/* Onebox V2 upload/copy protocol. Thresholds, part numbering, field types and
 * share-link negotiation are from the original DLL, not an OBS/S3 substitute. */
#define ONEBOX_PART_SIZE (5u * 1024u * 1024u)
#define ONEBOX_MULTIPART_THRESHOLD (20u * 1024u * 1024u)

static int transfer_hashes(struct onebox_transfer *transfer, int file, char md5[33], char block[33])
{
    GChecksum *whole = g_checksum_new(G_CHECKSUM_MD5), *prefix = g_checksum_new(G_CHECKSUM_MD5);
    unsigned char bytes[65536];
    uint64_t prefix_left = transfer->expected > 262144 ? 262144 : transfer->expected > 256 ? 256 : 0;
    gboolean have_prefix = prefix_left != 0;
    uint64_t total = 0;
    int result = 0;
    for (;;) {
        if (g_atomic_int_get(&stopping) || g_atomic_int_get(&transfer->cancelled)) { result = OFF_BASE + 15; break; }
        ssize_t length = read(file, bytes, sizeof bytes);
        if (length < 0 && errno == EINTR) continue;
        if (length < 0) { result = OFF_FILE_ERROR; break; }
        if (!length) break;
        total += (size_t)length;
        g_checksum_update(whole, bytes, length);
        size_t part = MIN((uint64_t)length, prefix_left);
        if (part) { g_checksum_update(prefix, bytes, part); prefix_left -= part; }
    }
    if (!result && (!total || total != transfer->expected)) result = OFF_BASE + 208;
    if (!result) {
        memcpy(md5, g_checksum_get_string(whole), 33);
        if (have_prefix) memcpy(block, g_checksum_get_string(prefix), 33);
        else block[0] = 0;
    }
    g_checksum_free(whole); g_checksum_free(prefix);
    return result;
}

static char *transfer_resource_url(struct onebox_transfer *transfer, CURL *curl,
                                   const char *prefix, const char *owner, const char *id, const char *suffix)
{
    char *user = curl_easy_escape(curl, owner, 0), *file = curl_easy_escape(curl, id, 0);
    char *tail = user && file ? g_strconcat(prefix, user, "/", file, suffix, NULL) : NULL;
    curl_free(user); curl_free(file);
    char *url = tail ? endpoint(transfer->configuration, tail) : NULL;
    g_free(tail);
    return url;
}

static int transfer_link(struct onebox_transfer *transfer, CURL *curl, const char *owner,
                          const char *id, const char *md5, char **access, char **link)
{
    struct json_object *info = native_get(transfer->request.param, "up_file_info");
    *access = g_compute_checksum_for_string(G_CHECKSUM_SHA256, md5, -1);
    if (!*access) return OFF_BASE + 7;
    /* SetShareLinkReqBodyV2 terminates the hex digest at byte 20 before serializing it. */
    (*access)[20] = '\0';
    char *url = transfer_resource_url(transfer, curl, "/api/v2/links/", owner, id, "");
    if (!url) return OFF_BASE + 7;
    struct json_object *body = json_object_new_object();
    json_object_object_add(body, "access", json_object_new_string("direct"));
    json_object_object_add(body, "plainAccessCode", json_object_new_string(*access));
    if (json_object_get_boolean(native_get(info, "is_cross_instance")))
        json_object_object_add(body, "scope", json_object_new_string("trusted"));
    else if (json_object_get_boolean(native_get(info, "public_share_link")))
        json_object_object_add(body, "scope", json_object_new_string("public"));
    int result = transfer_http(transfer, curl, url, "POST", body, TRUE, FALSE, NULL);
    json_object_put(body); g_free(url);
    gboolean existing = FALSE, forced = FALSE;
    if (!result && (transfer->response.status == 409 || transfer->response.status == 412)) {
        existing = TRUE;
        url = transfer_resource_url(transfer, curl, "/api/v2/nodes/", owner, id, "/links");
        result = url ? transfer_http(transfer, curl, url, "GET", NULL, TRUE, FALSE, NULL) : OFF_BASE + 7;
        g_free(url);
    } else if (!result && transfer->response.status == 404) {
        forced = TRUE;
        url = transfer_resource_url(transfer, curl, "/api/v1/link/forceGet/", owner, id, "?directlink=true");
        result = url ? transfer_http(transfer, curl, url, "GET", NULL, TRUE, FALSE, NULL) : OFF_BASE + 7;
        g_free(url);
    }
    if (!result && transfer->response.status != 200 && transfer->response.status != 201) result = OFF_BASE + 209;
    if (!result) {
        struct json_object *root = transfer_json(&transfer->response), *value = root;
        if (existing) {
            struct json_object *links = native_get(root, "links");
            value = json_object_is_type(links, json_type_array) && json_object_array_length(links) ?
                json_object_array_get_idx(links, 0) : NULL;
        }
        const char *address = text_value(value, forced ? "downloadUrl" : "url");
        struct json_object *plain = native_get(value, "plainAccessCode");
        if (!*address || (!forced && !json_object_is_type(plain, json_type_string))) result = OFF_PARSE_ERROR;
        else {
            *link = g_strdup(address);
            if (!forced) { g_free(*access); *access = g_strdup(json_object_get_string(plain)); }
        }
        json_object_put(root);
    }
    return result;
}

