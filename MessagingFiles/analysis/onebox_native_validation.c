/* Parent-only ia32 Onebox validation driver. No production headers or adapters.
 * Build (JSON_C_PREFIX MUST be the supplied private ia32 json-c 0.19 install):
 * cc -m32 -std=c11 -O2 -Wall -Wextra -Werror -pthread \
 *   -I"$JSON_C_PREFIX/include" analysis/onebox_native_validation.c \
 *   "$JSON_C_PREFIX/lib/libjson-c.a" -ldl -lm -o "$HELPER"
 * The Python fixture supplies a private log directory and JSON-lines controls.
 * stdout is JSON-lines evidence; callback.raw preserves the exact SDK frame.
 * Never dlclose: the public shutdown API intentionally leaves cleanup to workers.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <inttypes.h>
#include <json-c/json.h>
#include <link.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#if !defined(__i386__)
#error Build this helper with -m32 for the native SDK ia32 ABI
#endif
#if JSON_C_MAJOR_VERSION != 0 || JSON_C_MINOR_VERSION != 19
#error Use the supplied private static json-c 0.19 headers and archive
#endif

typedef int (*callback_fn)(const char *);
static int (*initialize)(const char *, callback_fn);
static void (*send_message)(const char *);
static int (*dispatch)(void);
static void (*shutdown_service)(void);
static pthread_t owner;
static pthread_mutex_t output_mutex = PTHREAD_MUTEX_INITIALIZER;
static atomic_uint callbacks, violations;
static atomic_int in_pump, stopped = 1;
static unsigned epoch;
static _Thread_local unsigned depth;
static struct json_object *armed;
static const char *log_directory;

static struct json_object *member(struct json_object *o, const char *key)
{
    struct json_object *v = NULL;
    if (json_object_is_type(o, json_type_object)) json_object_object_get_ex(o, key, &v);
    return v;
}

static int64_t integer(struct json_object *o, const char *key, int64_t missing)
{
    struct json_object *v = member(o, key);
    return json_object_is_type(v, json_type_int) ? json_object_get_int64(v) : missing;
}

static void number(struct json_object *o, const char *key, int64_t v)
{
    json_object_object_add(o, key, json_object_new_int64(v));
}

static void string(struct json_object *o, const char *key, const char *v)
{
    json_object_object_add(o, key, json_object_new_string(v));
}

static struct json_object *event(const char *type)
{
    struct json_object *o = json_object_new_object();
    string(o, "type", type);
    return o;
}

static void emit(struct json_object *o)
{
    pthread_mutex_lock(&output_mutex);
    puts(json_object_to_json_string_ext(o, JSON_C_TO_STRING_PLAIN));
    fflush(stdout);
    pthread_mutex_unlock(&output_mutex);
    json_object_put(o);
}

static int64_t now_ns(void)
{
    struct timespec ts;
    if (clock_gettime(CLOCK_MONOTONIC, &ts)) _exit(70);
    return (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec;
}

static struct json_object *parse(const char *text)
{
    size_t n = strlen(text);
    if (n >= INT32_MAX) return NULL;
    struct json_tokener *p = json_tokener_new();
    if (!p) return NULL;
    json_tokener_set_flags(p, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *o = json_tokener_parse_ex(p, text, (int)n + 1);
    if (json_tokener_get_error(p) != json_tokener_success || !json_object_is_type(o, json_type_object)) {
        json_object_put(o);
        o = NULL;
    }
    json_tokener_free(p);
    return o;
}

static int matches(struct json_object *frame)
{
    struct json_object *match = member(armed, "match");
    if (!match || !json_object_object_length(match)) return 0;
    json_object_object_foreach(match, key, expected) {
        struct json_object *actual = member(!strcmp(key, "file_handle") ? member(frame, "param") : frame, key);
        if (!actual || !json_object_equal(actual, expected)) return 0;
    }
    return 1;
}

static int callback(const char *text)
{
    int is_owner = pthread_equal(owner, pthread_self());
    unsigned index = atomic_fetch_add(&callbacks, 1) + 1;
    ++depth;
    int pumping = atomic_load(&in_pump), after_shutdown = atomic_load(&stopped);
    if (!is_owner || !pumping || after_shutdown || depth != 1) atomic_fetch_add(&violations, 1);
    struct json_object *o = event("callback");
    number(o, "index", index);
    number(o, "owner", is_owner);
    number(o, "pumping", pumping);
    number(o, "after_shutdown", after_shutdown);
    number(o, "depth", depth);
    /* epoch is owner-only; a broken worker callback never reads this field. */
    number(o, "epoch", is_owner ? (int64_t)epoch : -1);
    string(o, "raw", text ? text : "");
    emit(o);
    if (is_owner && pumping && !after_shutdown && depth == 1 && armed && text) {
        struct json_object *frame = parse(text);
        if (frame && matches(frame)) {
            struct json_object *action = armed;
            armed = NULL; /* Nested callbacks must never repeat the action. */
            o = event("action");
            number(o, "callback_index", index);
            if (json_object_get_boolean(member(action, "nested"))) {
                unsigned before = atomic_load(&callbacks);
                int64_t start = now_ns();
                int rc = dispatch();
                number(o, "nested_ns", now_ns() - start);
                number(o, "nested_rc", rc);
                number(o, "nested_callbacks", atomic_load(&callbacks) - before);
                if (rc != 0 || atomic_load(&callbacks) != before) atomic_fetch_add(&violations, 1);
            }
            int64_t release_sno = integer(action, "release_sno", 0);
            if (release_sno) {
                struct json_object *param = member(frame, "param");
                int64_t handle = integer(param, "file_handle", integer(param, "pcfile_handle", integer(param, "pfile_handle", 0)));
                char request[256];
                snprintf(request, sizeof request,
                    "{\"cmd\":589834,\"sno\":%" PRId64 ",\"description\":\"tup_offlinefile_releasefile\",\"param\":{\"file_handle\":%" PRId64 "}}",
                    release_sno, handle);
                int64_t start = now_ns();
                send_message(request);
                number(o, "release_ns", now_ns() - start);
                number(o, "release_handle", handle);
                number(o, "release_sno", release_sno);
                string(o, "release_request", request);
                if (handle <= 0) atomic_fetch_add(&violations, 1);
            }
            if (json_object_get_boolean(member(action, "shutdown"))) {
                atomic_store(&stopped, 1);
                int64_t start = now_ns();
                shutdown_service();
                number(o, "shutdown_ns", now_ns() - start);
                number(o, "shutdown_callback_count", atomic_load(&callbacks));
            }
            emit(o);
            json_object_put(action);
        }
        json_object_put(frame);
    }
    --depth;
    return 0;
}

