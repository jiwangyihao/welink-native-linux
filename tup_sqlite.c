/* Original pedestal SQLite command service. IM has a distinct database adapter.
 * Keys and tables are compatible with the SDK; failed opens never replace data.
 * Callbacks run outside the database mutex and must remain pinned until exit. */
#define _GNU_SOURCE
#include "native_rpc.h"
#include "native_storage.h"
#include "login_security_identity.h"
#include "pedestal_schema.h"
#include "pedestal_integrity.h"
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#define EXPORT __attribute__((visibility("default")))
static pthread_mutex_t database_lock = PTHREAD_MUTEX_INITIALIZER;
static native_callback callback;
static char base_path[PATH_MAX];
/* Public metadata is encrypted by the app's KMC provider, not the DB directory. */
static char public_kmc_path[PATH_MAX];
static struct native_storage_key public_key;
static sqlite3 *system_db, *user_db, *history_db;
static FILE *log_file;

static int make_name(char output[PATH_MAX], const char *directory, const char *name)
{
    int length = snprintf(output, PATH_MAX, "%s/%s", directory, name);
    return length < 0 || length >= PATH_MAX ? ENAMETOOLONG : 0;
}

static void close_database(sqlite3 **db)
{
    if (*db) sqlite3_close(*db);
    *db = NULL;
}

static void close_private(void)
{
    close_database(&user_db);
    close_database(&history_db);
}

static void close_all(void)
{
    close_private();
    close_database(&system_db);
    native_storage_clear_key(&public_key);
}

static int configure_base(const char *directory, const char *kmc_directory)
{
    if (!directory || directory[0] != '/' || !kmc_directory || kmc_directory[0] != '/') return EINVAL;
    size_t length = strlen(directory), kmc_length = strlen(kmc_directory);
    if (length >= sizeof(base_path) || kmc_length >= sizeof(public_kmc_path)) return ENAMETOOLONG;
    int error = native_storage_mkdirs(directory);
    if (error) return error;
    if (strcmp(directory, base_path) || strcmp(kmc_directory, public_kmc_path)) {
        close_all();
        memcpy(base_path, directory, length + 1);
        memcpy(public_kmc_path, kmc_directory, kmc_length + 1);
    }
    return 0;
}

static int public_metadata_path(char path[PATH_MAX])
{
    if (!base_path[0]) return EINVAL;
    char directory[PATH_MAX];
    int error = make_name(directory, base_path, "UserData");
    if (!error) error = native_storage_mkdirs(directory);
    return error ? error : make_name(path, directory, "config.db");
}

static int load_public_key(void)
{
    if (public_key.password[0]) return 0;
    char path[PATH_MAX];
    int error = public_metadata_path(path);
    return error ? error : native_storage_load_key(path, public_kmc_path, NULL, 0, &public_key);
}

static int open_schema(const char *directory, const char *name, const char *password,
                       const char *schema, sqlite3 **output)
{
    char path[PATH_MAX];
    if (make_name(path, directory, name)) return SQLITE_CANTOPEN;
    sqlite3 *db = NULL;
    int result = native_storage_open(path, password, 1, &db);
    if (result == SQLITE_OK) result = sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL);
    if (result == SQLITE_OK) result = sqlite3_exec(db, schema, NULL, NULL, NULL);
    if (result == SQLITE_OK) result = sqlite3_exec(db, "COMMIT", NULL, NULL, NULL);
    if (result != SQLITE_OK) {
        if (db) sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
        close_database(&db);
        return result;
    }
    close_database(output);
    *output = db;
    return SQLITE_OK;
}

