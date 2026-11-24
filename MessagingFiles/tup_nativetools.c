/* Native implementation of the observed tup_nativetools_logic_api ABI.
 * Build: json-c, libarchive, libgif, gdk-pixbuf-2.0, gio-2.0 and GLib threads.
 * Desktop runtime: xclip (X11) or wl-clipboard (Wayland), and an xdg-desktop-
 * portal Screenshot provider. No Wine, SDK recording library or network API.
 * Call NativeToolsDispatchCallbacks() only on the initializing FFI thread.
 * Shutdown invalidates queued callbacks and cancels work without joining;
 * initialization stays busy until the old worker finishes desktop cleanup.
 * The Windows dispatcher has no implementation for data migration (14/15);
 * those commands are rejected rather than reporting a completed migration.
 * Commands and response fields were recovered from the original DLL and JS.
 */
#define _GNU_SOURCE
#include "native_rpc.h"
#include "im_transport_dispatch.h"
#include <archive.h>
#include <archive_entry.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <gio/gio.h>
#include <gif_lib.h>
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

struct zip_reader {
    struct zip_reader *next;
    char *path;
    struct archive *archive;
    int64_t total, current;
};
struct tools_job { struct native_request request; };
static GMutex lifecycle;
static GAsyncQueue *jobs;
static GThread *worker;
static GCancellable *cancellation;
static native_callback reply_callback;
static struct im_dispatch_queue callbacks;
/* Immutable while worker is non-NULL, including its asynchronous cleanup. */
static guint64 startup_epoch;
static struct zip_reader *zip_readers;
static char stop_job;
static gboolean stopping;

static const char *string_value(struct json_object *object, const char *key)
{
    return native_string(object, key, "");
}

static struct json_object *reason_param(const char *reason)
{
    struct json_object *param = json_object_new_object();
    if (param) json_object_object_add(param, "reason", json_object_new_string(reason));
    return param;
}

static int queue_response(const char *text)
{
    im_dispatch_text(&callbacks, startup_epoch, text, 0);
    return 0;
}

static void respond(struct native_request *request, int result, struct json_object *param)
{
    native_respond(queue_response, request, result, param);
}

static gboolean is_cancelled(void)
{
    return g_cancellable_is_cancelled(cancellation);
}

static int write_all(int fd, const void *data, size_t length)
{
    const unsigned char *p = data;
    while (length) {
        ssize_t n = write(fd, p, length);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return -1;
        p += n;
        length -= (size_t)n;
    }
    return 0;
}

static int copy_file(const char *source, const char *destination)
{
    if (!*source || !*destination) return -1;
    int input = open(source, O_RDONLY | O_CLOEXEC);
    if (input < 0) return -1;
    struct stat st;
    if (fstat(input, &st) || !S_ISREG(st.st_mode)) { close(input); return -1; }
    char *temporary = g_strconcat(destination, ".XXXXXX", NULL);
    int output = g_mkstemp_full(temporary, O_WRONLY | O_CLOEXEC, 0600);
    int result = output < 0 ? -1 : 0;
    unsigned char buffer[65536];
    while (!result) {
        if (is_cancelled()) { result = -1; break; }
        ssize_t n = read(input, buffer, sizeof buffer);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) { result = -1; break; }
        if (!n) break;
        result = write_all(output, buffer, (size_t)n);
    }
    close(input);
    if (output >= 0) {
        if (!result && fsync(output)) result = -1;
        if (close(output)) result = -1;
        if (!result && rename(temporary, destination)) result = -1;
        if (result) unlink(temporary);
    }
    g_free(temporary);
    return result;
}

static struct archive *zip_open_reader(const char *path, const char *password)
{
    struct archive *archive = archive_read_new();
    if (!archive) return NULL;
    archive_read_support_format_zip(archive);
    if (*password && archive_read_add_passphrase(archive, password) != ARCHIVE_OK) {
        archive_read_free(archive);
        return NULL;
    }
    if (archive_read_open_filename(archive, path, 65536) != ARCHIVE_OK) {
        archive_read_free(archive);
        return NULL;
    }
    return archive;
}

static struct zip_reader **find_zip(const char *path)
{
    struct zip_reader **reader = &zip_readers;
    while (*reader && strcmp((*reader)->path, path)) reader = &(*reader)->next;
    return reader;
}

static void zip_close(struct zip_reader **position)
{
    struct zip_reader *reader = *position;
    *position = reader->next;
    archive_read_free(reader->archive);
    g_free(reader->path);
    g_free(reader);
}

