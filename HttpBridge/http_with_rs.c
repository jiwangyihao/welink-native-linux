/* Linux implementation of the matched http_with_rs.dll JSON adapter.
 * Evidence: /tmp/login-security-http-decompiled.c, RVAs 0x13bd0..0x20590;
 * command table at VA 0x10053138; reply 0x1d0d0; notification 0x1cc70.
 * httpWithRsSdk.js binds only the three http_json_* functions in the header.
 * wk_tup_httptrans.dll RVA 0x1000/0x66d0 proves method enum order below.
 * RVA 0xda00 in that same dependency supplies the default multipart key "file".
 * CURL errors use the vendor's 100 + CURLcode namespace (error map RVA 0x1710).
 * No vendor DLL, Wine process, browser, token cache or recorded response is used.
 */
#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#include "http_with_rs.h"
#include "../LoginSecurity/login_security_http.h"
#include <arpa/inet.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

struct event { struct event *next; char *text; unsigned handle; int notify; };
struct session;
struct job {
    struct job *next;
    struct session *session;
    struct json_object *message, *param, *request, *settings;
    struct ls_http_context http;
    struct ls_http_options options;
    struct ls_http_result result;
    struct curl_slist *headers;
    unsigned revision, handle;
    atomic_int cancelled;
    int cmd, upload, download, pinned_ip, fd, file_ready, invalid_range, compass_published;
    const char *url, *method, *body;
    size_t body_size;
    curl_off_t file_size, initial_offset, range_start;
    long status, low_speed_limit, low_speed_time;
    struct ls_http_buffer response;
    struct json_object *response_headers;
    curl_mime *mime;
    char range[64], request_id[37];
    const char *trace_id; /* Borrowed from this job's immutable curl_slist. */
    struct timespec progress_at;
    curl_off_t progress_total, progress_now;
};
struct session {
    pthread_t owner;
    http_rs_callback callback;
    atomic_int cancelled;
    struct ls_http_context http;
    struct event *head, *tail;
    struct job *jobs;
    unsigned revision, references;
    int dispatching;
};
/* These C references complement, but cannot replace, the JS process-lifetime
 * ffi.Callback registry. A worker never reads or invokes a callback pointer. */
struct callback_pin { struct callback_pin *next; http_rs_callback callback; };
static pthread_mutex_t bus_lock = PTHREAD_MUTEX_INITIALIZER;
static struct session *active;
static struct callback_pin *callback_pins;
static unsigned next_handle;
static void *library_pin;
static int log_fd = -1, log_level = 2, log_module;
static pthread_once_t curl_once = PTHREAD_ONCE_INIT;
static CURLcode curl_init_result;
static void init_curl(void) { curl_init_result = curl_global_init(CURL_GLOBAL_DEFAULT); }

static struct json_object *get(struct json_object *o, const char *key)
{
    struct json_object *v = NULL;
    if (json_object_is_type(o, json_type_object)) json_object_object_get_ex(o, key, &v);
    return v;
}
static const char *string(struct json_object *o, const char *key)
{
    struct json_object *v = get(o, key);
    return json_object_is_type(v, json_type_string) ? json_object_get_string(v) : "";
}
static int64_t integer(struct json_object *o, const char *key, int64_t fallback)
{
    struct json_object *v = get(o, key);
    return json_object_is_type(v, json_type_int) ? json_object_get_int64(v) : fallback;
}
static struct json_object *http_rs_clone_json(struct json_object *o)
{
    struct json_object *copy = NULL;
    if (o && json_object_deep_copy(o, &copy, NULL)) return NULL;
    return copy;
}
static void scrub_json(struct json_object *o)
{
    if (json_object_is_type(o, json_type_string))
        OPENSSL_cleanse((void *)json_object_get_string(o), (size_t)json_object_get_string_len(o));
    else if (json_object_is_type(o, json_type_object)) {
        json_object_object_foreach(o, key, value) { (void)key; scrub_json(value); }
    } else if (json_object_is_type(o, json_type_array)) {
        for (size_t i = 0; i < json_object_array_length(o); i++) scrub_json(json_object_array_get_idx(o, i));
    }
}
static void free_text(char *text)
{
    if (text) { OPENSSL_cleanse(text, strlen(text)); free(text); }
}
static void log_status(int cmd, int result)
{
    if (log_fd < 0 || (log_level == 0 && !result)) return;
    char line[160];
    int n = snprintf(line, sizeof line, "%lld module=%d cmd=%d result=%d\n",
                     (long long)time(NULL), log_module, cmd, result);
    if (n > 0 && (size_t)n < sizeof line) {
        ssize_t ignored = write(log_fd, line, (size_t)n); (void)ignored;
    }
}
static void event_free(struct event *e) { if (e) { free_text(e->text); free(e); } }
static void clear_events(struct session *s)
{
    while (s->head) { struct event *e = s->head; s->head = e->next; event_free(e); }
    s->tail = NULL;
}
static void release_session(struct session *s)
{
    if (--s->references) return;
    clear_events(s); ls_http_context_clear(&s->http); free(s);
}
/* Consumes JSON, queues serialized immutable bytes; caller holds bus_lock. */
static int enqueue(struct session *s, struct json_object *message, unsigned handle, int notify)
{
    if (!message) return ENOMEM;
    const char *text = json_object_to_json_string_ext(message, JSON_C_TO_STRING_PLAIN);
    char *copy = text ? strdup(text) : NULL;
    json_object_put(message);
    if (!copy) return ENOMEM;
    if (active != s || atomic_load(&s->cancelled)) { free_text(copy); return ECANCELED; }
    /* Progress is replaceable; replies and terminal notifications are not. */
    if (notify == 1 || notify == 3 || notify == 5) {
        for (struct event *e = s->head; e; e = e->next) {
            if (e->handle == handle && e->notify == notify) {
                free_text(e->text); e->text = copy; return 0;
            }
        }
    }
    struct event *e = calloc(1, sizeof *e);
    if (!e) { free_text(copy); return ENOMEM; }
    e->text = copy; e->handle = handle; e->notify = notify;
    if (s->tail) s->tail->next = e; else s->head = e;
    s->tail = e;
    return 0;
}
static struct json_object *reply(struct json_object *request, int result,
                                 struct json_object *param, const char *reason)
{
    struct json_object *o = json_object_new_object();
    if (!o) { json_object_put(param); return NULL; }
    const char *keys[] = {"cmd", "sno", "description"};
    const char *dest[] = {"rsp", "sno", "description"};
    for (size_t i = 0; i < 3; i++) {
        struct json_object *v = get(request, keys[i]);
        if (json_object_is_type(v, i == 2 ? json_type_string : json_type_int))
            json_object_object_add(o, dest[i], json_object_get(v));
    }
    json_object_object_add(o, "result", json_object_new_int(result));
    if (reason && *reason) json_object_object_add(o, "reason", json_object_new_string(reason));
    json_object_object_add(o, "param", param); /* Original empty Json::Value is null. */
    return o;
}
static const char *notification_name(int id)
{
    static const char *names[] = {NULL, "HTTP_RS_NOTIFY_DOWNLOAD_PROCESS",
        "HTTP_RS_NOTIFY_DOWNLOAD_RESPONSE", "HTTP_RS_NOTIFY_DOWNLOAD_UPGRADING_FILE_PROCESS",
        "HTTP_RS_NOTIFY_DOWNLOAD_UPGRADING_FILE_RESPONSE", "HTTP_RS_NOTIFY_UPLOAD_PROCESS",
        "HTTP_RS_NOTIFY_UPLOAD_RESPONSE", "HTTP_NOTIFY_ASYN_SEND_RESPONSE",
        "HTTP_RS_NOTIFY_UPATDE_COMPASS_CONFIG"};
    return names[id];
}
static struct json_object *notification(int id, struct json_object *param)
{
    struct json_object *o = json_object_new_object();
    if (!o) { json_object_put(param); return NULL; }
    json_object_object_add(o, "notify", json_object_new_int(id));
    json_object_object_add(o, "description", json_object_new_string(notification_name(id)));
    json_object_object_add(o, "param", param);
    return o;
}
static int cancelled(void *opaque)
{
    struct job *j = opaque;
    return atomic_load(&j->cancelled) || atomic_load(&j->session->cancelled);
}
/* JSON-C reference counts are not atomic. Unlike context_copy's shared immutable
 * Compass references, worker snapshots own ALL nodes and may be freed off-thread. */
