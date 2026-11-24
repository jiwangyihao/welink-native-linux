/* Software KMC v2 compatibility, verified against KMC 3.0.0.SPC001.B002.
 * This is the vendor CBC/PKCS#7 format, not an authenticated-encryption format.
 * Keystore records are authenticated with the vendor's RMK-derived HMAC key.
 * Existing stores are read-only; creation publishes two independent 0600 files.
 */
#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#define _TIME_BITS 64
#include "kmc_compat.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

static const unsigned char store_magic[32] = {
    0x5f,0x64,0x97,0x8d,0x19,0x4f,0x89,0xcf,0xa8,0x3f,0x8e,0xe1,0xdb,0x01,0x3c,0x0c,
    0x88,0x42,0x4a,0x1c,0xb7,0xfc,0xad,0x70,0x4e,0x45,0x13,0xa5,0x14,0x46,0x71,0x6c
};
/* The DLL's fixed third derivation component; this is not a user's key. */
static const unsigned char material_c[32] = {
    0xb2,0xa1,0x0c,0x73,0x52,0x73,0x76,0xa1,0x60,0x62,0x2e,0x08,0x52,0x08,0x2e,0xa9,
    0x60,0xbc,0x2e,0x73,0x52,0x0b,0x0c,0xbc,0xee,0x0a,0x2e,0x08,0x52,0x9c,0x76,0xa9
};
static const char primary_name[] = "kmcStore.dat";
static const char backup_name[] = "kmcStore_bak.dat";
static const char hex_digits[] = "0123456789abcdef";

static uint32_t get32(const unsigned char *p)
{
    return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) | p[3];
}

static unsigned get16(const unsigned char *p)
{
    return ((unsigned)p[0] << 8) | p[1];
}

static void put32(unsigned char *p, uint32_t v)
{
    p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v;
}

static void put16(unsigned char *p, unsigned v)
{
    p[0] = v >> 8; p[1] = v;
}

static int cbc(int encrypt, const unsigned char key[32], const unsigned char iv[16],
               const unsigned char *input, int length, unsigned char *output, int *written)
{
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (!ctx) return ENOMEM;
    int first = 0, last = 0;
    int ok = EVP_CipherInit_ex(ctx, EVP_aes_256_cbc(), NULL, key, iv, encrypt) == 1 &&
             EVP_CipherUpdate(ctx, output, &first, input, length) == 1 &&
             EVP_CipherFinal_ex(ctx, output + first, &last) == 1;
    EVP_CIPHER_CTX_free(ctx);
    if (!ok) return encrypt ? EIO : EBADMSG;
    *written = first + last;
    return 0;
}

static int derive_rmk(const unsigned char root[256], unsigned char rmk[64])
{
    uint32_t iterations = get32(root + 0x34);
    if (!iterations || iterations > INT_MAX) return ENOTSUP;
    unsigned char material[32];
    for (size_t i = 0; i < sizeof(material); ++i)
        material[i] = root[0x38 + i] ^ root[0x58 + i] ^ material_c[i];
    int ok = PKCS5_PBKDF2_HMAC((const char *)material, sizeof(material),
                              root + 0x98, 32, (int)iterations, EVP_sha256(), 64, rmk);
    OPENSSL_cleanse(material, sizeof(material));
    return ok == 1 ? 0 : EIO;
}

static int record_tag(const unsigned char record[256], const unsigned char rmk[64],
                      const unsigned char master[32], unsigned char tag[32])
{
    /* The DLL authenticates attributes + plaintext length + unwrapped key. */
    unsigned char authenticated[64];
    memcpy(authenticated, record, 0x1c);
    memcpy(authenticated + 0x1c, record + 0x5c, 4);
    memcpy(authenticated + 0x20, master, 32);
    unsigned length = 0;
    int ok = HMAC(EVP_sha256(), rmk + 32, 32, authenticated,
                  sizeof(authenticated), tag, &length) != NULL && length == 32;
    OPENSSL_cleanse(authenticated, sizeof(authenticated));
    return ok ? 0 : EIO;
}

