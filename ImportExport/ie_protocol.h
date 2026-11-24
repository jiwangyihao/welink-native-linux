#ifndef WELINK_IMPORT_EXPORT_PROTOCOL_H
#define WELINK_IMPORT_EXPORT_PROTOCOL_H
#include <stdint.h>
#define IE_WORKER_NAME "welink-import-export-worker"
#define IE_WORKER_ARGUMENT "--welink-import-export-worker-v1"
#define IE_REQUEST_FD 3
#define IE_CONTROL_FD 4
#define IE_EVENT_FD 5
#define IE_REQUEST_LIMIT (1024U * 1024U)
#define IE_EVENT_LIMIT 384U
/* Private exec protocol, never a vendor wire command:
 * fd3: "WIE1", uint32 little-endian byte count, exactly that UTF-8 JSON request.
 * fd4: private Unix stream socket; byte 'C' or EOF requests cancellation.
 * fd5: uint32 little-endian byte count followed by original callback JSON.
 * The host withholds terminal status 4/5/6 until waitpid confirms clean exit.
 * No request, account, path or key is carried in argv, environment, or logs.
 */
static inline uint32_t ie_load_u32(const unsigned char p[4])
{ return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static inline void ie_store_u32(unsigned char p[4], uint32_t n)
{ p[0] = (unsigned char)n; p[1] = (unsigned char)(n >> 8); p[2] = (unsigned char)(n >> 16); p[3] = (unsigned char)(n >> 24); }
#endif
