/* Onebox V2 operations recovered from tup_httpofflinefile.dll.
 * SSO/session renewal, signed links, file handles, progress, resumable downloads,
 * deduplicated/single/multipart uploads, multipart resume and server-side copy.
 * Legacy server modes and protected SVN file I/O require their real providers;
 * they fail explicitly rather than bypassing protection or fabricating results.
 * Dependencies: native_rpc.h, shared LoginSecurity HTTP, json-c, libcurl,
 * libcrypto, gio-2.0 and gthread-2.0.
 * No credentials, HTTP bodies, URLs or user paths are logged or persisted.
 * Results are pumped only on the initialization thread; shutdown invalidates
 * that startup epoch and leaves all worker/session cleanup to the worker.
 */
#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#include "native_rpc.h"
#include "im_transport_dispatch.h"
#include "login_security_http.h"
#include <curl/curl.h>
#include <gio/gio.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define OFF_BASE 134242560
#define OFF_INVALID_PARAM (OFF_BASE + 3)
#define OFF_NOT_SUPPORT (OFF_BASE + 20)
#define OFF_PARSE_ERROR (OFF_BASE + 28)
#define OFF_NOT_LOGIN (OFF_BASE + 30)
#define OFF_LOGIN_FAILED (OFF_BASE + 203)
#define OFF_FILE_ERROR (OFF_BASE + 218)

struct offline_job { struct native_request request; };
struct http_origin {
    char *scheme, *host;
    unsigned port;
};
struct onebox_session {
    struct json_object *configuration;
    char *token, *refresh_token, *user_id;
    gint64 renewal_at;
    struct http_origin origin;
    struct ls_http_context http;
};
struct http_response {
    CURLcode transport;
    long status;
    GString *body;
    int file;
    char target_host[256];
    unsigned target_port;
};
static struct onebox_session session;
static GMutex service_mutex;
static GAsyncQueue *requests;
static GThread *service_thread;
static native_callback service_callback;
static struct im_dispatch_queue service_dispatch;
/* Immutable until the service worker and every transfer worker have exited. */
static guint64 service_epoch;
static gint stopping;
static char shutdown_marker;
static gsize curl_initialized;
static CURLcode curl_initialization;

static const char *text_value(struct json_object *object, const char *key)
{
    return native_string(object, key, "");
}

static void clear_secret(char **value)
{
    if (!*value) return;
    volatile char *p = *value;
    size_t size = strlen(*value);
    while (size--) *p++ = 0;
    g_free(*value);
    *value = NULL;
}

static void clear_origin(struct http_origin *origin)
{
    curl_free(origin->scheme);
    curl_free(origin->host);
    memset(origin, 0, sizeof *origin);
}

static void clear_session(void)
{
    ls_http_context_clear(&session.http);
    clear_origin(&session.origin);
    clear_secret(&session.token);
    clear_secret(&session.refresh_token);
    clear_secret(&session.user_id);
    json_object_put(session.configuration);
    session.configuration = NULL;
    session.renewal_at = 0;
}

static struct json_object *reason_value(const char *reason)
{
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "reason", json_object_new_string(reason));
    return param;
}

static int queue_response(const char *text)
{
    im_dispatch_text(&service_dispatch, service_epoch, text, 0);
    return 0;
}

static void respond(const struct native_request *request, int result, struct json_object *param)
{
    native_respond(g_atomic_int_get(&stopping) ? NULL : queue_response, request, result, param);
}

static int service_cancelled(void *unused)
{
    (void)unused;
    return g_atomic_int_get(&stopping) != 0;
}

static size_t response_header(char *bytes, size_t size, size_t count, void *opaque)
{
    struct http_response *response = opaque;
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (length >= 12 && !memcmp(bytes, "HTTP/", 5)) {
        const char *space = memchr(bytes, ' ', length);
        if (space && (size_t)(bytes + length - space) >= 4 &&
            space[1] >= '1' && space[1] <= '5' &&
            space[2] >= '0' && space[2] <= '9' && space[3] >= '0' && space[3] <= '9')
            response->status = (space[1] - '0') * 100 + (space[2] - '0') * 10 + space[3] - '0';
    }
    return length;
}

static size_t response_body(char *bytes, size_t size, size_t count, void *opaque)
{
    struct http_response *response = opaque;
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (response->file >= 0 && response->status == 200) {
        size_t offset = 0;
        while (offset < length) {
            ssize_t n = write(response->file, bytes + offset, length - offset);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) return 0;
            offset += (size_t)n;
        }
    } else {
        if (length >= INT_MAX || response->body->len >= (size_t)INT_MAX - length) return 0;
        g_string_append_len(response->body, bytes, length);
    }
    return length;
}

