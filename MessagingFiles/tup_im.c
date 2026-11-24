/* Native tup_im_logic_api implementation.
 * Startup/Shutdown/SetLog/RegistCallBack/SendMsg retain the original ia32 ABI.
 * The callback's second integer and SendMsg's second integer are MODULE IDs,
 * not JSON lengths. The production path is verified TLS + reconstructed ECS
 * PacketMobile/NBR, never Wine or a recording/success SDK replacement.
 * Build with im_transport_codec.c, im_transport_presence.c, login_security_http.c,
 * libcurl, json-c, OpenSSL, gio-2.0, gthread-2.0, xcb and xcb-screensaver. */
#define _GNU_SOURCE
#include "native_rpc.h"
#include "im_transport_exports.h"
#include "im_transport_dispatch.h"
#include "im_transport_codec.h"
#include "im_transport_presence.h"
#include "im_transport_adapter.h"
#include "login_security_http.h"
#include <arpa/inet.h>
#include <curl/curl.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <net/if.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define IM_MODULE 1
#define FRAME_MAX 0xffffffu
#define REQUEST_TIMEOUT 30000000
#define LOGIN_TIMEOUT 20000000
#define HEARTBEAT_PERIOD 30000000

typedef int (*im_callback)(const char *, int);
struct im_job { struct native_request request; int module; };
struct pending {
    uint16_t code, serial;
    int internal;
    gint64 deadline;
    struct im_job *job;
};
struct transmission { GByteArray *frame; size_t offset; uint16_t serial; };
struct http_job {
    struct im_job *job;
    struct json_object *configuration;
    struct ls_http_context routing;
};
struct route { int64_t cmd; const char *path; };
static const struct route http_routes[] = {
#include "im_transport_http_routes.inc"
};
static GMutex lifecycle;
static GThread *worker;
static GThreadPool *http_pool;
static GAsyncQueue *jobs;
static im_callback callback;
static gint stopping;
static struct im_dispatch_queue im_callbacks;
static guint64 callback_epoch;
static int wake_pipe[2] = {-1, -1};
static gsize curl_initialized;
static CURLcode curl_initialization;
static FILE *log_file;
static struct {
    struct json_object *configuration, *dnd;
    struct ls_http_context routing;
    CURL *connection;
    curl_socket_t socket;
    GHashTable *pending;
    GQueue outgoing;
    GByteArray *incoming;
    size_t read_offset;
    uint16_t serial;
    uint64_t session_id;
    gboolean wanted, online, connecting, idle_enabled;
    gboolean network_unavailable;
    gint64 next_connect, heartbeat_at, authenticated_at, presence_at;
    int idle_state, idle_repeat, dnd_state;
    uint64_t idle_threshold;
    struct im_idle_reader idle;
} sdk;

static const char *string_value(struct json_object *object, const char *key)
{
    return native_string(object, key, "");
}
static void free_job(struct im_job *job)
{
    if (!job) return;
    native_release(&job->request);
    g_free(job);
}
static void free_pending(gpointer data)
{
    struct pending *pending = data;
    free_job(pending->job);
    g_free(pending);
}
static void emit(struct json_object *message, int module)
{
    im_dispatch_json(&im_callbacks, callback_epoch, message, module);
}

static int deliver_im_callback(const char *text, int module, gpointer unused)
{
    (void)unused;
    g_mutex_lock(&lifecycle);
    im_callback target = g_atomic_int_get(&stopping) ? NULL : callback;
    g_mutex_unlock(&lifecycle);
    if (!target) return 0;
    target(text, module);
    return 1;
}

