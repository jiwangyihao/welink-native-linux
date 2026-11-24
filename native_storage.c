#define _GNU_SOURCE
#include "native_storage.h"
#include "kmc_compat.h"
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

static int hexadecimal(const char *value, size_t size)
{
    for (size_t i = 0; i < size; ++i) {
        unsigned char c = (unsigned char)value[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') ||
              (c >= 'A' && c <= 'F'))) return 0;
    }
    return 1;
}

int native_storage_mkdirs(const char *directory)
{
    if (!directory || !*directory) return EINVAL;
    size_t length = strlen(directory);
    if (length >= PATH_MAX) return ENAMETOOLONG;
    char path[PATH_MAX];
    memcpy(path, directory, length + 1);
    for (size_t i = 1; i <= length; ++i) {
        if (path[i] && path[i] != '/') continue;
        char separator = path[i];
        path[i] = 0;
        if (mkdir(path, 0700) != 0) {
            int error = errno;
            struct stat st;
            if (error != EEXIST || stat(path, &st) != 0 || !S_ISDIR(st.st_mode))
                return error == EEXIST ? ENOTDIR : error;
        }
        path[i] = separator;
    }
    return 0;
}

int native_storage_read_metadata(const char *path, char *output, size_t capacity)
{
    if (!path || !output || capacity < 2) return EINVAL;
    output[0] = 0;
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return errno;
    struct stat st;
    int error = 0;
    if (fstat(fd, &st) != 0) error = errno;
    else if (!S_ISREG(st.st_mode)) error = EINVAL;
    else if (st.st_size < 0 || (uint64_t)st.st_size >= capacity) error = EOVERFLOW;
    size_t used = 0;
    while (!error && used < capacity - 1) {
        ssize_t count = read(fd, output + used, capacity - 1 - used);
        if (count < 0) { if (errno == EINTR) continue; error = errno; break; }
        if (!count) break;
        used += (size_t)count;
    }
    if (!error && used == capacity - 1) {
        unsigned char extra;
        ssize_t count;
        do { count = read(fd, &extra, 1); } while (count < 0 && errno == EINTR);
        if (count < 0) error = errno;
        else if (count) error = EOVERFLOW;
    }
    close(fd);
    if (!error && memchr(output, 0, used)) error = EBADMSG;
    output[used] = 0;
    if (error) output[0] = 0;
    return error;
}

int native_storage_derive(const char *plain, const char *nonce, char password[65])
{
    if (!plain || !nonce || !password || strlen(nonce) != 32 ||
        !hexadecimal(nonce, 32)) return EINVAL;
    size_t length = strlen(plain);
    if (length >= NATIVE_STORAGE_PLAIN_SIZE) return EOVERFLOW;
    unsigned char key[32];
    if (PKCS5_PBKDF2_HMAC(nonce, 32, (const unsigned char *)plain, (int)length,
                          4096, EVP_sha256(), sizeof(key), key) != 1) {
        OPENSSL_cleanse(key, sizeof(key));
        return EIO;
    }
    static const char digits[] = "0123456789ABCDEF";
    for (size_t i = 0; i < sizeof(key); ++i) {
        password[2*i] = digits[key[i] >> 4];
        password[2*i+1] = digits[key[i] & 15];
    }
    password[64] = 0;
    OPENSSL_cleanse(key, sizeof(key));
    return 0;
}

static int split_metadata(struct native_storage_key *key, size_t *cipher_length)
{
    const char *separator = strchr(key->metadata, '|');
    if (!separator || strchr(separator + 1, '|')) return EBADMSG;
    size_t length = (size_t)(separator - key->metadata);
    if (length < 160 || (length & 1) || !hexadecimal(key->metadata, length) ||
        strlen(separator + 1) != 32 || !hexadecimal(separator + 1, 32)) return EBADMSG;
    memcpy(key->nonce, separator + 1, 33);
    *cipher_length = length;
    return 0;
}

