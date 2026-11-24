/* Linux implementation of the original support JSON ABI, not a Wine shim.
 * DLL command addresses and the deliberately different storage derivation are
 * recorded in analysis/support-contract.txt. Only the five JS-bound entry
 * points are exported; native queue functions are not invented aliases.
 *
 * The worker performs crypto/filesystem work and enqueues owned JSON. Only the
 * init owner may dispatch callbacks. Epoch invalidation is the same lifecycle
 * pattern as login_security_runtime.h, with secure message/JSON destruction.
 */
#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#define _TIME_BITS 64
#include "wk_tup_support.h"
#include "native_rpc.h"
#include "kmc_compat.h"
#include "native_storage.h"
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <json-c/printbuf.h>

/* Secure teardown relies on the pinned parser's published internal ownership.
 * Review against json_tokener.c before upgrading the private json-c archive. */
#if JSON_C_VERSION_NUM != ((0 << 16) | (19 << 8) | 0)
#error "Support secure parser teardown requires json-c 0.19 ownership review"
#endif

#define IPSI_DATA_LENGTH 0x73010025
#define IPSI_IV_LENGTH 0x7301002b
#define IPSI_KEY_LENGTH 0x7301002c
#define IPSI_PADDING 0x73020008

struct support_message {
    struct support_message *next;
    uint64_t epoch;
    size_t length;
    char text[];
};
static struct {
    pthread_mutex_t lock;
    pthread_cond_t wake;
    pthread_t owner;
    tup_support_callback callback;
    struct support_message *head, *tail, *out_head, *out_tail;
    uint64_t epoch;
    int running, accepting, dispatching, error;
    FILE *log;
    size_t log_limit;
} runtime = {.lock = PTHREAD_MUTEX_INITIALIZER, .wake = PTHREAD_COND_INITIALIZER};

/* Worker-owned KMC session. Every new init epoch and start/stop clears it. */
static struct {
    char primary[256], backup[256];
    FILE *log;
    int started;
} kmc;

static void free_message(struct support_message *message)
{
    if (!message) return;
    OPENSSL_cleanse(message->text, message->length + 1);
    free(message);
}

static void free_messages(struct support_message *message)
{
    while (message) {
        struct support_message *next = message->next;
        free_message(message);
        message = next;
    }
}

/* Target-private linker wrappers, not SDK exports. The __real references make
 * omission of either --wrap flag a link failure under the normal -z defs.
 * json-c 0.19's two real string constructors return FRESH objects with NULL
 * userdata/user_delete (json_object.c:459-473,1492-1537). Attach only there:
 * never overwrite an existing object's userdata or a double's serializer.
 * Final release invokes this callback before freeing the inline string,
 * including duplicate-key replacement INSIDE json_tokener_parse_ex. */
struct json_object *__real_json_object_new_string(const char *text);
struct json_object *__real_json_object_new_string_len(const char *text, int length);

static void support_string_delete(struct json_object *value, void *userdata)
{
    (void)userdata;
    OPENSSL_cleanse((void *)json_object_get_string(value),
                    (size_t)json_object_get_string_len(value));
}

__attribute__((visibility("hidden")))
struct json_object *__wrap_json_object_new_string(const char *text)
{
    struct json_object *value = __real_json_object_new_string(text);
    if (value) json_object_set_userdata(value, NULL, support_string_delete);
    return value;
}

__attribute__((visibility("hidden")))
struct json_object *__wrap_json_object_new_string_len(const char *text, int length)
{
    struct json_object *value = __real_json_object_new_string_len(text, length);
    if (value) json_object_set_userdata(value, NULL, support_string_delete);
    return value;
}

static void destroy_json(struct json_object *value)
{
    json_object_put(value);
}