static gboolean add_header(struct curl_slist **headers, const char *name, const char *value)
{
    if (!value || strpbrk(value, "\r\n")) return FALSE;
    char *line = g_strconcat(name, *value ? ": " : ";", value, NULL);
    struct curl_slist *next = curl_slist_append(*headers, line);
    g_free(line);
    if (!next) return FALSE;
    *headers = next;
    return TRUE;
}

static CURLU *parse_http_url(const char *url, struct http_origin *origin)
{
    memset(origin, 0, sizeof *origin);
    CURLU *parsed = curl_url();
    if (!parsed) return NULL;
    char *user = NULL, *port = NULL;
    gboolean valid = url && curl_url_set(parsed, CURLUPART_URL, url, 0) == CURLUE_OK &&
        curl_url_get(parsed, CURLUPART_SCHEME, &origin->scheme, 0) == CURLUE_OK &&
        curl_url_get(parsed, CURLUPART_HOST, &origin->host, 0) == CURLUE_OK && *origin->host &&
        (!g_ascii_strcasecmp(origin->scheme, "https") || !g_ascii_strcasecmp(origin->scheme, "http")) &&
        curl_url_get(parsed, CURLUPART_PORT, &port, CURLU_DEFAULT_PORT) == CURLUE_OK &&
        curl_url_get(parsed, CURLUPART_USER, &user, 0) == CURLUE_NO_USER;
    if (valid) {
        char *end;
        unsigned long number = strtoul(port, &end, 10);
        valid = !*end && number > 0 && number <= UINT16_MAX;
        origin->port = (unsigned)number;
    }
    curl_free(user);
    curl_free(port);
    if (!valid) { curl_url_cleanup(parsed); clear_origin(origin); return NULL; }
    return parsed;
}

static gboolean cloud_host(struct json_object *configuration, const char *host)
{
    /* Original Login splits this string on commas; the download classifier
     * lowercases and compares whole DNS hosts, not suffixes or wildcards.
     * request_url is appended verbatim, so an authority with a port does not
     * match a URL's hostname unless the bare hostname is explicitly listed. */
    if (!g_ascii_strcasecmp(host, text_value(configuration, "request_url"))) return TRUE;
    const char *entry = text_value(configuration, "onebox_address_whitelist");
    size_t length = strlen(host);
    while (*entry) {
        const char *end = strchr(entry, ',');
        size_t count = end ? (size_t)(end - entry) : strlen(entry);
        if (count == length && !g_ascii_strncasecmp(host, entry, length)) return TRUE;
        if (!end) break;
        entry = end + 1;
    }
    return FALSE;
}

static gboolean origin_authorized(const struct http_origin *destination, const struct http_origin *trusted,
                                  struct json_object *configuration)
{
    return !g_ascii_strcasecmp(destination->scheme, "https") &&
        ((trusted->host && trusted->scheme && !g_ascii_strcasecmp(destination->scheme, trusted->scheme) &&
          !g_ascii_strcasecmp(destination->host, trusted->host) && destination->port == trusted->port) ||
         (destination->port == 443 && cloud_host(configuration, destination->host)));
}

static char *endpoint(struct json_object *configuration, const char *suffix);

static CURLU *authorized_url(const char *url, struct json_object *configuration)
{
    struct http_origin destination, temporary = {0};
    CURLU *parsed = parse_http_url(url, &destination);
    if (!parsed) return NULL;
    const struct http_origin *trusted = &session.origin;
    if (configuration != session.configuration || !trusted->host) {
        char *configured = endpoint(configuration, "");
        CURLU *base = parse_http_url(configured, &temporary);
        g_free(configured);
        if (!base) { clear_origin(&destination); curl_url_cleanup(parsed); return NULL; }
        curl_url_cleanup(base);
        trusted = &temporary;
    }
    /* An explicit cloud hostname authorizes its default HTTPS origin, not
     * arbitrary ports or plaintext transport. The current origin retains its port. */
    gboolean allowed = origin_authorized(&destination, trusted, configuration);
    clear_origin(&temporary);
    clear_origin(&destination);
    if (!allowed) { curl_url_cleanup(parsed); return NULL; }
    return parsed;
}

static char *authority_endpoint(const char *authority, const char *suffix)
{
    /* Both rsUrl and request_url are bare authorities in the original SDK. */
    if (!*authority || strpbrk(authority, "/?#@\\ \t\r\n")) return NULL;
    return g_strconcat("https://", authority, suffix, NULL);
}

static int onebox_options(struct json_object *configuration, struct ls_http_options *options)
{
    struct json_object *settings = native_get(configuration, "pst_login_info");
    int64_t timeout = native_integer(settings, "time_out", 0);
    int64_t connect_timeout = native_integer(settings, "try_connect_time_out", 0);
    if (timeout < 0 || timeout > LONG_MAX || connect_timeout < 0 || connect_timeout > LONG_MAX)
        return OFF_INVALID_PARAM;
    *options = (struct ls_http_options){
        .connect_timeout_ms = connect_timeout ? (long)connect_timeout : -1,
        .total_timeout_ms = timeout ? (long)timeout : -1,
        .cancel_check = service_cancelled
    };
    return 0;
}