static void zip_command(struct native_request *request)
{
    const char *path = string_value(request->param, "file_path");
    if (!*path) { respond(request, 1, NULL); return; }
    struct zip_reader **position = find_zip(path);
    if (request->cmd == 3) {
        int result = *position ? 0 : 1;
        if (*position) zip_close(position);
        respond(request, result, NULL);
        return;
    }
    if (request->cmd == 1) {
        const char *password = string_value(request->param, "password");
        struct archive *archive = zip_open_reader(path, password);
        if (!archive) { respond(request, 1, NULL); return; }
        int64_t count = 0;
        struct archive_entry *entry;
        int status;
        while ((status = archive_read_next_header(archive, &entry)) == ARCHIVE_OK) {
            ++count;
            if (is_cancelled() || archive_read_data_skip(archive) != ARCHIVE_OK) {
                status = ARCHIVE_FATAL;
                break;
            }
        }
        archive_read_free(archive);
        if (status != ARCHIVE_EOF || !(archive = zip_open_reader(path, password))) {
            respond(request, 1, NULL);
            return;
        }
        if (*position) zip_close(position);
        struct zip_reader *reader = g_new0(struct zip_reader, 1);
        reader->path = g_strdup(path);
        reader->archive = archive;
        reader->total = count;
        reader->next = zip_readers;
        zip_readers = reader;
        struct json_object *param = json_object_new_object();
        json_object_object_add(param, "file_path", json_object_new_string(path));
        json_object_object_add(param, "total_num", json_object_new_int64(count));
        respond(request, 0, param);
        return;
    }
    struct zip_reader *reader = *position;
    if (!reader) { respond(request, 1, NULL); return; }
    struct archive_entry *entry;
    int status;
    do {
        status = archive_read_next_header(reader->archive, &entry);
        if (status != ARCHIVE_OK) { respond(request, 1, NULL); return; }
        ++reader->current;
    } while (archive_entry_filetype(entry) == AE_IFDIR);
    la_int64_t size = archive_entry_size(entry);
    if (size < 0 || size > INT_MAX || archive_entry_filetype(entry) != AE_IFREG) {
        respond(request, 1, NULL);
        return;
    }
    char *data = g_try_malloc((size_t)size + 1);
    if (!data) { respond(request, 1, NULL); return; }
    size_t length = 0;
    while (length < (size_t)size && !is_cancelled()) {
        la_ssize_t n = archive_read_data(reader->archive, data + length, (size_t)size - length);
        if (n <= 0) break;
        length += (size_t)n;
    }
    char extra;
    if (length != (size_t)size || archive_read_data(reader->archive, &extra, 1) != 0 || is_cancelled()) {
        g_free(data);
        respond(request, 1, NULL);
        return;
    }
    data[length] = 0;
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "file_path", json_object_new_string(path));
    json_object_object_add(param, "file_stream", json_object_new_string_len(data, (int)length));
    json_object_object_add(param, "total_num", json_object_new_int64(reader->total));
    json_object_object_add(param, "cur_num", json_object_new_int64(reader->current));
    g_free(data);
    respond(request, 0, param);
}

