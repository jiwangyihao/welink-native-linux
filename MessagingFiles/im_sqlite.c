/* Native IM-specific SQLite service. This is not the pedestal database ABI. */
#define _GNU_SOURCE
#include "im_sqlite.h"
#include "im_transport_db.h"
#include "im_transport_dispatch.h"
#include <errno.h>
#include <fcntl.h>
#include <gio/gio.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

struct im_db_context {
    char *application, *root, *directory, *account, *log_directory;
    FILE *log;
    struct native_storage_key public_key, private_key;
    gboolean public_key_ready, private_key_ready;
    sqlite3 *database[6];
    gint archive_enabled;
    unsigned archive_interval;
    gint64 next_archive;
};
static const struct { const char *logical, *filename; } database_names[] = {
    {"sysdb", "sys.db"}, {"userdb", "user.db"}, {"historydb", "history.db"},
    {"conversationdb", "conversation.db"}, {"specialMsgdb", "specialMsg.db"},
    {"tempHistorydb", "tempHistory.db"}
};
struct im_database_job { struct native_request request; };
static struct im_db_context db_context;
static GMutex db_lifecycle;
static GAsyncQueue *db_requests;
static GThread *db_thread;
static native_callback db_callback;
static gint db_stopping;
static char db_stop_marker;
static struct im_dispatch_queue db_callbacks;
static guint64 db_callback_epoch;

static gboolean database_exists(const char *path)
{
    struct stat stat;
    return !lstat(path, &stat);
}

static int key_load(struct im_db_context *context, const char *metadata, gboolean data_exists,
                    const char *account, struct native_storage_key *key)
{
    if (database_exists(metadata)) return native_storage_load_key(metadata, context->root, account, 0, key);
    if (data_exists) return ENOENT;
    /* CheckGUIDAccount compares decrypted private metadata with the complete
     * account, not account + '=' and not a random GUID. */
    if (account) return native_storage_load_key(metadata, context->root, account, 1, key);
    /* IM GUID metadata must fit the original 512-byte reader. The generic
     * storage helper's maximum-sized default is inappropriate for this SDK. */
    char *guid = g_uuid_string_random();
    if (!guid) return ENOMEM;
    int result = native_storage_load_key(metadata, context->root, guid, 1, key);
    g_free(guid);
    return result;
}

static int database_configure(sqlite3 *database)
{
    sqlite3_busy_timeout(database, 5000);
    int result = sqlite3_exec(database,
        "PRAGMA journal_mode=WAL;PRAGMA foreign_keys=OFF;"
        "CREATE TABLE IF NOT EXISTS TestOpenTab(ID INTEGER,VALUE VARCHAR(32));"
        "CREATE UNIQUE INDEX IF NOT EXISTS UNIQUE_INDEX_ID ON TestOpenTab(ID);", NULL, NULL, NULL);
    int sample = g_random_int_range(0, 32768);
    sqlite3_stmt *statement = NULL;
    if (!result) result = sqlite3_prepare_v2(database, "REPLACE INTO TestOpenTab(ID,VALUE) VALUES(1,?1)", -1, &statement, NULL);
    if (!result) result = sqlite3_bind_int(statement, 1, sample);
    if (!result && sqlite3_step(statement) != SQLITE_DONE) result = sqlite3_errcode(database);
    sqlite3_finalize(statement); statement = NULL;
    if (!result) result = sqlite3_prepare_v2(database, "SELECT VALUE FROM TestOpenTab WHERE ID=1", -1, &statement, NULL);
    if (!result && (sqlite3_step(statement) != SQLITE_ROW || sqlite3_column_int(statement, 0) != sample)) result = SQLITE_CORRUPT;
    sqlite3_finalize(statement);
    return result;
}