static int initialize_account(const char *account)
{
    if (!account || !base_path[0]) return 1;
    if (!*account) { close_private(); return 0; }
    if (strcmp(account, "public")) close_private();
    if (load_public_key()) return 1;
    if (!strcmp(account, "public")) {
        return open_schema(base_path, "sys.db", public_key.password,
            LOGIN_SCHEMA SYSTEM_CONFIG_SCHEMA
            "CREATE UNIQUE INDEX IF NOT EXISTS LOGINLIST_UNIQUE_INDEX ON LoginListTab(ACCOUNT);"
            "CREATE UNIQUE INDEX IF NOT EXISTS SYSCONFIG_UNIQUE_INDEX ON SysConfigTab(KEY);",
            &system_db) != SQLITE_OK;
    }
    close_private();
    if (strchr(account, '/') || strchr(account, '\\') || !strcmp(account, ".") ||
        !strcmp(account, "..")) return 1;
    char users[PATH_MAX], directory[PATH_MAX], metadata[PATH_MAX];
    int error = make_name(users, base_path, "UserData");
    if (!error) error = make_name(directory, users, account);
    if (!error) error = native_storage_mkdirs(directory);
    if (!error) error = make_name(metadata, directory, "config_private.db");
    struct native_storage_key key = {0};
    if (!error) error = native_storage_load_key(metadata, base_path, account, 1, &key);
    if (!error) error = open_schema(directory, "user.db", key.password,
        USER_CONFIG_SCHEMA
        "CREATE UNIQUE INDEX IF NOT EXISTS USERCONFIG_UNIQUE_INDEX ON UserConfigTab(KEY);",
        &user_db);
    if (!error) error = open_schema(directory, "history.db", key.password,
        CALL_SCHEMA USER_CONFIG_SCHEMA DB_VERSION_SCHEMA
        "CREATE INDEX IF NOT EXISTS CALLRECORD_STARTTIME_INDEX ON CALLRecordTab(STARTTIME);",
        &history_db);
    native_storage_clear_key(&key);
    if (error) close_private();
    return error != 0;
}

static int bind_record(sqlite3_stmt *statement, const struct pedestal_record *record,
                       struct json_object *row)
{
    if (!json_object_is_type(row, json_type_object)) return SQLITE_MISMATCH;
    int config = record == &system_config_record || record == &user_config_record;
    int64_t id = 0;
    if (config) {
        struct json_object *identifier = native_get(row, "id");
        struct json_object *key = native_get(row, "strkey");
        struct json_object *value = native_get(row, "strvalue");
        if (!json_object_is_type(identifier, json_type_int) ||
            !json_object_is_type(key, json_type_string) ||
            !json_object_is_type(value, json_type_string)) return SQLITE_MISMATCH;
        if (json_object_get_string_len(key) >= 128 ||
            (record == &user_config_record && json_object_get_string_len(value) > 10240))
            return SQLITE_TOOBIG;
        id = json_object_get_int64(identifier);
    }
    int result = id ? sqlite3_bind_int64(statement, 1, id) : sqlite3_bind_null(statement, 1);
    for (size_t i = 1; result == SQLITE_OK && i < record->count; ++i) {
        struct json_object *value = native_get(row, record->fields[i].name);
        if (record->fields[i].kind == P_INTEGER) {
            int64_t number = 0;
            if (json_object_is_type(value, json_type_int) ||
                json_object_is_type(value, json_type_boolean)) number = json_object_get_int64(value);
            result = sqlite3_bind_int64(statement, (int)i + 1, number);
        } else if (record->fields[i].kind == P_JSON && value) {
            const char *encoded = json_object_to_json_string_ext(value, JSON_C_TO_STRING_PLAIN);
            result = encoded ? sqlite3_bind_text(statement, (int)i + 1, encoded, -1, SQLITE_STATIC) : SQLITE_NOMEM;
        } else if (json_object_is_type(value, json_type_string)) {
            result = sqlite3_bind_text(statement, (int)i + 1, json_object_get_string(value),
                                      json_object_get_string_len(value), SQLITE_STATIC);
        } else result = sqlite3_bind_null(statement, (int)i + 1);
    }
    return result;
}