static void support_tokener_free(struct json_tokener *tokener)
{
    if (!tokener) return;
    /* Failed parses retain current partial trees; their string finalizers run
     * when reset releases them. Successful results have been transferred out
     * and remain untouched. Unfinished field names are separately owned.
     * srec.obj and tokener.str are unused in the pinned json-c 0.19 parser. */
    for (int depth = 0; depth < tokener->max_depth; ++depth) {
        char *name = tokener->stack[depth].obj_field_name;
        if (name) OPENSSL_cleanse(name, strlen(name));
    }
    json_tokener_reset(tokener);
    /* printbuf_reset only clears byte zero; bpos/strlen miss previous tokens.
     * Mirror 0.19's free ownership, cleansing full allocations before release. */
    if (tokener->pb) {
        if (tokener->pb->buf) {
            OPENSSL_cleanse(tokener->pb->buf, (size_t)tokener->pb->size);
            free(tokener->pb->buf);
        }
        OPENSSL_cleanse(tokener->pb, sizeof(*tokener->pb));
        free(tokener->pb);
    }
    OPENSSL_cleanse(tokener->stack,
                    (size_t)tokener->max_depth * sizeof(*tokener->stack));
    free(tokener->stack);
    OPENSSL_cleanse(tokener, sizeof(*tokener));
    free(tokener);
}

static struct json_tokener *support_tokener_new(size_t input_length)
{
    if (input_length >= INT_MAX) return NULL;
    struct json_tokener *tokener = json_tokener_new();
    if (!tokener) return NULL;
    /* Decoding JSON escapes cannot exceed this complete input's byte length.
     * Reserve once before parsing: later printbuf growth would realloc/free an
     * old scratch allocation containing secrets before teardown can reach it. */
    size_t capacity = input_length + 1;
    if ((size_t)tokener->pb->size < capacity) {
        OPENSSL_cleanse(tokener->pb->buf, (size_t)tokener->pb->size);
        char *buffer = realloc(tokener->pb->buf, capacity);
        if (!buffer) { support_tokener_free(tokener); return NULL; }
        tokener->pb->buf = buffer;
        tokener->pb->size = (int)capacity;
        buffer[0] = 0;
    }
    return tokener;
}

static struct support_message *message_new(const char *text, size_t length)
{
    if (length > SIZE_MAX - sizeof(struct support_message) - 1) return NULL;
    struct support_message *message = malloc(sizeof(*message) + length + 1);
    if (!message) return NULL;
    message->next = NULL;
    message->epoch = 0;
    message->length = length;
    memcpy(message->text, text, length);
    message->text[length] = 0;
    return message;
}

static void log_result(uint64_t command, int result)
{
    pthread_mutex_lock(&runtime.lock);
    if (runtime.log) {
        long offset = ftell(runtime.log);
        if (offset >= 0 && (size_t)offset < runtime.log_limit) {
            fprintf(runtime.log, "support cmd=%llu result=%d\n",
                    (unsigned long long)command, result);
            fflush(runtime.log);
        }
    }
    pthread_mutex_unlock(&runtime.lock);
    if (kmc.log) {
        long offset = ftell(kmc.log);
        if (offset >= 0 && offset < 1024 * 1024) {
            fprintf(kmc.log, "support cmd=%llu result=%d\n",
                    (unsigned long long)command, result);
            fflush(kmc.log);
        }
    }
}

static int add_string(struct json_object *object, const char *name, const char *text, size_t length)
{
    if (length > INT_MAX) return EOVERFLOW;
    struct json_object *value = json_object_new_string_len(text, (int)length);
    if (!value) return ENOMEM;
    if (json_object_object_add(object, name, value)) { destroy_json(value); return ENOMEM; }
    return 0;
}

static int add_integer(struct json_object *object, const char *name, int64_t number)
{
    struct json_object *value = json_object_new_int64(number);
    if (!value) return ENOMEM;
    if (json_object_object_add(object, name, value)) { json_object_put(value); return ENOMEM; }
    return 0;
}

static void runtime_error(int error)
{
    pthread_mutex_lock(&runtime.lock);
    runtime.error = error;
    pthread_mutex_unlock(&runtime.lock);
}