IM_SDK_EXPORT int ImDispatchCallbacks(void)
{
    int requests = im_adapter_dispatch();
    if (requests < 0) return requests;
    int responses = im_dispatch_run(&im_callbacks, deliver_im_callback, NULL);
    if (responses < 0) return responses;
    return requests > INT_MAX - responses ? INT_MAX : requests + responses;
}
static void local_reply(struct im_job *job, int64_t rsp, int result, const char *description,
                        const char *reason, struct json_object *param)
{
    struct json_object *message = json_object_new_object();
    json_object_object_add(message, "rsp", json_object_new_int64(rsp));
    json_object_object_add(message, "sno", json_object_get(native_get(job->request.root, "sno")));
    json_object_object_add(message, "result", json_object_new_int(result));
    json_object_object_add(message, "resultDes", json_object_new_string(reason));
    json_object_object_add(message, "description", json_object_new_string(description));
    if (param) json_object_object_add(message, "param", param);
    emit(message, job->module);
}
static void failure(struct im_job *job, const char *reason)
{
    local_reply(job, job->request.cmd, 1, string_value(job->request.root, "description"), reason, NULL);
}
static void notify_parameter(int code, const char *description, struct json_object *parameter)
{
    struct json_object *message = json_object_new_object();
    json_object_object_add(message, "notify", json_object_new_int(code));
    json_object_object_add(message, "description", json_object_new_string(description));
    json_object_object_add(message, "param", parameter);
    emit(message, IM_MODULE);
}
static void login_status(gboolean enabled)
{
    struct json_object *parameter = json_object_new_object();
    json_object_object_add(parameter, "account", json_object_new_string(string_value(sdk.configuration, "account")));
    json_object_object_add(parameter, "isImEnable", json_object_new_int(enabled));
    notify_parameter(188672, "LoginStatusNotify", parameter);
}
static void note_status(const char *event, int code)
{
    g_mutex_lock(&lifecycle);
    if (log_file) { fprintf(log_file, "%s %d\n", event, code); fflush(log_file); }
    g_mutex_unlock(&lifecycle);
}
static void note_packet(const char *event, int code, const struct im_nbr_packet *packet, int acked)
{
    g_mutex_lock(&lifecycle);
    if (log_file) {
        if (code == ENOTSUP) {
            fprintf(log_file, "%s code=0x%04x type=0x%02x ver=%u flags=0x%02x ext=%zu body=%zu ack=%d\n",
                    event, (unsigned)packet->code, (unsigned)packet->type, (unsigned)packet->version,
                    (unsigned)packet->flags, packet->extension_size, packet->body_size, acked);
        } else {
            fprintf(log_file, "%s %d code=0x%04x type=0x%02x ver=%u flags=0x%02x ext=%zu body=%zu\n",
                    event, code, (unsigned)packet->code, (unsigned)packet->type, (unsigned)packet->version,
                    (unsigned)packet->flags, packet->extension_size, packet->body_size);
        }
        fflush(log_file);
    }
    g_mutex_unlock(&lifecycle);
}
static void wake_worker(void)
{
    unsigned char byte = 1;
    if (wake_pipe[1] >= 0) { ssize_t ignored = write(wake_pipe[1], &byte, 1); (void)ignored; }
}
static int im_http_cancelled(void *unused)
{
    (void)unused;
    return g_atomic_int_get(&stopping) != 0;
}
static char *https_address(const char *address)
{
    if (!*address) return NULL;
    char *url = strstr(address, "://") ? g_strdup(address) : g_strconcat("https://", address, NULL);
    CURLU *parsed = curl_url();
    char *scheme = NULL, *host = NULL, *user = NULL;
    gboolean valid = parsed && curl_url_set(parsed, CURLUPART_URL, url, 0) == CURLUE_OK &&
        curl_url_get(parsed, CURLUPART_SCHEME, &scheme, 0) == CURLUE_OK && !strcmp(scheme, "https") &&
        curl_url_get(parsed, CURLUPART_HOST, &host, 0) == CURLUE_OK && *host &&
        curl_url_get(parsed, CURLUPART_USER, &user, 0) == CURLUE_NO_USER;
    curl_free(scheme); curl_free(host); curl_free(user);
    if (parsed) curl_url_cleanup(parsed);
    if (!valid) { g_free(url); return NULL; }
    return url;
}
static struct ls_http_options im_http_options(gboolean omit_identity)
{
    return (struct ls_http_options) {
        .connect_timeout_ms = 20000, .total_timeout_ms = 30000,
        .cancel_check = im_http_cancelled, .omit_client_identity = omit_identity
    };
}
static int im_http_configure(struct ls_http_context *routing, struct json_object *configuration)
{
    /* BlueLogin in common.js and tup_im_json.dll's 0x117ca7..0x1183ef
     * read these exact fields. caPath is the certificate DIRECTORY, not a
     * client identity. No IM client-certificate fields have been observed. */
    struct json_object *settings = json_object_new_object();
    struct json_object *proxy = native_get(configuration, "proxyInfo");
    if (!settings) return ENOMEM;
    json_object_object_add(settings, "rs_url", json_object_new_string(string_value(configuration, "rsUrl")));
    json_object_object_add(settings, "verify_mode",
        json_object_new_int(native_integer(configuration, "isVerify", 1) != 0));
    json_object_object_add(settings, "ca_cert_path", json_object_new_string(string_value(configuration, "caPath")));
    json_object_object_add(settings, "proxy_addr", json_object_new_string(string_value(proxy, "m_strProxyServer")));
    json_object_object_add(settings, "proxy_port", json_object_new_int64(native_integer(proxy, "m_iProxyPort", 0)));
    json_object_object_add(settings, "proxy_account", json_object_new_string(string_value(proxy, "m_strProxyAccount")));
    json_object_object_add(settings, "proxy_pwd", json_object_new_string(string_value(proxy, "m_strProxyAccountPswd")));
    int error = ls_http_set_rs(routing, settings);
    json_object_put(settings);
    return error;
}
static void clear_transmissions(void)
{
    struct transmission *item;
    while ((item = g_queue_pop_head(&sdk.outgoing))) { g_byte_array_unref(item->frame); g_free(item); }
}
static void close_connection(const char *reason, gboolean retry)
{
    gboolean had_session = sdk.online || sdk.connecting;
    sdk.online = sdk.connecting = FALSE;
    if (sdk.connection) curl_easy_cleanup(sdk.connection);
    sdk.connection = NULL;
    sdk.socket = CURL_SOCKET_BAD;
    sdk.session_id = 0;
    sdk.read_offset = 0;
    g_byte_array_set_size(sdk.incoming, 0);
    clear_transmissions();
    GHashTableIter iterator;
    gpointer value;
    g_hash_table_iter_init(&iterator, sdk.pending);
    while (g_hash_table_iter_next(&iterator, NULL, &value)) {
        struct pending *pending = value;
        if (pending->job) failure(pending->job, reason);
    }
    g_hash_table_remove_all(sdk.pending);
    if (had_session) login_status(FALSE);
    if (retry && sdk.wanted) {
        /* Defaults are parsed as 15 and 30 seconds by the original dispatcher. */
        int minimum = native_integer(sdk.configuration, "minRetryTime", 15);
        int maximum = native_integer(sdk.configuration, "maxRetryTime", 30);
        if (minimum < 0 || maximum < minimum || maximum > INT_MAX / 1000) { sdk.wanted = FALSE; return; }
        int delay = minimum == maximum ? minimum : g_random_int_range(minimum, maximum + 1);
        sdk.next_connect = g_get_monotonic_time() + (gint64)delay * G_USEC_PER_SEC;
    }
}
static int parse_ip_address(const char *text, struct in6_addr *address, unsigned *scope)
{
    char unscoped[INET6_ADDRSTRLEN];
    const char *zone = strchr(text, '%');
    *scope = 0;
    if (zone) {
        size_t length = zone - text;
        if (!length || length >= sizeof unscoped || !zone[1]) return EINVAL;
        memcpy(unscoped, text, length);
        unscoped[length] = 0;
        text = unscoped;
        char *end;
        errno = 0;
        unsigned long index = strtoul(zone + 1, &end, 10);
        if (zone[1] >= '0' && zone[1] <= '9' && !errno && end != zone + 1 && !*end && index <= UINT_MAX)
            *scope = (unsigned)index;
        else if (!(*scope = if_nametoindex(zone + 1))) return EINVAL;
    }
    if (inet_pton(AF_INET6, text, address) == 1) return 0;
    if (zone) return EINVAL;
    memset(address, 0, sizeof *address);
    if (inet_pton(AF_INET, text, &address->s6_addr[12]) != 1) return EINVAL;
    address->s6_addr[10] = address->s6_addr[11] = 0xff;
    return 0;
}
static int connection_ip_address(struct in6_addr *address, unsigned *scope)
{
    struct sockaddr_storage local;
    socklen_t size = sizeof local;
    if (sdk.socket != CURL_SOCKET_BAD && !getsockname(sdk.socket, (struct sockaddr *)&local, &size)) {
        if (local.ss_family == AF_INET) {
            const struct sockaddr_in *ipv4 = (const struct sockaddr_in *)&local;
            memset(address, 0, sizeof *address);
            address->s6_addr[10] = address->s6_addr[11] = 0xff;
            memcpy(&address->s6_addr[12], &ipv4->sin_addr, sizeof ipv4->sin_addr);
            *scope = 0;
            return 0;
        }
        if (local.ss_family == AF_INET6) {
            const struct sockaddr_in6 *ipv6 = (const struct sockaddr_in6 *)&local;
            *address = ipv6->sin6_addr;
            *scope = ipv6->sin6_scope_id;
            return 0;
        }
    }
    char *text = NULL;
    if (curl_easy_getinfo(sdk.connection, CURLINFO_LOCAL_IP, &text) != CURLE_OK || !text || !*text)
        return EIO;
    return parse_ip_address(text, address, scope);
}
static int ip_list_change(struct json_object *addresses)
{
    if (!json_object_is_type(addresses, json_type_array)) return EINVAL;
    size_t count = json_object_array_length(addresses);
    struct in6_addr local;
    unsigned local_scope = 0;
    int error = count && sdk.connection ? connection_ip_address(&local, &local_scope) : 0;
    gboolean retained = FALSE;
    for (size_t n = 0; n < count; ++n) {
        struct json_object *item = json_object_array_get_idx(addresses, n);
        if (!json_object_is_type(item, json_type_string)) return EINVAL;
        const char *text = json_object_get_string(item);
        struct in6_addr address;
        unsigned scope;
        if (strlen(text) != (size_t)json_object_get_string_len(item) ||
            parse_ip_address(text, &address, &scope)) return EINVAL;
        /* Omitted zones cannot prove that a link-local interface disappeared.
         * IPv4 and IPv4-mapped IPv6 share the same binary representation. */
        if (sdk.connection && !error && !memcmp(&local, &address, sizeof local) &&
            (!scope || !local_scope || scope == local_scope)) retained = TRUE;
    }
    if (error) return error; /* No evidence of removal: preserve the live session. */
    sdk.network_unavailable = count == 0;
    if (sdk.connection && !retained) close_connection("network configuration changed", TRUE);
    /* No routing/credential change, and no retry deadline reset while offline.
     * An empty list pauses attempts; recovery resumes the existing backoff. */
    return 0;
}
static uint16_t next_serial(void)
{
    for (unsigned n = 0; n < UINT16_MAX; ++n) {
        if (!++sdk.serial) ++sdk.serial;
        if (!g_hash_table_contains(sdk.pending, GUINT_TO_POINTER((unsigned)sdk.serial))) return sdk.serial;
    }
    return 0;
}
static int send_message(uint16_t code, struct json_object *body, struct im_job *job, int internal)
{
    uint16_t serial = next_serial();
    if (!serial) return EBUSY;
    struct transmission *transmission = g_new0(struct transmission, 1);
    transmission->frame = g_byte_array_new();
    /* Keep the legacy session handshake; business requests advertise support
     * for the response envelope carrying the server's synchronization cursor. */
    int error = im_nbr_message_frame(job ? 6 : 4, code, serial, sdk.session_id, body, transmission->frame);
    if (error) { g_byte_array_unref(transmission->frame); g_free(transmission); return error; }
    struct pending *pending = g_new0(struct pending, 1);
    pending->serial = serial; pending->code = code; pending->internal = internal; pending->job = job;
    pending->deadline = g_get_monotonic_time() + (internal ? LOGIN_TIMEOUT : REQUEST_TIMEOUT);
    transmission->serial = serial;
    g_hash_table_insert(sdk.pending, GUINT_TO_POINTER((unsigned)serial), pending);
    g_queue_push_tail(&sdk.outgoing, transmission);
    return 0;
}
static struct json_object *login_body(void)
{
    struct json_object *body = json_object_new_object();
    json_object_object_add(body, "userAccount", json_object_new_string(string_value(sdk.configuration, "account")));
    /* The desktop SDK defaults clientType to 0 (PC); loginFlag is login intent,
     * not a device class. Mapping loginFlag == 1 here claims the mobile slot. */
    json_object_object_add(body, "clientType", json_object_new_int(native_integer(sdk.configuration, "clientType", 0)));
    json_object_object_add(body, "appId", json_object_new_string("1"));
    json_object_object_add(body, "loginAddr", json_object_new_string(native_string(sdk.configuration, "localIp", "0.0.0.0")));
    json_object_object_add(body, "token", json_object_new_string(string_value(sdk.configuration, "authToken")));
    json_object_object_add(body, "deviceId", json_object_new_string(string_value(sdk.configuration, "deviceId")));
    json_object_object_add(body, "language", json_object_new_string("zh-cn"));
    json_object_object_add(body, "deviceName", json_object_new_string(""));
    json_object_object_add(body, "versionNumber", json_object_new_string(string_value(sdk.configuration, "clientVersion")));
    struct json_object *capabilities = json_object_new_object(), *types = json_object_new_object();
    static const char *notify_types[] = {"0x111C","0x1204","0x135C","0x1360","0x1364","0x140E","0x151E",
        "0x151C","0x1530","0x120E","0x1214","0x1512","0x151A","0x1120","0x1338","0x1340","0x1346",
        "0x136E","0x1558","0x1560","0x1546"};
    for (size_t n = 0; n < sizeof notify_types / sizeof *notify_types; ++n)
        json_object_object_add(types, notify_types[n], json_object_new_string("1"));
    json_object_object_add(capabilities, "NotifyProtocolType", types);
    json_object_object_add(capabilities, "isAffirm", json_object_new_boolean(TRUE));
    json_object_object_add(body, "loginExtData", json_object_new_string(
        json_object_to_json_string_ext(capabilities, JSON_C_TO_STRING_PLAIN)));
    json_object_put(capabilities);
    return body;
}
static CURLcode im_maa_prepare(CURL *curl, unsigned attempt, const char *url, void *unused)
{
    (void)attempt; (void)url; (void)unused;
    /* MAA carries ECS/NBR, not HTTP. Do not advertise an HTTP ALPN protocol.
     * No frames are sent until the shared TLS connection has succeeded. */
    CURLcode result = curl_easy_setopt(curl, CURLOPT_CONNECT_ONLY, 1L);
    return result ? result : curl_easy_setopt(curl, CURLOPT_SSL_ENABLE_ALPN, 0L);
}
static void connect_session(void)
{
    char *url = https_address(string_value(sdk.configuration, "maaAddr"));
    if (!url) { sdk.wanted = FALSE; login_status(FALSE); return; }
    CURL *curl = curl_easy_init();
    if (!curl) { g_free(url); sdk.next_connect = g_get_monotonic_time() + 15000000; return; }
    sdk.connecting = TRUE;
    struct ls_http_options options = im_http_options(FALSE);
    struct ls_http_stream stream = {.prepare = im_maa_prepare, .transport_only = 1};
    struct ls_http_result response = {0};
    CURLcode result = ls_http_perform_stream(&sdk.routing, curl, url, NULL, &options, &stream, &response);
    ls_http_result_clear(&response);
    g_free(url);
    sdk.connection = curl;
    if (result != CURLE_OK || curl_easy_getinfo(curl, CURLINFO_ACTIVESOCKET, &sdk.socket) != CURLE_OK ||
        sdk.socket == CURL_SOCKET_BAD) {
        note_status("IM TLS connection", result);
        close_connection("connection failed", TRUE);
        return;
    }
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 0L);
    struct json_object *body = login_body();
    int error = send_message(0x1100, body, NULL, 1);
    json_object_put(body);
    if (error) close_connection("login encoding failed", FALSE);
}
static gboolean flush_output(void)
{
    while (!g_atomic_int_get(&stopping) && !g_queue_is_empty(&sdk.outgoing)) {
        struct transmission *item = g_queue_peek_head(&sdk.outgoing);
        size_t sent = 0;
        CURLcode result = curl_easy_send(sdk.connection, item->frame->data + item->offset,
                                        item->frame->len - item->offset, &sent);
        if (result == CURLE_AGAIN) return TRUE;
        if (result != CURLE_OK || !sent) return FALSE;
        item->offset += sent;
        if (item->offset == item->frame->len) {
            g_queue_pop_head(&sdk.outgoing);
            g_byte_array_unref(item->frame); g_free(item);
        }
    }
    return TRUE;
}
static void send_push_ack(const struct im_nbr_packet *packet)
{
    if ((packet->type & 0xf0) != 0x20 || !sdk.connection) return;
    struct transmission *receipt = g_new0(struct transmission, 1);
    receipt->frame = g_byte_array_new();
    struct im_nbr_packet ack = *packet;
    ack.type = 0x30; ack.body = NULL; ack.body_size = 0;
    if (!im_nbr_frame(&ack, receipt->frame)) g_queue_push_tail(&sdk.outgoing, receipt);
    else { g_byte_array_unref(receipt->frame); g_free(receipt); }
}
static void emit_packet(struct json_object *message, int module, const struct im_nbr_packet *packet)
{
    int error = im_nbr_apply_metadata(packet, message);
    if (error) note_packet("IM packet metadata", error, packet, 0);
    if (packet->code == 5449 || packet->code == 5475) {
        gboolean snapshot = packet->code == 5449;
        const char *cursor = string_value(message, snapshot ? "serverTime" : "syncTime");
        gboolean has_cursor = *cursor && strcmp(cursor, "0");
        note_status(snapshot ? (has_cursor ? "IM grouping snapshot (cursor)" : "IM grouping snapshot (no cursor)")
                             : (has_cursor ? "IM grouping delta (cursor)" : "IM grouping delta (no cursor)"),
                    native_integer(message, "result", -1));
    }
    emit(message, module);
}
static void deliver_packet(struct im_nbr_packet *packet)
{
    sdk.session_id = packet->session_id;
    if ((packet->type & 0xf0) == 0x30) return;
    int error = 0;
    struct json_object *decoded = im_nbr_decode(packet->code, packet->body, packet->body_size, &error);
    if (error) {
        if (error == ENOTSUP) {
            /* Mirror ecs_im_nbr.dll: unrecognized post-7.47.6 server pushes
             * still receive a 0x30 receipt so the server stops redelivering. */
            gboolean ack = (packet->type & 0xf0) == 0x20 && sdk.connection != NULL;
            if (ack) send_push_ack(packet);
            note_packet("IM unsupported", error, packet, ack ? 1 : 0);
        } else {
            note_packet("IM decode", error, packet, 0);
        }
        return;
    }
    struct pending *pending = g_hash_table_lookup(sdk.pending, GUINT_TO_POINTER((unsigned)packet->serial));
    if (pending && packet->code != (uint16_t)(pending->code + 1) && packet->code != 0) pending = NULL;
    if (pending) {
        if (pending->internal == 1) {
            sdk.connecting = FALSE;
            sdk.online = json_object_is_type(decoded, json_type_object) &&
                native_integer(decoded, "result", -1) == 0;
            if (sdk.online) {
                sdk.authenticated_at = g_get_monotonic_time();
                sdk.heartbeat_at = sdk.authenticated_at + HEARTBEAT_PERIOD;
            }
            login_status(sdk.online);
        } else if (pending->job) {
            if (!json_object_is_type(decoded, json_type_object) || !native_get(decoded, "result"))
                failure(pending->job, "invalid server response");
            else {
                json_object_object_add(decoded, "description", json_object_new_string(im_nbr_message_name(packet->code)));
                json_object_object_add(decoded, "rsp", json_object_get(native_get(pending->job->request.root, "cmd")));
                json_object_object_add(decoded, "sno", json_object_get(native_get(pending->job->request.root, "sno")));
                emit_packet(decoded, pending->job->module, packet);
                decoded = NULL;
            }
        }
        gboolean rejected_login = pending->internal == 1 && !sdk.online;
        g_hash_table_remove(sdk.pending, GUINT_TO_POINTER((unsigned)packet->serial));
        if (rejected_login) {
            json_object_put(decoded);
            close_connection("login rejected", TRUE);
            return;
        }
    } else {
        struct json_object *message = json_object_new_object();
        json_object_object_add(message, "notify", json_object_new_int(0x28000 + packet->code));
        json_object_object_add(message, "description", json_object_new_string(im_nbr_message_name(packet->code)));
        struct json_object *notify_time = native_get(decoded, "serverTime");
        json_object_object_add(message, "serverTime", notify_time ? json_object_get(notify_time) : json_object_new_string("0"));
        json_object_object_add(message, "traceId", json_object_new_string(string_value(decoded, "traceId")));
        json_object_object_add(message, "param", decoded);
        decoded = NULL;
        emit_packet(message, IM_MODULE, packet);
        if (packet->code == 0x111c) {
            sdk.wanted = FALSE;
            close_connection("server kick-out", FALSE);
            return;
        }
    }
    json_object_put(decoded);
    send_push_ack(packet);
}
static gboolean receive_input(void)
{
    if (sdk.read_offset && sdk.read_offset == sdk.incoming->len) {
        g_byte_array_set_size(sdk.incoming, 0); sdk.read_offset = 0;
    } else if (sdk.read_offset > sdk.incoming->len / 2) {
        g_byte_array_remove_range(sdk.incoming, 0, sdk.read_offset); sdk.read_offset = 0;
    }
    guint old = sdk.incoming->len;
    if (old > FRAME_MAX + 4) return FALSE;
    g_byte_array_set_size(sdk.incoming, old + 65536);
    size_t received = 0;
    CURLcode result = curl_easy_recv(sdk.connection, sdk.incoming->data + old, 65536, &received);
    g_byte_array_set_size(sdk.incoming, old + received);
    if (result == CURLE_AGAIN) return TRUE;
    if (result != CURLE_OK || !received) return FALSE;
    while (sdk.connection && sdk.incoming->len - sdk.read_offset >= 4) {
        const unsigned char *data = sdk.incoming->data + sdk.read_offset;
        uint32_t size = ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16) | ((uint32_t)data[2] << 8) | data[3];
        if (size > FRAME_MAX) return FALSE;
        if (sdk.incoming->len - sdk.read_offset < (size_t)size + 4) break;
        if (!size) { sdk.read_offset += 4; continue; }
        struct im_nbr_packet packet;
        if (im_nbr_packet_parse(data + 4, size, &packet)) return FALSE;
        sdk.read_offset += size + 4;
        deliver_packet(&packet);
    }
    return TRUE;
}

