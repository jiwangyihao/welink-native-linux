/* Onebox transfer handles and asynchronous downloads. All session data used by
 * a transfer is owned until its worker exits; release cancels, never completes it.
 * Notifications retain the startup epoch and never call FFI from pool threads. */
struct onebox_transfer {
    gint references, cancelled, completed;
    GMutex finished_mutex;
    GCond finished;
    uint32_t handle;
    guint64 epoch;
    struct native_request request;
    struct json_object *configuration;
    struct ls_http_context http;
    char *token, *owner, *path, *url, *location;
    struct http_origin origin;
    struct http_response response;
    uint64_t expected, offset, last_now;
    gboolean range_valid, reset_output, convert_failed, upload, multipart, transferring;
    off_t restart_at;
    gboolean restart_pending, stored_restart, output_io_failed;
    int input;
    uint64_t remaining;
};
static GMutex transfer_mutex;
static GHashTable *transfers;
static GThreadPool *transfer_pool;
static uint32_t last_transfer_handle;

static void transfer_unref(gpointer opaque)
{
    struct onebox_transfer *transfer = opaque;
    if (!g_atomic_int_dec_and_test(&transfer->references)) return;
    g_cond_clear(&transfer->finished);
    g_mutex_clear(&transfer->finished_mutex);
    native_release(&transfer->request);
    json_object_put(transfer->configuration);
    ls_http_context_clear(&transfer->http);
    clear_secret(&transfer->token);
    clear_secret(&transfer->owner);
    clear_origin(&transfer->origin);
    g_free(transfer->path); g_free(transfer->url); g_free(transfer->location);
    g_string_free(transfer->response.body, TRUE);
    g_free(transfer);
}

static void transfer_emit(struct onebox_transfer *transfer, int event, const char *description,
                          struct json_object *param)
{
    if (g_atomic_int_get(&stopping) || g_atomic_int_get(&transfer->cancelled)) {
        json_object_put(param);
        return;
    }
    struct json_object *message = json_object_new_object();
    json_object_object_add(message, "notify", json_object_new_int(event));
    json_object_object_add(message, "description", json_object_new_string(description));
    json_object_object_add(message, "param", param);
    im_dispatch_json(&service_dispatch, transfer->epoch, message, 0);
}

static int transfer_progress(void *opaque, curl_off_t total, curl_off_t now,
                             curl_off_t upload_total, curl_off_t uploaded)
{
    struct onebox_transfer *transfer = opaque;
    if (g_atomic_int_get(&stopping) || g_atomic_int_get(&transfer->cancelled)) return 1;
    if (!transfer->transferring) return 0;
    if (transfer->upload) { total = upload_total; now = uploaded; }
    if (now <= 0 || total < 0) return 0;
    uint64_t current = (uint64_t)now + transfer->offset;
    uint64_t length = transfer->expected ? transfer->expected : (uint64_t)total + transfer->offset;
    if (current == transfer->last_now) return 0;
    transfer->last_now = current;
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "file_handle", json_object_new_uint64(transfer->handle));
    json_object_object_add(param, "total", json_object_new_uint64(length));
    json_object_object_add(param, "now", json_object_new_uint64(current));
    transfer_emit(transfer, 2, "OFFLINE_E_EVT_PROG_RESULT", param);
    return 0;
}

