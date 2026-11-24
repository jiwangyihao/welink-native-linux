/* Original common-utils ConfigTab service (commands 100..105).
 * This layer owns no alternate database/key format. SQL runs under the registry
 * lock; callbacks are emitted by common_utils only after the lock is released. */
#define _GNU_SOURCE
#include "common_db.h"
#include "native_storage.h"
#include "login_security_identity.h"
#include <errno.h>
#include <limits.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <openssl/crypto.h>

enum { UPSERT, QUERY_KEY, QUERY_ALL, DELETE_KEY, DELETE_ALL, STATEMENT_COUNT };
static const char *const statements[STATEMENT_COUNT] = {
    "INSERT OR REPLACE INTO ConfigTab(KEY,VALUE) VALUES(?,?)",
    "SELECT KEY,VALUE FROM ConfigTab WHERE KEY=?",
    "SELECT KEY,VALUE FROM ConfigTab",
    "DELETE FROM ConfigTab WHERE KEY=?",
    "DELETE FROM ConfigTab"
};
struct config_database {
    int64_t handle;
    sqlite3 *db;
    sqlite3_stmt *statements[STATEMENT_COUNT];
};
static struct config_database databases[10];
static pthread_mutex_t registry_lock = PTHREAD_MUTEX_INITIALIZER;

static struct config_database *lookup(int64_t handle)
{
    for (size_t i = 0; i < sizeof(databases)/sizeof(databases[0]); ++i)
        if (databases[i].db && databases[i].handle == handle) return &databases[i];
    return NULL;
}

static void close_database(struct config_database *entry)
{
    for (size_t i = 0; i < STATEMENT_COUNT; ++i) sqlite3_finalize(entry->statements[i]);
    if (entry->db) sqlite3_close(entry->db);
    memset(entry, 0, sizeof(*entry));
}

static int cached_statement(struct config_database *entry, unsigned index, sqlite3_stmt **out)
{
    if (!entry->statements[index]) {
        int result = sqlite3_prepare_v2(entry->db, statements[index], -1,
                                        &entry->statements[index], NULL);
        if (result != SQLITE_OK) return result;
    }
    *out = entry->statements[index];
    sqlite3_reset(*out);
    sqlite3_clear_bindings(*out);
    return SQLITE_OK;
}

static int initialize(struct json_object *param, int64_t handle)
{
    if (lookup(handle)) return 0;
    struct config_database *entry = NULL;
    for (size_t i = 0; i < sizeof(databases)/sizeof(databases[0]); ++i)
        if (!databases[i].db) { entry = &databases[i]; break; }
    if (!entry) return 1;
    const char *directory = native_string(param, "dbPath", "");
    const char *name = native_string(param, "dbName", "");
    const char *kmc = native_string(param, "kmcStorePath", "");
    const char *iv = native_string(param, "privateEncryptIv", "");
    if (!*directory || !*name || !*kmc || strchr(name, '/') || strchr(name, '\\') ||
        !strcmp(name, ".") || !strcmp(name, "..") || !strcmp(name, "config.db")) return 3;
    char filename[PATH_MAX], metadata[PATH_MAX];
    int length = snprintf(filename, sizeof(filename), "%s/%s", directory, name);
    if (length < 0 || (size_t)length >= sizeof(filename)) return 3;
    length = snprintf(metadata, sizeof(metadata), "%s/config.db", directory);
    if (length < 0 || (size_t)length >= sizeof(metadata)) return 3;
    if (native_storage_mkdirs(directory) || native_storage_mkdirs(kmc)) return 1;
    struct stat st;
    int create_key = 1;
    if (stat(filename, &st) == 0) create_key = st.st_size == 0;
    else if (errno != ENOENT) return 1;
    char serial[1024], plain[190];
    login_security_disk_serial(serial, sizeof(serial));
    length = snprintf(plain, sizeof(plain), "%s=%s", serial, iv);
    OPENSSL_cleanse(serial, sizeof(serial));
    if (length < 0 || (size_t)length >= sizeof(plain)) return 1;
    struct native_storage_key key;
    int error = native_storage_load_key(metadata, kmc, plain, create_key, &key);
    OPENSSL_cleanse(plain, sizeof(plain));
    if (error) return 1;
    sqlite3 *db = NULL;
    int result = native_storage_open(filename, key.password, 1, &db);
    native_storage_clear_key(&key);
    if (result != SQLITE_OK) return 1;
    const char *schema =
        "CREATE TABLE IF NOT EXISTS ConfigTab("
        "AUTOID INTEGER PRIMARY KEY AUTOINCREMENT,"
        "KEY VARCHAR(256) NOT NULL,VALUE VARCHAR(512));"
        "CREATE UNIQUE INDEX IF NOT EXISTS SYSCONFIG_UNIQUE_INDEX ON ConfigTab(KEY);";
    result = sqlite3_exec(db, schema, NULL, NULL, NULL);
    if (result != SQLITE_OK) { sqlite3_close(db); return 1; }
    entry->handle = handle;
    entry->db = db;
    return 0;
}

