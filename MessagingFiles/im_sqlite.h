#ifndef WELINK_IM_SQLITE_H
#define WELINK_IM_SQLITE_H
#include "native_rpc.h"
#include "im_transport_exports.h"
IM_SDK_EXPORT int InitSqliteService(const char *log_directory, const char *application_directory,
                                  const char *database_root, native_callback callback);
IM_SDK_EXPORT void SqliteServiceSendMsg(const char *request);
IM_SDK_EXPORT void SqliteServiceShutdown(void);
#endif
