/* Original backup: plain ZIP -> importMsgTempFile/{history.db,config_private.db}.
 * The latter is a raw 64-character derived key, not the profile KMC envelope.
 * PE: 10032070,100386d0,10044440,10046f40,1003d990; SQL strings d78e8-d97d4.
 * No profile key is created, rekeyed, or replaced by import/export.
 */
#define _GNU_SOURCE
#include "ie_internal.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <openssl/crypto.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* Unix xFullPathname normally resolves /proc/self/fd and returns
 * SQLITE_OK_SYMLINK, which SQLITE_OPEN_NOFOLLOW rejects. This private VFS
 * preserves only our validated descriptor-relative names. Unix xOpen still
 * enforces O_NOFOLLOW on every database/journal leaf (amalgamation:41763).
 * Directory descriptors outlive their SQLite handles. Copy only the named
 * plain Unix VFS: SQLite3MC's default VFS is an extended sqlite3mc_vfs with
 * private mutex/list fields and must never be copied as a sqlite3_vfs. Its
 * public factory installs the genuine cipher wrapper above this path shim. */
#define IE_FD_VFS_NAME "welink-import-export-fd"
#define IE_CIPHER_VFS_NAME "multipleciphers-" IE_FD_VFS_NAME
static sqlite3_vfs descriptor_vfs;
static int descriptor_vfs_result = SQLITE_ERROR;
static pthread_once_t descriptor_vfs_once = PTHREAD_ONCE_INIT;
static int descriptor_path(sqlite3_vfs *vfs, const char *input, int capacity, char *output)
{
    (void)vfs;
    const char prefix[] = "/proc/self/fd/";
    if (strncmp(input, prefix, sizeof prefix - 1)) return SQLITE_CANTOPEN;
    char *end = NULL;
    errno = 0;
    long fd = strtol(input + sizeof prefix - 1, &end, 10);
    struct stat info;
    if (errno || fd < 0 || fd > INT_MAX || !end || *end != '/' ||
        !ie_component(end + 1) || fstat((int)fd, &info) || !S_ISDIR(info.st_mode))
        return SQLITE_CANTOPEN;
    size_t length = strlen(input);
    if (length >= (size_t)capacity) return SQLITE_CANTOPEN;
    memcpy(output, input, length + 1);
    return SQLITE_OK;
}
static void register_descriptor_vfs(void)
{
    sqlite3_vfs *base = sqlite3_vfs_find("unix");
    if (!base) { descriptor_vfs_result = SQLITE_NOTFOUND; return; }
    descriptor_vfs = *base;
    descriptor_vfs.pNext = NULL;
    descriptor_vfs.zName = IE_FD_VFS_NAME;
    descriptor_vfs.xFullPathname = descriptor_path;
    descriptor_vfs_result = sqlite3_vfs_register(&descriptor_vfs, 0);
    if (descriptor_vfs_result == SQLITE_OK) {
        descriptor_vfs_result = sqlite3mc_vfs_create(IE_FD_VFS_NAME, 0);
        if (descriptor_vfs_result != SQLITE_OK) sqlite3_vfs_unregister(&descriptor_vfs);
    }
}

