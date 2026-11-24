/* Purely synthetic Onebox oracle. Compile ia32; parent supplies a private Wine
 * prefix, no-network namespace with loopback, and copied original SDK DLLs.
 * argv: DLL directory, login.json, download.json, private log directory.
 * Callback frames on stdout are: CALLBACK <byte length> LF <unaltered JSON> LF.
 */
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <fcntl.h>
#include <io.h>
#include <limits.h>
#include <stdint.h>
#if !defined(__i386__)
#error Original SDK ABI is ia32
#endif

typedef int (__cdecl *callback_fn)(const char *);
typedef int (__cdecl *init_fn)(const char *, callback_fn);
typedef void (__cdecl *send_fn)(const char *);
typedef void (__cdecl *shutdown_fn)(void);
static CRITICAL_SECTION output_lock;
static HANDLE login_event, ack_event, completion_event, release_event;
static volatile LONG login_result = LONG_MIN, ack_result = LONG_MIN;
static volatile LONG handle_seen, progress_count;
static uint32_t file_handle;

static long long integer_field(const char *json, const char *name, long long absent)
{
    char key[96];
    snprintf(key, sizeof key, "\"%s\"", name);
    const char *p = strstr(json, key);
    if (!p) return absent;
    p += strlen(key);
    while (isspace((unsigned char)*p)) ++p;
    if (*p++ != ':') return absent;
    while (isspace((unsigned char)*p)) ++p;
    char *end;
    long long value = strtoll(p, &end, 10);
    return end != p ? value : absent;
}

static int __cdecl callback(const char *json)
{
    if (!json) return 0;
    EnterCriticalSection(&output_lock);
    size_t length = strlen(json);
    fprintf(stdout, "CALLBACK %lu\n", (unsigned long)length);
    fwrite(json, 1, length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    long long response = integer_field(json, "rsp", -1);
    long long notification = integer_field(json, "notify", -1);
    if (response == 589828) {
        login_result = (LONG)integer_field(json, "result", LONG_MIN);
        SetEvent(login_event);
    } else if (response == 589832) {
        ack_result = (LONG)integer_field(json, "result", LONG_MIN);
        long long handle = integer_field(json, "pcfile_handle", -1);
        if (handle >= 0 && (unsigned long long)handle <= UINT32_MAX) {
            file_handle = (uint32_t)handle;
            InterlockedExchange(&handle_seen, 1);
        }
        SetEvent(ack_event);
    } else if (response == 589834) SetEvent(release_event);
    if (notification == 2) InterlockedIncrement(&progress_count);
    if (notification == 1) SetEvent(completion_event);
    LeaveCriticalSection(&output_lock);
    return 0;
}

static char *read_request(const char *path)
{
    FILE *file = fopen(path, "rb");
    if (!file) return NULL;
    if (fseek(file, 0, SEEK_END)) { fclose(file); return NULL; }
    long length = ftell(file);
    if (length <= 0 || length > 1048576 || fseek(file, 0, SEEK_SET)) { fclose(file); return NULL; }
    char *content = malloc((size_t)length + 1);
    if (!content) { fclose(file); return NULL; }
    if (fread(content, 1, (size_t)length, file) != (size_t)length) {
        free(content); fclose(file); return NULL;
    }
    fclose(file);
    content[length] = 0;
    return content;
}

int main(int argc, char **argv)
{
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    if (argc != 5) return 2;
    _setmode(_fileno(stdout), _O_BINARY);
    InitializeCriticalSection(&output_lock);
    login_event = CreateEventA(NULL, TRUE, FALSE, NULL);
    ack_event = CreateEventA(NULL, TRUE, FALSE, NULL);
    completion_event = CreateEventA(NULL, TRUE, FALSE, NULL);
    release_event = CreateEventA(NULL, TRUE, FALSE, NULL);
    if (!login_event || !ack_event || !completion_event || !release_event) return 3;
    if (!SetDllDirectoryA(argv[1])) return 4;
    char library_path[4096];
    snprintf(library_path, sizeof library_path, "%s\\tup_offlinefile_logic_api.dll", argv[1]);
    HMODULE library = LoadLibraryExA(library_path, NULL, LOAD_WITH_ALTERED_SEARCH_PATH);
    if (!library) { fprintf(stderr, "SDK load error %lu\n", GetLastError()); return 5; }
    init_fn initialize = (init_fn)GetProcAddress(library, "OfflineFileInitService");
    send_fn send = (send_fn)GetProcAddress(library, "OfflineFileSendMsg");
    shutdown_fn shutdown = (shutdown_fn)GetProcAddress(library, "OfflineFileShutdown");
    if (!initialize || !send || !shutdown) return 6;
    char *login = read_request(argv[2]), *download = read_request(argv[3]);
    if (!login || !download) { free(login); free(download); return 7; }
    int result = initialize(argv[4], callback);
    fprintf(stderr, "INIT %d\n", result); fflush(stderr);
    if (result) { free(login); free(download); return 8; }
    int exit_code = 0;
    send(login);
    if (WaitForSingleObject(login_event, 30000) != WAIT_OBJECT_0) { exit_code = 10; goto finished; }
    if (login_result != 0) { exit_code = 11; goto finished; }
    send(download);
    if (WaitForSingleObject(ack_event, 30000) != WAIT_OBJECT_0) { exit_code = 12; goto finished; }
    if (ack_result != 0 || !handle_seen) { exit_code = 13; goto finished; }
    /* The initial pcfile_handle ack is NOT a completed download. */
    if (WaitForSingleObject(completion_event, 30000) != WAIT_OBJECT_0) { exit_code = 14; goto finished; }
    char release[256];
    snprintf(release, sizeof release,
        "{\"cmd\":589834,\"sno\":3,\"description\":\"tup_offlinefile_release\",\"param\":{\"file_handle\":%lu}}",
        (unsigned long)file_handle);
    send(release);
    if (WaitForSingleObject(release_event, 15000) != WAIT_OBJECT_0) exit_code = 15;
finished:
    fprintf(stderr, "END flow=%d progress=%ld completion=%d\n", exit_code, progress_count,
        WaitForSingleObject(completion_event, 0) == WAIT_OBJECT_0);
    fflush(stderr);
    shutdown();
    free(login); free(download);
    CloseHandle(login_event); CloseHandle(ack_event); CloseHandle(completion_event); CloseHandle(release_event);
    DeleteCriticalSection(&output_lock);
    return exit_code;
}