static int archive_directory(struct archive *archive, int directory, const char *relative,
                             const struct stat *output, const struct stat *old_output)
{
    int duplicate = dup(directory);
    if (duplicate < 0) return -1;
    DIR *entries = fdopendir(duplicate);
    if (!entries) { close(duplicate); return -1; }
    int result = 0;
    struct dirent *item;
    unsigned char buffer[65536];
    while (!result) {
        errno = 0;
        item = readdir(entries);
        if (!item) { if (errno) result = -1; break; }
        if (!strcmp(item->d_name, ".") || !strcmp(item->d_name, "..")) continue;
        if (is_cancelled()) { result = -1; break; }
        int fd = openat(directory, item->d_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
        struct stat st;
        if (fd < 0 || fstat(fd, &st)) { if (fd >= 0) close(fd); result = -1; break; }
        if ((st.st_dev == output->st_dev && st.st_ino == output->st_ino) ||
            (old_output && st.st_dev == old_output->st_dev && st.st_ino == old_output->st_ino)) {
            close(fd);
            continue;
        }
        char *name = *relative ? g_strconcat(relative, "/", item->d_name, NULL) : g_strdup(item->d_name);
        if (S_ISDIR(st.st_mode)) {
            struct archive_entry *entry = archive_entry_new();
            archive_entry_set_pathname_utf8(entry, name);
            archive_entry_set_filetype(entry, AE_IFDIR);
            archive_entry_set_perm(entry, st.st_mode & 0777);
            archive_entry_set_mtime(entry, st.st_mtime, 0);
            result = archive_write_header(archive, entry) != ARCHIVE_OK ? -1 : 0;
            archive_entry_free(entry);
            if (!result) result = archive_directory(archive, fd, name, output, old_output);
        } else if (S_ISREG(st.st_mode)) {
            struct archive_entry *entry = archive_entry_new();
            archive_entry_set_pathname_utf8(entry, name);
            archive_entry_set_filetype(entry, AE_IFREG);
            archive_entry_set_perm(entry, st.st_mode & 0777);
            archive_entry_set_size(entry, st.st_size);
            archive_entry_set_mtime(entry, st.st_mtime, 0);
            result = archive_write_header(archive, entry) != ARCHIVE_OK ? -1 : 0;
            archive_entry_free(entry);
            off_t remaining = st.st_size;
            while (!result && remaining) {
                if (is_cancelled()) { result = -1; break; }
                size_t want = remaining > (off_t)sizeof buffer ? sizeof buffer : (size_t)remaining;
                ssize_t n = read(fd, buffer, want);
                if (n < 0 && errno == EINTR) continue;
                if (n <= 0) { result = -1; break; }
                size_t offset = 0;
                while (offset < (size_t)n) {
                    la_ssize_t written = archive_write_data(archive, buffer + offset, (size_t)n - offset);
                    if (written <= 0) { result = -1; break; }
                    offset += (size_t)written;
                }
                remaining -= n;
            }
        } else result = -1;
        g_free(name);
        close(fd);
    }
    closedir(entries);
    return result;
}

static int create_zip(struct json_object *param)
{
    const char *source = string_value(param, "dir_path");
    const char *destination = string_value(param, "zip_file_name");
    if (!*source || !*destination) return -1;
    int directory = open(source, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (directory < 0) return -1;
    struct stat old_output, output;
    gboolean exists = stat(destination, &old_output) == 0;
    char *temporary = g_strconcat(destination, ".XXXXXX", NULL);
    int fd = g_mkstemp_full(temporary, O_WRONLY | O_CLOEXEC, 0600);
    struct archive *archive = archive_write_new();
    /* UTF-8 wire filenames must not depend on the host process locale. */
    int result = -1;
    if (fd >= 0 && archive && !fstat(fd, &output) &&
        archive_write_set_format_zip(archive) == ARCHIVE_OK &&
        archive_write_set_format_option(archive, "zip", "hdrcharset", "UTF-8") == ARCHIVE_OK &&
        archive_write_open_fd(archive, fd) == ARCHIVE_OK) {
        result = archive_directory(archive, directory, "", &output, exists ? &old_output : NULL);
        if (archive_write_close(archive) != ARCHIVE_OK) result = -1;
        if (!result && fsync(fd)) result = -1;
    }
    if (archive) archive_write_free(archive);
    close(directory);
    if (fd >= 0) {
        if (close(fd)) result = -1;
        if (!result && rename(temporary, destination)) result = -1;
        if (result) unlink(temporary);
    }
    g_free(temporary);
    return result;
}

static int save_gif(GdkPixbuf *image, const char *path)
{
    unsigned width = (unsigned)gdk_pixbuf_get_width(image);
    unsigned height = (unsigned)gdk_pixbuf_get_height(image);
    if (!width || !height || width > 65535 || height > 65535 ||
        (size_t)width > SIZE_MAX / height / 4) return -1;
    size_t count = (size_t)width * height;
    GifByteType *planes = g_try_malloc_n(count, 4);
    if (!planes) return -1;
    GifByteType *red = planes, *green = planes + count, *blue = planes + count * 2;
    GifByteType *indices = planes + count * 3;
    const unsigned char *pixels = gdk_pixbuf_read_pixels(image);
    int channels = gdk_pixbuf_get_n_channels(image);
    int stride = gdk_pixbuf_get_rowstride(image);
    gboolean alpha = gdk_pixbuf_get_has_alpha(image), transparent = FALSE;
    for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
        size_t n = (size_t)y * width + x;
        const unsigned char *pixel = pixels + (size_t)y * stride + (size_t)x * channels;
        red[n] = pixel[0]; green[n] = pixel[1]; blue[n] = pixel[2];
        if (alpha && pixel[3] < 128) transparent = TRUE;
    }
    GifColorType palette[256] = {{0}};
    int colors = transparent ? 255 : 256;
    int result = -1, error;
    if (GifQuantizeBuffer(width, height, &colors, red, green, blue, indices, palette) != GIF_OK) goto finished;
    if (transparent) for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x)
        if (pixels[(size_t)y * stride + (size_t)x * channels + 3] < 128)
            indices[(size_t)y * width + x] = 255;
    ColorMapObject *map = GifMakeMapObject(256, palette);
    if (!map) goto finished;
    GifFileType *gif = EGifOpenFileName(path, FALSE, &error);
    if (gif) {
        result = EGifPutScreenDesc(gif, width, height, 8, 0, map) == GIF_OK ? 0 : -1;
        if (!result && transparent) {
            const unsigned char extension[4] = {1, 0, 0, 255};
            if (EGifPutExtension(gif, GRAPHICS_EXT_FUNC_CODE, sizeof extension, extension) != GIF_OK) result = -1;
        }
        if (!result && EGifPutImageDesc(gif, 0, 0, width, height, FALSE, NULL) != GIF_OK) result = -1;
        for (unsigned y = 0; !result && y < height; ++y)
            if (EGifPutLine(gif, indices + (size_t)y * width, width) != GIF_OK) result = -1;
        if (EGifCloseFile(gif, &error) != GIF_OK) result = -1;
    }
    GifFreeMapObject(map);
finished:
    g_free(planes);
    return result;
}