static int write_metadata(const char *path, const char *text, int replace)
{
    size_t path_length = strlen(path);
    if (!path_length || path_length >= PATH_MAX) return EINVAL;
    char directory[PATH_MAX];
    memcpy(directory, path, path_length + 1);
    char *separator = strrchr(directory, '/');
    const char *name = separator ? path + (separator - directory) + 1 : path;
    if (!*name) return EINVAL;
    if (!separator) strcpy(directory, ".");
    else if (separator == directory) directory[1] = 0;
    else *separator = 0;
    int parent = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (parent < 0) return errno;
    unsigned char random[8];
    if (RAND_bytes(random, sizeof(random)) != 1) { close(parent); return EIO; }
    char temporary[40];
    int prefix = snprintf(temporary, sizeof(temporary), ".native-db-key-");
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < sizeof(random); ++i) {
        temporary[prefix + 2*i] = digits[random[i] >> 4];
        temporary[prefix + 2*i + 1] = digits[random[i] & 15];
    }
    temporary[prefix + 2*sizeof(random)] = 0;
    int fd = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (fd < 0) { int error = errno; close(parent); return error; }
    int error = fchmod(fd, 0600) == 0 ? 0 : errno;
    size_t length = strlen(text), done = 0;
    while (!error && done < length) {
        ssize_t count = write(fd, text + done, length - done);
        if (count < 0) { if (errno == EINTR) continue; error = errno; break; }
        if (!count) { error = EIO; break; }
        done += (size_t)count;
    }
    if (!error && fsync(fd) != 0) error = errno;
    if (close(fd) != 0 && !error) error = errno;
    if (!error) {
        int result = replace ? renameat(parent, temporary, parent, name)
                             : linkat(parent, temporary, parent, name, 0);
        if (result != 0) error = errno;
    }
    unlinkat(parent, temporary, 0);
    if (!error && fsync(parent) != 0) error = errno;
    close(parent);
    return error;
}

static int decode_key(const char *directory, const char *expected,
                      struct native_storage_key *key)
{
    size_t cipher_length = 0, length = 0;
    int error = split_metadata(key, &cipher_length);
    unsigned char *plain = NULL;
    if (!error) error = kmc_decrypt(directory, key->metadata, cipher_length, &plain, &length);
    if (!error && (length >= sizeof(key->plain) || memchr(plain, 0, length))) error = EBADMSG;
    if (!error && expected && (strlen(expected) != length ||
                               CRYPTO_memcmp(expected, plain, length))) error = EKEYREJECTED;
    if (!error) {
        memcpy(key->plain, plain, length);
        key->plain[length] = 0;
        error = native_storage_derive(key->plain, key->nonce, key->password);
    }
    if (plain) { OPENSSL_cleanse(plain, length); free(plain); }
    return error;
}

int native_storage_load_key(const char *path, const char *directory,
                            const char *expected, int create,
                            struct native_storage_key *key)
{
    if (!path || !directory || !key) return EINVAL;
    memset(key, 0, sizeof(*key));
    int error = native_storage_read_metadata(path, key->metadata, sizeof(key->metadata));
    if (!error) {
        error = decode_key(directory, expected, key);
        if (error) native_storage_clear_key(key);
        return error;
    }
    if (error != ENOENT || !create) return error;
    if (!expected || !*expected || strlen(expected) > 189) return EINVAL;
    unsigned char random[16];
    if (RAND_bytes(random, sizeof(random)) != 1) return EIO;
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < sizeof(random); ++i) {
        key->nonce[2*i] = digits[random[i] >> 4];
        key->nonce[2*i+1] = digits[random[i] & 15];
    }
    key->nonce[32] = 0;
    char *cipher = NULL;
    size_t binary_length = 0;
    error = kmc_encrypt(directory, (const unsigned char *)expected, strlen(expected),
                        &cipher, &binary_length);
    if (!error) {
        size_t cipher_length = strlen(cipher);
        if (cipher_length + 34 > sizeof(key->metadata)) error = EOVERFLOW;
        else {
            memcpy(key->metadata, cipher, cipher_length);
            key->metadata[cipher_length] = '|';
            memcpy(key->metadata + cipher_length + 1, key->nonce, 33);
            memcpy(key->plain, expected, strlen(expected) + 1);
            error = native_storage_derive(key->plain, key->nonce, key->password);
        }
    }
    free(cipher);
    if (!error) error = write_metadata(path, key->metadata, 0);
    if (error == EEXIST) {
        /* Another process published the original-format key first. Use its
         * bytes, never a different in-memory key for the same database. */
        error = native_storage_read_metadata(path, key->metadata, sizeof(key->metadata));
        if (!error) error = decode_key(directory, expected, key);
    }
    if (error) native_storage_clear_key(key);
    return error;
}

