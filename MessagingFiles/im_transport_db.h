/* Private contract for the native IM database service. */
#ifndef WELINK_IM_TRANSPORT_DB_H
#define WELINK_IM_TRANSPORT_DB_H
#include "native_rpc.h"
#include "native_storage.h"
#include <glib.h>

struct im_db_context;
/* The service serializes commands. Borrowed handles belong to the context.
 * Logical names are the original ECS database names: sysdb, userdb,
 * historydb, conversationdb, specialMsgdb and tempHistorydb. The core resolves the
 * original filenames/encryption; callers must not open another storage format. */
sqlite3 *im_db_database(struct im_db_context *context, const char *logical_name);
const char *im_db_directory(const struct im_db_context *context);
const char *im_db_account(const struct im_db_context *context);
/* Open a particular original-format database beneath the active IM directory,
 * e.g. an archive selected by the original DatabaseInfo.dat. The returned
 * handle is independently closable; no guessed paths or shared ownership. */
int im_db_open_file(struct im_db_context *context, const char *filename, int create, sqlite3 **database);
int im_db_open_archive(struct im_db_context *context, const char *filename,
                       const char *key_filename, int create, sqlite3 **database);
int im_db_archive_switch(struct im_db_context *context, int enabled);
int im_db_archive_enabled(const struct im_db_context *context);
/* Takes ownership of param, creates the observed rsp/sno/result/description
 * response, retaining the original cmd:null and ret:null fields. */
struct json_object *im_db_reply(const struct native_request *request, int result,
                              struct json_object *param, const char *description);
/* Each dispatcher returns 1 only for owned commands, with an owned full reply;
 * 0 means another dispatcher owns the command, not a successful operation.
 * Low command number is request->cmd & 0x2ffff, as in the original dispatcher. */
int im_db_entities(struct im_db_context *context, const struct native_request *request,
                   struct json_object **reply);
int im_db_history(struct im_db_context *context, const struct native_request *request,
                  struct json_object **reply);
/* Install/migrate only the original tables belonging to each handler slice. */
int im_db_entities_schema(struct im_db_context *context);
/* Public tracking storage must not make private-account initialization depend
 * on an already opened sysdb or its independently managed public key. */
int im_db_history_public_schema(struct im_db_context *context);
int im_db_history_schema(struct im_db_context *context);
int im_db_history_archive_configure(struct im_db_context *context, unsigned *interval_ms);
int im_db_history_archive(struct im_db_context *context);
void im_db_history_reset(struct im_db_context *context);
#endif