static int64_t insert_record(sqlite3 *db, const struct pedestal_record *record,
                              struct json_object *row)
{
    if (!db) return -1;
    sqlite3_stmt *statement = NULL;
    int result = sqlite3_prepare_v2(db, record->insert_sql, -1, &statement, NULL);
    if (result == SQLITE_OK) result = bind_record(statement, record, row);
    if (result == SQLITE_OK) result = sqlite3_step(statement);
    sqlite3_finalize(statement);
    return result == SQLITE_DONE ? sqlite3_last_insert_rowid(db) : -1;
}

static int insert_list(sqlite3 *db, const struct pedestal_record *record,
                       struct json_object *param, const char *name)
{
    struct json_object *list = native_get(param, name);
    int64_t count = native_integer(param, "_arraylen", -1);
    if (!db || count <= 0 || !json_object_is_type(list, json_type_array) ||
        (uint64_t)count > json_object_array_length(list)) return 0;
    int result = sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL);
    sqlite3_stmt *statement = NULL;
    if (result == SQLITE_OK) result = sqlite3_prepare_v2(db, record->insert_sql, -1, &statement, NULL);
    for (int64_t i = 0; result == SQLITE_OK && i < count; ++i) {
        result = bind_record(statement, record, json_object_array_get_idx(list, (size_t)i));
        if (result == SQLITE_OK) {
            int step = sqlite3_step(statement);
            result = step == SQLITE_DONE ? SQLITE_OK : step;
        }
        if (result == SQLITE_OK) result = sqlite3_reset(statement);
    }
    sqlite3_finalize(statement);
    if (result == SQLITE_OK) result = sqlite3_exec(db, "COMMIT", NULL, NULL, NULL);
    if (result != SQLITE_OK) sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
    return result == SQLITE_OK;
}

static int read_rows(sqlite3_stmt *statement, const struct pedestal_record *record,
                     const char *name, struct json_object **output)
{
    struct json_object *rows = NULL;
    int step = SQLITE_DONE;
    size_t count = 0;
    while (count < 512 && (step = sqlite3_step(statement)) == SQLITE_ROW) {
        struct json_object *row = json_object_new_object();
        if (!row || (!rows && !(rows = json_object_new_array()))) {
            json_object_put(row);
            json_object_put(rows);
            return SQLITE_NOMEM;
        }
        for (size_t i = 0; i < record->count; ++i) {
            struct json_object *value;
            if (record->fields[i].kind == P_INTEGER)
                value = json_object_new_int64(sqlite3_column_int64(statement, (int)i));
            else {
                const char *text = (const char *)sqlite3_column_text(statement, (int)i);
                value = json_object_new_string(text ? text : "");
            }
            if (!value) { json_object_put(row); json_object_put(rows); return SQLITE_NOMEM; }
            json_object_object_add(row, record->fields[i].name, value);
        }
        if (record == &call_record)
            json_object_object_add(row, "limitcount", json_object_new_int(0));
        json_object_array_add(rows, row);
        ++count;
    }
    if (step != SQLITE_DONE && !(step == SQLITE_ROW && count == 512)) {
        json_object_put(rows);
        return step;
    }
    struct json_object *param = json_object_new_object();
    if (!param) { json_object_put(rows); return SQLITE_NOMEM; }
    json_object_object_add(param, "_retlen", json_object_new_int64((int64_t)count));
    json_object_object_add(param, name, rows);
    *output = param;
    return SQLITE_OK;
}

static void empty_rows(const char *name, struct json_object **output)
{
    *output = json_object_new_object();
    json_object_object_add(*output, "_retlen", json_object_new_int(0));
    json_object_object_add(*output, name, NULL);
}

