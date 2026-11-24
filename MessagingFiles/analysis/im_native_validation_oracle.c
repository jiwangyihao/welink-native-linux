/* Minimal REAL original ia32 SQLite-ABI probe, synthetic fixtures only.
 * Build: i686-w64-mingw32-gcc -std=c11 -O2 -Wall -Wextra
 *        analysis/im_native_validation_oracle.c -o im_native_validation_oracle.exe
 * No SDK import library or mock is used. The parent supplies a private Wine
 * prefix, full path to original tup_sqlite_logic_api.dll, dependency directory,
 * log/app/KMC directories (ALL with trailing Windows separators), and JSONL.
 * argv: DLL DEPENDENCY_DIR LOG_DIR APP_DIR KMC_ROOT REQUESTS_JSONL
 * Full callback bytes are length-framed. A completed data probe is distinct
 * from clean lifecycle: exit 3 or timeout AFTER DATA_COMPLETE is NOT a
 * shutdown pass. Never replace Shutdown with ExitProcess to hide that failure.
 */
#define _CRT_SECURE_NO_WARNINGS
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <limits.h>
#include <ctype.h>
#include <fcntl.h>
#include <io.h>
#if !defined(__i386__)
#error Original SDK ABI is ia32
#endif

typedef int (__cdecl *callback_fn)(const char *);
typedef int (__cdecl *init_fn)(const char *, const char *, const char *, callback_fn);
typedef void (__cdecl *send_fn)(const char *);
typedef void (__cdecl *stop_fn)(void);
static CRITICAL_SECTION output_lock;
static HANDLE response_event;
static volatile LONG expected_sno = LONG_MIN;
static volatile LONG callbacks;

/* Only a top-level integer is accepted, never a similarly named nested key.
 * Requests themselves are JSON-serialized by Python, not hand-concatenated. */
static long top_integer(const char *text, const char *wanted, long absent)
{
    unsigned depth = 0;
    const char *p = text;
    while (*p) {
        if (*p == '{' || *p == '[') { ++depth; ++p; continue; }
        if (*p == '}' || *p == ']') { if (depth) --depth; ++p; continue; }
        if (*p != '"') { ++p; continue; }
        const char *begin = ++p;
        int escaped = 0;
        while (*p && *p != '"') {
            if (*p == '\\' && p[1]) { escaped = 1; p += 2; }
            else ++p;
        }
        if (!*p) return absent;
        size_t length = (size_t)(p - begin);
        ++p;
        const char *after = p;
        while (isspace((unsigned char)*after)) ++after;
        if (depth != 1 || escaped || length != strlen(wanted) || memcmp(begin, wanted, length) || *after != ':') continue;
        ++after;
        while (isspace((unsigned char)*after)) ++after;
        char *end;
        long value = strtol(after, &end, 10);
        if (end == after) return absent;
        while (isspace((unsigned char)*end)) ++end;
        return *end == ',' || *end == '}' ? value : absent;
    }
    return absent;
}
static int __cdecl callback(const char *text)
{
    if (!text) return 0;
    EnterCriticalSection(&output_lock);
    size_t length = strlen(text);
    printf("IMVALID_CALLBACK %lu\n", (unsigned long)length);
    fwrite(text, 1, length, stdout); putchar('\n'); fflush(stdout);
    InterlockedIncrement(&callbacks);
    if (top_integer(text, "sno", LONG_MIN) == InterlockedCompareExchange(&expected_sno, 0, 0))
        SetEvent(response_event);
    LeaveCriticalSection(&output_lock);
    return 0;
}
static int trailing_directory(const char *path)
{
    size_t length = strlen(path);
    return length > 3 && path[1] == ':' && path[length - 1] == '\\' && !strchr(path, '/');
}
int main(int argc, char **argv)
{
    if (argc != 7) {
        fprintf(stderr, "usage: oracle.exe ORIGINAL_DLL DEPENDENCY_DIR LOG_DIR APP_DIR KMC_ROOT REQUESTS_JSONL\n");
        return 2;
    }
    for (int n = 2; n <= 5; ++n) if (!trailing_directory(argv[n])) {
        fprintf(stderr, "directory arguments must be absolute Windows paths with trailing backslashes\n"); return 2;
    }
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    _setmode(_fileno(stdout), _O_BINARY);
    InitializeCriticalSection(&output_lock);
    response_event = CreateEventA(NULL, FALSE, FALSE, NULL);
    if (!response_event || !SetDllDirectoryA(argv[2])) return 4;
    HMODULE module = LoadLibraryA(argv[1]);
    if (!module) { fprintf(stderr, "original DLL load error %lu\n", GetLastError()); return 4; }
    init_fn init = (init_fn)GetProcAddress(module, "InitSqliteService");
    send_fn send = (send_fn)GetProcAddress(module, "SqliteServiceSendMsg");
    stop_fn stop = (stop_fn)GetProcAddress(module, "SqliteServiceShutdown");
    if (!init || !send || !stop) { fprintf(stderr, "missing exact original public SQLite ABI\n"); return 5; }
    FILE *requests = fopen(argv[6], "rb");
    if (!requests) return 6;
    /* Third argument is the KMC root, NOT the private account DB directory. */
    int initialized = init(argv[3], argv[4], argv[5], callback);
    printf("IMVALID_INIT %d\n", initialized); fflush(stdout);
    if (initialized) return 7;
    char *line = malloc(1024 * 1024 + 2);
    if (!line) return 8;
    unsigned sent = 0;
    while (fgets(line, 1024 * 1024 + 2, requests)) {
        size_t length = strlen(line);
        if (!length || line[length - 1] != '\n') { fprintf(stderr, "invalid or oversized request line\n"); return 9; }
        while (length && (line[length - 1] == '\n' || line[length - 1] == '\r')) line[--length] = 0;
        long sno = top_integer(line, "sno", LONG_MIN);
        if (sno == LONG_MIN) return 9;
        ResetEvent(response_event);
        InterlockedExchange(&expected_sno, sno);
        EnterCriticalSection(&output_lock);
        printf("IMVALID_REQUEST %lu\n", (unsigned long)length);
        fwrite(line, 1, length, stdout); putchar('\n'); fflush(stdout);
        LeaveCriticalSection(&output_lock);
        send(line); ++sent;
        if (WaitForSingleObject(response_event, 30000) != WAIT_OBJECT_0) {
            fprintf(stderr, "original callback timeout at sno %ld\n", sno); return 124;
        }
    }
    if (ferror(requests) || !sent) return 10;
    fclose(requests); free(line);
    printf("IMVALID_DATA_COMPLETE %u %ld\n", sent, callbacks); fflush(stdout);
    puts("IMVALID_SHUTDOWN_BEGIN"); fflush(stdout);
    stop();
    puts("IMVALID_SHUTDOWN_RETURNED"); fflush(stdout);
    /* Normal process exit deliberately exercises DLL detach too. No forced
     * successful exit, FreeLibrary race, or lifecycle-result suppression. */
    return 0;
}
