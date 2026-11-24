/* Native contact backend; ABI/DDL recovered from the original contact plugin.
 * This is its own account database, not the pedestal/IM SQLite command service.
 * All callbacks run outside the lock. The RPC callback belongs to Startup's
 * thread; short-lived SQL callbacks are invoked before the corresponding return.
 * Original ABI/DDL evidence is in analysis/plugin.c and analysis/decompiled.c.
 */
#define _GNU_SOURCE
#include "contact_sqlite_plugin.h"
#include "../native_rpc.h"
#include "../native_storage.h"
#include "../kmc_compat.h"
#include "contact_schema.h"
#include <glib.h>
#include <openssl/crypto.h>
#include <openssl/rand.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#define ARRAY_SIZE(a) (sizeof(a) / sizeof((a)[0]))
static GMutex contact_lock;
static GThread *owner;
static contact_callback service_callback;
static GQueue callbacks = G_QUEUE_INIT;
static guint64 generation;
static int dispatching;
static sqlite3 *system_db, *user_db, *gab_db;
static char *active_root, *active_account;
static FILE *log_file;

static void close_db(sqlite3 **db)
{
    if (*db) sqlite3_close_v2(*db);
    *db = NULL;
}

static void close_private(void)
{
    close_db(&gab_db);
    close_db(&user_db);
    g_clear_pointer(&active_account, g_free);
}

static int exists(const char *path)
{
    struct stat st;
    return lstat(path, &st) == 0 || errno != ENOENT;
}

static struct json_object *parse_object(const char *text)
{
    if (!text || strlen(text) >= INT_MAX) return NULL;
    struct json_tokener *tokener = json_tokener_new();
    if (!tokener) return NULL;
    json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *result = json_tokener_parse_ex(tokener, text, (int)strlen(text) + 1);
    int valid = json_tokener_get_error(tokener) == json_tokener_success &&
                json_object_is_type(result, json_type_object);
    json_tokener_free(tokener);
    if (!valid) { json_object_put(result); return NULL; }
    return result;
}

static void set_int(struct json_object *object, const char *key, int64_t value)
{
    json_object_object_add(object, key, json_object_new_int64(value));
}

static void set_string(struct json_object *object, const char *key, const char *value)
{
    json_object_object_add(object, key, json_object_new_string(value ? value : ""));
}

/* Publish only a new key, without a replace/rename path that could overwrite an
 * existing config.db, including one created concurrently by another process. */
static int publish_key(const char *path, const char *metadata)
{
    char *temporary = g_strconcat(path, ".contact-XXXXXX", NULL);
    int fd = g_mkstemp_full(temporary, O_WRONLY | O_CLOEXEC, 0600);
    int error = fd < 0 ? errno : 0;
    size_t length = strlen(metadata), written = 0;
    while (!error && written < length) {
        ssize_t count = write(fd, metadata + written, length - written);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) error = count < 0 ? errno : EIO;
        else written += (size_t)count;
    }
    if (!error && fsync(fd)) error = errno;
    if (fd >= 0 && close(fd) && !error) error = errno;
    if (!error && link(temporary, path)) error = errno;
    unlink(temporary);
    g_free(temporary);
    return error;
}

static void hex_nonce(const unsigned char bytes[16], char output[33])
{
    static const char hex[] = "0123456789ABCDEF";
    for (size_t i = 0; i < 16; ++i) {
        output[i * 2] = hex[bytes[i] >> 4];
        output[i * 2 + 1] = hex[bytes[i] & 15];
    }
    output[32] = 0;
}