static const char *http_route(int64_t command)
{
    if (command == 131076) return "/v1/welinkim/emoji-service/emoji-info/query-emoji-category";
    if (command == 131077) return "/v1/welinkim/emoji-service/emoji-info/query-emoji-list";
    if (command == 131079) return "/v1/welinkim/emoji-service/emoji-personal/fetch-emoji";
    if (command == 131080) return "/v1/welinkim/emoji-service/emoji-relation/adjust-emoji-index";
    if (command == 131081) return "/v1/welinkim/emoji-service/emoji-relation/batch-remove";
    if (command == 131082) return "/v1/welinkim/emoji-service/emoji-relation/relation-inc";
    for (size_t n = 0; n < sizeof http_routes / sizeof *http_routes; ++n)
        if (http_routes[n].cmd == command) return http_routes[n].path;
    return NULL;
}
static size_t http_write(char *data, size_t size, size_t count, void *context)
{
    GString *body = context;
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (length >= INT_MAX || body->len >= (size_t)INT_MAX - length) return 0;
    g_string_append_len(body, data, length);
    return length;
}
static gboolean http_header(struct curl_slist **headers, const char *name, const char *value)
{
    if (strpbrk(value, "\r\n")) return FALSE;
    char *line = g_strconcat(name, *value ? ": " : ";", value, NULL);
    struct curl_slist *next = curl_slist_append(*headers, line);
    g_free(line);
    if (!next) return FALSE;
    *headers = next;
    return TRUE;
}
#include "im_transport_http_files.inc"
static void http_worker(gpointer data, gpointer unused)
{
    (void)unused;
    struct http_job *work = data;
    struct im_job *job = work->job;
    struct native_request *request = &job->request;
    gboolean streaming = request->cmd == 131073 || request->cmd == 131078 ||
        request->cmd == 131083 || request->cmd == 131084;
    /* curl_easy_escape ignores its handle in the required libcurl version;
     * buffered requests let the shared transport own the only easy handle. */
    CURL *curl = streaming ? curl_easy_init() : NULL;
    char *base = request->cmd == 131073 ? NULL : https_address(string_value(work->configuration, "imHttpAddr"));
    char *url = NULL;
    struct json_object *body = NULL;
    const char *method = "POST";
    struct curl_slist *headers = NULL;
    if (request->cmd == 131073) { im_http_request(work, curl); goto finished; }
    if ((streaming && !curl) || !base) { failure(job, "invalid HTTP configuration"); goto finished; }
    size_t length = strlen(base);
    while (length && base[length - 1] == '/') base[--length] = 0;
    if (im_http_files(work, curl, base)) goto finished;
    url = g_strconcat(base, http_route(request->cmd), NULL);
    if (request->cmd == 131076 || request->cmd == 131077) {
        const char *key = request->cmd == 131076 ? "lastSyncEmojiCategoryTime" : "lastSyncEmojiListTime";
        struct json_object *timestamp = native_get(request->param, key);
        if (!json_object_is_type(timestamp, json_type_string)) { failure(job, "param is not correct!"); goto finished; }
        body = json_object_new_object();
        json_object_object_add(body, "query_timestamp", json_object_get(timestamp));
        if (request->cmd == 131077) {
            struct json_object *category = native_get(request->param, "categoryId");
            if (!json_object_is_type(category, json_type_string)) { failure(job, "param is not correct!"); goto finished; }
            char *escaped = curl_easy_escape(curl, json_object_get_string(category), 0);
            char *with_category = escaped ? g_strconcat(url, "/", escaped, NULL) : NULL;
            curl_free(escaped);
            if (!with_category) { failure(job, "allocation failed"); goto finished; }
            g_free(url); url = with_category;
        }
    } else if (request->cmd == 131082) {
        struct json_object *time = native_get(request->param, "lastSyncEmojiTime");
        struct json_object *owner = native_get(request->param, "ownerAccount");
        if (!json_object_is_type(time, json_type_string) || !json_object_is_type(owner, json_type_string)) {
            failure(job, "param is not correct!"); goto finished;
        }
        body = json_object_new_object();
        json_object_object_add(body, "lastSyncTime", json_object_get(time));
        json_object_object_add(body, "ownerAccount", json_object_get(owner));
    } else body = request->param ? json_object_get(request->param) : json_object_new_object();
    if (request->cmd == 131079) {
        struct json_object *id = native_get(request->param, "objectId");
        if (!json_object_is_type(id, json_type_string)) { failure(job, "param is not correct!"); goto finished; }
        char *escaped = curl_easy_escape(curl, json_object_get_string(id), 0);
        char *with_id = escaped ? g_strconcat(url, "/", escaped, NULL) : NULL;
        curl_free(escaped);
        if (!with_id) { failure(job, "allocation failed"); goto finished; }
        g_free(url); url = with_id;
        method = "GET";
        json_object_put(body); body = NULL;
    } else if (request->cmd == 131080 || request->cmd == 131081) {
        if (!json_object_is_type(request->param, json_type_object)) { failure(job, "param is not correct!"); goto finished; }
        json_object_put(body);
        body = json_object_new_object();
        json_object_object_add(body, "emojiIds", json_object_get(native_get(request->param, "emojiIds")));
        struct json_object *owner = native_get(request->param, "ownerAccount");
        if (json_object_is_type(owner, json_type_string))
            json_object_object_add(body, "ownerAccount", json_object_get(owner));
    }
    if (!http_header(&headers, "authorization", string_value(work->configuration, "authToken")) ||
        !http_header(&headers, "Cookie", string_value(work->configuration, "cookie")) ||
        !http_header(&headers, "x-app-id", "1") || !http_header(&headers, "Content-Type", "application/json") ||
        !http_header(&headers, "charset", "UTF-8")) { failure(job, "invalid HTTP headers"); goto finished; }
    const char *encoded = body ? json_object_to_json_string_ext(body, JSON_C_TO_STRING_PLAIN) : NULL;
    struct ls_http_options options = im_http_options(FALSE);
    struct ls_http_result response = {0};
    CURLcode result = ls_http_perform(&work->routing, url, method, encoded,
        encoded ? strlen(encoded) : 0, headers, &options, &response);
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "resp_code", json_object_new_int64(response.status));
    json_object_object_add(param, "recv_body", json_object_new_string_len(
        response.body.data ? response.body.data : "", response.body.length));
    local_reply(job, request->cmd, result, string_value(request->root, "description"),
                result ? "HTTP transport failed" : "success", param);
    ls_http_result_clear(&response);
