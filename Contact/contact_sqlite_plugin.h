#ifndef WELINK_CONTACT_SQLITE_PLUGIN_H
#define WELINK_CONTACT_SQLITE_PLUGIN_H

/* cdecl on Linux ia32, matching the seven live original FFI signatures.
 * The startup callback is pinned until shutdown and dispatched only by its owner.
 * Per-call SQL callbacks finish before their export returns, outside the lock.
 * GabReadZipFile is deliberately absent: the original export was disabled and
 * the complete frontend has no caller; the Linux integration removes that chain.
 */
typedef void (*contact_callback)(const char *json);
#define CONTACT_EXPORT __attribute__((visibility("default")))
CONTACT_EXPORT void ContactPluginSetLogPath(const char *directory);
CONTACT_EXPORT int SqliteServiceStartup(contact_callback callback);
CONTACT_EXPORT void SqliteRecvMsgImport(const char *json);
CONTACT_EXPORT void GabSqliteQueryAll(const char *sql, contact_callback callback);
CONTACT_EXPORT void GabSqliteExec(const char *sql, contact_callback callback);
CONTACT_EXPORT void GabSqliteQueryAllWithKey(const char *sql, contact_callback callback, const char *bindings);
CONTACT_EXPORT void GabSqliteExecWithKey(const char *sql, contact_callback callback, const char *bindings);
CONTACT_EXPORT int ContactPluginDispatchCallbacks(void);
CONTACT_EXPORT void ContactPluginShutdown(void);
#endif