static int onebox_configure(struct json_object *configuration)
{
    const char *rs = text_value(configuration, "rsUrl");
    char *url = authority_endpoint(rs, "");
    struct http_origin origin;
    CURLU *parsed = parse_http_url(url, &origin);
    g_free(url);
    if (!parsed) return OFF_INVALID_PARAM;
    curl_url_cleanup(parsed); clear_origin(&origin);
    struct json_object *login = native_get(configuration, "pst_login_info");
    struct json_object *tls = native_get(login, "st_tls_para");
    struct json_object *proxy = native_get(login, "proxy");
    const char *proxy_host = text_value(proxy, "proxy_ip");
    int64_t proxy_port = native_integer(proxy, "proxy_port", 0);
    if (*proxy_host && (proxy_port <= 0 || proxy_port > UINT16_MAX)) return OFF_INVALID_PARAM;
    struct json_object *settings = json_object_new_object();
    json_object_object_add(settings, "rs_url", json_object_new_string(rs));
    /* Deliberately stricter than en_verify_server_mode: neither a caller flag
     * nor custom-CA failure may turn off peer or hostname verification. */
    json_object_object_add(settings, "verify_mode", json_object_new_int(1));
    static const char *tls_fields[][2] = {
        {"ca_cert_path", "ca_cert_path"}, {"client_cert_path", "client_cert_path"},
        {"client_cert_type", "client_cert_type"}, {"client_key_path", "client_key_path"},
        {"client_key_kype", "client_key_type"}, {"client_priv_keypw", "client_priv_keypw"}
    };
    for (size_t n = 0; n < sizeof tls_fields / sizeof *tls_fields; ++n)
        json_object_object_add(settings, tls_fields[n][1], json_object_new_string(text_value(tls, tls_fields[n][0])));
    json_object_object_add(settings, "proxy_addr", json_object_new_string(proxy_host));
    json_object_object_add(settings, "proxy_port", json_object_new_int64(*proxy_host ? proxy_port : 0));
    json_object_object_add(settings, "proxy_account", json_object_new_string(text_value(proxy, "proxy_user_name")));
    json_object_object_add(settings, "proxy_pwd", json_object_new_string(text_value(proxy, "proxy_password")));
    int result = ls_http_set_rs(&session.http, settings) ? OFF_BASE + 7 : 0;
    json_object_put(settings);
    return result;
}

static void response_route(struct http_response *response, const struct ls_http_result *result)
{
    response->transport = result->transport;
    response->status = result->status;
    memcpy(response->target_host, result->target_host, sizeof response->target_host);
    response->target_port = result->target_port;
}

struct onebox_request {
    struct http_response *response;
    const char *method, *body;
    size_t body_size;
    off_t initial_offset;
    gboolean io_failed, defer_output;
};

static CURLcode onebox_prepare(CURL *curl, unsigned attempt, const char *url, void *opaque)
{
    (void)attempt; (void)url;
    struct onebox_request *request = opaque;
    struct http_response *response = request->response;
    response->status = 0;
    g_string_truncate(response->body, 0);
    if (response->file >= 0 && !request->defer_output &&
        (ftruncate(response->file, request->initial_offset) ||
         lseek(response->file, request->initial_offset, SEEK_SET) < 0)) {
        request->io_failed = TRUE;
        return CURLE_WRITE_ERROR;
    }
    if (request->body || !strcmp(request->method, "PUT") || !strcmp(request->method, "POST")) {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request->body ? request->body : "");
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)request->body_size);
    }
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, request->method);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, response_header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, response);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, response_body);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, response);
    return CURLE_OK;
}

static int onebox_terminal(CURLcode transport, long status, void *opaque)
{
    struct onebox_request *request = opaque;
    /* Keep real application errors (including 404/409/412/416) available to
     * the protocol. Transport and server failures may try another RS route. */
    return request->io_failed || (transport == CURLE_OK && status >= 200 && status < 500);
}