static int query_config(sqlite3 *db, const struct pedestal_record *record,
                        struct json_object *match, struct json_object **output)
{
    int system = record == &system_config_record;
    const char *name = system ? "_sysconfiglist" : "_userconfiglist";
    int64_t type = native_integer(match, "keytype", -1);
    const char *sql = NULL;
    if (type == 1) sql = system ? SYSTEM_CONFIG_SELECT " WHERE KEY=?" : USER_CONFIG_SELECT " WHERE KEY=?";
    else if (type == 3) sql = system ? SYSTEM_CONFIG_SELECT : USER_CONFIG_SELECT;
    sqlite3_stmt *statement = NULL;
    int result = db && sql ? sqlite3_prepare_v2(db, sql, -1, &statement, NULL) : SQLITE_MISUSE;
    if (result == SQLITE_OK && type == 1)
        result = sqlite3_bind_text(statement, 1, native_string(match, "match_value", ""), -1, SQLITE_STATIC);
    if (result == SQLITE_OK) result = read_rows(statement, record, name, output);
    sqlite3_finalize(statement);
    if (result != SQLITE_OK) empty_rows(name, output);
    return result == SQLITE_OK && (system || native_integer(*output, "_retlen", 0) != 0);
}

static int query_logins(struct json_object *match, struct json_object **output)
{
    int64_t type = native_integer(match, "keytype", -1);
    const char *sql = NULL;
    if (type == 8) sql = LOGIN_SELECT " ORDER BY TIMESTAMP DESC";
    else if (type == 1) sql = LOGIN_SELECT " WHERE ACCOUNT=? COLLATE NOCASE ORDER BY TIMESTAMP DESC LIMIT 1";
    else if (type == 2) sql = LOGIN_SELECT " WHERE DISPLAYACCOUNT=? COLLATE NOCASE ORDER BY TIMESTAMP DESC LIMIT 1";
    sqlite3_stmt *statement = NULL;
    int result = system_db && sql ? sqlite3_prepare_v2(system_db, sql, -1, &statement, NULL) : SQLITE_MISUSE;
    if (result == SQLITE_OK && type != 8)
        result = sqlite3_bind_text(statement, 1, native_string(match, "match_value", ""), -1, SQLITE_STATIC);
    if (result == SQLITE_OK) result = read_rows(statement, &login_record, "_logininfolist", output);
    sqlite3_finalize(statement);
    if (result != SQLITE_OK) empty_rows("_logininfolist", output);
    return result == SQLITE_OK;
}

static const char *call_match(struct json_object *multi, int key)
{
    struct json_object *list = native_get(multi, "datalist");
    if (!json_object_is_type(list, json_type_array)) return "";
    int64_t length = native_integer(multi, "datalen", 0);
    size_t count = json_object_array_length(list);
    if (length < 0 || (uint64_t)length > count) return "";
    for (int64_t i = 0; i < length; ++i) {
        struct json_object *item = json_object_array_get_idx(list, (size_t)i);
        if (native_integer(item, "keytype", -1) == key) return native_string(item, "match_value", "");
    }
    return "";
}

static int query_calls(struct json_object *multi, struct json_object **output)
{
    int64_t operation = native_integer(multi, "operationtype", -1);
    const char *sql = NULL, *filter = NULL;
    switch (operation) {
    case 1: sql = CALL_SELECT " WHERE PEERACCOUNT=?3 AND STARTTIME<?1 ORDER BY STARTTIME DESC LIMIT ?2"; filter = call_match(multi, 1); break;
    case 10: sql = CALL_SELECT " WHERE GROUPID=?3 AND STARTTIME<?1 ORDER BY STARTTIME DESC LIMIT ?2"; filter = call_match(multi, 10); break;
    case 7: sql = CALL_SELECT " WHERE CONFID=?3 AND STARTTIME<?1 ORDER BY STARTTIME DESC LIMIT ?2"; filter = call_match(multi, 7); break;
    case 14: sql = CALL_SELECT " WHERE STARTTIME<?1 ORDER BY STARTTIME DESC LIMIT ?2"; break;
    case 16: sql = CALL_SELECT " WHERE CONFID!='' AND STARTTIME<?1 ORDER BY STARTTIME DESC LIMIT ?2"; break;
    case 17: sql = CALL_SELECT " WHERE CONFID='' AND STARTTIME<?1 ORDER BY STARTTIME DESC LIMIT ?2"; break;
    }
    int64_t before = strtoll(call_match(multi, 11), NULL, 10);
    int64_t limit = strtoll(call_match(multi, 13), NULL, 10);
    sqlite3_stmt *statement = NULL;
    int result = history_db && sql && before > 0 && limit > 0 && (!filter || *filter) ?
        sqlite3_prepare_v2(history_db, sql, -1, &statement, NULL) : SQLITE_MISUSE;
    if (result == SQLITE_OK) result = sqlite3_bind_int64(statement, 1, before);
    if (result == SQLITE_OK) result = sqlite3_bind_int64(statement, 2, limit);
    if (result == SQLITE_OK && filter) result = sqlite3_bind_text(statement, 3, filter, -1, SQLITE_STATIC);
    if (result == SQLITE_OK) result = read_rows(statement, &call_record, "_callrecordlist", output);
    sqlite3_finalize(statement);
    if (result != SQLITE_OK) empty_rows("_callrecordlist", output);
    return result == SQLITE_OK && native_integer(*output, "_retlen", 0) != 0;
}

