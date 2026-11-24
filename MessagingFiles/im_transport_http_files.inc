/* Private IM HTTP file operations reconstructed from ImHttpService and
 * wk_tup_httptrans. Included after the common HTTP helpers in tup_im.c. */
struct im_file_response {
    GString *body;
    long status;
    int output;
};

static gboolean im_http_origin(CURLU *target, const char *address)
{
    if (!*address) return FALSE;
    char *base = https_address(address);
    CURLU *origin = base ? curl_url() : NULL;
    char *host = NULL, *port = NULL, *base_host = NULL, *base_port = NULL;
    gboolean valid = origin && curl_url_set(origin, CURLUPART_URL, base, 0) == CURLUE_OK &&
        curl_url_get(target, CURLUPART_HOST, &host, 0) == CURLUE_OK &&
        curl_url_get(target, CURLUPART_PORT, &port, CURLU_DEFAULT_PORT) == CURLUE_OK &&
        curl_url_get(origin, CURLUPART_HOST, &base_host, 0) == CURLUE_OK &&
        curl_url_get(origin, CURLUPART_PORT, &base_port, CURLU_DEFAULT_PORT) == CURLUE_OK &&
        !g_ascii_strcasecmp(host, base_host) && !strcmp(port, base_port);
    curl_free(host); curl_free(port); curl_free(base_host); curl_free(base_port);
    curl_url_cleanup(origin); g_free(base);
    return valid;
}

/* -1: invalid URL, 0: caller-selected external URL, 1: session authority.
 * common.js DownloadEmojiFile also targets middlegroundAddr/tinyimage; the
 * CDN and signed external links are downloads, not session-token recipients. */
static int im_http_authorize(struct http_job *work, const char *url, gboolean allow_http)
{
    CURLU *target = curl_url();
    char *scheme = NULL, *host = NULL, *user = NULL, *password = NULL, *fragment = NULL;
    int authority = -1;
    if (!target || !*url || strpbrk(url, "\r\n") ||
        curl_url_set(target, CURLUPART_URL, url, 0) != CURLUE_OK ||
        curl_url_get(target, CURLUPART_SCHEME, &scheme, 0) != CURLUE_OK ||
        (strcmp(scheme, "https") && (!allow_http || strcmp(scheme, "http"))) ||
        curl_url_get(target, CURLUPART_HOST, &host, 0) != CURLUE_OK || !*host ||
        curl_url_get(target, CURLUPART_USER, &user, 0) != CURLUE_NO_USER ||
        curl_url_get(target, CURLUPART_PASSWORD, &password, 0) != CURLUE_NO_PASSWORD ||
        curl_url_get(target, CURLUPART_FRAGMENT, &fragment, 0) != CURLUE_NO_FRAGMENT) goto done;
    authority = !strcmp(scheme, "https") &&
        (im_http_origin(target, string_value(work->configuration, "imHttpAddr")) ||
         im_http_origin(target, string_value(work->configuration, "middlegroundAddr")));
done:
    curl_free(scheme); curl_free(host); curl_free(user); curl_free(password); curl_free(fragment);
    curl_url_cleanup(target);
    return authority;
}

static size_t im_file_header(char *data, size_t size, size_t count, void *opaque)
{
    struct im_file_response *response = opaque;
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (length >= 12 && !memcmp(data, "HTTP/", 5)) {
        char *space = memchr(data, ' ', length);
        if (space && data + length - space >= 4 && space[1] >= '1' && space[1] <= '5' &&
            space[2] >= '0' && space[2] <= '9' && space[3] >= '0' && space[3] <= '9')
            response->status = (space[1] - '0') * 100 + (space[2] - '0') * 10 + space[3] - '0';
    }
    return length;
}

static size_t im_file_write(char *data, size_t size, size_t count, void *opaque)
{
    struct im_file_response *response = opaque;
    if (response->output < 0 || response->status != 200)
        return http_write(data, size, count, response->body);
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count, offset = 0;
    while (offset < length) {
        ssize_t wrote = write(response->output, data + offset, length - offset);
        if (wrote < 0 && errno == EINTR) continue;
        if (wrote <= 0) return 0;
        offset += (size_t)wrote;
    }
    return length;
}
struct im_file_stream {
    struct im_file_response *response;
    const char *method, *encoded, *filename;
    size_t body_size;
    int input;
    curl_off_t input_size;
    curl_mime *form;
};