static int onebox_request(const char *url, const char *method, struct curl_slist *headers,
                          struct json_object *configuration, struct json_object *body,
                          int file, struct http_response *response)
{
    *response = (struct http_response){ .body = g_string_new(NULL), .file = file };
    CURLU *target = authorized_url(url, configuration);
    if (!target) { response->transport = CURLE_URL_MALFORMAT; return OFF_BASE + 10; }
    curl_url_cleanup(target);
    struct ls_http_options options;
    int result = onebox_options(configuration, &options);
    if (!result && !session.http.settings) result = onebox_configure(configuration);
    if (result) return result;
    CURL *curl = curl_easy_init();
    if (!curl) { response->transport = CURLE_FAILED_INIT; return OFF_BASE + 201; }
    const char *encoded = body ? json_object_to_json_string_ext(body, JSON_C_TO_STRING_PLAIN) : NULL;
    struct onebox_request request = {
        .response = response, .method = method, .body = encoded,
        .body_size = encoded ? strlen(encoded) : 0,
        .initial_offset = file >= 0 ? lseek(file, 0, SEEK_CUR) : 0
    };
    if (request.initial_offset < 0) result = OFF_FILE_ERROR;
    else {
        struct ls_http_stream stream = {
            .prepare = onebox_prepare, .terminal = onebox_terminal, .context = &request
        };
        struct ls_http_result response_result = {0};
        ls_http_perform_stream(&session.http, curl, url, headers, &options, &stream, &response_result);
        response_route(response, &response_result);
        ls_http_result_clear(&response_result);
        if (request.io_failed) result = OFF_FILE_ERROR;
        else if (response->transport != CURLE_OK) result = OFF_BASE + 100 + response->transport;
    }
    curl_easy_cleanup(curl);
    return result;
}

static char *endpoint(struct json_object *configuration, const char *suffix)
{
    return authority_endpoint(text_value(configuration, "request_url"), suffix);
}

