#ifndef WELINK_MEETING_NATIVE_IDENTITY_H
#define WELINK_MEETING_NATIVE_IDENTITY_H
/* Actual Linux identity, derived by the same provider used by login/common-utils.
 * Process-lifetime borrowed string; NULL means the provider could not obtain it.
 * Never imports a Wine identity and never logs or invents a device identifier. */
__attribute__((visibility("default"))) const char *meeting_native_device_id(void);
#endif
