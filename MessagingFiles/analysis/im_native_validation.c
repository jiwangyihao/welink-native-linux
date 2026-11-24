/* Parent-run, synthetic-only validation; never part of a production library.
 * Build ia32, with the supplied PRIVATE json-c 0.19 static archive, GLib,
 * native_storage.c, kmc_compat.c and the project's sqlite3mc amalgamation.
 * Do not also compile im_transport_codec.c: this TU includes its actual code
 * so that nested/code-zero models are selected by name, not guessed codes.
 * The Python entrypoint documents arguments and records scenario verdicts.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>
#include <unistd.h>
#include <sys/wait.h>
#include <glib.h>
#include <json-c/json.h>
#include "../im_transport_codec.c"
#include "native_storage.h"

#if JSON_C_MAJOR_VERSION != 0 || JSON_C_MINOR_VERSION != 19
#error Use the supplied private json-c 0.19 headers and static archive, not system 0.18
#endif

static GMutex output_mutex;
static gint failures;
static void emit(struct json_object *event)
{
    g_mutex_lock(&output_mutex);
    puts(json_object_to_json_string_ext(event, JSON_C_TO_STRING_PLAIN));
    fflush(stdout);
    g_mutex_unlock(&output_mutex);
    json_object_put(event);
}
static struct json_object *event_new(const char *type)
{
    struct json_object *event = json_object_new_object();
    json_object_object_add(event, "event", json_object_new_string(type));
    return event;
}
static void problem(const char *where, const char *detail)
{
    g_atomic_int_inc(&failures);
    struct json_object *event = event_new("error");
    json_object_object_add(event, "where", json_object_new_string(where));
    json_object_object_add(event, "detail", json_object_new_string(detail));
    emit(event);
}
static const char *text_member(struct json_object *object, const char *key)
{
    struct json_object *item = member(object, key);
    return json_object_is_type(item, json_type_string) ? json_object_get_string(item) : NULL;
}
static int64_t integer_member(struct json_object *object, const char *key, int64_t fallback)
{
    struct json_object *item = member(object, key);
    return json_object_is_type(item, json_type_int) ? json_object_get_int64(item) : fallback;
}
static struct json_object *parse_json(const char *text)
{
    struct json_tokener *tokener = json_tokener_new();
    json_tokener_set_flags(tokener, JSON_TOKENER_STRICT);
    struct json_object *value = json_tokener_parse_ex(tokener, text, (int)strlen(text) + 1);
    enum json_tokener_error error = json_tokener_get_error(tokener);
    json_tokener_free(tokener);
    if (error != json_tokener_success) { json_object_put(value); return NULL; }
    return value;
}

/* Comparison follows the declared field type. It does NOT cast arbitrary
 * JSON strings/numbers/bools, discard unknown keys, sort arrays, or equate
 * absent required values with zero. Optional empty arrays/maps are the only
 * hide-empty equivalence. Original null versus {} is the empty model form. */
static gboolean empty_collection(struct json_object *value, unsigned kind)
{
    return !value || (kind == 26 && json_object_is_type(value, json_type_array) &&
        !json_object_array_length(value)) || (kind == 28 && json_object_is_type(value, json_type_object) &&
        !json_object_object_length(value));
}
static const struct nbr_field *named_field(int model, const char *name)
{
    for (unsigned n = 0; n < models[model].count; ++n)
        if (!strcmp(models[model].fields[n].name, name)) return &models[model].fields[n];
    return NULL;
}
static gboolean typed_equal(unsigned kind, int child, unsigned element,
                             struct json_object *expected, struct json_object *actual, unsigned depth);