static int save_image(GdkPixbuf *image, const char *path, const char *format)
{
    if (!image || !*path) return -1;
    char *temporary = g_strconcat(path, ".XXXXXX", NULL);
    int fd = g_mkstemp_full(temporary, O_WRONLY | O_CLOEXEC, 0600);
    int result = -1;
    if (fd >= 0) {
        close(fd);
        gboolean saved = !strcmp(format, "gif") ? save_gif(image, temporary) == 0 :
            gdk_pixbuf_save(image, temporary, format, NULL, NULL);
        if (saved && !rename(temporary, path)) result = 0;
        if (result) unlink(temporary);
    }
    g_free(temporary);
    return result;
}

static int thumbnail(struct json_object *param)
{
    const char *source = string_value(param, "origin_path");
    const char *destination = string_value(param, "thumb_path");
    int64_t width = native_integer(param, "thumb_width", 800);
    int64_t height = native_integer(param, "thumb_height", 600);
    if (!*source || !*destination || width <= 0 || height <= 0 || width > INT_MAX || height > INT_MAX) return -1;
    GdkPixbufFormat *detected = gdk_pixbuf_get_file_info(source, NULL, NULL);
    if (!detected) return -1;
    char *format = gdk_pixbuf_format_get_name(detected);
    if (strcmp(format, "png") && strcmp(format, "jpeg") && strcmp(format, "bmp") &&
        strcmp(format, "gif") && strcmp(format, "tiff")) { g_free(format); return -1; }
    GdkPixbuf *original = gdk_pixbuf_new_from_file(source, NULL);
    if (!original) { g_free(format); return -1; }
    int ow = gdk_pixbuf_get_width(original), oh = gdk_pixbuf_get_height(original);
    /* DLL uses the smaller target/original ratio, including upscaling. */
    if (width * oh <= height * ow) height = width * oh / ow;
    else width = height * ow / oh;
    if (!width) width = 1;
    if (!height) height = 1;
    GdkPixbuf *scaled = gdk_pixbuf_scale_simple(original, (int)width, (int)height, GDK_INTERP_BILINEAR);
    g_object_unref(original);
    if (!scaled) { g_free(format); return -1; }
    int result = save_image(scaled, destination, format);
    g_free(format);
    g_object_unref(scaled);
    return result;
}

/* The command is argv-only, and all clipboard bytes remain in memory. */
static GBytes *desktop_command(const char *const *argv, GBytes *input, gboolean capture)
{
    if (is_cancelled()) return NULL;
    GSubprocessFlags flags = G_SUBPROCESS_FLAGS_STDERR_SILENCE |
        (capture ? G_SUBPROCESS_FLAGS_STDOUT_PIPE : G_SUBPROCESS_FLAGS_STDOUT_SILENCE);
    if (input) flags |= G_SUBPROCESS_FLAGS_STDIN_PIPE;
    GSubprocess *process = g_subprocess_newv(argv, flags, NULL);
    if (!process) return NULL;
    GBytes *output = NULL;
    gboolean ok = g_subprocess_communicate(process, input, cancellation, capture ? &output : NULL, NULL, NULL);
    if (!ok) {
        g_subprocess_force_exit(process);
        g_subprocess_wait(process, NULL, NULL);
    }
    if (ok) ok = g_subprocess_get_successful(process);
    g_object_unref(process);
    if (!ok) { if (output) g_bytes_unref(output); return NULL; }
    return output ? output : g_bytes_new_static("", 0);
}

static gboolean wayland_session(void)
{
    const char *display = g_getenv("WAYLAND_DISPLAY");
    return display && *display;
}

static GdkPixbuf *clipboard_image(void)
{
    const char *wayland[] = { "wl-paste", "--no-newline", "--type", "image/png", NULL };
    const char *x11[] = { "xclip", "-selection", "clipboard", "-target", "image/png", "-out", NULL };
    GBytes *data = desktop_command(wayland_session() ? wayland : x11, NULL, TRUE);
    if (!data) return NULL;
    gsize length;
    const void *bytes = g_bytes_get_data(data, &length);
    GdkPixbufLoader *loader = gdk_pixbuf_loader_new();
    gboolean written = gdk_pixbuf_loader_write(loader, bytes, length, NULL);
    gboolean closed = gdk_pixbuf_loader_close(loader, NULL);
    GdkPixbuf *image = written && closed ? gdk_pixbuf_loader_get_pixbuf(loader) : NULL;
    if (image) g_object_ref(image);
    g_object_unref(loader);
    g_bytes_unref(data);
    return image;
}

static int clipboard_publish(GdkPixbuf *image)
{
    gchar *png = NULL;
    gsize length = 0;
    if (!gdk_pixbuf_save_to_buffer(image, &png, &length, "png", NULL, NULL)) return -1;
    GBytes *input = g_bytes_new_take(png, length);
    const char *wayland[] = { "wl-copy", "--type", "image/png", NULL };
    const char *x11[] = { "xclip", "-selection", "clipboard", "-target", "image/png", "-in", NULL };
    GBytes *output = desktop_command(wayland_session() ? wayland : x11, input, FALSE);
    g_bytes_unref(input);
    if (!output) return -1;
    g_bytes_unref(output);
    return 0;
}