static size_t im_file_read(char *data, size_t size, size_t count, void *opaque)
{
    struct im_file_stream *request = opaque;
    if ((size && count > SIZE_MAX / size) || im_http_cancelled(NULL)) return CURL_READFUNC_ABORT;
    size_t length = size * count;
    if (!length) return 0;
    ssize_t received;
    do { received = read(request->input, data, length); } while (received < 0 && errno == EINTR);
    return received < 0 ? CURL_READFUNC_ABORT : (size_t)received;
}

static int im_file_seek(void *opaque, curl_off_t offset, int origin)
{
    struct im_file_stream *request = opaque;
    off_t position = (off_t)offset;
    if ((curl_off_t)position != offset) return CURL_SEEKFUNC_CANTSEEK;
    return lseek(request->input, position, origin) < 0 ? CURL_SEEKFUNC_FAIL : CURL_SEEKFUNC_OK;
}

static CURLcode im_file_prepare(CURL *curl, unsigned attempt, const char *url, void *opaque)
{
    (void)attempt; (void)url;
    struct im_file_stream *request = opaque;
    struct im_file_response *response = request->response;
    g_string_truncate(response->body, 0);
    response->status = 0;
    /* A new temporary download and a pinned regular upload both start at zero.
     * Reset before EVERY IP/hostname/CA attempt, not merely before each request. */
    if (response->output >= 0 &&
        (ftruncate(response->output, 0) || lseek(response->output, 0, SEEK_SET) != 0))
        return CURLE_WRITE_ERROR;
    curl_mime_free(request->form); request->form = NULL;
    if (request->input >= 0) {
        if (lseek(request->input, 0, SEEK_SET) != 0) return CURLE_READ_ERROR;
        request->form = curl_mime_init(curl);
        curl_mimepart *file = request->form ? curl_mime_addpart(request->form) : NULL;
        curl_mimepart *source = file ? curl_mime_addpart(request->form) : NULL;
        if (!source) return CURLE_OUT_OF_MEMORY;
        CURLcode error = curl_mime_name(file, "file");
        if (!error) error = curl_mime_filename(file, request->filename);
        if (!error) error = curl_mime_data_cb(file, request->input_size,
            im_file_read, im_file_seek, NULL, request);
        if (!error) error = curl_mime_name(source, "uploadSourceType");
        if (!error) error = curl_mime_data(source, "PERSONAL", CURL_ZERO_TERMINATED);
        if (!error) error = curl_easy_setopt(curl, CURLOPT_MIMEPOST, request->form);
        if (error) return error;
    } else if (request->encoded) {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request->encoded);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)request->body_size);
    }
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, request->method);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, im_file_header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, response);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, im_file_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, response);
    return CURLE_OK;
}