static gboolean model_equal(int model, struct json_object *expected, struct json_object *actual, unsigned depth)
{
    if (depth > NBR_DEPTH || model < 0 || model >= (int)MODEL_COUNT) return FALSE;
    if (expected && !json_object_is_type(expected, json_type_object)) return FALSE;
    if (actual && !json_object_is_type(actual, json_type_object)) return FALSE;
    if (expected) {
        json_object_object_foreach(expected, key, unused) {
            (void)unused;
            if (!named_field(model, key)) return FALSE;
        }
    }
    if (actual) {
        json_object_object_foreach(actual, key, unused) {
            (void)unused;
            if (!named_field(model, key)) return FALSE;
        }
    }
    for (unsigned n = 0; n < models[model].count; ++n) {
        const struct nbr_field *field = &models[model].fields[n];
        struct json_object *a = member(expected, field->name), *b = member(actual, field->name);
        if (field->optional && (field->kind == 26 || field->kind == 28) &&
            empty_collection(a, field->kind) && empty_collection(b, field->kind)) continue;
        if (!typed_equal(field->kind, field->child, field->element_kind, a, b, depth + 1)) return FALSE;
    }
    return TRUE;
}
static gboolean wide_integer(struct json_object *value, gboolean is_signed, char result[32])
{
    if (!json_object_is_type(value, json_type_string) && !json_object_is_type(value, json_type_int)) return FALSE;
    const char *text = json_object_get_string(value);
    if (!text || !*text || *text == '+' || g_ascii_isspace(*text)) return FALSE;
    char *end;
    errno = 0;
    if (is_signed) {
        int64_t number = strtoll(text, &end, 10);
        if (errno || *end) return FALSE;
        snprintf(result, 32, "%" PRId64, number);
    } else {
        if (*text == '-') return FALSE;
        uint64_t number = strtoull(text, &end, 10);
        if (errno || *end) return FALSE;
        snprintf(result, 32, "%" PRIu64, number);
    }
    return TRUE;
}
static gboolean typed_equal(unsigned kind, int child, unsigned element,
                             struct json_object *expected, struct json_object *actual, unsigned depth)
{
    if (depth > NBR_DEPTH) return FALSE;
    if (kind == 22) return child < 0 ? !expected && !actual : model_equal(child, expected, actual, depth + 1);
    if (!expected || !actual) return expected == actual;
    if (kind == 4 || kind == 8) {
        char a[32], b[32];
        return wide_integer(expected, kind == 4, a) && wide_integer(actual, kind == 4, b) && !strcmp(a, b);
    }
    if (kind == 0) {
        if (!json_object_is_type(expected, json_type_boolean) || !json_object_is_type(actual, json_type_boolean)) return FALSE;
        return json_object_get_boolean(expected) == json_object_get_boolean(actual);
    }
    if (kind <= 8) return json_object_is_type(expected, json_type_int) &&
        json_object_is_type(actual, json_type_int) && json_object_equal(expected, actual);
    if (kind == 13 || kind == 16) return json_object_is_type(expected, json_type_string) &&
        json_object_is_type(actual, json_type_string) && json_object_equal(expected, actual);
    if (kind == 28) return json_object_is_type(expected, json_type_object) &&
        json_object_is_type(actual, json_type_object) && json_object_equal(expected, actual);
    if (kind != 26 || !json_object_is_type(expected, json_type_array) || !json_object_is_type(actual, json_type_array)) return FALSE;
    size_t count = json_object_array_length(expected);
    if (count != json_object_array_length(actual)) return FALSE;
    for (size_t n = 0; n < count; ++n)
        if (!typed_equal(element, child, 0, json_object_array_get_idx(expected, n),
                         json_object_array_get_idx(actual, n), depth + 1)) return FALSE;
    return TRUE;
}
static GByteArray *unhex(const char *text)
{
    if (!text) return NULL;
    size_t characters = strlen(text);
    if (!characters || characters % 2 || characters / 2 > NBR_LIMIT) return NULL;
    size_t length = characters / 2;
    GByteArray *bytes = g_byte_array_sized_new(length);
    g_byte_array_set_size(bytes, length);
    for (size_t n = 0; n < length; ++n) {
        int high = g_ascii_xdigit_value(text[2*n]), low = g_ascii_xdigit_value(text[2*n+1]);
        if (high < 0 || low < 0) { g_byte_array_unref(bytes); return NULL; }
        bytes->data[n] = (unsigned char)((high << 4) | low);
    }
    return bytes;
}
static struct json_object *hex_json(const GByteArray *bytes)
{
    static const char digits[] = "0123456789abcdef";
    char *text = g_malloc(2 * (size_t)bytes->len + 1);
    for (guint n = 0; n < bytes->len; ++n) {
        text[2*n] = digits[bytes->data[n] >> 4]; text[2*n+1] = digits[bytes->data[n] & 15];
    }
    text[2 * (size_t)bytes->len] = 0;
    struct json_object *result = json_object_new_string(text);
    g_free(text);
    return result;
}
static int run_codec(const char *path)
{
    FILE *file = fopen(path, "r");
    if (!file) { problem("corpus", strerror(errno)); return 1; }
    int defaults_status = initialize_defaults();
    char *line = NULL; size_t capacity = 0; unsigned rows = 0, passed = 0, zero_code = 0;
    while (getline(&line, &capacity, file) >= 0) {
        ++rows;
        struct json_object *row = parse_json(line), *record = event_new("vector");
        json_object_object_add(record, "row", json_object_new_int(rows));
        json_object_object_add(record, "original", json_object_get(row));
        const char *name = text_member(row, "class");
        int model = -1;
        if (name) for (size_t n = 0; n < MODEL_COUNT; ++n)
            if (!strcmp(name, models[n].name)) { model = (int)n; break; }
        struct json_object *input = NULL, *normalized = NULL;
        gboolean valid = row && name && model >= 0 && !defaults_status &&
            json_object_object_get_ex(row, "input", &input) &&
            json_object_object_get_ex(row, "normalized", &normalized);
        GByteArray *original[2] = {unhex(text_member(row, "nbr0")), unhex(text_member(row, "nbr1"))};
        gboolean ok = valid && original[0] && original[1];
        GByteArray *encoded = g_byte_array_new();
        int encode_status = valid ? encode_object(encoded, model, input, 0) : EINVAL;
        json_object_object_add(record, "encode_status", json_object_new_int(encode_status));
        json_object_object_add(record, "native_nbr1", hex_json(encoded));
        gboolean same = !encode_status && original[1] && encoded->len == original[1]->len &&
            !memcmp(encoded->data, original[1]->data, encoded->len);
        json_object_object_add(record, "encode_exact", json_object_new_boolean(same));
        ok &= same;
        if (model >= 0) {
            if (!models[model].code) ++zero_code;
            json_object_object_add(record, "model_code", json_object_new_int(models[model].code));
        }
        for (unsigned hide = 0; hide < 2; ++hide) {
            struct json_object *decoded = NULL;
            int status = EINVAL;
            if (valid && original[hide]) {
                struct cursor cursor = {original[hide]->data, original[hide]->data + original[hide]->len, 0};
                decoded = decode_object(&cursor, model, 0);
                status = cursor.error ? cursor.error : cursor.current == cursor.end ? 0 : EBADMSG;
            }
            gboolean equal = !status && model_equal(model, normalized, decoded, 0);
            char key[40];
            snprintf(key, sizeof key, "decode%u_status", hide);
            json_object_object_add(record, key, json_object_new_int(status));
            snprintf(key, sizeof key, "decoded%u", hide);
            json_object_object_add(record, key, decoded);
            snprintf(key, sizeof key, "decode%u_typed_equal", hide);
            json_object_object_add(record, key, json_object_new_boolean(equal));
            ok &= equal;
        }
        json_object_object_add(record, "pass", json_object_new_boolean(ok));
        if (ok) ++passed; else g_atomic_int_inc(&failures);
        emit(record);
        for (unsigned n = 0; n < 2; ++n) if (original[n]) g_byte_array_unref(original[n]);
        g_byte_array_unref(encoded); json_object_put(row);
    }
    if (ferror(file)) problem("corpus", "read failed");
    free(line); fclose(file);
    if (rows != 401) problem("corpus", "requires all 401 physical JSONL rows");
    if (!zero_code) problem("corpus", "no named code-zero models exercised");
    struct json_object *summary = event_new("codec_summary");
    json_object_object_add(summary, "rows", json_object_new_int(rows));
    json_object_object_add(summary, "passed", json_object_new_int(passed));
    json_object_object_add(summary, "code_zero_rows", json_object_new_int(zero_code));
    emit(summary);
    return g_atomic_int_get(&failures) ? 1 : 0;
}