static void clipboard_command(struct native_request *request)
{
    if (request->cmd == 11) {
        /* The original returns zero only for spreadsheet clipboard formats;
         * this is not a generic has-image/success boolean. */
        const char *wayland[] = { "wl-paste", "--list-types", NULL };
        const char *x11[] = { "xclip", "-selection", "clipboard", "-target", "TARGETS", "-out", NULL };
        GBytes *types = desktop_command(wayland_session() ? wayland : x11, NULL, TRUE);
        int result = 1;
        if (types) {
            gsize length;
            const char *data = g_bytes_get_data(types, &length);
            if (g_strstr_len(data, length, "WPS Spreadsheets") ||
                g_strstr_len(data, length, "WPS_Spreadsheets") ||
                g_strstr_len(data, length, "Biff")) result = 0;
            g_bytes_unref(types);
        }
        respond(request, result, NULL);
        return;
    }
    GdkPixbuf *image = clipboard_image();
    if (!image) { respond(request, 1, NULL); return; }
    if (request->cmd == 4) {
        struct json_object *param = json_object_new_object();
        json_object_object_add(param, "Width", json_object_new_int(gdk_pixbuf_get_width(image)));
        json_object_object_add(param, "Height", json_object_new_int(gdk_pixbuf_get_height(image)));
        respond(request, 0, param);
    } else {
        int result = save_image(image, string_value(request->param, "file_path"), "png");
        respond(request, result ? 1 : 0, NULL);
    }
    g_object_unref(image);
}

struct emoji_item { char *filename; int64_t index; };
static void emoji_free(gpointer pointer)
{
    struct emoji_item *item = pointer;
    g_free(item->filename);
    g_free(item);
}
static gint emoji_compare(gconstpointer a, gconstpointer b)
{
    const struct emoji_item *left = *(struct emoji_item *const *)a;
    const struct emoji_item *right = *(struct emoji_item *const *)b;
    return (left->index > right->index) - (left->index < right->index);
}
static gboolean safe_component(const char *text)
{
    return *text && strcmp(text, ".") && strcmp(text, "..") && !strpbrk(text, "/\\\r\n=");
}
static struct emoji_item *emoji_item_new(const char *name, int64_t index)
{
    struct emoji_item *item = g_new(struct emoji_item, 1);
    item->filename = g_strdup(name);
    item->index = index;
    return item;
}
static GPtrArray *emoji_read(const char *path)
{
    GKeyFile *ini = g_key_file_new();
    if (!g_key_file_load_from_file(ini, path, G_KEY_FILE_NONE, NULL)) {
        g_key_file_unref(ini);
        return NULL;
    }
    GPtrArray *items = g_ptr_array_new_with_free_func(emoji_free);
    gsize count;
    char **groups = g_key_file_get_groups(ini, &count);
    for (gsize n = 0; n < count; ++n) {
        char *end;
        errno = 0;
        int64_t index = g_ascii_strtoll(groups[n], &end, 10);
        char *name = g_key_file_get_string(ini, groups[n], "file", NULL);
        if (errno || *end || index <= 0 || !name || !safe_component(name)) {
            g_free(name);
            g_ptr_array_unref(items);
            items = NULL;
            break;
        }
        g_ptr_array_add(items, emoji_item_new(name, index));
        g_free(name);
    }
    g_strfreev(groups);
    g_key_file_unref(ini);
    if (items) g_ptr_array_sort(items, emoji_compare);
    return items;
}
static int emoji_write(const char *path, GPtrArray *items)
{
    char *temporary = g_strconcat(path, ".XXXXXX", NULL);
    int fd = g_mkstemp_full(temporary, O_WRONLY | O_CLOEXEC, 0600);
    if (fd < 0) { g_free(temporary); return -1; }
    int result = 0;
    for (guint n = 0; n < items->len && !result; ++n) {
        const struct emoji_item *item = g_ptr_array_index(items, n);
        char header[64];
        int length = snprintf(header, sizeof header, "[%u]\r\nfile=", n + 1);
        result = write_all(fd, header, (size_t)length) ||
                 write_all(fd, item->filename, strlen(item->filename)) ||
                 write_all(fd, "\r\nhint=\r\n", 9);
    }
    if (!result && fsync(fd)) result = -1;
    if (close(fd)) result = -1;
    if (!result && rename(temporary, path)) result = -1;
    if (result) unlink(temporary);
    g_free(temporary);
    return result;
}

