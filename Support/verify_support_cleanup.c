/* Parent-run memory-lifetime regression for the actual production implementation.
 * Include its translation unit so this exercises the same private cleanup code,
 * not a substitute parser or SDK response. Link the normal support dependencies
 * (native_storage.o, kmc_compat.o, CODEC, private libjson-c.a, OpenSSL, pthread,
 * libm, libdl), but NOT wk_tup_support.o. Retain the production string-factory
 * --wrap flags and add -Wl,--wrap=free for pre-release memory observation.
 * No application, native worker, credential store, or SDK request is started.
 */
#include "wk_tup_support.c"
#include <malloc.h>

struct allocation_watch {
    const void *allocation;
    const unsigned char *bytes;
    size_t length;
    const char *label;
    int released;
};
static struct allocation_watch watches[256];
static size_t watch_count, checked_frees, duplicate_frees;
static int parsing;
static const void *duplicate_allocation;
static const char *parse_needle;

void __real_free(void *allocation);

static void require(int condition, const char *message)
{
    if (!condition) {
        fprintf(stderr, "support cleanup verification failed: %s\n", message);
        abort();
    }
}

void __wrap_free(void *allocation)
{
    if (allocation && parsing && parse_needle) {
        require(!memmem(allocation, malloc_usable_size(allocation),
                         parse_needle, strlen(parse_needle)),
                "plaintext released inside a single parse call");
    }
    if (allocation && allocation == duplicate_allocation) {
        require(parsing, "duplicate value was not released during parsing");
        duplicate_allocation = NULL;
        ++duplicate_frees;
    }
    for (size_t i = 0; allocation && i < watch_count; ++i) {
        struct allocation_watch *watch = &watches[i];
        if (watch->allocation != allocation || watch->released) continue;
        for (size_t offset = 0; offset < watch->length; ++offset) {
            if (watch->bytes[offset]) {
                fprintf(stderr, "support cleanup left bytes in %s at offset %zu\n",
                        watch->label, offset);
                abort();
            }
        }
        watch->released = 1;
        ++checked_frees;
    }
    __real_free(allocation);
}

static void watch_allocation(const void *allocation, const void *bytes, size_t length,
                             const char *label)
{
    if (!allocation) return;
    for (size_t i = 0; i < watch_count; ++i)
        if (watches[i].allocation == allocation && watches[i].bytes == bytes) return;
    require(watch_count < sizeof(watches) / sizeof(watches[0]), "watch capacity");
    watches[watch_count++] = (struct allocation_watch){allocation, bytes, length, label, 0};
}

static void watch_tree(struct json_object *value)
{
    if (json_object_is_type(value, json_type_string)) {
        /* json-c 0.19 _json_object_new_string allocates parsed string bytes
         * inline in the object. No set_string mutation occurs in these tests. */
        watch_allocation(value, json_object_get_string(value),
                         (size_t)json_object_get_string_len(value) + 1, "parsed string");
    } else if (json_object_is_type(value, json_type_object)) {
        json_object_object_foreach(value, name, child) {
            (void)name;
            watch_tree(child);
        }
    } else if (json_object_is_type(value, json_type_array)) {
        size_t count = json_object_array_length(value);
        for (size_t i = 0; i < count; ++i) watch_tree(json_object_array_get_idx(value, i));
    }
}

static void finish_watches(void)
{
    for (size_t i = 0; i < watch_count; ++i)
        require(watches[i].released, "a watched parser allocation was not released");
    watch_count = 0;
}

static void parse_case(const char *input, int include_terminator, enum json_tokener_error expected,
                       const char *expected_secret, int partial_strings)
{
    size_t length = strlen(input);
    struct json_tokener *tokener = support_tokener_new(length);
    require(tokener != NULL, "parser allocation");
    json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    char *scratch = tokener->pb->buf;
    int capacity = tokener->pb->size;
    require((size_t)capacity >= length + 1, "scratch was not reserved before parsing");
    /* Deterministic nonzero slack proves teardown wipes capacity, not bpos or
     * strlen. Parser reset is allowed to clear only the first byte as usual. */
    memset(scratch, 0xa5, (size_t)capacity);
    scratch[0] = 0;
    struct json_object *result = json_tokener_parse_ex(tokener, input,
                                                      (int)length + include_terminator);
    require(json_tokener_get_error(tokener) == expected, "unexpected parse status");
    require(tokener->pb->buf == scratch && tokener->pb->size == capacity,
            "scratch reallocated after receiving sensitive input");
    require((expected == json_tokener_success) == (result != NULL), "parse result ownership");
    watch_allocation(tokener, tokener, sizeof(*tokener), "tokener state");
    watch_allocation(tokener->stack, tokener->stack,
                     (size_t)tokener->max_depth * sizeof(*tokener->stack), "parser stack");
    watch_allocation(tokener->pb, tokener->pb, sizeof(*tokener->pb), "scratch descriptor");
    watch_allocation(scratch, scratch, (size_t)capacity, "full scratch allocation");
    for (int depth = 0; depth < tokener->max_depth; ++depth) {
        watch_tree(tokener->stack[depth].current);
        const char *name = tokener->stack[depth].obj_field_name;
        if (name) watch_allocation(name, name, strlen(name) + 1, "unfinished field name");
    }
    if (partial_strings) require(watch_count > 4, "failure did not retain a partial string");
    support_tokener_free(tokener);
    finish_watches();
    if (result) {
        const char *secret = json_object_is_type(result, json_type_string)
            ? json_object_get_string(result) : native_string(result, "secret", NULL);
        require(secret && expected_secret && !strcmp(secret, expected_secret),
                "successful result was altered by parser teardown");
        watch_tree(result);
        destroy_json(result);
        finish_watches();
    }
}