static int read_at(int fd, unsigned char *buffer, size_t length, off_t offset)
{
    while (length) {
        ssize_t n = pread(fd, buffer, length, offset);
        if (n < 0) { if (errno == EINTR) continue; return errno; }
        if (!n) return EBADMSG;
        buffer += n; length -= (size_t)n; offset += n;
    }
    return 0;
}

static int read_key(int directory, const char *name, uint32_t domain, uint32_t *id,
                    const unsigned char *expected_hash, unsigned char master[32])
{
    int fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return errno;
    unsigned char root[256], record[256], rmk[64], digest[32], decoded[48];
    struct stat st;
    int error = 0;
    if (fstat(fd, &st) != 0) { error = errno; goto done; }
    if (!S_ISREG(st.st_mode)) { error = EINVAL; goto done; }
    error = read_at(fd, root, sizeof(root), 0);
    if (error) goto done;
    if (memcmp(root, store_magic, sizeof(store_magic)) || get16(root + 0x20) != 2) {
        error = ENOTSUP; goto done;
    }
    uint32_t count = get32(root + 0xb8);
    if (st.st_size != (off_t)256 + (off_t)count * 256 ||
        !SHA256(root + 0x20, 0xc0, digest) || CRYPTO_memcmp(digest, root + 0xe0, 32)) {
        error = EBADMSG; goto done;
    }
    error = derive_rmk(root, rmk);
    if (error) goto done;
    error = ENOKEY;
    for (uint32_t i = 0; i < count; ++i) {
        int status = read_at(fd, record, sizeof(record), (off_t)(i + 1ULL) * 256);
        if (status) { error = status; break; }
        if (get32(record) != domain) continue;
        if (expected_hash ? get32(record + 4) != *id :
            (record[10] != 1 || get16(record + 8) != 3)) continue;
        if (get32(record + 0x1c) != 7 || get32(record + 0x58) != 48 ||
            get32(record + 0x5c) != 32) { error = ENOTSUP; break; }
        int length = 0;
        error = cbc(0, rmk, record + 0x48, record + 0x60, 48, decoded, &length);
        if (error) break;
        if (length != 32) { error = EBADMSG; break; }
        error = record_tag(record, rmk, decoded, digest);
        if (error) break;
        if (CRYPTO_memcmp(digest, record + 0xe0, 32)) { error = EBADMSG; break; }
        if (expected_hash && (!SHA256(decoded, 32, digest) ||
                              CRYPTO_memcmp(digest, expected_hash, 8))) {
            error = ENOKEY; break;
        }
        memcpy(master, decoded, 32);
        *id = get32(record + 4);
        error = 0;
        break;
    }
 done:
    close(fd);
    OPENSSL_cleanse(root, sizeof(root));
    OPENSSL_cleanse(record, sizeof(record));
    OPENSSL_cleanse(digest, sizeof(digest));
    OPENSSL_cleanse(rmk, sizeof(rmk));
    OPENSSL_cleanse(decoded, sizeof(decoded));
    return error;
}

static int store_time(unsigned char out[8], time_t value)
{
    struct tm tm;
    if (!gmtime_r(&value, &tm) || tm.tm_year < -1900 || tm.tm_year > 63635) return EOVERFLOW;
    put16(out, (unsigned)(tm.tm_year + 1900));
    out[2] = tm.tm_mon + 1; out[3] = tm.tm_mday; out[4] = tm.tm_hour;
    out[5] = tm.tm_min; out[6] = tm.tm_sec; out[7] = tm.tm_wday ? tm.tm_wday : 7;
    return 0;
}

