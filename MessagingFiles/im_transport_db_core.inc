/* Core IM command families. The original uses boolean query/mutation results
 * and inserted row IDs; result is deliberately not a generic errno envelope. */
struct core_kv {
    unsigned add, batch, remove, query, update;
    const char *database, *table, *id_column, *key_name, *value_name, *input, *list, *output;
    const char *add_description, *query_description;
    gboolean config;
};
static const struct core_kv core_kvs[] = {
    {2,0,3,4,0,"sysdb","SysConfigTab","AUTOID","strkey","strvalue","_keyvalue",NULL,"_sysconfiglist","tup_sqlite_add_sysconfig","tup_sqlite_query_sysconfig",TRUE},
    {25,75,26,27,0,"userdb","UserConfigTab","AUTOID","strkey","strvalue","_keyvalue","_keyvaluelist","_userconfiglist","tup_sqlite_add_userconfig","tup_sqlite_query_userconfig",TRUE},
    {91,92,93,94,95,"conversationdb","CommonKeyValueTab","RECORD_ID","key","value","_commonkeyvalue","_commonkeyvaluelist","_commonkeyvaluelist","tup_sqlite_add_commonkeyvalue","tup_sqlite_query_commonkeyvalue",FALSE},
    {97,98,99,100,101,"userdb","UserCommonKeyValueTab","RECORD_ID","key","value","_commonkeyvalue","_commonkeyvaluelist","_commonkeyvaluelist","tup_sqlite_add_usercommonkeyvalue","tup_sqlite_query_usercommonkeyvalue",FALSE}
};

static struct json_object *core_error(const struct native_request *request, const char *description)
{
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "reason", json_object_new_string("param is not correct!"));
    return im_db_reply(request, -1, param, description);
}

static int core_prepare(sqlite3 *database, const char *sql, sqlite3_stmt **statement)
{
    *statement = NULL;
    if (!database) return SQLITE_MISUSE;
    const char *tail = NULL;
    int result = sqlite3_prepare_v2(database, sql, -1, statement, &tail);
    while (tail && g_ascii_isspace(*tail)) ++tail;
    if (!result && tail && *tail) result = SQLITE_MISUSE;
    if (result && *statement) { sqlite3_finalize(*statement); *statement = NULL; }
    return result;
}

static int core_bind_string(sqlite3_stmt *statement, int index, struct json_object *value)
{
    if (!json_object_is_type(value, json_type_string)) return SQLITE_MISMATCH;
    return sqlite3_bind_text(statement, index, json_object_get_string(value), json_object_get_string_len(value), SQLITE_TRANSIENT);
}

static struct json_object *core_match_value(struct json_object *multi, int key)
{
    struct json_object *items = native_get(multi, "datalist");
    if (!json_object_is_type(items, json_type_array)) return NULL;
    size_t count = json_object_array_length(items);
    if (native_integer(multi, "datalen", -1) != (int64_t)count) return NULL;
    for (size_t n = 0; n < count; ++n) {
        struct json_object *item = json_object_array_get_idx(items, n);
        if (native_integer(item, "keytype", -1) == key) return native_get(item, "match_value");
    }
    return NULL;
}

static int64_t core_decimal(struct json_object *value)
{
    if (json_object_is_type(value, json_type_int)) return json_object_get_int64(value);
    const char *text = json_object_is_type(value, json_type_string) ? json_object_get_string(value) : "";
    return g_ascii_strtoll(text, NULL, 10);
}

static int core_kv_add(sqlite3 *database, const struct core_kv *kind, struct json_object *row)
{
    struct json_object *id = native_get(row, "id"), *key = native_get(row, kind->key_name), *value = native_get(row, kind->value_name);
    if ((kind->config && !json_object_is_type(id, json_type_int)) || !json_object_is_type(key, json_type_string) ||
        !json_object_is_type(value, json_type_string)) return -1;
    char sql[256];
    snprintf(sql, sizeof sql, "INSERT OR REPLACE INTO %s(%s,KEY,VALUE) VALUES(?1,?2,?3)", kind->table, kind->id_column);
    sqlite3_stmt *statement = NULL;
    int status = core_prepare(database, sql, &statement);
    int64_t record = json_object_is_type(id, json_type_int) ? json_object_get_int64(id) : -1;
    if (!status) status = record > 0 ? sqlite3_bind_int64(statement, 1, record) : sqlite3_bind_null(statement, 1);
    if (!status) status = core_bind_string(statement, 2, key);
    if (!status) status = core_bind_string(statement, 3, value);
    if (!status) status = sqlite3_step(statement) == SQLITE_DONE ? SQLITE_OK : sqlite3_errcode(database);
    sqlite3_finalize(statement);
    return status ? -1 : (int)sqlite3_last_insert_rowid(database);
}

