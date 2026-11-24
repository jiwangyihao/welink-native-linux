#ifndef WELINK_IMPORT_EXPORT_INTERNAL_H
#define WELINK_IMPORT_EXPORT_INTERNAL_H
#define _GNU_SOURCE
#define _FILE_OFFSET_BITS 64
#define _TIME_BITS 64
#include "db_import_export_tools.h"
#include "../native_storage.h"
#include <glib.h>
#include <json-c/json.h>
#include <stdatomic.h>
#include <stdint.h>
#include <sys/types.h>
#include <sys/stat.h>

/* Bounds are native resource limits, not claims about vendor file limits. */
#define IE_MAX_DATABASES 10
#define IE_MAX_MEMBERS 100000
#define IE_MAX_REQUEST (1024 * 1024)
#define IE_CHUNK 65536
#define IE_MAX_VALUE (16 * 1024 * 1024)
#define IE_MAX_ARCHIVE_BYTES (UINT64_C(1) << 40)
#define IE_RUNNING 0
#define IE_CANCELLED 1
#define IE_COMMITTING 2

struct ie_database {
    char *name, *keyfile;
    char minimum[33], maximum[33];
    int directory;
    sqlite3 *db;
    struct native_storage_key key;
};
struct ie_job {
    atomic_int state;
    char *input;
    struct json_object *request;
    const char *account, *desktop, *selected, *conversation, *minimum, *maximum;
    char policy_minimum[33];
    int type, format, english, error, error_type, progress;
    const char *error_text;
    int desktop_fd, im_fd, account_fd, selected_fd, stage_fd, receive_fd, contact_fd;
    char *stage_name;
    GPtrArray *databases;
    sqlite3 *user_db;
    sqlite3 *contact_db;
    int contact_checked;
    uint64_t total, processed;
    /* Filenames created by this import only, for rollback; never user files. */
    GPtrArray *published_files;
};
int ie_cancelled(struct ie_job *job);
int ie_fail(struct ie_job *job, int code, const char *text);
void ie_status(struct ie_job *job, int status);
void ie_progress(struct ie_job *job, int progress);
int ie_commit_point(struct ie_job *job);
const char *ie_string(struct json_object *object, const char *name);
int ie_component(const char *name);
int ie_open_directory(const char *path);
int ie_open_subdir(int parent, const char *name, int create);
char *ie_fd_path(int directory, const char *name);
int ie_read_small(int directory, const char *name, char *out, size_t capacity);
int ie_write_file(struct ie_job *job, int directory, const char *name, const void *data, size_t length);
int ie_copy_file(struct ie_job *job, int source, const char *name, int target, const char *target_name, int missing_ok, struct stat *created);
int ie_stage(struct ie_job *job, int parent);
int ie_remove_tree(int directory);
int ie_publish(struct ie_job *job, int parent, const char *inside, const char *stem, const char *extension);
int ie_pack(struct ie_job *job, int directory, const char *name);
int ie_unpack(struct ie_job *job, int input);
int ie_open_database(struct ie_job *job, int directory, const char *name, const char *password, int create, int writable, sqlite3 **out);
int ie_load_profile(struct ie_job *job);
void ie_close_profile(struct ie_job *job);
int ie_export(struct ie_job *job);
int ie_import(struct ie_job *job);
int ie_render_row(struct ie_job *job, sqlite3_stmt *row, int output);
int ie_picture_row(struct ie_job *job, sqlite3_stmt *row, int output, int grouped);
int ie_column(sqlite3_stmt *row, const char *name);
const char *ie_column_text(sqlite3_stmt *row, const char *name);
int ie_prepare_receive(struct ie_job *job);
char *ie_import_filelist(const char *text);
int ie_import_pictures(struct ie_job *job, int source);
void ie_rollback_pictures(struct ie_job *job);
#endif