static int transfer_preupload(struct onebox_transfer *transfer, CURL *curl, const char *owner,
                               const struct stat *stat, const char *md5, const char *block,
                               char id[32], char **upload_url)
{
    struct json_object *info = native_get(transfer->request.param, "up_file_info");
    struct json_object *body = json_object_new_object();
    json_object_object_add(body, "name", json_object_new_string(text_value(info, "file_name")));
    json_object_object_add(body, "parent", json_object_new_string(native_string(info, "parent_id", "0")));
    json_object_object_add(body, "size", json_object_new_uint64(transfer->expected));
    json_object_object_add(body, "md5", json_object_new_string(md5));
    if (*block) json_object_object_add(body, "blockMD5", json_object_new_string(block));
    /* VTOP_Ultostr receives the original ia32 st_ctime/st_mtime * 1000 values. */
    json_object_object_add(body, "contentCreatedAt", json_object_new_uint64((uint32_t)stat->st_ctime * 1000u));
    json_object_object_add(body, "contentModifiedAt", json_object_new_uint64((uint32_t)stat->st_mtime * 1000u));
    json_object_object_add(body, "encryptKey", json_object_new_string(""));
    char *url = transfer_resource_url(transfer, curl, "/api/v2/files/", owner, "", "");
    int result = url ? transfer_http(transfer, curl, url, "PUT", body, TRUE, FALSE, NULL) : OFF_BASE + 7;
    json_object_put(body); g_free(url);
    if (!result && transfer->response.status != 200 && transfer->response.status != 201) result = OFF_BASE + 122;
    if (!result) {
        struct json_object *root = transfer_json(&transfer->response);
        static const char *ids[] = {"fileID", "fileId", "id"};
        uint64_t file_id = 0;
        for (size_t n = 0; n < sizeof ids / sizeof *ids && !file_id; ++n) {
            struct json_object *value = native_get(root, ids[n]);
            if (json_object_is_type(value, json_type_int)) file_id = json_object_get_uint64(value);
        }
        const char *target = text_value(root, "url");
        if (!*target) target = text_value(root, "uploadUrl");
        if (!file_id || (transfer->response.status != 201 && !*target)) result = OFF_PARSE_ERROR;
        else {
            snprintf(id, 32, "%" PRIu64, file_id);
            *upload_url = g_strdup(target);
        }
        json_object_put(root);
    }
    return result;
}

static int transfer_send_part(struct onebox_transfer *transfer, CURL *curl, int file,
                              const char *url, uint64_t offset, uint64_t length, gboolean multipart)
{
    if (lseek(file, (off_t)offset, SEEK_SET) < 0) return OFF_FILE_ERROR;
    transfer->input = file; transfer->remaining = length;
    transfer->offset = offset; transfer->multipart = multipart;
    transfer->transferring = TRUE;
    int result = transfer_http(transfer, curl, url, "PUT", NULL, !multipart, TRUE, NULL);
    transfer->input = -1; transfer->multipart = FALSE; transfer->transferring = FALSE;
    if (!result && transfer->remaining) result = OFF_FILE_ERROR;
    if (!result && transfer->response.status != 200 && (!multipart && transfer->response.status != 201)) result = OFF_BASE + 122;
    if (!result && multipart && transfer->response.status != 200) result = OFF_BASE + 122;
    return result;
}