static struct json_object *core_collect_keys(struct json_object *input, gboolean multi)
{
    struct json_object *result = json_object_new_array();
    if (!multi) {
        if (!json_object_is_type(input, json_type_array)) { json_object_put(result); return NULL; }
        for (size_t n = 0; n < json_object_array_length(input); ++n) {
            struct json_object *item = json_object_array_get_idx(input, n);
            if (!json_object_is_type(item, json_type_string)) { json_object_put(result); return NULL; }
            json_object_array_add(result, json_object_get(item));
        }
    } else {
        struct json_object *items = native_get(input, "datalist");
        if (!json_object_is_type(items, json_type_array) || native_integer(input, "datalen", -1) != (int64_t)json_object_array_length(items)) {
            json_object_put(result); return NULL;
        }
        for (size_t n = 0; n < json_object_array_length(items); ++n) {
            struct json_object *item = json_object_array_get_idx(items, n);
            if (!json_object_is_type(item, json_type_object)) { json_object_put(result); return NULL; }
            if (native_integer(item, "keytype", -1) != 7) continue;
            struct json_object *value = native_get(item, "match_value");
            if (json_object_is_type(value, json_type_string)) json_object_array_add(result, json_object_get(value));
            else if (json_object_is_type(value, json_type_array)) {
                for (size_t k = 0; k < json_object_array_length(value); ++k) {
                    struct json_object *key = json_object_array_get_idx(value, k);
                    if (!json_object_is_type(key, json_type_string)) { json_object_put(result); return NULL; }
                    json_object_array_add(result, json_object_get(key));
                }
            } else { json_object_put(result); return NULL; }
        }
    }
    return result;
}

static void core_append_in(GString *sql, size_t count)
{
    if (!count) { g_string_append(sql, "0"); return; }
    g_string_append(sql, "KEY IN (");
    for (size_t n = 0; n < count; ++n) g_string_append(sql, n ? ",?" : "?");
    g_string_append_c(sql, ')');
}