static void reply(struct json_object *request, uint64_t epoch, const char *description,
                  int result, struct json_object *param)
{
    uint64_t command = (uint64_t)native_integer(request, "cmd", 0);
    log_result(command, result);
    struct json_object *object = json_object_new_object();
    if (!object) { destroy_json(param); runtime_error(ENOMEM); return; }
    int failed = add_string(object, "description", description, strlen(description)) ||
        add_integer(object, "rsp", (int64_t)command) ||
        add_integer(object, "result", result);
    struct json_object *sno = native_get(request, "sno");
    if (!failed && json_object_is_type(sno, json_type_int) && json_object_get_int64(sno) >= 0 &&
        json_object_get_uint64(sno) <= UINT32_MAX)
        failed = add_integer(object, "sno", json_object_get_int64(sno));
    if (!failed && param) {
        failed = json_object_object_add(object, "param", param);
        if (!failed) param = NULL;
    }
    if (failed) {
        destroy_json(param);
        destroy_json(object);
        runtime_error(ENOMEM);
        return;
    }
    const char *text = json_object_to_json_string_ext(object, JSON_C_TO_STRING_PLAIN);
    size_t length = text ? strlen(text) : 0;
    struct support_message *message = text ? message_new(text, length) : NULL;
    if (text) OPENSSL_cleanse((void *)text, length);
    destroy_json(object);
    if (!message) { runtime_error(ENOMEM); return; }
    message->epoch = epoch;
    pthread_mutex_lock(&runtime.lock);
    if (runtime.accepting && runtime.epoch == epoch) {
        if (runtime.out_tail) runtime.out_tail->next = message;
        else runtime.out_head = message;
        runtime.out_tail = message;
        message = NULL;
    }
    pthread_mutex_unlock(&runtime.lock);
    free_message(message);
}

static const char *string_param(struct json_object *param, const char *name, size_t capacity,
                                size_t *length)
{
    struct json_object *value = native_get(param, name);
    if (!json_object_is_type(value, json_type_string)) return NULL;
    int count = json_object_get_string_len(value);
    const char *text = json_object_get_string(value);
    if (count < 0 || (size_t)count >= capacity || memchr(text, 0, (size_t)count)) return NULL;
    if (length) *length = (size_t)count;
    return text;
}

static int from_hex(const char *text, size_t count, unsigned char *output)
{
    if (!text || count % 2) return 1;
    for (size_t i = 0; i < count; ++i) {
        unsigned char c = (unsigned char)text[i];
        unsigned nibble;
        if (c >= '0' && c <= '9') nibble = c - '0';
        else if (c >= 'a' && c <= 'f') nibble = c - 'a' + 10;
        else if (c >= 'A' && c <= 'F') nibble = c - 'A' + 10;
        else return 1;
        if (!(i & 1)) output[i / 2] = (unsigned char)(nibble << 4);
        else output[i / 2] |= (unsigned char)nibble;
    }
    return 0;
}

static void to_hex(const unsigned char *input, size_t length, char *output)
{
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < length; ++i) {
        output[2*i] = digits[input[i] >> 4];
        output[2*i + 1] = digits[input[i] & 15];
    }
    output[2*length] = 0;
}


