/* Used vendor ABI; all database work is exec-isolated from Electron's private
 * SQLite copies. No vendor PE is loaded and no BlueEncrypt/GetBlueDbKey aliases
 * are exported. The DSO and FFI callbacks are process-pinned. */
#define _GNU_SOURCE
#include "db_import_export_tools.h"
#include "ie_protocol.h"
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <json-c/json.h>
#include <limits.h>
#include <openssl/crypto.h>
#include <openssl/sha.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <spawn.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define EVENT_COUNT 32
struct event { uint64_t generation, operation; int progress; char text[IE_EVENT_LIMIT]; };
struct host_job { uint64_t generation, operation; atomic_int cancelled; char *input; size_t length; };
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static pthread_t owner;
static int has_owner, dispatching;
static import_export_callback callback;
static void *library_pin;
static char *worker_path;
static char *runtime_environment;
static uint64_t generation, operation;
static struct host_job *active;
static struct event events[EVENT_COUNT];
static unsigned head, count;

static void enqueue_locked(struct host_job *job, const char *text, int progress)
{
    if (!callback || generation != job->generation || operation != job->operation) return;
    unsigned tail = (head + count) % EVENT_COUNT;
    if (progress && count && events[(tail + EVENT_COUNT - 1) % EVENT_COUNT].progress)
        tail = (tail + EVENT_COUNT - 1) % EVENT_COUNT;
    else {
        if (count == EVENT_COUNT) return; /* Only 100 coalesced progress steps and <12 phases. */
        ++count;
    }
    events[tail].generation = job->generation;
    events[tail].operation = job->operation;
    events[tail].progress = progress;
    memcpy(events[tail].text, text, strlen(text) + 1);
}
static int event_kind(const char *text, int *progress, int *terminal, int *failure)
{
    struct json_object *root = json_tokener_parse(text), *kind = NULL, *param = NULL, *value = NULL;
    int valid = json_object_is_type(root, json_type_object) &&
        json_object_object_get_ex(root, "resType", &kind) && json_object_is_type(kind, json_type_int) &&
        json_object_object_get_ex(root, "param", &param) && json_object_is_type(param, json_type_object);
    *progress = *terminal = *failure = 0;
    if (valid) {
        int type = json_object_get_int(kind);
        valid = type >= 0 && type <= 2;
        *progress = type == 2;
        *failure = type == 1;
        if (type == 0) {
            valid = json_object_object_get_ex(param, "status", &value) && json_object_is_type(value, json_type_int);
            if (valid) {
                int status = json_object_get_int(value);
                valid = status >= 0 && status <= 8;
                *terminal = status == 4 || status == 5 || status == 6;
            }
        }
    }
    json_object_put(root);
    return valid;
}
static void process_failure(struct host_job *job)
{
    struct json_object *request = json_tokener_parse(job->input), *type_value = NULL;
    int type = 0;
    if (json_object_is_type(request, json_type_object) &&
        json_object_object_get_ex(request, "operationType", &type_value) && json_object_is_type(type_value, json_type_int))
        type = json_object_get_int(type_value);
    json_object_put(request);
    struct json_object *root = json_object_new_object(), *param = json_object_new_object();
    json_object_object_add(root, "resType", json_object_new_int(1));
    json_object_object_add(param, "errorCode", json_object_new_int(12));
    json_object_object_add(param, "errorMsg", json_object_new_string("native import/export worker failed"));
    json_object_object_add(param, "imExType", json_object_new_int(type));
    json_object_object_add(root, "param", param);
    pthread_mutex_lock(&lock);
    if (active == job) active = NULL;
    enqueue_locked(job, json_object_to_json_string_ext(root, JSON_C_TO_STRING_PLAIN), 0);
    json_object_object_add(root, "resType", json_object_new_int(0));
    json_object_object_del(param, "errorMsg");
    json_object_object_add(param, "status", json_object_new_int(5));
    enqueue_locked(job, json_object_to_json_string_ext(root, JSON_C_TO_STRING_PLAIN), 0);
    pthread_mutex_unlock(&lock);
    json_object_put(root);
}
static int lift_fd(int fd)
{
    if (fd < 0) return -1;
    int result = fcntl(fd, F_DUPFD_CLOEXEC, 10);
    int error = errno; close(fd); errno = error; return result;
}
/* Match the launcher/main/supervisor gate, outside the renamed profile tree.
 * Workers retain their own shared description until exit, including COMMITTING. */
