/* Owner-thread FFI dispatch. Each SDK keeps one process-lifetime queue; worker
 * messages carry the startup epoch, and stop invalidates/drops that epoch.
 * No lock is held across a consumer callback. Reentrant dispatch is deferred. */
#ifndef WELINK_IM_TRANSPORT_DISPATCH_H
#define WELINK_IM_TRANSPORT_DISPATCH_H
#include <glib.h>
#include <json-c/json.h>
#include <errno.h>
#include <stdint.h>
#include <string.h>
#include "im_transport_exports.h"

struct im_dispatch_event {
    struct im_dispatch_event *next;
    struct json_object *object;
    int tag;
    char text[];
};
struct im_dispatch_queue {
    GMutex mutex;
    struct im_dispatch_event *head, *tail;
    GThread *owner;
    guint64 epoch;
    gboolean active, dispatching;
};
typedef int (*im_dispatch_consumer)(const char *text, int tag, gpointer context);

static inline void im_dispatch_free(struct im_dispatch_event *event)
{
    while (event) {
        struct im_dispatch_event *next = event->next;
        json_object_put(event->object);
        g_free(event);
        event = next;
    }
}

static inline guint64 im_dispatch_start(struct im_dispatch_queue *queue)
{
    g_mutex_lock(&queue->mutex);
    struct im_dispatch_event *old = queue->head;
    queue->head = queue->tail = NULL;
    queue->owner = g_thread_self();
    queue->active = queue->epoch != G_MAXUINT64;
    if (queue->active) ++queue->epoch;
    guint64 epoch = queue->active ? queue->epoch : 0;
    g_mutex_unlock(&queue->mutex);
    im_dispatch_free(old);
    return epoch;
}

static inline void im_dispatch_stop(struct im_dispatch_queue *queue)
{
    g_mutex_lock(&queue->mutex);
    queue->active = FALSE;
    if (queue->epoch != G_MAXUINT64) ++queue->epoch;
    struct im_dispatch_event *old = queue->head;
    queue->head = queue->tail = NULL;
    g_mutex_unlock(&queue->mutex);
    im_dispatch_free(old);
}

static inline void im_dispatch_enqueue(struct im_dispatch_queue *queue, guint64 epoch,
                                       struct im_dispatch_event *event)
{
    g_mutex_lock(&queue->mutex);
    gboolean accepted = queue->active && queue->epoch == epoch;
    if (accepted) {
        if (queue->tail) queue->tail->next = event;
        else queue->head = event;
        queue->tail = event;
    }
    g_mutex_unlock(&queue->mutex);
    if (!accepted) im_dispatch_free(event);
}

/* Takes ownership, including when the session has already stopped. */
static inline void im_dispatch_json(struct im_dispatch_queue *queue, guint64 epoch,
                                    struct json_object *object, int tag)
{
    if (!object) return;
    struct im_dispatch_event *event = g_new0(struct im_dispatch_event, 1);
    event->object = object; event->tag = tag;
    im_dispatch_enqueue(queue, epoch, event);
}

/* Required for native_respond's borrowed callback string: one allocation holds
 * both queue node and its owned bytes, without reparsing the JSON. */
static inline void im_dispatch_text(struct im_dispatch_queue *queue, guint64 epoch,
                                    const char *text, int tag)
{
    if (!text) return;
    size_t size = strlen(text);
    if (size > G_MAXSIZE - sizeof(struct im_dispatch_event) - 1) return;
    struct im_dispatch_event *event = g_malloc0(sizeof *event + size + 1);
    event->tag = tag;
    memcpy(event->text, text, size + 1);
    im_dispatch_enqueue(queue, epoch, event);
}

static inline int im_dispatch_run(struct im_dispatch_queue *queue, im_dispatch_consumer consumer, gpointer context)
{
    g_mutex_lock(&queue->mutex);
    if (!queue->active || queue->dispatching) { g_mutex_unlock(&queue->mutex); return 0; }
    if (queue->owner != g_thread_self()) { g_mutex_unlock(&queue->mutex); return -EPERM; }
    queue->dispatching = TRUE;
    guint64 epoch = queue->epoch;
    struct im_dispatch_event *event = queue->head;
    queue->head = queue->tail = NULL;
    g_mutex_unlock(&queue->mutex);
    int count = 0;
    while (event) {
        struct im_dispatch_event *next = event->next;
        event->next = NULL;
        g_mutex_lock(&queue->mutex);
        gboolean current = queue->active && queue->epoch == epoch;
        g_mutex_unlock(&queue->mutex);
        if (current) {
            const char *text = event->object ? json_object_to_json_string_ext(event->object, JSON_C_TO_STRING_PLAIN) : event->text;
            if (text && consumer(text, event->tag, context) && count < G_MAXINT) ++count;
        }
        im_dispatch_free(event);
        event = next;
    }
    g_mutex_lock(&queue->mutex);
    queue->dispatching = FALSE;
    g_mutex_unlock(&queue->mutex);
    return count;
}

/* Exact FFI pump names; call only from the thread that starts that SDK. */
IM_SDK_EXPORT int ImDispatchCallbacks(void);
IM_SDK_EXPORT int OfflineFileDispatchCallbacks(void);
IM_SDK_EXPORT int NativeToolsDispatchCallbacks(void);
IM_SDK_EXPORT int SqliteServiceDispatchCallbacks(void);
#endif