sqlite3 *im_db_database(struct im_db_context *context, const char *logical_name)
{
    unsigned index;
    for (index = 0; index < G_N_ELEMENTS(database_names); ++index)
        if (!strcmp(database_names[index].logical, logical_name)) break;
    if (index == G_N_ELEMENTS(database_names)) return NULL;
    if (index ? !context->private_key_ready : !context->public_key_ready) return NULL;
    if (context->database[index]) return context->database[index];
    const char *directory = index ? context->directory : context->root;
    const char *password = index ? context->private_key.password : context->public_key.password;
    if (!directory) return NULL;
    char *path = g_build_filename(directory, database_names[index].filename, NULL);
    sqlite3 *database = NULL;
    int status = native_storage_open(path, password, 1, &database);
    g_free(path);
    if (!status) status = database_configure(database);
    if (status) { if (database) sqlite3_close(database); return NULL; }
    context->database[index] = database;
    return database;
}

const char *im_db_directory(const struct im_db_context *context) { return context->directory; }
const char *im_db_account(const struct im_db_context *context) { return context->account; }

static gboolean database_relative_path(const char *filename)
{
    if (!filename || !*filename || g_path_is_absolute(filename) || strchr(filename, '\\')) return FALSE;
    for (const char *part = filename; *part;) {
        const char *end = strchr(part, '/');
        size_t length = end ? (size_t)(end - part) : strlen(part);
        if (!length || (length == 1 && *part == '.') || (length == 2 && !memcmp(part, "..", 2))) return FALSE;
        if (!end) return TRUE;
        part = end + 1;
    }
    return FALSE;
}

int im_db_open_file(struct im_db_context *context, const char *filename, int create, sqlite3 **database)
{
    *database = NULL;
    if (!context->private_key_ready || !context->directory || !database_relative_path(filename)) return SQLITE_MISUSE;
    char *path = g_build_filename(context->directory, filename, NULL);
    int status = native_storage_open(path, context->private_key.password, create, database);
    g_free(path);
    if (!status) status = database_configure(*database);
    if (status && *database) { sqlite3_close(*database); *database = NULL; }
    return status;
}

int im_db_open_archive(struct im_db_context *context, const char *filename,
                       const char *key_filename, int create, sqlite3 **database)
{
    *database = NULL;
    if (!context->private_key_ready || !context->directory || !database_relative_path(filename) ||
        !database_relative_path(key_filename)) return SQLITE_MISUSE;
    char *path = g_build_filename(context->directory, filename, NULL);
    char *metadata = g_build_filename(context->directory, key_filename, NULL);
    struct native_storage_key key = {0};
    int status;
    if (!database_exists(metadata) && create && !database_exists(path))
        status = native_storage_set_key(metadata, context->private_key.plain, context->private_key.nonce,
                                        context->private_key.metadata, &key);
    else status = native_storage_load_key(metadata, context->root, NULL, 0, &key);
    if (!status) status = native_storage_open(path, key.password, create, database);
    else status = SQLITE_NOTADB;
    if (!status) status = database_configure(*database);
    if (status && *database) { sqlite3_close(*database); *database = NULL; }
    native_storage_clear_key(&key); g_free(path); g_free(metadata);
    return status;
}

int im_db_archive_switch(struct im_db_context *context, int enabled)
{
    if (enabled != 0 && enabled != 1) return SQLITE_MISUSE;
    g_atomic_int_set(&context->archive_enabled, enabled);
    return SQLITE_OK;
}
int im_db_archive_enabled(const struct im_db_context *context)
{
    return g_atomic_int_get(&context->archive_enabled);
}

struct json_object *im_db_reply(const struct native_request *request, int result,
                               struct json_object *param, const char *description)
{
    struct json_object *reply = json_object_new_object();
    json_object_object_add(reply, "cmd", NULL);
    json_object_object_add(reply, "ret", NULL);
    json_object_object_add(reply, "rsp", json_object_get(native_get(request->root, "cmd")));
    struct json_object *sno = native_get(request->root, "sno");
    if (json_object_is_type(sno, json_type_int)) json_object_object_add(reply, "sno", json_object_get(sno));
    json_object_object_add(reply, "result", json_object_new_int(result));
    json_object_object_add(reply, "description", json_object_new_string(native_string(request->root, "description", description)));
    if (param) json_object_object_add(reply, "param", param);
    return reply;
}