static struct json_object *transfer_json(const struct http_response *response)
{
    struct json_tokener *parser = json_tokener_new();
    if (!parser) return NULL;
    json_tokener_set_flags(parser, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *root = json_tokener_parse_ex(parser, response->body->str, response->body->len + 1);
    if (json_tokener_get_error(parser) != json_tokener_success) { json_object_put(root); root = NULL; }
    json_tokener_free(parser);
    return root;
}

static void transfer_retire(struct onebox_transfer *transfer)
{
    if (g_atomic_int_get(&transfer->completed)) return;
    g_mutex_lock(&transfer->finished_mutex);
    g_atomic_int_set(&transfer->completed, 1);
    g_cond_broadcast(&transfer->finished);
    g_mutex_unlock(&transfer->finished_mutex);
    g_mutex_lock(&transfer_mutex);
    g_hash_table_remove(transfers, GUINT_TO_POINTER(transfer->handle));
    g_mutex_unlock(&transfer_mutex);
}

static void transfer_complete(struct onebox_transfer *transfer, int result,
                              const char *id, const char *access, const char *url)
{
    transfer_retire(transfer);
    struct json_object *root = transfer_json(&transfer->response);
    struct json_object *param = json_object_new_object(), *file = json_object_new_object();
    json_object_object_add(param, "file_handle", json_object_new_uint64(transfer->handle));
    json_object_object_add(param, "code", json_object_new_int(result));
    json_object_object_add(file, "callback_type", json_object_new_int(transfer->upload ? 1 : 2));
    json_object_object_add(file, "file_id", json_object_new_string(id ? id : ""));
    json_object_object_add(file, "plain_access_code", json_object_new_string(access ? access : ""));
    json_object_object_add(file, "url", json_object_new_string(url ? url : ""));
    json_object_object_add(file, "handle", json_object_new_uint64(transfer->upload ? transfer->handle : 0));
    long status = transfer->response.status;
    if (status == 201 || status == 206) status = 200;
    json_object_object_add(file, "status_code", json_object_new_int64(status));
    json_object_object_add(file, "code_msg", json_object_new_string(text_value(root, "message")));
    json_object_object_add(file, "code_", json_object_new_string(text_value(root, "code")));
    json_object_object_add(param, "filersp", file);
    transfer_emit(transfer, 1, "OFFLINE_E_EVT_RSP_RESULT", param);
    json_object_put(root);
}

static int transfer_restart_output(struct onebox_transfer *transfer)
{
    if (!transfer->restart_pending) return 0;
    int file = transfer->response.file;
    if (ftruncate(file, transfer->restart_at) || lseek(file, transfer->restart_at, SEEK_SET) < 0) {
        transfer->output_io_failed = TRUE;
        return -1;
    }
    transfer->restart_pending = FALSE;
    transfer->stored_restart = transfer->reset_output;
    return 0;
}

static size_t transfer_header(char *bytes, size_t size, size_t count, void *opaque)
{
    struct onebox_transfer *transfer = opaque;
    size_t length = response_header(bytes, size, count, &transfer->response);
    if (!length) return 0;
    if (length >= 12 && !memcmp(bytes, "HTTP/", 5)) {
        transfer->range_valid = FALSE;
        transfer->reset_output = transfer->offset && transfer->response.status == 200;
    }
    if (length > 9 && !g_ascii_strncasecmp(bytes, "Location:", 9)) {
        const char *begin = bytes + 9, *end = bytes + length;
        while (begin < end && g_ascii_isspace(*begin)) ++begin;
        while (end > begin && g_ascii_isspace(end[-1])) --end;
        g_free(transfer->location);
        transfer->location = g_strndup(begin, end - begin);
    }
    if (length > 14 && length < 256 && !g_ascii_strncasecmp(bytes, "Content-Range:", 14)) {
        char header[256];
        memcpy(header, bytes + 14, length - 14); header[length - 14] = 0;
        uint64_t first, last, total;
        if (sscanf(header, " bytes %" SCNu64 "-%" SCNu64 "/%" SCNu64, &first, &last, &total) == 3)
            transfer->range_valid = first == transfer->offset && last >= first && last < total &&
                (!transfer->expected || total == transfer->expected);
    }
    if (length >= 23 && !g_ascii_strncasecmp(bytes, "x-convert-result:", 17)) {
        const char *value = bytes + 17;
        while (value < bytes + length && g_ascii_isspace(*value)) ++value;
        if (bytes + length - value >= 5 && !g_ascii_strncasecmp(value, "false", 5)) transfer->convert_failed = TRUE;
    }
    /* Do not discard a previous partial download merely because the next
     * candidate fails DNS or TLS. Restart only when a usable response arrives;
     * successful empty bodies still truncate at the end of their headers. */
    if (transfer->response.file >= 0 &&
        ((length == 2 && bytes[0] == '\r' && bytes[1] == '\n') || (length == 1 && bytes[0] == '\n')) &&
        (transfer->response.status == 200 || (transfer->response.status == 206 && transfer->range_valid)) &&
        transfer_restart_output(transfer)) return 0;
    return length;
}

static size_t transfer_write(char *bytes, size_t size, size_t count, void *opaque)
{
    struct onebox_transfer *transfer = opaque;
    struct http_response *response = &transfer->response;
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (response->file < 0 || (response->status != 200 && response->status != 206))
        return response_body(bytes, size, count, response);
    if (response->status == 206 && !transfer->range_valid) return 0;
    if (transfer_restart_output(transfer)) return 0;
    /* A 200 that ignores Range is staged after the original prefix. Do not
     * overwrite that prefix until routing has finished: the next attempt must
     * be able to restore the exact initial resume point. */
    if (transfer->reset_output) transfer->offset = 0;
    size_t offset = 0;
    while (offset < length) {
        ssize_t wrote = write(response->file, bytes + offset, length - offset);
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) { transfer->output_io_failed = TRUE; return 0; }
        offset += (size_t)wrote;
    }
    return length;
}