static void emoji_command(struct native_request *request)
{
    int command = (int)request->cmd;
    const char *directory = string_value(request->param, command == 9 ? "customEmojiPath" : "saveFilePath");
    if (!*directory) { respond(request, 1, reason_param("invalid param")); return; }
    char *config = g_build_filename(directory, "Emotion.ini", NULL);
    GPtrArray *items = NULL;
    const char *reason = "invalid param";
    int result = -1;
    int64_t new_index = 0;
    char *removed_path = NULL;
    if (command == 9 || command == 10) {
        struct json_object *array = native_get(request->param, "emojiIds");
        if (!json_object_is_type(array, json_type_array)) goto finished;
        items = g_ptr_array_new_with_free_func(emoji_free);
        size_t count = json_object_array_length(array);
        for (size_t n = 0; n < count; ++n) {
            struct json_object *value = json_object_array_get_idx(array, n);
            const char *id = string_value(value, "objectId");
            const char *suffix = string_value(value, "fileSuffix");
            if (!safe_component(id) || !safe_component(suffix)) goto finished;
            char *name = g_strconcat(id, ".", suffix, NULL);
            int64_t index = command == 9 ? native_integer(value, "indexNo", 0) : (int64_t)n + 1;
            if (index <= 0) { g_free(name); goto finished; }
            g_ptr_array_add(items, emoji_item_new(name, index));
            g_free(name);
        }
        if (command == 9) g_ptr_array_sort(items, emoji_compare);
    } else {
        items = emoji_read(config);
        if (!items) { reason = "cannot read Emotion.ini"; goto finished; }
        int64_t direction = native_integer(request->param, "direction", 0);
        if ((command == 6 || command == 7) && direction != -1 && direction != 1) goto finished;
        if (command == 6) {
            const char *source = string_value(request->param, "filePath");
            const char *id = string_value(request->param, "guid");
            if (!*source || !safe_component(id)) goto finished;
            const char *suffix = strrchr(source, '.');
            if (!suffix || !safe_component(suffix + 1)) { reason = "invalid image suffix"; goto finished; }
            char *name = g_strconcat(id, suffix, NULL);
            char *destination = g_build_filename(directory, name, NULL);
            struct stat st;
            if (!stat(destination, &st)) {
                g_free(name); g_free(destination);
                reason = "image already exists";
                goto finished;
            }
            if (copy_file(source, destination)) {
                g_free(name); g_free(destination);
                reason = "cannot copy image";
                goto finished;
            }
            /* Roll back only this newly created image if committing the index fails. */
            removed_path = destination;
            struct emoji_item *item = emoji_item_new(name, 0);
            g_free(name);
            if (direction == 1) g_ptr_array_add(items, item);
            else g_ptr_array_insert(items, 0, item);
            new_index = direction == 1 ? items->len : 1;
        } else {
            const char *id = string_value(request->param, "emojiId");
            if (!safe_component(id)) goto finished;
            guint found = items->len;
            size_t id_length = strlen(id);
            for (guint n = 0; n < items->len; ++n) {
                struct emoji_item *item = g_ptr_array_index(items, n);
                if (!strcmp(item->filename, id) ||
                    (!strncmp(item->filename, id, id_length) && item->filename[id_length] == '.')) {
                    found = n;
                    break;
                }
            }
            if (found == items->len) { reason = "image not found"; goto finished; }
            struct emoji_item *item = g_ptr_array_steal_index(items, found);
            if (command == 8) {
                removed_path = g_build_filename(directory, item->filename, NULL);
                emoji_free(item);
            } else if (direction == 1) g_ptr_array_add(items, item);
            else g_ptr_array_insert(items, 0, item);
        }
    }
    result = emoji_write(config, items);
    if (result) reason = "cannot write Emotion.ini";
    if (!result && command == 8 && unlink(removed_path) && errno != ENOENT) {
        result = -1;
        reason = "cannot remove image";
    }
finished:
    if (result && command == 6 && removed_path) unlink(removed_path);
    g_free(removed_path);
    if (items) g_ptr_array_unref(items);
    g_free(config);
    struct json_object *param = reason_param(result ? reason : "success");
    if (!result && command == 6) {
        struct json_object *body = json_object_new_object();
        json_object_object_add(body, "objectId", json_object_new_string(string_value(request->param, "guid")));
        json_object_object_add(body, "state", json_object_new_string("0"));
        json_object_object_add(body, "indexNo", json_object_new_int64(new_index));
        json_object_object_add(param, "recv_body", body);
    }
    respond(request, result ? 1 : 0, param);
}