static int transfer_multipart(struct onebox_transfer *transfer, CURL *curl, int file,
                               const char *owner, const char *id, char **upload_url,
                               const char *md5, gboolean resume)
{
    uint64_t count = (transfer->expected - 1) / ONEBOX_PART_SIZE + 1, completed = 0;
    int result = 0;
    if (resume) {
        char *url = transfer_resource_url(transfer, curl, "/api/v2/files/", owner, id, "/refreshurl");
        struct json_object *body = json_object_new_object();
        json_object_object_add(body, "uploadUrl", json_object_new_string(*upload_url));
        result = url ? transfer_http(transfer, curl, url, "PUT", body, TRUE, FALSE, NULL) : OFF_BASE + 7;
        json_object_put(body); g_free(url);
        if (result) return result;
        if (transfer->response.status == 404) return 0; /* Original treats an already-committed upload this way; link lookup still must succeed. */
        if (transfer->response.status != 200) return OFF_BASE + 232;
        struct json_object *root = transfer_json(&transfer->response);
        const char *next = text_value(root, "uploadUrl");
        if (!*next) result = OFF_PARSE_ERROR;
        else { g_free(*upload_url); *upload_url = g_strdup(next); }
        json_object_put(root);
        if (result) return result;
        result = transfer_http(transfer, curl, *upload_url, "GET", NULL, FALSE, TRUE, NULL);
        if (result) return result;
        if (transfer->response.status != 200) return OFF_BASE + 231;
        root = transfer_json(&transfer->response);
        struct json_object *parts = native_get(root, "parts");
        if (!json_object_is_type(parts, json_type_array)) result = OFF_PARSE_ERROR;
        else for (size_t n = 0; n < json_object_array_length(parts); ++n) {
            int64_t part = native_integer(json_object_array_get_idx(parts, n), "partId", -1);
            if (part < 1 || (uint64_t)part > count) { result = OFF_PARSE_ERROR; break; }
            if ((uint64_t)part > completed) completed = part;
        }
        json_object_put(root);
        if (result) return result;
    } else {
        char *url = g_strconcat(*upload_url, "?parts", NULL);
        result = transfer_http(transfer, curl, url, "PUT", NULL, TRUE, TRUE, NULL);
        g_free(url);
        if (result) return result;
        if (transfer->response.status != 200) return OFF_BASE + 229;
    }
    for (uint64_t part = completed + 1; part <= count; ++part) {
        uint64_t offset = (part - 1) * ONEBOX_PART_SIZE;
        char *url = g_strdup_printf("%s?partId=%" PRIu64, *upload_url, part);
        result = transfer_send_part(transfer, curl, file, url, offset,
            MIN((uint64_t)ONEBOX_PART_SIZE, transfer->expected - offset), TRUE);
        g_free(url);
        if (result) return result;
        if (part == 1) {
            struct json_object *param = json_object_new_object();
            json_object_object_add(param, "file_handle", json_object_new_uint64(transfer->handle));
            json_object_object_add(param, "resume_file_id", json_object_new_string(id));
            json_object_object_add(param, "resume_up_url", json_object_new_string(*upload_url));
            json_object_object_add(param, "resume_md5", json_object_new_string(md5));
            transfer_emit(transfer, 5, "OFFLINE_E_EVT_MULTIPART_UPLOAD_URL", param);
        }
    }
    struct json_object *body = json_object_new_object(), *parts = json_object_new_array_ext((int)count);
    for (uint64_t part = 1; part <= count; ++part) {
        char number[32]; snprintf(number, sizeof number, "%" PRIu64, part);
        struct json_object *value = json_object_new_object();
        json_object_object_add(value, "partId", json_object_new_string(number));
        json_object_array_add(parts, value);
    }
    json_object_object_add(body, "parts", parts);
    char *url = g_strconcat(*upload_url, "?commit", NULL);
    result = transfer_http(transfer, curl, url, "PUT", body, FALSE, TRUE, NULL);
    g_free(url); json_object_put(body);
    if (!result && transfer->response.status != 200) result = OFF_BASE + 122;
    return result;
}