static CURLU *transfer_url(struct onebox_transfer *transfer, const char *url, gboolean *authenticated,
                           gboolean delegated, gboolean *trusted)
{
    struct http_origin origin;
    CURLU *parsed = parse_http_url(url, &origin);
    if (parsed) {
        *trusted = origin_authorized(&origin, &transfer->origin, transfer->configuration);
        if (*authenticated && !*trusted) {
            if (!delegated || g_ascii_strcasecmp(origin.scheme, "https")) {
                curl_url_cleanup(parsed); parsed = NULL;
            } else {
                /* A server-issued signed URL delegates access to its resource,
                 * never our Onebox token or client TLS identity. */
                *authenticated = FALSE;
            }
        }
    }
    clear_origin(&origin);
    return parsed;
}

static size_t transfer_read(char *bytes, size_t size, size_t count, void *opaque)
{
    struct onebox_transfer *transfer = opaque;
    if (size && count > SIZE_MAX / size) return CURL_READFUNC_ABORT;
    if (g_atomic_int_get(&stopping) || g_atomic_int_get(&transfer->cancelled)) return CURL_READFUNC_ABORT;
    size_t length = MIN((uint64_t)(size * count), transfer->remaining);
    if (!length) return 0;
    ssize_t got;
    do got = read(transfer->input, bytes, length); while (got < 0 && errno == EINTR);
    if (got < 0) return CURL_READFUNC_ABORT;
    transfer->remaining -= (size_t)got;
    return (size_t)got;
}

struct transfer_request {
    struct onebox_request request;
    struct onebox_transfer *transfer;
    off_t input_offset;
    uint64_t offset, remaining;
};

static int transfer_cancelled(void *opaque)
{
    struct onebox_transfer *transfer = opaque;
    return service_cancelled(NULL) || g_atomic_int_get(&transfer->cancelled);
}

static CURLcode transfer_prepare(CURL *curl, unsigned attempt, const char *url, void *opaque)
{
    struct transfer_request *request = opaque;
    struct onebox_transfer *transfer = request->transfer;
    transfer->offset = request->offset;
    transfer->remaining = request->remaining;
    transfer->last_now = UINT64_MAX;
    transfer->range_valid = transfer->reset_output = transfer->convert_failed = FALSE;
    g_clear_pointer(&transfer->location, g_free);
    transfer->restart_at = request->request.initial_offset;
    transfer->restart_pending = transfer->response.file >= 0;
    CURLcode result = onebox_prepare(curl, attempt, url, &request->request);
    if (result != CURLE_OK) return result;
    if (transfer->input >= 0) {
        if (lseek(transfer->input, request->input_offset, SEEK_SET) < 0) {
            request->request.io_failed = TRUE;
            return CURLE_READ_ERROR;
        }
        curl_easy_setopt(curl, CURLOPT_UPLOAD, 1L);
        curl_easy_setopt(curl, CURLOPT_READFUNCTION, transfer_read);
        curl_easy_setopt(curl, CURLOPT_READDATA, transfer);
        curl_easy_setopt(curl, CURLOPT_INFILESIZE_LARGE, (curl_off_t)request->remaining);
    }
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, transfer_header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, transfer);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, transfer_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, transfer);
    return CURLE_OK;
}