finished:
    if (curl) curl_easy_cleanup(curl);
    curl_slist_free_all(headers);
    json_object_put(body);
    g_free(base); g_free(url);
    json_object_put(work->configuration);
    ls_http_context_clear(&work->routing);
    free_job(job); g_free(work);
}

static gboolean credentials_ready_for(struct json_object *configuration)
{
    /* Original AccessStatus: 1 is InLogin, 2 is LoginSuccess. */
    return native_integer(configuration, "login_status", 0) == 2 &&
        *string_value(configuration, "account") && *string_value(configuration, "authToken") &&
        *string_value(configuration, "maaAddr");
}
static void update_configuration(struct im_job *job)
{
    if (!json_object_is_type(job->request.param, json_type_object)) { failure(job, "param error"); return; }
    struct json_object *next = json_object_new_object();
    if (sdk.configuration) {
        json_object_object_foreach(sdk.configuration, key, value) {
            json_object_object_add(next, key, json_object_get(value));
        }
    }
    json_object_object_foreach(job->request.param, key, value) {
        json_object_object_add(next, key, json_object_get(value));
    }
    gboolean changed = !sdk.configuration;
    /* Exclude authToken to match vendor FUN_1010ac40 (isNeedReLogin): hourly
     * token refresh must update HTTP/reconnect credentials without tearing down
     * the live IM TLS session. Clearing authToken still disconnects via !wanted. */
    static const char *identity[] = {"account", "maaAddr", "loginFlag", "clientType", "login_status",
        "rsUrl", "isVerify", "caPath", "proxyInfo"};
    for (size_t n = 0; n < sizeof identity / sizeof *identity; ++n)
        if (!json_object_equal(native_get(next, identity[n]), native_get(sdk.configuration, identity[n]))) changed = TRUE;
    if (im_http_configure(&sdk.routing, next)) {
        json_object_put(next); failure(job, "invalid HTTP configuration"); return;
    }
    gboolean wanted = credentials_ready_for(next);
    gboolean closed = FALSE;
    if ((changed || !wanted) && sdk.connection) {
        closed = sdk.online || sdk.connecting;
        close_connection("session configuration changed", FALSE);
    }
    json_object_put(sdk.configuration);
    sdk.configuration = next;
    sdk.wanted = wanted;
    if (sdk.wanted && (!sdk.connection || changed)) sdk.next_connect = g_get_monotonic_time();
    local_reply(job, 188417, 0, "updateLoginEserverInfo", "success", NULL);
    /* Match vendor doLoginEserverInfoChange: do not re-emit LoginStatusNotify(1)
     * when already online and unchanged, and do not double-emit offline on logout. */
    if (!sdk.wanted && !closed) login_status(FALSE);
}
static void publish_dnd(void)
{
    sdk.dnd_state = im_schedule_do_not_disturb(sdk.dnd, time(NULL));
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "isDoNotDisturb", json_object_new_int(sdk.dnd_state));
    notify_parameter(193024, "DoNotDisturbStateNotify", param);
}
static void process_job(struct im_job *job)
{
    struct native_request *request = &job->request;
    if (job->module == 5) {
        int error = im_adapter_submit(request);
        if (error) failure(job, error == ENODEV ? "adapter handler unavailable" : "adapter request rejected");
        free_job(job);
        return;
    }
    if (job->module != IM_MODULE) { failure(job, "invalid module"); free_job(job); return; }
    switch (request->cmd) {
    case 155648: update_configuration(job); free_job(job); return;
    case 155904: {
        int error = ip_list_change(request->param);
        local_reply(job, 155905, error ? 1 : 0, "ipListChange",
                    error ? strerror(error) : "success", NULL);
        free_job(job); return;
    }
    case 159744: {
        gboolean enabled = native_integer(request->param, "isStartTimer", 0) == 1;
        int64_t threshold = native_integer(request->param, "timeInterval", -1);
        int error = enabled && threshold < 0 ? EINVAL : 0;
        if (enabled && !sdk.idle.x11 && !sdk.idle.bus && !error) error = im_idle_open(&sdk.idle);
        sdk.idle_enabled = enabled && !error;
        sdk.idle_threshold = threshold >= 0 ? (uint64_t)threshold : 0;
        sdk.idle_state = -1; sdk.idle_repeat = 0;
        local_reply(job, 159745, error ? 1 : 0, "tup_native_inittimer_ack",
                    error ? "system idle monitor unavailable" : "success", NULL);
        free_job(job); return;
    }
    case 159746:
        if (!json_object_is_type(request->param, json_type_object)) failure(job, "param error");
        else {
            json_object_put(sdk.dnd); sdk.dnd = json_object_get(request->param);
            publish_dnd();
            local_reply(job, request->cmd, 0, "DoNotDisturbConfig", "success", NULL);
        }
        free_job(job); return;
    case 159748: {
        struct json_object *param = json_object_new_object();
        json_object_object_add(param, "isDoNotDisturb", json_object_new_int(im_schedule_do_not_disturb(sdk.dnd, time(NULL))));
        local_reply(job, request->cmd, 0, "DoNotDisturbQuery", "success", param);
        free_job(job); return;
    }
    default: break;
    }
    if (!sdk.online) { failure(job, "is not login"); free_job(job); return; }
    if (http_route(request->cmd) || request->cmd == 131073 || request->cmd == 131078 ||
        request->cmd == 131083 || request->cmd == 131084) {
        struct http_job *work = g_new0(struct http_job, 1);
        work->job = job;
        if (json_object_deep_copy(sdk.configuration, &work->configuration, NULL) ||
            ls_http_context_copy(&work->routing, &sdk.routing) ||
            !g_thread_pool_push(http_pool, work, NULL)) {
            json_object_put(work->configuration); ls_http_context_clear(&work->routing);
            g_free(work); failure(job, "HTTP worker unavailable"); free_job(job);
        }
        return;
    }
    if (request->cmd < 0x20000 || request->cmd > 0x2ffff || !im_nbr_message_name(request->cmd - 0x20000)) {
        failure(job, "cmdId error"); free_job(job); return;
    }
    GHashTableIter iterator;
    gpointer value;
    g_hash_table_iter_init(&iterator, sdk.pending);
    while (g_hash_table_iter_next(&iterator, NULL, &value)) {
        struct pending *pending = value;
        if (pending->job && pending->job->module == job->module &&
            native_integer(pending->job->request.root, "sno", -1) == native_integer(request->root, "sno", -2)) {
            failure(job, "sno repeat"); free_job(job); return;
        }
    }
    int error = send_message(request->cmd - 0x20000, request->param, job, 0);
    if (error) { failure(job, "param error"); free_job(job); }
}
static void presence_tick(gint64 now)
{
    if (now < sdk.presence_at) return;
    sdk.presence_at = now + 2000000;
    int dnd = im_schedule_do_not_disturb(sdk.dnd, time(NULL));
    if (dnd != sdk.dnd_state) publish_dnd();
    if (!sdk.idle_enabled) return;
    uint64_t idle;
    if (im_idle_milliseconds(&sdk.idle, &idle)) return;
    if (sdk.authenticated_at && (uint64_t)((now - sdk.authenticated_at) / 1000) < idle)
        idle = (now - sdk.authenticated_at) / 1000;
    int state = idle >= sdk.idle_threshold;
    if (sdk.idle_state != state) { sdk.idle_state = state; sdk.idle_repeat = 0; }
    if (sdk.idle_repeat++ >= 4) return;
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "isNotActive", json_object_new_int(state));
    notify_parameter(192768, "TempLeaveNotify", param);
}
static void expire_requests(gint64 now)
{
    GHashTableIter iterator;
    gpointer value;
    g_hash_table_iter_init(&iterator, sdk.pending);
    while (g_hash_table_iter_next(&iterator, NULL, &value)) {
        struct pending *pending = value;
        if (pending->deadline > now) continue;
        if (pending->internal) { close_connection("session request timed out", TRUE); return; }
        for (GList *entry = sdk.outgoing.head; entry; entry = entry->next) {
            struct transmission *transmission = entry->data;
            if (transmission->serial != pending->serial) continue;
            if (transmission->offset) { close_connection("partial request timed out", TRUE); return; }
            g_queue_delete_link(&sdk.outgoing, entry);
            g_byte_array_unref(transmission->frame); g_free(transmission);
            break;
        }
        failure(pending->job, "request timed out");
        g_hash_table_iter_remove(&iterator);
    }
}
static gpointer run_im(gpointer unused)
{
    (void)unused;
    sdk.socket = CURL_SOCKET_BAD;
    sdk.pending = g_hash_table_new_full(g_direct_hash, g_direct_equal, NULL, free_pending);
    sdk.incoming = g_byte_array_new();
    sdk.idle_state = -1;
    while (!g_atomic_int_get(&stopping)) {
        struct im_job *job;
        while (!g_atomic_int_get(&stopping) && (job = g_async_queue_try_pop(jobs))) process_job(job);
        if (g_atomic_int_get(&stopping)) break;
        gint64 now = g_get_monotonic_time();
        if (!sdk.connection && sdk.wanted && !sdk.network_unavailable && now >= sdk.next_connect)
            connect_session();
        now = g_get_monotonic_time();
        presence_tick(now);
        expire_requests(now);
        if (sdk.online && now >= sdk.heartbeat_at) {
            if (send_message(0x110a, NULL, NULL, 2)) close_connection("heartbeat encoding failed", TRUE);
            sdk.heartbeat_at = now + HEARTBEAT_PERIOD;
        }
        if (sdk.connection && !flush_output()) close_connection("send failed", TRUE);
        struct pollfd descriptors[2] = {{wake_pipe[0], POLLIN, 0}, {sdk.socket, POLLIN, 0}};
        if (!g_queue_is_empty(&sdk.outgoing)) descriptors[1].events |= POLLOUT;
        int count = sdk.connection ? 2 : 1;
        int status = poll(descriptors, count, 1000);
        if (status < 0 && errno == EINTR) continue;
        if (descriptors[0].revents & POLLIN) {
            unsigned char bytes[64];
            while (read(wake_pipe[0], bytes, sizeof bytes) > 0) { }
        }
        if (sdk.connection && (descriptors[1].revents & (POLLERR | POLLHUP | POLLNVAL)))
            close_connection("connection closed", TRUE);
        else if (sdk.connection && (descriptors[1].revents & POLLIN) && !receive_input())
            close_connection("receive failed", TRUE);
    }
    sdk.wanted = FALSE;
    close_connection("shutdown", FALSE);
    im_idle_close(&sdk.idle);
    g_hash_table_unref(sdk.pending);
    g_byte_array_unref(sdk.incoming);
    json_object_put(sdk.configuration); json_object_put(sdk.dnd);
    ls_http_context_clear(&sdk.routing);
    memset(&sdk, 0, sizeof sdk);
    /* The owner never joins a worker. All dependent workers now only enqueue
     * callbacks, so it is safe for this thread to finish their cleanup. */
    g_thread_pool_free(http_pool, FALSE, TRUE);
    g_mutex_lock(&lifecycle);
    struct im_job *remaining;
    while ((remaining = g_async_queue_try_pop(jobs))) free_job(remaining);
    g_async_queue_unref(jobs); jobs = NULL;
    GThread *finished = worker;
    worker = NULL; http_pool = NULL;
    close(wake_pipe[0]); close(wake_pipe[1]); wake_pipe[0] = wake_pipe[1] = -1;
    g_mutex_unlock(&lifecycle);
    g_thread_unref(finished);
    return NULL;
}

