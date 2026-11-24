/* Temporary, credential-free metadata extraction from the hash-matched ia32
 * original DLLs. This is NOT a production backend. It calls only generated
 * default-message constructors, Object::io/encodeJson, and destructors.
 * It never calls Startup/ImInit/Login, opens sockets, or reads user storage.
 * Build with i686-w64-mingw32-gcc. Run in a disposable, network-isolated Wine
 * prefix, with original dependency DLL directories on the process search path.
 * argv: tup_im_json.dll ecs_im_nbr.dll im_transport_factories.tsv
 */
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if !defined(__i386__) && !defined(_M_IX86)
#error This extractor requires the original 32-bit DLL ABI
#endif
#define THIS __attribute__((thiscall))
typedef void *(__cdecl *factory_fn)(void);
/* MSVC virtual inheritance adds a hidden most-derived flag (constructor ret 4). */
typedef void *(THIS *stream_ctor_fn)(void *, int);
typedef void (THIS *one_arg_fn)(void *);
typedef void (THIS *object_io_fn)(void *, void *);
typedef void *(THIS *object_json_fn)(void *, void *, unsigned char);
typedef void *(THIS *delete_fn)(void *, unsigned int);

static uint32_t word(const void *base, size_t offset)
{
    uint32_t value;
    memcpy(&value, (const unsigned char *)base + offset, sizeof value);
    return value;
}
static void quoted(const char *text, size_t length)
{
    putchar('"');
    for (size_t n = 0; n < length; ++n) {
        unsigned char c = (unsigned char)text[n];
        if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
        else if (c < 32) printf("\\u%04x", c);
        else putchar(c);
    }
    putchar('"');
}
static void integer_set(const unsigned char *node, unsigned *remaining, int *first)
{
    if (!node || !*remaining || node[13]) return;
    --*remaining;
    integer_set((const void *)(uintptr_t)word(node, 0), remaining, first);
    if (!*first) putchar(',');
    *first = 0;
    printf("%d", (int32_t)word(node, 16));
    integer_set((const void *)(uintptr_t)word(node, 8), remaining, first);
}
int main(int argc, char **argv)
{
    if (argc != 4) return 2;
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    SetDllDirectoryA("Z:\\tmp\\sdk");
    HMODULE im = LoadLibraryA(argv[1]);
    HMODULE nbr = LoadLibraryA(argv[2]);
    if (!im || !nbr) { fprintf(stderr, "DLL load failed: %lu\n", GetLastError()); return 3; }
    stream_ctor_fn stream_ctor = (stream_ctor_fn)GetProcAddress(nbr, "??0CollectMetaStream@ecs@@QAE@XZ");
    one_arg_fn stream_dtor = (one_arg_fn)GetProcAddress(nbr, "??_DCollectMetaStream@ecs@@QAEXXZ");
    one_arg_fn string_dtor = (one_arg_fn)GetProcAddress(nbr, "??1String@ecs@@QAE@XZ");
    object_io_fn object_io = (object_io_fn)GetProcAddress(nbr, "?io@Object@ecs@@UAEXAAVCodecStream@2@@Z");
    object_json_fn encode_json = (object_json_fn)GetProcAddress(nbr, "?encodeJson@Object@ecs@@QBE?AVString@2@_N@Z");
    if (!stream_ctor || !stream_dtor || !string_dtor || !object_io || !encode_json) return 4;
    FILE *input = fopen(argv[3], "r");
    if (!input) return 5;
    char name[256];
    unsigned rva, code;
    while (fscanf(input, "%x %x %255s", &rva, &code, name) == 3) {
        factory_fn factory = (factory_fn)((unsigned char *)im + rva);
        void *object = factory();
        if (!object) return 6;
        unsigned char stream[64] = {0}, output[32] = {0};
        stream_ctor(stream, 1);
        object_io(object, stream);
        const unsigned char *begin = (const void *)(uintptr_t)word(stream, 12);
        const unsigned char *end = (const void *)(uintptr_t)word(stream, 16);
        if ((uintptr_t)end < (uintptr_t)begin || ((uintptr_t)end - (uintptr_t)begin) % 48 ||
            (uintptr_t)end - (uintptr_t)begin > 48 * 4096) return 7;
        printf("{\"class\":"); quoted(name, strlen(name));
        printf(",\"code\":%u,\"factory_rva\":%u,\"fields\":[", code, rva);
        for (const unsigned char *field = begin; field != end; field += 48) {
            if (field != begin) putchar(',');
            printf("{\"field_id\":%d,\"field_name\":", (int32_t)word(field, 0));
            quoted((const char *)(uintptr_t)word(field, 4), word(field, 8));
            printf(",\"codec_type\":%d,\"codec_flag4\":%u,\"codec_text\":", (int32_t)word(field, 20), field[24]);
            quoted((const char *)(uintptr_t)word(field, 28), word(field, 32));
            printf(",\"codec_flag16\":%u,\"contained\":[", field[36]);
            const unsigned char *head = (const void *)(uintptr_t)word(field, 12);
            unsigned remaining = word(field, 16);
            if (remaining > 4096) return 8;
            int first = 1;
            if (head) integer_set((const void *)(uintptr_t)word(head, 4), &remaining, &first);
            printf("]}");
        }
        encode_json(object, output, 0);
        const char *data = word(output, 20) >= 16 ? (const char *)(uintptr_t)word(output, 0) : (const char *)output;
        printf("],\"defaults\":");
        fwrite(data, 1, word(output, 16), stdout);
        printf("}\n");
        fflush(stdout);
        string_dtor(output);
        stream_dtor(stream);
        delete_fn destroy = (delete_fn)(uintptr_t)word((const void *)(uintptr_t)word(object, 0), 0);
        destroy(object, 1);
    }
    fclose(input);
    return 0;
}