static int transfer_request_progress(void *opaque, curl_off_t total, curl_off_t now,
                                     curl_off_t upload_total, curl_off_t uploaded)
{
    struct transfer_request *request = opaque;
    return transfer_progress(request->transfer, total, now, upload_total, uploaded);
}

static int transfer_terminal(CURLcode transport, long status, void *opaque)
{
    struct transfer_request *request = opaque;
    return request->transfer->output_io_failed || onebox_terminal(transport, status, &request->request);
}

static int transfer_commit_restart(struct transfer_request *request)
{
    struct onebox_transfer *transfer = request->transfer;
    int file = transfer->response.file;
    off_t initial = request->request.initial_offset;
    if (file < 0 || !initial || !transfer->stored_restart) return 0;
    if (transfer_cancelled(transfer)) {
        return ftruncate(file, initial) || lseek(file, initial, SEEK_SET) < 0 ? OFF_FILE_ERROR : 0;
    }
    off_t end = lseek(file, 0, SEEK_CUR);
    if (end < initial) return OFF_FILE_ERROR;
    off_t length = end - initial, offset = 0;
    unsigned char bytes[65536];
    /* Only the Range-ignored case needs this bounded-memory, in-place move.
     * Its staged source is always ahead of the destination, so overlapping
     * ranges cannot destroy bytes that have not yet been read. */
    while (offset < length) {
        size_t count = (uint64_t)(length - offset) < sizeof bytes ? (size_t)(length - offset) : sizeof bytes;
        ssize_t got;
        do got = pread(file, bytes, count, initial + offset); while (got < 0 && errno == EINTR);
        if (got <= 0) return OFF_FILE_ERROR;
        size_t written = 0;
        while (written < (size_t)got) {
            ssize_t part = pwrite(file, bytes + written, (size_t)got - written, offset + (off_t)written);
            if (part < 0 && errno == EINTR) continue;
            if (part <= 0) return OFF_FILE_ERROR;
            written += (size_t)part;
        }
        offset += got;
    }
    if (ftruncate(file, length) || lseek(file, length, SEEK_SET) < 0) return OFF_FILE_ERROR;
    transfer->offset = 0;
    transfer->reset_output = FALSE;
    transfer->stored_restart = FALSE;
    return 0;
}

