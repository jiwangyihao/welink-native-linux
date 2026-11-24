/* Linux replacement for GetLastInputInfo and the original in-memory DND timer.
 * Never substitutes a zero idle time when the compositor cannot provide it. */
#define _POSIX_C_SOURCE 200809L
#include "im_transport_presence.h"
#include <errno.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <xcb/xcbext.h>
#include <xcb/screensaver.h>

static struct json_object *field(struct json_object *object, const char *key)
{
    struct json_object *value = NULL;
    if (json_object_is_type(object, json_type_object)) json_object_object_get_ex(object, key, &value);
    return value;
}
static int integer(struct json_object *object, const char *key)
{
    return json_object_get_int(field(object, key));
}

static int bus_idle(struct im_idle_reader *reader, uint64_t *milliseconds)
{
    GVariant *value = g_dbus_connection_call_sync(reader->bus, reader->service, reader->path,
        reader->service, "GetIdletime", NULL, G_VARIANT_TYPE("(t)"), G_DBUS_CALL_FLAGS_NONE,
        1500, NULL, NULL);
    if (!value) return ENODEV;
    guint64 idle;
    g_variant_get(value, "(t)", &idle);
    g_variant_unref(value);
    *milliseconds = idle;
    return 0;
}

int im_idle_open(struct im_idle_reader *reader)
{
    memset(reader, 0, sizeof *reader);
    const char *wayland = getenv("WAYLAND_DISPLAY");
    if (wayland && *wayland) {
        static const struct { const char *service, *path; } providers[] = {
            {"org.gnome.Mutter.IdleMonitor", "/org/gnome/Mutter/IdleMonitor/Core"},
            {"org.cinnamon.Muffin.IdleMonitor", "/org/cinnamon/Muffin/IdleMonitor/Core"}
        };
        reader->bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, NULL);
        if (!reader->bus) return ENODEV;
        for (size_t n = 0; n < sizeof providers / sizeof *providers; ++n) {
            reader->service = providers[n].service;
            reader->path = providers[n].path;
            uint64_t ignored;
            if (!bus_idle(reader, &ignored)) return 0;
        }
        im_idle_close(reader);
        return ENOTSUP;
    }
    int screen_number;
    reader->x11 = xcb_connect(NULL, &screen_number);
    if (!reader->x11 || xcb_connection_has_error(reader->x11)) {
        im_idle_close(reader);
        return ENODEV;
    }
    const xcb_query_extension_reply_t *extension = xcb_get_extension_data(reader->x11, &xcb_screensaver_id);
    if (!extension || !extension->present) { im_idle_close(reader); return ENOTSUP; }
    xcb_screen_iterator_t screens = xcb_setup_roots_iterator(xcb_get_setup(reader->x11));
    for (int n = 0; n < screen_number && screens.rem; ++n) xcb_screen_next(&screens);
    if (!screens.rem) { im_idle_close(reader); return ENODEV; }
    reader->root = screens.data->root;
    return 0;
}

int im_idle_milliseconds(struct im_idle_reader *reader, uint64_t *milliseconds)
{
    if (reader->bus) return bus_idle(reader, milliseconds);
    if (!reader->x11 || xcb_connection_has_error(reader->x11)) return ENODEV;
    xcb_screensaver_query_info_cookie_t cookie = xcb_screensaver_query_info(reader->x11, reader->root);
    if (xcb_flush(reader->x11) <= 0) return ENODEV;
    gint64 deadline = g_get_monotonic_time() + 1500000;
    for (;;) {
        void *reply = NULL;
        xcb_generic_error_t *error = NULL;
        if (xcb_poll_for_reply(reader->x11, cookie.sequence, &reply, &error)) {
            if (error || !reply) { free(error); free(reply); return EIO; }
            *milliseconds = ((xcb_screensaver_query_info_reply_t *)reply)->ms_since_user_input;
            free(reply);
            return 0;
        }
        gint64 remaining = deadline - g_get_monotonic_time();
        if (remaining <= 0) { xcb_discard_reply(reader->x11, cookie.sequence); return ETIMEDOUT; }
        struct pollfd descriptor = {xcb_get_file_descriptor(reader->x11), POLLIN, 0};
        int status = poll(&descriptor, 1, (int)((remaining + 999) / 1000));
        if (status < 0 && errno == EINTR) continue;
        if (status < 0 || (descriptor.revents & (POLLERR | POLLHUP | POLLNVAL))) {
            xcb_discard_reply(reader->x11, cookie.sequence);
            return EIO;
        }
    }
}

void im_idle_close(struct im_idle_reader *reader)
{
    if (reader->bus) g_object_unref(reader->bus);
    if (reader->x11) xcb_disconnect(reader->x11);
    memset(reader, 0, sizeof *reader);
}

int im_schedule_do_not_disturb(struct json_object *configuration, time_t now)
{
    if (!integer(configuration, "isMsgDoNotDisturb")) return 0;
    struct tm local;
    if (!localtime_r(&now, &local)) return 0;
    gboolean applies = FALSE;
    int repetition = integer(configuration, "repetitionFrequency");
    struct json_object *days = field(configuration, repetition == 1 ? "dayOfWeekList" : "activeDates");
    if (json_object_is_type(days, json_type_array)) for (size_t n = 0; n < json_object_array_length(days); ++n) {
        struct json_object *day = json_object_array_get_idx(days, n);
        if (repetition == 1) {
            if (json_object_get_int(day) == local.tm_wday) applies = TRUE;
        } else if (repetition == 0 && integer(day, "year") == local.tm_year + 1900 &&
                   integer(day, "mon") == local.tm_mon + 1 && integer(day, "mday") == local.tm_mday)
            applies = TRUE;
    }
    if (!applies) return 0;
    struct json_object *ranges = field(configuration, "timeRanges");
    if (!json_object_is_type(ranges, json_type_array)) return 0;
    for (size_t n = 0; n < json_object_array_length(ranges); ++n) {
        struct json_object *range = json_object_array_get_idx(ranges, n);
        struct tm begin = local, end = local;
        begin.tm_hour = integer(range, "beginHour"); begin.tm_min = integer(range, "beginMin"); begin.tm_sec = 0;
        end.tm_hour = integer(range, "endHour"); end.tm_min = integer(range, "endMin"); end.tm_sec = 0;
        if (begin.tm_hour < 0 || begin.tm_hour > 23 || end.tm_hour < 0 || end.tm_hour > 23 ||
            begin.tm_min < 0 || begin.tm_min > 59 || end.tm_min < 0 || end.tm_min > 59) continue;
        time_t first = mktime(&begin), last = mktime(&end);
        /* The original compares the same-day epochs with strict bounds. */
        if (first != (time_t)-1 && last != (time_t)-1 && first < now && now < last) return 1;
    }
    return 0;
}