static int database_close_private(struct im_db_context *context)
{
    g_atomic_int_set(&context->archive_enabled, 0);
    context->next_archive = 0;
    context->private_key_ready = FALSE;
    im_db_history_reset(context);
    int result = SQLITE_OK;
    for (unsigned index = 1; index < G_N_ELEMENTS(context->database); ++index) {
        if (!context->database[index]) continue;
        int status = sqlite3_close_v2(context->database[index]);
        if (status && !result) result = status;
        if (!status) context->database[index] = NULL;
    }
    if (!result) {
        g_clear_pointer(&context->directory, g_free);
        g_clear_pointer(&context->account, g_free);
        native_storage_clear_key(&context->private_key);
    }
    return result;
}

static int public_schema(struct im_db_context *context)
{
    sqlite3 *database = im_db_database(context, "sysdb");
    if (!database) return SQLITE_CANTOPEN;
    int status = sqlite3_exec(database,
        "CREATE TABLE IF NOT EXISTS SysConfigTab(AUTOID INTEGER PRIMARY KEY AUTOINCREMENT,KEY VARCHAR(256) NOT NULL,VALUE VARCHAR(512));"
        "CREATE UNIQUE INDEX IF NOT EXISTS SYSCONFIG_UNIQUE_INDEX ON SysConfigTab(KEY);"
        "CREATE TABLE IF NOT EXISTS LoginListTab(AUTOID INTEGER PRIMARY KEY AUTOINCREMENT,ACCOUNT VARCHAR(32) NOT NULL,DISPLAYACCOUNT VARCHAR(32) NOT NULL,PASSWORD VARCHAR(128) NOT NULL,AUTOLOGIN BOOLEAN NOT NULL DEFAULT(0),REMPWD BOOLEAN NOT NULL DEFAULT(0),USERRANDOM VARCHAR(128),TIMESTAMP VARCHAR(32),TENANTCN VARCHAR(151) NOT NULL,TENANTEN VARCHAR(128) NOT NULL,TENANTID VARCHAR(128) NOT NULL,THIRDCERTYPE BOOLEAN NOT NULL DEFAULT(0),ISMAXHUBWORKPLACE INTEGER,THIRDACCOUNT VARCHAR(129),MAXHUBMIDDLEENDADDRESS VARCHAR(256),SETPASSWORDTOKEN VARCHAR(512),THIRDAUTHTYPE VARCHAR(4),THIRDLOGINURL VARCHAR(512),REALNAMEAUTH INTEGER,USERIV VARCHAR(289));"
        "CREATE UNIQUE INDEX IF NOT EXISTS LOGINLIST_UNIQUE_INDEX ON LoginListTab(ACCOUNT);", NULL, NULL, NULL);
    return status ? status : im_db_history_public_schema(context);
}