static void http_date(char output[64])
{
    static const char *days[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
    static const char *months[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
    time_t now = time(NULL);
    struct tm utc;
    gmtime_r(&now, &utc);
    snprintf(output, 64, "%s, %d %s %d %02d:%02d:%02d GMT", days[utc.tm_wday],
        utc.tm_mday, months[utc.tm_mon], utc.tm_year + 1900, utc.tm_hour, utc.tm_min, utc.tm_sec);
}

static int store_login_response(const struct http_response *response,
                                struct json_object *configuration, gboolean renewing)
{
    if (response->status != 200) return OFF_LOGIN_FAILED;
    struct json_tokener *tokener = json_tokener_new();
    if (!tokener) return OFF_BASE + 7;
    json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *root = json_tokener_parse_ex(tokener, response->body->str, response->body->len + 1);
    enum json_tokener_error error = json_tokener_get_error(tokener);
    json_tokener_free(tokener);
    const char *token = text_value(root, "token");
    const char *refresh = text_value(root, "refreshToken");
    struct json_object *cloud_id = native_get(root, "cloudUserId");
    int64_t timeout = native_integer(root, "timeout", 0);
    if (error != json_tokener_success || !*token || !*refresh || timeout <= 0 ||
        (!renewing && !json_object_is_type(cloud_id, json_type_int)) ||
        (renewing && (!session.user_id ||
         !json_object_is_type(native_get(root, "tokenType"), json_type_string)))) {
        json_object_put(root);
        return OFF_PARSE_ERROR;
    }
    struct http_origin origin = {0};
    if (renewing) {
        origin = session.origin;
        memset(&session.origin, 0, sizeof session.origin);
    } else {
        char *configured = endpoint(configuration, "");
        CURLU *base = parse_http_url(configured, &origin);
        g_free(configured);
        if (!base) { json_object_put(root); return OFF_BASE + 10; }
        curl_url_cleanup(base);
    }
    char *new_token = g_strdup(token), *new_refresh = g_strdup(refresh);
    /* The V1 refresh response does not replace the V2 cloud identity. */
    char *new_user = renewing ? g_strdup(session.user_id) :
        g_strdup_printf("%" PRId64, json_object_get_int64(cloud_id));
    struct json_object *retained_configuration = json_object_get(configuration);
    struct ls_http_context http = session.http;
    memset(&session.http, 0, sizeof session.http);
    clear_session();
    session.configuration = retained_configuration;
    session.http = http;
    session.origin = origin;
    session.token = new_token;
    session.refresh_token = new_refresh;
    session.user_id = new_user;
    /* Original refresh timer: timeout > 600 ? timeout - 120 : 600 seconds. */
    int64_t interval = timeout > 600 ? timeout - 120 : 600;
    if (interval > G_MAXINT64 / G_USEC_PER_SEC - g_get_monotonic_time() / G_USEC_PER_SEC)
        interval = 600;
    session.renewal_at = g_get_monotonic_time() + interval * G_USEC_PER_SEC;
    json_object_put(root);
    return 0;
}

static int refresh_session(void)
{
    if (!session.token || !session.refresh_token || !session.configuration) return OFF_NOT_LOGIN;
    struct curl_slist *headers = NULL;
    if (!add_header(&headers, "Authorization", session.refresh_token) ||
        !add_header(&headers, "Content-Type", "application/json")) {
        curl_slist_free_all(headers);
        clear_secret(&session.token);
        session.renewal_at = 0;
        return OFF_INVALID_PARAM;
    }
    char *url = endpoint(session.configuration, "/api/v2/token");
    struct http_response response;
    int result = onebox_request(url, "PUT", headers, session.configuration, NULL, -1, &response);
    curl_slist_free_all(headers);
    g_free(url);
    if (!result) result = store_login_response(&response, session.configuration, TRUE);
    g_string_free(response.body, TRUE);
    if (result) {
        /* Do not manufacture a renewal. The next request tells JS to re-login. */
        clear_secret(&session.token);
        session.renewal_at = 0;
    }
    return result;
}

static void login_command(struct native_request *request)
{
    struct json_object *credentials = native_get(request->param, "log_file_size");
    struct json_object *settings = native_get(request->param, "pst_login_info");
    if (native_integer(settings, "en_server_mode", -1) != 1 ||
        native_integer(credentials, "is_sso_login", -1) != 1) {
        respond(request, OFF_NOT_SUPPORT, reason_value("only the observed Onebox V2 SSO login is implemented"));
        return;
    }
    /* OfflineLogIn calls LoadKIADll when kia_disabled == 0. No compatible
     * Linux implementation is linked here; never pretend this policy engine
     * is present, and do not authenticate a new session under that pretense. */
    if (native_integer(settings, "kia_disabled", 0) == 0) {
        respond(request, OFF_BASE + 234, reason_value("required KIA policy engine is unavailable"));
        return;
    }
    const char *app_name = text_value(credentials, "app_name");
    const char *access_token = text_value(credentials, "access_token");
    if (!*app_name || !*access_token || !*text_value(request->param, "request_url") ||
        !*text_value(request->param, "rsUrl")) {
        respond(request, OFF_INVALID_PARAM, NULL);
        return;
    }
    CURL *escape = curl_easy_init();
    if (!escape) { respond(request, OFF_BASE + 201, NULL); return; }
    char *app = curl_easy_escape(escape, app_name, 0);
    char *corp = curl_easy_escape(escape, text_value(credentials, "corp_id"), 0);
    curl_easy_cleanup(escape);
    if (!app || !corp) {
        curl_free(app); curl_free(corp);
        respond(request, OFF_BASE + 7, NULL);
        return;
    }
    char *suffix = g_strconcat("/api/v2/sso/", app, *corp ? "?corpid=" : "", corp, NULL);
    char *url = endpoint(request->param, suffix);
    curl_free(app); curl_free(corp); g_free(suffix);
    struct curl_slist *headers = NULL;
    gboolean valid = add_header(&headers, "x-access-token", access_token);
    static const struct { const char *header, *key; } fields[] = {
        {"x-server-domain", "server_domain"}, {"Cookie", "cookie"},
        {"x-device-sn", "device_sn"}, {"x-device-os", "device_os"},
        {"x-device-name", "device_name"}, {"x-device-type", "device_type"},
        {"x-client-version", "device_version"}, {"x-device-cpuid", "device_cpuid"},
        {"x-device-guid", "device_guid"}, {"x-device-mac", "device_mac"}, {"x-device-uuid", "device_uuid"}
    };
    for (size_t n = 0; valid && n < sizeof fields / sizeof *fields; ++n)
        valid = add_header(&headers, fields[n].header, text_value(credentials, fields[n].key));
    if (!valid) {
        curl_slist_free_all(headers); g_free(url);
        respond(request, OFF_INVALID_PARAM, NULL);
        return;
    }
    clear_session();
    struct http_response response;
    int result = onebox_request(url, "GET", headers, request->param, NULL, -1, &response);
    curl_slist_free_all(headers); g_free(url);
    if (!result) result = store_login_response(&response, request->param, FALSE);
    if (result) clear_session();
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "plogin_result", json_object_new_int64(response.status));
    json_object_object_add(param, "user_id", json_object_new_string(!result ? session.user_id : ""));
    g_string_free(response.body, TRUE);
    respond(request, result, param);
}

static void logout_command(struct native_request *request)
{
    if (!session.token) { clear_session(); respond(request, OFF_NOT_LOGIN, NULL); return; }
    char *url = endpoint(session.configuration, "/api/v2/token");
    struct curl_slist *headers = NULL;
    if (!add_header(&headers, "Authorization", session.token)) {
        curl_slist_free_all(headers); g_free(url);
        respond(request, OFF_INVALID_PARAM, NULL);
        return;
    }
    struct http_response response;
    int result = onebox_request(url, "DELETE", headers, session.configuration, NULL, -1, &response);
    if (!result && response.status != 200) result = OFF_LOGIN_FAILED;
    curl_slist_free_all(headers); g_free(url);
    g_string_free(response.body, TRUE);
    clear_session();
    respond(request, result, NULL);
}

/* Original getSignPlainAccess hashes accessCode + "_sep_" + Date with SHA256,
 * formats that digest as lowercase hex, then base64-encodes the 64 ASCII bytes.
 * It is deliberately NOT base64(raw_digest), HMAC, or a password/KMC format. */
static char *sign_plain_access(const char *access_code, const char *date)
{
    GChecksum *checksum = g_checksum_new(G_CHECKSUM_SHA256);
    if (!checksum) return NULL;
    g_checksum_update(checksum, (const guchar *)access_code, strlen(access_code));
    g_checksum_update(checksum, (const guchar *)"_sep_", 5);
    g_checksum_update(checksum, (const guchar *)date, strlen(date));
    char *encoded = g_base64_encode((const guchar *)g_checksum_get_string(checksum), 64);
    g_checksum_free(checksum);
    return encoded;
}

static void query_link_command(struct native_request *request)
{
    if (!session.token) { respond(request, OFF_NOT_LOGIN, NULL); return; }
    struct json_object *code = native_get(request->param, "link_code");
    struct json_object *access = native_get(request->param, "access_code");
    if (!json_object_is_type(code, json_type_string) ||
        !json_object_is_type(access, json_type_string) || !json_object_get_string_len(code)) {
        respond(request, OFF_INVALID_PARAM, NULL);
        return;
    }
    char date[64];
    http_date(date);
    char *signature = sign_plain_access(json_object_get_string(access), date);
    if (!signature) { respond(request, OFF_BASE + 7, NULL); return; }
    char *authorization = g_strconcat("link,", json_object_get_string(code), ",", signature, NULL);
    g_free(signature);
    struct curl_slist *headers = NULL;
    gboolean valid = add_header(&headers, "Date", date) &&
        add_header(&headers, "Authorization", authorization) &&
        add_header(&headers, "x-usertoken", session.token);
    g_free(authorization);
    if (!valid) {
        curl_slist_free_all(headers);
        respond(request, OFF_INVALID_PARAM, NULL);
        return;
    }
    char *url = endpoint(session.configuration, "/api/v2/links/node");
    struct http_response response;
    int result = onebox_request(url, "GET", headers, session.configuration, NULL, -1, &response);
    g_free(url);
    curl_slist_free_all(headers);
    struct json_object *param = NULL;
    if (!result && response.status != 200) result = response.status ? (int)response.status : OFF_PARSE_ERROR;
    if (!result) {
        struct json_tokener *tokener = json_tokener_new();
        if (!tokener) result = OFF_BASE + 7;
        else {
            json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
            param = json_tokener_parse_ex(tokener, response.body->str, response.body->len + 1);
            if (json_tokener_get_error(tokener) != json_tokener_success) {
                json_object_put(param);
                param = NULL;
                result = OFF_PARSE_ERROR;
            }
            json_tokener_free(tokener);
        }
    }
    g_string_free(response.body, TRUE);
    respond(request, result, param);
}

static void cloud_url_command(struct native_request *request)
{
    if (!session.token) { respond(request, OFF_NOT_LOGIN, NULL); return; }
    struct json_object *token = native_get(request->param, "token");
    if (!json_object_is_type(token, json_type_string)) {
        respond(request, OFF_INVALID_PARAM, NULL);
        return;
    }
    struct json_object *parameters = json_object_new_object();
    json_object_object_add(parameters, "token", json_object_get(token));
    json_object_object_add(parameters, "page", json_object_new_uint64(
        (uint32_t)native_integer(request->param, "page", 0)));
    json_object_object_add(parameters, "parent", json_object_new_uint64(
        (uint32_t)native_integer(request->param, "parent", 0)));
    struct json_object *body = json_object_new_object();
    json_object_object_add(body, "type", json_object_new_string("homePage"));
    json_object_object_add(body, "params", parameters);
    char date[64];
    http_date(date);
    struct curl_slist *headers = NULL;
    gboolean valid = add_header(&headers, "Authorization", session.token) &&
        add_header(&headers, "Date", date) &&
        add_header(&headers, "Content-Type", "application/json");
    if (!valid) {
        curl_slist_free_all(headers);
        json_object_put(body);
        respond(request, OFF_INVALID_PARAM, NULL);
        return;
    }
    char *url = endpoint(session.configuration, "/api/v2/weburl");
    struct http_response response;
    int result = onebox_request(url, "POST", headers, session.configuration, body, -1, &response);
    g_free(url);
    curl_slist_free_all(headers);
    json_object_put(body);
    struct json_object *param = NULL;
    if (!result && response.status != 200) result = response.status ? (int)response.status : OFF_PARSE_ERROR;
    if (!result) {
        struct json_tokener *tokener = json_tokener_new();
        if (!tokener) result = OFF_BASE + 7;
        else {
            json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
            struct json_object *root = json_tokener_parse_ex(tokener, response.body->str, response.body->len + 1);
            struct json_object *web_url = native_get(root, "webUrl");
            if (json_tokener_get_error(tokener) != json_tokener_success ||
                !json_object_is_type(web_url, json_type_string) || !json_object_get_string_len(web_url))
                result = OFF_PARSE_ERROR;
            else {
                param = json_object_new_object();
                json_object_object_add(param, "webUrl", json_object_get(web_url));
            }
            json_object_put(root);
            json_tokener_free(tokener);
        }
    }
    g_string_free(response.body, TRUE);
    respond(request, result, param);
}

static int download_image(const char *url, const char *path, struct http_response *response)
{
    *response = (struct http_response){ .file = -1, .body = g_string_new(NULL) };
    if (!*url || !*path) return OFF_INVALID_PARAM;
    char *temporary = g_strconcat(path, ".XXXXXX", NULL);
    int file = g_mkstemp_full(temporary, O_WRONLY | O_CLOEXEC, 0600);
    if (file < 0) { g_free(temporary); return OFF_FILE_ERROR; }
    struct curl_slist *headers = NULL;
    char date[64];
    http_date(date);
    int result = OFF_INVALID_PARAM;
    if (add_header(&headers, "Authorization", session.token) &&
        add_header(&headers, "x-usertoken", session.token) &&
        add_header(&headers, "Content-Type", "application/json") &&
        add_header(&headers, "Date", date)) {
        g_string_free(response->body, TRUE);
        result = onebox_request(url, "GET", headers, session.configuration, NULL, file, response);
        if (!result && response->status != 200) result = OFF_BASE + 122;
    }
    curl_slist_free_all(headers);
    if (!result && fsync(file)) result = OFF_FILE_ERROR;
    if (close(file)) result = OFF_FILE_ERROR;
    if (!result && rename(temporary, path)) result = OFF_FILE_ERROR;
    if (result) unlink(temporary);
    g_free(temporary);
    response->file = -1;
    return result;
}

static void download_emoji_command(struct native_request *request)
{
    if (!session.token) { respond(request, OFF_NOT_LOGIN, NULL); return; }
    const char *url = text_value(request->param, "originalUrl");
    const char *path = text_value(request->param, "filePath");
    const char *thumbnail = text_value(request->param, "thumbnailUrl");
    const char *thumbnail_path = text_value(request->param, "thumbnailFilePath");
    if (!*url || !*path || (!!*thumbnail != !!*thumbnail_path)) {
        respond(request, OFF_INVALID_PARAM, reason_value("param is not correct!"));
        return;
    }
    struct http_response response;
    int result = 0;
    if (*thumbnail) {
        result = download_image(thumbnail, thumbnail_path, &response);
        if (!result) g_string_free(response.body, TRUE);
    }
    if (!result) result = download_image(url, path, &response);
    struct json_object *reply = json_object_new_object();
    struct json_object *param = json_object_new_object();
    json_object_object_add(reply, "rsp", json_object_get(native_get(request->root, "cmd")));
    json_object_object_add(reply, "sno", json_object_get(native_get(request->root, "sno")));
    json_object_object_add(reply, "description", json_object_new_string("tup_offlinefile_download_emoji"));
    /* This API's completion uses ret, not result; HTTP fields are inside param. */
    json_object_object_add(reply, "ret", json_object_new_int(result ? -1 : 0));
    json_object_object_add(param, "resp_code", json_object_new_int64(response.status));
    if (response.body->len)
        json_object_object_add(param, "recv_body", json_object_new_string_len(response.body->str, response.body->len));
    if (result) json_object_object_add(param, "reason", json_object_new_string("DownloadEmojiRspNotify failed."));
    json_object_object_add(reply, "param", param);
    g_string_free(response.body, TRUE);
    im_dispatch_json(&service_dispatch, service_epoch, reply, 0);
}

#include "im_transport_onebox.inc"

static gpointer offline_worker(gpointer unused)
{
    (void)unused;
    while (!g_atomic_int_get(&stopping)) {
        gpointer item;
        if (session.renewal_at) {
            gint64 remaining = session.renewal_at - g_get_monotonic_time();
            if (remaining <= 0) { refresh_session(); continue; }
            item = g_async_queue_timeout_pop(requests, remaining);
            if (!item) { refresh_session(); continue; }
        } else item = g_async_queue_pop(requests);
        if (item == &shutdown_marker) break;
        struct offline_job *job = item;
        if (g_atomic_int_get(&stopping)) {
            native_release(&job->request);
            g_free(job);
            break;
        }
        struct native_request *request = &job->request;
        switch (request->cmd) {
        case 589828: transfer_cancel_all(); login_command(request); break;
        case 589829: transfer_cancel_all(); logout_command(request); break;
        case 589830:
        case 589832:
        case 589834:
        case 589862: transfer_command(request); break;
        case 589844: onebox_copy_command(request); break;
        case 589860: {
            const char *token = text_value(request->param, "access_token");
            if (!session.configuration) respond(request, OFF_NOT_LOGIN, NULL);
            else if (!*token || strpbrk(token, "\r\n")) respond(request, OFF_INVALID_PARAM, NULL);
            else {
                struct json_object *credentials = native_get(session.configuration, "log_file_size");
                json_object_object_add(credentials, "access_token", json_object_new_string(token));
                respond(request, 0, NULL);
            }
            break;
        }
        case 589863: download_emoji_command(request); break;
        case 589861: query_link_command(request); break;
        case 589858: cloud_url_command(request); break;
        default: respond(request, OFF_NOT_SUPPORT, reason_value("unsupported Onebox command")); break;
        }
        native_release(request);
        g_free(job);
    }
    transfer_cancel_all();
    g_thread_pool_free(transfer_pool, FALSE, TRUE);
    transfer_pool = NULL;
    g_hash_table_destroy(transfers);
    transfers = NULL;
    clear_session();
    gpointer item;
    while ((item = g_async_queue_try_pop(requests))) {
        if (item == &shutdown_marker) continue;
        struct offline_job *job = item;
        native_release(&job->request);
        g_free(job);
    }
    g_mutex_lock(&service_mutex);
    g_async_queue_unref(requests);
    requests = NULL;
    g_thread_unref(service_thread);
    /* Only now can another startup safely reuse the session globals. */
    service_thread = NULL;
    g_mutex_unlock(&service_mutex);
    return NULL;
}

IM_SDK_EXPORT int OfflineFileInitService(const char *log_path, native_callback callback)
{
    (void)log_path;
    if (!callback) return OFF_INVALID_PARAM;
    if (g_once_init_enter(&curl_initialized)) {
        curl_initialization = curl_global_init(CURL_GLOBAL_DEFAULT);
        g_once_init_leave(&curl_initialized, 1);
    }
    if (curl_initialization != CURLE_OK) return OFF_BASE + 1;
    g_mutex_lock(&service_mutex);
    if (service_thread) { g_mutex_unlock(&service_mutex); return OFF_BASE + 34; }
    service_epoch = im_dispatch_start(&service_dispatch);
    if (!service_epoch) { g_mutex_unlock(&service_mutex); return OFF_BASE + 34; }
    requests = g_async_queue_new();
    transfers = g_hash_table_new_full(g_direct_hash, g_direct_equal, NULL, transfer_unref);
    transfer_pool = g_thread_pool_new(transfer_worker, NULL, 4, FALSE, NULL);
    g_atomic_int_set(&stopping, 0);
    service_thread = transfer_pool ? g_thread_try_new("welink-offline", offline_worker, NULL, NULL) : NULL;
    if (!service_thread) {
        g_atomic_int_set(&stopping, 1);
        im_dispatch_stop(&service_dispatch);
        if (transfer_pool) g_thread_pool_free(transfer_pool, FALSE, FALSE);
        transfer_pool = NULL;
        g_hash_table_destroy(transfers);
        transfers = NULL;
        g_async_queue_unref(requests);
        requests = NULL;
    } else service_callback = callback;
    int result = service_thread ? 0 : OFF_BASE + 19;
    g_mutex_unlock(&service_mutex);
    return result;
}

IM_SDK_EXPORT void OfflineFileSendMsg(const char *text)
{
    struct offline_job *job = g_try_new0(struct offline_job, 1);
    if (!job) return;
    if (native_parse(&job->request, text)) { g_free(job); return; }
    g_mutex_lock(&service_mutex);
    if (service_thread && !g_atomic_int_get(&stopping)) {
        g_async_queue_push(requests, job);
        job = NULL;
    }
    g_mutex_unlock(&service_mutex);
    if (job) { native_release(&job->request); g_free(job); }
}

static int dispatch_response(const char *text, int tag, gpointer context)
{
    (void)tag;
    native_callback callback = *(native_callback *)context;
    callback(text);
    return 1;
}

IM_SDK_EXPORT int OfflineFileDispatchCallbacks(void)
{
    g_mutex_lock(&service_mutex);
    native_callback callback = service_callback;
    g_mutex_unlock(&service_mutex);
    return im_dispatch_run(&service_dispatch, dispatch_response, &callback);
}

IM_SDK_EXPORT void OfflineFileShutdown(void)
{
    g_mutex_lock(&service_mutex);
    if (!service_thread || g_atomic_int_get(&stopping)) { g_mutex_unlock(&service_mutex); return; }
    g_atomic_int_set(&stopping, 1);
    im_dispatch_stop(&service_dispatch);
    g_async_queue_push(requests, &shutdown_marker);
    g_mutex_unlock(&service_mutex);
}