static void *wrong_thread(void *argument)
{
    *(int *)argument = dispatch();
    return NULL;
}

static int reject_shared_json(struct dl_phdr_info *info, size_t size, void *unused)
{
    (void)size; (void)unused;
    const char *base = strrchr(info->dlpi_name, '/');
    base = base ? base + 1 : info->dlpi_name;
    return !strncmp(base, "libjson-c.so", 12);
}

static int load_api(const char *path)
{
    void *library = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!library) { fprintf(stderr, "dlopen: %s\n", dlerror()); return -1; }
#define LOAD(variable, symbol) do { \
    void *address = dlsym(library, symbol); \
    if (!address) { fprintf(stderr, "missing %s\n", symbol); return -1; } \
    _Static_assert(sizeof variable == sizeof address, "function pointer ABI"); \
    memcpy(&variable, &address, sizeof address); \
} while (0)
    LOAD(initialize, "OfflineFileInitService");
    LOAD(send_message, "OfflineFileSendMsg");
    LOAD(dispatch, "OfflineFileDispatchCallbacks");
    LOAD(shutdown_service, "OfflineFileShutdown");
#undef LOAD
    if (dl_iterate_phdr(reject_shared_json, NULL)) {
        fputs("shared json-c loaded; the SDK and helper require private static 0.19\n", stderr);
        return -1;
    }
    const char *(*sdk_version)(void) = NULL;
    void *address = dlsym(library, "json_c_version");
    if (address) memcpy(&sdk_version, &address, sizeof address);
    if (strcmp(json_c_version(), "0.19") || (sdk_version && strcmp(sdk_version(), "0.19"))) {
        fputs("JSON-C version is not the supplied 0.19\n", stderr);
        return -1;
    }
    struct json_object *o = event("ready");
    number(o, "pointer_bits", sizeof(void *) * 8);
    string(o, "json_c", json_c_version());
    string(o, "sdk_json_c", sdk_version ? sdk_version() : "hidden-static-symbol");
    emit(o);
    return 0;
}

