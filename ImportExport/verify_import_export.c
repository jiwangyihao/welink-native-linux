/* Parent-run only. No vendor DLL/runtime, mocks or recorded SDK responses.
 * Compile this verifier with native_storage.c, kmc_compat.c and the validated
 * sqlite3mc object; link json-c, glib-2.0, libarchive, crypto, pthread, dl, m.
 * Run: verify_import_export /absolute/path/db_import_export_tools.so
 * The real welink-import-export-worker executable must be beside that DSO.
 * Every profile, archive and image is synthetic under one private mkdtemp root.
 */
#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#define _TIME_BITS 64
#include "db_import_export_tools.h"
#include "../native_storage.h"
#include <archive.h>
#include <archive_entry.h>
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <glib.h>
#include <json-c/json.h>
#include <openssl/crypto.h>
#include <pthread.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include "analysis/record_schema.inc"

#define CHECK(condition) do { if (!(condition)) { fprintf(stderr, "import/export verification failed at line %d\n", __LINE__); exit(1); } } while (0)
static int (*register_callback)(import_export_callback), (*submit)(const char *), (*cancel)(void), (*pump)(void);
static pthread_t owner;
static int terminal, error_code, last_progress, callbacks, other_callbacks, cancel_on_running;
static unsigned phases;
static int callback_impl(const char *text)
{
    CHECK(pthread_equal(owner, pthread_self()));
    CHECK(pump() == 0); /* Reentrant pumping must not invoke a second callback. */
    struct json_object *event = json_tokener_parse(text), *kind = NULL, *param = NULL, *value = NULL;
    CHECK(event && json_object_object_get_ex(event, "resType", &kind) && json_object_object_get_ex(event, "param", &param));
    CHECK(json_object_object_get_ex(param, "imExType", &value));
    int type = json_object_get_int(kind);
    CHECK(type >= 0 && type <= 2);
    if (type == 0) {
        CHECK(json_object_object_get_ex(param, "status", &value));
        int status = json_object_get_int(value); CHECK(status >= 0 && status <= 8);
        phases |= 1U << status;
        CHECK(json_object_object_get_ex(param, "errorCode", &value));
        if (status == 4 || status == 5 || status == 6) terminal = status;
        if (status == 1 && cancel_on_running) { cancel_on_running = 0; CHECK(cancel() == 0); }
    } else if (type == 1) {
        CHECK(json_object_object_get_ex(param, "errorCode", &value)); error_code = json_object_get_int(value);
        CHECK(error_code > 0 && json_object_object_get_ex(param, "errorMsg", &value));
        CHECK(!strstr(json_object_get_string(value), "/tmp/") && !strstr(json_object_get_string(value), "synthetic-account"));
    } else {
        CHECK(json_object_object_get_ex(param, "progress", &value));
        int progress = json_object_get_int(value); CHECK(progress >= last_progress && progress <= 100);
        last_progress = progress;
    }
    json_object_put(event); ++callbacks; return 0;
}
static int callback_a(const char *text) { return callback_impl(text); }
static int callback_b(const char *text) { ++other_callbacks; return callback_impl(text); }
static void reset_events(void) { terminal = error_code = last_progress = 0; phases = 0; }
static void finish(int expected)
{
    int64_t deadline = g_get_monotonic_time() + 60000000;
    while (!terminal && g_get_monotonic_time() < deadline) { CHECK(pump() >= 0); if (!terminal) g_usleep(1000); }
    CHECK(terminal == expected);
    while (pump() > 0) {}
}
static void *wrong_thread(void *unused)
{
    (void)unused;
    CHECK(pump() == -EPERM && cancel() == -EPERM && submit("{}") == -EPERM);
    CHECK(register_callback(callback_a) == -EPERM); return NULL;
}
struct profile { char *desktop, *root, *directory, *database, *metadata; struct native_storage_key key; };
static struct profile profile_new(const char *base, const char *name, const char *account)
{
    struct profile p = {0};
    p.desktop = g_build_filename(base, name, NULL);
    p.root = g_build_filename(p.desktop, "appdata", "IM", NULL);
    p.directory = g_build_filename(p.root, account, NULL);
    p.database = g_build_filename(p.directory, "history.db", NULL);
    p.metadata = g_build_filename(p.directory, "config_private.db", NULL);
    CHECK(!native_storage_mkdirs(p.directory));
    CHECK(!native_storage_load_key(p.metadata, p.root, account, 1, &p.key));
    sqlite3 *db = NULL; CHECK(!native_storage_open(p.database, p.key.password, 1, &db));
    CHECK(!sqlite3_exec(db, record_schema, NULL, NULL, NULL)); CHECK(!sqlite3_close(db));
    return p;
}
static void profile_free(struct profile *p)
{
    native_storage_clear_key(&p->key); g_free(p->desktop); g_free(p->root); g_free(p->directory); g_free(p->database); g_free(p->metadata);
}
static void seed(struct profile *p, unsigned records)
{
    sqlite3 *db = NULL; sqlite3_stmt *row = NULL;
    CHECK(!native_storage_open(p->database, p->key.password, 0, &db));
    CHECK(!sqlite3_exec(db, "BEGIN", NULL, NULL, NULL));
    CHECK(!sqlite3_prepare_v2(db, "INSERT INTO RecordTab(CONVERSATION_ID,SERVERMESSAGEID,CLIENTMESSAGEID,RECORDTYPE,CONTENT,FILELIST,GROUPID,GROUPNAME,PEERNAME,PEERNATIVENAME,ORIGINACCOUNT,TARGETACCOUNT,SHOWTEXT,MEDIATYPE,ISREAD,ISDELETE,ISWITHDRAW,TIMESTAMP,UTCSTAMP,EXTRA) VALUES(?1,?2,?2,1,?3,?4,'','','Synthetic sender','Synthetic sender','sender','target',?5,?6,1,0,?7,?8,?8,?9)", -1, &row, NULL));
    const unsigned char blob[] = {0,1,2,255,0,3};
    for (unsigned i = 0; i < records; ++i) {
        char id[40], stamp[32]; snprintf(id, sizeof id, "synthetic-%u", i);
        snprintf(stamp, sizeof stamp, "%013" G_GUINT64_FORMAT, UINT64_C(1700000000000) + i * 1000);
        CHECK(!sqlite3_bind_text(row, 1, i == 2 ? "bob" : "alice", -1, SQLITE_STATIC));
        CHECK(!sqlite3_bind_text(row, 2, id, -1, SQLITE_TRANSIENT));
        CHECK(!sqlite3_bind_text(row, 3, "<r><g>0</g><c><![CDATA[<imbody><content>Synthetic text</content></imbody>]]></c></r>", -1, SQLITE_STATIC));
        CHECK(!sqlite3_bind_text(row, 4, i == 1 ? "[{\"file_name\":\"fixture.png\",\"expire\":\"expired\"}]" : "", -1, SQLITE_STATIC));
        CHECK(!sqlite3_bind_text(row, 5, i == 1 ? "fixture.png" : i == 3 ? "withdrawn synthetic record" : "Synthetic text", -1, SQLITE_STATIC));
        CHECK(!sqlite3_bind_int(row, 6, i == 1 ? 3 : 0)); CHECK(!sqlite3_bind_int(row, 7, i == 3));
        CHECK(!sqlite3_bind_text(row, 8, stamp, -1, SQLITE_TRANSIENT)); CHECK(!sqlite3_bind_blob(row, 9, blob, sizeof blob, SQLITE_STATIC));
        CHECK(sqlite3_step(row) == SQLITE_DONE); CHECK(!sqlite3_reset(row)); sqlite3_clear_bindings(row);
    }
    sqlite3_finalize(row); CHECK(!sqlite3_exec(db, "COMMIT", NULL, NULL, NULL)); CHECK(!sqlite3_close(db));
}
static unsigned records(struct profile *p)
{
    sqlite3 *db = NULL; sqlite3_stmt *query = NULL;
    CHECK(!native_storage_open(p->database, p->key.password, 0, &db));
    CHECK(!sqlite3_prepare_v2(db, "SELECT count(*) FROM RecordTab", -1, &query, NULL)); CHECK(sqlite3_step(query) == SQLITE_ROW);
    unsigned result = (unsigned)sqlite3_column_int(query, 0); sqlite3_finalize(query); CHECK(!sqlite3_close(db)); return result;
}
static char *digest(const char *path)
{
    gchar *data = NULL; gsize length = 0; CHECK(g_file_get_contents(path, &data, &length, NULL));
    char *result = g_compute_checksum_for_data(G_CHECKSUM_SHA256, (const guchar *)data, length);
    OPENSSL_cleanse(data, length); g_free(data); return result;
}
static char *new_directory(const char *base, const char *name)
{
    char *path = g_build_filename(base, name, NULL); CHECK(!mkdir(path, 0700)); return path;
}
static void write_data(const char *path, const void *data, size_t size)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600); CHECK(fd >= 0);
    size_t done = 0;
    while (done < size) { ssize_t n = write(fd, (const char *)data + done, size - done); CHECK(n > 0); done += (size_t)n; }
    CHECK(!close(fd));
}
static char *request(struct profile *p, const char *account, int operation, int format, const char *path,
                     const char *conversation, const char *minimum, const char *maximum)
{
    struct json_object *object = json_object_new_object();
    json_object_object_add(object, "account", json_object_new_string(account));
    json_object_object_add(object, "welinkDesktopPath", json_object_new_string(p->desktop));
    json_object_object_add(object, "operationType", json_object_new_int(operation));
    json_object_object_add(object, "exportType", json_object_new_int(format));
    json_object_object_add(object, "isEnglish", json_object_new_int(1));
    json_object_object_add(object, operation == 1 ? "importPath" : "exportPath", json_object_new_string(path));
    json_object_object_add(object, "conversationId", json_object_new_string(conversation));
    json_object_object_add(object, "minTimestamp", json_object_new_string(minimum));
    json_object_object_add(object, "maxTimestamp", json_object_new_string(maximum));
    char *result = g_strdup(json_object_to_json_string_ext(object, JSON_C_TO_STRING_PLAIN)); json_object_put(object); return result;
}
static void operation(struct profile *p, const char *account, int type, int format, const char *path, int expected)
{
    char *json = request(p, account, type, format, path, "", "", ""); reset_events(); CHECK(!submit(json)); g_free(json); finish(expected);
}
static char *find_archive(const char *directory)
{
    GDir *dir = g_dir_open(directory, 0, NULL); CHECK(dir); const char *name; char *result = NULL;
    while ((name = g_dir_read_name(dir))) if (g_str_has_prefix(name, "archive") && g_str_has_suffix(name, ".bak")) {
        CHECK(!result); result = g_build_filename(directory, name, NULL);
    }
    g_dir_close(dir); CHECK(result); return result;
}
static char *find_archive_directory(const char *directory)
{
    GDir *dir = g_dir_open(directory, 0, NULL); CHECK(dir);
    const char *name; char *result = NULL;
    while ((name = g_dir_read_name(dir))) if (g_str_has_prefix(name, "archive")) {
        char *path = g_build_filename(directory, name, NULL);
        if (g_file_test(path, G_FILE_TEST_IS_DIR)) { CHECK(!result); result = path; }
        else g_free(path);
    }
    g_dir_close(dir); CHECK(result); return result;
}