static int add_config(struct config_database *entry, struct json_object *value)
{
    const char *key = native_string(value, "key", "");
    const char *text = native_string(value, "value", "");
    if (!*key) return 3;
    sqlite3_stmt *statement = NULL;
    int result = cached_statement(entry, UPSERT, &statement);
    if (result == SQLITE_OK) result = sqlite3_bind_text(statement, 1, key, -1, SQLITE_STATIC);
    if (result == SQLITE_OK) result = sqlite3_bind_text(statement, 2, text, -1, SQLITE_STATIC);
    if (result == SQLITE_OK) result = sqlite3_step(statement);
    if (statement) { sqlite3_reset(statement); sqlite3_clear_bindings(statement); }
    return result == SQLITE_DONE ? 0 : 1;
}

static int add_batch(struct config_database *entry, struct json_object *param)
{
    struct json_object *array = native_get(param, "dataList");
    struct json_object *count = native_get(param, "listLen");
    if (!json_object_is_type(array, json_type_array) ||
        !json_object_is_type(count, json_type_int) ||
        !json_object_is_type(native_get(param, "dbHandle"), json_type_int)) return 3;
    int64_t length = json_object_get_int64(count);
    if (length < 0 || (uint64_t)length > json_object_array_length(array)) return 3;
    for (int64_t i = 0; i < length; ++i)
        if (!*native_string(json_object_array_get_idx(array, (size_t)i), "key", "")) return 3;
    if (sqlite3_exec(entry->db, "BEGIN IMMEDIATE", NULL, NULL, NULL) != SQLITE_OK) return 1;
    int result = 0;
    for (int64_t i = 0; i < length && !result; ++i)
        result = add_config(entry, json_object_array_get_idx(array, (size_t)i));
    if (!result && sqlite3_exec(entry->db, "COMMIT", NULL, NULL, NULL) != SQLITE_OK) result = 1;
    if (result) sqlite3_exec(entry->db, "ROLLBACK", NULL, NULL, NULL);
    return result;
}

static int match_statement(struct config_database *entry, struct json_object *param,
                           int query, sqlite3_stmt **statement, int *temporary)
{
    *statement = NULL; *temporary = 0;
    int64_t type = native_integer(param, "keyType", 0);
    const char *match = native_string(param, "matchValue", "");
    /* Public KeyType 1 is all rows; 0 is one key; 2 is the original comma list. */
    if (type == 1)
        return cached_statement(entry, query ? QUERY_ALL : DELETE_ALL, statement) == SQLITE_OK ? 0 : 1;
    if (!*match || (type != 0 && type != 2)) return 3;
    if (type == 0) {
        int result = cached_statement(entry, query ? QUERY_KEY : DELETE_KEY, statement);
        if (result == SQLITE_OK) result = sqlite3_bind_text(*statement, 1, match, -1, SQLITE_STATIC);
        return result == SQLITE_OK ? 0 : 1;
    }
    size_t count = 0;
    const char *part = match;
    for (;;) {
        const char *comma = strchr(part, ',');
        size_t length = comma ? (size_t)(comma - part) : strlen(part);
        if (length) ++count;
        if (!comma) break;
        part = comma + 1;
    }
    if (!count) return 3;
    if (count > (size_t)sqlite3_limit(entry->db, SQLITE_LIMIT_VARIABLE_NUMBER, -1)) return 1;
    const char *prefix = query ? "SELECT KEY,VALUE FROM ConfigTab WHERE KEY IN ("
                               : "DELETE FROM ConfigTab WHERE KEY IN (";
    size_t prefix_length = strlen(prefix);
    char *sql = malloc(prefix_length + 2*count + 2);
    if (!sql) return 1;
    memcpy(sql, prefix, prefix_length);
    size_t position = prefix_length;
    for (size_t i = 0; i < count; ++i) {
        if (i) sql[position++] = ',';
        sql[position++] = '?';
    }
    sql[position++] = ')'; sql[position] = 0;
    int result = sqlite3_prepare_v2(entry->db, sql, -1, statement, NULL);
    free(sql);
    if (result != SQLITE_OK) return 1;
    *temporary = 1;
    part = match;
    int index = 1;
    for (;;) {
        const char *comma = strchr(part, ',');
        size_t length = comma ? (size_t)(comma - part) : strlen(part);
        if (length) {
            result = sqlite3_bind_text(*statement, index++, part, (int)length, SQLITE_STATIC);
            if (result != SQLITE_OK) return 1;
        }
        if (!comma) break;
        part = comma + 1;
    }
    return 0;
}

