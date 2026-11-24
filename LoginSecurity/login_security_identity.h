/* Shared identity for the native login and common-utils implementations.
 * Returns zero or errno. Optional info receives a json-c-owned deviceInfo array;
 * serial has space for two source markers, 64 uppercase SHA256 digits and NUL.
 * Hardware-derived identity is native to this Linux host, never imported from
 * a Wine registry. Caller must json_object_put(*info). */
#ifndef WELINK_LOGIN_SECURITY_IDENTITY_H
#define WELINK_LOGIN_SECURITY_IDENTITY_H
#include <json-c/json.h>
/* Raw root-disk serial, not the hashed device ID. Writes an empty string when
 * unavailable (if capacity permits); never substitutes another identifier. */
void login_security_disk_serial(char *out, size_t capacity);
int login_security_identity(struct json_object **info, char serial[67]);
/* Original common-utils FilterWordStr mode 10, used in the uuid HTTP header. */
void login_security_mask_uuid(const char *serial, char *out, size_t capacity);
#endif