static struct json_object *core_kv_query(struct im_db_context *context, const struct native_request *request,
                                        const struct core_kv *kind)
{
    sqlite3 *database = im_db_database(context, kind->database);
    struct json_object *match = native_get(request->param, kind->config ? "_matchinfo" : "_multimatchinfo");
    int operation = native_integer(match, kind->config ? "keytype" : "operationtype", -1);
    struct json_object *value = kind->config ? native_get(match, "match_value") : core_match_value(match, operation);
    struct json_object *keys = NULL, *rows = NULL;
    gboolean filter = !kind->config && operation == 3;
    if (!database || !json_object_is_type(match, json_type_object)) return core_error(request, kind->query_description);
    GString *sql = g_string_new(NULL);
    g_string_append_printf(sql, "SELECT %s,KEY,VALUE FROM %s", kind->id_column, kind->table);
    int status = SQLITE_OK, parameter = 0, upper_length = 0;
    int64_t limit = 512, offset = 0;
    if (operation == 1 || (!kind->config && operation == 0)) {
        if (!json_object_is_type(value, json_type_string)) status = SQLITE_MISMATCH;
        g_string_append_printf(sql, " WHERE %s=?1", operation == 1 ? "KEY" : kind->id_column);
        parameter = 1;
    } else if (kind->config && kind->query == 27 && operation == 4) {
        if (!json_object_is_type(value, json_type_string)) status = SQLITE_MISMATCH;
        else {
            keys = json_object_new_array();
            const char *part = json_object_get_string(value);
            while (*part) {
                const char *end = strchr(part, ',');
                size_t count = end ? (size_t)(end - part) : strlen(part);
                json_object_array_add(keys, json_object_new_string_len(part, count));
                if (!end) break;
                part = end + 1;
            }
            g_string_append(sql, " WHERE "); core_append_in(sql, json_object_array_length(keys));
        }
    } else if (!kind->config && kind->query == 100 && operation == 7) {
        keys = core_collect_keys(match, TRUE);
        if (!keys) status = SQLITE_MISMATCH;
        else { g_string_append(sql, " WHERE "); core_append_in(sql, json_object_array_length(keys)); }
    } else if (filter) {
        if (!json_object_is_type(value, json_type_string)) status = SQLITE_MISMATCH;
        else {
            parameter = 1;
            const unsigned char *prefix = (const unsigned char *)json_object_get_string(value);
            upper_length = json_object_get_string_len(value);
            while (upper_length && prefix[upper_length - 1] == 0xff) --upper_length;
            /* Empty/all-ff prefixes have no finite byte successor. */
            g_string_append(sql, " WHERE KEY>=?1");
            if (upper_length) g_string_append(sql, " AND KEY<?2");
        }
    } else if (!(kind->config ? operation == 3 : operation == 6)) status = SQLITE_MISMATCH;
    if (filter) {
        limit = core_decimal(core_match_value(match, 4));
        if (limit <= 0 || limit > 512) limit = 512; /* Vendor serialization cap. */
        offset = core_decimal(core_match_value(match, 5));
        if (offset < 0) offset = 0;
        g_string_append(sql, upper_length ? " LIMIT ?3 OFFSET ?4" : " LIMIT ?2 OFFSET ?3");
    } else g_string_append(sql, " LIMIT 512");
    sqlite3_stmt *statement = NULL;
    if (!status) status = core_prepare(database, sql->str, &statement);
    g_string_free(sql, TRUE);
    if (!status && !sqlite3_stmt_readonly(statement)) status = SQLITE_MISUSE;
    if (!status && parameter) status = operation == 0 ? sqlite3_bind_int64(statement, 1, core_decimal(value)) : core_bind_string(statement, 1, value);
    if (!status && filter) {
        if (upper_length) {
            char *upper = g_malloc(upper_length);
            memcpy(upper, json_object_get_string(value), upper_length);
            ++((unsigned char *)upper)[upper_length - 1];
            /* Transfer the sole upper-bound allocation to SQLite. */
            status = sqlite3_bind_text(statement, 2, upper, upper_length, g_free);
        }
        int limit_parameter = upper_length ? 3 : 2;
        if (!status) status = sqlite3_bind_int64(statement, limit_parameter, limit);
        if (!status) status = sqlite3_bind_int64(statement, limit_parameter + 1, offset);
    }
    for (size_t n = 0; !status && keys && n < json_object_array_length(keys); ++n)
        status = core_bind_string(statement, n + 1, json_object_array_get_idx(keys, n));
    size_t count = 0;
    while (!status) {
        int step = sqlite3_step(statement);
        if (step == SQLITE_DONE) break;
        if (step != SQLITE_ROW) { status = step; break; }
        if (!rows) rows = json_object_new_array();
        struct json_object *row = json_object_new_object();
        json_object_object_add(row, "id", json_object_new_int64(sqlite3_column_int64(statement, 0)));
        for (int column = 1; column <= 2; ++column) {
            const char *text = (const char *)sqlite3_column_text(statement, column);
            json_object_object_add(row, column == 1 ? kind->key_name : kind->value_name,
                json_object_new_string_len(text ? text : "", text ? sqlite3_column_bytes(statement, column) : 0));
        }
        json_object_array_add(rows, row); ++count;
    }
    sqlite3_finalize(statement); json_object_put(keys);
    if (status) { json_object_put(rows); return core_error(request, kind->query_description); }
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, kind->output, rows);
    json_object_object_add(param, "_retlen", json_object_new_int64(count));
    return im_db_reply(request, 1, param, kind->query_description);
}