static int query_or_delete(struct config_database *entry, struct json_object *request,
                           int query, struct json_object *response)
{
    sqlite3_stmt *statement = NULL;
    int temporary = 0;
    int result = match_statement(entry, request, query, &statement, &temporary);
    struct json_object *rows = query ? native_get(response, "dataList") : NULL;
    if (!result) {
        int step;
        while ((step = sqlite3_step(statement)) == SQLITE_ROW && query) {
            struct json_object *row = json_object_new_object();
            const char *key = (const char *)sqlite3_column_text(statement, 0);
            const char *value = (const char *)sqlite3_column_text(statement, 1);
            struct json_object *key_json = json_object_new_string(key ? key : "");
            struct json_object *value_json = json_object_new_string(value ? value : "");
            if (!row || !key_json || !value_json) {
                json_object_put(row); json_object_put(key_json); json_object_put(value_json);
                result = 1; break;
            }
            json_object_object_add(row, "key", key_json);
            json_object_object_add(row, "value", value_json);
            json_object_array_add(rows, row);
        }
        if (!result && step != SQLITE_DONE) result = 1;
    }
    if (temporary) sqlite3_finalize(statement);
    else if (statement) { sqlite3_reset(statement); sqlite3_clear_bindings(statement); }
    if (query)
        json_object_object_add(response, "listLen", json_object_new_int64((int64_t)json_object_array_length(rows)));
    return result;
}

int common_db_execute(const struct native_request *request, struct json_object **param)
{
    *param = NULL;
    if (request->cmd == 104) {
        *param = json_object_new_object();
        struct json_object *array = json_object_new_array();
        if (!*param || !array) { json_object_put(*param); json_object_put(array); *param = NULL; return 1; }
        json_object_object_add(*param, "dataList", array);
        json_object_object_add(*param, "listLen", json_object_new_int(0));
    }
    int64_t handle = native_integer(request->param, "dbHandle", 0);
    if (handle < INT_MIN || handle > INT_MAX) return 3;
    pthread_mutex_lock(&registry_lock);
    int result;
    struct config_database *entry = lookup(handle);
    if (request->cmd == 100) result = initialize(request->param, handle);
    else if (!entry) result = 5;
    else switch (request->cmd) {
        case 101: result = add_config(entry, request->param); break;
        case 102: result = add_batch(entry, request->param); break;
        case 103: result = query_or_delete(entry, request->param, 0, NULL); break;
        case 104: result = query_or_delete(entry, request->param, 1, *param); break;
        case 105: close_database(entry); result = 0; break;
        default: result = 3; break;
    }
    pthread_mutex_unlock(&registry_lock);
    return result;
}

void common_db_shutdown(void)
{
    pthread_mutex_lock(&registry_lock);
    for (size_t i = 0; i < sizeof(databases)/sizeof(databases[0]); ++i)
        if (databases[i].db) close_database(&databases[i]);
    pthread_mutex_unlock(&registry_lock);
}