struct screenshot_request {
    GMainLoop *loop;
    char *handle;
    char *uri;
    guint response;
    gboolean received;
};
static void screenshot_response(GDBusConnection *connection, const gchar *sender,
                                const gchar *path, const gchar *interface,
                                const gchar *signal, GVariant *parameters, gpointer data)
{
    (void)connection; (void)sender; (void)interface; (void)signal;
    struct screenshot_request *request = data;
    if (!request->handle || strcmp(request->handle, path)) return;
    GVariant *results;
    g_variant_get(parameters, "(u@a{sv})", &request->response, &results);
    g_variant_lookup(results, "uri", "s", &request->uri);
    g_variant_unref(results);
    request->received = TRUE;
    g_main_loop_quit(request->loop);
}
static gboolean screenshot_timeout(gpointer data)
{
    g_main_loop_quit(((struct screenshot_request *)data)->loop);
    return G_SOURCE_REMOVE;
}
static gboolean screenshot_cancelled(GCancellable *cancelled, gpointer data)
{
    (void)cancelled;
    return screenshot_timeout(data);
}
static void screenshot(struct native_request *request)
{
    GMainContext *context = g_main_context_new();
    g_main_context_push_thread_default(context);
    struct screenshot_request shot = { .loop = g_main_loop_new(context, FALSE), .response = 2 };
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, cancellation, NULL);
    guint subscription = 0;
    GSource *cancel_source = NULL;
    GSource *timer = NULL;
    gboolean started = FALSE;
    int result = 1, exit_code = 0;
    if (!bus || is_cancelled()) goto finished;
    const char *sender = g_dbus_connection_get_unique_name(bus);
    if (!sender || sender[0] != ':') goto finished;
    static guint64 sequence;
    char token[64];
    g_snprintf(token, sizeof token, "welink_tools_%" G_GUINT64_FORMAT "_%" G_GUINT64_FORMAT,
               startup_epoch, ++sequence);
    /* Know the request path before calling Screenshot so cancellation of the
     * method reply can still close the actual portal dialog. */
    shot.handle = g_strdup_printf("/org/freedesktop/portal/desktop/request/%s/%s", sender + 1, token);
    g_strdelimit(shot.handle, ".", '_');
    subscription = g_dbus_connection_signal_subscribe(bus, "org.freedesktop.portal.Desktop",
        "org.freedesktop.portal.Request", "Response", NULL, NULL, G_DBUS_SIGNAL_FLAGS_NONE,
        screenshot_response, &shot, NULL);
    GVariantBuilder options;
    g_variant_builder_init(&options, G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&options, "{sv}", "interactive", g_variant_new_boolean(TRUE));
    g_variant_builder_add(&options, "{sv}", "handle_token", g_variant_new_string(token));
    GVariant *response = g_dbus_connection_call_sync(bus, "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop", "org.freedesktop.portal.Screenshot", "Screenshot",
        g_variant_new("(sa{sv})", "", &options), G_VARIANT_TYPE("(o)"), G_DBUS_CALL_FLAGS_NONE,
        10000, cancellation, NULL);
    if (!response) goto finished;
    const char *handle;
    g_variant_get(response, "(&o)", &handle);
    if (strcmp(shot.handle, handle)) {
        g_free(shot.handle);
        shot.handle = g_strdup(handle);
    }
    g_variant_unref(response);
    started = TRUE;
    timer = g_timeout_source_new_seconds(120);
    g_source_set_callback(timer, screenshot_timeout, &shot, NULL);
    g_source_attach(timer, context);
    cancel_source = g_cancellable_source_new(cancellation);
    g_source_set_callback(cancel_source, G_SOURCE_FUNC(screenshot_cancelled), &shot, NULL);
    g_source_attach(cancel_source, context);
    /* A cancelled source wakes this private context even when shutdown races
     * with entering the loop; never wait for a portal Response to cancel. */
    if (!is_cancelled()) g_main_loop_run(shot.loop);
    if (is_cancelled() || !shot.received) goto finished;
    if (shot.response == 1) {
        result = 0; /* User cancellation: not a captured image. */
    } else if (shot.response == 0 && shot.uri) {
        char *path = g_filename_from_uri(shot.uri, NULL, NULL);
        GdkPixbuf *image = path ? gdk_pixbuf_new_from_file(path, NULL) : NULL;
        if (image) {
            if (!clipboard_publish(image)) { result = 0; exit_code = 12; }
            g_object_unref(image);
        }
        g_free(path);
    }
finished:
    if (cancel_source) { g_source_destroy(cancel_source); g_source_unref(cancel_source); }
    if (timer) { g_source_destroy(timer); g_source_unref(timer); }
    if (subscription) g_dbus_connection_signal_unsubscribe(bus, subscription);
    if (bus && shot.handle && !shot.received) {
        /* Cleanup belongs to this worker, not Shutdown. Do not pass the
         * cancelled token to Close, and bound the wait for the portal. */
        GVariant *closed = g_dbus_connection_call_sync(bus, "org.freedesktop.portal.Desktop", shot.handle,
            "org.freedesktop.portal.Request", "Close", NULL, NULL, G_DBUS_CALL_FLAGS_NONE,
            5000, NULL, NULL);
        if (closed) g_variant_unref(closed);
    }
    if (bus) g_object_unref(bus);
    g_main_loop_unref(shot.loop);
    g_free(shot.handle);
    g_free(shot.uri);
    g_main_context_pop_thread_default(context);
    g_main_context_unref(context);
    if (!started) {
        struct json_object *param = reason_param("interactive screenshot portal unavailable");
        json_object_object_add(param, "exitCode", json_object_new_int(exit_code));
        respond(request, 1, param);
        return;
    }
    struct json_object *notification = json_object_new_object();
    struct json_object *param = json_object_new_object();
    json_object_object_add(notification, "notify", json_object_new_int(1));
    json_object_object_add(notification, "description", json_object_new_string("ScreenCatchNotify"));
    json_object_object_add(notification, "result", json_object_new_int(result));
    json_object_object_add(param, "exitCode", json_object_new_int(exit_code));
    respond(request, result, json_object_get(param));
    json_object_object_add(notification, "param", param);
    struct json_object *extra = native_get(request->param, "extParam");
    if (extra) json_object_object_add(notification, "extParam", json_object_get(extra));
    im_dispatch_json(&callbacks, startup_epoch, notification, 0);
}