static int copy_context(struct ls_http_context *out, const struct ls_http_context *in)
{
    struct ls_http_context copy = {0};
    struct json_object **to[] = {&copy.settings, &copy.compass, &copy.addresses, &copy.last_ips, &copy.standby};
    struct json_object *from[] = {in->settings, in->compass, in->addresses, in->last_ips, in->standby};
    for (size_t i = 0; i < 5; i++) {
        if (from[i] && !(*to[i] = http_rs_clone_json(from[i]))) { ls_http_context_clear(&copy); return ENOMEM; }
    }
    copy.queried = in->queried; copy.ttl = in->ttl; copy.enabled = in->enabled;
    ls_http_context_clear(out); *out = copy;
    return 0;
}
/* GetStandbyInfo/notify8 expose the flattened standby map, not the server's
 * nested objects. Never manufacture enable/httpDns/default domains before RS. */
static struct json_object *compass_view(const struct ls_http_context *c)
{
    if (!c->compass) return NULL;
    struct json_object *o = json_object_new_object();
    if (!o) return NULL;
    json_object_object_add(o, "enable", json_object_new_boolean(c->enabled));
    struct json_object *stamp = get(c->compass, "lastUpdateTime");
    json_object_object_add(o, "lastUpdateTime", stamp ? http_rs_clone_json(stamp) : json_object_new_int(0));
    if (c->enabled) {
        if (c->standby) json_object_object_add(o, "standbyDomainConfig", http_rs_clone_json(c->standby));
        struct json_object *dns = get(c->compass, "httpDns");
        if (dns) json_object_object_add(o, "httpDns", http_rs_clone_json(dns));
    }
    return o;
}
static void publish_context(struct job *j)
{
    struct session *s = j->session;
    pthread_mutex_lock(&bus_lock);
    if (active == s && !cancelled(j) && s->revision == j->revision) {
        if (j->http.compass && j->http.queried >= s->http.queried) {
            struct json_object *before = compass_view(&s->http);
            struct json_object *after = compass_view(&j->http);
            int changed = after && (!before || !json_object_equal(before, after));
            if (!copy_context(&s->http, &j->http) && changed)
                enqueue(s, notification(8, after), 0, 8);
            else json_object_put(after);
            json_object_put(before);
        } else if (j->http.last_ips) {
            if (!s->http.last_ips) s->http.last_ips = json_object_new_object();
            json_object_object_foreach(j->http.last_ips, host, ip) {
                json_object_object_add(s->http.last_ips, host, http_rs_clone_json(ip));
            }
        }
    }
    pthread_mutex_unlock(&bus_lock);
}
static int add_header(struct curl_slist **headers, const char *name, const char *value)
{
    if (!*name || strpbrk(name, ":\r\n") || strpbrk(value, "\r\n")) return EINVAL;
    size_t n = strlen(name), v = strlen(value);
    if (n > SIZE_MAX - v - 3) return ENOMEM;
    char *line = malloc(n + v + 3);
    if (!line) return ENOMEM;
    memcpy(line, name, n); line[n] = ':'; line[n + 1] = ' ';
    memcpy(line + n + 2, value, v + 1);
    struct curl_slist *next = curl_slist_append(*headers, line);
    free_text(line);
    if (!next) return ENOMEM;
    *headers = next; return 0;
}
static int headers_from_json(struct curl_slist **headers, struct json_object *o)
{
    if (!o) return 0;
    if (json_object_is_type(o, json_type_object)) {
        json_object_object_foreach(o, name, value) {
            if (!json_object_is_type(value, json_type_string)) return EINVAL;
            int e = add_header(headers, name, json_object_get_string(value)); if (e) return e;
        }
        return 0;
    }
    if (!json_object_is_type(o, json_type_array)) return EINVAL;
    for (size_t i = 0; i < json_object_array_length(o); i++) {
        struct json_object *item = json_object_array_get_idx(o, i);
        if (!json_object_is_type(get(item, "name"), json_type_string) ||
            !json_object_is_type(get(item, "value"), json_type_string)) return EINVAL;
        int e = add_header(headers, string(item, "name"), string(item, "value")); if (e) return e;
    }
    return 0;
}
static void setting(struct json_object *out, const char *key, struct json_object *in, const char *from)
{
    struct json_object *v = get(in, from);
    if (v) json_object_object_add(out, key, http_rs_clone_json(v));
}
static int make_settings(struct job *j)
{
    j->settings = json_object_new_object();
    if (!j->settings) return ENOMEM;
    struct json_object *p = j->param, *config = get(p, "config_param");
    struct json_object *tls = get(config, "tls_param");
    if (!tls) tls = get(p, "tls_param");
    if (!tls) tls = get(p, "tlsParam");
    if (tls) {
        setting(j->settings, "ca_cert_path", tls, "ca_cert_path");
        setting(j->settings, "ca_cert_path", tls, "caCertPath");
        const char *keys[] = {"client_cert_path", "client_key_path", "client_priv_keypw", "client_cert_type", "client_key_type"};
        for (size_t i = 0; i < sizeof keys / sizeof *keys; i++) setting(j->settings, keys[i], tls, keys[i]);
    }
    /* Legacy tlsMode=0 must not silently disable native TLS/hostname validation.
     * Both custom and system CA attempts remain authenticated. */
    json_object_object_add(j->settings, "verify_mode", json_object_new_int(1));
    struct json_object *proxy = get(p, "proxyInfo");
    if (proxy) {
        json_object_object_add(j->settings, "proxy_addr", json_object_new_string(string(proxy, "proxyAddress")));
        setting(j->settings, "proxy_port", proxy, "proxyPort");
        setting(j->settings, "proxy_account", proxy, "proxyAccount");
        setting(j->settings, "proxy_pwd", proxy, "proxyPassword");
    } else if ((proxy = get(config, "proxy_param"))) {
        /* 105/107 use addr/username/pwd; 109/111 use ip/auth_info. */
        const char *address = string(proxy, "ip");
        if (!*address) address = string(proxy, "addr");
        json_object_object_add(j->settings, "proxy_addr", json_object_new_string(address));
        setting(j->settings, "proxy_port", proxy, "port");
        setting(j->settings, "proxy_account", proxy, "username");
        setting(j->settings, "proxy_pwd", proxy, "pwd");
        setting(j->settings, "proxy_account", get(proxy, "auth_info"), "username");
        setting(j->settings, "proxy_pwd", get(proxy, "auth_info"), "password");
    }
    /* The JS proxy port can be a decimal string. The original native parser
     * receives an integer for nested requests, a string for proxyInfo. */
    struct json_object *port = get(j->settings, "proxy_port");
    if (json_object_is_type(port, json_type_string)) {
        char *end; errno = 0;
        long n = strtol(json_object_get_string(port), &end, 10);
        if (errno || *end || n < 0 || n > 65535) return EINVAL;
        json_object_object_add(j->settings, "proxy_port", json_object_new_int64(n));
    }
    struct json_object *timeouts = config ? config : p;
    j->options.settings = j->settings;
    j->options.connect_timeout = (long)integer(timeouts, "tcp_timeout", j->cmd == 109 ? 5 : 10);
    j->options.total_timeout = (long)integer(timeouts, "req_timeout", j->upload || j->cmd == 105 ? 3600 : 30);
    if (j->options.connect_timeout < 0 || j->options.total_timeout < 0) return EINVAL;
    if (!j->options.connect_timeout) j->options.connect_timeout_ms = -1;
    if (!j->options.total_timeout) j->options.total_timeout_ms = -1;
    j->options.cancel_check = cancelled; j->options.cancel_context = j;
    j->low_speed_limit = (long)integer(timeouts, "low_speed_limit", 0);
    j->low_speed_time = (long)integer(timeouts, "low_speed_time", 0);
    if (j->low_speed_limit < 0 || j->low_speed_time < 0) return EINVAL;
    return 0;
}
static int make_request_id(char out[37])
{
    unsigned char b[16];
    if (RAND_bytes(b, sizeof b) != 1) return EIO;
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             b[0],b[1],b[2],b[3],b[4],b[5],b[6],b[7],b[8],b[9],b[10],b[11],b[12],b[13],b[14],b[15]);
    return 0;
}
static int setup_job(struct job *j)
{
    static const char *methods[] = {"POST", "DELETE", "PUT", "GET", "HEAD"};
    j->param = get(j->message, "param");
    j->request = j->cmd == 109 || j->cmd == 110 ? get(j->param, "req_param") : j->param;
    if (j->cmd == 113) return make_settings(j);
    if (!json_object_is_type(j->request, json_type_object)) return EINVAL;
    j->upload = j->cmd == 107 || j->cmd == 111 || j->cmd == 114;
    j->download = j->cmd == 104 || j->cmd == 105 || j->cmd == 112 || j->cmd == 115;
    j->url = string(j->request, j->cmd == 105 ? "version_download_url" : "url");
    if (!*j->url) return EINVAL;
    CURLU *url = curl_url(); char *host = NULL, *scheme = NULL, *user = NULL;
    int invalid = !url || curl_url_set(url, CURLUPART_URL, j->url, 0) ||
        curl_url_get(url, CURLUPART_HOST, &host, 0) ||
        curl_url_get(url, CURLUPART_SCHEME, &scheme, 0) ||
        (strcmp(scheme, "http") && strcmp(scheme, "https")) ||
        curl_url_get(url, CURLUPART_USER, &user, 0) != CURLUE_NO_USER;
    if (!invalid && (j->cmd == 114 || j->cmd == 115)) {
        unsigned char address[16]; const char *ip = string(j->param, "ip_address");
        invalid = inet_pton(AF_INET, ip, address) != 1 && inet_pton(AF_INET6, ip, address) != 1;
        if (!invalid) {
            /* A private last-IP map selects the explicit peer while libcurl
             * keeps the original URL authority for Host, SNI and verification.
             * terminal() stops DNS/RS failover, but not custom->system CA retry. */
            json_object_put(j->http.last_ips); j->http.last_ips = json_object_new_object();
            if (!j->http.last_ips) invalid = 1;
            else json_object_object_add(j->http.last_ips, host, json_object_new_string(ip));
            j->pinned_ip = 1;
        }
    }
    curl_free(host); curl_free(scheme); curl_free(user); curl_url_cleanup(url);
    if (invalid) return EINVAL;
    if (j->pinned_ip || j->cmd == 109 || j->cmd == 110 || j->cmd == 111 || j->cmd == 112) {
        /* Direct commands bypass Compass, without discarding inherited CA/proxy. */
        json_object_object_add(j->http.settings, "rs_url", json_object_new_string(""));
        if (!j->pinned_ip) {
            json_object_put(j->http.last_ips); j->http.last_ips = NULL;
        }
        j->http.enabled = 0;
    }
    int64_t type = integer(j->request, j->upload ? "req_type" : "type", j->download ? 3 : 0);
    if (type < 0 || type > 4) return EINVAL;
    j->method = methods[type]; j->body = string(j->request, "body");
    struct json_object *body = get(j->request, "body");
    if (body && !json_object_is_type(body, json_type_string)) return EINVAL;
    j->body_size = body ? (size_t)json_object_get_string_len(body) : 0;
    if (j->upload && type != 0 && type != 2) return EINVAL;
    int error = make_settings(j);
    if (!error) error = headers_from_json(&j->headers, get(j->request, "header"));
    if (!error) error = make_request_id(j->request_id);
    if (!error) {
        for (struct curl_slist *h = j->headers; h; h = h->next) {
            const char *colon = strchr(h->data, ':');
            if (colon && colon - h->data == 7 && !strncasecmp(h->data, "traceid", 7)) {
                if (j->trace_id) return EINVAL;
                j->trace_id = colon + 1;
                while (*j->trace_id == ' ' || *j->trace_id == '\t') j->trace_id++;
            }
        }
        if (!j->trace_id) {
            char trace_uuid[37], trace[52];
            error = make_request_id(trace_uuid);
            if (!error) {
                snprintf(trace, sizeof trace, "pc-{%s}", trace_uuid);
                error = add_header(&j->headers, "traceid", trace);
                if (!error) {
                    struct curl_slist *last = j->headers;
                    while (last->next) last = last->next;
                    j->trace_id = last->data + 9;
                }
            }
        }
    }
    if (error) return error;
    struct json_object *auth = get(j->request, "auth_info");
    /* The matched frontend only emits mode 0; unknown native auth enums are
     * rejected rather than silently sending unauthenticated requests. */
    if (integer(auth, "mode", 0) != 0) return ENOTSUP;
    if (j->upload || j->download) {
        const char *path = string(j->param, "file_path");
        if (!*path) return EINVAL;
        j->fd = open(path, (j->upload ? O_RDONLY : O_RDWR | O_CREAT) | O_CLOEXEC | O_NOFOLLOW, 0600);
        if (j->fd < 0) return errno;
        struct stat st;
        if (fstat(j->fd, &st)) return errno;
        if (!S_ISREG(st.st_mode)) return EINVAL;
        j->file_size = (curl_off_t)st.st_size;
        if (j->cmd == 105 && json_object_get_boolean(get(j->param, "keep_download")))
            j->initial_offset = j->file_size;
        if (j->upload) {
            struct json_object *parts = get(j->param, "form_options");
            if (parts && !json_object_is_type(parts, json_type_array)) return EINVAL;
            for (size_t i = 0; parts && i < json_object_array_length(parts); i++) {
                struct json_object *part = json_object_array_get_idx(parts, i);
                if (!json_object_is_type(get(part, "key"), json_type_string) ||
                    !json_object_is_type(get(part, "content"), json_type_string)) return EINVAL;
            }
            parts = get(j->param, "mult_part");
            if (parts && (!json_object_is_type(get(parts, "key"), json_type_string) ||
                          !json_object_is_type(get(parts, "content"), json_type_string))) return EINVAL;
        }
    }
    return 0;
}
static int append_body(struct ls_http_buffer *b, const void *data, size_t size)
{
    if (size > (size_t)INT_MAX - 1 - b->length) return 0;
    size_t need = b->length + size + 1;
    if (need > b->capacity) {
        size_t cap = b->capacity ? b->capacity : 4096;
        while (cap < need) { if (cap > (size_t)INT_MAX / 2) { cap = need; break; } cap *= 2; }
        char *next = realloc(b->data, cap); if (!next) return 0;
        b->data = next; b->capacity = cap;
    }
    memcpy(b->data + b->length, data, size); b->length += size; b->data[b->length] = 0;
    return 1;
}
static size_t receive_body(char *data, size_t size, size_t count, void *opaque)
{
    struct job *j = opaque;
    if (count && size > SIZE_MAX / count) return 0;
    size_t n = size * count;
    if (cancelled(j)) return 0;
    if (j->download && j->status >= 200 && j->status < 300) {
        if (!j->file_ready || j->invalid_range) return 0;
        size_t done = 0;
        while (done < n) {
            ssize_t written = write(j->fd, data + done, n - done);
            if (written < 0 && errno == EINTR) continue;
            if (written <= 0) return 0;
            done += (size_t)written;
        }
        return n;
    }
    return append_body(&j->response, data, n) ? n : 0;
}
static size_t receive_header(char *data, size_t size, size_t count, void *opaque)
{
    struct job *j = opaque;
    if (count && size > SIZE_MAX / count) return 0;
    size_t n = size * count;
    if (cancelled(j)) return 0;
    if (n >= 5 && !strncasecmp(data, "HTTP/", 5)) {
        const char *space = memchr(data, ' ', n);
        j->status = space ? strtol(space + 1, NULL, 10) : 0;
        json_object_put(j->response_headers); j->response_headers = json_object_new_array();
        j->range_start = -1; j->file_ready = 0;
        if (!j->response_headers) return 0;
    } else if (n == 2 && data[0] == '\r' && data[1] == '\n') {
        if (j->download && j->status >= 200 && j->status < 300) {
            curl_off_t offset = j->status == 206 ? j->initial_offset : 0;
            if (j->status == 206 && j->range_start != offset) { j->invalid_range = 1; return 0; }
            /* A TLS/proxy failure must not erase an existing partial file. */
            if (ftruncate(j->fd, (off_t)offset) || lseek(j->fd, (off_t)offset, SEEK_SET) < 0) return 0;
            j->file_ready = 1;
        }
    } else {
        const char *colon = memchr(data, ':', n);
        if (colon) {
            size_t name_len = (size_t)(colon - data), end = n;
            while (end && (data[end - 1] == '\r' || data[end - 1] == '\n')) end--;
            const char *value = colon + 1;
            while (value < data + end && (*value == ' ' || *value == '\t')) value++;
            if (end < (size_t)(value - data)) return 0;
            struct json_object *h = json_object_new_object();
            if (!h) return 0;
            json_object_object_add(h, "name", json_object_new_string_len(data, (int)name_len));
            json_object_object_add(h, "value", json_object_new_string_len(value, (int)(data + end - value)));
            if (!j->response_headers) j->response_headers = json_object_new_array();
            if (!j->response_headers || json_object_array_add(j->response_headers, h)) { json_object_put(h); return 0; }
            if (name_len == 13 && !strncasecmp(data, "Content-Range", name_len)) {
                long long first;
                /* Parse the bounded copy, not the non-terminated curl buffer. */
                if (sscanf(string(h, "value"), "bytes %lld-", &first) == 1 && first >= 0)
                    j->range_start = (curl_off_t)first;
            }
        }
    }
    return n;
}
static size_t read_upload(char *data, size_t size, size_t count, void *opaque)
{
    struct job *j = opaque;
    if (cancelled(j) || (count && size > SIZE_MAX / count)) return CURL_READFUNC_ABORT;
    ssize_t n;
    do n = read(j->fd, data, size * count); while (n < 0 && errno == EINTR);
    return n < 0 ? CURL_READFUNC_ABORT : (size_t)n;
}
static int seek_upload(void *opaque, curl_off_t offset, int origin)
{
    struct job *j = opaque;
    return lseek(j->fd, (off_t)offset, origin) < 0 ? CURL_SEEKFUNC_FAIL : CURL_SEEKFUNC_OK;
}
static int progress(void *opaque, curl_off_t total_down, curl_off_t now_down,
                    curl_off_t total_up, curl_off_t now_up)
{
    struct job *j = opaque;
    if (cancelled(j)) return 1;
    if (!j->handle || (!j->upload && !j->download)) return 0;
    curl_off_t total = j->upload ? total_up : total_down;
    curl_off_t now = j->upload ? now_up : now_down;
    if (j->download && j->initial_offset && j->status == 206) {
        total += j->initial_offset; now += j->initial_offset;
    }
    if (total == j->progress_total && now == j->progress_now) return 0;
    struct timespec clock; clock_gettime(CLOCK_MONOTONIC, &clock);
    int64_t elapsed = (int64_t)(clock.tv_sec - j->progress_at.tv_sec) * 1000 +
                      (clock.tv_nsec - j->progress_at.tv_nsec) / 1000000;
    if (j->progress_at.tv_sec && elapsed < 200 && now != total) return 0;
    j->progress_at = clock; j->progress_total = total; j->progress_now = now;
    struct json_object *p = json_object_new_object();
    if (!p) return 1;
    json_object_object_add(p, "handle", json_object_new_int64(j->handle));
    json_object_object_add(p, "total", json_object_new_int64(total));
    json_object_object_add(p, "now", json_object_new_int64(now));
    int id = j->upload ? 5 : j->cmd == 105 ? 3 : 1;
    pthread_mutex_lock(&bus_lock);
    int e = enqueue(j->session, notification(id, p), j->handle, id);
    pthread_mutex_unlock(&bus_lock);
    return e ? 1 : 0;
}
static CURLcode add_form(curl_mime *mime, struct json_object *entry)
{
    curl_mimepart *part = curl_mime_addpart(mime);
    if (!part) return CURLE_OUT_OF_MEMORY;
    CURLcode e = curl_mime_name(part, string(entry, "key"));
    if (!e) e = curl_mime_data(part, string(entry, "content"),
                             (size_t)json_object_get_string_len(get(entry, "content")));
    return e;
}
static CURLcode prepare(CURL *curl, unsigned attempt, const char *target, void *opaque)
{
    (void)attempt; (void)target;
    struct job *j = opaque;
    if (cancelled(j)) return CURLE_ABORTED_BY_CALLBACK;
    if (!j->compass_published && j->http.compass && !j->pinned_ip &&
        j->cmd != 109 && j->cmd != 110 && j->cmd != 111 && j->cmd != 112) {
        /* Publish the real RS update before a potentially hour-long transfer,
         * rather than delaying notify8 until that transfer completes. */
        publish_context(j);
        j->compass_published = 1;
    }
    if (j->mime) { curl_mime_free(j->mime); j->mime = NULL; }
    if (j->response.data) OPENSSL_cleanse(j->response.data, j->response.length);
    j->response.length = 0; if (j->response.data) j->response.data[0] = 0;
    json_object_put(j->response_headers); j->response_headers = NULL;
    j->status = 0; j->file_ready = 0; j->invalid_range = 0; j->range_start = -1;
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, receive_body);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, j);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, receive_header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, j);
    if (j->low_speed_limit) curl_easy_setopt(curl, CURLOPT_LOW_SPEED_LIMIT, j->low_speed_limit);
    if (j->low_speed_time) curl_easy_setopt(curl, CURLOPT_LOW_SPEED_TIME, j->low_speed_time);
    if (j->upload) {
        if (lseek(j->fd, 0, SEEK_SET) < 0) return CURLE_READ_ERROR;
        if (!strcmp(j->method, "PUT")) {
            curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
            curl_easy_setopt(curl, CURLOPT_READFUNCTION, read_upload);
            curl_easy_setopt(curl, CURLOPT_READDATA, j);
            curl_easy_setopt(curl, CURLOPT_SEEKFUNCTION, seek_upload);
            curl_easy_setopt(curl, CURLOPT_SEEKDATA, j);
            curl_easy_setopt(curl, CURLOPT_INFILESIZE_LARGE, j->file_size);
        } else {
            j->mime = curl_mime_init(curl);
            if (!j->mime) return CURLE_OUT_OF_MEMORY;
            struct json_object *parts = get(j->param, "form_options");
            CURLcode e = CURLE_OK;
            for (size_t i = 0; parts && i < json_object_array_length(parts) && !e; i++)
                e = add_form(j->mime, json_object_array_get_idx(parts, i));
            if (!e && get(j->param, "mult_part")) e = add_form(j->mime, get(j->param, "mult_part"));
            curl_mimepart *file = !e ? curl_mime_addpart(j->mime) : NULL;
            if (!e && !file) e = CURLE_OUT_OF_MEMORY;
            const char *key = string(j->param, "file_form_key");
            const char *path = string(j->param, "file_path"), *slash = strrchr(path, '/');
            if (!e) e = curl_mime_name(file, *key ? key : "file");
            if (!e) e = curl_mime_filename(file, slash ? slash + 1 : path);
            if (!e) e = curl_mime_data_cb(file, j->file_size, read_upload, seek_upload, NULL, j);
            if (e) return e;
            curl_easy_setopt(curl, CURLOPT_MIMEPOST, j->mime);
        }
    } else {
        if (!strcmp(j->method, "HEAD")) curl_easy_setopt(curl, CURLOPT_NOBODY, 1L);
        else if (strcmp(j->method, "GET") || j->body_size) {
            curl_easy_setopt(curl, CURLOPT_POSTFIELDS, j->body);
            curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)j->body_size);
        }
        if (j->download && j->initial_offset) {
            snprintf(j->range, sizeof j->range, "%lld-", (long long)j->initial_offset);
            curl_easy_setopt(curl, CURLOPT_RANGE, j->range);
        }
    }
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, j->method);
    return CURLE_OK;
}
static int terminal(CURLcode code, long status, void *opaque)
{
    struct job *j = opaque;
    if (j->pinned_ip || j->cmd == 109 || j->cmd == 110 || j->cmd == 111 || j->cmd == 112) return 1;
    /* Original RS sync routing treats 2xx and 4xx as terminal; 3xx/5xx can
     * try an advertised peer/standby but never become synthetic success. */
    return code == CURLE_OK && ((status >= 200 && status < 300) || (status >= 400 && status < 500));
}
static struct json_object *sync_result(struct job *j)
{
    struct json_object *p = json_object_new_object();
    if (!p) return NULL;
    if (j->response.data) json_object_object_add(p, "recv_body", json_object_new_string_len(j->response.data, (int)j->response.length));
    json_object_object_add(p, "resp_code", json_object_new_int64(j->result.status ?
        j->result.status : j->cmd == 103 ? 700 : 0));
    size_t count = j->response_headers ? json_object_array_length(j->response_headers) : 0;
    json_object_object_add(p, "out_header_num", json_object_new_int64((int64_t)count));
    if (count) {
        struct json_object *headers = json_object_new_array();
        for (size_t i = 0; i < count; i++) {
            struct json_object *in = json_object_array_get_idx(j->response_headers, i), *h = json_object_new_object();
            json_object_object_add(h, "header_name", json_object_new_string(string(in, "name")));
            json_object_object_add(h, "header_value", json_object_new_string(string(in, "value")));
            json_object_array_add(headers, h);
        }
        json_object_object_add(p, "out_header", headers);
    }
    json_object_object_add(p, "out_real_auth_name", json_object_new_string(""));
    json_object_object_add(p, "requestId", json_object_new_string(j->request_id));
    if (j->cmd == 103) json_object_object_add(p, "traceId", json_object_new_string(j->trace_id));
    if (j->result.ca_fallback && j->result.ca_path)
        json_object_object_add(p, "usedInstallCaPath", json_object_new_string(j->result.ca_path));
    return p;
}
static struct json_object *transfer_result(struct job *j, int ret, const char *reason)
{
    struct json_object *p = json_object_new_object();
    if (!p) return NULL;
    json_object_object_add(p, "handle", json_object_new_int64(j->handle));
    json_object_object_add(p, "ret", json_object_new_int(ret));
    if (j->cmd != 105 && j->cmd != 110)
        json_object_object_add(p, "ret_reason", json_object_new_string(reason && *reason ? reason :
            ret ? "Unknown error type." : "All fine. Proceed as usual."));
    if (j->result.status) {
        struct json_object *body = json_object_new_object();
        json_object_object_add(body, "rsp_code", json_object_new_int64(j->result.status));
        if (j->response.data) json_object_object_add(body, "rsp_msg", json_object_new_string_len(j->response.data, (int)j->response.length));
        if (j->response_headers && json_object_array_length(j->response_headers))
            json_object_object_add(body, "header", json_object_get(j->response_headers));
        json_object_object_add(p, "rsp_body", body);
    }
    return p;
}
static void free_job(struct job *j)
{
    if (j->fd >= 0) close(j->fd);
    if (j->mime) curl_mime_free(j->mime);
    for (struct curl_slist *h = j->headers; h; h = h->next) OPENSSL_cleanse(h->data, strlen(h->data));
    curl_slist_free_all(j->headers);
    if (j->response.data) { OPENSSL_cleanse(j->response.data, j->response.length); free(j->response.data); }
    json_object_put(j->response_headers); ls_http_result_clear(&j->result);
    scrub_json(j->settings); json_object_put(j->settings);
    scrub_json(j->message); json_object_put(j->message);
    ls_http_context_clear(&j->http); free(j);
}
/* Implemented below through the shared Compass query API, not an independent
 * HTTP implementation: authentication, .com/.cn fallback and TLS remain shared. */