static void permissions(const char *path, mode_t mode)
{
    struct stat info; CHECK(!lstat(path, &info) && (info.st_mode & 0777) == mode);
}
static void no_stage(const char *directory)
{
    GDir *dir = g_dir_open(directory, 0, NULL); CHECK(dir); const char *name;
    while ((name = g_dir_read_name(dir))) CHECK(!g_str_has_prefix(name, ".welink-transfer-"));
    g_dir_close(dir);
}
static void assert_same(const char *path, const char *before)
{
    char *after = digest(path); CHECK(!strcmp(before, after)); g_free(after);
}
static void unpack_check(const char *archive_path, const char *directory, struct profile *source)
{
    struct archive *zip = archive_read_new(); CHECK(zip); CHECK(archive_read_support_format_zip(zip) == ARCHIVE_OK);
    CHECK(archive_read_open_filename(zip, archive_path, 65536) == ARCHIVE_OK);
    struct archive_entry *entry; unsigned seen = 0; int status;
    while ((status = archive_read_next_header(zip, &entry)) == ARCHIVE_OK) {
        const char *member = archive_entry_pathname(entry), *name;
        if (!strcmp(member, "importMsgTempFile/history.db")) { seen |= 1; name = "history.db"; }
        else { CHECK(!strcmp(member, "importMsgTempFile/config_private.db")); seen |= 2; name = "config_private.db"; }
        CHECK(archive_entry_filetype(entry) == AE_IFREG && !archive_entry_is_encrypted(entry));
        char *path = g_build_filename(directory, name, NULL); int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600); CHECK(fd >= 0);
        char buffer[65536]; la_ssize_t n;
        while ((n = archive_read_data(zip, buffer, sizeof buffer)) > 0) CHECK(write(fd, buffer, (size_t)n) == n);
        CHECK(n == 0 && !close(fd)); OPENSSL_cleanse(buffer, sizeof buffer); g_free(path);
    }
    CHECK(status == ARCHIVE_EOF && seen == 3); CHECK(archive_read_close(zip) == ARCHIVE_OK); archive_read_free(zip);
    char *key_path = g_build_filename(directory, "config_private.db", NULL), *db_path = g_build_filename(directory, "history.db", NULL);
    gchar *key = NULL; gsize length = 0; CHECK(g_file_get_contents(key_path, &key, &length, NULL));
    CHECK(length == 65 && key[64] == '\n'); key[64] = 0; CHECK(!strcmp(key, source->key.password));
    char header[16]; int fd = open(db_path, O_RDONLY); CHECK(fd >= 0 && read(fd, header, sizeof header) == sizeof header); close(fd);
    CHECK(memcmp(header, "SQLite format 3", 15));
    sqlite3 *db = NULL; sqlite3_stmt *row = NULL;
    CHECK(!native_storage_open(db_path, key, 0, &db));
    CHECK(!sqlite3_prepare_v2(db, "SELECT EXTRA FROM RecordTab WHERE SERVERMESSAGEID='synthetic-0'", -1, &row, NULL)); CHECK(sqlite3_step(row) == SQLITE_ROW);
    const unsigned char blob[] = {0,1,2,255,0,3}; CHECK(sqlite3_column_bytes(row, 0) == sizeof blob && !memcmp(sqlite3_column_blob(row, 0), blob, sizeof blob));
    sqlite3_finalize(row); CHECK(!sqlite3_close(db));
    CHECK(native_storage_open(db_path, "wrong-key", 0, &db) != SQLITE_OK && !db);
    OPENSSL_cleanse(key, length); g_free(key); g_free(key_path); g_free(db_path);
}
static void hostile_archive(const char *path)
{
    struct archive *zip = archive_write_new(); CHECK(zip && archive_write_set_format_zip(zip) == ARCHIVE_OK);
    CHECK(archive_write_open_filename(zip, path) == ARCHIVE_OK);
    struct archive_entry *entry = archive_entry_new(); archive_entry_set_pathname(entry, "../outside-file");
    archive_entry_set_filetype(entry, AE_IFREG); archive_entry_set_perm(entry, 0600); archive_entry_set_size(entry, 3);
    CHECK(archive_write_header(zip, entry) == ARCHIVE_OK && archive_write_data(zip, "bad", 3) == 3);
    archive_entry_free(entry); CHECK(archive_write_close(zip) == ARCHIVE_OK); archive_write_free(zip);
}
static void remove_owned(const char *path)
{
    struct stat info; CHECK(!lstat(path, &info));
    if (S_ISDIR(info.st_mode)) {
        GDir *directory = g_dir_open(path, 0, NULL); CHECK(directory); const char *name;
        while ((name = g_dir_read_name(directory))) { char *child = g_build_filename(path, name, NULL); remove_owned(child); g_free(child); }
        g_dir_close(directory); CHECK(!rmdir(path));
    } else CHECK(!unlink(path));
}
int main(int argc, char **argv)
{
    CHECK(argc == 2); owner = pthread_self();
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL); CHECK(library);
    *(void **)(&register_callback) = dlsym(library, "CallBack"); *(void **)(&submit) = dlsym(library, "Startup");
    *(void **)(&cancel) = dlsym(library, "Shutdown"); *(void **)(&pump) = dlsym(library, "ImportExportDispatchCallbacks");
    CHECK(register_callback && submit && cancel && pump);
    CHECK(!dlsym(library, "BlueEncrypt") && !dlsym(library, "GetBlueDbKey"));
    CHECK(submit("{}") == -1 && !cancel() && !pump()); CHECK(!register_callback(callback_a));
    CHECK(!register_callback(callback_a) && submit(NULL) == -1);
    pthread_t wrong; CHECK(!pthread_create(&wrong, NULL, wrong_thread, NULL)); CHECK(!pthread_join(wrong, NULL));
    reset_events(); CHECK(!submit("{")); finish(5); CHECK(error_code == 10);
    char temporary[] = "/tmp/welink-import-export-verify-XXXXXX"; CHECK(mkdtemp(temporary)); CHECK(!chmod(temporary, 0700));
    const char *account = "synthetic-account";
    struct profile source = profile_new(temporary, "source", account), target = profile_new(temporary, "target", account);
    struct profile directory_target = profile_new(temporary, "directory-target", account), filtered_target = profile_new(temporary, "filtered-target", account);
    struct profile wrong_account = profile_new(temporary, "wrong-account", "different-account");
    seed(&source, 4); seed(&target, 1);
    sqlite3 *existing = NULL; CHECK(!native_storage_open(target.database, target.key.password, 0, &existing));
    CHECK(!sqlite3_exec(existing, "UPDATE RecordTab SET SHOWTEXT='existing authoritative record'", NULL, NULL, NULL)); CHECK(!sqlite3_close(existing));
    char *pictures = g_build_filename(source.directory, "ReceiveFiles", "originalImgfiles", NULL); CHECK(!native_storage_mkdirs(pictures));
    char *picture = g_build_filename(pictures, "fixture.png", NULL);
    gsize image_size = 0;
    guchar *image = g_base64_decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cISkAAAAASUVORK5CYII=", &image_size);
    CHECK(image && image_size); write_data(picture, image, image_size); g_free(image);
    char *source_digest = digest(source.database), *source_metadata = digest(source.metadata), *target_metadata = digest(target.metadata);
    char *exports = new_directory(temporary, "bak-output"), *inspect = new_directory(temporary, "inspection");
    operation(&source, account, 2, 2, exports, 4); CHECK((phases & (1U << 1)) && (phases & (1U << 2)) && last_progress == 100);
    char *bak = find_archive(exports); permissions(bak, 0600); unpack_check(bak, inspect, &source); no_stage(exports);
    assert_same(source.database, source_digest); assert_same(source.metadata, source_metadata);
    operation(&target, account, 1, 0, bak, 4); CHECK(records(&target) == 4 && (phases & (1U << 3)));
    assert_same(target.metadata, target_metadata); no_stage(target.directory);
    CHECK(!native_storage_open(target.database, target.key.password, 0, &existing)); sqlite3_stmt *query = NULL;
    CHECK(!sqlite3_prepare_v2(existing, "SELECT SHOWTEXT FROM RecordTab WHERE SERVERMESSAGEID='synthetic-0'", -1, &query, NULL));
    CHECK(sqlite3_step(query) == SQLITE_ROW && !strcmp((const char *)sqlite3_column_text(query, 0), "existing authoritative record"));
    sqlite3_finalize(query); CHECK(!sqlite3_close(existing));
    operation(&target, account, 1, 0, bak, 4); CHECK(records(&target) == 4);
    char *bak_digest = digest(bak); operation(&source, account, 2, 2, exports, 4); assert_same(bak, bak_digest);
    char *filtered = new_directory(temporary, "filtered-output");
    char *json = request(&source, account, 2, 2, filtered, "alice", "1700000001000", "1700000001000");
    reset_events(); CHECK(!submit(json)); g_free(json); finish(4); char *filtered_bak = find_archive(filtered);
    operation(&filtered_target, account, 1, 0, filtered_bak, 4); CHECK(records(&filtered_target) == 1);
    /* A transaction held by this verifier's separate SQLite copy must block
     * the exec worker. Same-process private SQLite registries are not enough. */
    CHECK(!native_storage_open(filtered_target.database, filtered_target.key.password, 0, &existing));
    CHECK(!sqlite3_exec(existing, "BEGIN IMMEDIATE", NULL, NULL, NULL));
    operation(&filtered_target, account, 1, 0, bak, 5); CHECK(error_code == 25);
    CHECK(!sqlite3_exec(existing, "ROLLBACK", NULL, NULL, NULL)); CHECK(!sqlite3_close(existing));
    CHECK(records(&filtered_target) == 1); no_stage(filtered_target.directory);
    char *combined = new_directory(temporary, "combined-output"); operation(&source, account, 2, 3, combined, 4);
    char *archive_dir = find_archive_directory(combined); permissions(archive_dir, 0700);
    char *combined_image = g_build_filename(archive_dir, "originalImgfiles", "fixture.png", NULL); permissions(combined_image, 0600);
    char *image_digest = digest(picture); assert_same(combined_image, image_digest);
    operation(&directory_target, account, 1, 0, archive_dir, 4); CHECK(records(&directory_target) == 4);
    char *restored_image = g_build_filename(directory_target.directory, "ReceiveFiles", "originalImgfiles", "fixture.png", NULL); assert_same(restored_image, image_digest);
    char *text_output = new_directory(temporary, "text-output"); operation(&source, account, 2, 0, text_output, 4);
    char *text_file = g_build_filename(text_output, "HistoryRecord", "Contacts", "alice.txt", NULL);
    gchar *text = NULL; gsize text_size = 0; CHECK(g_file_get_contents(text_file, &text, &text_size, NULL));
    CHECK(strstr(text, "Synthetic text\r\n") && strstr(text, "[Image]\r\n") && !strstr(text, "withdrawn synthetic record"));
    g_free(text); permissions(text_file, 0600);
    char *image_output = new_directory(temporary, "image-output"); operation(&source, account, 2, 1, image_output, 4);
    char *exported_image = g_build_filename(image_output, "HistoryRecord", "Contacts", "alice", "fixture.png", NULL); assert_same(exported_image, image_digest);
    char *wrong_before = digest(wrong_account.database); operation(&wrong_account, "different-account", 1, 0, bak, 5);
    CHECK(error_code == 26); assert_same(wrong_account.database, wrong_before); CHECK(records(&wrong_account) == 0);
    char *hostile = g_build_filename(temporary, "hostile.bak", NULL); hostile_archive(hostile);
    char *target_before = digest(target.database); operation(&target, account, 1, 0, hostile, 5); CHECK(error_code == 20);
    assert_same(target.database, target_before); no_stage(target.directory);
    assert_same(target.metadata, target_metadata);
    char *escaped = g_build_filename(target.directory, "outside-file", NULL);
    CHECK(access(escaped, F_OK) < 0 && errno == ENOENT); g_free(escaped);
    struct profile conflict = profile_new(temporary, "conflict", account);
    char *conflict_directory = g_build_filename(conflict.directory, "ReceiveFiles", "originalImgfiles", NULL); CHECK(!native_storage_mkdirs(conflict_directory));
    char *conflict_image = g_build_filename(conflict_directory, "fixture.png", NULL); write_data(conflict_image, "existing", 8);
    char *conflict_before = digest(conflict_image); operation(&conflict, account, 1, 0, archive_dir, 5);
    CHECK(records(&conflict) == 0); assert_same(conflict_image, conflict_before); no_stage(conflict.directory);
    struct profile large = profile_new(temporary, "large", account), cancelled_target = profile_new(temporary, "cancelled-target", account);
    seed(&large, 100000); char *large_output = new_directory(temporary, "large-output");
    json = request(&large, account, 2, 2, large_output, "", "", ""); reset_events(); CHECK(!submit(json)); CHECK(!cancel()); finish(6); no_stage(large_output);
    /* Reuse the same registered callback after cancellation. */
    reset_events(); CHECK(!submit(json)); finish(4); char *large_bak = find_archive(large_output);
    cancel_on_running = 1; operation(&cancelled_target, account, 1, 0, large_bak, 6); CHECK(records(&cancelled_target) == 0); no_stage(cancelled_target.directory);
    reset_events(); CHECK(!submit(json)); CHECK(!register_callback(NULL)); CHECK(!register_callback(callback_b));
    int baseline = callbacks; int admitted = -EBUSY; int64_t deadline = g_get_monotonic_time() + 60000000;
    while (admitted == -EBUSY && g_get_monotonic_time() < deadline) {
        CHECK(pump() == 0 && callbacks == baseline); admitted = submit("{}"); if (admitted == -EBUSY) g_usleep(1000);
    }
    CHECK(!admitted); finish(5); CHECK(error_code == 8 && other_callbacks > 0); no_stage(large_output); g_free(json);
    CHECK(!cancel()); CHECK(!register_callback(NULL)); CHECK(!pump());
    /* dlclose must not unload executing code; the DSO deliberately self-pins. */
    CHECK(!dlclose(library)); CHECK(!pump());
    profile_free(&source); profile_free(&target); profile_free(&directory_target); profile_free(&filtered_target);
    profile_free(&wrong_account); profile_free(&conflict); profile_free(&large); profile_free(&cancelled_target);
    char *allocations[] = {pictures,picture,source_digest,source_metadata,target_metadata,exports,inspect,bak,bak_digest,filtered,filtered_bak,combined,archive_dir,combined_image,image_digest,restored_image,text_output,text_file,image_output,exported_image,wrong_before,hostile,target_before,conflict_directory,conflict_image,conflict_before,large_output,large_bak};
    for (unsigned i = 0; i < G_N_ELEMENTS(allocations); ++i) g_free(allocations[i]);
    remove_owned(temporary);
    puts("PASS genuine native import/export: encrypted round trips, all four formats, preservation, cancellation and callback epochs");
    return 0;
}
