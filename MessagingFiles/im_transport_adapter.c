#include "im_transport_adapter.h"
#include "im_transport_dispatch.h"
#include <glib.h>
#include <limits.h>
#include <string.h>

struct adapter_request {
    uint32_t id, epoch;
    int64_t cmd, sno;
    char *description;
};
static GMutex lock;
static GHashTable *pending;
static im_adapter_request_fn request_handler;
static im_adapter_cancel_fn cancel_handler;
static im_adapter_deliver_fn deliver;
static uint32_t epoch, next_id;
static unsigned in_callback;
static gboolean active;
static GThread *owner;
static struct im_dispatch_queue request_queue;
static guint64 request_queue_epoch;

static void release_request(gpointer pointer)
{
    struct adapter_request *request = pointer;
    g_free(request->description);
    g_free(request);
}

static struct json_object *parse_message(const char *text)
{
    if (!text) return NULL;
    size_t length = strlen(text);
    if (length >= INT_MAX) return NULL;
    struct json_tokener *parser = json_tokener_new();
    if (!parser) return NULL;
    json_tokener_set_flags(parser, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *root = json_tokener_parse_ex(parser, text, length + 1);
    enum json_tokener_error error = json_tokener_get_error(parser);
    json_tokener_free(parser);
    if (error != json_tokener_success || !json_object_is_type(root, json_type_object)) {
        json_object_put(root);
        return NULL;
    }
    return root;
}

int WelinkRegisterAdapterHandler(im_adapter_request_fn request, im_adapter_cancel_fn cancel)
{
    if (!!request != !!cancel) return EINVAL;
    if (owner && owner != g_thread_self()) return EPERM;
    g_mutex_lock(&lock);
    if (in_callback || (pending && g_hash_table_size(pending))) { g_mutex_unlock(&lock); return EBUSY; }
    if (active && epoch == UINT32_MAX) { g_mutex_unlock(&lock); return EOVERFLOW; }
    im_adapter_cancel_fn previous = active ? cancel_handler : NULL;
    uint32_t previous_epoch = epoch;
    if (active) ++epoch;
    request_handler = request;
    cancel_handler = cancel;
    g_mutex_unlock(&lock);
    if (previous) previous(0, previous_epoch);
    return 0;
}

int im_adapter_start(im_adapter_deliver_fn target)
{
    if (!target) return EINVAL;
    if (owner && owner != g_thread_self()) return EPERM;
    g_mutex_lock(&lock);
    if (active || in_callback) { g_mutex_unlock(&lock); return EBUSY; }
    if (epoch == UINT32_MAX) { g_mutex_unlock(&lock); return EOVERFLOW; }
    if (!pending) pending = g_hash_table_new_full(g_direct_hash, g_direct_equal, NULL, release_request);
    ++epoch;
    owner = g_thread_self();
    request_queue_epoch = im_dispatch_start(&request_queue);
    if (!request_queue_epoch) { g_mutex_unlock(&lock); return EOVERFLOW; }
    deliver = target;
    active = TRUE;
    g_mutex_unlock(&lock);
    return 0;
}

int im_adapter_submit(const struct native_request *message)
{
    g_mutex_lock(&lock);
    if (!active || !request_handler || !cancel_handler) { g_mutex_unlock(&lock); return ENODEV; }
    if (next_id == UINT32_MAX) { g_mutex_unlock(&lock); return EOVERFLOW; }
    struct adapter_request *request = g_new0(struct adapter_request, 1);
    request->id = ++next_id;
    request->epoch = epoch;
    request->cmd = message->cmd;
    request->sno = native_integer(message->root, "sno", -1);
    request->description = g_strdup(native_string(message->root, "description", ""));
    uint32_t id = request->id;
    guint64 queue_epoch = request_queue_epoch;
    g_hash_table_insert(pending, GUINT_TO_POINTER(id), request);
    struct json_object *payload = json_object_get(message->root);
    g_mutex_unlock(&lock);
    im_dispatch_json(&request_queue, queue_epoch, payload, (int)id);
    return 0;
}

static int dispatch_request(const char *text, int tag, gpointer unused)
{
    (void)unused;
    uint32_t id = (uint32_t)tag;
    g_mutex_lock(&lock);
    struct adapter_request *request = pending ? g_hash_table_lookup(pending, GUINT_TO_POINTER(id)) : NULL;
    if (!active || !request || request->epoch != epoch || !request_handler) { g_mutex_unlock(&lock); return 0; }
    im_adapter_request_fn handler = request_handler;
    uint32_t generation = epoch;
    ++in_callback;
    g_mutex_unlock(&lock);
    int result = handler(text, id, generation);
    g_mutex_lock(&lock);
    --in_callback;
    request = pending ? g_hash_table_lookup(pending, GUINT_TO_POINTER(id)) : NULL;
    im_adapter_deliver_fn target = deliver;
    gboolean rejected = result && active && epoch == generation && request;
    if (rejected) g_hash_table_steal(pending, GUINT_TO_POINTER(id));
    g_mutex_unlock(&lock);
    if (rejected) {
        struct json_object *reply = json_object_new_object();
        json_object_object_add(reply, "rsp", json_object_new_int64(request->cmd));
        json_object_object_add(reply, "sno", json_object_new_int64(request->sno));
        json_object_object_add(reply, "result", json_object_new_int(1));
        json_object_object_add(reply, "resultDes", json_object_new_string("adapter request rejected"));
        json_object_object_add(reply, "description", json_object_new_string(request->description));
        release_request(request);
        target(reply, 5);
    }
    return 1;
}

int im_adapter_dispatch(void)
{
    return im_dispatch_run(&request_queue, dispatch_request, NULL);
}

int WelinkCompleteAdapterRequest(uint32_t id, uint32_t generation, const char *text)
{
    g_mutex_lock(&lock);
    if (owner && owner != g_thread_self()) { g_mutex_unlock(&lock); return EPERM; }
    gboolean available = active && generation == epoch;
    g_mutex_unlock(&lock);
    if (!available) return ECANCELED;
    struct json_object *response = parse_message(text);
    if (!response) return EINVAL;
    if (!json_object_is_type(native_get(response, "rsp"), json_type_int) ||
        !json_object_is_type(native_get(response, "sno"), json_type_int) ||
        !json_object_is_type(native_get(response, "result"), json_type_int)) {
        json_object_put(response);
        return EINVAL;
    }
    g_mutex_lock(&lock);
    struct adapter_request *request = pending ? g_hash_table_lookup(pending, GUINT_TO_POINTER(id)) : NULL;
    if (!active || generation != epoch || !request || request->epoch != generation) {
        g_mutex_unlock(&lock);
        json_object_put(response);
        return ECANCELED;
    }
    if (native_integer(response, "sno", -1) != request->sno) {
        g_mutex_unlock(&lock);
        json_object_put(response);
        return EINVAL;
    }
    im_adapter_deliver_fn target = deliver;
    g_hash_table_remove(pending, GUINT_TO_POINTER(id));
    g_mutex_unlock(&lock);
    target(response, 5);
    return 0;
}

int WelinkNotifyAdapter(uint32_t generation, const char *text)
{
    if (owner && owner != g_thread_self()) return EPERM;
    struct json_object *message = parse_message(text);
    if (!message) return EINVAL;
    if (!json_object_is_type(native_get(message, "notify"), json_type_int)) {
        json_object_put(message);
        return EINVAL;
    }
    g_mutex_lock(&lock);
    im_adapter_deliver_fn target = active && generation == epoch ? deliver : NULL;
    g_mutex_unlock(&lock);
    if (!target) { json_object_put(message); return ECANCELED; }
    target(message, 5);
    return 0;
}

int WelinkCancelAdapterRequest(uint32_t id, uint32_t generation)
{
    if (owner && owner != g_thread_self()) return EPERM;
    g_mutex_lock(&lock);
    struct adapter_request *request = pending ? g_hash_table_lookup(pending, GUINT_TO_POINTER(id)) : NULL;
    if (!active || generation != epoch || !request || request->epoch != generation) {
        g_mutex_unlock(&lock);
        return ECANCELED;
    }
    im_adapter_cancel_fn cancel = cancel_handler;
    im_adapter_deliver_fn target = deliver;
    g_hash_table_steal(pending, GUINT_TO_POINTER(id));
    ++in_callback;
    g_mutex_unlock(&lock);
    cancel(id, generation);
    struct json_object *reply = json_object_new_object();
    json_object_object_add(reply, "rsp", json_object_new_int64(request->cmd));
    json_object_object_add(reply, "sno", json_object_new_int64(request->sno));
    json_object_object_add(reply, "result", json_object_new_int(1));
    json_object_object_add(reply, "resultDes", json_object_new_string("adapter request cancelled"));
    json_object_object_add(reply, "description", json_object_new_string(request->description));
    target(reply, 5);
    release_request(request);
    g_mutex_lock(&lock);
    --in_callback;
    g_mutex_unlock(&lock);
    return 0;
}

void im_adapter_stop(void)
{
    g_mutex_lock(&lock);
    if (!active) { g_mutex_unlock(&lock); return; }
    uint32_t stopped_epoch = epoch;
    im_adapter_cancel_fn cancel = cancel_handler;
    active = FALSE;
    deliver = NULL;
    request_handler = NULL;
    cancel_handler = NULL;
    if (pending) {
        g_hash_table_unref(pending);
        pending = NULL;
    }
    g_mutex_unlock(&lock);
    im_dispatch_stop(&request_queue);
    if (cancel) cancel(0, stopped_epoch);
}