static int private_core_schema(struct im_db_context *context)
{
    sqlite3 *user = im_db_database(context, "userdb");
    sqlite3 *conversation = im_db_database(context, "conversationdb");
    sqlite3 *history = im_db_database(context, "historydb");
    if (!user || !conversation || !history) return SQLITE_CANTOPEN;
    int status = sqlite3_exec(user,
        "CREATE TABLE IF NOT EXISTS UserConfigTab(AUTOID INTEGER PRIMARY KEY AUTOINCREMENT,KEY VARCHAR(256) NOT NULL,VALUE VARCHAR(512));"
        "CREATE UNIQUE INDEX IF NOT EXISTS USERCONFIG_UNIQUE_INDEX ON UserConfigTab(KEY);"
        "CREATE TABLE IF NOT EXISTS UserCommonKeyValueTab(RECORD_ID INTEGER PRIMARY KEY AUTOINCREMENT,KEY VARCHAR(128),VALUE VARCHAR(4096));"
        "CREATE UNIQUE INDEX IF NOT EXISTS COMMONKEYVALUE_UNIQUE_INDEX_KEY ON UserCommonKeyValueTab(KEY);", NULL, NULL, NULL);
    const char *common_schema =
        "CREATE TABLE IF NOT EXISTS DBVersionTab(VERSION_KEY VARCHAR(20) NOT NULL PRIMARY KEY,VERSION_VALUE VARCHAR(20));"
        "CREATE TABLE IF NOT EXISTS UserConfigTab(AUTOID INTEGER PRIMARY KEY AUTOINCREMENT,KEY VARCHAR(256) NOT NULL,VALUE VARCHAR(512));"
        "CREATE UNIQUE INDEX IF NOT EXISTS USERCONFIG_UNIQUE_INDEX ON UserConfigTab(KEY);"
        "CREATE TABLE IF NOT EXISTS CommonKeyValueTab(RECORD_ID INTEGER PRIMARY KEY AUTOINCREMENT,KEY VARCHAR(128),VALUE VARCHAR(4096));"
        "CREATE UNIQUE INDEX IF NOT EXISTS COMMONKEYVALUE_UNIQUE_INDEX_KEY ON CommonKeyValueTab(KEY);";
    if (!status) status = sqlite3_exec(conversation, common_schema, NULL, NULL, NULL);
    if (!status) status = sqlite3_exec(history, common_schema, NULL, NULL, NULL);
    sqlite3_stmt *account = NULL;
    if (!status) status = sqlite3_prepare_v2(user,
        "INSERT OR IGNORE INTO UserConfigTab(KEY,VALUE) VALUES('loginaccount',?1)", -1, &account, NULL);
    if (!status) status = sqlite3_bind_text(account, 1, context->account, -1, SQLITE_TRANSIENT);
    if (!status && sqlite3_step(account) != SQLITE_DONE) status = sqlite3_errcode(user);
    sqlite3_finalize(account); account = NULL;
    if (!status) status = sqlite3_prepare_v2(user, "SELECT VALUE FROM UserConfigTab WHERE KEY='loginaccount'", -1, &account, NULL);
    if (!status && (sqlite3_step(account) != SQLITE_ROW || !sqlite3_column_text(account, 0) ||
        strcmp((const char *)sqlite3_column_text(account, 0), context->account))) status = SQLITE_AUTH;
    sqlite3_finalize(account);
    return status;
}

static int private_version_commit(struct im_db_context *context)
{
    static const char statement[] =
        "INSERT INTO DBVersionTab(VERSION_KEY,VERSION_VALUE) VALUES('DBVersion','3.0') "
        "ON CONFLICT(VERSION_KEY) DO UPDATE SET VERSION_VALUE=excluded.VERSION_VALUE "
        "WHERE VERSION_VALUE!='3.0'";
    sqlite3 *history = im_db_database(context, "historydb");
    sqlite3 *conversation = im_db_database(context, "conversationdb");
    if (!history || !conversation) return SQLITE_CANTOPEN;
    int result = sqlite3_exec(history, statement, NULL, NULL, NULL);
    if (!result) result = sqlite3_exec(conversation, statement, NULL, NULL, NULL);
    return result;
}

static int private_key_backup(struct im_db_context *context)
{
    char *directory = g_build_filename(context->application, "appdata", "kmcdata", context->account, NULL);
    int result = native_storage_mkdirs(directory);
    static const char *names[] = {"config_private.db", "config_private_bak.db"};
    for (unsigned n = 0; !result && n < G_N_ELEMENTS(names); ++n) {
        char *path = g_build_filename(directory, names[n], NULL);
        struct native_storage_key written = {0};
        result = native_storage_set_key(path, context->private_key.plain, context->private_key.nonce,
                                        context->private_key.metadata, &written);
        native_storage_clear_key(&written); g_free(path);
    }
    g_free(directory);
    return result;
}

