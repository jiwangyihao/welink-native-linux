/* SQLite3MC 1.4.6 uses x86 AES intrinsics without per-function ISA attributes.
 * Scope the required instructions to its five accelerated helpers; keep the
 * runtime AES/SSE4.1 check and the rest of SQLite on the baseline ia32 ISA.
 * Forced in only while compiling the pinned codec amalgamation. */
#ifndef WELINK_NATIVE_CODEC_TARGET_H
#define WELINK_NATIVE_CODEC_TARGET_H
#ifndef _GNU_SOURCE
#define _GNU_SOURCE 1
#endif
#if (defined(__i386__) || defined(__x86_64__)) && defined(__GNUC__)
#include <emmintrin.h>
#define WELINK_AES_TARGET __attribute__((target("aes,sse4.1")))
static WELINK_AES_TARGET int aesGenKeyEncryptInternal(const unsigned char *, int, __m128i *);
static WELINK_AES_TARGET int aesGenKeyEncrypt(const unsigned char *, int, unsigned char *);
static WELINK_AES_TARGET int aesGenKeyDecrypt(const unsigned char *, int, unsigned char *);
static WELINK_AES_TARGET void aesEncryptCBC(const unsigned char *, unsigned char *,
                                            unsigned char[16], unsigned long,
                                            const unsigned char *, int);
static WELINK_AES_TARGET void aesDecryptCBC(const unsigned char *, unsigned char *,
                                            unsigned char[16], unsigned long,
                                            const unsigned char *, int);
#undef WELINK_AES_TARGET
#endif
#endif
