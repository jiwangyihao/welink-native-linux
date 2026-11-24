/* Native owner-thread ABI for the original wk_tup_support command bus.
 * Callback and library stay pinned until process exit: the detached worker is
 * process-lived. Init, dispatch and shutdown belong to one FFI owner thread.
 * dispatch returns delivered callbacks, 0 if idle/reentrant, or negative errno.
 * Shutdown invalidates the epoch immediately, never joins and never calls JS.
 * Evidence and parent-run verification: Support/analysis, verify_support.js.
 */
#ifndef WELINK_TUP_SUPPORT_H
#define WELINK_TUP_SUPPORT_H
#define SUPPORT_EXPORT __attribute__((visibility("default")))
typedef void (*tup_support_callback)(const char *json);
SUPPORT_EXPORT void tup_support_set_log_path(const char *path, int level, int size_kb, int count);
SUPPORT_EXPORT void tup_support_init(void *callback);
SUPPORT_EXPORT void tup_support_send_msg(const char *json);
SUPPORT_EXPORT void tup_support_shutdown(void);
SUPPORT_EXPORT int tup_support_dispatch(void);
#endif
