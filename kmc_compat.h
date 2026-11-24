/* Compatibility with the software KMC v2 stores used by WeLink's KMC 3 DLL.
 * Operations return zero or a positive errno. Outputs are malloc-owned on success.
 * No proprietary runtime is needed; existing stores are never rewritten.
 * Supports software-v2 AES-256-CBC records, not the complete vendor SDK.
 * The JSON adapter preserves the original Base64 input and CBC output limits;
 * verify_kmc.py covers vendor fixtures, limits, backup recovery and corruption. */
#ifndef WELINK_KMC_COMPAT_H
#define WELINK_KMC_COMPAT_H

#include <stddef.h>

int kmc_encrypt(const char *directory, const unsigned char *plain, size_t length,
                char **hex, size_t *binary_length);
int kmc_decrypt(const char *directory, const char *hex, size_t length,
                unsigned char **plain, size_t *plain_length);

/* Explicit filenames used by wk_tup_support's KeyStoreFile/KeyStoreFileBak.
 * Parent directories must exist. Initialize authenticates an existing usable
 * master key, or creates both stores only when neither exists. Encrypt/decrypt
 * never initialize implicitly. No operation rewrites existing files. */
int kmc_initialize_paths(const char *primary, const char *backup);
int kmc_encrypt_paths(const char *primary, const char *backup,
                      const unsigned char *plain, size_t length,
                      char **hex, size_t *binary_length);
int kmc_decrypt_paths(const char *primary, const char *backup,
                      const char *hex, size_t length,
                      unsigned char **plain, size_t *plain_length);

#endif