static int transfer_upload(struct onebox_transfer *transfer, CURL *curl)
{
    struct json_object *info = native_get(transfer->request.param, "up_file_info");
    int file = open(transfer->path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    struct stat stat;
    if (file < 0) return OFF_FILE_ERROR;
    if (fstat(file, &stat) || !S_ISREG(stat.st_mode) || stat.st_size < 0 || (uint64_t)stat.st_size > 0xc0000000u) {
        close(file); return OFF_FILE_ERROR;
    }
    transfer->expected = stat.st_size;
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "pfile_handle", json_object_new_uint64(transfer->handle));
    respond(&transfer->request, 0, param);
    char md5[33] = {0}, block[33] = {0}, id[32] = {0};
    char *upload_url = NULL, *access = NULL, *link = NULL;
    const char *group = text_value(info, "group_id");
    const char *owner = *group ? group : transfer->owner;
    int result = transfer_hashes(transfer, file, md5, block);
    gboolean multipart = transfer->expected > ONEBOX_MULTIPART_THRESHOLD;
    gboolean resume = multipart && *text_value(info, "resume_up_url") &&
        *text_value(info, "resume_file_id") && !strcmp(text_value(info, "resume_md5"), md5);
    gboolean deduplicated = FALSE;
    if (!result && resume) {
        const char *stored = text_value(info, "resume_file_id");
        char *end = NULL; errno = 0;
        uint64_t file_id = g_ascii_strtoull(stored, &end, 10);
        if (errno || *end || !g_ascii_isdigit(*stored) || !file_id) result = OFF_INVALID_PARAM;
        else {
            snprintf(id, sizeof id, "%" PRIu64, file_id);
            upload_url = g_strdup(text_value(info, "resume_up_url"));
        }
    } else if (!result) {
        result = transfer_preupload(transfer, curl, owner, &stat, md5, block, id, &upload_url);
        deduplicated = !result && transfer->response.status == 201;
    }
    if (!result && !deduplicated) {
        if (multipart) result = transfer_multipart(transfer, curl, file, owner, id, &upload_url, md5, resume);
        else result = transfer_send_part(transfer, curl, file, upload_url, 0, transfer->expected, FALSE);
    }
    close(file);
    if (!result) result = transfer_link(transfer, curl, owner, id, md5, &access, &link);
    transfer_complete(transfer, result, id, access, link);
    g_free(upload_url); clear_secret(&access); g_free(link);
    return 0;
}