static int profile_gate(int *result, char *environment, size_t capacity)
{
    *result = -1;
    environment[0] = 0;
    const char *profile = getenv("WELINK_NATIVE_PROFILE_DIR");
    if (!profile || !*profile) return 0; /* Standalone non-profile ABI callers. */
    char canonical[PATH_MAX], directory[PATH_MAX];
    if (!realpath(profile, canonical)) return errno;
    if (strcmp(profile, canonical) || !canonical[1]) return EINVAL;
    int length = snprintf(environment, capacity, "WELINK_NATIVE_PROFILE_DIR=%s", canonical);
    if (length < 0 || (size_t)length >= capacity) return ENAMETOOLONG;
    const char *slash = strrchr(canonical, '/');
    length = snprintf(directory, sizeof directory, "%.*s/.welink-native-profile-gates", (int)(slash - canonical), canonical);
    if (length < 0 || (size_t)length >= sizeof directory) return ENAMETOOLONG;
    unsigned char hash[SHA256_DIGEST_LENGTH];
    if (!SHA256((const unsigned char *)canonical, strlen(canonical), hash)) return EIO;
    static const char hex[] = "0123456789abcdef";
    char name[SHA256_DIGEST_LENGTH * 2 + sizeof ".lock"];
    for (unsigned i = 0; i < sizeof hash; ++i) {
        name[i * 2] = hex[hash[i] >> 4];
        name[i * 2 + 1] = hex[hash[i] & 15];
    }
    memcpy(name + sizeof hash * 2, ".lock", sizeof ".lock");
    int parent = open(directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent < 0) return errno;
    struct stat dir_info, info, named;
    int error = fstat(parent, &dir_info) ? errno : 0;
    if (!error && (dir_info.st_uid != getuid() || (dir_info.st_mode & 07777) != 0700)) error = EPERM;
    int gate = -1;
    if (!error) {
        gate = lift_fd(openat(parent, name, O_RDWR | O_NOFOLLOW | O_CLOEXEC));
        if (gate < 0) error = errno;
    }
    if (!error && fstat(gate, &info)) error = errno;
    if (!error && (!S_ISREG(info.st_mode) || info.st_uid != getuid() || info.st_nlink != 1 ||
                   (info.st_mode & 07777) != 0600)) error = EPERM;
    if (!error && flock(gate, LOCK_SH | LOCK_NB)) error = errno;
    if (!error && fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW)) error = errno;
    if (!error && (named.st_dev != info.st_dev || named.st_ino != info.st_ino)) error = ESTALE;
    close(parent);
    if (error) { if (gate >= 0) close(gate); return error; }
    *result = gate;
    return 0;
}
static int make_pipe(int descriptors[2])
{
    int pair[2];
    if (pipe2(pair, O_CLOEXEC)) return errno;
    descriptors[0] = lift_fd(pair[0]); descriptors[1] = lift_fd(pair[1]);
    return descriptors[0] < 0 || descriptors[1] < 0 ? errno : 0;
}
static int nonblocking(int fd)
{
    int flags = fcntl(fd, F_GETFL);
    return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) ? errno : 0;
}
static int spawn_worker(pid_t *pid, int request, int control, int event)
{
    /* The only executable accepted is this fixed, nonsymlink sibling of the
     * real loaded DSO. No PATH lookup, configurable helper, loader injection,
     * or user request in argv/environment. */
    int helper = open(worker_path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    struct stat info;
    int error = helper < 0 ? errno : fstat(helper, &info) ? errno : 0;
    if (!error && (!S_ISREG(info.st_mode) || !(info.st_mode & 0111) || (info.st_mode & 0022))) error = EPERM;
    if (helper >= 0) close(helper);
    if (error) return error;
    int gate = -1;
    char profile_environment[PATH_MAX + sizeof "WELINK_NATIVE_PROFILE_DIR="];
    error = profile_gate(&gate, profile_environment, sizeof profile_environment);
    if (error) return error;
    posix_spawn_file_actions_t actions;
    error = posix_spawn_file_actions_init(&actions);
    if (error) { if (gate >= 0) close(gate); return error; }
    if (!error) error = posix_spawn_file_actions_adddup2(&actions, request, IE_REQUEST_FD);
    if (!error) error = posix_spawn_file_actions_adddup2(&actions, control, IE_CONTROL_FD);
    if (!error) error = posix_spawn_file_actions_adddup2(&actions, event, IE_EVENT_FD);
    for (int fd = 0; !error && fd < 3; ++fd)
        error = posix_spawn_file_actions_addopen(&actions, fd, "/dev/null", fd ? O_WRONLY : O_RDONLY, 0);
    if (!error && gate >= 0) error = posix_spawn_file_actions_adddup2(&actions, gate, IE_PROFILE_GATE_FD);
    if (!error) error = posix_spawn_file_actions_addclosefrom_np(&actions, gate >= 0 ? IE_PROFILE_GATE_FD + 1 : IE_PROFILE_GATE_FD);
    posix_spawnattr_t attr;
    int attr_ready = !posix_spawnattr_init(&attr);
    if (!attr_ready && !error) error = ENOMEM;
    sigset_t empty, defaults; sigemptyset(&empty); sigemptyset(&defaults);
    sigaddset(&defaults, SIGPIPE); sigaddset(&defaults, SIGTERM); sigaddset(&defaults, SIGINT);
    if (!error) error = posix_spawnattr_setsigmask(&attr, &empty);
    if (!error) error = posix_spawnattr_setsigdefault(&attr, &defaults);
    if (!error) error = posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);
    char *argv[] = { worker_path, IE_WORKER_ARGUMENT, NULL };
    char *environment[] = { "LANG=C.UTF-8", "LC_ALL=C.UTF-8", runtime_environment,
                            profile_environment[0] ? profile_environment : NULL, NULL };
    if (!error) error = posix_spawn(pid, worker_path, &actions, &attr, argv, environment);
    if (attr_ready) posix_spawnattr_destroy(&attr);
    posix_spawn_file_actions_destroy(&actions);
    if (gate >= 0) close(gate);
    return error;
}
static void *run_process(void *pointer)
{
    struct host_job *job = pointer;
    int request[2] = {-1,-1}, event[2] = {-1,-1}, control[2] = {-1,-1};
    int error = make_pipe(request);
    if (!error) error = make_pipe(event);
    if (!error) {
        int pair[2];
        if (socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, pair)) error = errno;
        else {
            control[0] = lift_fd(pair[0]); control[1] = lift_fd(pair[1]);
            if (control[0] < 0 || control[1] < 0) error = errno;
        }
    }
    if (!error) error = nonblocking(request[1]);
    if (!error) error = nonblocking(event[0]);
    if (!error) error = nonblocking(control[0]);
    pid_t child = -1;
    if (!error) error = spawn_worker(&child, request[0], control[1], event[1]);
    if (request[0] >= 0) { close(request[0]); request[0] = -1; }
    if (control[1] >= 0) { close(control[1]); control[1] = -1; }
    if (event[1] >= 0) { close(event[1]); event[1] = -1; }
    char terminal[IE_EVENT_LIMIT] = {0}, failure[IE_EVENT_LIMIT] = {0};
    unsigned char header[8] = {'W','I','E','1'}, incoming[IE_EVENT_LIMIT + 4];
    ie_store_u32(header + 4, (uint32_t)job->length);
    size_t sent = 0, have = 0;
    int cancel_sent = 0, child_status = 0, exited = 0, eof = 0;
    /* Block SIGPIPE only in this detached transport thread. Socket cancellation
     * uses MSG_NOSIGNAL; a failed request-pipe write must not terminate Electron. */
    sigset_t blocked; sigemptyset(&blocked); sigaddset(&blocked, SIGPIPE);
    pthread_sigmask(SIG_BLOCK, &blocked, NULL);
    while (child > 0 && (!exited || !eof)) {
        if (!cancel_sent && (atomic_load(&job->cancelled) || error)) {
            ssize_t n = send(control[0], "C", 1, MSG_NOSIGNAL);
            if (n == 1) cancel_sent = 1;
            else if (n < 0 && errno != EAGAIN && errno != EINTR) cancel_sent = 1;
        }
        if (request[1] >= 0) {
            const void *bytes = sent < sizeof header ? (const void *)(header + sent) : (const void *)(job->input + sent - sizeof header);
            size_t length = sent < sizeof header ? sizeof header - sent : job->length + sizeof header - sent;
            if (!length) { close(request[1]); request[1] = -1; }
            else {
                ssize_t n = write(request[1], bytes, length);
                if (n > 0) sent += (size_t)n;
                else if (n < 0 && errno != EAGAIN && errno != EINTR) { error = errno; close(request[1]); request[1] = -1; }
            }
        }
        if (!eof) {
            ssize_t n = read(event[0], incoming + have, sizeof incoming - have);
            if (n == 0) { eof = 1; if (have) error = EPROTO; }
            else if (n < 0 && errno != EAGAIN && errno != EINTR) { error = errno; eof = 1; }
            else if (n > 0) {
                have += (size_t)n;
                while (have >= 4) {
                    uint32_t length = ie_load_u32(incoming);
                    if (!length || length >= IE_EVENT_LIMIT) { error = EPROTO; have = 0; break; }
                    if (have < (size_t)length + 4) break;
                    char text[IE_EVENT_LIMIT]; memcpy(text, incoming + 4, length); text[length] = 0;
                    int progress = 0, final = 0, failed = 0;
                    if (memchr(text, 0, length) || !event_kind(text, &progress, &final, &failed)) error = EPROTO;
                    else if (final) {
                        if (*terminal) error = EPROTO;
                        else memcpy(terminal, text, length + 1);
                    } else if (failed) {
                        if (*failure) error = EPROTO;
                        else memcpy(failure, text, length + 1);
                    } else if (!error && !*terminal && !atomic_load(&job->cancelled)) {
                        pthread_mutex_lock(&lock); enqueue_locked(job, text, progress); pthread_mutex_unlock(&lock);
                    }
                    have -= (size_t)length + 4;
                    memmove(incoming, incoming + length + 4, have);
                }
            }
        }
        if (!exited) {
            pid_t result = waitpid(child, &child_status, WNOHANG);
            if (result == child) exited = 1;
            else if (result < 0 && errno != EINTR) { error = errno; exited = 1; }
        }
        if (exited && eof) break;
        struct pollfd pipes[2] = {
            { .fd = eof ? -1 : event[0], .events = POLLIN },
            { .fd = request[1], .events = POLLOUT }
        };
        if (poll(pipes, 2, 20) < 0 && errno != EINTR) error = errno;
    }
    if (child > 0 && (!WIFEXITED(child_status) || WEXITSTATUS(child_status) != 0 || !*terminal)) error = ECHILD;
    int descriptors[] = {request[0],request[1],event[0],event[1],control[0],control[1]};
    for (unsigned i = 0; i < sizeof descriptors / sizeof descriptors[0]; ++i) if (descriptors[i] >= 0) close(descriptors[i]);
    /* Child cleanup AND process exit precede both callback visibility and the
     * admission of the next operation. A crash/IPC fault is failure, not cancel. */
    if (error || !*terminal) process_failure(job);
    else {
        pthread_mutex_lock(&lock);
        if (active == job) active = NULL;
        if (*failure) enqueue_locked(job, failure, 0);
        enqueue_locked(job, terminal, 0);
        pthread_mutex_unlock(&lock);
    }
    OPENSSL_cleanse(job->input, job->length); free(job->input); free(job);
    return NULL;
}
IMPORT_EXPORT_API int CallBack(import_export_callback fn)
{
    pthread_mutex_lock(&lock);
    if (has_owner && !pthread_equal(owner, pthread_self())) { pthread_mutex_unlock(&lock); return -EPERM; }
    if (fn && !library_pin) {
        Dl_info info;
        if (!dladdr((void *)CallBack, &info)) { pthread_mutex_unlock(&lock); return -ENOENT; }
        char *path = realpath(info.dli_fname, NULL), *slash = path ? strrchr(path, '/') : NULL;
        if (!slash) { free(path); pthread_mutex_unlock(&lock); return -ENOENT; }
        *slash = 0;
        size_t length = strlen(path) + sizeof IE_WORKER_NAME + 1;
        size_t runtime_length = strlen(path) + sizeof("LD_LIBRARY_PATH=/runtime");
        worker_path = malloc(length);
        if (worker_path) snprintf(worker_path, length, "%s/%s", path, IE_WORKER_NAME);
        runtime_environment = malloc(runtime_length);
        if (runtime_environment)
            snprintf(runtime_environment, runtime_length, "LD_LIBRARY_PATH=%s/runtime", path);
        free(path);
        if (!worker_path || !runtime_environment) {
            free(worker_path); free(runtime_environment);
            worker_path = runtime_environment = NULL;
            pthread_mutex_unlock(&lock); return -ENOMEM;
        }
        library_pin = dlopen(info.dli_fname, RTLD_NOW | RTLD_LOCAL | RTLD_NODELETE);
        if (!library_pin) {
            free(worker_path); free(runtime_environment);
            worker_path = runtime_environment = NULL;
            pthread_mutex_unlock(&lock); return -ENOENT;
        }
    }
    if (!has_owner) { owner = pthread_self(); has_owner = 1; }
    if (fn != callback) {
        if (active) atomic_store(&active->cancelled, 1);
        ++generation; ++operation; head = count = 0; callback = fn;
    }
    pthread_mutex_unlock(&lock);
    return 0;
}
IMPORT_EXPORT_API int Startup(const char *text)
{
    pthread_mutex_lock(&lock);
    if (!callback || !text) { pthread_mutex_unlock(&lock); return -1; }
    if (!pthread_equal(owner, pthread_self())) { pthread_mutex_unlock(&lock); return -EPERM; }
    if (active) { pthread_mutex_unlock(&lock); return -EBUSY; }
    size_t length = strnlen(text, IE_REQUEST_LIMIT + 1);
    if (length > IE_REQUEST_LIMIT) { pthread_mutex_unlock(&lock); return -E2BIG; }
    struct host_job *job = calloc(1, sizeof *job);
    if (!job) { pthread_mutex_unlock(&lock); return -ENOMEM; }
    job->input = strndup(text, length);
    if (!job->input) { free(job); pthread_mutex_unlock(&lock); return -ENOMEM; }
    job->length = length; job->generation = generation; job->operation = ++operation;
    atomic_init(&job->cancelled, 0); head = count = 0;
    pthread_attr_t attr; pthread_t thread;
    int error = pthread_attr_init(&attr);
    if (!error) {
        error = pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
        if (!error) { active = job; error = pthread_create(&thread, &attr, run_process, job); }
        pthread_attr_destroy(&attr);
    }
    if (error) { active = NULL; free(job->input); free(job); }
    pthread_mutex_unlock(&lock);
    return error ? -error : 0;
}
IMPORT_EXPORT_API int Shutdown(void)
{
    pthread_mutex_lock(&lock);
    if (has_owner && !pthread_equal(owner, pthread_self())) { pthread_mutex_unlock(&lock); return -EPERM; }
    if (active) atomic_store(&active->cancelled, 1);
    head = count = 0;
    pthread_mutex_unlock(&lock);
    return 0;
}
IMPORT_EXPORT_API int ImportExportDispatchCallbacks(void)
{
    pthread_mutex_lock(&lock);
    if (has_owner && !pthread_equal(owner, pthread_self())) { pthread_mutex_unlock(&lock); return -EPERM; }
    if (!callback || dispatching) { pthread_mutex_unlock(&lock); return 0; }
    while (count && (events[head].generation != generation || events[head].operation != operation)) {
        head = (head + 1) % EVENT_COUNT; --count;
    }
    if (!count) { pthread_mutex_unlock(&lock); return 0; }
    struct event event = events[head]; head = (head + 1) % EVENT_COUNT; --count;
    import_export_callback fn = callback; dispatching = 1;
    pthread_mutex_unlock(&lock);
    fn(event.text);
    pthread_mutex_lock(&lock); dispatching = 0; pthread_mutex_unlock(&lock);
    return 1;
}