static int load_key(const char *path, const char *primary, const char *backup,
                    const char *account, int data_exists, struct native_storage_key *key)
{
    memset(key, 0, sizeof(*key));
    int error = native_storage_read_metadata(path, key->metadata, sizeof(key->metadata));
    if (error == ENOENT && !data_exists) {
        unsigned char bytes[16];
        if (RAND_bytes(bytes, sizeof(bytes)) != 1) return EIO;
        hex_nonce(bytes, key->nonce);
        if (account) {
            if (strlen(account) >= sizeof(key->plain)) return EOVERFLOW;
            memcpy(key->plain, account, strlen(account) + 1);
        } else {
            if (RAND_bytes(bytes, sizeof(bytes)) != 1) return EIO;
            hex_nonce(bytes, key->plain);
        }
        OPENSSL_cleanse(bytes, sizeof(bytes));
        char *encrypted = NULL;
        size_t binary_length = 0;
        error = kmc_encrypt_paths(primary, backup, (const unsigned char *)key->plain,
                                  strlen(key->plain), &encrypted, &binary_length);
        if (!error) {
            int length = snprintf(key->metadata, sizeof(key->metadata), "%s|%s", encrypted, key->nonce);
            if (length < 0 || (size_t)length >= sizeof(key->metadata)) error = EOVERFLOW;
        }
        free(encrypted);
        if (!error) error = native_storage_derive(key->plain, key->nonce, key->password);
        if (!error) error = publish_key(path, key->metadata);
        if (error == EEXIST) return load_key(path, primary, backup, account, 1, key);
        return error;
    }
    if (error) return error;
    char *delimiter = strrchr(key->metadata, '|');
    if (!delimiter || strlen(delimiter + 1) != 32) return EINVAL;
    for (size_t i = 1; i <= 32; ++i)
        if (!g_ascii_isxdigit(delimiter[i])) return EINVAL;
    memcpy(key->nonce, delimiter + 1, 33);
    unsigned char *plain = NULL;
    size_t length = 0;
    error = kmc_decrypt_paths(primary, backup, key->metadata,
                              (size_t)(delimiter - key->metadata), &plain, &length);
    if (!error && (!length || length >= sizeof(key->plain) || memchr(plain, 0, length))) error = EINVAL;
    if (!error && account && (strlen(account) != length || memcmp(account, plain, length))) error = EACCES;
    if (!error) { memcpy(key->plain, plain, length); key->plain[length] = 0; }
    if (plain) { OPENSSL_cleanse(plain, length); free(plain); }
    if (!error) error = native_storage_derive(key->plain, key->nonce, key->password);
    return error;
}

static int apply_schema(sqlite3 *db, const char *const *schema, size_t count)
{
    int result = sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL);
    for (size_t i = 0; !result && i < count; ++i)
        result = sqlite3_exec(db, schema[i], NULL, NULL, NULL);
    if (!result) result = sqlite3_exec(db, "COMMIT", NULL, NULL, NULL);
    if (result) sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
    return result;
}

static int initialize(struct json_object *param)
{
    const char *account = native_string(param, "userAccount", "");
    if (!*account) { close_private(); return SQLITE_OK; }
    const char *root = native_string(param, "dbPath", NULL);
    const char *kmc_root = native_string(param, "kmcStorePath", NULL);
    const char *kmc_backup = native_string(param, "kmcStoreBakPath", NULL);
    if (!root || root[0] != '/' || !kmc_root || kmc_root[0] != '/' ||
        !kmc_backup || kmc_backup[0] != '/' || strchr(account, '/') || strchr(account, '\\') ||
        !strcmp(account, ".") || !strcmp(account, "..")) return SQLITE_MISUSE;
    int public = !strcmp(account, "public");
    int enable_gab = json_object_get_boolean(native_get(param, "enableGabLib"));
    char *directory = public ? g_strdup(root) : g_build_filename(root, account, NULL);
    char *metadata = g_build_filename(directory, "config.db", NULL);
    char *first_path = g_build_filename(directory, public ? "sys.db" : "user.db", NULL);
    char *second_path = g_build_filename(directory, "gab.db", NULL);
    char *primary = g_build_filename(kmc_root, "kmcStore.dat", NULL);
    char *backup = g_build_filename(kmc_backup, "kmcStore_bak.dat", NULL);
    int has_data = exists(first_path) || (!public && exists(second_path));
    int error = 0;
    if ((has_data || exists(metadata)) && !exists(primary) && !exists(backup)) error = EACCES;
    if (!error) error = native_storage_mkdirs(directory);
    if (!error) error = native_storage_mkdirs(kmc_root);
    if (!error) error = native_storage_mkdirs(kmc_backup);
    if (!error) error = kmc_initialize_paths(primary, backup);
    struct native_storage_key key = {0};
    if (!error) error = load_key(metadata, primary, backup, public ? NULL : account, has_data, &key);
    int result = error ? SQLITE_AUTH : SQLITE_OK;
    sqlite3 *first = NULL, *second = NULL;
    if (!result) result = native_storage_open(first_path, key.password, 1, &first);
    if (!result && !public && enable_gab) result = native_storage_open(second_path, key.password, 1, &second);
    native_storage_clear_key(&key);
    /* Authenticate every existing database before executing any schema writes. */
    if (!result) {
        sqlite3_busy_timeout(first, 5000);
        result = apply_schema(first, public ? system_schema : user_schema,
                               public ? ARRAY_SIZE(system_schema) : ARRAY_SIZE(user_schema));
    }
    if (!result && second) {
        sqlite3_busy_timeout(second, 5000);
        result = apply_schema(second, gab_schema, ARRAY_SIZE(gab_schema));
    }
    if (!result) {
        if (active_root && strcmp(root, active_root)) { close_private(); close_db(&system_db); }
        g_free(active_root); active_root = g_strdup(root);
        if (public) { close_db(&system_db); system_db = first; }
        else {
            close_private(); user_db = first; gab_db = second;
            active_account = g_strdup(account);
        }
        first = second = NULL;
    }
    close_db(&first); close_db(&second);
    g_free(directory); g_free(metadata); g_free(first_path); g_free(second_path);
    g_free(primary); g_free(backup);
    return result;
}