static int write_new_store(int directory, const char *name, const unsigned char data[512])
{
    unsigned char random[8];
    if (RAND_bytes(random, sizeof(random)) != 1) return EIO;
    char temporary[29] = ".kmc-v2-";
    for (size_t i = 0; i < sizeof(random); ++i) {
        temporary[8 + 2*i] = hex_digits[random[i] >> 4];
        temporary[9 + 2*i] = hex_digits[random[i] & 15];
    }
    memcpy(temporary + 24, ".tmp", 5);
    int fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (fd < 0) return errno;
    int error = 0;
    size_t offset = 0;
    while (offset < 512) {
        ssize_t n = write(fd, data + offset, 512 - offset);
        if (n < 0) { if (errno == EINTR) continue; error = errno; break; }
        if (!n) { error = EIO; break; }
        offset += (size_t)n;
    }
    if (!error && fsync(fd) != 0) error = errno;
    if (close(fd) != 0 && !error) error = errno;
    /* linkat publishes without ever replacing an existing file. Backups use
     * a separate temporary inode, so a damaged primary cannot damage both. */
    if (!error && linkat(directory, temporary, directory, name, 0) != 0) error = errno;
    unlinkat(directory, temporary, 0);
    return error;
}

static int create_store(int primary_dir, const char *primary,
                         int backup_dir, const char *backup, unsigned char master[32])
{
    unsigned char data[512] = {0}, rmk[64];
    unsigned char *record = data + 256;
    int error = EIO, written = 0;
    time_t now = time(NULL);
    if (now == (time_t)-1) goto done;
    memcpy(data, store_magic, sizeof(store_magic));
    put16(data + 0x20, 2);
    if (store_time(data + 0x24, now) || store_time(data + 0x2c, now + 3650LL*86400) ||
        store_time(record + 0x0c, now) || store_time(record + 0x14, now + 180LL*86400)) {
        error = EOVERFLOW; goto done;
    }
    put32(data + 0x34, 10000);
    if (RAND_bytes(data + 0x38, 64) != 1 || RAND_bytes(data + 0x98, 32) != 1 ||
        RAND_bytes(master, 32) != 1 || RAND_bytes(record + 0x48, 16) != 1) goto done;
    put32(data + 0xb8, 1);
    put32(data + 0xbc, 1);
    put32(data + 0xc4, 1);
    if (!SHA256(data + 0x20, 0xc0, data + 0xe0)) goto done;
    put32(record + 4, 1);
    put16(record + 8, 3);
    record[10] = 1;
    put32(record + 0x1c, 7);
    put32(record + 0x58, 48);
    put32(record + 0x5c, 32);
    error = derive_rmk(data, rmk);
    if (error) goto done;
    error = cbc(1, rmk, record + 0x48, master, 32, record + 0x60, &written);
    if (error) goto done;
    if (written != 48) { error = EIO; goto done; }
    error = record_tag(record, rmk, master, record + 0xe0);
    if (error) goto done;
    error = write_new_store(primary_dir, primary, data);
    if (error) goto done;
    error = write_new_store(backup_dir, backup, data);
    if (!error && fsync(primary_dir) != 0) error = errno;
    if (!error && backup_dir != primary_dir && fsync(backup_dir) != 0) error = errno;
 done:
    OPENSSL_cleanse(data, sizeof(data));
    OPENSSL_cleanse(rmk, sizeof(rmk));
    return error;
}

struct key_paths {
    const char *directory, *primary, *backup;
};

