/* RSA wire format from wk_login.dll 7.47.6.95, RVAs 0x32090/0x33ba0.
 * Only a public server key is embedded here; no client credentials or tokens. */
#ifndef WELINK_LOGIN_SECURITY_CRYPTO_H
#define WELINK_LOGIN_SECURITY_CRYPTO_H
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rsa.h>
#include <openssl/err.h>
#include <openssl/crypto.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

static const char login_default_public_key[] =
"MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEAwjPIz2fKcVofW73dmh9sAi1V"
"2YeN46lhcQo6BcJGNl2NzlK78LwI0Yw7rZwx/oMP5ytIS9dbfd/BEqAF9Nfh2sMwYipX"
"AIuP9TtYeZTvtqLEbl++OmdrKQS/tWXYi7MI/OuKlCH0MnORHcgtxjCAtwc+kjSQx3meVH"
"nRboxNWMGcr7SXPlRNRo8CuuQIJPyHqSq3OdnKYuXFoPM3NnaUyBG61guFkqzyrf19fgcAr"
"IRGZL88wT3xHQQGpqSTGzsp52xxB/hUWqZfPLo17qJJyXbeVjUTkitMBR+QjzT/kK+Wb0J7"
"xsrORBFYSYs7g1Sfte2jJs5D/wRZbAtw+6qPVxXXORcYOtJ2Im29AGuoz51I7Gof8J0OQp3"
"TuNTTF/k6ywu9w1+VyGzCuaHcDX1GogOHF27tD3HPRXWgKnIEz7Al1z2ZXnndrXQ95DNgBd"
"QIIOl2GrrqxaTEf8xqeSkc0Bh9v1Ju14BKSw2+8/FTFo0rSaqhdAGFiO7wHI3wc3wzAgMBAAE=";

static EVP_PKEY *login_read_key(const char *base64)
{
    size_t n = strlen(base64);
    if (n > (size_t)INT_MAX-100) return NULL;
    /* The JS sends bare SubjectPublicKeyInfo Base64, not a PEM envelope. */
    size_t length = n+n/55+80;
    char *pem = malloc(length);
    if (!pem) return NULL;
    char *out = pem;
    const char *begin = "-----BEGIN PUBLIC KEY-----\n", *end = "-----END PUBLIC KEY-----\n";
    size_t b = strlen(begin); memcpy(out,begin,b); out += b;
    for (size_t i=0; i<n; i+=55) {
        size_t part = n-i < 55 ? n-i : 55;
        memcpy(out,base64+i,part); out += part; *out++ = '\n';
    }
    memcpy(out,end,strlen(end)+1);
    BIO *bio = BIO_new_mem_buf(pem,-1);
    EVP_PKEY *key = bio ? PEM_read_bio_PUBKEY(bio,NULL,NULL,NULL) : NULL;
    BIO_free(bio); free(pem);
    if (key && !EVP_PKEY_is_a(key,"RSA")) { EVP_PKEY_free(key); key = NULL; }
    ERR_clear_error();
    return key;
}

static char *login_rsa_base64(EVP_PKEY *key, const char *plain)
{
    size_t length = strlen(plain);
    if (!length) return strdup("");
    if (!key) return NULL;
    int size = EVP_PKEY_get_size(key);
    if (size <= 42) return NULL;
    /* The DLL advances by RSA_size-41, even though OAEP/SHA1 permits size-42.
     * Preserve its block framing and omission of a failed oversized block. */
    size_t part_size = (size_t)size-41;
    size_t count = length/part_size + (length%part_size != 0);
    if (count > (size_t)INT_MAX/(size_t)size) return NULL;
    size_t capacity = count*(size_t)size;
    unsigned char *cipher = malloc(capacity);
    EVP_PKEY_CTX *ctx = EVP_PKEY_CTX_new(key,NULL);
    size_t used = 0;
    if (!cipher || !ctx || EVP_PKEY_encrypt_init(ctx)<=0 ||
        EVP_PKEY_CTX_set_rsa_padding(ctx,RSA_PKCS1_OAEP_PADDING)<=0 ||
        EVP_PKEY_CTX_set_rsa_oaep_md(ctx,EVP_sha1())<=0 ||
        EVP_PKEY_CTX_set_rsa_mgf1_md(ctx,EVP_sha1())<=0) goto fail;
    for (size_t i=0; i<length; i+=part_size) {
        size_t part = length-i<part_size ? length-i : part_size, n = (size_t)size;
        if (EVP_PKEY_encrypt(ctx,cipher+used,&n,(const unsigned char *)plain+i,part)>0)
            used += n;
        else ERR_clear_error();
    }
    if (used > ((size_t)INT_MAX/4)*3-3) goto fail;
    size_t encoded = 4*((used+2)/3);
    char *result = malloc(encoded+1);
    if (!result) goto fail;
    EVP_EncodeBlock((unsigned char *)result,cipher,(int)used);
    OPENSSL_clear_free(cipher,capacity);
    EVP_PKEY_CTX_free(ctx); ERR_clear_error();
    return result;
fail:
    if (cipher) OPENSSL_clear_free(cipher,capacity);
    EVP_PKEY_CTX_free(ctx); ERR_clear_error();
    return NULL;
}
#endif