static int query_compass(struct job *j);
static void *run_job(void *opaque)
{
    struct job *j = opaque;
    int result;
    const char *reason = NULL;
    if (j->cmd == 113) {
        result = query_compass(j);
        reason = result ? "Compass configuration is unavailable from the configured RS server" : NULL;
    } else {
        CURL *curl = curl_easy_init();
        if (!curl) j->result.transport = CURLE_OUT_OF_MEMORY;
        else {
            struct ls_http_stream stream = {.prepare = prepare, .progress = progress, .terminal = terminal, .context = j};
            ls_http_perform_stream(&j->http, curl, j->url, j->headers, &j->options, &stream, &j->result);
            curl_easy_setopt(curl, CURLOPT_MIMEPOST, NULL);
            if (j->mime) { curl_mime_free(j->mime); j->mime = NULL; }
            curl_easy_cleanup(curl);
        }
        if (cancelled(j)) j->result.transport = CURLE_ABORTED_BY_CALLBACK;
        if (j->download && j->result.transport == CURLE_OK && fsync(j->fd)) j->result.transport = CURLE_WRITE_ERROR;
        result = j->result.transport ? 100 + (int)j->result.transport : 0;
        reason = result ? curl_easy_strerror(j->result.transport) : "All fine. Proceed as usual.";
    }
    if (!j->pinned_ip && j->cmd != 109 && j->cmd != 110 && j->cmd != 111 && j->cmd != 112) publish_context(j);
    struct json_object *message;
    int notify = 0;
    if (j->cmd == 113) message = reply(j->message, result, compass_view(&j->http), reason);
    else if (j->handle) {
        notify = j->upload ? 6 : j->cmd == 105 ? 4 : j->cmd == 110 ? 7 : 2;
        message = notification(notify, transfer_result(j, result, reason));
    } else message = reply(j->message, result, sync_result(j), reason);
    pthread_mutex_lock(&bus_lock);
    struct session *s = j->session;
    enqueue(s, message, j->handle, notify);
    log_status(j->cmd, result);
    struct job **slot = &s->jobs;
    while (*slot && *slot != j) slot = &(*slot)->next;
    if (*slot) *slot = j->next;
    release_session(s);
    pthread_mutex_unlock(&bus_lock);
    free_job(j);
    return NULL;
}
/* Real query only; no fake GET or placeholder configuration. */
static int query_compass(struct job *j)
{
    if (!json_object_get_boolean(get(j->message, "query"))) return j->http.compass ? 0 : 3;
    CURLcode code = ls_http_query_compass(&j->http, &j->options, 1);
    return code ? 100 + (int)code : j->http.compass ? 0 : 3;
}
static int pin_library(void)
{
    if (library_pin) return 0;
    Dl_info info;
    if (!dladdr((void *)http_json_init, &info) || !info.dli_fname) return ENOENT;
    library_pin = dlopen(info.dli_fname, RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE);
    return library_pin ? 0 : ENOENT;
}
HTTP_RS_API int http_json_init(http_rs_callback callback)
{
    if (!callback) return 3;
    pthread_once(&curl_once, init_curl);
    if (curl_init_result) return 100 + (int)curl_init_result;
    pthread_mutex_lock(&bus_lock);
    if (active) {
        int same = pthread_equal(active->owner, pthread_self()) && active->callback == callback;
        pthread_mutex_unlock(&bus_lock); return same ? 0 : 34;
    }
    if (pin_library()) { pthread_mutex_unlock(&bus_lock); return 2; }
    struct session *s = calloc(1, sizeof *s);
    struct callback_pin *pin = calloc(1, sizeof *pin);
    if (!s || !pin) { free(s); free(pin); pthread_mutex_unlock(&bus_lock); return 127; }
    s->owner = pthread_self(); s->callback = callback; s->references = 1;
    atomic_init(&s->cancelled, 0);
    struct json_object *settings = json_object_new_object();
    if (!settings) { free(pin); free(s); pthread_mutex_unlock(&bus_lock); return 127; }
    json_object_object_add(settings, "verify_mode", json_object_new_int(1));
    int error = ls_http_set_rs(&s->http, settings); json_object_put(settings);
    if (error) { free(pin); free(s); pthread_mutex_unlock(&bus_lock); return 127; }
    pin->callback = callback; pin->next = callback_pins; callback_pins = pin;
    active = s;
    pthread_mutex_unlock(&bus_lock);
    return 0;
}
HTTP_RS_API int http_json_shutdown(void)
{
    pthread_mutex_lock(&bus_lock);
    struct session *s = active;
    if (!s) { pthread_mutex_unlock(&bus_lock); return 0; }
    if (!pthread_equal(s->owner, pthread_self())) { pthread_mutex_unlock(&bus_lock); return 3; }
    active = NULL; atomic_store(&s->cancelled, 1);
    clear_events(s); release_session(s);
    pthread_mutex_unlock(&bus_lock);
    return 0;
}
HTTP_RS_API int HttpWithRsDispatchCallbacks(void)
{
    pthread_mutex_lock(&bus_lock);
    struct session *s = active;
    if (!s) { pthread_mutex_unlock(&bus_lock); return 0; }
    if (!pthread_equal(s->owner, pthread_self())) { pthread_mutex_unlock(&bus_lock); return -EPERM; }
    if (s->dispatching || !s->head) { pthread_mutex_unlock(&bus_lock); return 0; }
    struct event *e = s->head; s->head = e->next; if (!s->head) s->tail = NULL;
    s->dispatching = 1; s->references++;
    http_rs_callback callback = s->callback;
    pthread_mutex_unlock(&bus_lock);
    callback(e->text);
    pthread_mutex_lock(&bus_lock);
    s->dispatching = 0; release_session(s);
    pthread_mutex_unlock(&bus_lock);
    event_free(e);
    return 1;
}
HTTP_RS_API int http_json_call_msg(const char *text)
{
    if (!text) return 3;
    size_t length = strlen(text);
    if (length > INT_MAX - 1) return 3;
    struct json_tokener *tok = json_tokener_new(); if (!tok) return 127;
    json_tokener_set_flags(tok, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *message = json_tokener_parse_ex(tok, text, (int)length + 1);
    int invalid = json_tokener_get_error(tok) != json_tokener_success || !json_object_is_type(message, json_type_object);
    json_tokener_free(tok);
    if (invalid) { json_object_put(message); return 3; }
    int64_t command = integer(message, "cmd", -1);
    pthread_mutex_lock(&bus_lock);
    struct session *s = active;
    if (!s || !pthread_equal(s->owner, pthread_self())) {
        pthread_mutex_unlock(&bus_lock); scrub_json(message); json_object_put(message); return 3;
    }
    int ret = 0;
    if (command == 101) ret = enqueue(s, reply(message, 0, NULL, NULL), 0, 0);
    else if (command == 102) {
        struct json_object *settings = http_rs_clone_json(get(message, "param"));
        int error = !json_object_is_type(settings, json_type_object) || !json_object_is_type(get(settings, "rs_url"), json_type_string);
        const char *rs = string(settings, "rs_url");
        if (!error && *rs && strpbrk(rs, "/@?#\\ \t\r\n")) error = 1;
        if (!error) {
            json_object_object_add(settings, "verify_mode", json_object_new_int(1));
            error = ls_http_set_rs(&s->http, settings);
            if (!error) s->revision++;
        }
        scrub_json(settings); json_object_put(settings);
        ret = enqueue(s, reply(message, error ? 3 : 0, NULL, error ? "rs_url or configuration is invalid" : NULL), 0, 0);
    } else if (command == 106 || command == 108) {
        int64_t handle = integer(get(message, "param"), "handle", -1);
        struct job *match = NULL;
        for (struct job *j = s->jobs; j; j = j->next) {
            if ((command == 106 && j->cmd == 105) || (command == 108 && handle > 0 && j->handle == (uint64_t)handle)) {
                match = j; atomic_store(&j->cancelled, 1);
            }
        }
        /* Idempotent release is the vendor contract, including unknown handles. */
        ret = enqueue(s, reply(message, 0, NULL, !match && command == 108 ? "handle is error" : NULL), 0, 0);
    } else if (command >= 103 && command <= 115) {
        struct job *j = calloc(1, sizeof *j);
        int error = j ? 0 : ENOMEM;
        if (j) {
            j->fd = -1; j->cmd = (int)command; j->session = s; j->revision = s->revision;
            atomic_init(&j->cancelled, 0);
            j->message = message; message = NULL;
            error = copy_context(&j->http, &s->http);
            if (!error) error = setup_job(j);
            if (!error && j->cmd == 105) {
                for (struct job *other = s->jobs; other; other = other->next)
                    if (other->cmd == 105 && !atomic_load(&other->cancelled)) { error = EALREADY; break; }
            }
        }
        if (!error) {
            if (j->upload || j->download || j->cmd == 110) {
                if (next_handle == UINT_MAX) error = EOVERFLOW;
                else j->handle = ++next_handle;
            }
        }
        if (!error) {
            /* Thread starts behind this lock; its result cannot overtake ack. */
            s->references++; j->next = s->jobs; s->jobs = j;
            pthread_attr_t attr; pthread_t worker;
            error = pthread_attr_init(&attr);
            if (!error) {
                error = pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
                if (!error) error = pthread_create(&worker, &attr, run_job, j);
                pthread_attr_destroy(&attr);
            }
            if (error) { s->jobs = j->next; s->references--; }
            else if (j->handle) {
                struct json_object *p = json_object_new_object();
                json_object_object_add(p, "handle", json_object_new_int64(j->handle));
                if (j->download || j->cmd == 111) json_object_object_add(p, "requestId", json_object_new_string(j->request_id));
                if (j->download && j->cmd != 112) json_object_object_add(p, "traceId", json_object_new_string(j->trace_id));
                ret = enqueue(s, reply(j->message, 0, p, "All fine. Proceed as usual."), j->handle, 0);
                if (ret) atomic_store(&j->cancelled, 1);
            }
        }
        if (error) {
            int code = error == EALREADY ? 37 : error == ENOMEM ? 127 : 3;
            ret = enqueue(s, reply(j ? j->message : message, code, NULL,
                error == EALREADY ? "is in downloading, not download again" : strerror(error)), 0, 0);
            if (j) free_job(j);
        }
    } else ret = enqueue(s, reply(message, 3, NULL, "Unknown HTTP JSON command"), 0, 0);
    log_status((int)command, ret);
    pthread_mutex_unlock(&bus_lock);
    scrub_json(message); json_object_put(message);
    return ret ? 127 : 0;
}
HTTP_RS_API int http_json_set_log_param(int level, int module, const char *directory)
{
    if (!directory || !*directory) return 36;
    if (strlen(directory) >= PATH_MAX) return 35;
    char path[PATH_MAX]; strcpy(path, directory);
    for (char *p = path + 1; ; p++) {
        if (*p && *p != '/') continue;
        char save = *p; *p = 0;
        if (mkdir(path, 0700) && errno != EEXIST) return 3;
        *p = save; if (!save) break;
    }
    int dir = open(directory, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (dir < 0) return 3;
    int fd = openat(dir, "http_with_rs.log", O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    close(dir); if (fd < 0) return 3;
    pthread_mutex_lock(&bus_lock);
    if (log_fd >= 0) close(log_fd);
    log_fd = fd; log_level = level >= 0 && level <= 3 ? level : 2; log_module = module;
    pthread_mutex_unlock(&bus_lock);
    return 0;
}