static int progress_sql(void *context) { return ie_cancelled(context); }
int ie_open_database(struct ie_job *job, int directory, const char *name, const char *password,
                     int create, int writable, sqlite3 **out)
{
    *out = NULL;
    if (!ie_component(name)) return SQLITE_CANTOPEN;
    pthread_once(&descriptor_vfs_once, register_descriptor_vfs);
    if (descriptor_vfs_result != SQLITE_OK) return descriptor_vfs_result;
    int fd = openat(directory, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0 && create && errno == ENOENT) {
        fd = openat(directory, name, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
        if (fd >= 0 && fchmod(fd, 0600)) { close(fd); return SQLITE_CANTOPEN; }
    }
    struct stat info;
    if (fd < 0) return SQLITE_CANTOPEN;
    int invalid = fstat(fd, &info) || !S_ISREG(info.st_mode);
    close(fd);
    if (invalid) return SQLITE_CANTOPEN;
    char *path = ie_fd_path(directory, name);
    sqlite3 *db = NULL;
    int rc = sqlite3_open_v2(path, &db, (writable ? SQLITE_OPEN_READWRITE : SQLITE_OPEN_READONLY) |
        SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW, IE_CIPHER_VFS_NAME);
    g_free(path);
    if (!rc && (sqlite3mc_config(db, "cipher", CODEC_TYPE_AES256) < 0 ||
        sqlite3mc_config_cipher(db, "aes256cbc", "legacy", 0) < 0 ||
        sqlite3mc_config_cipher(db, "aes256cbc", "kdf_iter", 4001) < 0)) rc = SQLITE_ERROR;
    if (!rc) rc = sqlite3_key(db, password, (int)strlen(password));
    if (!rc) {
        sqlite3_db_config(db, SQLITE_DBCONFIG_DEFENSIVE, 1, NULL);
        sqlite3_db_config(db, SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, NULL);
        rc = sqlite3_exec(db, "PRAGMA temp_store=MEMORY", NULL, NULL, NULL);
        sqlite3_limit(db, SQLITE_LIMIT_LENGTH, IE_MAX_VALUE);
        sqlite3_limit(db, SQLITE_LIMIT_SQL_LENGTH, IE_MAX_REQUEST);
        sqlite3_busy_timeout(db, 0); /* Busy is failure, never an unbounded wait. */
        sqlite3_progress_handler(db, 1000, progress_sql, job);
        sqlite3_stmt *check = NULL;
        if (!rc) rc = sqlite3_prepare_v2(db, "SELECT count(*) FROM sqlite_master", -1, &check, NULL);
        if (!rc) rc = sqlite3_step(check) == SQLITE_ROW ? SQLITE_OK : sqlite3_errcode(db);
        sqlite3_finalize(check);
    }
    if (rc) { if (db) sqlite3_close(db); return rc; }
    *out = db; return SQLITE_OK;
}
static int load_key(struct ie_job *job, struct ie_database *entry)
{
    char *metadata = ie_fd_path(entry->directory, entry->keyfile);
    char *kmc = ie_fd_path(job->im_fd, "");
    int rc = native_storage_load_key(metadata, kmc, job->account, 0, &entry->key);
    g_free(metadata); g_free(kmc); return rc;
}
static void database_free(gpointer pointer)
{
    struct ie_database *entry = pointer;
    if (entry->db) sqlite3_close(entry->db);
    if (entry->directory >= 0) close(entry->directory);
    native_storage_clear_key(&entry->key);
    g_free(entry->name); g_free(entry->keyfile); g_free(entry);
}
static int add_database(struct ie_job *job, int directory, const char *name, const char *keyfile,
                        const char *maximum, const char *minimum)
{
    if (job->databases->len >= IE_MAX_DATABASES || !ie_component(name) || !ie_component(keyfile) ||
        strlen(maximum) > 32 || strlen(minimum) > 32) return ie_fail(job, 12, "InitDbList  failed");
    for (const char *p = minimum; *p; ++p) if (!g_ascii_isdigit(*p)) return ie_fail(job, 12, "invalid database timestamp");
    for (const char *p = maximum; *p; ++p) if (!g_ascii_isdigit(*p)) return ie_fail(job, 12, "invalid database timestamp");
    if (*minimum && *maximum && strcmp(minimum, maximum) > 0) return ie_fail(job, 12, "invalid database range");
    for (unsigned i = 0; i < job->databases->len; ++i) {
        struct ie_database *old = g_ptr_array_index(job->databases, i);
        if (!strcmp(old->name, name)) return ie_fail(job, 12, "InitDbList  failed");
    }
    struct ie_database *entry = g_new0(struct ie_database, 1);
    entry->directory = fcntl(directory, F_DUPFD_CLOEXEC, 3);
    entry->name = g_strdup(name); entry->keyfile = g_strdup(keyfile);
    g_strlcpy(entry->maximum, maximum, sizeof entry->maximum);
    g_strlcpy(entry->minimum, minimum, sizeof entry->minimum);
    g_ptr_array_add(job->databases, entry);
    if (entry->directory < 0 || load_key(job, entry) ||
        ie_open_database(job, entry->directory, name, entry->key.password, 0, 0, &entry->db))
        return ie_fail(job, 12, "InitDbList  failed");
    if (sqlite3_exec(entry->db, "BEGIN", NULL, NULL, NULL)) return ie_fail(job, 12, "InitDbList  failed");
    sqlite3_stmt *check = NULL;
    int rc = sqlite3_prepare_v2(entry->db, "SELECT min(UTCSTAMP),max(UTCSTAMP) FROM RecordTab WHERE (RECORDTYPE=0 OR RECORDTYPE=1) AND PEERNAME!='[Group Notify]'", -1, &check, NULL);
    if (!rc && sqlite3_step(check) == SQLITE_ROW) {
        if (!*entry->minimum) g_strlcpy(entry->minimum, (const char *)(sqlite3_column_text(check, 0) ?: (const unsigned char *)"0000000000000"), sizeof entry->minimum);
        if (!*entry->maximum) g_strlcpy(entry->maximum, (const char *)(sqlite3_column_text(check, 1) ?: (const unsigned char *)"9999999999999"), sizeof entry->maximum);
    } else rc = SQLITE_ERROR;
    sqlite3_finalize(check);
    return rc ? ie_fail(job, 12, "InitDbList  failed") : 0;
}
static char *user_config(sqlite3 *db, const char *key)
{
    if (!db) return NULL;
    sqlite3_stmt *statement = NULL;
    char *value = NULL;
    int rc = sqlite3_prepare_v2(db, "SELECT VALUE FROM UserConfigTab WHERE KEY=?1", -1, &statement, NULL);
    if (!rc) rc = sqlite3_bind_text(statement, 1, key, -1, SQLITE_STATIC);
    if (!rc && sqlite3_step(statement) == SQLITE_ROW) value = g_strdup((const char *)sqlite3_column_text(statement, 0));
    sqlite3_finalize(statement); return value;
}
int ie_load_profile(struct ie_job *job)
{
    job->desktop_fd = ie_open_directory(job->desktop);
    int appdata = job->desktop_fd < 0 ? -1 : ie_open_subdir(job->desktop_fd, "appdata", 0);
    job->im_fd = appdata < 0 ? -1 : ie_open_subdir(appdata, "IM", 0);
    if (appdata >= 0) close(appdata);
    job->account_fd = job->im_fd < 0 ? -1 : ie_open_subdir(job->im_fd, job->account, 0);
    if (job->account_fd < 0) return ie_fail(job, 12, "InitDbList  failed");
    job->databases = g_ptr_array_new_with_free_func(database_free);
    int archive = ie_open_subdir(job->account_fd, "ArchiveFiles", 0);
    if (archive >= 0) {
        char *text = g_malloc(IE_MAX_REQUEST + 1);
        int rc = ie_read_small(archive, "DatabaseInfo.dat", text, IE_MAX_REQUEST + 1);
        if (rc && rc != ENOENT) ie_fail(job, 12, "InitDbList  failed");
        if (!rc) {
            char **lines = g_strsplit(text, "\n", -1);
            for (unsigned n = 0; lines[n] && !job->error; ++n) {
                g_strchomp(lines[n]); if (!*lines[n]) continue;
                char **fields = g_strsplit(lines[n], "#", -1);
                char *end = NULL;
                if (g_strv_length(fields) != 7 || !*fields[6] || g_ascii_strtoull(fields[6], &end, 10) != job->databases->len || !end || *end)
                    ie_fail(job, 12, "InitDbList  failed");
                else if (!strcmp(fields[0], "historydb")) {
                    /* Migration metadata can contain the live entry. */
                    add_database(job, job->account_fd, "history.db", "config_private.db", fields[2], fields[3]);
                } else add_database(job, archive, fields[0], fields[1], fields[2], fields[3]);
                g_strfreev(fields);
            }
            g_strfreev(lines);
        }
        g_free(text); close(archive);
    } else if (errno != ENOENT) return ie_fail(job, 12, "InitDbList  failed");
    if (job->error) return -1;
    int live = -1;
    for (unsigned i = 0; i < job->databases->len; ++i)
        if (!strcmp(((struct ie_database *)g_ptr_array_index(job->databases, i))->name, "history.db")) live = (int)i;
    if (live < 0) {
        if (add_database(job, job->account_fd, "history.db", "config_private.db", "", "")) return -1;
        live = (int)job->databases->len - 1;
    }
    /* Original enumeration puts the live database last. Reject ambiguous
     * migration ordering instead of assigning records to guessed shards. */
    if ((unsigned)live != job->databases->len - 1) return ie_fail(job, 12, "invalid database ordering");
    struct ie_database *current = g_ptr_array_index(job->databases, (unsigned)live);
    struct stat info;
    if (!fstatat(job->account_fd, "user.db", &info, AT_SYMLINK_NOFOLLOW)) {
        if (ie_open_database(job, job->account_fd, "user.db", current->key.password, 0, 0, &job->user_db))
            return ie_fail(job, 12, "openUserDb failed");
    } else if (errno != ENOENT) return ie_fail(job, 12, "openUserDb failed");
    char *period = user_config(job->user_db, "HistoryPeriod");
    if (period && *period && strcmp(period, "0")) {
        char *end = NULL; errno = 0;
        int64_t days = g_ascii_strtoll(period, &end, 10);
        if (errno || *end || days < 0 || days > 365000) { g_free(period); return ie_fail(job, 12, "invalid HistoryPeriod"); }
        time_t then = time(NULL) - days * INT64_C(86400);
        struct tm calendar;
        if (!localtime_r(&then, &calendar)) { g_free(period); return ie_fail(job, 12, "invalid HistoryPeriod"); }
        calendar.tm_hour = calendar.tm_min = calendar.tm_sec = 0; calendar.tm_isdst = -1;
        int64_t milliseconds = (int64_t)mktime(&calendar) * 1000;
        snprintf(job->policy_minimum, sizeof job->policy_minimum, "%013" G_GINT64_FORMAT, milliseconds);
        if (strcmp(job->minimum, job->policy_minimum) < 0) job->minimum = job->policy_minimum;
        if (strcmp(job->maximum, job->policy_minimum) < 0) job->maximum = job->policy_minimum;
    }
    g_free(period); return 0;
}
void ie_close_profile(struct ie_job *job)
{
    if (job->user_db) { sqlite3_close(job->user_db); job->user_db = NULL; }
    if (job->contact_db) { sqlite3_close(job->contact_db); job->contact_db = NULL; }
    if (job->databases) { g_ptr_array_free(job->databases, TRUE); job->databases = NULL; }
}
int ie_column(sqlite3_stmt *row, const char *name)
{
    for (int i = 0; i < sqlite3_column_count(row); ++i) if (!g_ascii_strcasecmp(sqlite3_column_name(row, i), name)) return i;
    return -1;
}
const char *ie_column_text(sqlite3_stmt *row, const char *name)
{
    int column = ie_column(row, name);
    const unsigned char *value = column < 0 ? NULL : sqlite3_column_text(row, column);
    return value ? (const char *)value : "";
}
static int select_rows(struct ie_job *job, sqlite3 *db, int count_only, sqlite3_stmt **out)
{
    const char *filter = job->format == 0 ?
        " AND MEDIATYPE NOT IN(11,13) AND RECORDTYPE IN(0,1) AND ISWITHDRAW=0 AND ISDELETE=0" :
        job->format == 1 ? " AND MEDIATYPE IN(3,8) AND RECORDTYPE IN(0,1)" : "";
    char *sql = g_strdup_printf("SELECT %s FROM RecordTab WHERE UTCSTAMP>=?1 AND UTCSTAMP<=?2%s%s%s",
        count_only ? "count(*)" : "*", filter, *job->conversation ? " AND CONVERSATION_ID=?3" : "",
        count_only ? "" : " ORDER BY UTCSTAMP,RECORD_ID");
    int rc = sqlite3_prepare_v2(db, sql, -1, out, NULL); g_free(sql);
    if (!rc) rc = sqlite3_bind_text(*out, 1, job->minimum, -1, SQLITE_STATIC);
    if (!rc) rc = sqlite3_bind_text(*out, 2, job->maximum, -1, SQLITE_STATIC);
    if (!rc && *job->conversation) rc = sqlite3_bind_text(*out, 3, job->conversation, -1, SQLITE_STATIC);
    return rc;
}
static void append_identifier(GString *sql, const char *name)
{
    char *quoted = sqlite3_mprintf("\"%w\"", name);
    g_string_append(sql, quoted); sqlite3_free(quoted);
}
static int create_backup_schema(sqlite3 *source, sqlite3 *backup)
{
    sqlite3_stmt *columns = NULL;
    int rc = sqlite3_prepare_v2(source, "PRAGMA table_info(RecordTab)", -1, &columns, NULL);
    GString *sql = g_string_new("CREATE TABLE RecordTab("); unsigned count = 0;
    int step = SQLITE_DONE;
    while (!rc && (step = sqlite3_step(columns)) == SQLITE_ROW) {
        const char *name = (const char *)sqlite3_column_text(columns, 1);
        const char *type = (const char *)sqlite3_column_text(columns, 2);
        if (!name || !type || ++count > 256) { rc = SQLITE_SCHEMA; break; }
        if (count > 1) g_string_append_c(sql, ',');
        append_identifier(sql, name);
        if (!g_ascii_strcasecmp(name, "RECORD_ID")) g_string_append(sql, " INTEGER PRIMARY KEY AUTOINCREMENT");
        else { g_string_append_c(sql, ' '); append_identifier(sql, type); }
    }
    if (!rc && (step != SQLITE_DONE || !count)) rc = SQLITE_SCHEMA;
    sqlite3_finalize(columns);
    g_string_append(sql, ");CREATE UNIQUE INDEX RECORD_UNIQUE_INDEX_SERVERMESSAGEID ON RecordTab(SERVERMESSAGEID);"
        "CREATE INDEX RECORD_INDEX_CLIENTMESSAGEID ON RecordTab(CLIENTMESSAGEID);"
        "CREATE INDEX RECORD_INDEX_CVSID ON RecordTab(CONVERSATION_ID);"
        "CREATE INDEX RECORD_INDEX_UTCSTAMP ON RecordTab(UTCSTAMP);"
        "CREATE INDEX RECORD_INDEX_CVSID_UTCSTAMP_SERVERMESSAGEID ON RecordTab(CONVERSATION_ID,UTCSTAMP,SERVERMESSAGEID);"
        "CREATE TABLE UserConfigTab(AUTOID INTEGER PRIMARY KEY AUTOINCREMENT,KEY VARCHAR(256) NOT NULL,VALUE VARCHAR(512));"
        "CREATE UNIQUE INDEX USERCONFIG_UNIQUE_INDEX ON UserConfigTab(KEY);");
    if (!rc) rc = sqlite3_exec(backup, sql->str, NULL, NULL, NULL);
    g_string_free(sql, TRUE); return rc;
}
static int prepare_insert(sqlite3 *target, const char *schema, sqlite3_stmt *source, sqlite3_stmt **insert)
{
    GString *sql = g_string_new("INSERT OR IGNORE INTO ");
    append_identifier(sql, schema); g_string_append(sql, ".RecordTab(");
    int count = 0;
    for (int i = 0; i < sqlite3_column_count(source); ++i) {
        const char *name = sqlite3_column_name(source, i);
        if (!g_ascii_strcasecmp(name, "RECORD_ID")) continue;
        if (count++) g_string_append_c(sql, ','); append_identifier(sql, name);
    }
    g_string_append(sql, ") VALUES(");
    for (int i = 0; i < count; ++i) g_string_append(sql, i ? ",?" : "?");
    g_string_append_c(sql, ')');
    int rc = count ? sqlite3_prepare_v2(target, sql->str, -1, insert, NULL) : SQLITE_SCHEMA;
    g_string_free(sql, TRUE); return rc;
}
static int insert_row(struct ie_job *job, sqlite3_stmt *source, sqlite3_stmt *insert)
{
    int parameter = 0, rc = SQLITE_OK;
    char *repaired = NULL;
    for (int i = 0; !rc && i < sqlite3_column_count(source); ++i) {
        const char *name = sqlite3_column_name(source, i);
        if (!g_ascii_strcasecmp(name, "RECORD_ID")) continue;
        if (job->type == 1 && !g_ascii_strcasecmp(name, "FILELIST") && sqlite3_column_type(source, i) == SQLITE_TEXT)
            repaired = ie_import_filelist((const char *)sqlite3_column_text(source, i));
        if (repaired && !g_ascii_strcasecmp(name, "FILELIST"))
            rc = sqlite3_bind_text(insert, ++parameter, repaired, -1, SQLITE_STATIC);
        else rc = sqlite3_bind_value(insert, ++parameter, sqlite3_column_value(source, i));
    }
    if (!rc) rc = sqlite3_step(insert) == SQLITE_DONE ? SQLITE_OK : sqlite3_errcode(sqlite3_db_handle(insert));
    int reset = sqlite3_reset(insert); sqlite3_clear_bindings(insert);
    if (repaired) { OPENSSL_cleanse(repaired, strlen(repaired)); g_free(repaired); }
    return rc ? rc : reset;
}
static int count_export(struct ie_job *job)
{
    for (unsigned i = 0; i < job->databases->len; ++i) {
        struct ie_database *entry = g_ptr_array_index(job->databases, i);
        sqlite3_stmt *count = NULL;
        int rc = select_rows(job, entry->db, 1, &count);
        if (!rc && sqlite3_step(count) == SQLITE_ROW) job->total += (uint64_t)sqlite3_column_int64(count, 0);
        else rc = SQLITE_ERROR;
        sqlite3_finalize(count);
        if (rc) return ie_fail(job, 15, "getMessageList failed");
    }
    return 0;
}
static int archive_date(const char *stamp, char output[16])
{
    char seconds[11] = {0};
    size_t length = MIN(strlen(stamp), (size_t)10);
    if (!length) return -1;
    for (size_t i = 0; i < length; ++i) if (!g_ascii_isdigit(stamp[i])) return -1;
    memcpy(seconds, stamp, length);
    time_t value = (time_t)g_ascii_strtoll(seconds, NULL, 10) + 28800;
    struct tm calendar;
    return gmtime_r(&value, &calendar) && strftime(output, 16, "%Y.%m.%d", &calendar) ? 0 : -1;
}
static char *backup_stem(struct ie_job *job, sqlite3 *backup)
{
    const char *minimum = job->minimum, *maximum = job->maximum;
    sqlite3_stmt *query = NULL;
    if (!strcmp(minimum, "0000000000000") && !strcmp(maximum, "9999999999999")) {
        if (sqlite3_prepare_v2(backup, "SELECT min(UTCSTAMP),max(UTCSTAMP) FROM RecordTab WHERE RECORDTYPE IN(0,1) AND PEERNAME!='[Group Notify]'", -1, &query, NULL) ||
            sqlite3_step(query) != SQLITE_ROW) { sqlite3_finalize(query); return NULL; }
        minimum = (const char *)sqlite3_column_text(query, 0);
        maximum = (const char *)sqlite3_column_text(query, 1);
        if (!minimum || !maximum) { sqlite3_finalize(query); return g_strdup("archive"); }
    }
    char first[16], last[16];
    int error = archive_date(minimum, first) || archive_date(maximum, last);
    sqlite3_finalize(query);
    return error ? NULL : g_strdup_printf("archive(%s-%s)", first, last);
}

int ie_export(struct ie_job *job)
{
    if (ie_stage(job, job->selected_fd) || count_export(job)) return -1;
    int output = -1, data = -1; sqlite3 *backup = NULL;
    int rc = SQLITE_OK;
    char *stem = NULL, *zip_name = NULL;
    if (job->format >= 2) {
        struct ie_database *live = g_ptr_array_index(job->databases, job->databases->len - 1);
        data = ie_open_subdir(job->stage_fd, "importMsgTempFile", 1);
        char key[66]; snprintf(key, sizeof key, "%s\n", live->key.password);
        int error = data < 0 ? errno : ie_write_file(job, data, "config_private.db", key, strlen(key));
        OPENSSL_cleanse(key, sizeof key);
        if (error || ie_open_database(job, data, "history.db", live->key.password, 1, 1, &backup)) rc = SQLITE_CANTOPEN;
        if (!rc) rc = create_backup_schema(live->db, backup);
        if (!rc) rc = sqlite3_exec(backup, "BEGIN IMMEDIATE", NULL, NULL, NULL);
        sqlite3_stmt *account = NULL;
        if (!rc) rc = sqlite3_prepare_v2(backup, "INSERT INTO UserConfigTab(KEY,VALUE) VALUES('loginaccount',?1)", -1, &account, NULL);
        if (!rc) rc = sqlite3_bind_text(account, 1, job->account, -1, SQLITE_STATIC);
        if (!rc) rc = sqlite3_step(account) == SQLITE_DONE ? SQLITE_OK : SQLITE_ERROR;
        sqlite3_finalize(account);
        if (job->format == 3) output = ie_open_subdir(job->stage_fd, "archive", 1);
    } else output = ie_open_subdir(job->stage_fd, "HistoryRecord", 1);
    if (!rc && (job->format != 2 && output < 0)) rc = SQLITE_CANTOPEN;
    if (rc) ie_fail(job, 16, "InitBak failed");
    if (!rc) ie_status(job, 1);
    for (unsigned i = 0; !rc && i < job->databases->len && !ie_cancelled(job); ++i) {
        struct ie_database *entry = g_ptr_array_index(job->databases, i);
        sqlite3_stmt *rows = NULL, *insert = NULL;
        rc = select_rows(job, entry->db, 0, &rows);
        if (!rc && backup) rc = prepare_insert(backup, "main", rows, &insert);
        int step = SQLITE_DONE;
        while (!rc && !ie_cancelled(job) && (step = sqlite3_step(rows)) == SQLITE_ROW) {
            if (backup) rc = insert_row(job, rows, insert);
            if (!rc && job->format == 0) rc = ie_render_row(job, rows, output);
            if (!rc && (job->format == 1 || job->format == 3)) rc = ie_picture_row(job, rows, output, job->format == 1);
            ++job->processed;
            ie_progress(job, job->total ? 5 + (int)(90 * job->processed / job->total) : 95);
        }
        if (!rc && !ie_cancelled(job) && step != SQLITE_DONE) rc = step;
        sqlite3_finalize(insert); sqlite3_finalize(rows);
    }
    if (backup) {
        if (!rc && !ie_cancelled(job)) {
            stem = backup_stem(job, backup);
            if (!stem) rc = SQLITE_ERROR;
            else zip_name = g_strconcat(stem, ".bak", NULL);
        }
        sqlite3_progress_handler(backup, 0, NULL, NULL);
        int end = sqlite3_exec(backup, rc || ie_cancelled(job) ? "ROLLBACK" : "COMMIT", NULL, NULL, NULL);
        if (!rc) rc = end;
        if (sqlite3_close(backup) && !rc) rc = SQLITE_ERROR;
    }
    if (rc && !job->error) ie_fail(job, 15, "getMessageList failed");
    if (data >= 0) close(data);
    if (!rc && !ie_cancelled(job)) {
        if (job->format >= 2) {
            ie_status(job, 2);
            int destination = job->format == 3 ? output : job->stage_fd;
            if (ie_pack(job, destination, zip_name)) rc = SQLITE_IOERR;
        }
        if (!rc) {
            if (output >= 0 && fsync(output)) rc = SQLITE_IOERR_FSYNC;
            if (!rc) rc = ie_publish(job, job->selected_fd,
                job->format == 2 ? zip_name : job->format == 3 ? "archive" : "HistoryRecord",
                job->format >= 2 ? stem : "HistoryRecord", job->format == 2 ? ".bak" : "");
        }
    }
    if (output >= 0) close(output);
    g_free(zip_name); g_free(stem);
    if (rc && !job->error && !ie_cancelled(job)) ie_fail(job, 1, "output publication failed");
    return rc;
}
static int selected_backup(struct ie_job *job)
{
    struct stat info;
    if (fstat(job->selected_fd, &info)) return -1;
    if (S_ISREG(info.st_mode)) return fcntl(job->selected_fd, F_DUPFD_CLOEXEC, 3);
    int duplicate = openat(job->selected_fd, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    DIR *directory = duplicate < 0 ? NULL : fdopendir(duplicate);
    if (!directory) { if (duplicate >= 0) close(duplicate); return -1; }
    int result = -1; unsigned found = 0; struct dirent *entry;
    while ((entry = readdir(directory))) {
        if (!g_str_has_prefix(entry->d_name, "archive") || !g_str_has_suffix(entry->d_name, ".bak")) continue;
        if (++found > 1) { if (result >= 0) close(result); result = -1; break; }
        result = openat(job->selected_fd, entry->d_name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK);
        if (result >= 0 && (fstat(result, &info) || !S_ISREG(info.st_mode))) { close(result); result = -1; }
    }
    closedir(directory); return result;
}
static int attach_target(struct ie_job *job, sqlite3 *target, struct ie_database *entry, unsigned index)
{
    char *sql = g_strdup_printf("ATTACH DATABASE ?1 AS db%u KEY ?2", index);
    char *path = ie_fd_path(entry->directory, entry->name);
    sqlite3_stmt *statement = NULL;
    int rc = sqlite3_prepare_v2(target, sql, -1, &statement, NULL); g_free(sql);
    if (!rc) rc = sqlite3_bind_text(statement, 1, path, -1, SQLITE_STATIC);
    if (!rc) rc = sqlite3_bind_text(statement, 2, entry->key.password, -1, SQLITE_STATIC);
    if (!rc) rc = sqlite3_step(statement) == SQLITE_DONE ? SQLITE_OK : sqlite3_errcode(target);
    sqlite3_finalize(statement); g_free(path);
    if (!rc && ie_cancelled(job)) rc = SQLITE_INTERRUPT;
    return rc;
}
int ie_import(struct ie_job *job)
{
    if (ie_stage(job, job->account_fd)) return -1;
    ie_status(job, 3);
    int input = selected_backup(job);
    if (input < 0) return ie_fail(job, 19, "open zip file error");
    int rc = ie_unpack(job, input); close(input);
    if (rc || ie_cancelled(job)) return -1;
    int data = ie_open_subdir(job->stage_fd, "importMsgTempFile", 0);
    char key[68] = {0};
    int error = data < 0 ? EIO : ie_read_small(data, "config_private.db", key, sizeof key);
    size_t key_length = strlen(key);
    while (key_length && (key[key_length - 1] == '\r' || key[key_length - 1] == '\n')) key[--key_length] = 0;
    if (key_length != 64) error = EINVAL;
    for (size_t i = 0; !error && i < key_length; ++i) if (!g_ascii_isxdigit(key[i])) error = EINVAL;
    sqlite3 *source = NULL, *target = NULL;
    if (error) ie_fail(job, 22, "db key can not open");
    else if (ie_open_database(job, data, "history.db", key, 0, 0, &source)) ie_fail(job, 23, "open bak db failed");
    OPENSSL_cleanse(key, sizeof key);
    if (job->error) { if (data >= 0) close(data); return -1; }
    char *account = user_config(source, "loginaccount");
    if (!account || strcmp(account, job->account)) ie_fail(job, 26, "bakAccount != account");
    if (account) { OPENSSL_cleanse(account, strlen(account)); g_free(account); }
    sqlite3_stmt *rows = NULL;
    if (!job->error) {
        rc = sqlite3_prepare_v2(source, "SELECT count(*) FROM RecordTab", -1, &rows, NULL);
        if (!rc && sqlite3_step(rows) == SQLITE_ROW) job->total = (uint64_t)sqlite3_column_int64(rows, 0);
        else rc = SQLITE_ERROR;
        sqlite3_finalize(rows); rows = NULL;
        if (rc) ie_fail(job, 28, "HistoryDBRecordTabQueryCount failed");
    }
    /* Never report success while leaving an imported record outside every
     * established shard interval. Original range routing has open ends for the
     * oldest archive and live database; a malformed/gapped index is an error. */
    if (!job->error) {
        GString *sql = g_string_new("SELECT count(*) FROM RecordTab WHERE ");
        for (unsigned i = 0; i < job->databases->len; ++i) {
            if (i) g_string_append(sql, " OR ");
            g_string_append_printf(sql, "(UTCSTAMP>=?%u AND UTCSTAMP<=?%u)", 2 * i + 1, 2 * i + 2);
        }
        rc = sqlite3_prepare_v2(source, sql->str, -1, &rows, NULL); g_string_free(sql, TRUE);
        for (unsigned i = 0; !rc && i < job->databases->len; ++i) {
            struct ie_database *entry = g_ptr_array_index(job->databases, i);
            rc = sqlite3_bind_text(rows, (int)(2 * i + 1), i ? entry->minimum : "0000000000000", -1, SQLITE_STATIC);
            if (!rc) rc = sqlite3_bind_text(rows, (int)(2 * i + 2),
                i + 1 == job->databases->len ? "9999999999999" : entry->maximum, -1, SQLITE_STATIC);
        }
        if (!rc && (sqlite3_step(rows) != SQLITE_ROW || (uint64_t)sqlite3_column_int64(rows, 0) != job->total)) rc = SQLITE_CORRUPT;
        sqlite3_finalize(rows); rows = NULL;
        if (rc) ie_fail(job, 25, "backup contains records outside database ranges");
    }
    if (!job->error) ie_status(job, 1);
    struct ie_database *live = g_ptr_array_index(job->databases, job->databases->len - 1);
    for (unsigned i = 0; i < job->databases->len; ++i) {
        struct ie_database *entry = g_ptr_array_index(job->databases, i);
        if (entry->db) { sqlite3_close(entry->db); entry->db = NULL; }
    }
    if (!job->error && ie_open_database(job, live->directory, live->name, live->key.password, 0, 1, &target))
        ie_fail(job, 25, "BakDbInsertToTargetDb failed");
    unsigned attached = 0;
    for (unsigned i = 0; !job->error && i + 1 < job->databases->len; ++i) {
        if (attach_target(job, target, g_ptr_array_index(job->databases, i), i)) ie_fail(job, 25, "BakDbInsertToTargetDb failed");
        else ++attached;
    }
    int transaction = 0;
    if (!job->error) {
        rc = sqlite3_exec(target, "BEGIN IMMEDIATE", NULL, NULL, NULL);
        if (rc) ie_fail(job, 25, "BakDbInsertToTargetDb failed"); else transaction = 1;
    }
    for (unsigned i = 0; !job->error && i < job->databases->len && !ie_cancelled(job); ++i) {
        struct ie_database *entry = g_ptr_array_index(job->databases, i);
        const char *minimum = i == 0 ? "0000000000000" : entry->minimum;
        const char *maximum = i + 1 == job->databases->len ? "9999999999999" : entry->maximum;
        char schema[24]; snprintf(schema, sizeof schema, i + 1 == job->databases->len ? "main" : "db%u", i);
        rc = sqlite3_prepare_v2(source, "SELECT * FROM RecordTab WHERE UTCSTAMP>=?1 AND UTCSTAMP<=?2 ORDER BY UTCSTAMP,RECORD_ID", -1, &rows, NULL);
        if (!rc) rc = sqlite3_bind_text(rows, 1, minimum, -1, SQLITE_STATIC);
        if (!rc) rc = sqlite3_bind_text(rows, 2, maximum, -1, SQLITE_STATIC);
        sqlite3_stmt *insert = NULL;
        if (!rc) rc = prepare_insert(target, schema, rows, &insert);
        int step = SQLITE_DONE;
        while (!rc && !ie_cancelled(job) && (step = sqlite3_step(rows)) == SQLITE_ROW) {
            rc = insert_row(job, rows, insert);
            ++job->processed;
            ie_progress(job, job->total ? MIN(95, (int)(95 * job->processed / job->total)) : 95);
        }
        if (!rc && !ie_cancelled(job) && step != SQLITE_DONE) rc = step;
        sqlite3_finalize(insert); sqlite3_finalize(rows); rows = NULL;
        if (rc) ie_fail(job, 25, "BakDbInsertToTargetDb failed");
    }
    /* Importing an exported directory carries images outside the ZIP. Media is
     * staged and no-clobber linked before commit; failure rolls back our links.
     * A selected standalone .bak deliberately contains database records only. */
    struct stat selected_info;
    if (!job->error && !ie_cancelled(job) && !fstat(job->selected_fd, &selected_info) && S_ISDIR(selected_info.st_mode))
        ie_import_pictures(job, job->selected_fd);
    int committed = 0;
    if (transaction) {
        if (!job->error && !ie_cancelled(job) && !ie_commit_point(job)) {
            rc = sqlite3_exec(target, "COMMIT", NULL, NULL, NULL);
            if (!rc) committed = 1;
            else ie_fail(job, 25, "database commit failed");
        }
        if (!committed) {
            sqlite3_progress_handler(target, 0, NULL, NULL);
            if (sqlite3_exec(target, "ROLLBACK", NULL, NULL, NULL)) ie_fail(job, 25, "database rollback failed");
            ie_rollback_pictures(job);
        }
    }
    sqlite3_finalize(rows);
    if (target) {
        for (unsigned i = 0; i < attached; ++i) {
            char sql[40]; snprintf(sql, sizeof sql, "DETACH DATABASE db%u", i); sqlite3_exec(target, sql, NULL, NULL, NULL);
        }
        sqlite3_close(target);
    }
    sqlite3_close(source);
    close(data);
    return committed ? 0 : -1;
}
/* Used by media export: the DLL resolves FolderAddr to its parent/ReceiveFiles;
 * absent configuration uses appdata/IM/<account>/ReceiveFiles. */
int ie_prepare_receive(struct ie_job *job)
{
    if (job->receive_fd >= 0) return 0;
    char *folder = user_config(job->user_db, "FolderAddr");
    if (folder && *folder) {
        for (char *p = folder; *p; ++p) if (*p == '\\') *p = '/';
        size_t length = strlen(folder); while (length > 1 && folder[length - 1] == '/') folder[--length] = 0;
        char *parent = g_path_get_dirname(folder);
        char *receive = g_build_filename(parent, "ReceiveFiles", NULL);
        job->receive_fd = ie_open_directory(receive);
        g_free(receive); g_free(parent);
    } else job->receive_fd = ie_open_subdir(job->account_fd, "ReceiveFiles", job->type == 1);
    g_free(folder);
    return job->receive_fd < 0 ? -1 : 0;
}