static int delete_rows(int64_t command, struct json_object *match)
{
    sqlite3 *db = system_db;
    int64_t type = native_integer(match, "keytype", -1);
    const char *sql = NULL;
    if (command == 3) {
        if (type == 0) sql = "DELETE FROM SysConfigTab WHERE AUTOID=?";
        else if (type == 1) sql = "DELETE FROM SysConfigTab WHERE KEY=?";
    } else if (command == 26) {
        db = user_db;
        if (type == 0) sql = "DELETE FROM UserConfigTab WHERE AUTOID=?";
        else if (type == 1) sql = "DELETE FROM UserConfigTab WHERE KEY=?";
    } else if (command == 6 || command == 93) {
        if (type == 0) sql = "DELETE FROM LoginListTab WHERE AUTOID=?";
        else if (type == 1) sql = "DELETE FROM LoginListTab WHERE ACCOUNT=?";
    } else if (command == 73) {
        db = history_db;
        if (type == 0) sql = "DELETE FROM CALLRecordTab WHERE AUTOID=?";
        else if (type == 1) sql = "DELETE FROM CALLRecordTab WHERE PEERACCOUNT=?";
        else if (type == 7) sql = "DELETE FROM CALLRecordTab WHERE CONFID=?";
        else if (type == 14) sql = "DELETE FROM CALLRecordTab";
    }
    if (!db || !sql || (command == 93 && type != 1)) return 0;
    struct json_object *values = NULL;
    int64_t count = 1;
    if (command == 93) {
        values = native_get(match, "match_values");
        count = native_integer(match, "arraylen", -1);
        if (count <= 0 || !json_object_is_type(values, json_type_array) ||
            (uint64_t)count > json_object_array_length(values)) return 0;
    }
    sqlite3_stmt *statement = NULL;
    int result = values ? sqlite3_exec(db, "BEGIN IMMEDIATE", NULL, NULL, NULL) : SQLITE_OK;
    if (result == SQLITE_OK) result = sqlite3_prepare_v2(db, sql, -1, &statement, NULL);
    int changed = 0;
    for (int64_t i = 0; result == SQLITE_OK && i < count; ++i) {
        struct json_object *value = values ? json_object_array_get_idx(values, (size_t)i) : native_get(match, "match_value");
        const char *text = json_object_is_type(value, json_type_string) ? json_object_get_string(value) : "";
        if (type == 0) result = sqlite3_bind_int64(statement, 1, strtoll(text, NULL, 10));
        else if (type != 14) result = sqlite3_bind_text(statement, 1, text, -1, SQLITE_STATIC);
        if (result == SQLITE_OK) {
            int step = sqlite3_step(statement);
            result = step == SQLITE_DONE ? SQLITE_OK : step;
            changed |= sqlite3_changes(db) != 0;
        }
        if (result == SQLITE_OK) result = sqlite3_reset(statement);
    }
    sqlite3_finalize(statement);
    if (values) {
        if (result == SQLITE_OK) result = sqlite3_exec(db, "COMMIT", NULL, NULL, NULL);
        if (result != SQLITE_OK) sqlite3_exec(db, "ROLLBACK", NULL, NULL, NULL);
    }
    return result == SQLITE_OK && (command == 73 || changed);
}

