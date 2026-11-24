/* Native conference authentication and a separately verified WebRTC media host.
 * The observed adapter bus remains distinct from the new web-host protocol.
 * Command 50 succeeds only after the genuine HRTC readiness event is accepted.
 * The callback ABI is void(const char *), verified in hwmService.js and at
 * meeting_adapter.dll 0x10034b02. The callback JSON is borrowed for that call.
 */
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include "native_rpc.h"
#include "meeting_native_token.h"

#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#define JSON_KEY_FLAGS (JSON_C_OBJECT_ADD_KEY_IS_NEW | JSON_C_OBJECT_KEY_IS_CONSTANT)

typedef void (*meeting_callback)(const char *json);

static pthread_mutex_t state_mutex = PTHREAD_MUTEX_INITIALIZER;
/* Only the FFI owner emits JSON. Recursion permits that callback to reset
 * authentication synchronously without retaining state_mutex during JS. */
static pthread_mutex_t publication_mutex = PTHREAD_RECURSIVE_MUTEX_INITIALIZER_NP;
static meeting_native_dispatch_callback dispatch_wake;
static pthread_t dispatch_owner;
struct auth_publication;
static struct auth_publication *pending_auth_publication;
static meeting_callback js_callback;
static struct json_object *auth_config;
static char *cached_token;
static char *cached_refresh_token;
static int cache_expiry_known;
static int64_t cache_deadline;
static int64_t cache_refresh_at;
static int cache_refresh_scheduled;
static uint64_t auth_generation;
static int login_pending;
struct auth_job;
static pthread_cond_t auth_condition;
static struct auth_job *auth_queue_head, *auth_queue_tail;
static struct auth_job *login_job, *refresh_job, *logout_job;
static unsigned auth_pending_count;
static int auth_worker_started;
static FILE *adapter_log;
static int media_ready;
static char media_version[128];
static char media_instance[64];
static int64_t media_sequence = -1;

static void clear_secret(char *value)
{
    if (!value) return;
    size_t length = strlen(value);
    volatile unsigned char *bytes = (volatile unsigned char *)value;
    for (size_t i = 0; i < length; ++i) bytes[i] = 0;
    free(value);
}

/* Caller holds state_mutex. No credential survives an account reset. */
static void clear_auth_cache_locked(void)
{
    clear_secret(cached_token);
    clear_secret(cached_refresh_token);
    cached_token = NULL;
    cached_refresh_token = NULL;
    cache_expiry_known = 0;
    cache_deadline = 0;
    cache_refresh_at = 0;
    cache_refresh_scheduled = 0;
}