static int transfer_http(struct onebox_transfer *transfer, CURL *curl, const char *url,
                         const char *method, struct json_object *body, gboolean authenticated,
                         gboolean delegated, const char *date)
{
    struct http_response *response = &transfer->response;
    response->status = 0; response->transport = CURLE_OK;
    response->target_host[0] = 0; response->target_port = 0;
    g_string_truncate(response->body, 0);
    g_clear_pointer(&transfer->location, g_free);
    gboolean trusted = FALSE;
    CURLU *parsed = transfer_url(transfer, url, &authenticated, delegated, &trusted);
    if (!parsed) { response->transport = CURLE_URL_MALFORMAT; return OFF_BASE + 10; }
    curl_url_cleanup(parsed);
    struct curl_slist *headers = NULL;
    struct ls_http_options options;
    int result = onebox_options(transfer->configuration, &options);
    if (!result && (!add_header(&headers, "Content-Type", transfer->multipart ? "multipart/form-data" : "application/json") ||
        (authenticated && (!add_header(&headers, "Authorization", transfer->token) ||
         (!transfer->upload && !add_header(&headers, "x-usertoken", transfer->token)))) ||
        (date && !add_header(&headers, "Date", date)))) result = OFF_INVALID_PARAM;
    if (!result && transfer->offset && response->file >= 0) {
        char range[64];
        snprintf(range, sizeof range, "bytes=%" PRIu64 "-", transfer->offset);
        if (!add_header(&headers, "Range", range)) result = OFF_INVALID_PARAM;
    }
    if (!result) {
        const char *encoded = body ? json_object_to_json_string_ext(body, JSON_C_TO_STRING_PLAIN) : NULL;
        struct transfer_request request = {
            .request = {
                .response = response, .method = method, .body = encoded,
                .body_size = encoded ? strlen(encoded) : 0,
                .initial_offset = response->file >= 0 ? lseek(response->file, 0, SEEK_CUR) : 0,
                .defer_output = TRUE
            },
            .transfer = transfer, .offset = transfer->offset, .remaining = transfer->remaining,
            .input_offset = transfer->input >= 0 ? lseek(transfer->input, 0, SEEK_CUR) : 0
        };
        if (request.request.initial_offset < 0 || request.input_offset < 0) result = OFF_FILE_ERROR;
        else {
            options.cancel_check = transfer_cancelled;
            options.cancel_context = transfer;
            options.omit_client_identity = !trusted;
            struct ls_http_stream stream = {
                .prepare = transfer_prepare, .progress = transfer_request_progress,
                .terminal = transfer_terminal, .context = &request
            };
            struct ls_http_result response_result = {0};
            ls_http_perform_stream(&transfer->http, curl, url, headers, &options, &stream, &response_result);
            response_route(response, &response_result);
            ls_http_result_clear(&response_result);
            result = transfer_commit_restart(&request);
            if (request.request.io_failed || transfer->output_io_failed) result = OFF_FILE_ERROR;
            if (!result && response->transport != CURLE_OK) result = OFF_BASE + 100 + response->transport;
        }
    }
    curl_easy_reset(curl);
    curl_slist_free_all(headers);
    return result;
}

static int transfer_owner_url(struct onebox_transfer *transfer, CURL *curl)
{
    struct json_object *input = transfer->request.param;
    const char *owner = text_value(input, "owner_id"), *id = text_value(input, "file_id");
    if (!*id) return OFF_INVALID_PARAM;
    char *owner_id = curl_easy_escape(curl, *owner ? owner : transfer->owner, 0);
    char *file_id = curl_easy_escape(curl, id, 0);
    char *suffix = owner_id && file_id ? g_strdup_printf("/api/v4/files/%s/%s/url", owner_id, file_id) : NULL;
    curl_free(owner_id); curl_free(file_id);
    if (!suffix) return OFF_BASE + 7;
    char *url = endpoint(transfer->configuration, suffix), date[64];
    g_free(suffix); http_date(date);
    int result = transfer_http(transfer, curl, url, "GET", NULL, TRUE, FALSE, date);
    g_free(url);
    if (!result && transfer->response.status != 200) result = OFF_BASE + 122;
    if (!result) {
        struct json_object *root = transfer_json(&transfer->response);
        const char *download = text_value(root, "downloadURL");
        if (!*download) download = text_value(root, "downloadUrl");
        if (!*download) result = OFF_PARSE_ERROR;
        else { g_free(transfer->url); transfer->url = g_strdup(download); }
        json_object_put(root);
    }
    return result;
}