static int derive(struct json_object *param, int extended, struct json_object **out)
{
    /* commonlib 0x100027e0: fixed legacy password, little-endian stack bytes. */
    static const unsigned char legacy_password[32] = {
        0x2a,0x23,0x43,0x79,0x13,0x1d,0x0b,0x54,0x5e,0x6f,0x4b,0x68,0x47,0x2e,0x57,0x15,
        0x52,0x16,0x32,0x2c,0x10,0x7c,0x28,0x72,0x57,0x28,0x25,0x17,0x38,0x17,0x21,0x4b
    };
    unsigned char salt[32] = {0}, iv[16] = {0};
    size_t salt_length = 0, iv_length = 0;
    const char *salt_text = string_param(param, "salt", 65, &salt_length);
    int result = 1;
    unsigned char *key = NULL;
    char *hex = NULL;
    size_t length = 0;
    if (!salt_text || !salt_length || from_hex(salt_text, salt_length, salt)) goto done;
    const unsigned char *password = legacy_password;
    size_t password_length = sizeof(legacy_password);
    if (extended) {
        const char *iv_text = string_param(param, "iv", 33, &iv_length);
        if (!iv_text || !iv_length || from_hex(iv_text, iv_length, iv)) goto done;
        password = iv;
        password_length = iv_length / 2;
    }
    int64_t requested = native_integer(param, "dklen", 0);
    if (requested <= 0) goto done;
    if (requested > 65535) { result = IPSI_KEY_LENGTH; goto done; }
    length = (size_t)requested;
    key = malloc(length);
    hex = malloc(2 * length + 1);
    if (!key || !hex) goto done;
    /* saltLen is deliberately ignored: the DLL uses strlen(salt)/2.
     * IPSI 0x10056550 converts iteration=0 to 0x800, not storage's 4096. */
    if (PKCS5_PBKDF2_HMAC((const char *)password, (int)password_length, salt,
                          (int)(salt_length / 2), 2048, EVP_sha256(), (int)length, key) != 1)
        goto done;
    to_hex(key, length, hex);
    *out = json_object_new_object();
    if (!*out || add_string(*out, "derivedkey", hex, 2 * length)) goto done;
    if (add_integer(*out, "keyLen", 32) || add_integer(*out, "IVLen", 16)) goto done;
    result = 0;
 done:
    OPENSSL_cleanse(salt, sizeof(salt));
    OPENSSL_cleanse(iv, sizeof(iv));
    if (key) { OPENSSL_cleanse(key, length); free(key); }
    if (hex) { OPENSSL_cleanse(hex, 2 * length + 1); free(hex); }
    return result;
}

/* Vendor decrypt inserts plaintext directly inside JSON quotes after replacing
 * a marker. Thus it decodes exactly one JSON string-escape layer; encryption's
 * JS wrapper explicitly supplies that layer. Parse it instead of interpolating
 * untrusted plaintext into an envelope (which could inject rsp/sno/result). */
static int plaintext_value(const unsigned char *plain, size_t length, struct json_object **value)
{
    size_t used = strnlen((const char *)plain, length);
    char *quoted = malloc(used + 3);
    if (!quoted) return ENOMEM;
    quoted[0] = '"';
    memcpy(quoted + 1, plain, used);
    quoted[used + 1] = '"';
    quoted[used + 2] = 0;
    struct json_tokener *tokener = support_tokener_new(used + 2);
    int error = ENOMEM;
    *value = NULL;
    if (tokener) {
        json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
        *value = json_tokener_parse_ex(tokener, quoted, (int)used + 3);
        error = json_tokener_get_error(tokener) == json_tokener_success &&
            json_object_is_type(*value, json_type_string) ? 0 : EBADMSG;
        support_tokener_free(tokener);
    }
    OPENSSL_cleanse(quoted, used + 3);
    free(quoted);
    if (error) { destroy_json(*value); *value = NULL; }
    return error;
}

