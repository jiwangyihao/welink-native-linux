/* Temporary offline codec-vector extraction. No SDK startup, network, login,
 * filesystem data transfer, or user profile access. Input must contain only
 * synthetic JSON chosen by the parent, one RVA<TAB>class<TAB>JSON line each.
 * Build ia32 with i686-w64-mingw32-gcc; run in a private no-network Wine prefix.
 * argv: tup_im_json.dll ecs_im_nbr.dll synthetic-input.tsv
 */
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if !defined(__i386__)
#error The original SDK uses the ia32 MSVC ABI
#endif
#define THIS __attribute__((thiscall))
struct istr { const char *data; unsigned length; };
typedef void *(__cdecl *factory_fn)(void);
typedef void (THIS *decode_fn)(void *, struct istr);
typedef void *(THIS *encode_fn)(void *, void *, unsigned char);
typedef struct istr *(THIS *bytes_str_fn)(void *, struct istr *);
typedef void (THIS *dtor_fn)(void *);
typedef void *(THIS *delete_fn)(void *, unsigned);
static const char *current_stage = "startup";
static char current_model[256];
static LONG handling_exception;
static void stage(const char *name)
{
    current_stage = name;
    fprintf(stderr, "stage %s %s\n", current_model, name);
    fflush(stderr);
}
static uintptr_t remote_word(uintptr_t address)
{
    uint32_t result = 0;
    SIZE_T copied = 0;
    ReadProcessMemory(GetCurrentProcess(), (const void *)address, &result, sizeof result, &copied);
    return copied == sizeof result ? result : 0;
}
static void remote_text(uintptr_t address, char *output, size_t capacity)
{
    size_t n = 0;
    for (; address && n + 1 < capacity; ++n) {
        SIZE_T copied = 0;
        char value;
        if (!ReadProcessMemory(GetCurrentProcess(), (const void *)(address + n), &value, 1, &copied) ||
            copied != 1 || !value) break;
        output[n] = (unsigned char)value >= 32 ? value : '?';
    }
    output[n] = 0;
}
static LONG CALLBACK report_exception(EXCEPTION_POINTERS *information)
{
    EXCEPTION_RECORD *record = information->ExceptionRecord;
    if (record->ExceptionCode != 0xe06d7363 && record->ExceptionCode != EXCEPTION_ACCESS_VIOLATION &&
        record->ExceptionCode != 0xc0000409 && record->ExceptionCode != EXCEPTION_ILLEGAL_INSTRUCTION)
        return EXCEPTION_CONTINUE_SEARCH;
    if (InterlockedCompareExchange(&handling_exception, 1, 0)) return EXCEPTION_CONTINUE_SEARCH;
    char type[256] = "", detail[512] = "";
    if (record->ExceptionCode == 0xe06d7363 && record->NumberParameters >= 3) {
        uintptr_t types = remote_word(record->ExceptionInformation[2] + 12);
        uintptr_t first = remote_word(types + 4);
        uintptr_t descriptor = remote_word(first + 4);
        if (descriptor) remote_text(descriptor + 8, type, sizeof type);
        remote_text(remote_word(record->ExceptionInformation[1] + 4), detail, sizeof detail);
    }
    fprintf(stderr, "exception %08lx address=%p model=%s stage=%s type=%s detail=%s\n",
        record->ExceptionCode, record->ExceptionAddress, current_model, current_stage, type, detail);
    fflush(stderr);
    InterlockedExchange(&handling_exception, 0);
    return EXCEPTION_CONTINUE_SEARCH;
}
static uint32_t word(const void *base, unsigned offset)
{
    uint32_t result;
    memcpy(&result, (const char *)base + offset, sizeof result);
    return result;
}
static void quoted(const char *text, size_t size)
{
    putchar('"');
    for (size_t n = 0; n < size; ++n) {
        unsigned char c = text[n];
        if (c == '\\' || c == '"') { putchar('\\'); putchar(c); }
        else if (c < 32) printf("\\u%04x", c);
        else putchar(c);
    }
    putchar('"');
}
int main(int argc, char **argv)
{
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    AddVectoredExceptionHandler(1, report_exception);
    if (argc != 4) return 2;
    HMODULE im = LoadLibraryA(argv[1]), nbr = LoadLibraryA(argv[2]);
    if (!im || !nbr) { fprintf(stderr, "DLL load failed: %lu\n", GetLastError()); return 3; }
    decode_fn decode = (decode_fn)GetProcAddress(nbr, "?decodeJson@Object@ecs@@QAEXVistr@2@@Z");
    encode_fn encode = (encode_fn)GetProcAddress(nbr, "?encode@Object@ecs@@QBE?AVBytes@2@_N@Z");
    encode_fn encode_json = (encode_fn)GetProcAddress(nbr, "?encodeJson@Object@ecs@@QBE?AVString@2@_N@Z");
    bytes_str_fn bytes_str = (bytes_str_fn)GetProcAddress(nbr, "??BBytes@ecs@@QBE?AVistr@1@XZ");
    dtor_fn bytes_dtor = (dtor_fn)GetProcAddress(nbr, "??1Bytes@ecs@@QAE@XZ");
    dtor_fn string_dtor = (dtor_fn)GetProcAddress(nbr, "??1String@ecs@@QAE@XZ");
    if (!decode || !encode || !encode_json || !bytes_str || !bytes_dtor || !string_dtor) return 4;
    FILE *input = fopen(argv[3], "r");
    if (!input) return 5;
    char *line = malloc(1024 * 1024);
    if (!line) return 6;
    while (fgets(line, 1024 * 1024, input)) {
        char *first = strchr(line, '\t');
        char *second = first ? strchr(first + 1, '\t') : NULL;
        if (!first || !second) return 7;
        *first++ = 0; *second++ = 0;
        size_t length = strcspn(second, "\r\n");
        second[length] = 0;
        uintptr_t rva = strtoul(line, NULL, 16);
        strncpy(current_model, first, sizeof current_model - 1);
        current_model[sizeof current_model - 1] = 0;
        stage("factory");
        void *object = ((factory_fn)((unsigned char *)im + rva))();
        if (!object) return 8;
        struct istr json = { second, (unsigned)length };
        stage("decodeJson");
        decode(object, json);
        printf("{\"class\":"); quoted(first, strlen(first));
        printf(",\"input\":%s", second);
        for (unsigned hide = 0; hide < 2; ++hide) {
            unsigned char bytes[32] = {0};
            struct istr result = {0};
            stage(hide ? "encode1" : "encode0");
            encode(object, bytes, hide);
            stage("bytesView");
            bytes_str(bytes, &result);
            printf(",\"nbr%u\":\"", hide);
            for (unsigned n = 0; n < result.length; ++n) printf("%02x", (unsigned char)result.data[n]);
            putchar('"');
            stage("destroyBytes");
            bytes_dtor(bytes);
        }
        unsigned char normalized[32] = {0};
        stage("encodeJson");
        encode_json(object, normalized, 0);
        const char *data = word(normalized, 20) >= 16 ? (const char *)(uintptr_t)word(normalized, 0) : (const char *)normalized;
        printf(",\"normalized\":"); fwrite(data, 1, word(normalized, 16), stdout);
        puts("}"); fflush(stdout);
        stage("destroyString");
        string_dtor(normalized);
        stage("destroyObject");
        ((delete_fn)(uintptr_t)word((void *)(uintptr_t)word(object, 0), 0))(object, 1);
    }
    free(line);
    fclose(input);
    return 0;
}
