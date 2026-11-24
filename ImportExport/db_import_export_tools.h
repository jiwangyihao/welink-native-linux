#ifndef WELINK_DB_IMPORT_EXPORT_TOOLS_H
#define WELINK_DB_IMPORT_EXPORT_TOOLS_H
#ifdef __cplusplus
extern "C" {
#endif
#define IMPORT_EXPORT_API __attribute__((visibility("default")))
typedef int (*import_export_callback)(const char *json);
/* Registration, not Startup, establishes the owner thread. Callback and DSO
 * handles must remain process-pinned by the FFI host. No callback runs on a
 * worker. A replacement registration cancels the previous epoch. */
IMPORT_EXPORT_API int CallBack(import_export_callback callback);
/* Original ABI: -1 without a registered callback or with NULL input, otherwise
 * 0 means submitted, never completed. Native admission errors are -errno.
 * Operation errors use the original resType/param callback envelope. */
IMPORT_EXPORT_API int Startup(const char *parameters);
/* Nonblocking cancellation request. 0 on acceptance/idempotent idle call;
 * -EPERM on the wrong thread. Completion is reported after rollback/cleanup.
 * Cancellation cannot undo an operation already at its commit point. */
IMPORT_EXPORT_API int Shutdown(void);
/* At most one event per call; returns 0/1, or -EPERM off the owner thread.
 * Recursive dispatch returns 0. Stale operation/registration events are dropped. */
IMPORT_EXPORT_API int ImportExportDispatchCallbacks(void);
#ifdef __cplusplus
}
#endif
#endif