static int cipher_command(struct json_object *param, int encrypt, struct json_object **out)
{
    unsigned char key[32] = {0}, iv[16] = {0}, input[512] = {0}, output[528] = {0};
    char hex[1057];
    size_t key_length = 0, iv_length = 0, length = 0;
    const char *key_text = string_param(param, "Key", 65, &key_length);
    const char *iv_text = string_param(param, "IV", 33, &iv_length);
    const char *text = string_param(param, encrypt ? "PlainText" : "cipher",
                                    encrypt ? 512 : 1024, &length);
    int result = 1, first = 0, last = 0;
    EVP_CIPHER_CTX *ctx = NULL;
    if (!text || from_hex(key_text, key_length, key) || from_hex(iv_text, iv_length, iv)) goto done;
    if (key_length != 64) { result = IPSI_KEY_LENGTH; goto done; }
    if (iv_length != 32) { result = IPSI_IV_LENGTH; goto done; }
    if (!encrypt) {
        if (!length || length % 32) { result = IPSI_DATA_LENGTH; goto done; }
        if (from_hex(text, length, input)) goto done;
        length /= 2;
    }
    ctx = EVP_CIPHER_CTX_new();
    if (!ctx || EVP_CipherInit_ex(ctx, EVP_aes_256_cbc(), NULL, key, iv, encrypt) != 1) goto done;
    if (EVP_CipherUpdate(ctx, output, &first, encrypt ? (const unsigned char *)text : input,
                         (int)length) != 1) goto done;
    if (EVP_CipherFinal_ex(ctx, output + first, &last) != 1) {
        result = encrypt ? 1 : IPSI_PADDING;
        goto done;
    }
    size_t written = (size_t)first + (size_t)last;
    *out = json_object_new_object();
    if (!*out) goto done;
    if (encrypt) {
        to_hex(output, written, hex);
        if (add_string(*out, "CipherText", hex, 2 * written)) goto done;
        if (add_integer(*out, "CipherLen", (int64_t)written * 2)) goto done;
    } else {
        struct json_object *value = NULL;
        int error = plaintext_value(output, written, &value);
        if (error) { result = -error; goto done; }
        if (json_object_object_add(*out, "PlainText", value)) { destroy_json(value); goto done; }
        if (add_integer(*out, "PlainLen", (int64_t)written)) goto done;
    }
    result = 0;
 done:
    EVP_CIPHER_CTX_free(ctx);
    OPENSSL_cleanse(key, sizeof(key));
    OPENSSL_cleanse(iv, sizeof(iv));
    OPENSSL_cleanse(input, sizeof(input));
    OPENSSL_cleanse(output, sizeof(output));
    OPENSSL_cleanse(hex, sizeof(hex));
    return result;
}

static int random_command(struct json_object *param, struct json_object **out)
{
    int64_t requested = native_integer(param, "RandLen", 0);
    /* Bound the hex output to json-c's signed string length. */
    if (requested <= 0 || requested > INT_MAX / 2) return 1;
    size_t length = (size_t)requested;
    char *buffer = malloc(2 * length + 1);
    if (!buffer) return 1;
    int result = 1;
    if (RAND_bytes((unsigned char *)buffer, (int)length) == 1) {
        static const char digits[] = "0123456789abcdef";
        for (size_t i = length; i-- > 0;) {
            unsigned char value = (unsigned char)buffer[i];
            buffer[2*i] = digits[value >> 4];
            buffer[2*i + 1] = digits[value & 15];
        }
        buffer[2*length] = 0;
        *out = json_object_new_object();
        if (*out && !add_string(*out, "realrandom", buffer, 2 * length)) result = 0;
    }
    OPENSSL_cleanse(buffer, 2 * length + 1);
    free(buffer);
    return result;
}

static void kmc_clear(void)
{
    if (kmc.log) fclose(kmc.log);
    OPENSSL_cleanse(&kmc, sizeof(kmc));
}

static int create_parent(const char *path)
{
    const char *slash = strrchr(path, '/');
    if (!slash || slash == path) return 0;
    size_t length = (size_t)(slash - path);
    char parent[256];
    if (length >= sizeof(parent)) return ENAMETOOLONG;
    memcpy(parent, path, length);
    parent[length] = 0;
    return native_storage_mkdirs(parent);
}

static FILE *open_log(const char *path)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK, 0600);
    if (fd < 0) return NULL;
    struct stat st;
    if (fstat(fd, &st) || !S_ISREG(st.st_mode)) {
        int error = errno ? errno : EINVAL;
        close(fd); errno = error; return NULL;
    }
    FILE *file = fdopen(fd, "a");
    if (!file) { int error = errno; close(fd); errno = error; }
    return file;
}