static int im_file_request(struct http_job *work, CURL *curl, const char *url,
                           const char *method, struct json_object *body,
                           const char *upload, const char *download, struct im_file_response *response)
{
    g_string_truncate(response->body, 0);
    response->status = 0;
    response->output = -1;
    int authority = im_http_authorize(work, url, FALSE);
    if (authority < 0 || (!authority && (upload || body || !download))) return -1;
    struct curl_slist *headers = NULL;
    char *temporary = NULL, *filename = NULL;
    int result = -1;
    struct im_file_stream request = {.response = response, .method = method, .input = -1};
    struct ls_http_result routed = {0};
    if (authority &&
        (!http_header(&headers, "authorization", string_value(work->configuration, "authToken")) ||
         !http_header(&headers, "Cookie", string_value(work->configuration, "cookie")) ||
         !http_header(&headers, "x-app-id", "1"))) goto done;
    if (upload) {
        request.input = open(upload, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
        struct stat info;
        if (request.input < 0 || fstat(request.input, &info) || !S_ISREG(info.st_mode) || info.st_size < 0)
            goto done;
        request.input_size = info.st_size;
        filename = g_path_get_basename(upload); request.filename = filename;
    } else if (body) {
        if (!http_header(&headers, "Content-Type", "application/json") ||
            !http_header(&headers, "charset", "UTF-8")) goto done;
        request.encoded = json_object_to_json_string_ext(body, JSON_C_TO_STRING_PLAIN);
        request.body_size = strlen(request.encoded);
    }
    if (download) {
        temporary = g_strconcat(download, ".XXXXXX", NULL);
        response->output = g_mkstemp_full(temporary, O_WRONLY | O_CLOEXEC, 0600);
        if (response->output < 0) goto done;
    }
    struct ls_http_options options = im_http_options(!authority);
    options.require_http_200 = 1;
    struct ls_http_stream stream = {.prepare = im_file_prepare, .context = &request};
    result = ls_http_perform_stream(&work->routing, curl, url, headers, &options, &stream, &routed);
    response->status = routed.status;
    if (response->output >= 0) {
        if (!result && response->status == 200 && fsync(response->output)) result = -1;
        if (close(response->output)) result = -1;
        response->output = -1;
        if (!result && response->status == 200 && rename(temporary, download)) result = -1;
    }
done:
    if (response->output >= 0) close(response->output);
    response->output = -1;
    if (temporary) { unlink(temporary); g_free(temporary); }
    curl_easy_setopt(curl, CURLOPT_MIMEPOST, NULL);
    curl_mime_free(request.form);
    if (request.input >= 0) close(request.input);
    g_free(filename);
    ls_http_result_clear(&routed);
    curl_slist_free_all(headers);
    return result;
}

static struct json_object *im_file_json(const struct im_file_response *response)
{
    struct json_tokener *parser = json_tokener_new();
    if (!parser) return NULL;
    json_tokener_set_flags(parser, JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *root = json_tokener_parse_ex(parser, response->body->str, response->body->len + 1);
    if (json_tokener_get_error(parser) != json_tokener_success) {
        json_object_put(root); root = NULL;
    }
    json_tokener_free(parser);
    return root;
}

static void im_file_reply(struct http_job *work, const struct im_file_response *response,
                          int result, gboolean asynchronous, const char *description, const char *reason)
{
    struct native_request *request = &work->job->request;
    struct json_object *reply = json_object_new_object(), *param = json_object_new_object();
    json_object_object_add(reply, "rsp", json_object_get(native_get(request->root, "cmd")));
    json_object_object_add(reply, "sno", json_object_get(native_get(request->root, "sno")));
    json_object_object_add(reply, "description", json_object_new_string(description));
    json_object_object_add(reply, asynchronous ? "ret" : "result", json_object_new_int(result));
    json_object_object_add(param, "resp_code", json_object_new_int64(response->status));
    if (response->body->len)
        json_object_object_add(param, "recv_body", json_object_new_string_len(response->body->str, response->body->len));
    if (reason) json_object_object_add(param, "reason", json_object_new_string(reason));
    json_object_object_add(reply, "param", param);
    emit(reply, work->job->module);
}

static char *im_file_md5(const char *path)
{
    int file = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    if (file < 0) return NULL;
    struct stat stat;
    if (fstat(file, &stat) || !S_ISREG(stat.st_mode)) { close(file); return NULL; }
    GChecksum *checksum = g_checksum_new(G_CHECKSUM_MD5);
    unsigned char bytes[65536];
    ssize_t length = -1;
    while (!g_atomic_int_get(&stopping)) {
        length = read(file, bytes, sizeof bytes);
        if (length < 0 && errno == EINTR) continue;
        if (length <= 0) break;
        g_checksum_update(checksum, bytes, length);
    }
    char *digest = !length && !g_atomic_int_get(&stopping) ? g_strdup(g_checksum_get_string(checksum)) : NULL;
    g_checksum_free(checksum); close(file);
    return digest;
}

static void im_add_emoji(struct http_job *work, CURL *curl, const char *base, struct im_file_response *response)
{
    struct json_object *input = work->job->request.param;
    struct json_object *body = NULL, *root = NULL;
    char *id = g_strdup(string_value(input, "objectId")), *url = NULL;
    const char *reason = NULL;
    gboolean asynchronous = FALSE;
    int result = -1;
    if (!json_object_is_type(input, json_type_object)) { reason = "param is invalid."; goto done; }
    const char *path = string_value(input, "filePath");
    if (!*id && *path) {
        char *md5 = im_file_md5(path);
        if (!md5) { reason = "get file MD5 failed."; goto done; }
        body = json_object_new_object();
        json_object_object_add(body, "md5", json_object_new_string(md5)); g_free(md5);
        url = g_strconcat(base, "/v1/welinkim/emoji-service/files/check-file-repeat", NULL);
        result = im_file_request(work, curl, url, "POST", body, NULL, NULL, response);
        json_object_put(body); body = NULL; g_free(url); url = NULL;
        if (result || response->status != 200) { result = -1; reason = "CheckFileRepeat failed."; goto done; }
        root = im_file_json(response);
        g_free(id); id = g_strdup(string_value(root, "objectId"));
        json_object_put(root); root = NULL;
    }
    if (!*id) {
        if (!*path) { result = -1; reason = "UploadEmoji failed."; goto done; }
        asynchronous = TRUE;
        url = g_strconcat(base, "/v1/welinkim/emoji-service/files/upload", NULL);
        result = im_file_request(work, curl, url, "POST", NULL, path, NULL, response);
        g_free(url); url = NULL;
        if (result || response->status != 200) { reason = "ImHttpUploadFileRspNotify failed."; goto done; }
        root = im_file_json(response);
        g_free(id); id = g_strdup(string_value(native_get(root, "data"), "objectId"));
        json_object_put(root); root = NULL;
        if (!*id) { result = -1; reason = "get objectId failed."; goto done; }
    }
    body = json_object_new_object();
    static const char *strings[] = {"collectAccount", "copyrightDesc", "description", "name"};
    for (size_t n = 0; n < sizeof strings / sizeof *strings; ++n)
        json_object_object_add(body, strings[n], json_object_new_string(string_value(input, strings[n])));
    json_object_object_add(body, "copyrightFlag", json_object_new_int64(native_integer(input, "copyrightFlag", 0)));
    json_object_object_add(body, "payFlag", json_object_new_int64(native_integer(input, "payFlag", 0)));
    json_object_object_add(body, "objectId", json_object_new_string(id));
    url = g_strconcat(base, "/v1/welinkim/emoji-service/emoji-personal", NULL);
    result = im_file_request(work, curl, url, "POST", body, NULL, NULL, response);
    if (result || response->status != 200) { result = -1; reason = "AddPersonalEmoji failed."; }
    else asynchronous = FALSE; /* Final AddPersonalEmoji response uses result. */
done:
    im_file_reply(work, response, result, asynchronous, "im_http_add_emoji", reason);
    json_object_put(body); json_object_put(root); g_free(id); g_free(url);
}

static char *im_download_url(CURL *curl, const char *base, struct json_object *input,
                             const char *url_key, const char *id_key)
{
    const char *direct = string_value(input, url_key);
    if (*direct) return g_strdup(direct);
    const char *id = string_value(input, id_key);
    if (!*id) return NULL;
    char *escaped = curl_easy_escape(curl, id, 0);
    char *url = escaped ? g_strconcat(base, "/v1/welinkim/emoji-service/files/download/", escaped, NULL) : NULL;
    curl_free(escaped);
    return url;
}

static void im_download_emoji(struct http_job *work, CURL *curl, const char *base,
                              struct im_file_response *response)
{
    struct json_object *input = work->job->request.param;
    const char *path = string_value(input, "filePath");
    const char *thumb_path = string_value(input, "thumbnailFilePath");
    char *original = im_download_url(curl, base, input, "originalUrl", "objectId");
    char *thumbnail = im_download_url(curl, base, input, "thumbnailUrl", "placeholderObjectId");
    const char *cdn_path = string_value(input, "cdnDownloadUrl");
    char *cdn = *cdn_path ? g_strconcat("https://im-cdn.welink.huaweicloud.com", cdn_path, NULL) : NULL;
    char *thumb_cdn = NULL;
    const char *placeholder = string_value(input, "placeholderObjectId");
    const char *slash = strrchr(cdn_path, '/');
    if (cdn && slash && *placeholder) {
        char *escaped = curl_easy_escape(curl, placeholder, 0);
        if (escaped) thumb_cdn = g_strdup_printf("https://im-cdn.welink.huaweicloud.com%.*s/%s", (int)(slash - cdn_path), cdn_path, escaped);
        curl_free(escaped);
    }
    int result = -1;
    const char *reason = "param is not correct!";
    gboolean started = FALSE;
    if (!*path || !original || (thumbnail && !*thumb_path)) goto done;
    started = TRUE;
    result = 0;
    if (thumbnail) {
        result = im_file_request(work, curl, thumb_cdn ? thumb_cdn : thumbnail, "GET", NULL, NULL, thumb_path, response);
        if (thumb_cdn && (result || response->status != 200))
            result = im_file_request(work, curl, thumbnail, "GET", NULL, NULL, thumb_path, response);
        if (!result && response->status != 200) result = -1;
    }
    if (!result) {
        result = im_file_request(work, curl, cdn ? cdn : original, "GET", NULL, NULL, path, response);
        if (cdn && (result || response->status != 200))
            result = im_file_request(work, curl, original, "GET", NULL, NULL, path, response);
        if (!result && response->status != 200) result = -1;
    }
    reason = result ? "ImHttpDownloadFileRspNotify failed." : NULL;
done:
    im_file_reply(work, response, result, started, "im_http_download_file", reason);
    g_free(original); g_free(thumbnail); g_free(cdn); g_free(thumb_cdn);
}

static gboolean im_http_files(struct http_job *work, CURL *curl, const char *base)
{
    int64_t command = work->job->request.cmd;
    if (command != 131078 && command != 131083 && command != 131084) return FALSE;
    struct im_file_response response = {.body = g_string_new(NULL), .output = -1};
    if (command == 131078) im_add_emoji(work, curl, base, &response);
    else if (command == 131083) im_download_emoji(work, curl, base, &response);
    else {
        struct json_object *input = work->job->request.param;
        struct json_object *ids = native_get(input, "objectIds");
        const char *directory = string_value(input, "filePath");
        const char *first = json_object_is_type(ids, json_type_array) && json_object_array_length(ids) ?
            json_object_get_string(json_object_array_get_idx(ids, 0)) : NULL;
        gboolean valid = first && *first && !strpbrk(first, "/\\") && strcmp(first, ".") && strcmp(first, "..") && *directory;
        int result = -1;
        if (valid) {
            char *name = g_strconcat(first, "-.zip", NULL);
            char *path = g_build_filename(directory, name, NULL);
            char *url = g_strconcat(base, "/v1/welinkim/emoji-service/files/download/multi", NULL);
            result = im_file_request(work, curl, url, "POST", ids, NULL, path, &response);
            if (!result && response.status != 200) result = -1;
            g_free(name); g_free(path); g_free(url);
        }
        im_file_reply(work, &response, result, valid, "im_http_download_multi_file",
            result ? (valid ? "ImHttpDownloadCompressFileRspNotify failed." : "param is not correct!") : NULL);
    }
    g_string_free(response.body, TRUE);
    return TRUE;
}

static size_t im_request_header(char *data, size_t size, size_t count, void *opaque)
{
    struct json_object *headers = opaque;
    if (size && count > SIZE_MAX / size) return 0;
    size_t length = size * count;
    if (length >= 5 && !memcmp(data, "HTTP/", 5)) {
        json_object_array_del_idx(headers, 0, json_object_array_length(headers));
        return length;
    }
    const char *colon = memchr(data, ':', length);
    if (!colon) return length;
    const char *value = colon + 1, *end = data + length;
    while (value < end && (*value == ' ' || *value == '\t')) ++value;
    while (end > value && (end[-1] == '\r' || end[-1] == '\n')) --end;
    struct json_object *header = json_object_new_object();
    json_object_object_add(header, "header_name", json_object_new_string_len(data, colon - data));
    json_object_object_add(header, "header_value", json_object_new_string_len(value, end - value));
    json_object_array_add(headers, header);
    return length;
}

struct im_request_stream {
    GString *response;
    struct json_object *headers;
    const char *method, *body;
    size_t size;
    gboolean head;
};

static CURLcode im_request_prepare(CURL *curl, unsigned attempt, const char *url, void *opaque)
{
    (void)attempt; (void)url;
    struct im_request_stream *request = opaque;
    g_string_truncate(request->response, 0);
    json_object_array_del_idx(request->headers, 0, json_object_array_length(request->headers));
    if (request->head) curl_easy_setopt(curl, CURLOPT_NOBODY, 1L);
    else if (request->body) {
        curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request->body);
        curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)request->size);
    }
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, request->method);
    curl_easy_setopt(curl, CURLOPT_HEADERFUNCTION, im_request_header);
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, request->headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, http_write);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, request->response);
    return CURLE_OK;
}