static struct json_object *core_kv_command(struct im_db_context *context, const struct native_request *request,
                                          const struct core_kv *kind, unsigned command)
{
    if (command == kind->query) return core_kv_query(context, request, kind);
    const char *description = kind->add_description;
    switch (command) {
    case 3: description = "tup_sqlite_del_sysconfig"; break;
    case 26: description = "tup_sqlite_delete_userconfig"; break;
    case 75: description = "tup_sqlite_add_userconfiglist"; break;
    case 92: description = "tup_sqlite_add_commonkeyvaluelist"; break;
    case 93: description = "tup_sqlite_delete_commonkeyvalue"; break;
    case 95: description = "tup_sqlite_update_commonkeyvalue"; break;
    case 98: description = "tup_sqlite_add_usercommonkeyvaluelist"; break;
    case 99: description = "tup_sqlite_delete_usercommonkeyvalue"; break;
    case 101: description = "tup_sqlite_update_usercommonkeyvalue"; break;
    default: break;
    }
    const char *database_name = command == 92 ? "historydb" : kind->database;
    sqlite3 *database = im_db_database(context, database_name);
    if (!database) return core_error(request, description);
    if (command == kind->add) {
        int result = core_kv_add(database, kind, native_get(request->param, kind->input));
        return im_db_reply(request, result, NULL, description);
    }
    if (command == kind->batch) {
        struct json_object *items = native_get(request->param, kind->list);
        if (!json_object_is_type(items, json_type_array) || native_integer(request->param, "_arraylen", -1) != (int64_t)json_object_array_length(items))
            return core_error(request, description);
        int status = sqlite3_exec(database, "SAVEPOINT im_core_batch", NULL, NULL, NULL);
        for (size_t n = 0; !status && n < json_object_array_length(items); ++n)
            if (core_kv_add(database, kind, json_object_array_get_idx(items, n)) < 0) status = SQLITE_ERROR;
        if (status) sqlite3_exec(database, "ROLLBACK TO im_core_batch;RELEASE im_core_batch", NULL, NULL, NULL);
        else status = sqlite3_exec(database, "RELEASE im_core_batch", NULL, NULL, NULL);
        return im_db_reply(request, !status, NULL, description);
    }
    struct json_object *match = native_get(request->param, command == kind->update ? "_multimatchinfo" : "_matchinfo");
    if (!json_object_is_type(match, json_type_object)) return core_error(request, description);
    int type = native_integer(match, command == kind->update ? "operationtype" : "keytype", -1);
    struct json_object *value = native_get(match, "match_value"), *updated = NULL, *keys = NULL;
    GString *sql = g_string_new(NULL);
    int result = -1, status = 0;
    gboolean update = command == kind->update;
    if (update) {
        if (type != 2) { g_string_free(sql, TRUE); return core_error(request, description); }
        updated = core_match_value(match, 2);
        value = core_match_value(match, 0);
        type = 0;
        if (!json_object_is_type(value, json_type_string) || !json_object_get_string_len(value)) { value = core_match_value(match, 1); type = 1; }
        if (!json_object_is_type(value, json_type_string) || !json_object_is_type(updated, json_type_string)) status = SQLITE_MISMATCH;
        g_string_append_printf(sql, "UPDATE %s SET VALUE=?1", kind->table);
    } else g_string_append_printf(sql, "DELETE FROM %s", kind->table);
    if (type == 0 || type == 1) {
        if (!json_object_is_type(value, json_type_string)) status = SQLITE_MISMATCH;
        g_string_append_printf(sql, " WHERE %s=?%d", type == 0 ? kind->id_column : "KEY", update ? 2 : 1);
    } else if (!kind->config && command == 99 && type == 7) {
        keys = core_collect_keys(value, FALSE);
        if (!keys) status = SQLITE_MISMATCH;
        else { g_string_append(sql, " WHERE "); core_append_in(sql, json_object_array_length(keys)); }
    } else if (kind->config || type != 6 || update) status = SQLITE_MISMATCH;
    sqlite3_stmt *statement = NULL;
    if (!status) status = core_prepare(database, sql->str, &statement);
    g_string_free(sql, TRUE);
    if (!status && update) status = core_bind_string(statement, 1, updated);
    if (!status && (type == 0 || type == 1)) status = type == 0 ?
        sqlite3_bind_int64(statement, update ? 2 : 1, core_decimal(value)) : core_bind_string(statement, update ? 2 : 1, value);
    for (size_t n = 0; !status && keys && n < json_object_array_length(keys); ++n)
        status = core_bind_string(statement, n + 1, json_object_array_get_idx(keys, n));
    if (!status && sqlite3_step(statement) == SQLITE_DONE) result = sqlite3_changes(database) > 0;
    sqlite3_finalize(statement); json_object_put(keys);
    return im_db_reply(request, result, NULL, description);
}