static int prepare_key(const char *plain, const char *nonce, const char *metadata,
                        struct native_storage_key *next)
{
    if (!plain || !nonce || !metadata) return EINVAL;
    size_t length = strlen(plain), metadata_length = strlen(metadata);
    if (!length || length >= sizeof(next->plain) || metadata_length >= sizeof(next->metadata))
        return EINVAL;
    memcpy(next->metadata, metadata, metadata_length + 1);
    size_t cipher_length = 0;
    int error = split_metadata(next, &cipher_length);
    if (!error && strcmp(next->nonce, nonce)) error = EINVAL;
    if (!error) {
        memcpy(next->plain, plain, length + 1);
        error = native_storage_derive(plain, nonce, next->password);
    }
    return error;
}

int native_storage_set_key(const char *path, const char *plain, const char *nonce,
                           const char *metadata, struct native_storage_key *key)
{
    if (!path || !key) return EINVAL;
    struct native_storage_key next = {0};
    int error = prepare_key(plain, nonce, metadata, &next);
    if (!error) error = write_metadata(path, metadata, 1);
    if (!error) *key = next;
    native_storage_clear_key(&next);
    return error;
}

int native_storage_rekey(sqlite3 *db, const char *path, const char *plain,
                         const char *nonce, const char *metadata,
                         struct native_storage_key *key)
{
    if (!db || !path || !key || !key->password[0]) return EINVAL;
    struct native_storage_key next = {0};
    int error = prepare_key(plain, nonce, metadata, &next);
    int changed = 0;
    if (!error) {
        int result = sqlite3_rekey(db, next.password, (int)strlen(next.password));
        if (result != SQLITE_OK) error = EIO;
        else changed = 1;
    }
    if (!error) error = write_metadata(path, metadata, 1);
    if (error && changed && sqlite3_rekey(db, key->password, (int)strlen(key->password)) != SQLITE_OK)
        error = ENOTRECOVERABLE;
    if (!error) *key = next;
    native_storage_clear_key(&next);
    return error;
}

void native_storage_clear_key(struct native_storage_key *key)
{
    if (key) OPENSSL_cleanse(key, sizeof(*key));
}

int native_storage_open(const char *path, const char *password, int create,
                        sqlite3 **database)
{
    if (!path || !*path || !database) return SQLITE_MISUSE;
    *database = NULL;
    if (create) {
        int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (fd >= 0) {
            int error = fchmod(fd, 0600);
            close(fd);
            if (error) return SQLITE_CANTOPEN;
        } else if (errno != EEXIST) return SQLITE_CANTOPEN;
    }
    int flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW;
    if (create) flags |= SQLITE_OPEN_CREATE;
    sqlite3 *db = NULL;
    int result = sqlite3_open_v2(path, &db, flags, NULL);
    if (result == SQLITE_OK &&
        (sqlite3mc_config(db, "cipher", CODEC_TYPE_AES256) < 0 ||
         sqlite3mc_config_cipher(db, "aes256cbc", "legacy", 0) < 0 ||
         sqlite3mc_config_cipher(db, "aes256cbc", "kdf_iter", 4001) < 0)) result = SQLITE_ERROR;
    if (result == SQLITE_OK && password && *password)
        result = sqlite3_key(db, password, (int)strlen(password));
    sqlite3_stmt *statement = NULL;
    if (result == SQLITE_OK)
        result = sqlite3_prepare_v2(db, "SELECT count(*) FROM sqlite_master", -1, &statement, NULL);
    if (result == SQLITE_OK) {
        int step = sqlite3_step(statement);
        result = step == SQLITE_ROW ? SQLITE_OK : step;
    }
    sqlite3_finalize(statement);
    if (result != SQLITE_OK) { if (db) sqlite3_close(db); return result; }
    *database = db;
    return SQLITE_OK;
}