static gpointer run_tools(gpointer unused)
{
    (void)unused;
    for (;;) {
        gpointer pointer = g_async_queue_pop(jobs);
        if (pointer == &stop_job) break;
        struct tools_job *job = pointer;
        struct native_request *request = &job->request;
        if (!is_cancelled()) switch (request->cmd) {
        case 1: case 2: case 3: zip_command(request); break;
        case 4: case 5: case 11: case 16: clipboard_command(request); break;
        case 6: case 7: case 8: case 9: case 10: emoji_command(request); break;
        case 12: respond(request, thumbnail(request->param) ? 1 : 0, NULL); break;
        case 13: screenshot(request); break;
        case 17: respond(request, create_zip(request->param) ? 1 : 0, NULL); break;
        case 18: respond(request, copy_file(string_value(request->param, "src_path"),
                                           string_value(request->param, "dest_path")) ? 1 : 0, NULL); break;
        default: respond(request, 1, reason_param("unsupported native-tools command")); break;
        }
        native_release(request);
        g_free(job);
    }
    gpointer pointer;
    while ((pointer = g_async_queue_try_pop(jobs))) {
        struct tools_job *job = pointer;
        native_release(&job->request);
        g_free(job);
    }
    while (zip_readers) zip_close(&zip_readers);
    g_mutex_lock(&lifecycle);
    g_async_queue_unref(jobs);
    g_object_unref(cancellation);
    g_thread_unref(worker);
    jobs = NULL;
    cancellation = NULL;
    worker = NULL;
    reply_callback = NULL;
    g_mutex_unlock(&lifecycle);
    return NULL;
}

struct tools_dispatch_context {
    native_callback callback;
    guint64 epoch;
};

static int dispatch_response(const char *text, int tag, gpointer data)
{
    (void)tag;
    const struct tools_dispatch_context *context = data;
    g_mutex_lock(&lifecycle);
    gboolean current = !stopping && startup_epoch == context->epoch;
    g_mutex_unlock(&lifecycle);
    if (!current || !context->callback) return 0;
    context->callback(text);
    return 1;
}

IM_SDK_EXPORT int NativeToolsDispatchCallbacks(void)
{
    g_mutex_lock(&lifecycle);
    struct tools_dispatch_context context = { reply_callback, startup_epoch };
    g_mutex_unlock(&lifecycle);
    return im_dispatch_run(&callbacks, dispatch_response, &context);
}

IM_SDK_EXPORT int NativeToolsInitService(const char *log_path, native_callback callback)
{
    (void)log_path;
    if (!callback) return 1;
    g_mutex_lock(&lifecycle);
    if (worker) { g_mutex_unlock(&lifecycle); return 1; }
    startup_epoch = im_dispatch_start(&callbacks);
    if (!startup_epoch) { g_mutex_unlock(&lifecycle); return 1; }
    jobs = g_async_queue_new();
    cancellation = g_cancellable_new();
    stopping = FALSE;
    reply_callback = callback;
    worker = g_thread_try_new("welink-tools", run_tools, NULL, NULL);
    if (!worker) {
        im_dispatch_stop(&callbacks);
        stopping = TRUE;
        g_async_queue_unref(jobs);
        g_object_unref(cancellation);
        jobs = NULL;
        cancellation = NULL;
        reply_callback = NULL;
    }
    int result = worker ? 0 : 1;
    g_mutex_unlock(&lifecycle);
    return result;
}

IM_SDK_EXPORT void NativeToolsSendMsg(const char *text)
{
    struct tools_job *job = g_try_new0(struct tools_job, 1);
    if (!job) return;
    if (native_parse(&job->request, text)) { g_free(job); return; }
    g_mutex_lock(&lifecycle);
    if (worker && !stopping) {
        g_async_queue_push(jobs, job);
        job = NULL;
    }
    g_mutex_unlock(&lifecycle);
    if (job) { native_release(&job->request); g_free(job); }
}

IM_SDK_EXPORT void NativeToolsShutdown(void)
{
    g_mutex_lock(&lifecycle);
    if (!worker || stopping) { g_mutex_unlock(&lifecycle); return; }
    stopping = TRUE;
    im_dispatch_stop(&callbacks);
    reply_callback = NULL;
    GCancellable *cancel = g_object_ref(cancellation);
    GAsyncQueue *queue = g_async_queue_ref(jobs);
    g_mutex_unlock(&lifecycle);
    /* Cancellation handlers run outside the lifecycle lock. Only the worker
     * releases desktop state, service objects and its thread. */
    g_cancellable_cancel(cancel);
    g_async_queue_push_front(queue, &stop_job);
    g_object_unref(cancel);
    g_async_queue_unref(queue);
}