static struct json_object *sql_error(int status, const char *message)
{
    struct json_object *reply = json_object_new_object();
    set_int(reply, "code", status);
    set_string(reply, "error", message ? message : sqlite3_errstr(status));
    return reply;
}

/* keyStr is NOT a database encryption key. It is {"len":N,"type":op,
 * "0":value,...}. Original DBExecutor receives these strings verbatim. */
static int bind_keys(sqlite3_stmt *statement, struct json_object *keys)
{
    int64_t count = native_integer(keys, "len", -1);
    if (count < 0 || count != sqlite3_bind_parameter_count(statement)) return SQLITE_RANGE;
    for (int i = 0; i < count; ++i) {
        char name[24]; snprintf(name, sizeof(name), "%d", i);
        struct json_object *value = native_get(keys, name);
        int result;
        if (json_object_is_type(value, json_type_string))
            result = sqlite3_bind_text(statement, i + 1, json_object_get_string(value),
                                       json_object_get_string_len(value), SQLITE_STATIC);
        else if (json_object_is_type(value, json_type_int))
            result = sqlite3_bind_int64(statement, i + 1, json_object_get_int64(value));
        else return SQLITE_MISMATCH;
        if (result) return result;
    }
    return SQLITE_OK;
}

static int collect_rows(sqlite3_stmt *statement, struct json_object **rows,
                        const struct contact_record *record)
{
    int step;
    while ((step = sqlite3_step(statement)) == SQLITE_ROW) {
        struct json_object *row = record ? json_object_new_object() : NULL;
        int columns = sqlite3_column_count(statement);
        for (int i = 0; i < columns; ++i) {
            struct json_object *value = NULL;
            const char *name = record ? record->fields[i].json : sqlite3_column_name(statement, i);
            int kind = record ? (record->fields[i].kind == C_TEXT ? SQLITE_TEXT : SQLITE_INTEGER)
                              : sqlite3_column_type(statement, i);
            switch (kind) {
            case SQLITE_INTEGER: value = json_object_new_int64(sqlite3_column_int64(statement, i)); break;
            case SQLITE_FLOAT: value = json_object_new_double(sqlite3_column_double(statement, i)); break;
            case SQLITE_TEXT: {
                const char *text = (const char *)sqlite3_column_text(statement, i);
                value = json_object_new_string_len(text ? text : "", text ? sqlite3_column_bytes(statement, i) : 0);
                break;
            }
            default: continue; /* Original raw query omits NULL and BLOB columns. */
            }
            if (!row) row = json_object_new_object();
            if (!row || !value) { json_object_put(value); json_object_put(row); return SQLITE_NOMEM; }
            json_object_object_add(row, name, value);
        }
        if (!*rows) *rows = json_object_new_array();
        if (!*rows || json_object_array_add(*rows, row)) {
            json_object_put(row); return SQLITE_NOMEM;
        }
    }
    return step == SQLITE_DONE ? SQLITE_OK : step;
}

static struct json_object *run_sql(const char *sql, const char *bindings, int query)
{
    if (!gab_db || !sql || !*sql) return sql_error(SQLITE_ERROR, NULL);
    struct json_object *keys = bindings ? parse_object(bindings) : NULL;
    if (bindings && !keys) return sql_error(SQLITE_MISUSE, "invalid keyStr object");
    sqlite3_stmt *statement = NULL;
    struct json_object *rows = bindings ? json_object_new_array() : NULL;
    int result = SQLITE_OK;
    if (!query && !bindings) {
        char *message = NULL;
        result = sqlite3_exec(gab_db, sql, NULL, NULL, &message);
        if (result) {
            struct json_object *reply = sql_error(message ? 1 : result, message);
            sqlite3_free(message); json_object_put(rows); return reply;
        }
    } else {
        const char *tail = NULL;
        result = sqlite3_prepare_v2(gab_db, sql, -1, &statement, &tail);
        if (!result && !statement) result = SQLITE_MISUSE;
        if (!result && keys) {
            /* The bound ABI is a single prepared statement. Never silently drop
             * trailing SQL carrying a second operation. */
            while (tail && g_ascii_isspace(*tail)) ++tail;
            if (tail && *tail) result = SQLITE_MISUSE;
            else result = bind_keys(statement, keys);
        }
        if (!result) {
            if (query) result = collect_rows(statement, &rows, NULL);
            else {
                int step;
                do { step = sqlite3_step(statement); } while (step == SQLITE_ROW);
                result = step == SQLITE_DONE ? SQLITE_OK : step;
            }
        }
        sqlite3_finalize(statement);
    }
    json_object_put(keys);
    if (result) { json_object_put(rows); return sql_error(result, sqlite3_errmsg(gab_db)); }
    struct json_object *reply = json_object_new_object();
    set_int(reply, "code", 0);
    if (query) json_object_object_add(reply, "data", rows);
    else { json_object_put(rows); set_int(reply, "count", sqlite3_changes(gab_db)); }
    return reply;
}