static struct json_object *parse_object(const char *text)
{
    if (!text || strlen(text) >= INT_MAX) return NULL;
    struct json_tokener *parser = json_tokener_new();
    if (!parser) return NULL;
    json_tokener_set_flags(parser, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *object = json_tokener_parse_ex(parser, text, (int)strlen(text) + 1);
    enum json_tokener_error error = json_tokener_get_error(parser);
    json_tokener_free(parser);
    if (error != json_tokener_success || !json_object_is_type(object, json_type_object)) {
        json_object_put(object);
        return NULL;
    }
    return object;
}

static int add_value(struct json_object *object, const char *key, struct json_object *value)
{
    if (!value) return -ENOMEM;
    if (json_object_object_add_ex(object, key, value, JSON_KEY_FLAGS)) {
        json_object_put(value);
        return -ENOMEM;
    }
    return 0;
}

static int add_number(struct json_object *object, const char *key, int64_t value)
{
    return add_value(object, key, json_object_new_int64(value));
}

static int add_text(struct json_object *object, const char *key, const char *value)
{
    return add_value(object, key, json_object_new_string(value));
}

static int emit(struct json_object *object)
{
    pthread_mutex_lock(&state_mutex);
    meeting_callback callback = js_callback;
    pthread_mutex_unlock(&state_mutex);
    const char *text = json_object_to_json_string_ext(object, JSON_C_TO_STRING_PLAIN);
    int result = !callback ? -ENODEV : !text ? -ENOMEM : 0;
    if (!result) callback(text);
    json_object_put(object);
    return result;
}

static int acknowledge(const struct native_request *request, const char *description,
                       int64_t result)
{
    struct json_object *reply = json_object_new_object();
    if (!reply) return -ENOMEM;
    int error = add_text(reply, "description", description);
    if (!error) error = add_number(reply, "rsp", request->cmd);
    if (!error) error = add_number(reply, "sno", native_integer(request->root, "sno", 0));
    if (!error) error = add_number(reply, "result", result);
    if (!error) error = json_object_object_add_ex(reply, "notify", NULL, JSON_KEY_FLAGS);
    if (error) {
        json_object_put(reply);
        return error;
    }
    return emit(reply);
}

/* Takes ownership of param, just as the shared native response helper does. */
static int notify(int64_t id, const char *description, int64_t result,
                  struct json_object *param)
{
    struct json_object *reply = json_object_new_object();
    if (!reply) {
        json_object_put(param);
        return -ENOMEM;
    }
    int error = add_text(reply, "description", description);
    if (!error) error = add_number(reply, "notify", id);
    if (!error) error = add_number(reply, "result", result);
    if (!error) error = json_object_object_add_ex(reply, "rsp", NULL, JSON_KEY_FLAGS);
    if (!error && id == 50) error = add_text(reply, "category", "nativewnd");
    if (!error) {
        error = add_value(reply, "param", param);
        param = NULL;
    }
    json_object_put(param);
    if (error) {
        json_object_put(reply);
        return error;
    }
    return emit(reply);
}

static struct json_object *result_param(int64_t result, const char *reason)
{
    struct json_object *param = json_object_new_object();
    if (!param) return NULL;
    if (add_number(param, "reason_code", result) || add_text(param, "reason", reason)) {
        json_object_put(param);
        return NULL;
    }
    return param;
}

static int make_directory(const char *path)
{
    char directory[4096];
    size_t length = strlen(path);
    if (!length || length >= sizeof(directory)) return -EINVAL;
    memcpy(directory, path, length + 1);
    for (char *part = directory + 1; ; ++part) {
        if (*part != '/' && *part) continue;
        char saved = *part;
        *part = 0;
        if (mkdir(directory, 0700) && errno != EEXIST) return -errno;
        if (!saved) break;
        *part = saved;
    }
    return 0;
}

int init_config(const char *json)
{
    struct json_object *config = parse_object(json);
    if (!config) return 6;
    struct json_object *param = native_get(config, "param");
    const char *directory = native_string(param, "nativelogpath", "./adaptorMeetlog/");
    const char *name = native_string(param, "log_name", "meeting_adaptor_trace.log");
    int result = strchr(name, '/') || strchr(name, '\\') ? -EINVAL : make_directory(directory);
    char path[4096];
    if (!result) {
        int length = snprintf(path, sizeof(path), "%s/%s", directory, name);
        if (length < 0 || (size_t)length >= sizeof(path)) result = -ENAMETOOLONG;
    }
    if (!result) {
        FILE *log = fopen(path, "a");
        if (!log) result = -errno;
        else {
            pthread_mutex_lock(&state_mutex);
            if (adapter_log) fclose(adapter_log);
            adapter_log = log;
            fputs("Native workplace authentication adapter; media readiness requires the verified WebRTC host.\n", adapter_log);
            fflush(adapter_log);
            pthread_mutex_unlock(&state_mutex);
        }
    }
    json_object_put(config);
    return result;
}

int set_c2js_callback(meeting_callback callback)
{
    if (!callback) return 6;
    pthread_mutex_lock(&state_mutex);
    js_callback = callback;
    pthread_mutex_unlock(&state_mutex);
    return 2;
}

int meeting_native_auth_set_dispatch_callback(meeting_native_dispatch_callback callback)
{
    if (!callback) return -EINVAL;
    pthread_mutex_lock(&state_mutex);
    int result = 0;
    if (dispatch_wake && (dispatch_wake != callback ||
                          !pthread_equal(dispatch_owner, pthread_self()))) result = -EALREADY;
    else {
        dispatch_wake = callback;
        dispatch_owner = pthread_self();
    }
    pthread_mutex_unlock(&state_mutex);
    return result;
}

static int valid_config(struct json_object *config)
{
    const char *required[] = {"server", "userAgent", "deviceId"};
    const char *optional[] = {"terminalVersion", "terminalAppId", "terminalPlatform",
                             "terminalDeviceModel", "proxyUrl", "proxyUsername",
                             "proxyPassword", "caBundle"};
    for (size_t i = 0; i < sizeof(required) / sizeof(required[0]); ++i) {
        const char *value = native_string(config, required[i], NULL);
        if (!value || !*value || strpbrk(value, "\r\n")) return -EINVAL;
    }
    for (size_t i = 0; i < sizeof(optional) / sizeof(optional[0]); ++i) {
        struct json_object *value = native_get(config, optional[i]);
        if (value && (!json_object_is_type(value, json_type_string) ||
                      strpbrk(json_object_get_string(value), "\r\n"))) return -EINVAL;
    }
    int64_t port = native_integer(config, "port", 0);
    /* Original LoginManager::notifyUsgInfoChange sets isLargeTicket to zero
     * in each path feeding this workplace-ticket flow (0x1009d3f6/4ce/5a5). */
    int64_t long_ticket = native_integer(config, "longTicket", 0);
    return port > 0 && port <= 65535 && (long_ticket == 0 || long_ticket == 1) ? 0 : -EINVAL;
}

int meeting_native_auth_init(const char *json)
{
    struct json_object *config = parse_object(json);
    if (!config) return -EINVAL;
    int status = valid_config(config);
    if (!status) status = meeting_native_token_transport_init();
    if (status) {
        json_object_put(config);
        return status;
    }
    pthread_mutex_lock(&publication_mutex);
    pthread_mutex_lock(&state_mutex);
    if (!dispatch_wake) {
        pthread_mutex_unlock(&state_mutex);
        pthread_mutex_unlock(&publication_mutex);
        json_object_put(config);
        return -ENODEV;
    }
    struct json_object *old_config = auth_config;
    auth_config = config;
    ++auth_generation;
    clear_auth_cache_locked();
    json_object_put(old_config);
    pthread_mutex_unlock(&state_mutex);
    pthread_mutex_unlock(&publication_mutex);
    return 0;
}

void meeting_native_auth_reset(void)
{
    pthread_mutex_lock(&publication_mutex);
    pthread_mutex_lock(&state_mutex);
    ++auth_generation;
    clear_auth_cache_locked();
    pthread_mutex_unlock(&state_mutex);
    pthread_mutex_unlock(&publication_mutex);
}

/* Called only by the app-owned bridge after its real SDK check. This is not a
 * legacy cmd/rsp packet, and a stale window cannot clear a newer host's state. */
int meeting_native_web_state(const char *json)
{
    struct json_object *packet = parse_object(json);
    if (!packet) return -EINVAL;
    const char *protocol = native_string(packet, "protocol", "");
    const char *instance = native_string(packet, "instance", "");
    const char *event = native_string(packet, "event", "");
    const char *version = native_string(packet, "sdkVersion", "");
    int64_t sequence = native_integer(packet, "sequence", -1);
    int ready = strcmp(event, "engine-ready") == 0;
    int status = 0;
    if (strcmp(protocol, "welink-native-web/1") || !*instance || sequence < 0 ||
        strlen(instance) >= sizeof(media_instance) ||
        (!ready && strcmp(event, "engine-unavailable"))) status = -EINVAL;
    if (!status && ready) {
        struct json_object *capabilities = native_get(packet, "capabilities");
        const char *required[] = {"devices", "join", "leave", "audio", "video"};
        if (!*version || strlen(version) >= sizeof(media_version)) status = -EINVAL;
        for (size_t i = 0; !status && i < sizeof(required) / sizeof(required[0]); ++i) {
            struct json_object *value = native_get(capabilities, required[i]);
            if (!json_object_is_type(value, json_type_boolean) || !json_object_get_boolean(value))
                status = -ENOTSUP;
        }
    }
    if (!status) {
        pthread_mutex_lock(&state_mutex);
        if (!ready && *media_instance && strcmp(instance, media_instance)) status = -ESTALE;
        else if (!strcmp(instance, media_instance) && sequence <= media_sequence) status = -ESTALE;
        else {
            media_ready = ready;
            media_sequence = sequence;
            memcpy(media_instance, instance, strlen(instance) + 1);
            if (ready) memcpy(media_version, version, strlen(version) + 1);
            else media_version[0] = 0;
        }
        pthread_mutex_unlock(&state_mutex);
    }
    json_object_put(packet);
    return status;
}

const char *meeting_native_auth_capabilities(void)
{
    static _Thread_local char status[512];
    pthread_mutex_lock(&state_mutex);
    snprintf(status, sizeof(status),
             "{\"authInitialized\":%s,\"loginPending\":%s,\"operationPending\":%s,"
             "\"logoutPending\":%s,\"hasToken\":%s,\"hasRefreshToken\":%s,\"expiryKnown\":%s,"
             "\"ticketExchange\":true,\"tokenRead\":true,\"localReset\":true,"
             "\"tokenRefresh\":true,\"automaticRefresh\":true,\"serverLogout\":true,\"mediaReady\":%s}",
             auth_config ? "true" : "false", login_pending ? "true" : "false",
             auth_pending_count ? "true" : "false", logout_job ? "true" : "false",
             cached_token && *cached_token ? "true" : "false",
             cached_refresh_token && *cached_refresh_token ? "true" : "false",
             cache_expiry_known ? "true" : "false", media_ready ? "true" : "false");
    pthread_mutex_unlock(&state_mutex);
    return status;
}

enum auth_operation { AUTH_LOGIN, AUTH_REFRESH, AUTH_LOGOUT };

struct auth_job {
    struct json_object *config;
    char *account;
    char *ticket;
    uint64_t generation;
    enum auth_operation operation;
    unsigned requests;
    unsigned token_reads;
    unsigned acknowledgements;
    int finishing;
    struct auth_job *next;
};

/* One serialized worker produces one batch at a time. Its stack and response
 * remain alive until the owner drains this slot; no payload is sent in wake. */
struct auth_publication {
    const struct auth_job *job;
    int64_t result;
    const char *reason;
    unsigned requests;
    unsigned token_reads;
    int done;
};

static void release_job(struct auth_job *job)
{
    if (!job) return;
    json_object_put(job->config);
    clear_secret(job->account);
    clear_secret(job->ticket);
    free(job);
}

static void config_parameters(struct json_object *source,
                              struct meeting_native_token_config *destination)
{
    *destination = (struct meeting_native_token_config){
        .server = native_string(source, "server", NULL),
        .port = (unsigned)native_integer(source, "port", 0),
        .user_agent = native_string(source, "userAgent", NULL),
        .device_id = native_string(source, "deviceId", NULL),
        .terminal_version = native_string(source, "terminalVersion", NULL),
        .terminal_appid = native_string(source, "terminalAppId", NULL),
        .terminal_platform = native_string(source, "terminalPlatform", NULL),
        .terminal_device_model = native_string(source, "terminalDeviceModel", NULL),
        .proxy_url = native_string(source, "proxyUrl", NULL),
        .proxy_username = native_string(source, "proxyUsername", NULL),
        .proxy_password = native_string(source, "proxyPassword", NULL),
        .ca_bundle = native_string(source, "caBundle", NULL)
    };
}

static int64_t server_error(struct json_object *response, int64_t fallback)
{
    const char *text = native_string(response, "error_code", NULL);
    if (!text || !*text) return fallback;
    /* tup_login.dll ParseUportalErrorCodeBase: remove USG./MMC., parse decimal,
     * and add the USG base 200000000 when the value is below that base. */
    const char *prefix = strstr(text, "USG.");
    if (!prefix) prefix = strstr(text, "MMC.");
    if (prefix) text = prefix + 4;
    char *end = NULL;
    errno = 0;
    unsigned long value = strtoul(text, &end, 10);
    if (end == text || !value) return 0x189025b0;
    if (errno == ERANGE || value > UINT32_MAX) value = UINT32_MAX;
    return value < 200000000UL ? value + 200000000UL : value;
}

static int64_t monotonic_seconds(void)
{
    struct timespec now;
    return clock_gettime(CLOCK_MONOTONIC, &now) ? -1 : (int64_t)now.tv_sec;
}

struct token_update {
    char *token;
    char *refresh;
    int replace_refresh;
    int expiry_known;
    int64_t deadline;
    int64_t refresh_at;
};

static void clear_update(struct token_update *update)
{
    clear_secret(update->token);
    clear_secret(update->refresh);
    memset(update, 0, sizeof(*update));
}

static int parse_token_update(struct json_object *payload, int new_login,
                              struct token_update *update)
{
    memset(update, 0, sizeof(*update));
    struct json_object *value = native_get(payload, "accessToken");
    if (!json_object_is_type(value, json_type_string)) return -EPROTO;
    const char *token = json_object_get_string(value);
    if (!*token || strlen(token) != (size_t)json_object_get_string_len(value)) return -EPROTO;
    update->token = strdup(token);
    if (!update->token) return -ENOMEM;
    update->replace_refresh = new_login;
    if (json_object_object_get_ex(payload, "refreshToken", &value)) {
        update->replace_refresh = 1;
        if (value && !json_object_is_type(value, json_type_string)) return -EPROTO;
        if (value) {
            const char *refresh = json_object_get_string(value);
            if (strlen(refresh) != (size_t)json_object_get_string_len(value)) return -EPROTO;
            if (*refresh && !(update->refresh = strdup(refresh))) return -ENOMEM;
        }
    }
    /* Vendor USG fields: validPeriod and expireTime are seconds; createTime is
     * milliseconds. Missing or expired lease information cannot authenticate. */
    int64_t ttl = 0;
    value = native_get(payload, "validPeriod");
    if (value) {
        if (!json_object_is_type(value, json_type_int)) return -EPROTO;
        ttl = json_object_get_int64(value);
        update->expiry_known = 1;
    }
    if ((value = native_get(payload, "expireTime")) != NULL) {
        if (!json_object_is_type(value, json_type_int)) return -EPROTO;
        time_t wall_time = time(NULL);
        if (wall_time < 0) return -EIO;
        int64_t expiry = json_object_get_int64(value);
        if (expiry <= (int64_t)wall_time) return -EKEYEXPIRED;
        int64_t absolute_ttl = expiry - (int64_t)wall_time;
        if (!update->expiry_known || absolute_ttl < ttl) ttl = absolute_ttl;
        update->expiry_known = 1;
    }
    if (!update->expiry_known) return -EPROTO;
    if (update->expiry_known) {
        if (ttl <= 0) return -EKEYEXPIRED;
        int64_t now = monotonic_seconds();
        if (now < 0) return -EIO;
        if (ttl > INT64_MAX - now) return -EOVERFLOW;
        update->deadline = now + ttl;
        int64_t margin = ttl / 4;
        if (margin > 60) margin = 60;
        update->refresh_at = update->deadline - margin;
    }
    return 0;
}

/* Caller holds state_mutex. Queue admission cannot establish validity at the
 * later delivery time: the FFI owner may have been blocked past this lease. */
static int token_publication_status_locked(void)
{
    if (!cached_token || !*cached_token) return -ENOTCONN;
    if (!cache_expiry_known) return -EPROTO;
    int64_t now = monotonic_seconds();
    if (now < 0) return -EIO;
    return now >= cache_deadline ? -EKEYEXPIRED : 0;
}

static void publish_token_result(int64_t result, const char *reason, uint64_t generation)
{
    pthread_mutex_lock(&publication_mutex);
    pthread_mutex_lock(&state_mutex);
    if (generation != auth_generation ||
        (logout_job && logout_job->generation == generation)) {
        result = -ECANCELED;
        reason = "Conference authentication state was reset or logged out";
    }
    if (!result && cached_token) {
        result = token_publication_status_locked();
        if (result) reason = "Conference token is no longer valid at delivery";
    }
    struct json_object *param = result_param(result, reason);
    if (param && !result && add_text(param, "token", cached_token ? cached_token : "")) {
        json_object_put(param);
        param = NULL;
    }
    pthread_mutex_unlock(&state_mutex);
    if (param) notify(1001, "OnGetMeetingTokenResult", result, param);
    pthread_mutex_unlock(&publication_mutex);
}

static void publish_auth_result(const struct auth_publication *publication)
{
    const struct auth_job *job = publication->job;
    int64_t result = publication->result;
    const char *reason = publication->reason;
    pthread_mutex_lock(&publication_mutex);
    pthread_mutex_lock(&state_mutex);
    if (job->generation != auth_generation) {
        result = -ECANCELED;
        reason = "Conference authentication state was reset";
    } else if (job->operation == AUTH_LOGIN && logout_job &&
               logout_job->generation == job->generation) {
        result = -ECANCELED;
        reason = "Conference logout was requested during login";
    }
    if (!result && job->operation != AUTH_LOGOUT) {
        result = token_publication_status_locked();
        if (result) reason = "Conference token is no longer valid at delivery";
    }
    pthread_mutex_unlock(&state_mutex);
    int64_t notification = job->operation == AUTH_LOGIN ? 1032 :
                           job->operation == AUTH_REFRESH ? 110 : 1030;
    const char *description = job->operation == AUTH_LOGIN ? "OnLoginByTokenResult" :
                              job->operation == AUTH_REFRESH ? "OnRefreshMeetingTokenResult" : "OnLogoutResult";
    struct json_object *param = result_param(result, reason);
    if (param) notify(notification, description, result, param);
    pthread_mutex_unlock(&publication_mutex);
}

int meeting_native_auth_dispatch(void)
{
    pthread_mutex_lock(&state_mutex);
    int status = !dispatch_wake ? -ENODEV :
                 !pthread_equal(dispatch_owner, pthread_self()) ? -EPERM : 0;
    struct auth_publication *publication = status ? NULL : pending_auth_publication;
    if (publication) pending_auth_publication = NULL;
    pthread_mutex_unlock(&state_mutex);
    if (status || !publication) return status;
    for (unsigned i = 0; i < publication->requests; ++i)
        publish_auth_result(publication);
    for (unsigned i = 0; i < publication->token_reads; ++i)
        publish_token_result(publication->result, publication->reason, publication->job->generation);
    pthread_mutex_lock(&state_mutex);
    publication->done = 1;
    pthread_cond_signal(&auth_condition);
    pthread_mutex_unlock(&state_mutex);
    return 0;
}

/* The worker owns the server-declared renewal deadline. A failed scheduled
 * renewal is reported once; no retry interval or replacement lease is invented.
 * Explicit refresh and token reads can still request another genuine attempt. */
static int begin_refresh_locked(unsigned requests, unsigned token_reads, struct auth_job **accepted);


static void *auth_worker(void *unused)
{
    (void)unused;
    for (;;) {
        pthread_mutex_lock(&state_mutex);
        while (!auth_queue_head) {
            if (!cache_refresh_scheduled) {
                pthread_cond_wait(&auth_condition, &state_mutex);
                continue;
            }
            int64_t now = monotonic_seconds();
            if (now < 0) {
                cache_refresh_scheduled = 0;
                continue;
            }
            if (now >= cache_refresh_at) {
                cache_refresh_scheduled = 0;
                int scheduled = begin_refresh_locked(1, 0, NULL);
                if (scheduled && adapter_log) {
                    fprintf(adapter_log, "Conference automatic refresh could not start: result=%d\n", scheduled);
                    fflush(adapter_log);
                }
                continue;
            }
            struct timespec deadline = {.tv_sec = (time_t)cache_refresh_at, .tv_nsec = 0};
            if ((int64_t)deadline.tv_sec != cache_refresh_at) {
                cache_refresh_scheduled = 0;
                continue;
            }
            pthread_cond_timedwait(&auth_condition, &state_mutex, &deadline);
        }
        struct auth_job *job = auth_queue_head;
        auth_queue_head = job->next;
        if (!auth_queue_head) auth_queue_tail = NULL;
        job->next = NULL;
        pthread_mutex_unlock(&state_mutex);
        pthread_mutex_lock(&publication_mutex);
        pthread_mutex_lock(&state_mutex);
        int status = job->generation == auth_generation ? 0 : -ECANCELED;
        if (!status && job->operation != AUTH_LOGIN) {
            const char *credential = job->operation == AUTH_REFRESH ? cached_refresh_token : cached_token;
            if (!credential || !*credential)
                status = job->operation == AUTH_REFRESH ? -ENOKEY : -ENOTCONN;
            else if (!(job->ticket = strdup(credential))) status = -ENOMEM;
        }
        if (job->operation == AUTH_LOGOUT && job->generation == auth_generation) {
            clear_auth_cache_locked();
            job->generation = ++auth_generation;
        }
        pthread_mutex_unlock(&state_mutex);
        pthread_mutex_unlock(&publication_mutex);

        struct meeting_native_token_config config;
        config_parameters(job->config, &config);
        struct meeting_native_token_reply reply = {0};
        if (!status) {
            if (job->operation == AUTH_LOGIN)
                status = meeting_native_exchange_ticket(&config, job->account, job->ticket,
                             (int)native_integer(job->config, "longTicket", 0), &reply);
            else if (job->operation == AUTH_REFRESH)
                status = meeting_native_refresh_token(&config, job->ticket, &reply);
            else
                status = meeting_native_logout_token(&config, job->ticket, &reply);
        }
        int64_t result = server_error(reply.payload, status);
        struct token_update update = {0};
        if (!result && job->operation != AUTH_LOGOUT)
            result = parse_token_update(reply.payload, job->operation == AUTH_LOGIN, &update);
        const char *reason = result ? native_string(reply.payload, "error_msg",
                                      "Native conference authentication operation failed") : "";
        pthread_mutex_lock(&state_mutex);
        /* Local failures can finish before js2c_sendmsg returns. Never publish
         * a completion before all acknowledgements admitted to this job. */
        while (job->acknowledgements) pthread_cond_wait(&auth_condition, &state_mutex);
        job->finishing = 1;
        pthread_mutex_unlock(&state_mutex);
        pthread_mutex_lock(&publication_mutex);
        pthread_mutex_lock(&state_mutex);
        if (job->generation != auth_generation) {
            result = -ECANCELED;
            reason = "Conference authentication state was reset";
        } else if (!result && job->operation != AUTH_LOGOUT) {
            clear_secret(cached_token);
            cached_token = update.token;
            update.token = NULL;
            if (update.replace_refresh) {
                clear_secret(cached_refresh_token);
                cached_refresh_token = update.refresh;
                update.refresh = NULL;
            }
            cache_expiry_known = update.expiry_known;
            cache_deadline = update.deadline;
            cache_refresh_at = update.refresh_at;
            cache_refresh_scheduled = cache_expiry_known && cached_refresh_token != NULL;
        }
        if (adapter_log && result) {
            fprintf(adapter_log, "Conference auth operation=%d failed: result=%lld http=%ld transport=%d\n",
                    job->operation, (long long)result, reply.http_status, reply.curl_status);
            fflush(adapter_log);
        }
        pthread_mutex_unlock(&state_mutex);
        pthread_mutex_unlock(&publication_mutex);
        clear_update(&update);

        struct auth_publication publication = {
            .job = job, .result = result, .reason = reason,
            .requests = job->requests, .token_reads = job->token_reads
        };
        pthread_mutex_lock(&state_mutex);
        pending_auth_publication = &publication;
        meeting_native_dispatch_callback wake = dispatch_wake;
        pthread_mutex_unlock(&state_mutex);
        /* ffi-napi marshals this no-payload wake to its registering thread.
         * It may synchronously drain and reenter reset there. Hold neither
         * mutex while invoking it or while awaiting that owner's dispatch. */
        wake();
        pthread_mutex_lock(&state_mutex);
        while (!publication.done) pthread_cond_wait(&auth_condition, &state_mutex);
        pthread_mutex_unlock(&state_mutex);
        meeting_native_token_reply_clear(&reply);
        /* Keep every operation pending through all callbacks and secret cleanup.
         * The detached worker/library are process-lifetime objects, not unloadable. */
        pthread_mutex_lock(&state_mutex);
        if (login_job == job) { login_job = NULL; login_pending = 0; }
        if (refresh_job == job) refresh_job = NULL;
        if (logout_job == job) logout_job = NULL;
        release_job(job);
        --auth_pending_count;
        pthread_mutex_unlock(&state_mutex);
    }
    return NULL;
}

/* state_mutex is held by the enqueueing caller. */
static int ensure_auth_worker_locked(void)
{
    if (auth_worker_started) return 0;
    pthread_condattr_t condition_attributes;
    int error = pthread_condattr_init(&condition_attributes);
    if (error) return -error;
    error = pthread_condattr_setclock(&condition_attributes, CLOCK_MONOTONIC);
    if (!error) error = pthread_cond_init(&auth_condition, &condition_attributes);
    pthread_condattr_destroy(&condition_attributes);
    if (error) return -error;
    pthread_attr_t attributes;
    error = pthread_attr_init(&attributes);
    if (!error) {
        error = pthread_attr_setdetachstate(&attributes, PTHREAD_CREATE_DETACHED);
        if (!error) {
            pthread_t thread;
            error = pthread_create(&thread, &attributes, auth_worker, NULL);
        }
        pthread_attr_destroy(&attributes);
    }
    if (error) {
        pthread_cond_destroy(&auth_condition);
        return -error;
    }
    auth_worker_started = 1;
    return 0;
}

static void enqueue_auth_locked(struct auth_job *job)
{
    job->config = json_object_get(auth_config);
    if (auth_queue_tail) auth_queue_tail->next = job;
    else auth_queue_head = job;
    auth_queue_tail = job;
    ++auth_pending_count;
    pthread_cond_signal(&auth_condition);
}

static void complete_acknowledgement(struct auth_job *job)
{
    if (!job) return;
    pthread_mutex_lock(&state_mutex);
    --job->acknowledgements;
    pthread_cond_signal(&auth_condition);
    pthread_mutex_unlock(&state_mutex);
}

static int begin_refresh_locked(unsigned requests, unsigned token_reads, struct auth_job **accepted)
{
    if (!auth_config) return -ENODEV;
    if (logout_job) return -ENOTCONN;
    if (refresh_job && refresh_job->generation == auth_generation) {
        if (refresh_job->finishing) return -EBUSY;
        if (refresh_job->requests > UINT_MAX - requests ||
            refresh_job->token_reads > UINT_MAX - token_reads ||
            (accepted && refresh_job->acknowledgements == UINT_MAX)) return -EOVERFLOW;
        refresh_job->requests += requests;
        refresh_job->token_reads += token_reads;
        if (accepted) {
            ++refresh_job->acknowledgements;
            *accepted = refresh_job;
        }
        return 0;
    }
    if (auth_pending_count) return -EBUSY;
    if (!cached_refresh_token || !*cached_refresh_token) return -ENOKEY;
    struct auth_job *job = calloc(1, sizeof(*job));
    if (!job) return -ENOMEM;
    int error = ensure_auth_worker_locked();
    if (error) { free(job); return error; }
    job->operation = AUTH_REFRESH;
    job->generation = auth_generation;
    job->requests = requests;
    job->token_reads = token_reads;
    if (accepted) {
        job->acknowledgements = 1;
        *accepted = job;
    }
    refresh_job = job;
    enqueue_auth_locked(job);
    return 0;
}

static int begin_refresh(struct auth_job **accepted)
{
    pthread_mutex_lock(&state_mutex);
    int error = begin_refresh_locked(1, 0, accepted);
    pthread_mutex_unlock(&state_mutex);
    return error;
}

static int begin_logout(struct auth_job **accepted)
{
    pthread_mutex_lock(&publication_mutex);
    pthread_mutex_lock(&state_mutex);
    int error = !auth_config ? -ENODEV : 0;
    if (!error && logout_job) {
        if (logout_job->generation != auth_generation || logout_job->finishing) error = -EBUSY;
        else if (logout_job->requests == UINT_MAX || logout_job->acknowledgements == UINT_MAX) error = -EOVERFLOW;
        else {
            ++logout_job->requests;
            ++logout_job->acknowledgements;
            *accepted = logout_job;
        }
        pthread_mutex_unlock(&state_mutex);
        pthread_mutex_unlock(&publication_mutex);
        return error;
    }
    if (!error && (!cached_token || !*cached_token) &&
        !(login_job && login_job->generation == auth_generation)) error = -ENOTCONN;
    struct auth_job *job = error ? NULL : calloc(1, sizeof(*job));
    if (!error && !job) error = -ENOMEM;
    if (!error) error = ensure_auth_worker_locked();
    if (!error) {
        job->operation = AUTH_LOGOUT;
        job->generation = auth_generation;
        job->requests = 1;
        job->acknowledgements = 1;
        *accepted = job;
        logout_job = job;
        enqueue_auth_locked(job);
    }
    pthread_mutex_unlock(&state_mutex);
    pthread_mutex_unlock(&publication_mutex);
    if (error) release_job(job);
    return error;
}

static int begin_login(const struct native_request *request, struct auth_job **accepted)
{
    const char *account = native_string(request->param, "username", NULL);
    const char *ticket = native_string(request->param, "middleGroundToken", NULL);
    if (!account || !*account || !ticket || !*ticket) return -EINVAL;
    pthread_mutex_lock(&publication_mutex);
    pthread_mutex_lock(&state_mutex);
    int error = !auth_config ? -ENODEV : auth_pending_count ? -EBUSY : 0;
    struct auth_job *job = error ? NULL : calloc(1, sizeof(*job));
    if (!error && !job) error = -ENOMEM;
    if (!error) {
        job->account = strdup(account);
        job->ticket = strdup(ticket);
        if (!job->account || !job->ticket) error = -ENOMEM;
    }
    if (!error) error = ensure_auth_worker_locked();
    if (!error) {
        job->operation = AUTH_LOGIN;
        job->generation = ++auth_generation;
        job->requests = 1;
        job->acknowledgements = 1;
        *accepted = job;
        clear_auth_cache_locked();
        login_pending = 1;
        login_job = job;
        enqueue_auth_locked(job);
    }
    pthread_mutex_unlock(&state_mutex);
    pthread_mutex_unlock(&publication_mutex);
    if (error) release_job(job);
    return error;
}

static int read_token_request(const struct native_request *request)
{
    struct auth_job *accepted = NULL;
    pthread_mutex_lock(&state_mutex);
    uint64_t generation = auth_generation;
    int result = auth_config ? 0 : 6;
    int deferred = 0;
    if (!result && logout_job) result = -ENOTCONN;
    if (!result && refresh_job && !refresh_job->finishing &&
        refresh_job->generation == auth_generation) {
        result = begin_refresh_locked(0, 1, &accepted);
        deferred = !result;
    } else if (!result && cached_token && cache_expiry_known) {
        int64_t now = monotonic_seconds();
        if (now < 0) result = -EIO;
        else if (now >= cache_refresh_at && cached_refresh_token) {
            result = begin_refresh_locked(0, 1, &accepted);
            deferred = !result;
        } else if (now >= cache_deadline) result = -EKEYEXPIRED;
    }
    pthread_mutex_unlock(&state_mutex);
    acknowledge(request, "GetMeetingToken", result);
    complete_acknowledgement(accepted);
    if (!result && !deferred) publish_token_result(0, "", generation);
    return result;
}

int js2c_sendmsg(const char *json)
{
    pthread_mutex_lock(&state_mutex);
    int has_callback = js_callback != NULL;
    int dispatch_status = !dispatch_wake ? -ENODEV :
                          !pthread_equal(dispatch_owner, pthread_self()) ? -EPERM : 0;
    pthread_mutex_unlock(&state_mutex);
    if (!has_callback) return 6;
    if (dispatch_status) return dispatch_status;
    struct native_request request;
    if (native_parse(&request, json)) return 6;
    int result;
    struct auth_job *accepted = NULL;
    if (request.cmd == 1032) {
        result = begin_login(&request, &accepted);
        acknowledge(&request, "loginLogicAuthorize", result);
    } else if (request.cmd == 110) {
        /* Original adapter registration 0x100187ee and callback 0x1003de19. */
        result = begin_refresh(&accepted);
        acknowledge(&request, "RefreshMeetingToken", result);
    } else if (request.cmd == 1030) {
        result = begin_logout(&accepted);
        acknowledge(&request, "Logout", result);
    } else if (request.cmd == 50) {
        char version[sizeof(media_version)];
        pthread_mutex_lock(&state_mutex);
        result = media_ready ? 0 : -ENODEV;
        memcpy(version, media_version, sizeof(version));
        pthread_mutex_unlock(&state_mutex);
        acknowledge(&request, "InitConfSdkParam", result);
        if (!result) {
            struct json_object *param = result_param(0, "");
            if (param) {
                if (!add_text(param, "version", version))
                    notify(50, "InitConfSdkParam", 0, param);
                else json_object_put(param);
            }
        }
    } else if (request.cmd == 1001) {
        result = read_token_request(&request);
    } else {
        /* Media control uses the explicit native-WebRTC RPC, not forged legacy
         * responses for operations whose complete DLL schema is different. */
        result = -ENOSYS;
        const char *description = native_string(request.root, "description", "UnsupportedConferenceCommand");
        acknowledge(&request, description, result);
    }
    complete_acknowledgement(accepted);
    native_release(&request);
    return result;
}
