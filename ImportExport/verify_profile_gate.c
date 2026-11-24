/* Parent-run lifetime regression for the real exec worker and host spawn code.
 * Build with the same ia32 compiler/json-c prefix and libcrypto/pthread/dl flags
 * as db_import_export_tools.so. Run with the actual built worker path.
 * No account/database payload is sent; the worker waits on its real fd protocol. */
#include "db_import_export_tools.c"

static void check(int condition, const char *message)
{
    if (!condition) { perror(message); exit(1); }
}
static void close_pair(int pair[2])
{
    for (unsigned i = 0; i < 2; ++i) if (pair[i] >= 0) close(pair[i]);
}
int main(int argc, char **argv)
{
    check(argc == 2, "supply real worker");
    char binary[PATH_MAX];
    check(realpath(argv[1], binary) != NULL, "worker path");
    worker_path = binary;
    char runtime[PATH_MAX + sizeof "LD_LIBRARY_PATH=/runtime"];
    char *slash = strrchr(binary, '/');
    int n = snprintf(runtime, sizeof runtime, "LD_LIBRARY_PATH=%.*s/runtime", (int)(slash - binary), binary);
    check(n > 0 && (size_t)n < sizeof runtime, "runtime path");
    runtime_environment = runtime;

    char fixture[PATH_MAX], profile[PATH_MAX], directory[PATH_MAX], gate_path[PATH_MAX];
    const char *temporary = getenv("TMPDIR");
    if (!temporary || !*temporary) temporary = "/tmp";
    n = snprintf(fixture, sizeof fixture, "%s/welink-worker-gate-XXXXXX", temporary);
    check(n > 0 && (size_t)n < sizeof fixture && mkdtemp(fixture), "fixture directory");
    n = snprintf(profile, sizeof profile, "%s/profile", fixture);
    check(n > 0 && (size_t)n < sizeof profile && !mkdir(profile, 0700), "profile directory");
    char canonical[PATH_MAX];
    check(realpath(profile, canonical) != NULL, "canonical profile");
    n = snprintf(directory, sizeof directory, "%s/.welink-native-profile-gates", fixture);
    check(n > 0 && (size_t)n < sizeof directory && !mkdir(directory, 0700), "gate directory");
    unsigned char hash[SHA256_DIGEST_LENGTH];
    check(SHA256((const unsigned char *)canonical, strlen(canonical), hash) != NULL, "profile hash");
    char encoded[SHA256_DIGEST_LENGTH * 2 + 1];
    for (unsigned i = 0; i < sizeof hash; ++i) snprintf(encoded + i * 2, 3, "%02x", hash[i]);
    n = snprintf(gate_path, sizeof gate_path, "%s/%s.lock", directory, encoded);
    check(n > 0 && (size_t)n < sizeof gate_path, "gate path");
    int gate = open(gate_path, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    check(gate >= 0 && !setenv("WELINK_NATIVE_PROFILE_DIR", canonical, 1), "gate creation");

    int request[2] = {-1,-1}, event[2] = {-1,-1}, control[2] = {-1,-1}, raw[2];
    check(!make_pipe(request) && !make_pipe(event), "protocol pipes");
    check(!socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, raw), "control socket");
    control[0] = lift_fd(raw[0]); control[1] = lift_fd(raw[1]);
    check(control[0] >= 0 && control[1] >= 0, "control descriptors");
    pid_t child = -1;
    check(!flock(gate, LOCK_EX | LOCK_NB), "exclusive update gate");
    int refused = spawn_worker(&child, request[0], control[1], event[1]);
    check((refused == EWOULDBLOCK || refused == EAGAIN) && child == -1,
          "worker must not start while profile update owns gate");
    check(!flock(gate, LOCK_UN), "release exclusive gate");

    check(!spawn_worker(&child, request[0], control[1], event[1]), "real worker spawn");
    close(request[0]); request[0] = -1;
    close(control[1]); control[1] = -1;
    close(event[1]); event[1] = -1;
    errno = 0;
    check(flock(gate, LOCK_EX | LOCK_NB) == -1 && (errno == EWOULDBLOCK || errno == EAGAIN),
          "exec worker must retain shared gate after parent spawn returns");
    check(send(control[0], "C", 1, MSG_NOSIGNAL) == 1, "cancel submission");
    errno = 0;
    check(flock(gate, LOCK_EX | LOCK_NB) == -1 && (errno == EWOULDBLOCK || errno == EAGAIN),
          "cancel submission must not release a live worker gate");
    close(request[1]); request[1] = -1;
    int status = 0;
    check(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 67,
          "real worker must exit on incomplete request");
    check(!flock(gate, LOCK_EX | LOCK_NB), "gate must release only after worker exit");
    check(!flock(gate, LOCK_UN), "unlock after worker exit");

    check(!unlink(gate_path), "remove test gate");
    child = -1;
    check(profile_gate(&request[0], runtime, sizeof runtime) == ENOENT && request[0] == -1,
          "missing profile gate must fail closed");
    close(gate); close_pair(request); close_pair(event); close_pair(control);
    check(!rmdir(directory) && !rmdir(profile) && !rmdir(fixture), "remove private fixture");
    puts("PASS real worker: exclusive update blocks spawn; shared gate survives exec/cancel and releases at exit");
    return 0;
}