static int im_request_terminal(CURLcode transport, long status, void *unused)
{
    (void)unused;
    /* HttpWithRs::http_syn_send (0xdf30) accepts 2xx and 4xx when the
     * synchronous caller supplied no completion predicate. */
    return transport == CURLE_OK &&
        ((status >= 200 && status < 300) || (status >= 400 && status < 500));
}

static void im_http_request(struct http_job *work, CURL *curl)
{
    const struct native_request *request = &work->job->request;
    struct json_object *input = native_get(request->param, "req_param");
    const char *url = string_value(input, "url");
    int64_t type = native_integer(input, "type", -1);
    static const char *methods[] = {"POST", "DELETE", "PUT", "GET", "HEAD"};
    struct json_object *output_headers = json_object_new_array();
    struct curl_slist *headers = NULL;
    GString *response = g_string_new(NULL);
    int result = 3;
    struct ls_http_result routed = {0};
    int authority = im_http_authorize(work, url, TRUE);
    if (!curl || authority < 0 || type < 0 || type > 4) goto done;
    const char *token = string_value(work->configuration, "authToken");
    const char *cookie = string_value(work->configuration, "cookie");
    struct json_object *input_headers = native_get(input, "header");
    if (input_headers && !json_object_is_type(input_headers, json_type_array)) goto done;
    for (size_t n = 0; input_headers && n < json_object_array_length(input_headers); ++n) {
        struct json_object *header = json_object_array_get_idx(input_headers, n);
        const char *name = string_value(header, "name");
        struct json_object *value = native_get(header, "value");
        if (!*name || strlen(name) >= 64 || !json_object_is_type(value, json_type_string) ||
            json_object_get_string_len(value) >= 4096) goto done;
        for (const unsigned char *p = (const unsigned char *)name; *p; ++p)
            if (!g_ascii_isalnum(*p) && !strchr("!#$%&'*+-.^_`|~", *p)) goto done;
        const char *text = json_object_get_string(value);
        /* Preserve caller-supplied headers, but neither a Host override nor a
         * session credential may turn an external/signed URL into an IM origin. */
        if (!g_ascii_strcasecmp(name, "Host") || !g_ascii_strcasecmp(name, "Proxy-Authorization") ||
            (!authority && ((*token && strstr(text, token)) || (*cookie && strstr(text, cookie)))))
            goto done;
        if (!http_header(&headers, name, json_object_get_string(value))) goto done;
    }
    struct json_object *body = native_get(input, "body");
    const char *encoded = json_object_is_type(body, json_type_object) ?
        json_object_to_json_string_ext(body, JSON_C_TO_STRING_PLAIN) :
        json_object_is_type(body, json_type_string) ? json_object_get_string(body) : "";
    struct im_request_stream io = {
        .response = response, .headers = output_headers, .method = methods[type],
        .body = *encoded || type == 0 || type == 2 ? encoded : NULL,
        .size = strlen(encoded), .head = type == 4
    };
    struct ls_http_options options = im_http_options(!authority);
    struct ls_http_stream stream = {
        .prepare = im_request_prepare, .terminal = im_request_terminal, .context = &io
    };
    CURLcode transport = ls_http_perform_stream(&work->routing, curl, url, headers, &options, &stream, &routed);
    result = transport == CURLE_OK ? 0 : 100 + transport;
done:
    curl_slist_free_all(headers);
    struct json_object *param = json_object_new_object(), *reply = json_object_new_object();
    json_object_object_add(param, "resp_code", json_object_new_int64(routed.status));
    if (response->len) json_object_object_add(param, "recv_body", json_object_new_string_len(response->str, response->len));
    size_t count = json_object_array_length(output_headers);
    json_object_object_add(param, "out_header_num", json_object_new_uint64(count));
    if (count) json_object_object_add(param, "out_header", output_headers);
    else json_object_put(output_headers);
    /* wk_tup_httptrans 0xce80/0xe418 fills this from a 401 WWW-Authenticate
     * auth-name only with an HTTP username configured. ImHttpSynSend exposes
     * URL/type/body/headers, not those credentials. This is NOT the route host. */
    json_object_object_add(param, "out_real_auth_name", json_object_new_string(""));
    json_object_object_add(reply, "rsp", json_object_get(native_get(request->root, "cmd")));
    json_object_object_add(reply, "sno", json_object_get(native_get(request->root, "sno")));
    json_object_object_add(reply, "result", json_object_new_int(result));
    json_object_object_add(reply, "description", json_object_new_string("im_http_syn_send"));
    json_object_object_add(reply, "param", param);
    g_string_free(response, TRUE);
    ls_http_result_clear(&routed);
    emit(reply, work->job->module);
}