static void onebox_copy_command(struct native_request *request)
{
    if (!session.token) { respond(request, OFF_NOT_LOGIN, NULL); return; }
    const char *destination = text_value(request->param, "group_space_id");
    int64_t id = native_integer(request->param, "file_id", -1);
    if (!*destination || id < 0) { respond(request, OFF_INVALID_PARAM, NULL); return; }
    const char *owner = text_value(request->param, "owner_id");
    if (json_object_get_boolean(native_get(request->param, "from_group"))) owner = destination;
    else if (!*owner) owner = session.user_id;
    CURL *escape = curl_easy_init();
    if (!escape) { respond(request, OFF_BASE + 7, NULL); return; }
    char *user = curl_easy_escape(escape, owner, 0);
    curl_easy_cleanup(escape);
    if (!user) { respond(request, OFF_BASE + 7, NULL); return; }
    char *suffix = g_strdup_printf("/api/v2/files/%s/%" PRId64 "/copy", user, id);
    curl_free(user);
    char *url = endpoint(session.configuration, suffix), date[64];
    g_free(suffix); http_date(date);
    struct json_object *body = json_object_new_object();
    json_object_object_add(body, "destParent", json_object_new_int64(native_integer(request->param, "dest_parent_id", 0)));
    json_object_object_add(body, "destOwnerId", json_object_new_string(destination));
    json_object_object_add(body, "autoRename", json_object_new_string("true"));
    const char *code = text_value(request->param, "link_code"), *plain = text_value(request->param, "plain_access_code");
    if (*code || *plain) {
        struct json_object *link = json_object_new_object();
        if (*code) json_object_object_add(link, "linkCode", json_object_new_string(code));
        if (*plain) {
            char *signed_access = sign_plain_access(plain, date);
            if (!signed_access) { json_object_put(link); json_object_put(body); g_free(url); respond(request, OFF_BASE + 7, NULL); return; }
            json_object_object_add(link, "plainAccessCode", json_object_new_string(signed_access));
            clear_secret(&signed_access);
        }
        json_object_object_add(body, "link", link);
    }
    struct curl_slist *headers = NULL;
    int result = 0;
    if (!add_header(&headers, "Authorization", session.token) ||
        !add_header(&headers, "Content-Type", "application/json") ||
        (*plain && !add_header(&headers, "Date", date))) result = OFF_INVALID_PARAM;
    struct http_response response = {.body = g_string_new(NULL), .file = -1};
    if (!result) {
        g_string_free(response.body, TRUE);
        result = onebox_request(url, "PUT", headers, session.configuration, body, -1, &response);
    }
    json_object_put(body); curl_slist_free_all(headers); g_free(url);
    if (!result && response.status != 200) result = response.status ? (int)response.status : OFF_PARSE_ERROR;
    struct json_object *root = transfer_json(&response), *param = json_object_new_object();
    struct json_object *file = json_object_new_object(), *http = json_object_new_object();
    if (!result && (!json_object_is_type(root, json_type_object) || native_integer(root, "id", 0) <= 0))
        result = OFF_PARSE_ERROR;
    static const char *numbers[][2] = {
        {"owned_by", "ownedBy"}, {"created_by", "createdBy"}, {"modify_by", "modifiedBy"},
        {"file_id", "id"}, {"parent_id", "parent"}, {"created_at", "createdAt"}, {"modified_at", "modifiedAt"},
        {"resource_type", "type"}, {"size", "size"}, {"content_created_at", "contentCreatedAt"},
        {"content_modified_at", "contentModifiedAt"}, {"kia_status", "kiaStatus"}
    };
    for (size_t n = 0; n < sizeof numbers / sizeof *numbers; ++n)
        json_object_object_add(file, numbers[n][0], json_object_new_int64(native_integer(root, numbers[n][1], n == 7 ? 1 : 0)));
    static const char *strings[][2] = {{"name", "name"}, {"mender", "mender"}, {"md5", "md5"}};
    for (size_t n = 0; n < sizeof strings / sizeof *strings; ++n) {
        struct json_object *value = native_get(root, strings[n][1]);
        if (json_object_is_type(value, json_type_string)) json_object_object_add(file, strings[n][0], json_object_get(value));
    }
    json_object_object_add(file, "mender_name", json_object_new_string(""));
    json_object_object_add(file, "link_count", json_object_new_int(0));
    json_object_object_add(file, "is_shared", json_object_new_int(json_object_get_boolean(native_get(root, "isShare"))));
    json_object_object_add(file, "has_sharelilnk", json_object_new_int(json_object_get_boolean(native_get(root, "isSharelink"))));
    json_object_object_add(file, "is_encrypt", json_object_new_int(json_object_get_boolean(native_get(root, "isEncrypt"))));
    /* The original wrapper reads its code buffer for both type and code. */
    json_object_object_add(http, "type", json_object_new_string(result ? text_value(root, "code") : ""));
    json_object_object_add(http, "code", json_object_new_string(result ? text_value(root, "code") : ""));
    json_object_object_add(http, "message", json_object_new_string(result ? text_value(root, "message") : ""));
    json_object_object_add(param, "file_info", file); json_object_object_add(param, "http_info", http);
    json_object_put(root); g_string_free(response.body, TRUE);
    respond(request, result, param);
}