static int database_initialize(struct im_db_context *context, const struct native_request *request)
{
    const char *account = native_string(request->param, "_useraccount", NULL);
    const char *directory = native_string(request->param, "_dbpath", NULL);
    if (database_close_private(context)) return 1;
    if (!account || !directory) return 1;
    if (!*account) return 0;
    if (!strcmp(account, "public")) {
        if (!context->public_key_ready) {
            char *metadata = g_build_filename(context->root, "config.db", NULL);
            char *path = g_build_filename(context->root, "sys.db", NULL);
            int status = key_load(context, metadata, database_exists(path), NULL, &context->public_key);
            g_free(metadata); g_free(path);
            if (status) return 1;
            context->public_key_ready = TRUE;
        }
        return public_schema(context) ? 1 : 0;
    }
    if (!*directory || strchr(account, '/') || strchr(account, '\\') || !strcmp(account, ".") || !strcmp(account, "..")) return 1;
    context->directory = g_canonicalize_filename(directory, context->root);
    context->account = g_strdup(account);
    if (native_storage_mkdirs(context->directory)) goto failed;
    gboolean existing = FALSE;
    for (unsigned index = 1; index < G_N_ELEMENTS(database_names); ++index) {
        char *path = g_build_filename(context->directory, database_names[index].filename, NULL);
        existing |= database_exists(path); g_free(path);
    }
    char *metadata = g_build_filename(context->directory, "config_private.db", NULL);
    int status = key_load(context, metadata, existing, context->account, &context->private_key);
    g_free(metadata);
    if (status) goto failed;
    context->private_key_ready = TRUE;
    if (private_core_schema(context) || im_db_entities_schema(context) || im_db_history_schema(context) ||
        private_version_commit(context) || private_key_backup(context) ||
        im_db_history_archive_configure(context, &context->archive_interval)) goto failed;
    context->next_archive = g_get_monotonic_time() + (gint64)context->archive_interval * 1000;
    return 0;
failed:
    database_close_private(context);
    return 1;
}

#include "im_transport_db_core.inc"

static int deliver_database_callback(const char *text, int tag, gpointer unused)
{
    (void)tag; (void)unused;
    g_mutex_lock(&db_lifecycle);
    native_callback callback = g_atomic_int_get(&db_stopping) ? NULL : db_callback;
    g_mutex_unlock(&db_lifecycle);
    if (!callback) return 0;
    callback(text);
    return 1;
}

IM_SDK_EXPORT int SqliteServiceDispatchCallbacks(void)
{
    return im_dispatch_run(&db_callbacks, deliver_database_callback, NULL);
}

static void database_emit(struct json_object *reply)
{
    if (db_context.log) {
        fprintf(db_context.log, "cmd=%lld result=%lld\n", (long long)native_integer(reply, "rsp", -1),
            (long long)native_integer(reply, "result", -1));
        fflush(db_context.log);
    }
    im_dispatch_json(&db_callbacks, db_callback_epoch, reply, 0);
}