/* Storage helpers below are linked from the real native implementation. They
 * are used ONLY for encrypted-file inspection and an external SQLite lock.
 * All account initialization and CRUD use the public SDK function pointers. */
static int open_private(const char *kmc, const char *directory, const char *filename, sqlite3 **database)
{
    struct native_storage_key key = {0};
    char *metadata = g_build_filename(directory, "config_private.db", NULL);
    int status = native_storage_load_key(metadata, kmc, "fixture-user", 0, &key);
    g_free(metadata);
    if (!status && strcmp(key.plain, "fixture-user")) status = EACCES;
    if (!status) {
        char *path = g_build_filename(directory, filename, NULL);
        FILE *file = fopen(path, "rb");
        unsigned char header[16] = {0};
        size_t size = file ? fread(header, 1, sizeof header, file) : 0;
        if (file) fclose(file);
        if (size != sizeof header || !memcmp(header, "SQLite format 3\0", 16)) status = EINVAL;
        if (!status) status = native_storage_open(path, key.password, 0, database);
        g_free(path);
    }
    native_storage_clear_key(&key);
    return status;
}

/* POSIX record locks are process-owned. A second private SQLite instance in
 * this process cannot provide the external lock required by the lifecycle test. */
static int lock_holder(const char *kmc, const char *directory)
{
    sqlite3 *database = NULL;
    int status = open_private(kmc, directory, "user.db", &database);
    if (!status) status = sqlite3_exec(database, "BEGIN IMMEDIATE", NULL, NULL, NULL);
    ssize_t sent;
    do sent = write(STDOUT_FILENO, &status, sizeof status); while (sent < 0 && errno == EINTR);
    if (sent != sizeof status) status = EIO;
    if (!status) {
        char release;
        ssize_t received;
        do received = read(STDIN_FILENO, &release, 1); while (received < 0 && errno == EINTR);
        status = received < 0 ? errno : sqlite3_exec(database, "ROLLBACK", NULL, NULL, NULL);
    }
    if (database) {
        int closed = sqlite3_close(database);
        if (!status) status = closed;
    }
    return status ? 1 : 0;
}
static struct json_object *sql_rows(sqlite3 *database, const char *sql, int *status)
{
    struct json_object *rows = json_object_new_array();
    sqlite3_stmt *statement = NULL;
    *status = sqlite3_prepare_v2(database, sql, -1, &statement, NULL);
    if (!*status && !sqlite3_stmt_readonly(statement)) *status = SQLITE_MISUSE;
    while (!*status) {
        int step = sqlite3_step(statement);
        if (step == SQLITE_DONE) break;
        if (step != SQLITE_ROW) { *status = step; break; }
        struct json_object *row = json_object_new_object();
        for (int n = 0; n < sqlite3_column_count(statement); ++n) {
            struct json_object *value = NULL;
            if (sqlite3_column_type(statement, n) == SQLITE_INTEGER)
                value = json_object_new_int64(sqlite3_column_int64(statement, n));
            else if (sqlite3_column_type(statement, n) != SQLITE_NULL)
                value = json_object_new_string_len((const char *)sqlite3_column_text(statement, n), sqlite3_column_bytes(statement, n));
            json_object_object_add(row, sqlite3_column_name(statement, n), value);
        }
        json_object_array_add(rows, row);
    }
    sqlite3_finalize(statement);
    return rows;
}
static int inspect_fixture(const char *kmc, const char *directory)
{
    static const char *names[] = {"user.db", "history.db", "conversation.db"};
    for (unsigned n = 0; n < G_N_ELEMENTS(names); ++n) {
        struct json_object *record = event_new("database_inspection");
        json_object_object_add(record, "filename", json_object_new_string(names[n]));
        sqlite3 *database = NULL;
        int status = open_private(kmc, directory, names[n], &database);
        if (!status) {
            json_object_object_add(record, "schema", sql_rows(database,
                "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name", &status));
            if (!status) json_object_object_add(record, "user_version", sql_rows(database, "PRAGMA user_version", &status));
            if (!status && (n == 1 || n == 2)) json_object_object_add(record, "db_version", sql_rows(database,
                "SELECT VERSION_KEY,VERSION_VALUE FROM DBVersionTab ORDER BY VERSION_KEY", &status));
            if (!status && !n) json_object_object_add(record, "account", sql_rows(database,
                "SELECT KEY,VALUE FROM UserConfigTab WHERE KEY='loginaccount'", &status));
        }
        if (database) { int close_status = sqlite3_close(database); if (!status) status = close_status; }
        json_object_object_add(record, "status", json_object_new_int(status));
        emit(record);
        if (status) problem(names[n], "encrypted original-format inspection failed (no plaintext fallback)");
    }
    return g_atomic_int_get(&failures) ? 1 : 0;
}