static int start_kmc(struct json_object *param)
{
    const char *log = string_param(param, "LogFile", 256, NULL);
    const char *primary = string_param(param, "KeyStoreFile", 256, NULL);
    const char *backup = string_param(param, "KeyStoreFileBak", 256, NULL);
    if (!log || !*log || !primary || !*primary || !backup || !*backup) return 1;
    kmc_clear();
    int error = create_parent(log);
    if (!error) error = create_parent(primary);
    if (!error) error = create_parent(backup);
    if (error) return -error;
    kmc.log = open_log(log);
    if (!kmc.log) return -errno;
    error = kmc_initialize_paths(primary, backup);
    if (error) { kmc_clear(); return -error; }
    memcpy(kmc.primary, primary, strlen(primary) + 1);
    memcpy(kmc.backup, backup, strlen(backup) + 1);
    kmc.started = 1;
    return 0;
}

/* commonlib 0x10001550 accepts URL alphabet, CR/LF and unpadded groups.
 * Its '=' and CR/LF table entries are skipped, not decoded as zero sextets. */
static size_t decode_base64(const char *text, size_t length, unsigned char output[193])
{
    unsigned bits = 0, accumulator = 0;
    size_t written = 0;
    for (size_t i = 0; i < length; ++i) {
        unsigned char c = (unsigned char)text[i];
        unsigned value;
        if (c >= 'A' && c <= 'Z') value = c - 'A';
        else if (c >= 'a' && c <= 'z') value = c - 'a' + 26;
        else if (c >= '0' && c <= '9') value = c - '0' + 52;
        else if (c == '+' || c == '-') value = 62;
        else if (c == '/' || c == '_') value = 63;
        else if (c == '=' || c == '\r' || c == '\n') continue;
        else return 0;
        accumulator = (accumulator << 6) | value;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            output[written++] = (unsigned char)(accumulator >> bits);
        }
    }
    return written;
}

static int kmc_command(struct json_object *param, int encrypt, struct json_object **out)
{
    /* KMC.dll 0x10012db0: state != initialized returns 0x10e. */
    if (!kmc.started) return 0x10e;
    size_t length = 0;
    const char *text = string_param(param, encrypt ? "PlainText" : "CiperText",
                                    encrypt ? 256 : 640, &length);
    if (!text || !length) return 1;
    unsigned char decoded[193] = {0};
    unsigned char *plain = NULL;
    char *hex = NULL;
    size_t written = 0;
    int result = 1;
    if (encrypt) {
        size_t count = decode_base64(text, length, decoded);
        if (!count) goto done;
        int error = kmc_encrypt_paths(kmc.primary, kmc.backup, decoded, count, &hex, &written);
        if (error) { result = -error; goto done; }
        *out = json_object_new_object();
        if (!*out || add_string(*out, "CiperText", hex, 2 * written)) goto done;
        /* Unlike common_utils, support returns the actual hex character count. */
        if (add_integer(*out, "CiperLen", (int64_t)written * 2)) goto done;
    } else {
        int error = kmc_decrypt_paths(kmc.primary, kmc.backup, text, length, &plain, &written);
        if (error) { result = -error; goto done; }
        struct json_object *value = NULL;
        error = plaintext_value(plain, written, &value);
        if (error) { result = -error; goto done; }
        *out = json_object_new_object();
        if (!*out) { destroy_json(value); goto done; }
        if (json_object_object_add(*out, "PlainText", value)) { destroy_json(value); goto done; }
    }
    result = 0;
 done:
    OPENSSL_cleanse(decoded, sizeof(decoded));
    if (plain) { OPENSSL_cleanse(plain, written + 1); free(plain); }
    if (hex) { OPENSSL_cleanse(hex, 2 * written + 1); free(hex); }
    return result;
}