static gpointer database_worker(gpointer unused)
{
    (void)unused;
    while (!g_atomic_int_get(&db_stopping)) {
        gpointer item;
        if (db_context.next_archive) {
            gint64 delay = db_context.next_archive - g_get_monotonic_time();
            if (delay <= 0) {
                if (im_db_archive_enabled(&db_context)) im_db_history_archive(&db_context);
                db_context.next_archive = g_get_monotonic_time() + (gint64)db_context.archive_interval * 1000;
                continue;
            }
            item = g_async_queue_timeout_pop(db_requests, delay);
            if (!item) continue;
        } else item = g_async_queue_pop(db_requests);
        if (item == &db_stop_marker) break;
        struct im_database_job *job = item;
        struct json_object *reply = NULL;
        if (!im_db_core(&db_context, &job->request, &reply) &&
            !im_db_entities(&db_context, &job->request, &reply) &&
            !im_db_history(&db_context, &job->request, &reply))
            reply = im_db_reply(&job->request, -1, NULL, "unsupported IM database command");
        if (reply) database_emit(reply);
        native_release(&job->request); g_free(job);
    }
    database_close_private(&db_context);
    if (db_context.database[0]) { sqlite3_close(db_context.database[0]); db_context.database[0] = NULL; }
    native_storage_clear_key(&db_context.public_key);
    db_context.public_key_ready = FALSE;
    if (db_context.log) { fclose(db_context.log); db_context.log = NULL; }
    g_mutex_lock(&db_lifecycle);
    gpointer item;
    while ((item = g_async_queue_try_pop(db_requests))) {
        if (item == &db_stop_marker) continue;
        struct im_database_job *job = item;
        native_release(&job->request); g_free(job);
    }
    g_async_queue_unref(db_requests); db_requests = NULL;
    GThread *finished = db_thread; db_thread = NULL;
    g_clear_pointer(&db_context.application, g_free); g_clear_pointer(&db_context.root, g_free);
    g_clear_pointer(&db_context.log_directory, g_free);
    g_mutex_unlock(&db_lifecycle);
    g_thread_unref(finished);
    return NULL;
}

int InitSqliteService(const char *log_directory, const char *application_directory,
                      const char *database_root, native_callback callback)
{
    if (!log_directory || !application_directory || !*application_directory || !database_root || !*database_root || !callback) return EINVAL;
    g_mutex_lock(&db_lifecycle);
    if (db_thread) { g_mutex_unlock(&db_lifecycle); return EALREADY; }
    db_context.application = g_canonicalize_filename(application_directory, NULL);
    db_context.root = g_canonicalize_filename(database_root, NULL);
    db_context.log_directory = g_strdup(log_directory);
    int result = native_storage_mkdirs(db_context.root);
    if (!result) result = database_set_log_path(&db_context, log_directory);
    if (!result) {
        db_requests = g_async_queue_new(); db_callback = callback;
        g_atomic_int_set(&db_stopping, 0);
        db_callback_epoch = im_dispatch_start(&db_callbacks);
        if (db_callback_epoch) db_thread = g_thread_try_new("welink-im-db", database_worker, NULL, NULL);
        if (!db_thread) result = EAGAIN;
    }
    if (result) {
        im_dispatch_stop(&db_callbacks);
        if (db_context.log) { fclose(db_context.log); db_context.log = NULL; }
        if (db_requests) g_async_queue_unref(db_requests);
        db_requests = NULL; db_callback = NULL;
        g_clear_pointer(&db_context.application, g_free); g_clear_pointer(&db_context.root, g_free);
        g_clear_pointer(&db_context.log_directory, g_free);
    }
    g_mutex_unlock(&db_lifecycle);
    return result;
}

void SqliteServiceSendMsg(const char *text)
{
    struct im_database_job *job = g_new0(struct im_database_job, 1);
    if (native_parse(&job->request, text)) { g_free(job); return; }
    g_mutex_lock(&db_lifecycle);
    if (db_thread && !g_atomic_int_get(&db_stopping)) { g_async_queue_push(db_requests, job); job = NULL; }
    g_mutex_unlock(&db_lifecycle);
    if (job) { native_release(&job->request); g_free(job); }
}

void SqliteServiceShutdown(void)
{
    g_mutex_lock(&db_lifecycle);
    if (!db_thread || g_atomic_int_get(&db_stopping)) { g_mutex_unlock(&db_lifecycle); return; }
    g_atomic_int_set(&db_stopping, 1);
    g_atomic_int_set(&db_context.archive_enabled, 0);
    im_dispatch_stop(&db_callbacks);
    g_async_queue_push(db_requests, &db_stop_marker);
    g_mutex_unlock(&db_lifecycle);
}