struct login_column { const char *json, *sql; unsigned type; };
static const struct login_column login_columns[] = {
    {"id","AUTOID",1},{"account","ACCOUNT",0},{"displayaccount","DISPLAYACCOUNT",0},
    {"userpwd","PASSWORD",0},{"isautologin","AUTOLOGIN",2},{"isrememberpwd","REMPWD",2},
    {"userrandom","USERRANDOM",0},{"timestamp","TIMESTAMP",0},{"tenantcn","TENANTCN",0},
    {"tenanten","TENANTEN",0},{"tenantid","TENANTID",0},{"thirdcertype","THIRDCERTYPE",2},
    {"isMaxhubWorkplace","ISMAXHUBWORKPLACE",1},{"thirdaccount","THIRDACCOUNT",0},
    {"maxhubMiddleEndAddress","MAXHUBMIDDLEENDADDRESS",0},{"setPasswordToken","SETPASSWORDTOKEN",0},
    {"thirdAuthType","THIRDAUTHTYPE",0},{"thirdLoginUrl","THIRDLOGINURL",0},
    {"realNameAuth","REALNAMEAUTH",1},{"useriv","USERIV",0}
};

static struct json_object *core_login_command(struct im_db_context *context, const struct native_request *request, unsigned command)
{
    static const char *descriptions[] = {"tup_sqlite_add_logininfo","tup_sqlite_del_logininfo","tup_sqlite_query_logininfo","tup_sqlite_update_logininfo"};
    const char *description = descriptions[command - 5];
    sqlite3 *database = im_db_database(context, "sysdb");
    if (!database) return core_error(request, description);
    GString *sql = g_string_new(NULL);
    struct json_object *row = native_get(request->param, "_logininfo"), *value = NULL, *changed = NULL;
    int type = -1, status = SQLITE_OK, result = -1;
    if (command == 5) {
        if (!json_object_is_type(row, json_type_object)) status = SQLITE_MISMATCH;
        g_string_append(sql, "INSERT OR REPLACE INTO LoginListTab(");
        for (unsigned n = 0; n < G_N_ELEMENTS(login_columns); ++n) g_string_append_printf(sql, "%s%s", n ? "," : "", login_columns[n].sql);
        g_string_append(sql, ") VALUES(");
        for (unsigned n = 0; n < G_N_ELEMENTS(login_columns); ++n) g_string_append(sql, n ? ",?" : "?");
        g_string_append_c(sql, ')');
    } else if (command == 8) {
        struct json_object *multi = native_get(request->param, "_multimatchinfo");
        type = native_integer(multi, "operationtype", -1);
        value = core_match_value(multi, 1); changed = core_match_value(multi, type);
        if ((type != 3 && type != 4 && type != 5) || !json_object_is_type(value, json_type_string) ||
            !json_object_is_type(changed, json_type_string)) status = SQLITE_MISMATCH;
        g_string_append_printf(sql, "UPDATE LoginListTab SET %s=?1 WHERE ACCOUNT=?2", type == 3 ? "PASSWORD" : type == 4 ? "AUTOLOGIN" : "REMPWD");
    } else {
        struct json_object *match = native_get(request->param, "_matchinfo");
        type = native_integer(match, "keytype", -1); value = native_get(match, "match_value");
        if (!json_object_is_type(value, json_type_string)) status = SQLITE_MISMATCH;
        if (command == 6) g_string_append(sql, "DELETE FROM LoginListTab");
        else {
            g_string_append(sql, "SELECT ");
            for (unsigned n = 0; n < G_N_ELEMENTS(login_columns); ++n) g_string_append_printf(sql, "%s%s", n ? "," : "", login_columns[n].sql);
            g_string_append(sql, " FROM LoginListTab");
        }
        if (type == 1 || (command == 6 && type == 0) || (command == 7 && type == 2))
            g_string_append_printf(sql, " WHERE %s=?1", type == 0 ? "AUTOID" : type == 1 ? "ACCOUNT" : "DISPLAYACCOUNT");
        else if (!(command == 7 && type == 8)) status = SQLITE_MISMATCH;
        if (command == 7) g_string_append(sql, " LIMIT 512");
    }
    sqlite3_stmt *statement = NULL;
    if (!status) status = core_prepare(database, sql->str, &statement);
    g_string_free(sql, TRUE);
    if (!status && command == 5) {
        for (unsigned n = 0; !status && n < G_N_ELEMENTS(login_columns); ++n) {
            struct json_object *field = native_get(row, login_columns[n].json);
            if (!n && native_integer(row, "id", 0) <= 0) status = sqlite3_bind_null(statement, 1);
            else if (login_columns[n].type == 1) status = sqlite3_bind_int64(statement, n + 1, native_integer(row, login_columns[n].json, 0));
            else if (login_columns[n].type == 2) status = sqlite3_bind_int(statement, n + 1, json_object_is_type(field, json_type_boolean) && json_object_get_boolean(field));
            else status = sqlite3_bind_text(statement, n + 1, native_string(row, login_columns[n].json, ""), -1, SQLITE_TRANSIENT);
        }
    } else if (!status && command == 8) {
        status = type == 3 ? core_bind_string(statement, 1, changed) : sqlite3_bind_int(statement, 1, !strcmp(json_object_get_string(changed), "true"));
        if (!status) status = core_bind_string(statement, 2, value);
    } else if (!status && type != 8) status = type == 0 ? sqlite3_bind_int64(statement, 1, core_decimal(value)) : core_bind_string(statement, 1, value);
    struct json_object *rows = NULL;
    unsigned count = 0;
    while (!status && command == 7) {
        int step = sqlite3_step(statement);
        if (step == SQLITE_DONE) { result = 1; break; }
        if (step != SQLITE_ROW) { status = step; break; }
        if (!rows) rows = json_object_new_array();
        struct json_object *entry = json_object_new_object();
        for (unsigned n = 0; n < G_N_ELEMENTS(login_columns); ++n) {
            struct json_object *field;
            if (login_columns[n].type == 1) field = json_object_new_int64(sqlite3_column_int64(statement, n));
            else if (login_columns[n].type == 2) field = json_object_new_boolean(sqlite3_column_int(statement, n) == 1);
            else {
                const char *text = (const char *)sqlite3_column_text(statement, n);
                field = json_object_new_string_len(text ? text : "", text ? sqlite3_column_bytes(statement, n) : 0);
            }
            json_object_object_add(entry, login_columns[n].json, field);
        }
        json_object_array_add(rows, entry); ++count;
    }
    if (!status && command != 7 && sqlite3_step(statement) == SQLITE_DONE)
        result = command == 5 ? (int)sqlite3_last_insert_rowid(database) : sqlite3_changes(database) > 0;
    sqlite3_finalize(statement);
    if (status || result < 0) { json_object_put(rows); return core_error(request, description); }
    struct json_object *param = NULL;
    if (command == 7) {
        param = json_object_new_object();
        json_object_object_add(param, "_logininfolist", rows);
        json_object_object_add(param, "_retlen", json_object_new_int(count));
    }
    return im_db_reply(request, result, param, description);
}

