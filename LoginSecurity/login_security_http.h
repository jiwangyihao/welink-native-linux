/* Shared synchronous HTTPS/HTTP + Huawei Compass routing. Contexts are owned by
 * one caller/thread; use one context per SDK worker or serialize access.
 * Configuration is the observed rs_url/verify_mode/ca_cert_path/proxy_* object.
 * All outputs are owned by result and released with ls_http_result_clear. */
#ifndef WELINK_LOGIN_SECURITY_HTTP_H
#define WELINK_LOGIN_SECURITY_HTTP_H
#include <curl/curl.h>
#include <json-c/json.h>
#include <stdatomic.h>
#include <time.h>
struct ls_http_context {
    struct json_object *settings, *compass, *addresses, *last_ips;
    time_t queried;
    long ttl;
    int enabled;
    struct json_object *standby;
};
struct ls_http_buffer { char *data; size_t length,capacity; };
struct ls_http_result {
    struct ls_http_buffer body,cookies;
    struct json_object *json;
    struct curl_slist *headers;
    long status;
    CURLcode transport;
    char primary_ip[64];
    char target_host[256];
    unsigned target_port;
    /* Trust selected for the final attempt. ca_fallback records a custom-CA
     * failure followed by a system-CA attempt, even when that attempt fails.
     * ca_path is owned by result; NULL when TLS trust was not configured. */
    int used_system_ca, ca_fallback;
    char *ca_path;
};
struct ls_http_options {
    struct json_object *settings;
    long connect_timeout, total_timeout;
    atomic_int *cancel;
    int require_http_200;
    /* Optional request-generation cancellation, independent of shutdown. */
    const atomic_uint *generation;
    unsigned expected_generation;
    /* Optional millisecond limits: positive overrides seconds, -1 means
     * libcurl's unlimited/default timeout. Zero preserves the existing API. */
    long connect_timeout_ms, total_timeout_ms;
    int (*cancel_check)(void *);
    void *cancel_context;
    int omit_client_identity;
};
/* prepare is called before EVERY route/certificate attempt, with attempt 0
 * first. It must rewind uploads and restart downloads at their initial offset
 * before accepting bytes, or fail if replay is unsafe. Download truncation may
 * wait for a usable response so a failed DNS/TLS attempt cannot erase prior
 * partial bytes. It configures only
 * method/body and I/O callbacks; routing, TLS, proxy and headers are shared.
 * The caller owns curl and keeps it on success (also supports CONNECT_ONLY).
 * No upload/download bytes are buffered by this interface. */
struct ls_http_stream {
    CURLcode (*prepare)(CURL *, unsigned attempt, const char *target_url, void *);
    curl_xferinfo_callback progress;
    int (*terminal)(CURLcode, long status, void *);
    void *context;
    int transport_only;
};
/* destination must be zero-initialized or already initialized by this API. */
int ls_http_context_copy(struct ls_http_context *, const struct ls_http_context *);
/* Borrowed, server-advertised standby authority, or NULL. No synthesized
 * production domain: this follows the original flattened Compass map. */
const char *ls_http_standby_domain(const struct ls_http_context *, const char *host);
CURLcode ls_http_perform_stream(struct ls_http_context *, CURL *, const char *url,
    struct curl_slist *headers, const struct ls_http_options *,
    const struct ls_http_stream *, struct ls_http_result *);
int ls_http_set_rs(struct ls_http_context *,struct json_object *settings);
void ls_http_context_clear(struct ls_http_context *);
void ls_http_result_clear(struct ls_http_result *);
CURLcode ls_http_perform(struct ls_http_context *, const char *url,
    const char *method,const void *body,size_t body_size,struct curl_slist *headers,
    const struct ls_http_options *,struct ls_http_result *);
/* Returns a borrowed original Compass response, including standbyDomainConfig,
 * for the HTTP bus owner's configuration notification. NULL until a real reply. */
struct json_object *ls_http_compass_config(struct ls_http_context *);
/* Query only the configured RS endpoint. force bypasses a still-live cache;
 * failure retains the previous configuration and never reports it as a fresh
 * success. CURLE_OK means a real cached/fetched object, HTTP non-200 is
 * CURLE_HTTP_RETURNED_ERROR, malformed JSON is CURLE_WEIRD_SERVER_REPLY.
 * No configured/valid RS authority is CURLE_URL_MALFORMAT. Cancellation and
 * transport errors retain their CURLcode. This never issues a service request. */
CURLcode ls_http_query_compass(struct ls_http_context *, const struct ls_http_options *, int force);
#endif
