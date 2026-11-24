/* Human-readable and image export rules recovered from PE 1004e9d0,
 * 100516a0,100537c0,10055540,100567e0,100572a0,10057b90 and 10085670.
 * DISPLAY text has a documented vendor fallback to SHOWTEXT on unsupported
 * XML/compression; database backups never pass through this lossy rendering.
 */
#define _GNU_SOURCE
#include "ie_internal.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <openssl/crypto.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <zlib.h>

static struct json_object *parse_json(const char *text)
{
    size_t length = strlen(text);
    if (length > IE_MAX_VALUE) return NULL;
    struct json_tokener *tokener = json_tokener_new_ex(32);
    if (!tokener) return NULL;
    json_tokener_set_flags(tokener, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *object = json_tokener_parse_ex(tokener, text, (int)length + 1);
    if (json_tokener_get_error(tokener) != json_tokener_success) { json_object_put(object); object = NULL; }
    json_tokener_free(tokener); return object;
}
static char *decode_content(const char *text)
{
    /* PE 10085670: Base64 then gzip; a decoded non-gzip value retains the input. */
    gsize length = 0;
    guchar *binary = g_base64_decode(text, &length);
    if (!binary || length < 2 || binary[0] != 0x1f || binary[1] != 0x8b) { g_free(binary); return g_strdup(text); }
    z_stream stream = { .next_in = binary, .avail_in = (uInt)length };
    if (length > UINT_MAX || inflateInit2(&stream, 15 + 16) != Z_OK) { g_free(binary); return NULL; }
    GString *output = g_string_sized_new(1024); char buffer[8192]; int rc;
    do {
        stream.next_out = (Bytef *)buffer; stream.avail_out = sizeof buffer;
        rc = inflate(&stream, Z_NO_FLUSH);
        size_t used = sizeof buffer - stream.avail_out;
        if (used > IE_MAX_VALUE - output->len || memchr(buffer, 0, used)) { rc = Z_DATA_ERROR; break; }
        g_string_append_len(output, buffer, (gssize)used);
    } while (rc == Z_OK);
    int complete = rc == Z_STREAM_END && stream.avail_in == 0;
    inflateEnd(&stream); OPENSSL_cleanse(binary, length); g_free(binary);
    OPENSSL_cleanse(buffer, sizeof buffer);
    if (!complete || !g_utf8_validate(output->str, (gssize)output->len, NULL)) { g_string_free(output, TRUE); return NULL; }
    return g_string_free(output, FALSE);
}
static struct json_object *filelist(const char *text)
{
    char *decoded = strstr(text, "file_name") ? g_strdup(text) : decode_content(text);
    if (!decoded) return NULL;
    struct json_object *object = parse_json(decoded); g_free(decoded); return object;
}
char *ie_import_filelist(const char *text)
{
    struct json_object *object = filelist(text);
    if (!object) return NULL;
    struct json_object *entry = object;
    if (json_object_is_type(object, json_type_array)) {
        if (json_object_array_length(object) != 1) { json_object_put(object); return NULL; }
        entry = json_object_array_get_idx(object, 0);
    }
    struct json_object *expire = NULL;
    char *result = NULL;
    if (json_object_is_type(entry, json_type_object) &&
        (!json_object_object_get_ex(entry, "expire", &expire) || !json_object_is_type(expire, json_type_string) || *json_object_get_string(expire))) {
        json_object_object_add(entry, "expire", json_object_new_string(""));
        if (entry == object) {
            struct json_object *array = json_object_new_array();
            json_object_array_add(array, json_object_get(entry));
            result = g_strdup(json_object_to_json_string_ext(array, JSON_C_TO_STRING_PLAIN));
            json_object_put(array);
        } else result = g_strdup(json_object_to_json_string_ext(object, JSON_C_TO_STRING_PLAIN));
    }
    json_object_put(object); return result;
}
struct xml_extract { const char *wanted; GString *path, *text; size_t lengths[32]; unsigned depth; int capturing, found; };
static void xml_start(GMarkupParseContext *context, const gchar *name, const gchar **names,
                      const gchar **values, gpointer user, GError **error)
{
    (void)context; (void)names; (void)values;
    struct xml_extract *state = user;
    if (state->depth >= G_N_ELEMENTS(state->lengths)) { g_set_error_literal(error, G_MARKUP_ERROR, G_MARKUP_ERROR_INVALID_CONTENT, "XML depth"); return; }
    state->lengths[state->depth++] = state->path->len;
    if (state->path->len) g_string_append_c(state->path, '.');
    g_string_append(state->path, name);
    if (!strcmp(state->path->str, state->wanted)) { state->capturing = (int)state->depth; state->found = 1; }
}
static void xml_end(GMarkupParseContext *context, const gchar *name, gpointer user, GError **error)
{
    (void)context; (void)name; (void)error;
    struct xml_extract *state = user;
    if (state->capturing == (int)state->depth) state->capturing = 0;
    if (state->depth) g_string_truncate(state->path, state->lengths[--state->depth]);
}
static void xml_text(GMarkupParseContext *context, const gchar *text, gsize length, gpointer user, GError **error)
{
    (void)context;
    struct xml_extract *state = user;
    if (state->capturing) {
        if (length > IE_MAX_VALUE - state->text->len) { g_set_error_literal(error, G_MARKUP_ERROR, G_MARKUP_ERROR_INVALID_CONTENT, "XML size"); return; }
        g_string_append_len(state->text, text, (gssize)length);
    }
}
static char *extract_xml(const char *xml, const char *path)
{
    struct xml_extract state = { .wanted = path, .path = g_string_new(NULL), .text = g_string_new(NULL) };
    GMarkupParser parser = { .start_element = xml_start, .end_element = xml_end, .text = xml_text };
    GMarkupParseContext *context = g_markup_parse_context_new(&parser, G_MARKUP_TREAT_CDATA_AS_TEXT, &state, NULL);
    GError *error = NULL;
    int ok = g_markup_parse_context_parse(context, xml, -1, &error) && g_markup_parse_context_end_parse(context, &error) && state.found;
    g_markup_parse_context_free(context); g_clear_error(&error); g_string_free(state.path, TRUE);
    return g_string_free(state.text, !ok);
}
static char *message_content(const char *xml)
{
    char *gzip = extract_xml(xml, "r.g"), *body = extract_xml(xml, "r.c");
    if (!gzip || !body) { g_free(gzip); g_free(body); return NULL; }
    if (!strcmp(gzip, "1")) { char *decoded = decode_content(body); g_free(body); body = decoded; }
    g_free(gzip);
    char *text = body ? extract_xml(body, "imbody.content") : NULL;
    g_free(body); return text;
}
static char *replace_all(const char *text, const char *needle, const char *replacement)
{
    if (!*needle) return g_strdup(text);
    GString *out = g_string_sized_new(strlen(text)); size_t length = strlen(needle);
    const char *match;
    while ((match = strstr(text, needle))) {
        if (out->len + (size_t)(match - text) + strlen(replacement) > IE_MAX_VALUE) { g_string_free(out, TRUE); return NULL; }
        g_string_append_len(out, text, match - text); g_string_append(out, replacement); text = match + length;
    }
    g_string_append(out, text); return g_string_free(out, FALSE);
}
static char *replace_images(const char *text, const char *label)
{
    GString *out = g_string_new(NULL);
    const char *cursor = text, *start;
    while ((start = strstr(cursor, "/:um_begin{https://"))) {
        const char *end = strstr(start, "}/:um_end");
        if (!end) break;
        g_string_append_len(out, cursor, start - cursor); g_string_append_printf(out, "[%s]", label);
        cursor = end + strlen("}/:um_end");
    }
    g_string_append(out, cursor); return g_string_free(out, FALSE);
}
static char *replace_emoji(struct ie_job *job, const char *text)
{
    char *result = replace_all(text, "\xE2\x81\xA0", "\x1e");
    struct json_object *emoji = NULL;
    if (!json_object_object_get_ex(job->request, "emojiData", &emoji) || !json_object_is_type(emoji, json_type_array)) return result;
    size_t count = json_object_array_length(emoji);
    for (size_t i = 0; result && i < count; ++i) {
        struct json_object *entry = json_object_array_get_idx(emoji, i);
        const char *character = ie_string(entry, "character"), *language = ie_string(entry, "language");
        if (!*character) continue;
        char *a = replace_all(character, "\xE2\x81\xA0", "\x1e");
        char *b = a ? replace_all(a, "/;&gt;", "/;>") : NULL;
        char *needle = b ? replace_all(b, "/:&lt;", "/:<") : NULL;
        char *label = g_strdup_printf("[%s]", language);
        char *next = needle ? replace_all(result, needle, label) : NULL;
        g_free(a); g_free(b); g_free(needle); g_free(label); g_free(result); result = next;
    }
    return result;
}
static char *display_body(struct ie_job *job, sqlite3_stmt *row)
{
    int column = ie_column(row, "MEDIATYPE"), media = column < 0 ? 0 : sqlite3_column_int(row, column);
    const char *image = job->english ? "Image" : "图片";
    const char *video = job->english ? "Video" : "视频";
    const char *file = job->english ? "File" : "文件";
    const char *label = media == 1 ? (job->english ? "Voice" : "语音") :
        media == 2 ? video : media == 3 ? image : media == 4 ? file :
        media == 7 ? (job->english ? "Link" : "链接") : NULL;
    if (label) return g_strdup_printf("[%s]", label);
    const char *shown = ie_column_text(row, "SHOWTEXT");
    if (media == 10 && *ie_column_text(row, "FILELIST") && !*shown)
        return g_strdup_printf("[%s][%s]", job->english ? "Cardshare message" : "卡片消息", image);
    char *content = message_content(ie_column_text(row, "CONTENT"));
    if (!content) return g_strdup(shown);
    char *rendered = NULL;
    if (media == 8) {
        if (strstr(content, "/:um_begin")) {
            char *pictures = replace_images(content, image);
            rendered = replace_emoji(job, pictures); g_free(pictures);
        }
    } else if (media == 10) {
        struct json_object *object = parse_json(content), *card = NULL, *reply = NULL, *kind = NULL;
        if (json_object_is_type(object, json_type_object) && json_object_object_get_ex(object, "cardContext", &card) &&
            json_object_is_type(card, json_type_object) && json_object_object_get_ex(card, "replyMsg", &reply) &&
            json_object_is_type(reply, json_type_object)) {
            const char *reply_text = ie_string(reply, "content");
            int type = json_object_object_get_ex(reply, "type", &kind) ? json_object_get_int(kind) : -1;
            char *pictures = replace_images(reply_text, type == 2 ? video : type == 4 ? file : image);
            char *emojis = replace_emoji(job, pictures);
            if (emojis) rendered = g_strdup_printf("[%s]%s", job->english ? "Cardshare message" : "卡片消息",
                strcmp(reply_text, emojis) ? emojis : shown);
            g_free(pictures); g_free(emojis);
        }
        json_object_put(object);
    } else if (strstr(content, "\xE2\x81\xA0")) rendered = replace_emoji(job, content);
    g_free(content); return rendered ? rendered : g_strdup(shown);
}
static char *safe_name(const char *name)
{
    if (!g_utf8_validate(name, -1, NULL)) return NULL;
    GString *out = g_string_sized_new(MIN(strlen(name), 180));
    for (const char *p = name; *p && out->len < 180;) {
        const char *next = g_utf8_next_char(p);
        if ((unsigned char)*p < 32 || strchr("<>:\"/\\|?*", *p)) g_string_append_c(out, '_');
        else if (out->len + (size_t)(next - p) <= 180) g_string_append_len(out, p, next - p);
        else break;
        p = next;
    }
    while (out->len && (out->str[out->len - 1] == '.' || out->str[out->len - 1] == ' ')) g_string_truncate(out, out->len - 1);
    return g_string_free(out, FALSE);
}
static int contact_open(struct ie_job *job)
{
    if (job->contact_checked) return 0;
    job->contact_checked = 1;
    int appdata = ie_open_subdir(job->desktop_fd, "appdata", 0);
    int root = appdata < 0 ? -1 : ie_open_subdir(appdata, "contact", 0);
    if (appdata >= 0) close(appdata);
    if (root < 0) return errno == ENOENT ? 0 : ie_fail(job, 12, "contact directory unavailable");
    int directory = ie_open_subdir(root, job->account, 0);
    if (directory < 0) {
        int error = errno; close(root);
        return error == ENOENT ? 0 : ie_fail(job, 12, "contact directory unavailable");
    }
    struct stat info;
    int error = fstatat(directory, "user.db", &info, AT_SYMLINK_NOFOLLOW) ? errno : 0;
    if (error == ENOENT) { close(directory); close(root); return 0; }
    struct native_storage_key key = {0};
    char *metadata = ie_fd_path(directory, "config.db"), *kmc = ie_fd_path(root, "");
    if (!error) error = native_storage_load_key(metadata, kmc, NULL, 0, &key);
    if (!error) error = ie_open_database(job, directory, "user.db", key.password, 0, 0, &job->contact_db);
    native_storage_clear_key(&key); g_free(metadata); g_free(kmc);
    if (error) close(directory); else job->contact_fd = directory;
    close(root);
    return error ? ie_fail(job, 12, "openContactUserDb failed") : 0;
}

static char *conversation_name(struct ie_job *job, sqlite3_stmt *row, const char **category)
{
    const char *id = ie_column_text(row, "CONVERSATION_ID"), *group_id = ie_column_text(row, "GROUPID");
    char *display = NULL; int temporary = 0, left = 0;
    if (*group_id) {
        if (job->user_db) {
            sqlite3_stmt *query = NULL;
            if (!sqlite3_prepare_v2(job->user_db, "SELECT GROUPTYPE,EXPARAMS,NAME FROM GroupTab WHERE GROUPID=?1", -1, &query, NULL)) {
                sqlite3_bind_text(query, 1, group_id, -1, SQLITE_STATIC);
                if (sqlite3_step(query) == SQLITE_ROW) {
                    temporary = sqlite3_column_int(query, 0) != 0;
                    const char *extra = (const char *)sqlite3_column_text(query, 1);
                    struct json_object *object = parse_json(extra ?: ""), *state = NULL;
                    if (json_object_is_type(object, json_type_object) && json_object_object_get_ex(object, "groupState", &state) &&
                        json_object_is_type(state, json_type_string)) left = !strcmp(json_object_get_string(state), "1");
                    json_object_put(object); display = g_strdup((const char *)sqlite3_column_text(query, 2));
                }
            }
            sqlite3_finalize(query);
        }
        if (!display || !*display) { g_free(display); display = g_strdup(ie_column_text(row, "GROUPNAME")); }
        *category = temporary ? (job->english ? "Temporary Groups" : "讨论组") : (job->english ? "Groups" : "固定群");
    } else {
        *category = job->english ? "Contacts" : "联系人";
        if (contact_open(job)) return NULL;
        sqlite3_stmt *query = NULL;
        if (job->contact_db && !sqlite3_prepare_v2(job->contact_db,
            "SELECT NAME,FOREIGNNAME FROM ContactTab WHERE ACCOUNT=?1", -1, &query, NULL)) {
            sqlite3_bind_text(query, 1, id, -1, SQLITE_STATIC);
            if (sqlite3_step(query) == SQLITE_ROW) display = g_strdup((const char *)sqlite3_column_text(query, job->english ? 1 : 0));
        }
        sqlite3_finalize(query);
    }
    /* Contact lookup is optional in the vendor too: an absent directory/name
     * produces the conversation account alone, not an invented display name. */
    char *clean_id = safe_name(id), *clean_display = safe_name(display ?: "");
    if (!clean_id || !clean_display) { g_free(clean_id); g_free(clean_display); g_free(display); return NULL; }
    char *name = *clean_display ? g_strdup_printf("%s%s(%s)", left ? (job->english ? "[Left]" : "[已退出]") : "", clean_display, clean_id) : g_strdup(clean_id);
    g_free(clean_id); g_free(clean_display); g_free(display);
    if (!ie_component(name)) { g_free(name); return NULL; }
    return name;
}
static int destination(struct ie_job *job, sqlite3_stmt *row, int output, int picture, char **filename)
{
    const char *category;
    char *name = conversation_name(job, row, &category);
    if (!name) { errno = EINVAL; return -1; }
    int directory = *job->conversation ? fcntl(output, F_DUPFD_CLOEXEC, 3) : ie_open_subdir(output, category, 1);
    if (directory < 0) { g_free(name); return -1; }
    if (picture) {
        int child = ie_open_subdir(directory, name, 1); close(directory); g_free(name); return child;
    }
    *filename = g_strconcat(name, ".txt", NULL); g_free(name);
    return directory;
}
int ie_render_row(struct ie_job *job, sqlite3_stmt *row, int output)
{
    char *name = NULL;
    int directory = destination(job, row, output, 0, &name);
    if (directory < 0) return ie_fail(job, 14, "create file failed");
    int fd = openat(directory, name, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    g_free(name); close(directory);
    if (fd < 0) return ie_fail(job, 14, "create file failed");
    const char *sender = ie_column_text(row, job->english ? "PEERNATIVENAME" : "PEERNAME");
    const char *origin = ie_column_text(row, "ORIGINACCOUNT");
    const char *stamp = ie_column_text(row, "UTCSTAMP");
    char seconds[11] = {0}; memcpy(seconds, stamp, MIN(strlen(stamp), (size_t)10));
    time_t time_value = (time_t)g_ascii_strtoll(seconds, NULL, 10) + 28800;
    struct tm calendar; char date[32] = "", clock[32] = "";
    if (gmtime_r(&time_value, &calendar)) {
        strftime(date, sizeof date, "%Y-%m-%d", &calendar); strftime(clock, sizeof clock, "%H:%M:%S", &calendar);
    }
    char *body = display_body(job, row);
    char *text = g_strdup_printf("%s(%s)\t%s %s\r\n%s\r\n", sender, origin, date, clock, body);
    size_t length = strlen(text), offset = 0; int error = 0;
    while (offset < length && !error) {
        if (ie_cancelled(job)) { error = ECANCELED; break; }
        ssize_t n = write(fd, text + offset, MIN(length - offset, IE_CHUNK));
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) error = n < 0 ? errno : EIO; else offset += (size_t)n;
    }
    if (!error && fsync(fd)) error = errno;
    if (close(fd) && !error) error = errno;
    OPENSSL_cleanse(text, length); g_free(text); OPENSSL_cleanse(body, strlen(body)); g_free(body);
    return error ? ie_fail(job, error == ENOSPC ? 27 : 14, "text export write failed") : 0;
}
int ie_picture_row(struct ie_job *job, sqlite3_stmt *row, int output, int grouped)
{
    int column = ie_column(row, "MEDIATYPE"), media = column < 0 ? 0 : sqlite3_column_int(row, column);
    if (media != 3 && media != 8) return 0;
    if (ie_prepare_receive(job)) {
        if (errno == ENOENT) return 0; /* The vendor omits pictures not cached locally. */
        return ie_fail(job, 1, "image source unavailable");
    }
    const char *shown = ie_column_text(row, "SHOWTEXT");
    struct json_object *object = NULL, *entry = NULL;
    const char *name = NULL;
    if (media == 3 && strchr(shown, '.')) name = shown;
    else {
        object = filelist(ie_column_text(row, "FILELIST")); entry = object;
        if (json_object_is_type(object, json_type_array)) {
            if (json_object_array_length(object) == 1) entry = json_object_array_get_idx(object, 0);
            else entry = NULL;
        }
        name = ie_string(entry, "file_name");
    }
    if (!name || !*name) { json_object_put(object); return 0; }
    if (!ie_component(name)) { json_object_put(object); return ie_fail(job, 1, "unsafe image filename"); }
    int target = grouped ? destination(job, row, output, 1, NULL) : fcntl(output, F_DUPFD_CLOEXEC, 3);
    int error = target < 0 ? errno : 0;
    const char *folders[] = { "originalImgfiles", "ScreenShot" };
    for (unsigned i = 0; !error && i < G_N_ELEMENTS(folders); ++i) {
        int source = ie_open_subdir(job->receive_fd, folders[i], 0);
        if (source < 0) { if (errno != ENOENT) error = errno; continue; }
        struct stat info;
        if (fstatat(source, name, &info, AT_SYMLINK_NOFOLLOW)) { if (errno != ENOENT) error = errno; close(source); continue; }
        int folder = grouped ? fcntl(target, F_DUPFD_CLOEXEC, 3) : ie_open_subdir(target, folders[i], 1);
        error = folder < 0 ? errno : ie_copy_file(job, source, name, folder, name, 0, NULL);
        if (folder >= 0) close(folder); close(source);
        if (grouped) break; /* Image-only prefers original, then screenshot. */
    }
    if (target >= 0) close(target); json_object_put(object);
    return error ? ie_fail(job, error == ENOSPC ? 27 : 1, "image copy failed") : 0;
}
struct published_file { char *folder, *name; dev_t device; ino_t inode; };
static void published_free(gpointer pointer)
{
    struct published_file *file = pointer; g_free(file->folder); g_free(file->name); g_free(file);
}
int ie_import_pictures(struct ie_job *job, int source)
{
    if (ie_prepare_receive(job)) return ie_fail(job, 1, "image destination unavailable");
    if (!job->published_files) job->published_files = g_ptr_array_new_with_free_func(published_free);
    const char *folders[] = { "originalImgfiles", "ScreenShot" };
    int stage = ie_open_subdir(job->stage_fd, "media", 1);
    if (stage < 0) return ie_fail(job, 1, "image staging failed");
    int error = 0;
    unsigned members = 0;
    for (unsigned i = 0; !error && i < G_N_ELEMENTS(folders); ++i) {
        int from = ie_open_subdir(source, folders[i], 0);
        if (from < 0) { if (errno != ENOENT) error = errno; continue; }
        int staged = ie_open_subdir(stage, folders[i], 1);
        int target = ie_open_subdir(job->receive_fd, folders[i], 1);
        int duplicate = openat(from, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        DIR *directory = duplicate < 0 ? NULL : fdopendir(duplicate);
        if (staged < 0 || target < 0 || !directory) error = errno;
        if (!directory && duplicate >= 0) close(duplicate);
        struct dirent *entry;
        while (!error && (entry = readdir(directory))) {
            if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
            if (ie_cancelled(job) || ++members > IE_MAX_MEMBERS) { error = ECANCELED; break; }
            error = ie_copy_file(job, from, entry->d_name, staged, entry->d_name, 0, NULL);
            if (error) break;
            struct stat created;
            if (fstatat(staged, entry->d_name, &created, AT_SYMLINK_NOFOLLOW)) { error = errno; break; }
            if (linkat(staged, entry->d_name, target, entry->d_name, 0)) {
                if (errno == EEXIST || errno == EXDEV)
                    error = ie_copy_file(job, staged, entry->d_name, target, entry->d_name, 0, &created);
                else error = errno;
            }
            if (!error && created.st_mode) {
                struct published_file *file = g_new0(struct published_file, 1);
                file->folder = g_strdup(folders[i]); file->name = g_strdup(entry->d_name);
                file->device = created.st_dev; file->inode = created.st_ino; g_ptr_array_add(job->published_files, file);
            }
        }
        if (directory) closedir(directory);
        if (!error && fsync(target)) error = errno;
        if (target >= 0) close(target); if (staged >= 0) close(staged); close(from);
    }
    close(stage);
    return error ? ie_fail(job, error == ENOSPC ? 27 : 1, "image import failed") : 0;
}
void ie_rollback_pictures(struct ie_job *job)
{
    for (unsigned i = 0; job->published_files && i < job->published_files->len; ++i) {
        struct published_file *file = g_ptr_array_index(job->published_files, i);
        int parent = ie_open_subdir(job->receive_fd, file->folder, 0);
        struct stat info;
        if (parent < 0) { ie_fail(job, 1, "image rollback failed"); continue; }
        if (fstatat(parent, file->name, &info, AT_SYMLINK_NOFOLLOW)) {
            if (errno != ENOENT) ie_fail(job, 1, "image rollback failed");
        } else if (info.st_dev == file->device && info.st_ino == file->inode) {
            if (unlinkat(parent, file->name, 0)) ie_fail(job, 1, "image rollback failed");
        } else ie_fail(job, 1, "image changed during rollback");
        if (fsync(parent)) ie_fail(job, 1, "image rollback sync failed");
        close(parent);
    }
}