static int database_set_log_path(struct im_db_context *context, const char *directory)
{
    if (!directory) return EINVAL;
    FILE *next = NULL;
    if (*directory) {
        int result = native_storage_mkdirs(directory);
        if (result) return result;
        char *path = g_build_filename(directory, "sqlite_plugin.log", NULL);
        int file = open(path, O_WRONLY | O_APPEND | O_CREAT | O_CLOEXEC, 0600);
        g_free(path);
        if (file < 0) return errno;
        next = fdopen(file, "a");
        if (!next) { int result = errno; close(file); return result; }
    }
    char *retained = g_strdup(directory);
    if (context->log) fclose(context->log);
    context->log = next;
    g_free(context->log_directory); context->log_directory = retained;
    return 0;
}

static int core_stage_key(struct im_db_context *context, const char *plain, const char *nonce,
                          const char *metadata, char **temporary, struct native_storage_key *key)
{
    *temporary = NULL;
    if (!*plain || !*nonce || !*metadata || strlen(metadata) >= sizeof key->metadata) return EINVAL;
    char *path = g_build_filename(context->root, "config.db.key.XXXXXX", NULL);
    int file = g_mkstemp_full(path, O_WRONLY | O_CLOEXEC, 0600);
    if (file < 0) { int result = errno; g_free(path); return result; }
    size_t length = strlen(metadata), offset = 0;
    int result = 0;
    while (offset < length) {
        ssize_t count = write(file, metadata + offset, length - offset);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) { result = errno ? errno : EIO; break; }
        offset += (size_t)count;
    }
    if (!result && fsync(file)) result = errno;
    if (close(file) && !result) result = errno;
    if (!result) result = native_storage_load_key(path, context->root, plain, 0, key);
    if (!result && strcmp(key->nonce, nonce)) result = EINVAL;
    if (result) { unlink(path); g_free(path); native_storage_clear_key(key); }
    else *temporary = path;
    return result;
}

