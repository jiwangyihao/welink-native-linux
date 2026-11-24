#ifndef WELINK_COMMON_DB_H
#define WELINK_COMMON_DB_H
#include "native_rpc.h"

/* Original common-utils commands 100..105. Returns the vendor result code;
 * *param is owned by the caller and is present only for query responses. */
int common_db_execute(const struct native_request *request, struct json_object **param);
void common_db_shutdown(void);
#endif
