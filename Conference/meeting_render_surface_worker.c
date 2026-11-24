/* Private pipe protocol for Linux render-surface export; not a Huawei ABI.
 * Every XID is an InputOutput child of the actual Electron X11 client window.
 * Manual Composite redirection prevents duplicate on-screen presentation; the
 * real Chromium scene remains the only presentation/input owner. Consumers use
 * CompositeNameWindowPixmap + GetImage and must release their named pixmaps.
 * Stdin EOF, parent unmap/destruction, invalid input, X error or 1500ms without a
 * complete frame closes the connection, destroying ALL exported windows.
 */
#define _POSIX_C_SOURCE 200809L
#include <xcb/xcb.h>
#include <xcb/composite.h>
#include <xcb/shape.h>
#include <errno.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/prctl.h>
#include <sys/resource.h>

#define MAX_SURFACES 16
#define MAX_EDGE 4096
#define MAX_PIXELS (4u * 1024u * 1024u)
#define LEASE_MS 1500
/* WRS1; uint32 LE: magic, sequence, count, viewport width/height, and
 * Electron content-minus-outer x/y in physical pixels. Subtract actual EWMH
 * frame extents to locate web content inside a framed/menu-bearing X client.
 * Each target: slot, x, y, width, height; followed by width*height*4 RGBA bytes. */
#define MAGIC 0x31535257u
static xcb_connection_t *connection;
static xcb_window_t parent;
static uint8_t depth;
static xcb_visualid_t visual;
static int64_t deadline;
static xcb_atom_t frame_extents;
static uint32_t content_x, content_y;
struct surface { uint32_t slot, width, height; int32_t x, y; xcb_window_t window; xcb_gcontext_t gc; uint8_t *pixels; size_t capacity; int seen; };
static struct surface surfaces[MAX_SURFACES];