static int set_public_key(struct json_object *param, int update)
{
    const char *plain = native_string(param, update ? "newplainvalue" : "plainvalue", NULL);
    const char *nonce = native_string(param, update ? "newvecvalue" : "vecvalue", NULL);
    const char *metadata = native_string(param, update ? "newsecvalue" : "secvalue", NULL);
    if (!plain || !nonce || !metadata) return 0;
    char path[PATH_MAX];
    int error = public_metadata_path(path);
    if (error) return 0;
    if (!update) {
        struct native_storage_key previous = {0};
        error = native_storage_load_key(path, public_kmc_path, NULL, 0, &previous);
        if (error == ENOENT) {
            struct stat existing;
            if (lstat(path, &existing) && errno == ENOENT) error = 0;
        }
        else if (!error && (strcmp(previous.plain, plain) || strcmp(previous.nonce, nonce)))
            error = EKEYREJECTED;
        if (!error && system_db && (strcmp(public_key.plain, plain) || strcmp(public_key.nonce, nonce)))
            error = EBUSY;
        native_storage_clear_key(&previous);
        if (!error) error = native_storage_set_key(path, plain, nonce, metadata, &public_key);
        return error == 0;
    }
    error = load_public_key();
    sqlite3 *db = system_db, *temporary = NULL;
    if (!error && !db) {
        char database[PATH_MAX];
        error = make_name(database, base_path, "sys.db");
        if (!error) error = native_storage_open(database, public_key.password, 0, &temporary);
        db = temporary;
    }
    if (!error) error = native_storage_rekey(db, path, plain, nonce, metadata, &public_key);
    if (error == ENOTRECOVERABLE) {
        if (log_file) fputs("public key rotation rollback failed\n", log_file);
        close_database(&system_db);
    }
    close_database(&temporary);
    return error == 0;
}

static int set_log(const char *directory)
{
    char path[PATH_MAX];
    if (!directory || !*directory) return EINVAL;
    int error = native_storage_mkdirs(directory);
    if (!error) error = make_name(path, directory, "sqlite-native.log");
    if (error) return error;
    int fd = open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) return errno;
    FILE *next = fdopen(fd, "a");
    if (!next) { error = errno; close(fd); return error; }
    setvbuf(next, NULL, _IOLBF, 0);
    if (log_file) fclose(log_file);
    log_file = next;
    return 0;
}

static const char *command_name(int64_t command)
{
    switch (command) {
    case 1: return "tup_sqlite_init_db";
    case 2: return "tup_sqlite_add_sysconfig";
    case 3: return "tup_sqlite_del_sysconfig";
    case 4: return "tup_sqlite_query_sysconfig";
    case 5: case 92: return "tup_sqlite_add_logininfo";
    case 6: case 93: return "tup_sqlite_del_logininfo";
    case 7: return "tup_sqlite_query_logininfo";
    case 25: return "tup_sqlite_add_userconfig";
    case 26: return "tup_sqlite_del_userconfig";
    case 27: return "tup_sqlite_query_userconfig";
    case 71: return "tup_sqlite_add_callrecord";
    case 72: return "tup_sqlite_add_callrecordlist";
    case 73: return "tup_sqlite_delete_callrecord";
    case 74: return "tup_sqlite_query_callrecord";
    case 76: return "tup_uilogic_getdiscserialnumber";
    case 77: return "tup_sqlite_set_saltvalue";
    case 78: return "tup_sqlite_get_saltvalue";
    case 79: return "tup_sqlite_init_dbpath";
    case 89: return "tup_sqlite_update_saltvalue";
    case 90: return "tup_sqlite_set_logpath";
    default: return NULL;
    }
}