static int transfer_download(struct onebox_transfer *transfer, CURL *curl)
{
    struct json_object *input = transfer->request.param;
    gboolean owner_url = transfer->request.cmd == 589862;
    struct json_object *info = owner_url ? input : native_get(input, "down_file_info");
    struct json_object *access = native_get(info, "pplain_access");
    int result = owner_url ? transfer_owner_url(transfer, curl) : 0;
    if (result) return result;
    struct http_origin origin;
    CURLU *validated = parse_http_url(transfer->url, &origin);
    if (!validated) return OFF_BASE + 10;
    gboolean authenticated = origin_authorized(&origin, &transfer->origin, transfer->configuration);
    gboolean allowed = owner_url ? !g_ascii_strcasecmp(origin.scheme, "https") :
        (authenticated || !cloud_host(transfer->configuration, origin.host));
    clear_origin(&origin); curl_url_cleanup(validated);
    if (!allowed) return OFF_BASE + 10;
    int file = open(transfer->path, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    struct stat stat;
    if (file < 0) return OFF_FILE_ERROR;
    if (fstat(file, &stat) || !S_ISREG(stat.st_mode) || stat.st_size < 0) { close(file); return OFF_FILE_ERROR; }
    gboolean resume = transfer->expected && (owner_url || native_integer(info, "bkeep_download", 0) == 1);
    if (resume && (uint64_t)stat.st_size <= transfer->expected) transfer->offset = stat.st_size;
    else if (ftruncate(file, 0)) { close(file); return OFF_FILE_ERROR; }
    if (lseek(file, transfer->offset, SEEK_SET) < 0) { close(file); return OFF_FILE_ERROR; }
    transfer->response.file = file;
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "pcfile_handle", json_object_new_uint64(transfer->handle));
    respond(&transfer->request, 0, param);
    transfer->transferring = TRUE;
    struct json_object *body = NULL;
    char date[64];
    const char *plain = text_value(access, "access_code");
    const char *method = "GET";
    if (authenticated && *plain) {
        http_date(date);
        char *signature = sign_plain_access(plain, date);
        if (!signature) result = OFF_BASE + 7;
        else {
            body = json_object_new_object();
            json_object_object_add(body, "plainAccessCode", json_object_new_string(signature));
            g_free(signature); method = "POST";
            const char *type = text_value(access, "pctype");
            if (*type) json_object_object_add(body, "type", json_object_new_string(type));
            static const char *keys[][2] = {{"pcheight", "height"}, {"pcwidth", "width"}};
            for (size_t n = 0; n < sizeof keys / sizeof *keys; ++n) {
                const char *number = text_value(access, keys[n][0]);
                if (!*number) continue;
                char *end = NULL; errno = 0;
                uint64_t value = g_ascii_strtoull(number, &end, 10);
                if (errno || *end || !g_ascii_isdigit(*number)) { result = OFF_INVALID_PARAM; break; }
                json_object_object_add(body, keys[n][1], json_object_new_uint64(value));
            }
        }
    }
    if (!result && transfer->expected && transfer->offset == transfer->expected) {
        /* The original skips the body request when the existing partial is complete. */
        transfer->response.status = 200;
        g_string_truncate(transfer->response.body, 0);
    } else if (!result) {
        result = transfer_http(transfer, curl, transfer->url, method, body, authenticated, owner_url, body ? date : NULL);
        for (unsigned redirects = 0; !result && transfer->response.status == 307; ++redirects) {
            if (!transfer->location || redirects == 20) { result = OFF_BASE + 10; break; }
            CURLU *next = curl_url(); char *target = NULL, port[6];
            snprintf(port, sizeof port, "%u", transfer->response.target_port);
            /* Relative redirects belong to the route that actually replied,
             * which may be a verified Compass standby rather than request_url. */
            if (next && *transfer->response.target_host && transfer->response.target_port &&
                curl_url_set(next, CURLUPART_URL, transfer->url, 0) == CURLUE_OK &&
                curl_url_set(next, CURLUPART_HOST, transfer->response.target_host, 0) == CURLUE_OK &&
                curl_url_set(next, CURLUPART_PORT, port, 0) == CURLUE_OK &&
                curl_url_set(next, CURLUPART_URL, transfer->location, 0) == CURLUE_OK)
                curl_url_get(next, CURLUPART_URL, &target, 0);
            curl_url_cleanup(next);
            if (!target) { result = OFF_BASE + 10; break; }
            g_free(transfer->url); transfer->url = g_strdup(target); curl_free(target);
            /* CreateHandleByHandle in the SDK starts a GET without session headers. */
            result = transfer_http(transfer, curl, transfer->url, "GET", NULL, FALSE, FALSE, NULL);
        }
    }
    json_object_put(body);
    if (!result && transfer->convert_failed) result = OFF_PARSE_ERROR;
    if (!result && (transfer->response.status == 200 || transfer->response.status == 206)) {
        if (fsync(file) || fstat(file, &stat) ||
            (transfer->expected && (uint64_t)stat.st_size != transfer->expected)) result = OFF_FILE_ERROR;
    }
    if (close(file) && !result) result = OFF_FILE_ERROR;
    transfer->response.file = -1;
    if (!resume && (g_atomic_int_get(&transfer->cancelled) || g_atomic_int_get(&stopping)))
        unlink(transfer->path);
    transfer_complete(transfer, result, NULL, NULL, NULL);
    return 0; /* Completion has been queued, including genuine transfer failure. */
}

