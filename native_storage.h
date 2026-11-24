/* Shared storage primitives for the original WeLink database formats.
 * Metadata is KMC ciphertext + '|' + the ASCII hex nonce, not a new key format.
 * Derivation is PBKDF2-SHA256(password=nonce, salt=plaintext, 4096), uppercase hex.
 * Existing invalid metadata/database files are never replaced as error recovery.
 * Pedestal account metadata contains the exact account, without a device/IV suffix.
 * verify_storage.py and verify_pedestal.py exercise original encrypted fixtures.
 */
#ifndef WELINK_NATIVE_STORAGE_H
#define WELINK_NATIVE_STORAGE_H
#include <stddef.h>
#ifndef SQLITE_API
#define SQLITE_API __attribute__((visibility("hidden")))
#endif
#include "vendor/sqlite3mc-1.4.6/sqlite3mc_amalgamation.h"

#define NATIVE_STORAGE_PLAIN_SIZE 240
#define NATIVE_STORAGE_METADATA_SIZE 642
struct native_storage_key {
    char plain[NATIVE_STORAGE_PLAIN_SIZE];
    char nonce[33];
    char metadata[NATIVE_STORAGE_METADATA_SIZE];
    char password[65];
};

/* Filesystem/key operations return zero or positive errno. */
int native_storage_mkdirs(const char *directory);
int native_storage_read_metadata(const char *path, char *output, size_t capacity);
int native_storage_derive(const char *plain, const char *nonce, char password[65]);
int native_storage_load_key(const char *path, const char *kmc_directory,
                            const char *expected_plain, int create,
                            struct native_storage_key *key);
/* Explicit setter used by command 77; does not invent a key on read failure. */
int native_storage_set_key(const char *path, const char *plain, const char *nonce,
                           const char *metadata, struct native_storage_key *key);
/* Validates the complete next key before modifying SQLite. Publication failure
 * rolls back the database key; ENOTRECOVERABLE means that rollback also failed. */
int native_storage_rekey(sqlite3 *database, const char *path, const char *plain,
                         const char *nonce, const char *metadata,
                         struct native_storage_key *key);
void native_storage_clear_key(struct native_storage_key *key);
/* SQLite result codes; validates the key before callers create/update tables. */
int native_storage_open(const char *path, const char *password, int create,
                        sqlite3 **database);
#endif