static int64_t now_ms(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) return 0;
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}
static int fail(const char *code) {
    printf("{\"error\":\"%s\"}\n", code); fflush(stdout);
    if (connection) xcb_disconnect(connection);
    for (size_t i = 0; i < MAX_SURFACES; ++i) free(surfaces[i].pixels);
    return 1;
}
static int checked(xcb_void_cookie_t cookie) {
    xcb_generic_error_t *error = xcb_request_check(connection, cookie);
    if (!error) return !xcb_connection_has_error(connection);
    free(error); return 0;
}
static int events_ok(void) {
    xcb_generic_event_t *event;
    while ((event = xcb_poll_for_event(connection))) {
        uint8_t type = event->response_type & 127;
        int bad = type == 0 || type == XCB_DESTROY_NOTIFY || type == XCB_UNMAP_NOTIFY;
        free(event);
        if (bad) return 0;
    }
    return !xcb_connection_has_error(connection);
}
static int read_exact(void *buffer, size_t bytes) {
    uint8_t *out = buffer;
    while (bytes) {
        if (!events_ok()) return 0;
        int64_t remaining = deadline - now_ms();
        if (remaining <= 0) return 0;
        struct pollfd fd[2] = {{ STDIN_FILENO, POLLIN, 0 }, {xcb_get_file_descriptor(connection), POLLIN, 0}};
        int rc = poll(fd, 2, (int)remaining);
        if (rc < 0 && errno == EINTR) continue;
        if (rc <= 0 || (fd[0].revents & (POLLERR | POLLNVAL))) return 0;
        if (fd[0].revents & (POLLIN | POLLHUP)) {
            ssize_t n = read(STDIN_FILENO, out, bytes);
            if (n < 0 && errno == EINTR) continue;
            if (n <= 0) return 0;
            out += n; bytes -= (size_t)n;
        }
    }
    return 1;
}
static int word(uint32_t *value) {
    uint8_t b[4];
    if (!read_exact(b, sizeof b)) return 0;
    *value = (uint32_t)b[0] | (uint32_t)b[1] << 8 | (uint32_t)b[2] << 16 | (uint32_t)b[3] << 24;
    return 1;
}
enum parent_state { PARENT_GONE, PARENT_READY, PARENT_RESIZED };
static enum parent_state parent_ready(uint32_t width, uint32_t height, uint32_t outer_dx, uint32_t outer_dy) {
    xcb_get_window_attributes_reply_t *a = xcb_get_window_attributes_reply(connection, xcb_get_window_attributes(connection, parent), NULL);
    xcb_get_geometry_reply_t *g = xcb_get_geometry_reply(connection, xcb_get_geometry(connection, parent), NULL);
    enum parent_state state = a && g && a->map_state == XCB_MAP_STATE_VIEWABLE && g->depth == depth ? PARENT_READY : PARENT_GONE;
    if (state == PARENT_READY && width) {
        uint32_t left = 0, top = 0;
        xcb_get_property_reply_t *p = frame_extents ? xcb_get_property_reply(connection,
            xcb_get_property(connection, 0, parent, frame_extents, XCB_ATOM_CARDINAL, 0, 4), NULL) : NULL;
        if (p && p->format == 32 && p->type == XCB_ATOM_CARDINAL && xcb_get_property_value_length(p) == 16) {
            const uint32_t *values = xcb_get_property_value(p); left = values[0]; top = values[2];
        }
        free(p);
        /* Electron's Linux bounds can include server decorations or describe
         * the client directly. Accept only the origin independently confirmed
         * by this X window's client size and the actual web-content viewport.
         * Our BrowserWindow contains only web content plus its top menu bar. */
        if (outer_dx >= left && outer_dy >= top &&
            outer_dx - left + width == g->width && outer_dy - top + height == g->height) {
            content_x = outer_dx - left; content_y = outer_dy - top;
        } else if (outer_dx + width == g->width && outer_dy + height == g->height) {
            content_x = outer_dx; content_y = outer_dy;
        } else state = PARENT_RESIZED;
    }
    free(a); free(g); return state;
}
static void destroy_surface(struct surface *s) {
    if (s->window) { xcb_destroy_window(connection, s->window); xcb_free_gc(connection, s->gc); }
    free(s->pixels); memset(s, 0, sizeof *s);
}
static void clear_surfaces(void) {
    for (size_t j = 0; j < MAX_SURFACES; ++j) if (surfaces[j].slot) destroy_surface(&surfaces[j]);
}
static int discard_pixels(size_t bytes) {
    uint8_t scratch[8192];
    while (bytes) {
        size_t chunk = bytes < sizeof scratch ? bytes : sizeof scratch;
        if (!read_exact(scratch, chunk)) return 0;
        bytes -= chunk;
    }
    return 1;
}
static int create_surface(struct surface *s) {
    s->window = xcb_generate_id(connection); s->gc = xcb_generate_id(connection);
    uint32_t values[] = { 0, 1 };
    if (!checked(xcb_create_window_checked(connection, depth, s->window, parent, s->x, s->y,
            s->width, s->height, 0, XCB_WINDOW_CLASS_INPUT_OUTPUT, visual,
            XCB_CW_BACK_PIXEL | XCB_CW_OVERRIDE_REDIRECT, values)) ||
        !checked(xcb_composite_redirect_window_checked(connection, s->window, XCB_COMPOSITE_REDIRECT_MANUAL)) ||
        !checked(xcb_shape_rectangles_checked(connection, XCB_SHAPE_SO_SET, XCB_SHAPE_SK_INPUT,
            XCB_CLIP_ORDERING_UNSORTED, s->window, 0, 0, 0, NULL)) ||
        !checked(xcb_create_gc_checked(connection, s->gc, s->window, 0, NULL)) ||
        !checked(xcb_map_window_checked(connection, s->window))) return 0;
    return 1;
}
int main(int argc, char **argv) {
    struct rlimit core = {0, 0}; setrlimit(RLIMIT_CORE, &core); prctl(PR_SET_DUMPABLE, 0);
    if (argc != 3) return fail("RENDER_PARENT_REQUIRED");
    char *end; errno = 0; unsigned long id = strtoul(argv[1], &end, 10);
    if (errno || *end || !id || id > UINT32_MAX) return fail("RENDER_PARENT_INVALID");
    parent = (xcb_window_t)id;
    errno = 0; unsigned long owner_pid = strtoul(argv[2], &end, 10);
    if (errno || *end || !owner_pid || owner_pid > UINT32_MAX) return fail("RENDER_OWNER_INVALID");
    connection = xcb_connect(NULL, NULL);
    if (!connection || xcb_connection_has_error(connection)) return fail("X11_DISPLAY_UNAVAILABLE");
    xcb_intern_atom_reply_t *pid_atom = xcb_intern_atom_reply(connection,
        xcb_intern_atom(connection, 1, 11, "_NET_WM_PID"), NULL);
    xcb_get_property_reply_t *pid = pid_atom && pid_atom->atom ?
        xcb_get_property_reply(connection, xcb_get_property(connection, 0, parent,
            pid_atom->atom, XCB_ATOM_CARDINAL, 0, 1), NULL) : NULL;
    int owns_parent = pid && pid->format == 32 && pid->type == XCB_ATOM_CARDINAL &&
        xcb_get_property_value_length(pid) == 4 && *(uint32_t *)xcb_get_property_value(pid) == owner_pid;
    free(pid_atom); free(pid);
    if (!owns_parent) return fail("RENDER_PARENT_OWNER_MISMATCH");
    xcb_intern_atom_reply_t *extents = xcb_intern_atom_reply(connection,
        xcb_intern_atom(connection, 1, 18, "_NET_FRAME_EXTENTS"), NULL);
    frame_extents = extents ? extents->atom : XCB_ATOM_NONE; free(extents);
    const xcb_setup_t *setup = xcb_get_setup(connection);
    xcb_get_window_attributes_reply_t *attr = xcb_get_window_attributes_reply(connection, xcb_get_window_attributes(connection, parent), NULL);
    xcb_get_geometry_reply_t *geometry = xcb_get_geometry_reply(connection, xcb_get_geometry(connection, parent), NULL);
    if (!attr || !geometry) { free(attr); free(geometry); return fail("NOT_AN_X11_WINDOW"); }
    visual = attr->visual; depth = geometry->depth; free(attr); free(geometry);
    int supported = 0;
    for (xcb_screen_iterator_t screen = xcb_setup_roots_iterator(setup); screen.rem; xcb_screen_next(&screen))
        for (xcb_depth_iterator_t d = xcb_screen_allowed_depths_iterator(screen.data); d.rem; xcb_depth_next(&d))
            for (xcb_visualtype_iterator_t v = xcb_depth_visuals_iterator(d.data); v.rem; xcb_visualtype_next(&v))
                if (v.data->visual_id == visual && v.data->_class == XCB_VISUAL_CLASS_TRUE_COLOR &&
                    v.data->red_mask == 0xff0000 && v.data->green_mask == 0xff00 && v.data->blue_mask == 0xff)
                    supported = 1;
    int bpp = 0;
    for (xcb_format_iterator_t f = xcb_setup_pixmap_formats_iterator(setup); f.rem; xcb_format_next(&f))
        if (f.data->depth == depth && f.data->bits_per_pixel == 32 && f.data->scanline_pad == 32) bpp = 1;
    if (!supported || !bpp || (depth != 24 && depth != 32) || setup->image_byte_order != XCB_IMAGE_ORDER_LSB_FIRST)
        return fail("X11_VISUAL_UNSUPPORTED");
    const xcb_query_extension_reply_t *composite = xcb_get_extension_data(connection, &xcb_composite_id);
    const xcb_query_extension_reply_t *shape = xcb_get_extension_data(connection, &xcb_shape_id);
    if (!composite || !composite->present || !shape || !shape->present) return fail("X11_COMPOSITE_UNAVAILABLE");
    xcb_composite_query_version_reply_t *cv = xcb_composite_query_version_reply(connection, xcb_composite_query_version(connection, 0, 4), NULL);
    xcb_shape_query_version_reply_t *sv = xcb_shape_query_version_reply(connection, xcb_shape_query_version(connection), NULL);
    supported = cv && (cv->major_version > 0 || cv->minor_version >= 2) && sv &&
        (sv->major_version > 1 || (sv->major_version == 1 && sv->minor_version >= 1));
    free(cv); free(sv);
    if (!supported) return fail("X11_COMPOSITE_UNAVAILABLE");
    uint32_t event_mask = XCB_EVENT_MASK_STRUCTURE_NOTIFY;
    if (!checked(xcb_change_window_attributes_checked(connection, parent, XCB_CW_EVENT_MASK, &event_mask)) || !parent_ready(0, 0, 0, 0))
        return fail("RENDER_PARENT_NOT_VISIBLE");
    printf("{\"ready\":true,\"parentXid\":%u,\"depth\":%u,\"visualId\":%u}\n", parent, depth, visual); fflush(stdout);
    deadline = now_ms() + LEASE_MS;
    for (;;) {
        uint32_t magic, sequence, count, vw, vh, outer_dx, outer_dy;
        if (!word(&magic)) break;
        if (!word(&sequence) || !word(&count) || !word(&vw) || !word(&vh) || !word(&outer_dx) || !word(&outer_dy) ||
            magic != MAGIC || count > MAX_SURFACES || !vw || !vh || vw > 32767 || vh > 32767 || outer_dx > 4096 || outer_dy > 4096)
            return fail("INVALID_RENDER_FRAME");
        enum parent_state layout = parent_ready(count ? vw : 0, vh, outer_dx, outer_dy);
        if (layout == PARENT_GONE) return fail("RENDER_PARENT_RETIRED");
        const uint32_t draw_x = content_x, draw_y = content_y;
        if (layout == PARENT_RESIZED) { clear_surfaces(); xcb_flush(connection); }
        for (size_t j = 0; j < MAX_SURFACES; ++j) surfaces[j].seen = 0;
        uint32_t pixels = 0;
        for (uint32_t i = 0; i < count; ++i) {
            uint32_t slot, x, y, w, h;
            if (!word(&slot) || !word(&x) || !word(&y) || !word(&w) || !word(&h) || !slot ||
                !w || !h || w > MAX_EDGE || h > MAX_EDGE || x > vw || y > vh || w > vw - x || h > vh - y ||
                w * h > MAX_PIXELS - pixels) return fail("INVALID_RENDER_GEOMETRY");
            pixels += w * h;
            if (layout == PARENT_RESIZED) {
                if (!discard_pixels((size_t)w * h * 4)) return fail("RENDER_FRAME_RETIRED");
                continue;
            }
            x += content_x; y += content_y;
            struct surface *s = NULL;
            for (size_t j = 0; j < MAX_SURFACES; ++j) if (surfaces[j].slot == slot) { s = &surfaces[j]; break; }
            if (!s) for (size_t j = 0; j < MAX_SURFACES; ++j) if (!surfaces[j].slot) { s = &surfaces[j]; s->slot = slot; break; }
            if (!s || s->seen) return fail("RENDER_SURFACE_LIMIT");
            s->seen = 1;
            size_t bytes = (size_t)w * h * 4;
            if (s->capacity < bytes) {
                uint8_t *next = realloc(s->pixels, bytes);
                if (!next) return fail("RENDER_MEMORY_UNAVAILABLE");
                s->pixels = next; s->capacity = bytes;
            }
            if (!read_exact(s->pixels, bytes)) return fail("RENDER_FRAME_RETIRED");
            int changed = s->x != (int32_t)x || s->y != (int32_t)y || s->width != w || s->height != h;
            s->x = x; s->y = y; s->width = w; s->height = h;
            if (!s->window) { if (!create_surface(s)) return fail("X11_SURFACE_CREATE_FAILED"); }
            else if (changed) {
                uint32_t values[] = {x, y, w, h};
                if (!checked(xcb_configure_window_checked(connection, s->window,
                        XCB_CONFIG_WINDOW_X | XCB_CONFIG_WINDOW_Y | XCB_CONFIG_WINDOW_WIDTH | XCB_CONFIG_WINDOW_HEIGHT, values)))
                    return fail("X11_SURFACE_RESIZE_FAILED");
            }
            for (size_t p = 0; p < bytes; p += 4) { uint8_t r = s->pixels[p]; s->pixels[p] = s->pixels[p+2]; s->pixels[p+2] = r; }
            uint32_t rows = (xcb_get_maximum_request_length(connection) * 4u - 64u) / (w * 4u);
            if (!rows) return fail("X11_IMAGE_TOO_WIDE");
            for (uint32_t y0 = 0; y0 < h; y0 += rows) {
                uint32_t n = h - y0 < rows ? h - y0 : rows;
                if (!checked(xcb_put_image_checked(connection, XCB_IMAGE_FORMAT_Z_PIXMAP, s->window, s->gc,
                        w, n, 0, y0, 0, depth, w * n * 4u, s->pixels + (size_t)y0 * w * 4)))
                    return fail("X11_SURFACE_PAINT_FAILED");
            }
        }
        for (size_t j = 0; j < MAX_SURFACES; ++j) if (surfaces[j].slot && !surfaces[j].seen) destroy_surface(&surfaces[j]);
        enum parent_state painted = parent_ready(count ? vw : 0, vh, outer_dx, outer_dy);
        if (painted == PARENT_GONE || !events_ok()) return fail("RENDER_PARENT_RETIRED");
        if (layout == PARENT_RESIZED || painted == PARENT_RESIZED || (count && (draw_x != content_x || draw_y != content_y))) {
            clear_surfaces();
            /* Acknowledge only after X has destroyed the old windows. Keep the
             * connection, so no old tile ID is reassigned within this lease. */
            if (parent_ready(0, 0, 0, 0) != PARENT_READY || !events_ok()) return fail("RENDER_PARENT_RETIRED");
            printf("{\"sequence\":%u,\"layoutPending\":true,\"surfaces\":[]}\n", sequence);
            fflush(stdout); deadline = now_ms() + LEASE_MS; continue;
        }
        /* The round trip above confirms all drawing before publishing the XIDs. */
        printf("{\"sequence\":%u,\"contentOffset\":{\"x\":%u,\"y\":%u},\"surfaces\":[", sequence, content_x, content_y);
        int comma = 0;
        for (size_t j = 0; j < MAX_SURFACES; ++j) {
            struct surface *s = &surfaces[j]; if (!s->slot) continue;
            printf("%s{\"slot\":%u,\"xid\":%u,\"x\":%d,\"y\":%d,\"width\":%u,\"height\":%u}",
                comma++ ? "," : "", s->slot, s->window, s->x, s->y, s->width, s->height);
        }
        puts("]}"); fflush(stdout); deadline = now_ms() + LEASE_MS;
    }
    xcb_disconnect(connection);
    for (size_t i = 0; i < MAX_SURFACES; ++i) free(surfaces[i].pixels);
    return 0;
}