#include "im_transport_onebox_upload.inc"

static void transfer_worker(gpointer opaque, gpointer unused)
{
    (void)unused;
    struct onebox_transfer *transfer = opaque;
    CURL *curl = curl_easy_init();
    int result = g_atomic_int_get(&transfer->cancelled) || g_atomic_int_get(&stopping) ? OFF_BASE + 15 :
        !curl ? OFF_BASE + 201 : transfer->upload ? transfer_upload(transfer, curl) : transfer_download(transfer, curl);
    if (result && !g_atomic_int_get(&transfer->cancelled)) respond(&transfer->request, result, NULL);
    if (curl) curl_easy_cleanup(curl);
    transfer_retire(transfer);
    transfer_unref(transfer);
}

static void transfer_wait_finished(struct onebox_transfer *transfer)
{
    g_mutex_lock(&transfer->finished_mutex);
    while (!g_atomic_int_get(&transfer->completed))
        g_cond_wait(&transfer->finished, &transfer->finished_mutex);
    g_mutex_unlock(&transfer->finished_mutex);
}

static void transfer_cancel_all(void)
{
    g_mutex_lock(&transfer_mutex);
    unsigned count = transfers ? g_hash_table_size(transfers) : 0;
    if (!count) { g_mutex_unlock(&transfer_mutex); return; }
    GPtrArray *cancelled = g_ptr_array_sized_new(count);
    GHashTableIter iterator; gpointer value;
    g_hash_table_iter_init(&iterator, transfers);
    while (g_hash_table_iter_next(&iterator, NULL, &value)) {
        g_atomic_int_set(&((struct onebox_transfer *)value)->cancelled, 1);
        g_ptr_array_add(cancelled, value);
    }
    /* The array takes the table's references; workers retain their own. */
    g_hash_table_steal_all(transfers);
    g_mutex_unlock(&transfer_mutex);
    for (unsigned n = 0; n < cancelled->len; ++n) {
        struct onebox_transfer *transfer = g_ptr_array_index(cancelled, n);
        transfer_wait_finished(transfer);
        transfer_unref(transfer);
    }
    g_ptr_array_free(cancelled, TRUE);
}

