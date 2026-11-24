/* Parent-only synthetic oracle helper. Link into the existing ia32 IM probe and
 * call im_oracle_dump_database_keys("fixture-user") AFTER its real cmd1 callback.
 * Never run this in a production Wine prefix. It neither starts the SDK nor
 * opens a DB, sends a command, changes a keystore, or calls SDK shutdown.
 * Matched im_ecsdata.dll SHA256:
 * d0525e8f286c7b47e6e516065885bb94d801ea35af7e18b48b3b360f8208f627 */
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#if !defined(__i386__)
#error This helper requires the original ia32 MSVC ABI
#endif
#define THIS __attribute__((thiscall))
struct msvc_string {
    union { char small[16]; const char *heap; } storage;
    uint32_t length, capacity;
};
typedef void *(__cdecl *instance_fn)(void);
typedef struct msvc_string *(THIS *get_key_fn)(void *, struct msvc_string *, int);
typedef void (THIS *string_destroy_fn)(struct msvc_string *);

static int copy_string(const struct msvc_string *value, char *output, size_t capacity)
{
    if (value->length >= capacity || value->capacity < value->length) return 0;
    const char *data = value->capacity < 16 ? value->storage.small : value->storage.heap;
    SIZE_T copied = 0;
    if (!ReadProcessMemory(GetCurrentProcess(), data, output, value->length, &copied) || copied != value->length) return 0;
    output[value->length] = 0;
    return 1;
}

int im_oracle_dump_database_keys(const char *expected_synthetic_account)
{
    if (!expected_synthetic_account || strcmp(expected_synthetic_account, "fixture-user")) return 60;
    HMODULE module = GetModuleHandleW(L"im_ecsdata.dll");
    if (!module) return 61;
    const unsigned char *image = (const unsigned char *)module;
    const IMAGE_DOS_HEADER *dos = (const IMAGE_DOS_HEADER *)image;
    const IMAGE_NT_HEADERS32 *nt = (const IMAGE_NT_HEADERS32 *)(image + dos->e_lfanew);
    if (dos->e_magic != IMAGE_DOS_SIGNATURE || nt->Signature != IMAGE_NT_SIGNATURE ||
        nt->OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR32_MAGIC ||
        nt->OptionalHeader.SizeOfImage != 0x35f000 || nt->FileHeader.TimeDateStamp != 0x6745723f) return 62;
    instance_fn instance = (instance_fn)GetProcAddress(module,
        "?Instance@ECSData@ecsdata@ecs@@SAPAV123@XZ");
    get_key_fn get_key = (get_key_fn)GetProcAddress(module,
        "?GetDBKey@ECSData@ecsdata@ecs@@QBE?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@_N@Z");
    if (!instance || !get_key) return 63;
    void *context = instance();
    if (!context) return 64;
    struct msvc_string account;
    SIZE_T copied = 0;
    if (!ReadProcessMemory(GetCurrentProcess(), (const char *)context + 0x710,
                           &account, sizeof account, &copied) || copied != sizeof account) return 65;
    char account_text[128];
    if (!copy_string(&account, account_text, sizeof account_text) ||
        strcmp(account_text, expected_synthetic_account)) return 66;
    string_destroy_fn destroy = (string_destroy_fn)(image + 0x108d0);
    for (int public_key = 0; public_key <= 1; ++public_key) {
        struct msvc_string key = {0};
        key.capacity = 15;
        struct msvc_string *returned = get_key(context, &key, public_key);
        char value[1024];
        if (returned != &key || !copy_string(&key, value, sizeof value)) {
            destroy(&key); return 67;
        }
        printf("IM_DB_KEY %s length=%u bytes_hex=", public_key ? "public" : "private", key.length);
        for (uint32_t n = 0; n < key.length; ++n) printf("%02x", (unsigned char)value[n]);
        putchar('\n'); fflush(stdout);
        SecureZeroMemory(value, sizeof value);
        if (key.capacity >= 16 && key.storage.heap) SecureZeroMemory((void *)key.storage.heap, key.length);
        destroy(&key);
    }
    return 0;
}