static void execute(struct json_object *request, uint64_t epoch)
{
    struct json_object *param = native_get(request, "param"), *output = NULL;
    uint64_t command = (uint64_t)native_integer(request, "cmd", 0);
    const char *description = "tup_support_unsupported_command";
    int result;
    switch (command) {
    case 0x40001:
        description = "tup_support_crypt_Pkcs5Derivekey";
        result = derive(param, 0, &output);
        break;
    case 0x40002:
        description = "tup_commonlib_crypt_encrypt";
        result = cipher_command(param, 1, &output);
        break;
    case 0x40003:
        description = "tup_commonlib_crypt_decrypt";
        result = cipher_command(param, 0, &output);
        break;
    case 0x40004:
        description = "tup_commonlib_crypt_realrandom";
        result = random_command(param, &output);
        break;
    case 0x40005:
        description = "kmc_service_start";
        result = start_kmc(param);
        break;
    case 0x40006:
        description = "kmc_service_stop";
        kmc_clear();
        result = 0;
        break;
    case 0x40007:
        description = "kmc_encrypt";
        result = kmc_command(param, 1, &output);
        break;
    case 0x40008:
        description = "kmc_decrypt";
        result = kmc_command(param, 0, &output);
        break;
    case 0x40009:
        description = "tup_commonlib_crypt_pkcs5_derive_key_ex";
        result = derive(param, 1, &output);
        break;
    default:
        result = -ENOSYS;
        break;
    }
    if (result) { destroy_json(output); output = NULL; }
    reply(request, epoch, description, result, output);
}

static void *worker(void *unused)
{
    (void)unused;
    uint64_t state_epoch = 0;
    pthread_mutex_lock(&runtime.lock);
    for (;;) {
        if (state_epoch != runtime.epoch) {
            state_epoch = runtime.epoch;
            pthread_mutex_unlock(&runtime.lock);
            kmc_clear();
            pthread_mutex_lock(&runtime.lock);
            continue;
        }
        while (!runtime.head && state_epoch == runtime.epoch)
            pthread_cond_wait(&runtime.wake, &runtime.lock);
        if (state_epoch != runtime.epoch) continue;
        struct support_message *job = runtime.head;
        runtime.head = job->next;
        if (!runtime.head) runtime.tail = NULL;
        pthread_mutex_unlock(&runtime.lock);
        struct json_tokener *tokener = support_tokener_new(job->length);
        if (tokener) {
            json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
            struct json_object *request = json_tokener_parse_ex(tokener, job->text, (int)job->length + 1);
            int valid = json_tokener_get_error(tokener) == json_tokener_success &&
                json_object_is_type(request, json_type_object) &&
                json_object_is_type(native_get(request, "cmd"), json_type_int) &&
                native_integer(request, "cmd", -1) >= 0 &&
                native_integer(request, "cmd", -1) <= UINT32_MAX;
            support_tokener_free(tokener);
            if (valid) execute(request, job->epoch);
            else log_result(0, -EINVAL);
            destroy_json(request);
        } else { log_result(0, -ENOMEM); runtime_error(ENOMEM); }
        free_message(job);
        pthread_mutex_lock(&runtime.lock);
    }
    return NULL;
}

SUPPORT_EXPORT void tup_support_init(void *callback)
{
    pthread_mutex_lock(&runtime.lock);
    if (!runtime.accepting && callback) {
        runtime.owner = pthread_self();
        runtime.callback = (tup_support_callback)callback;
        runtime.accepting = 1;
        runtime.error = 0;
        ++runtime.epoch;
        if (!runtime.running) {
            pthread_attr_t attributes;
            int error = pthread_attr_init(&attributes);
            if (!error) {
                error = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
                if (!error) {
                    pthread_t thread;
                    error = pthread_create(&thread, &attributes, worker, NULL);
                }
                pthread_attr_destroy(&attributes);
            }
            if (error) {
                runtime.error = error;
                runtime.accepting = 0;
                runtime.callback = NULL;
            } else runtime.running = 1;
        }
        pthread_cond_signal(&runtime.wake);
    }
    pthread_mutex_unlock(&runtime.lock);
}

