/* One exec-launched native operation. SQLite/KMC never run in Electron's
 * process; its SDKs therefore coordinate with this worker using OS locks.
 * See ie_protocol.h for the private inherited-fd protocol. */
#define _GNU_SOURCE
#include "ie_internal.h"
#include "ie_protocol.h"
#include <errno.h>
#include <fcntl.h>
#include <openssl/crypto.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

static struct ie_job job;
static int event_error;
const char *ie_string(struct json_object *object, const char *name)
{
    struct json_object *value = NULL;
    if (!json_object_is_type(object, json_type_object) || !json_object_object_get_ex(object, name, &value) ||
        !json_object_is_type(value, json_type_string)) return "";
    const char *text = json_object_get_string(value);
    return strlen(text) == (size_t)json_object_get_string_len(value) ? text : "";
}
int ie_cancelled(struct ie_job *operation) { return atomic_load(&operation->state) == IE_CANCELLED; }
int ie_fail(struct ie_job *operation, int code, const char *text)
{
    if (!operation->error) { operation->error = code; operation->error_text = text; }
    return -1;
}
int ie_commit_point(struct ie_job *operation)
{
    int expected = IE_RUNNING;
    return atomic_compare_exchange_strong(&operation->state, &expected, IE_COMMITTING) ? 0 : -1;
}
static int write_event(const char *text)
{
    unsigned char frame[IE_EVENT_LIMIT + 4]; size_t length = strlen(text);
    if (!length || length >= IE_EVENT_LIMIT) return -1;
    ie_store_u32(frame, (uint32_t)length); memcpy(frame + 4, text, length);
    size_t offset = 0;
    while (offset < length + 4) {
        ssize_t n = write(IE_EVENT_FD, frame + offset, length + 4 - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        offset += (size_t)n;
    }
    return 0;
}
static void emit(struct ie_job *operation, int kind, int value)
{
    char text[IE_EVENT_LIMIT];
    if (kind == 0)
        snprintf(text, sizeof text,
            "{\"resType\":0,\"param\":{\"status\":%d,\"imExType\":%d,\"errorCode\":%d}}",
            value, operation->type, value == 5 ? operation->error : 0);
    else if (kind == 1)
        snprintf(text, sizeof text,
            "{\"resType\":1,\"param\":{\"errorCode\":%d,\"errorMsg\":\"%s\",\"imExType\":%d}}",
            operation->error, operation->error_text, operation->error_type);
    else
        snprintf(text, sizeof text,
            "{\"resType\":2,\"param\":{\"progress\":%d,\"imExType\":%d}}", value, operation->type);
    if (write_event(text)) { event_error = 1; int state = IE_RUNNING; atomic_compare_exchange_strong(&operation->state, &state, IE_CANCELLED); }
}
void ie_status(struct ie_job *operation, int status) { emit(operation, 0, status); }
void ie_progress(struct ie_job *operation, int value)
{
    value = CLAMP(value, 0, 100);
    if (!ie_cancelled(operation) && value > operation->progress) { operation->progress = value; emit(operation, 2, value); }
}
static int timestamp(const char *value)
{
    size_t length = strlen(value);
    if (!length || length > 32) return 0;
    for (size_t i = 0; i < length; ++i) if (value[i] < '0' || value[i] > '9') return 0;
    return 1;
}
static int parse(struct ie_job *operation)
{
    if (!*operation->input) return ie_fail(operation, 11, "receiveMsg  is empty");
    struct json_tokener *tokener = json_tokener_new_ex(32);
    if (!tokener) return ie_fail(operation, 10, "reader  parse is failed");
    json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    operation->request = json_tokener_parse_ex(tokener, operation->input, (int)strlen(operation->input) + 1);
    int error = json_tokener_get_error(tokener) != json_tokener_success;
    json_tokener_free(tokener);
    if (error) return ie_fail(operation, 10, "reader  parse is failed");
    if (!json_object_is_type(operation->request, json_type_object)) return ie_fail(operation, 9, "root  type is not object");
    struct json_object *value = NULL;
    if (json_object_object_get_ex(operation->request, "operationType", &value) && json_object_is_type(value, json_type_int)) operation->type = json_object_get_int(value);
    if (json_object_object_get_ex(operation->request, "exportType", &value) && json_object_is_type(value, json_type_int)) operation->format = json_object_get_int(value);
    if (json_object_object_get_ex(operation->request, "isEnglish", &value) && json_object_is_type(value, json_type_int)) operation->english = json_object_get_int(value) != 0;
    operation->account = ie_string(operation->request, "account");
    operation->desktop = ie_string(operation->request, "welinkDesktopPath");
    operation->conversation = ie_string(operation->request, "conversationId");
    operation->minimum = ie_string(operation->request, "minTimestamp");
    operation->maximum = ie_string(operation->request, "maxTimestamp");
    if (!*operation->minimum) operation->minimum = "0000000000000";
    if (!*operation->maximum) operation->maximum = "9999999999999";
    if (!*operation->desktop || !ie_component(operation->account)) return ie_fail(operation, 8, "WelinkDesktopPath or account is empty!");
    if ((operation->type != 1 && operation->type != 2) || operation->format < 0 || operation->format > 3 ||
        !timestamp(operation->minimum) || !timestamp(operation->maximum) || strcmp(operation->minimum, operation->maximum) > 0)
        return ie_fail(operation, 9, "invalid operation or timestamp range");
    operation->selected = ie_string(operation->request, operation->type == 1 ? "importPath" : "exportPath");
    if (!*operation->selected) return ie_fail(operation, operation->type == 1 ? 4 : 5,
        operation->type == 1 ? "ImportPath is empty!" : "ExportPath is empty!");
    operation->selected_fd = operation->type == 1 ? open(operation->selected, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK) : ie_open_directory(operation->selected);
    struct stat info;
    if (operation->selected_fd < 0 || fstat(operation->selected_fd, &info) ||
        (!S_ISREG(info.st_mode) && !S_ISDIR(info.st_mode)) || (operation->type == 2 && !S_ISDIR(info.st_mode)))
        return ie_fail(operation, operation->type == 1 ? 6 : 7, operation->type == 1 ? "importPath not exist" : "exportPath not exist");
    return 0;
}
static int cleanup(struct ie_job *operation)
{
    ie_close_profile(operation);
    int error = 0;
    if (operation->stage_fd >= 0) { error = ie_remove_tree(operation->stage_fd); close(operation->stage_fd); }
    if (operation->stage_name) {
        int parent = operation->type == 2 ? operation->selected_fd : operation->account_fd;
        if (parent >= 0 && unlinkat(parent, operation->stage_name, AT_REMOVEDIR)) error = errno;
    }
    int descriptors[] = {operation->desktop_fd, operation->im_fd, operation->account_fd, operation->selected_fd, operation->receive_fd, operation->contact_fd};
    for (unsigned i = 0; i < G_N_ELEMENTS(descriptors); ++i) if (descriptors[i] >= 0) close(descriptors[i]);
    g_free(operation->stage_name);
    if (operation->published_files) g_ptr_array_free(operation->published_files, TRUE);
    json_object_put(operation->request);
    if (operation->input) { OPENSSL_cleanse(operation->input, strlen(operation->input)); free(operation->input); }
    return error;
}
static int read_exact(int fd, void *buffer, size_t length)
{
    size_t done = 0;
    while (done < length) {
        ssize_t n = read(fd, (char *)buffer + done, length - done);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        done += (size_t)n;
    }
    return 0;
}
static void *watch_cancel(void *unused)
{
    (void)unused;
    for (;;) {
        char value; ssize_t n = read(IE_CONTROL_FD, &value, 1);
        if (n < 0 && errno == EINTR) continue;
        if (n == 1 && value != 'C') continue;
        int state = IE_RUNNING; atomic_compare_exchange_strong(&job.state, &state, IE_CANCELLED);
        if (n <= 0) break;
    }
    return NULL;
}
int main(int argc, char **argv)
{
    if (argc != 2 || strcmp(argv[1], IE_WORKER_ARGUMENT)) return 64;
    struct stat request_info, event_info, control_info;
    if (fstat(IE_REQUEST_FD, &request_info) || !S_ISFIFO(request_info.st_mode) ||
        fstat(IE_EVENT_FD, &event_info) || !S_ISFIFO(event_info.st_mode) ||
        fstat(IE_CONTROL_FD, &control_info) || !S_ISSOCK(control_info.st_mode)) return 65;
    const char *profile = getenv("WELINK_NATIVE_PROFILE_DIR");
    if (profile && *profile) {
        struct stat gate;
        if (fstat(IE_PROFILE_GATE_FD, &gate) || !S_ISREG(gate.st_mode) || gate.st_uid != getuid() ||
            gate.st_nlink != 1 || (gate.st_mode & 07777) != 0600 ||
            flock(IE_PROFILE_GATE_FD, LOCK_SH | LOCK_NB)) return 71;
        /* Do not close this gate on cancellation or cleanup: COMMITTING may
         * continue after the host exits, and only process exit releases it. */
    }
    struct sigaction ignore = { .sa_handler = SIG_IGN }; sigemptyset(&ignore.sa_mask); sigaction(SIGPIPE, &ignore, NULL);
    job.desktop_fd = job.im_fd = job.account_fd = job.selected_fd = job.stage_fd = job.receive_fd = job.contact_fd = -1;
    atomic_init(&job.state, IE_RUNNING);
    /* Bound SQLite scratch/cache memory without spilling decrypted message
     * sorts to a global temporary directory. This affects this worker only. */
    sqlite3_hard_heap_limit64(128 * 1024 * 1024);
    pthread_t watcher;
    if (pthread_create(&watcher, NULL, watch_cancel, NULL)) return 66;
    pthread_detach(watcher);
    unsigned char header[8];
    if (read_exact(IE_REQUEST_FD, header, sizeof header) || memcmp(header, "WIE1", 4)) return 67;
    uint32_t length = ie_load_u32(header + 4);
    if (length > IE_REQUEST_LIMIT || !(job.input = calloc((size_t)length + 1, 1))) return 68;
    if (read_exact(IE_REQUEST_FD, job.input, length) || memchr(job.input, 0, length)) { cleanup(&job); return 69; }
    close(IE_REQUEST_FD);
    ie_status(&job, 0); /* PE 10030a00: BEGIN with imExType 0 before parsing. */
    if (!parse(&job) && !ie_cancelled(&job) && !ie_load_profile(&job) && !ie_cancelled(&job)) {
        int kind = job.type;
        job.type = 0; ie_progress(&job, 5); job.type = kind;
        job.error_type = kind;
        if (job.type == 1) ie_import(&job); else ie_export(&job);
    }
    int cleanup_error = cleanup(&job);
    if (cleanup_error) {
        job.error = 1; job.error_text = "temporary file cleanup failed"; job.error_type = job.type;
        emit(&job, 1, 0); ie_status(&job, 5);
    } else if (ie_cancelled(&job)) ie_status(&job, 6);
    else if (job.error) { emit(&job, 1, 0); ie_status(&job, 5); }
    else { ie_progress(&job, 100); ie_status(&job, 4); }
    close(IE_EVENT_FD);
    /* The detached cancellation reader touches only the static atomic state.
     * Returning exits this process; no pthread/SQLite code survives in the host. */
    return event_error ? 70 : 0;
}