static void transfer_command(struct native_request *request)
{
    if (!session.token) { respond(request, OFF_NOT_LOGIN, NULL); return; }
    if (request->cmd == 589834) {
        int64_t id = native_integer(request->param, "file_handle", 0);
        g_mutex_lock(&transfer_mutex);
        struct onebox_transfer *transfer = id > 0 && id <= UINT32_MAX ?
            g_hash_table_lookup(transfers, GUINT_TO_POINTER((uint32_t)id)) : NULL;
        if (transfer && g_atomic_int_get(&transfer->completed)) transfer = NULL;
        if (transfer) {
            g_atomic_int_inc(&transfer->references);
            g_atomic_int_set(&transfer->cancelled, 1);
            g_hash_table_remove(transfers, GUINT_TO_POINTER((uint32_t)id));
        }
        g_mutex_unlock(&transfer_mutex);
        if (transfer) {
            transfer_wait_finished(transfer);
            transfer_unref(transfer);
        }
        respond(request, transfer ? 0 : OFF_BASE + 4, NULL);
        return;
    }
    gboolean owner_url = request->cmd == 589862, upload = request->cmd == 589830;
    struct json_object *info = owner_url ? request->param :
        native_get(request->param, upload ? "up_file_info" : "down_file_info");
    const char *path = text_value(info, owner_url || upload ? "file_path" : "pcfile_path");
    if (upload && !strncmp(path, "file:", 5)) path += 5;
    const char *url = owner_url || upload ? "" : text_value(info, "pcfile_down_url");
    int64_t length = upload ? 0 : native_integer(info, owner_url ? "file_size" : "total_length", 0);
    if (!*path || (!owner_url && !upload && !*url) || length < 0 ||
        (upload && !*text_value(info, "file_name"))) { respond(request, OFF_INVALID_PARAM, NULL); return; }
    /* SVN virtual-file I/O requires its genuine native protection provider. */
    if (json_object_get_boolean(native_get(info, upload ? "use_svn_file" : "buse_svn_file"))) {
        respond(request, OFF_NOT_SUPPORT, reason_value("SVN file protection provider is unavailable")); return;
    }
    g_mutex_lock(&transfer_mutex);
    GHashTableIter iterator; gpointer value;
    g_hash_table_iter_init(&iterator, transfers);
    while (g_hash_table_iter_next(&iterator, NULL, &value)) {
        struct onebox_transfer *existing = value;
        if (existing->upload == upload && !g_atomic_int_get(&existing->completed) && !strcmp(existing->path, path)) {
            uint32_t handle = existing->handle;
            g_mutex_unlock(&transfer_mutex);
            struct json_object *param = json_object_new_object();
            json_object_object_add(param, upload ? "pfile_handle" : "pcfile_handle", json_object_new_uint64(handle));
            respond(request, 0, param); return;
        }
    }
    if (last_transfer_handle == UINT32_MAX) {
        g_mutex_unlock(&transfer_mutex); respond(request, OFF_BASE + 34, NULL); return;
    }
    struct onebox_transfer *transfer = g_new0(struct onebox_transfer, 1);
    g_mutex_init(&transfer->finished_mutex);
    g_cond_init(&transfer->finished);
    transfer->references = 1;
    transfer->upload = upload;
    transfer->input = -1;
    transfer->handle = ++last_transfer_handle;
    transfer->epoch = service_epoch;
    transfer->request = *request;
    transfer->request.root = json_object_get(request->root);
    transfer->token = g_strdup(session.token); transfer->owner = g_strdup(session.user_id);
    transfer->origin.scheme = g_strdup(session.origin.scheme);
    transfer->origin.host = g_strdup(session.origin.host);
    transfer->origin.port = session.origin.port;
    transfer->path = g_strdup(path); transfer->url = g_strdup(url);
    transfer->expected = length; transfer->last_now = UINT64_MAX;
    transfer->response.body = g_string_new(NULL); transfer->response.file = -1;
    if (json_object_deep_copy(session.configuration, &transfer->configuration, NULL) ||
        ls_http_context_copy(&transfer->http, &session.http)) {
        g_mutex_unlock(&transfer_mutex);
        transfer_unref(transfer);
        respond(request, OFF_BASE + 7, NULL);
        return;
    }
    transfer->references = 2;
    g_hash_table_insert(transfers, GUINT_TO_POINTER(transfer->handle), transfer);
    gboolean queued = g_thread_pool_push(transfer_pool, transfer, NULL);
    if (!queued) g_hash_table_remove(transfers, GUINT_TO_POINTER(transfer->handle));
    g_mutex_unlock(&transfer_mutex);
    if (!queued) { transfer_unref(transfer); respond(request, OFF_BASE + 19, NULL); }
}
