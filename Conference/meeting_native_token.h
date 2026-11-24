#ifndef WELINK_MEETING_NATIVE_TOKEN_H
#define WELINK_MEETING_NATIVE_TOKEN_H

#include <json-c/json.h>

/* Parameters supplied by the application's real conference/login configuration.
 * There are intentionally no invented device identities or service credentials.
 * This is the workplace ticket exchange, not full media-SDK initialization. */
struct meeting_native_token_config {
    const char *server;
    unsigned int port;
    const char *user_agent;
    const char *device_id;
    const char *terminal_version;
    const char *terminal_appid;
    const char *terminal_platform;
    const char *terminal_device_model;
    const char *proxy_url;
    const char *proxy_username;
    const char *proxy_password;
    const char *ca_bundle;
};

struct meeting_native_token_reply {
    long http_status;
    int curl_status;
    /* Owned response, including the server's error_code/error_msg on HTTP errors.
     * It can contain credentials. Never log it. Release with reply_clear(). */
    struct json_object *payload;
};

int meeting_native_token_transport_init(void);

/* Synchronous real HTTPS operation. long_ticket is the original is_large_tiket
 * flag, not inferred from token length. The caller supplies the real account and
 * middleGroundToken. Returns zero only for HTTP 200 with a nonempty accessToken.
 * Negative errno values describe local/transport/protocol failure; they are NOT
 * Huawei SDK result codes. Preserve server error_code separately in the adapter.
 * reply is an output parameter; clear a previous reply before reusing it.
 * No meetings are created/joined and no media SDK readiness is claimed. */
int meeting_native_exchange_ticket(const struct meeting_native_token_config *config,
                                  const char *account, const char *ticket,
                                  int long_ticket,
                                  struct meeting_native_token_reply *reply);
/* PUT /v2/usg/acs/token with the actual server-issued refreshToken. */
int meeting_native_refresh_token(const struct meeting_native_token_config *config,
                                 const char *refresh_token,
                                 struct meeting_native_token_reply *reply);
/* DELETE /v1/usg/acs/token with this session's accessToken. Only an actual
 * HTTP 200 confirms revocation; a documented empty response is accepted. */
int meeting_native_logout_token(const struct meeting_native_token_config *config,
                                const char *access_token,
                                struct meeting_native_token_reply *reply);
void meeting_native_token_reply_clear(struct meeting_native_token_reply *reply);

/* Explicit auth-only FFI surface in meeting_adapter.c. This does not initialize
 * the media engine. init accepts a JSON object containing required server,
 * port, userAgent and deviceId. longTicket is optional (integer 0 or 1), with
 * the original cmd1032 path's verified ShortTicket default of 0. Optional strings:
 * terminalVersion, terminalAppId, terminalPlatform, terminalDeviceModel, proxyUrl,
 * proxyUsername, proxyPassword and caBundle. Values must come from real runtime
 * configuration, never recordings of another user's credentials/device identity.
 *
 * Commands 1032 and 1001 authenticate and read the real in-process token cache.
 * Command 110 refreshes on the server; command 1030 performs real server logout.
 * Successful authentication requires a nonempty accessToken and a positive
 * validPeriod or future expireTime; when both are supplied, the earlier expiry
 * wins. Missing/invalid expiry never establishes a fresh authenticated cache.
 * Their notifications are 1032/1001/110/1030 respectively. A monotonic-clock
 * worker renews near the server's declared expiry; reads share an in-flight
 * refresh. Failed scheduled renewal is reported without an invented retry lease.
 * Logout is serialized behind an in-flight login/refresh and blocks token reads.
 * Media controls use the separate native-WebRTC RPC; command 50 only succeeds
 * after a verified engine-ready event. reset clears local secrets and cancels
 * publication of an in-flight login; it is NOT server logout.
 * capabilities returns a borrowed string copied immediately by FFI. Pin this
 * library and both registered callbacks for the lifetime of the process.
 * loginPending/operationPending are status flags, never unload/drain barriers.
 * The serialized worker remains alive for the process lifetime. */
__attribute__((visibility("default"))) int meeting_native_auth_init(const char *json);
__attribute__((visibility("default"))) void meeting_native_auth_reset(void);
__attribute__((visibility("default"))) const char *meeting_native_auth_capabilities(void);

/* Register on the FFI owner thread after set_c2js_callback and before auth_init.
 * The worker invokes this no-argument wake without holding either adapter lock;
 * the host must marshal it to that same owner and call auth_dispatch there.
 * ffi-napi does that marshaling for its Callback. Dispatch emits the original
 * JSON callbacks on the owner; it also supports synchronous reset reentry.
 * A reset before dispatch cancels stale results, including queued token reads.
 *
 * Both return zero on success. dispatch with no queued batch is a no-op.
 * Registration is process-lifetime: NULL is rejected, and replacing its callback
 * or owner is rejected with -EALREADY. Dispatch/js2c_sendmsg from another thread
 * return -EPERM. Keep servicing wakes through logout completion, then reset
 * local state before closing the client. Window disposal is NOT library unload:
 * never unregister/free either Callback or dlclose this library before exit. */
typedef void (*meeting_native_dispatch_callback)(void);
__attribute__((visibility("default"))) int meeting_native_auth_set_dispatch_callback(meeting_native_dispatch_callback callback);
__attribute__((visibility("default"))) int meeting_native_auth_dispatch(void);

/* Accepts the exact 'engine' event emitted by MeetingNativeWeb. Protocol:
 * welink-native-web/1; instance; monotonically increasing integer sequence;
 * event=engine-ready|engine-unavailable. Ready events also carry sdkVersion and
 * verified capability booleans. Duplicate/stale state messages are rejected.
 * Publish this in the process owning this library, not another Electron process. */
__attribute__((visibility("default"))) int meeting_native_web_state(const char *json);

typedef void (*meeting_native_callback)(const char *json);
__attribute__((visibility("default"))) int init_config(const char *json);
__attribute__((visibility("default"))) int set_c2js_callback(meeting_native_callback callback);
__attribute__((visibility("default"))) int js2c_sendmsg(const char *json);

#endif