static int open_parent(const char *path, const char **name)
{
    if (!path || !*path) { errno = EINVAL; return -1; }
    const char *slash = strrchr(path, '/');
    *name = slash ? slash + 1 : path;
    if (!**name || !strcmp(*name, ".") || !strcmp(*name, "..")) {
        errno = EINVAL; return -1;
    }
    if (!slash) return open(".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    size_t length = slash == path ? 1 : (size_t)(slash - path);
    if (length >= PATH_MAX) { errno = ENAMETOOLONG; return -1; }
    char directory[PATH_MAX];
    memcpy(directory, path, length);
    directory[length] = 0;
    return open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
}

static int load_key(const struct key_paths *paths, uint32_t domain, uint32_t *id,
                    const unsigned char *expected_hash, int create,
                    unsigned char master[32])
{
    const char *primary = paths->primary, *backup = paths->backup;
    int first, second, error = 0;
    if (paths->directory) {
        if (!*paths->directory) return EINVAL;
        first = open(paths->directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (first < 0) return errno;
        second = first;
    } else {
        first = open_parent(primary, &primary);
        if (first < 0) return errno;
        second = open_parent(backup, &backup);
        if (second < 0) { error = errno; close(first); return error; }
    }
    int same = first == second, low = first, high = second;
    if (!same) {
        struct stat a, b;
        if (fstat(first, &a) || fstat(second, &b)) { error = errno; goto done; }
        same = a.st_dev == b.st_dev && a.st_ino == b.st_ino;
        if (same) {
            close(second);
            second = high = first;
        } else if (a.st_dev > b.st_dev || (a.st_dev == b.st_dev && a.st_ino > b.st_ino)) {
            /* Stable inode ordering also covers reversed explicit path pairs. */
            low = second; high = first;
        }
    }
    if (same && !strcmp(primary, backup)) { error = EINVAL; goto done; }
    if (flock(low, LOCK_EX) || (high != low && flock(high, LOCK_EX))) {
        error = errno; goto done;
    }
    int primary_error = read_key(first, primary, domain, id, expected_hash, master);
    error = primary_error;
    if (primary_error) {
        int backup_error = read_key(second, backup, domain, id, expected_hash, master);
        if (!backup_error) error = 0;
        else if (primary_error == ENOENT && backup_error == ENOENT && create && !expected_hash) {
            error = create_store(first, primary, second, backup, master);
            if (!error) *id = 1;
        } else if (primary_error == ENOENT) error = backup_error;
    }
 done:
    if (second != first) close(second);
    close(first);
    return error;
}

static int encrypt_paths(const struct key_paths *paths, int create,
                          const unsigned char *plain, size_t length,
                          char **hex, size_t *binary_length)
{
    *hex = NULL; *binary_length = 0;
    if (!plain || !length || length > INT_MAX - 80) return EINVAL;
    size_t total = 64 + (length / 16 + 1) * 16;
    if (total > (SIZE_MAX - 1) / 2) return EOVERFLOW;
    unsigned char master[32], working[32], digest[32];
    uint32_t id = 0;
    int error = load_key(paths, 0, &id, NULL, create, master);
    unsigned char *buffer = NULL;
    if (error) goto done;
    buffer = malloc(2 * total + 1);
    if (!buffer) { error = ENOMEM; goto done; }
    memset(buffer, 0, 64);
    put32(buffer, 2); put32(buffer + 12, id); put32(buffer + 16, 7);
    if (!SHA256(master, 32, digest) || RAND_bytes(buffer + 28, 24) != 1) {
        error = EIO; goto done;
    }
    memcpy(buffer + 20, digest, 8);
    if (PKCS5_PBKDF2_HMAC((const char *)master, 32, buffer + 28, 8, 1,
                          EVP_sha256(), 32, working) != 1) { error = EIO; goto done; }
    int written = 0;
    error = cbc(1, working, buffer + 36, plain, (int)length, buffer + 64, &written);
    if (error) goto done;
    if ((size_t)written != total - 64) { error = EIO; goto done; }
    put32(buffer + 60, (uint32_t)written);
    /* Expand backwards in the output allocation; unread binary bytes remain intact. */
    for (size_t i = total; i-- > 0;) {
        unsigned char value = buffer[i];
        buffer[2*i] = hex_digits[value >> 4]; buffer[2*i + 1] = hex_digits[value & 15];
    }
    buffer[2*total] = 0;
    *hex = (char *)buffer; *binary_length = total;
    buffer = NULL;
 done:
    if (buffer) { OPENSSL_cleanse(buffer, 2 * total + 1); free(buffer); }
    OPENSSL_cleanse(master, sizeof(master));
    OPENSSL_cleanse(working, sizeof(working));
    OPENSSL_cleanse(digest, sizeof(digest));
    return error;
}

static int unhex(const char *text, unsigned char *out, size_t bytes)
{
    for (size_t i = 0; i < bytes; ++i) {
        unsigned value = 0;
        for (unsigned j = 0; j < 2; ++j) {
            unsigned char c = (unsigned char)text[2*i + j];
            unsigned digit;
            if (c >= '0' && c <= '9') digit = c - '0';
            else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
            else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
            else return EINVAL;
            value = (value << 4) | digit;
        }
        out[i] = (unsigned char)value;
    }
    return 0;
}

static int decrypt_paths(const struct key_paths *paths, const char *hex, size_t length,
                          unsigned char **plain, size_t *plain_length)
{
    *plain = NULL; *plain_length = 0;
    if (!hex || (length & 1) || length < 160) return EINVAL;
    unsigned char header[64], master[32], working[32];
    int error = unhex(hex, header, sizeof(header));
    if (error) return error;
    if (get32(header) != 2 || get32(header + 4) != 0 || get32(header + 16) != 7) return ENOTSUP;
    size_t body_length = length / 2 - sizeof(header);
    if (body_length > INT_MAX || body_length % 16 || get32(header + 60) != body_length) return EINVAL;
    /* common_utils supplies 256 output bytes to a CBC decoder requiring
     * room for an extra block. Match its 239-byte plaintext boundary. */
    if (body_length > 256 - 16) return ENOBUFS;
    unsigned char *buffer = malloc(body_length + 1);
    if (!buffer) return ENOMEM;
    error = unhex(hex + 128, buffer, body_length);
    if (error) goto done;
    uint32_t id = get32(header + 12);
    error = load_key(paths, get32(header + 8), &id, header + 20, 0, master);
    if (error) goto done;
    if (PKCS5_PBKDF2_HMAC((const char *)master, 32, header + 28, 8, 1,
                          EVP_sha256(), 32, working) != 1) { error = EIO; goto done; }
    int written = 0;
    error = cbc(0, working, header + 36, buffer, (int)body_length, buffer, &written);
    if (!error) {
        buffer[written] = 0;
        *plain = buffer; *plain_length = (size_t)written;
        buffer = NULL;
    }
 done:
    if (buffer) { OPENSSL_cleanse(buffer, body_length + 1); free(buffer); }
    OPENSSL_cleanse(master, sizeof(master));
    OPENSSL_cleanse(working, sizeof(working));
    return error;
}

int kmc_encrypt(const char *directory, const unsigned char *plain, size_t length,
                char **hex, size_t *binary_length)
{
    if (!directory) { *hex = NULL; *binary_length = 0; return EINVAL; }
    const struct key_paths paths = {directory, primary_name, backup_name};
    return encrypt_paths(&paths, 1, plain, length, hex, binary_length);
}

int kmc_decrypt(const char *directory, const char *hex, size_t length,
                unsigned char **plain, size_t *plain_length)
{
    if (!directory) { *plain = NULL; *plain_length = 0; return EINVAL; }
    const struct key_paths paths = {directory, primary_name, backup_name};
    return decrypt_paths(&paths, hex, length, plain, plain_length);
}

int kmc_initialize_paths(const char *primary, const char *backup)
{
    const struct key_paths paths = {NULL, primary, backup};
    unsigned char master[32];
    uint32_t id = 0;
    int error = load_key(&paths, 0, &id, NULL, 1, master);
    OPENSSL_cleanse(master, sizeof(master));
    return error;
}

int kmc_encrypt_paths(const char *primary, const char *backup,
                      const unsigned char *plain, size_t length,
                      char **hex, size_t *binary_length)
{
    const struct key_paths paths = {NULL, primary, backup};
    return encrypt_paths(&paths, 0, plain, length, hex, binary_length);
}

int kmc_decrypt_paths(const char *primary, const char *backup,
                      const char *hex, size_t length,
                      unsigned char **plain, size_t *plain_length)
{
    const struct key_paths paths = {NULL, primary, backup};
    return decrypt_paths(&paths, hex, length, plain, plain_length);
}
