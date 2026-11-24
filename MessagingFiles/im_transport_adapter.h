/* Private native/JS adapter boundary, not an emulated SDK.
 * request(json,id,epoch) must return 0 only when accepted; it must later call
 * WelinkCompleteAdapterRequest with the REAL complete rsp/sno/result envelope.
 * cancel(0,epoch) cancels every activity of a stopped SDK session, including
 * long-running activities whose start request has already completed.
 * Handler buffers must stay alive until successful unregister or Shutdown.
 * Register/unregister while a callback/pending request exists returns EBUSY. */
#ifndef WELINK_IM_TRANSPORT_ADAPTER_H
#define WELINK_IM_TRANSPORT_ADAPTER_H
#include <stdint.h>
#include "native_rpc.h"
#include "im_transport_exports.h"
typedef int (*im_adapter_request_fn)(const char *, uint32_t, uint32_t);
typedef int (*im_adapter_cancel_fn)(uint32_t, uint32_t);
typedef void (*im_adapter_deliver_fn)(struct json_object *, int);
IM_SDK_EXPORT int WelinkRegisterAdapterHandler(im_adapter_request_fn request, im_adapter_cancel_fn cancel);
IM_SDK_EXPORT int WelinkCompleteAdapterRequest(uint32_t id, uint32_t epoch, const char *json);
IM_SDK_EXPORT int WelinkNotifyAdapter(uint32_t epoch, const char *json);
IM_SDK_EXPORT int WelinkCancelAdapterRequest(uint32_t id, uint32_t epoch);
int im_adapter_start(im_adapter_deliver_fn deliver);
int im_adapter_dispatch(void);
void im_adapter_stop(void);
int im_adapter_submit(const struct native_request *request);
#endif