IM_SDK_EXPORT int SetLog(const char *path)
{
    if (!path || !*path || g_mkdir_with_parents(path, 0700)) return 1;
    char *filename = g_build_filename(path, "native_im.log", NULL);
    int descriptor = open(filename, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    g_free(filename);
    if (descriptor < 0) return 1;
    FILE *stream = fdopen(descriptor, "a");
    if (!stream) { close(descriptor); return 1; }
    g_mutex_lock(&lifecycle);
    if (log_file) fclose(log_file);
    log_file = stream;
    g_mutex_unlock(&lifecycle);
    return 0;
}
IM_SDK_EXPORT int RegistCallBack(im_callback target)
{
    g_mutex_lock(&lifecycle); callback = target; g_mutex_unlock(&lifecycle);
    return 0;
}
IM_SDK_EXPORT int Startup(void)
{
    if (g_once_init_enter(&curl_initialized)) {
        curl_initialization = curl_global_init(CURL_GLOBAL_DEFAULT);
        g_once_init_leave(&curl_initialized, 1);
    }
    if (curl_initialization != CURLE_OK) return 1;
    g_mutex_lock(&lifecycle);
    if (worker) {
        int result = g_atomic_int_get(&stopping) ? 1 : 0;
        g_mutex_unlock(&lifecycle);
        return result;
    }
    if (!callback || pipe2(wake_pipe, O_NONBLOCK | O_CLOEXEC)) { g_mutex_unlock(&lifecycle); return 1; }
    jobs = g_async_queue_new();
    http_pool = g_thread_pool_new(http_worker, NULL, 4, FALSE, NULL);
    g_atomic_int_set(&stopping, 0);
    gboolean adapter_started = FALSE;
    callback_epoch = im_dispatch_start(&im_callbacks);
    if (http_pool && callback_epoch) {
        adapter_started = im_adapter_start(emit) == 0;
        if (adapter_started) worker = g_thread_try_new("welink-im", run_im, NULL, NULL);
    }
    if (!worker) {
        g_atomic_int_set(&stopping, 1);
        im_dispatch_stop(&im_callbacks);
        if (http_pool) g_thread_pool_free(http_pool, TRUE, TRUE);
        g_async_queue_unref(jobs); jobs = NULL; http_pool = NULL;
        close(wake_pipe[0]); close(wake_pipe[1]); wake_pipe[0] = wake_pipe[1] = -1;
    }
    int result = worker ? 0 : 1;
    g_mutex_unlock(&lifecycle);
    if (result && adapter_started) im_adapter_stop();
    return result;
}
IM_SDK_EXPORT int SendMsg(const char *json, int module)
{
    struct im_job *job = g_try_new0(struct im_job, 1);
    if (!job) return 1;
    if (native_parse(&job->request, json)) { g_free(job); return 1; }
    job->module = module;
    g_mutex_lock(&lifecycle);
    if (!worker || g_atomic_int_get(&stopping)) {
        g_mutex_unlock(&lifecycle); free_job(job); return 1;
    }
    g_async_queue_push(jobs, job);
    wake_worker();
    g_mutex_unlock(&lifecycle);
    return 0;
}
IM_SDK_EXPORT int Shutdown(void)
{
    g_mutex_lock(&lifecycle);
    if (!worker || g_atomic_int_get(&stopping)) { g_mutex_unlock(&lifecycle); return 0; }
    if (im_callbacks.owner != g_thread_self()) { g_mutex_unlock(&lifecycle); return 1; }
    g_atomic_int_set(&stopping, 1);
    im_dispatch_stop(&im_callbacks);
    wake_worker();
    g_mutex_unlock(&lifecycle);
    /* Adapter cancellation invokes the pinned JS cancellation handler only
     * here, on the owner thread and with no native lock held. */
    im_adapter_stop();
    return 0;
}
