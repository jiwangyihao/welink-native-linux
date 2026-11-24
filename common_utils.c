/* Native common_utils command adapter.
 * Replies use the original rsp/sno envelope. Commands 106/107 use the software
 * KMC v2 keystore and CBC envelope implemented in kmc_compat.c, not a new format.
 * Encryption accepts Base64 UTF-8 and returns the vendor's CiperText/CiperLen;
 * decryption returns direct UTF-8 in PlainText. Unknown commands are errors.
 * Device identity and autostart queries use the local Linux environment.
 * Commands 100..105 use the original encrypted ConfigTab service and key metadata.
 */

#define _GNU_SOURCE
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <ctype.h>
#include <sys/statvfs.h>
#include <sys/utsname.h>
#include <time.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include "native_rpc.h"
#include "kmc_compat.h"
#include "common_db.h"
#include "login_security_identity.h"


static native_callback g_callback;
static FILE *g_log;

static void log_line(const char *fmt, ...)
{
    if (!g_log) {
        const char *path = getenv("WELINK_NATIVE_LOG");
        g_log = fopen(path ? path : "/tmp/welink-native.log", "a");
        if (!g_log) return;
        setvbuf(g_log, NULL, _IOLBF, 0);
    }
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm;
    localtime_r(&ts.tv_sec, &tm);
    char stamp[16];
    strftime(stamp, sizeof(stamp), "%H:%M:%S", &tm);
    fprintf(g_log, "%s.%03ld [common_utils] ", stamp, ts.tv_nsec / 1000000);
    va_list args;
    va_start(args, fmt);
    vfprintf(g_log, fmt, args);
    va_end(args);
    fputc('\n', g_log);
}




static int autostart_enabled(void)
{
    const char *home = getenv("HOME");
    if (!home) return 0;
    char path[512];
    snprintf(path, sizeof(path), "%s/.config/autostart/cn.edu.hit.welink.desktop", home);
    struct stat st;
    return stat(path, &st) == 0;
}


static int decode_plain(struct json_object *value, unsigned char **plain,
                        size_t *length, size_t *capacity)
{
    *plain = NULL; *length = 0; *capacity = 0;
    if (!json_object_is_type(value, json_type_string)) return 3;
    const char *encoded = json_object_get_string(value);
    int count = json_object_get_string_len(value);
    if (!count) return 3;
    /* The original wrapper copies Base64 into a 256-byte C-string buffer
     * before decoding it; 190 plaintext bytes already exceed that limit. */
    if (count >= 256 || count % 4) return 1;
    *capacity = (size_t)count / 4 * 3 + 1;
    *plain = malloc(*capacity);
    if (!*plain) return 1;
    int decoded = EVP_DecodeBlock(*plain, (const unsigned char *)encoded, count);
    if (decoded < 0) return 1;
    if (encoded[count - 1] == '=') --decoded;
    if (encoded[count - 2] == '=') --decoded;
    if (decoded <= 0) return 1;
    /* The original wrapper passes the decoded value as a C string. */
    *length = strnlen((const char *)*plain, (size_t)decoded);
    return 0;
}

static void default_description(struct native_request *request, const char *description)
{
    if (!json_object_is_type(native_get(request->root, "description"), json_type_string))
        json_object_object_add(request->root, "description", json_object_new_string(description));
}

#define EXPORT __attribute__((visibility("default")))

EXPORT void common_utils_set_log_path(const char *path, int a, int b, int c)
{
    log_line("set_log_path(%s, %d, %d, %d)", path ? path : "(null)", a, b, c);
}

EXPORT void common_utils_init(void *callback)
{
    if (!callback) {
        log_line("init ignored: callback is null");
        return;
    }
    if (g_callback) {
        log_line("init ignored: already inited");
        return;
    }
    g_callback = (native_callback)callback;
    log_line("init");
}