static int core_set_key(struct im_db_context *context, struct json_object *input, gboolean rekey)
{
    const char *plain = native_string(input, rekey ? "newplainvalue" : "plainvalue", "");
    const char *nonce = native_string(input, rekey ? "newvecvalue" : "vecvalue", "");
    const char *metadata = native_string(input, rekey ? "newsecvalue" : "secvalue", "");
    struct native_storage_key candidate = {0};
    char *temporary = NULL;
    int result = core_stage_key(context, plain, nonce, metadata, &temporary, &candidate);
    if (result) return -1;
    char *path = g_build_filename(context->root, "sys.db", NULL);
    char *key_path = g_build_filename(context->root, "config.db", NULL);
    gboolean exists = database_exists(path), changed = FALSE;
    sqlite3 *database = NULL;
    if (exists && rekey) {
        if (!context->public_key_ready) {
            result = native_storage_load_key(key_path, context->root, NULL, 0, &context->public_key);
            if (!result) context->public_key_ready = TRUE;
        }
        if (!result) database = im_db_database(context, "sysdb");
        if (!result && !database) result = SQLITE_CANTOPEN;
        if (!result) result = sqlite3_wal_checkpoint_v2(database, NULL, SQLITE_CHECKPOINT_TRUNCATE, NULL, NULL);
        if (!result) result = sqlite3_exec(database, "PRAGMA journal_mode=DELETE", NULL, NULL, NULL);
        if (!result) {
            result = sqlite3_rekey(database, candidate.password, strlen(candidate.password));
            changed = !result;
        }
    } else if (exists) {
        /* A setter can restore the same key, but must not strand an existing
         * database under an unrelated metadata value. Rotation is command 89. */
        result = native_storage_open(path, candidate.password, 0, &database);
        if (database) { sqlite3_close(database); database = NULL; }
    }
    if (!result && rename(temporary, key_path)) result = errno;
    if (result && changed) {
        int rollback = sqlite3_rekey(database, context->public_key.password, strlen(context->public_key.password));
        if (rollback) {
            /* Preserve the validated, original-format replacement key if the
             * filesystem also prevents rollback; never overwrite the old key. */
            g_free(temporary); temporary = NULL;
        }
    }
    if (!result) {
        native_storage_clear_key(&context->public_key);
        context->public_key = candidate;
        memset(&candidate, 0, sizeof candidate);
        context->public_key_ready = TRUE;
        int directory = open(context->root, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (directory < 0) result = errno;
        else { if (fsync(directory)) result = errno; close(directory); }
    }
    if (database && rekey) {
        int configured = database_configure(database);
        if (!result) result = configured;
    }
    if (temporary) { unlink(temporary); g_free(temporary); }
    native_storage_clear_key(&candidate);
    g_free(path); g_free(key_path);
    return result ? -1 : 1;
}

static struct json_object *core_volume_identifier(struct im_db_context *context, const struct native_request *request)
{
    GFile *directory = g_file_new_for_path(context->root);
    GError *error = NULL;
    GMount *mount = g_file_find_enclosing_mount(directory, NULL, &error);
    g_object_unref(directory);
    if (error) g_error_free(error);
    char *identifier = mount ? g_mount_get_uuid(mount) : NULL;
    if (!identifier && mount) {
        GVolume *volume = g_mount_get_volume(mount);
        if (volume) {
            identifier = g_volume_get_identifier(volume, G_VOLUME_IDENTIFIER_KIND_UUID);
            g_object_unref(volume);
        }
    }
    if (mount) g_object_unref(mount);
    struct json_object *param = json_object_new_object();
    json_object_object_add(param, "discserialnumber", json_object_new_string(identifier ? identifier : ""));
    int result = identifier && *identifier ? 0 : -1;
    g_free(identifier);
    return im_db_reply(request, result, param, "tup_uilogic_getdiscserialnumber");
}

static int im_db_core(struct im_db_context *context, const struct native_request *request, struct json_object **reply)
{
    unsigned command = (uint64_t)request->cmd & 0x2ffffu;
    for (unsigned n = 0; n < G_N_ELEMENTS(core_kvs); ++n) {
        const struct core_kv *kind = &core_kvs[n];
        if (command && (command == kind->add || command == kind->batch || command == kind->remove ||
            command == kind->query || command == kind->update)) {
            *reply = core_kv_command(context, request, kind, command); return 1;
        }
    }
    if (command >= 5 && command <= 8) { *reply = core_login_command(context, request, command); return 1; }
    switch (command) {
    case 1:
        *reply = im_db_reply(request, database_initialize(context, request), NULL, "tup_sqlite_init_db"); break;
    case 128:
        *reply = im_db_reply(request, database_close_private(context) ? 1 : 0, NULL, "tup_sqlite_init_db"); break;
    case 76:
        *reply = core_volume_identifier(context, request); break;
    case 77:
    case 89:
        *reply = im_db_reply(request, core_set_key(context, request->param, command == 89), NULL,
            command == 89 ? "tup_sqlite_update_saltvalue" : "tup_sqlite_set_saltvalue"); break;
    case 78: {
        char *path = g_build_filename(context->root, "config.db", NULL);
        char metadata[NATIVE_STORAGE_METADATA_SIZE] = {0};
        int result = native_storage_read_metadata(path, metadata, sizeof metadata);
        g_free(path);
        struct json_object *param = json_object_new_object();
        json_object_object_add(param, "secvalue", json_object_new_string(result ? "" : metadata));
        *reply = im_db_reply(request, result && result != ENOENT ? -1 : 0, param, "tup_sqlite_get_saltvalue");
        break;
    }
    case 79:
        /* The original table entry is an empty function, with no JS operation. */
        *reply = im_db_reply(request, -1, NULL, "unsupported reserved IM database command"); break;
    case 80: {
        int result = context->private_key_ready || context->public_key_ready ? 0 : 1;
        for (unsigned n = 0; !result && n < G_N_ELEMENTS(context->database); ++n) {
            if (!context->database[n]) continue;
            sqlite3_stmt *statement = NULL;
            int status = core_prepare(context->database[n], "SELECT count(*) FROM sqlite_master", &statement);
            if (!status && sqlite3_step(statement) != SQLITE_ROW) status = SQLITE_ERROR;
            sqlite3_finalize(statement);
            if (status) result = 1;
        }
        *reply = im_db_reply(request, result, NULL, "tup_sqlite_examin_encrypt_file");
        json_object_object_add(*reply, "param", NULL);
        break;
    }
    case 90: {
        const char *directory = native_string(request->param, "_logpath", NULL);
        *reply = im_db_reply(request, database_set_log_path(context, directory) ? -1 : 0, NULL, "tup_sqlite_set_logpath");
        break;
    }
    default: return 0;
    }
    return 1;
}