SUPPORT_EXPORT void tup_support_send_msg(const char *json)
{
    if (!json) return;
    size_t length = strlen(json);
    if (length >= INT_MAX) return;
    struct support_message *job = message_new(json, length);
    if (!job) {
        pthread_mutex_lock(&runtime.lock);
        runtime.error = ENOMEM;
        pthread_mutex_unlock(&runtime.lock);
        return;
    }
    pthread_mutex_lock(&runtime.lock);
    if (runtime.accepting) {
        job->epoch = runtime.epoch;
        if (runtime.tail) runtime.tail->next = job;
        else runtime.head = job;
        runtime.tail = job;
        pthread_cond_signal(&runtime.wake);
        job = NULL;
    }
    pthread_mutex_unlock(&runtime.lock);
    free_message(job);
}

SUPPORT_EXPORT int tup_support_dispatch(void)
{
    pthread_mutex_lock(&runtime.lock);
    if (runtime.error) {
        int error = runtime.error;
        runtime.error = 0;
        pthread_mutex_unlock(&runtime.lock);
        return -error;
    }
    if (!runtime.accepting || runtime.dispatching) {
        pthread_mutex_unlock(&runtime.lock); return 0;
    }
    if (!pthread_equal(runtime.owner, pthread_self())) {
        pthread_mutex_unlock(&runtime.lock); return -EPERM;
    }
    runtime.dispatching = 1;
    pthread_mutex_unlock(&runtime.lock);
    int delivered = 0;
    for (unsigned count = 0; count < 64; ++count) {
        pthread_mutex_lock(&runtime.lock);
        struct support_message *message = runtime.out_head;
        if (!message) { pthread_mutex_unlock(&runtime.lock); break; }
        runtime.out_head = message->next;
        if (!runtime.out_head) runtime.out_tail = NULL;
        tup_support_callback callback = runtime.accepting && message->epoch == runtime.epoch
            ? runtime.callback : NULL;
        pthread_mutex_unlock(&runtime.lock);
        if (callback) { callback(message->text); ++delivered; }
        free_message(message);
    }
    pthread_mutex_lock(&runtime.lock);
    runtime.dispatching = 0;
    pthread_mutex_unlock(&runtime.lock);
    return delivered;
}

SUPPORT_EXPORT void tup_support_shutdown(void)
{
    pthread_mutex_lock(&runtime.lock);
    if (runtime.accepting && !pthread_equal(runtime.owner, pthread_self())) {
        runtime.error = EPERM;
        pthread_mutex_unlock(&runtime.lock);
        return;
    }
    runtime.accepting = 0;
    runtime.callback = NULL;
    ++runtime.epoch;
    struct support_message *jobs = runtime.head, *messages = runtime.out_head;
    runtime.head = runtime.tail = runtime.out_head = runtime.out_tail = NULL;
    FILE *log = runtime.log;
    runtime.log = NULL;
    pthread_cond_signal(&runtime.wake);
    pthread_mutex_unlock(&runtime.lock);
    free_messages(jobs);
    free_messages(messages);
    if (log) fclose(log);
}

SUPPORT_EXPORT void tup_support_set_log_path(const char *path, int level, int size_kb, int count)
{
    (void)count; /* One bounded metadata-only file; never emit keys or payloads. */
    FILE *file = NULL;
    int error = 0;
    if (path && *path && level >= 0 && size_kb > 0) {
        char joined[PATH_MAX];
        struct stat st;
        if (!stat(path, &st) && S_ISDIR(st.st_mode)) {
            int written = snprintf(joined, sizeof(joined), "%s/wk_tup_support.log", path);
            if (written < 0 || (size_t)written >= sizeof(joined)) error = ENAMETOOLONG;
            else path = joined;
        }
        if (!error) { file = open_log(path); if (!file) error = errno; }
    }
    pthread_mutex_lock(&runtime.lock);
    FILE *old = runtime.log;
    runtime.log = file;
    runtime.log_limit = size_kb > 0 ? (size_t)size_kb * 1024 : 0;
    if (error) runtime.error = error;
    pthread_mutex_unlock(&runtime.lock);
    if (old) fclose(old);
}