EXPORT void common_utils_send_msg(const char *json)
{
    struct native_request request;
    int parse_error = native_parse(&request, json);
    if (parse_error) {
        log_line("invalid request: %d", parse_error);
        return;
    }
    int database_command = request.cmd >= 100 && request.cmd <= 105;
    struct json_object *param = database_command ? NULL : json_object_new_object();
    int64_t result = 0;
    if (!database_command && !param) {
        native_respond(g_callback, &request, -ENOMEM, NULL);
        native_release(&request);
        return;
    }
    switch (request.cmd) {
        case 7: {
            default_description(&request, "common_utils_get_device_info");
            char id[67];
            struct utsname u;
            if (uname(&u) != 0) { result = -errno; break; }
            if (login_security_identity(NULL, id)) { result = 1; break; }
            json_object_object_add(param, "deviceId", json_object_new_string(id));
            json_object_object_add(param, "osBit", json_object_new_string(
                strstr(u.machine, "64") ? "64-bit" : "32-bit"));
            break;
        }
        case 10: {
            default_description(&request, "common_utils_get_all_device_info");
            char serial[67] = "";
            struct json_object *info = NULL;
            if (login_security_identity(&info, serial)) { result = 1; break; }
            const char *cpuid = "", *guid = "", *mac = "";
            size_t len = info ? json_object_array_length(info) : 0;
            for (size_t i = 0; i < len; ++i) {
                struct json_object *item = json_object_array_get_idx(info, i);
                const char *type = native_string(item, "deviceType", "");
                const char *val = native_string(item, "deviceValue", "");
                if (!*cpuid && !strcmp(type, "CPUID")) cpuid = val;
                else if (!*guid && !strcmp(type, "GUID")) guid = val;
                else if (!*mac && !strcmp(type, "MAC")) mac = val;
            }
            json_object_object_add(param, "CPUID", json_object_new_string(cpuid));
            json_object_object_add(param, "GUID", json_object_new_string(guid));
            json_object_object_add(param, "UUID", json_object_new_string(serial));
            json_object_object_add(param, "MAC", json_object_new_string(mac));
            json_object_put(info);
            break;
        }
        case 15: {
            default_description(&request, "common_utils_is_disk_freespace_enough");
            const char *req_path = native_string(request.param, "diskPath", "");
            int64_t threshold = native_integer(request.param, "threshold", INT64_C(1073741824));
            if (threshold < 0) threshold = INT64_C(1073741824);
            const char *home = getenv("HOME");
            const char *fallback = (home && home[0] == '/') ? home : "/";
            int is_default = !req_path || !*req_path ||
                             (isalpha((unsigned char)req_path[0]) && req_path[1] == ':');
            const char *check_path = is_default ? fallback : req_path;
            struct statvfs64 vfs;
            int err = 0;
            if (statvfs64(check_path, &vfs) != 0) {
                err = errno;
                if (!is_default && statvfs64(fallback, &vfs) == 0) {
                    check_path = fallback;
                    is_default = 1;
                    err = 0;
                }
            }
            int is_system = is_default;
            if (!err && !is_system) {
                struct stat st_path, st_root;
                if (stat(check_path, &st_path) == 0 && stat("/", &st_root) == 0 &&
                    st_path.st_dev == st_root.st_dev) is_system = 1;
            }
            uint64_t free_bytes = 0;
            if (!err) {
                uint64_t unit = vfs.f_frsize ? (uint64_t)vfs.f_frsize : (uint64_t)vfs.f_bsize;
                uint64_t avail = (uint64_t)vfs.f_bavail;
                free_bytes = (unit && avail > (uint64_t)INT64_MAX / unit)
                    ? (uint64_t)INT64_MAX : avail * unit;
            }
            int enough = !err && free_bytes > (uint64_t)threshold;
            json_object_object_add(param, "diskPath", json_object_new_string(check_path));
            json_object_object_add(param, "isSystemDir", json_object_new_boolean(is_system));
            json_object_object_add(param, "isSpaceEnough", json_object_new_boolean(enough));
            json_object_object_add(param, "freeSpace", json_object_new_int64((int64_t)free_bytes));
            json_object_object_add(param, "errorCode", json_object_new_int(err));
            if (err) result = 1;
            break;
        }
        case 4:
            default_description(&request, "common_utils_get_auto_start");
            json_object_object_add(param, "isAutoStart", json_object_new_boolean(autostart_enabled()));
            break;
        case 2:
            default_description(&request, "common_utils_get_reg_info");
            break;
        case 100: case 101: case 102: case 103: case 104: case 105: {
            static const char *const descriptions[] = {
                "common_utils_init_db", "common_utils_single_add_config",
                "common_utils_batch_add_config", "common_utils_delete_config",
                "common_utils_query_config", "common_utils_uninit_db"
            };
            default_description(&request, descriptions[request.cmd - 100]);
            result = common_db_execute(&request, &param);
            break;
        }
        case 106: {
            default_description(&request, "common_utils_encrypt_by_kmc");
            unsigned char *plain = NULL;
            char *hex = NULL;
            size_t length = 0, capacity = 0, binary_length = 0;
            result = decode_plain(native_get(request.param, "plainText"), &plain, &length, &capacity);
            if (!result) {
                int error = kmc_encrypt(native_string(request.param, "kmcdir", ""),
                                        plain, length, &hex, &binary_length);
                if (error) { result = 1; log_line("KMC encrypt error: %d", error); }
            }
            json_object_object_add(param, "CiperText", json_object_new_string(hex ? hex : ""));
            json_object_object_add(param, "CiperLen", json_object_new_int64((int64_t)binary_length * 4));
            if (plain) { OPENSSL_cleanse(plain, capacity); free(plain); }
            free(hex);
            break;
        }
        case 107: {
            default_description(&request, "kmc_decrypt");
            struct json_object *cipher = native_get(request.param, "cipherText");
            unsigned char *plain = NULL;
            size_t length = 0;
            int error = EINVAL;
            if (json_object_is_type(cipher, json_type_string))
                error = kmc_decrypt(native_string(request.param, "kmcdir", ""),
                                    json_object_get_string(cipher),
                                    (size_t)json_object_get_string_len(cipher), &plain, &length);
            /* The original wrapper reports result:0 and empty PlainText on
             * wrong keys or malformed ciphertext; do not mistake it for success. */
            if (error) log_line("KMC decrypt error: %d", error);
            json_object_object_add(param, "PlainText", json_object_new_string_len(
                plain ? (const char *)plain : "", (int)length));
            if (plain) { OPENSSL_cleanse(plain, length); free(plain); }
            break;
        }
        default:
            result = -ENOSYS;
            break;
    }
    log_line("cmd=%lld result=%lld", (long long)request.cmd, (long long)result);
    native_respond(g_callback, &request, result, param);
    native_release(&request);
}

EXPORT void common_utils_shutdown(void)
{
    log_line("shutdown");
    common_db_shutdown();
    g_callback = NULL;
    if (g_log) { fclose(g_log); g_log = NULL; }
}
