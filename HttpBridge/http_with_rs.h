/* Native HTTP bus ABI for the original libraries/js/httpWithRsSdk.js.
 * Original definitions: http_json_init: int(pointer),
 * http_json_set_log_param: int(int,int,string), http_json_call_msg: int(string).
 * Callback: void(string), cdecl, JSON UTF-8, valid only during invocation.
 * Add HttpWithRsDispatchCallbacks: int() and http_json_shutdown: int().
 * Pump once per event-loop turn on the thread which called http_json_init.
 * Drain only one queued item per pump: the JS Promise continuation must install
 * UploadDownloadManage's handle before its progress/result notification runs.
 * Keep EVERY ffi.Callback and Library object in a process-lifetime JS registry,
 * including retired owners. Never dlclose or free callbacks at renderer teardown.
 * Shutdown only cancels; it never waits for a worker or calls JavaScript.
 * Loading this library with RTLD_NODELETE (also enforced in init) is required.
 * All symbols use default visibility even with -fvisibility=hidden.
 * No raw HttpWithRs* exports are bound by the matched JS. The Windows exports
 * ServiceStartup/Stop, SendMsgImport/Export, RecvMsgImport/Export are native
 * queue internals, not aliases for the callback ABI; none are invented here.
 */
#ifndef WELINK_HTTP_WITH_RS_H
#define WELINK_HTTP_WITH_RS_H
#if defined(__GNUC__)
#define HTTP_RS_API __attribute__((visibility("default")))
#else
#define HTTP_RS_API
#endif
#ifdef __cplusplus
extern "C" {
#endif
typedef void (*http_rs_callback)(const char *message);
HTTP_RS_API int http_json_init(http_rs_callback callback);
HTTP_RS_API int http_json_call_msg(const char *message);
HTTP_RS_API int http_json_set_log_param(int level, int module, const char *directory);
HTTP_RS_API int http_json_shutdown(void);
HTTP_RS_API int HttpWithRsDispatchCallbacks(void);
#ifdef __cplusplus
}
#endif
#endif
