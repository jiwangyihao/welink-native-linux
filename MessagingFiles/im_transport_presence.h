#ifndef WELINK_IM_TRANSPORT_PRESENCE_H
#define WELINK_IM_TRANSPORT_PRESENCE_H
#include <stdint.h>
#include <time.h>
#include <gio/gio.h>
#include <json-c/json.h>
#include <xcb/xcb.h>
struct im_idle_reader {
    GDBusConnection *bus;
    const char *service, *path;
    xcb_connection_t *x11;
    xcb_window_t root;
};
int im_idle_open(struct im_idle_reader *reader);
int im_idle_milliseconds(struct im_idle_reader *reader, uint64_t *milliseconds);
void im_idle_close(struct im_idle_reader *reader);
int im_schedule_do_not_disturb(struct json_object *configuration, time_t now);
#endif