EXPORT void tup_sqlite_set_log_path(const char *path, int level, int maximum, int flags)
{
    (void)level; (void)maximum; (void)flags;
    pthread_mutex_lock(&database_lock);
    set_log(path);
    pthread_mutex_unlock(&database_lock);
}

EXPORT void tup_sqlite_init(void *handler)
{
    pedestal_integrity_shutdown();
    pthread_mutex_lock(&database_lock);
    callback = (native_callback)handler;
    pthread_mutex_unlock(&database_lock);
}

EXPORT void tup_sqlite_send_msg(const char *text)
{
    struct native_request request;
    if (native_parse(&request, text)) return;
    pthread_mutex_lock(&database_lock);
    native_callback handler = callback;
    if (request.cmd == 80 || request.cmd == 91) {
        pthread_mutex_unlock(&database_lock);
        pedestal_integrity_execute(&request, handler);
        native_release(&request);
        return;
    }
    const char *description = command_name(request.cmd);
    if (description && !json_object_is_type(native_get(request.root, "description"), json_type_string))
        json_object_object_add(request.root, "description", json_object_new_string(description));
    struct json_object *param = request.param, *reply = NULL;
    int64_t result = -ENOSYS;
    switch (request.cmd) {
    case 1: result = initialize_account(native_string(param, "_useraccount", NULL)); break;
    case 2: result = insert_record(system_db, &system_config_record, native_get(param, "_keyvalue")); break;
    case 25: result = insert_record(user_db, &user_config_record, native_get(param, "_keyvalue")); break;
    case 3: case 6: case 26: case 73: case 93:
        result = delete_rows(request.cmd, native_get(param, "_matchinfo")); break;
    case 4: result = query_config(system_db, &system_config_record, native_get(param, "_matchinfo"), &reply); break;
    case 27: result = query_config(user_db, &user_config_record, native_get(param, "_matchinfo"), &reply); break;
    case 5: result = insert_record(system_db, &login_record, native_get(param, "_logininfo")); break;
    case 7: result = query_logins(native_get(param, "_matchinfo"), &reply); break;
    case 71: result = insert_record(history_db, &call_record, native_get(param, "_callrecordinfo")); break;
    case 72: result = insert_list(history_db, &call_record, param, "_callrecordinfolist"); break;
    case 74: result = query_calls(native_get(param, "_multimatchinfo"), &reply); break;
    case 76: {
        char serial[256];
        login_security_disk_serial(serial, sizeof(serial));
        reply = json_object_new_object();
        json_object_object_add(reply, "discserialnumber", json_object_new_string(serial));
        result = 0;
        break;
    }
    case 77: case 89: result = set_public_key(param, request.cmd == 89); break;
    case 78: {
        char path[PATH_MAX], metadata[NATIVE_STORAGE_METADATA_SIZE] = "";
        int error = public_metadata_path(path);
        if (!error) error = native_storage_read_metadata(path, metadata, sizeof(metadata));
        result = error && error != ENOENT ? -1 : 0;
        reply = json_object_new_object();
        json_object_object_add(reply, "secvalue", json_object_new_string(metadata));
        break;
    }
    case 79:
        result = configure_base(native_string(param, "_dbpath", NULL),
                                native_string(param, "_kmcpath", NULL)) ? 1 : 0;
        break;
    case 90: result = set_log(native_string(param, "_logpath", NULL)) ? -1 : 0; break;
    case 92: result = insert_list(system_db, &login_record, param, "_logininfolist"); break;
    }
    if (log_file) fprintf(log_file, "cmd=%lld result=%lld\n", (long long)request.cmd, (long long)result);
    pthread_mutex_unlock(&database_lock);
    native_respond(handler, &request, result, reply);
    native_release(&request);
}

EXPORT void tup_sqlite_shutdown(void)
{
    pedestal_integrity_shutdown();
    pthread_mutex_lock(&database_lock);
    close_all();
    callback = NULL;
    base_path[0] = 0;
    public_kmc_path[0] = 0;
    if (log_file) fclose(log_file);
    log_file = NULL;
    pthread_mutex_unlock(&database_lock);
}