typedef int (*db_callback_fn)(const char *);
typedef int (*db_init_fn)(const char *, const char *, const char *, db_callback_fn);
typedef void (*db_send_fn)(const char *);
typedef void (*db_stop_fn)(void);
typedef int (*db_pump_fn)(void);
static db_init_fn db_init;
static db_send_fn db_send;
static db_stop_fn db_stop;
static db_pump_fn db_pump;
static GThread *owner;
static gint pumping;
static gint callback_count;
static GMutex seen_mutex;
static GArray *seen;
static char *log_path, *app_path, *kmc_path;
static int generation;
static int64_t shutdown_sno = INT64_MIN;
static GPid lock_process;
static int lock_input = -1, lock_output = -1;
static const gint64 nonblocking_limit_us = 250000;
static int service_init(void);

static int release_external_lock(void)
{
    if (!lock_process) return EINVAL;
    close(lock_input); close(lock_output);
    lock_input = lock_output = -1;
    int status = 0;
    pid_t waited;
    do waited = waitpid(lock_process, &status, 0); while (waited < 0 && errno == EINTR);
    g_spawn_close_pid(lock_process); lock_process = 0;
    return waited < 0 ? errno : WIFEXITED(status) && !WEXITSTATUS(status) ? 0 : EIO;
}