static void direct_sql(const char *sql, contact_callback callback, const char *bindings, int query)
{
    if (!callback) return;
    g_mutex_lock(&contact_lock);
    struct json_object *reply = owner && owner == g_thread_self()
        ? run_sql(sql, bindings, query) : sql_error(SQLITE_MISUSE, "contact service owner is not active");
    g_mutex_unlock(&contact_lock);
    if (reply) {
        callback(json_object_to_json_string_ext(reply, JSON_C_TO_STRING_PLAIN));
        json_object_put(reply);
    }
}

void GabSqliteQueryAll(const char *sql, contact_callback callback) { direct_sql(sql, callback, NULL, 1); }
void GabSqliteExec(const char *sql, contact_callback callback) { direct_sql(sql, callback, NULL, 0); }
void GabSqliteQueryAllWithKey(const char *sql, contact_callback callback, const char *keys)
{ direct_sql(sql, callback, keys ? keys : "", 1); }
void GabSqliteExecWithKey(const char *sql, contact_callback callback, const char *keys)
{ direct_sql(sql, callback, keys ? keys : "", 0); }

#include "contact_records.inc"

void ContactPluginSetLogPath(const char *directory)
{
    if (!directory || directory[0] != '/') return;
    if (native_storage_mkdirs(directory)) return;
    char *path = g_build_filename(directory, "contact_sqlite.log", NULL);
    int fd = open(path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600);
    g_free(path);
    if (fd < 0) return;
    FILE *next = fdopen(fd, "a");
    if (!next) { close(fd); return; }
    g_mutex_lock(&contact_lock);
    if (log_file) fclose(log_file);
    log_file = next;
    g_mutex_unlock(&contact_lock);
}

static void clear_callbacks(void)
{
    struct json_object *reply;
    while ((reply = g_queue_pop_head(&callbacks))) json_object_put(reply);
}

int SqliteServiceStartup(contact_callback callback)
{
    if (!callback) return EINVAL;
    g_mutex_lock(&contact_lock);
    if (owner && owner != g_thread_self()) { g_mutex_unlock(&contact_lock); return EPERM; }
    if (!owner) owner = g_thread_ref(g_thread_self());
    ++generation;
    clear_callbacks();
    service_callback = callback;
    if (log_file) { fputs("contact service started\n", log_file); fflush(log_file); }
    g_mutex_unlock(&contact_lock);
    return 0;
}

void SqliteRecvMsgImport(const char *text)
{
    struct native_request request;
    if (native_parse(&request, text)) return;
    g_mutex_lock(&contact_lock);
    if (owner && service_callback) {
        struct json_object *reply = handle_request(&request);
        if (reply) {
            if (log_file) {
                fprintf(log_file, "contact cmd=%lld result=%lld\n",
                        (long long)request.cmd, (long long)native_integer(reply, "result", -1));
                fflush(log_file);
            }
            g_queue_push_tail(&callbacks, reply);
        }
    }
    g_mutex_unlock(&contact_lock);
    native_release(&request);
}

int ContactPluginDispatchCallbacks(void)
{
    g_mutex_lock(&contact_lock);
    if (!owner) { g_mutex_unlock(&contact_lock); return 0; }
    if (owner != g_thread_self()) { g_mutex_unlock(&contact_lock); return -EPERM; }
    if (dispatching) { g_mutex_unlock(&contact_lock); return 0; }
    dispatching = 1;
    guint64 epoch = generation;
    guint pending = callbacks.length;
    int delivered = 0;
    while (pending-- && owner && generation == epoch && service_callback) {
        struct json_object *reply = g_queue_pop_head(&callbacks);
        if (!reply) break;
        contact_callback callback = service_callback;
        g_mutex_unlock(&contact_lock);
        callback(json_object_to_json_string_ext(reply, JSON_C_TO_STRING_PLAIN));
        json_object_put(reply);
        ++delivered;
        g_mutex_lock(&contact_lock);
    }
    dispatching = 0;
    g_mutex_unlock(&contact_lock);
    return delivered;
}

void ContactPluginShutdown(void)
{
    g_mutex_lock(&contact_lock);
    ++generation;
    service_callback = NULL;
    clear_callbacks();
    close_private();
    close_db(&system_db);
    g_clear_pointer(&active_root, g_free);
    if (owner) { g_thread_unref(owner); owner = NULL; }
    if (log_file) { fclose(log_file); log_file = NULL; }
    g_mutex_unlock(&contact_lock);
}
