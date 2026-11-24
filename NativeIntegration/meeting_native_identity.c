#include "meeting_native_identity.h"
#include "login_security_identity.h"
#include <pthread.h>
#include <openssl/crypto.h>

static pthread_once_t identity_once = PTHREAD_ONCE_INIT;
static char device_identity[67];

static void initialize_identity(void)
{
    if (login_security_identity(NULL, device_identity))
        OPENSSL_cleanse(device_identity, sizeof(device_identity));
}

const char *meeting_native_device_id(void)
{
    if (pthread_once(&identity_once, initialize_identity) || !device_identity[0]) return NULL;
    return device_identity;
}