int main(int argc, char **argv)
{
    if (argc != 3) { fprintf(stderr, "usage: %s native-sdk.so private-log-directory\n", argv[0]); return 64; }
    owner = pthread_self();
    log_directory = argv[2];
    if (load_api(argv[1])) return 65;
    char *line = NULL;
    size_t capacity = 0;
    int exit_code = 0;
    while (getline(&line, &capacity, stdin) >= 0) {
        struct json_object *control = parse(line);
        struct json_object *operation = member(control, "op");
        if (!json_object_is_type(operation, json_type_string)) { json_object_put(control); exit_code = 64; break; }
        const char *op = json_object_get_string(operation);
        int rc = 0, quit = 0;
        int64_t start = now_ns();
        if (!strcmp(op, "init")) {
            rc = initialize(log_directory, callback);
            if (!rc) { ++epoch; atomic_store(&stopped, 0); }
        } else if (!strcmp(op, "send")) {
            struct json_object *request = member(control, "request");
            if (!json_object_is_type(request, json_type_object)) rc = -EINVAL;
            else send_message(json_object_to_json_string_ext(request, JSON_C_TO_STRING_PLAIN));
        } else if (!strcmp(op, "pump")) {
            atomic_store(&in_pump, 1);
            rc = dispatch();
            atomic_store(&in_pump, 0);
        } else if (!strcmp(op, "wrong_pump")) {
            pthread_t thread;
            int error = pthread_create(&thread, NULL, wrong_thread, &rc);
            if (error) rc = -error;
            else if ((error = pthread_join(thread, NULL))) rc = -error;
        } else if (!strcmp(op, "observe")) {
            int64_t ms = integer(control, "milliseconds", 0);
            if (ms < 0 || ms > 2000) rc = -EINVAL;
            else {
                struct timespec pause = {.tv_sec = ms / 1000, .tv_nsec = (ms % 1000) * 1000000};
                while (nanosleep(&pause, &pause) && errno == EINTR) {}
            }
        } else if (!strcmp(op, "arm")) {
            struct json_object *match = member(control, "match");
            if (!json_object_is_type(match, json_type_object) || !json_object_object_length(match)) rc = -EINVAL;
            else { json_object_put(armed); armed = json_object_get(control); }
        } else if (!strcmp(op, "shutdown") || !strcmp(op, "exit")) {
            atomic_store(&stopped, 1);
            shutdown_service();
            quit = !strcmp(op, "exit");
        } else rc = -EINVAL;
        struct json_object *o = event("control");
        number(o, "id", integer(control, "id", -1));
        string(o, "op", op);
        number(o, "rc", rc);
        number(o, "elapsed_ns", now_ns() - start);
        number(o, "callbacks", atomic_load(&callbacks));
        number(o, "violations", atomic_load(&violations));
        number(o, "epoch", epoch);
        emit(o);
        json_object_put(control);
        if (quit) break;
    }
    atomic_store(&stopped, 1);
    shutdown_service();
    json_object_put(armed);
    free(line);
    return exit_code ? exit_code : atomic_load(&violations) ? 66 : 0;
}