/* Register the old value BEFORE the parse call that replaces it. This catches
 * the precise json_object_object_add duplicate branch, not later teardown.
 * The first case also proves escaped-equivalent keys retain last-value-wins. */
static void duplicate_case(const char *prefix, const char *suffix, int replace_param)
{
    struct json_tokener *tokener = support_tokener_new(strlen(prefix) + strlen(suffix));
    require(tokener != NULL, "duplicate parser allocation");
    json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    require(json_tokener_parse_ex(tokener, prefix, (int)strlen(prefix)) == NULL &&
            json_tokener_get_error(tokener) == json_tokener_continue,
            "duplicate prefix must leave an incomplete request");
    struct json_object *container = replace_param
        ? native_get(tokener->stack[0].current, "param")
        : tokener->stack[tokener->depth].current;
    struct json_object *previous = native_get(container, "PlainText");
    require(json_object_is_type(previous, json_type_string), "missing old duplicate string");
    watch_tree(previous);
    duplicate_allocation = previous;
    size_t before = duplicate_frees;
    parsing = 1;
    struct json_object *result = json_tokener_parse_ex(tokener, suffix, (int)strlen(suffix) + 1);
    parsing = 0;
    require(result && json_tokener_get_error(tokener) == json_tokener_success,
            "duplicate field must remain valid JSON");
    require(!duplicate_allocation && duplicate_frees == before + 1,
            "duplicate release was not observed during the replacing parse");
    finish_watches();
    require(!strcmp(native_string(native_get(result, "param"), "PlainText", ""), "replacement"),
            "duplicate field must preserve last-value-wins");
    support_tokener_free(tokener);
    watch_tree(result);
    destroy_json(result);
    finish_watches();
}

static void single_call_duplicate_case(void)
{
    static const char input[] =
        "{\"param\":{\"PlainText\":\"SINGLE-CALL-DUPLICATE-SECRET\","
        "\"PlainText\":\"replacement\"}}";
    struct json_tokener *tokener = support_tokener_new(sizeof(input) - 1);
    require(tokener != NULL, "single-call parser allocation");
    json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    /* Inspect ALL frees while json-c is parsing, before watches can be
     * registered afterward. No allocator or JSON behavior is substituted. */
    parse_needle = "SINGLE-CALL-DUPLICATE-SECRET";
    parsing = 1;
    struct json_object *result = json_tokener_parse_ex(tokener, input, sizeof(input));
    parsing = 0;
    parse_needle = NULL;
    require(result && json_tokener_get_error(tokener) == json_tokener_success,
            "single-call duplicate must remain valid JSON");
    require(!strcmp(native_string(native_get(result, "param"), "PlainText", ""), "replacement"),
            "single-call duplicate must preserve last-value-wins");
    support_tokener_free(tokener);
    watch_tree(result);
    destroy_json(result);
    finish_watches();
}

int main(void)
{
    support_tokener_free(NULL);
    parse_case("\"synthetic\\nsecret\"", 1, json_tokener_success, "synthetic\nsecret", 0);
    char secret[2049], input[2300];
    memset(secret, 'S', sizeof(secret) - 1);
    secret[sizeof(secret) - 1] = 0;
    int count = snprintf(input, sizeof(input), "{\"secret\":\"%s\",\"tail\":1}", secret);
    require(count > 0 && (size_t)count < sizeof(input), "long success input");
    parse_case(input, 1, json_tokener_success, secret, 0);
    parse_case("{\"outer\":{\"saved\":\"synthetic-complete\",\"unfinished\":\"synthetic\\q\"}}",
               1, json_tokener_error_parse_string, NULL, 1);
    parse_case("{\"outer\":[\"synthetic-complete\",{\"unfinished\":\"synthetic-partial",
               1, json_tokener_error_parse_eof, NULL, 1);
    parse_case("{\"outer\":[\"synthetic-complete\",{\"unfinished\":\"synthetic-partial",
               0, json_tokener_continue, NULL, 1);
    parse_case("{\"unfinished-sensitive-field\"", 1, json_tokener_error_parse_eof, NULL, 1);
    parse_case("{\"secret\":\"synthetic-complete\"}x", 1,
               json_tokener_error_parse_unexpected, NULL, 1);
    parse_case("{\"saved\":\"synthetic-complete\",\"secret\":\"invalid-\xff\"}", 1,
               json_tokener_error_parse_utf8_string, NULL, 1);
    char nested[256];
    const char *prefix = "{\"secret\":\"synthetic-depth\",\"nested\":";
    size_t used = strlen(prefix);
    memcpy(nested, prefix, used);
    memset(nested + used, '[', 40);
    nested[used + 40] = 0;
    parse_case(nested, 1, json_tokener_error_depth, NULL, 1);
    duplicate_case("{\"cmd\":262151,\"param\":{\"PlainText\":\"synthetic-old\\u0000-tail\",",
                   "\"\\u0050lainText\":\"replacement\"}}", 0);
    duplicate_case("{\"cmd\":262151,\"param\":{\"PlainText\":\"synthetic-old-subtree\"},",
                   "\"param\":{\"PlainText\":\"replacement\"}}", 1);
    single_call_duplicate_case();
    OPENSSL_cleanse(secret, sizeof(secret));
    OPENSSL_cleanse(input, sizeof(input));
    OPENSSL_cleanse(nested, sizeof(nested));
    printf("support secure parser cleanup: 12 cases, %zu cleansed frees, %zu during-parse duplicates\n",
           checked_frees, duplicate_frees);
    return 0;
}