static int acquire_external_lock(const char *directory)
{
    if (!directory || lock_process) return EINVAL;
    char *executable = g_file_read_link("/proc/self/exe", NULL);
    if (!executable) return EIO;
    char *arguments[] = {executable, "hold-lock", kmc_path, (char *)directory, NULL};
    gboolean started = g_spawn_async_with_pipes(NULL, arguments, NULL, G_SPAWN_DO_NOT_REAP_CHILD,
        NULL, NULL, &lock_process, &lock_input, &lock_output, NULL, NULL);
    g_free(executable);
    if (!started) { lock_process = 0; return EIO; }
    int status = 0;
    ssize_t received;
    do received = read(lock_output, &status, sizeof status); while (received < 0 && errno == EINTR);
    if (received != sizeof status) status = EIO;
    if (status) release_external_lock();
    return status;
}
static int callback(const char *raw)
{
    gboolean on_owner = g_thread_self() == owner, in_pump = g_atomic_int_get(&pumping) != 0;
    struct json_object *reply = parse_json(raw ? raw : "");
    int64_t sno = integer_member(reply, "sno", INT64_MIN);
    struct json_object *record = event_new("callback");
    json_object_object_add(record, "raw", json_object_new_string(raw ? raw : ""));
    json_object_object_add(record, "reply", json_object_get(reply));
    json_object_object_add(record, "owner", json_object_new_boolean(on_owner));
    json_object_object_add(record, "inside_pump", json_object_new_boolean(in_pump));
    json_object_object_add(record, "generation", json_object_new_int(g_atomic_int_get(&generation)));
    emit(record);
    if (!on_owner || !in_pump || !json_object_is_type(reply, json_type_object) || sno == INT64_MIN)
        problem("callback", "foreign-thread, pre-pump, or malformed callback");
    g_mutex_lock(&seen_mutex); g_array_append_val(seen, sno); g_mutex_unlock(&seen_mutex);
    g_atomic_int_inc(&callback_count);
    if (on_owner && in_pump && sno == shutdown_sno) {
        shutdown_sno = INT64_MIN;
        int nested = db_pump();
        gint64 started = g_get_monotonic_time(); db_stop();
        gint64 duration = g_get_monotonic_time() - started;
        int busy = service_init();
        struct json_object *event = event_new("reentrant_shutdown");
        json_object_object_add(event, "nested_dispatch", json_object_new_int(nested));
        json_object_object_add(event, "duration_us", json_object_new_int64(duration));
        json_object_object_add(event, "immediate_init", json_object_new_int(busy));
        emit(event);
        if (nested != 0 || duration > nonblocking_limit_us || busy != EALREADY)
            problem("reentrant_shutdown", "nested dispatch, blocking shutdown, or no busy cleanup interval");
    }
    json_object_put(reply);
    return 0;
}
static int service_init(void)
{
    return db_init(log_path, app_path, kmc_path, callback);
}
static gboolean has_seen(int64_t sno)
{
    gboolean found = FALSE;
    g_mutex_lock(&seen_mutex);
    for (guint n = 0; n < seen->len; ++n) if (g_array_index(seen, int64_t, n) == sno) { found = TRUE; break; }
    g_mutex_unlock(&seen_mutex);
    return found;
}
static int owner_pump(void)
{
    g_atomic_int_set(&pumping, 1);
    int result = db_pump();
    g_atomic_int_set(&pumping, 0);
    if (result < 0) problem("dispatch", "owner pump returned an error");
    return result;
}
static gpointer foreign_pump(gpointer unused)
{
    (void)unused;
    return GINT_TO_POINTER(db_pump());
}
static unsigned log_lines(void)
{
    char *path = g_build_filename(log_path, "sqlite_plugin.log", NULL);
    FILE *file = fopen(path, "r"); g_free(path);
    unsigned count = 0;
    if (file) { int c; while ((c = fgetc(file)) != EOF) if (c == '\n') ++count; fclose(file); }
    return count;
}
static int run_script(const char *library, const char *script)
{
    void *module = dlopen(library, RTLD_NOW | RTLD_LOCAL);
    if (!module) { problem("dlopen", dlerror()); return 1; }
    db_init = (db_init_fn)dlsym(module, "InitSqliteService");
    db_send = (db_send_fn)dlsym(module, "SqliteServiceSendMsg");
    db_stop = (db_stop_fn)dlsym(module, "SqliteServiceShutdown");
    db_pump = (db_pump_fn)dlsym(module, "SqliteServiceDispatchCallbacks");
    if (!db_init || !db_send || !db_stop || !db_pump) { problem("ABI", "missing exact public SQLite exports"); return 1; }
    FILE *file = fopen(script, "r");
    if (!file) { problem("script", strerror(errno)); return 1; }
    owner = g_thread_self(); seen = g_array_new(FALSE, FALSE, sizeof(int64_t));
    char *line = NULL; size_t capacity = 0; unsigned number = 0;
    while (getline(&line, &capacity, file) >= 0) {
        ++number;
        struct json_object *instruction = parse_json(line);
        const char *op = text_member(instruction, "op");
        struct json_object *record = event_new("operation");
        json_object_object_add(record, "line", json_object_new_int(number));
        json_object_object_add(record, "instruction", json_object_get(instruction));
        int status = 0;
        gint64 milliseconds = integer_member(instruction, "ms", 10000);
        if (milliseconds < 0 || milliseconds > 120000) { problem("script", "invalid deadline"); milliseconds = 0; }
        gint64 deadline = g_get_monotonic_time() + milliseconds * 1000;
        if (!op) problem("script", "invalid operation");
        else if (!strcmp(op, "init")) {
            const char *log = text_member(instruction, "log"), *app = text_member(instruction, "app"), *kmc = text_member(instruction, "kmc");
            if (!log || !app || !kmc || log_path) problem(op, "init requires explicit log/app/kmc paths once");
            else {
                log_path = g_strdup(log); app_path = g_strdup(app); kmc_path = g_strdup(kmc);
                status = service_init();
                if (status) problem(op, "public InitSqliteService failed"); else g_atomic_int_inc(&generation);
            }
        } else if (!log_path) problem("script", "first operation must initialize service");
        else if (!strcmp(op, "send")) {
            struct json_object *request = member(instruction, "request");
            if (!json_object_is_type(request, json_type_object)) problem(op, "request must be an object");
            else db_send(json_object_to_json_string_ext(request, JSON_C_TO_STRING_PLAIN));
        } else if (!strcmp(op, "await")) {
            int64_t sno = integer_member(instruction, "sno", INT64_MIN);
            while (!has_seen(sno) && g_get_monotonic_time() < deadline) { owner_pump(); g_usleep(1000); }
            if (sno == INT64_MIN || !has_seen(sno)) problem(op, "callback deadline expired");
        } else if (!strcmp(op, "pause")) {
            g_usleep(milliseconds * 1000);
        } else if (!strcmp(op, "pump")) {
            do { owner_pump(); g_usleep(1000); } while (g_get_monotonic_time() < deadline);
        } else if (!strcmp(op, "foreign_pump")) {
            GThread *thread = g_thread_new("foreign-im-validator", foreign_pump, NULL);
            status = GPOINTER_TO_INT(g_thread_join(thread));
            if (status != -EPERM) problem(op, "foreign owner pump must return -EPERM");
        } else if (!strcmp(op, "arm_shutdown")) {
            shutdown_sno = integer_member(instruction, "sno", INT64_MIN);
            if (shutdown_sno == INT64_MIN) problem(op, "missing callback serial");
        } else if (!strcmp(op, "shutdown")) {
            gint64 started = g_get_monotonic_time(); db_stop();
            gint64 elapsed = g_get_monotonic_time() - started;
            json_object_object_add(record, "duration_us", json_object_new_int64(elapsed));
            if (elapsed > nonblocking_limit_us) problem(op, "shutdown blocked the owner");
        } else if (!strcmp(op, "expect_busy")) {
            status = service_init();
            if (status != EALREADY) problem(op, "cleanup must still be busy while external writer holds lock");
        } else if (!strcmp(op, "reinit")) {
            unsigned busy = 0;
            do {
                status = service_init();
                if (status != EALREADY) break;
                ++busy; g_usleep(1000);
            } while (g_get_monotonic_time() < deadline);
            json_object_object_add(record, "busy_observations", json_object_new_int(busy));
            if (status) problem(op, "cleanup/reinit failed or timed out"); else g_atomic_int_inc(&generation);
        } else if (!strcmp(op, "wait_log")) {
            unsigned count = (unsigned)integer_member(instruction, "count", UINT_MAX);
            while (log_lines() < count && g_get_monotonic_time() < deadline) g_usleep(1000);
            if (log_lines() < count) problem(op, "worker completion barrier timed out");
        } else if (!strcmp(op, "lock")) {
            status = acquire_external_lock(text_member(instruction, "directory"));
            if (status) problem(op, "could not hold real encrypted SQLite writer lock");
        } else if (!strcmp(op, "unlock")) {
            status = release_external_lock();
            if (status) problem(op, "could not release external writer lock");
        } else problem("script", "unknown operation");
        json_object_object_add(record, "status", json_object_new_int(status));
        json_object_object_add(record, "callbacks", json_object_new_int(g_atomic_int_get(&callback_count)));
        emit(record); json_object_put(instruction);
        if (g_atomic_int_get(&failures)) break;
    }
    if (ferror(file)) problem("script", "read failed");
    free(line); fclose(file);
    if (log_path) db_stop();
    if (lock_process) release_external_lock();
    /* Never dlclose an SDK with asynchronous cleanup. Process isolation is
     * intentional; scripts explicitly prove cleanup by successful reinit. */
    struct json_object *summary = event_new("script_summary");
    json_object_object_add(summary, "failures", json_object_new_int(g_atomic_int_get(&failures)));
    json_object_object_add(summary, "callbacks", json_object_new_int(g_atomic_int_get(&callback_count)));
    emit(summary);
    return g_atomic_int_get(&failures) ? 1 : 0;
}
int main(int argc, char **argv)
{
    if (sizeof(void *) != 4 || JSON_C_VERSION_NUM != json_c_version_num()) {
        problem("prerequisite", "requires ia32 and exactly the linked private json-c 0.19 build"); return 2;
    }
    if (argc == 4 && !strcmp(argv[1], "hold-lock")) return lock_holder(argv[2], argv[3]);
    struct json_object *runtime = event_new("runtime");
    json_object_object_add(runtime, "pointer_bits", json_object_new_int(8 * sizeof(void *)));
    json_object_object_add(runtime, "json_c", json_object_new_string(json_c_version()));
    emit(runtime);
    if (argc == 3 && !strcmp(argv[1], "codec")) return run_codec(argv[2]);
    if (argc == 4 && !strcmp(argv[1], "inspect")) return inspect_fixture(argv[2], argv[3]);
    if (argc == 4 && !strcmp(argv[1], "database")) return run_script(argv[2], argv[3]);
    fprintf(stderr, "usage: im_native_validation codec CORPUS | inspect KMC PRIVATE_DB_DIR | database NATIVE_LIBRARY SCRIPT_JSONL\n");
    return 2;
}
