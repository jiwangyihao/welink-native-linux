/* Included by contact_sqlite_plugin.c: legacy JSON command records/selectors. */
struct contact_filter {
    const char *where, *value;
    char *owned_where, *storage;
    GPtrArray *list;
    int limit, offset;
};

static void free_filter(struct contact_filter *filter)
{
    g_free(filter->owned_where);
    g_free(filter->storage);
    if (filter->list) g_ptr_array_free(filter->list, TRUE);
}

/* The original frontend sends SQL-quoted comma-separated account/work-id lists.
 * Parse values, not SQL, so apostrophes and commas cannot become executable text. */
static int list_filter(struct contact_filter *filter, const char *column)
{
    filter->storage = g_strdup(filter->value);
    filter->list = g_ptr_array_new();
    char *input = filter->storage, *output = input;
    while (*input) {
        while (g_ascii_isspace(*input)) ++input;
        if (!*input) break;
        char *value = output;
        if (*input == '\'' || *input == '"') {
            char quote = *input++;
            int closed = 0;
            while (*input) {
                if (*input == quote) {
                    ++input;
                    if (*input != quote) { closed = 1; break; }
                }
                *output++ = *input++;
            }
            if (!closed) return SQLITE_MISMATCH;
            while (g_ascii_isspace(*input)) ++input;
            if (*input && *input != ',') return SQLITE_MISMATCH;
        } else {
            while (*input && *input != ',') *output++ = *input++;
            while (output > value && g_ascii_isspace(output[-1])) --output;
        }
        int more = *input == ',';
        if (more) ++input;
        *output++ = 0;
        g_ptr_array_add(filter->list, value);
        if (!more) break;
    }
    if (!filter->list->len) { filter->where = "0"; return SQLITE_OK; }
    if (user_db && filter->list->len > (guint)sqlite3_limit(user_db, SQLITE_LIMIT_VARIABLE_NUMBER, -1)) return SQLITE_TOOBIG;
    GString *where = g_string_new(column);
    g_string_append(where, " IN (");
    for (guint i = 0; i < filter->list->len; ++i) {
        if (i) g_string_append_c(where, ',');
        g_string_append_c(where, '?');
    }
    g_string_append_c(where, ')');
    filter->owned_where = g_string_free(where, FALSE);
    filter->where = filter->owned_where;
    return SQLITE_OK;
}

static int record_filter(const struct contact_record *record, struct json_object *match,
                         int deleting, struct contact_filter *filter)
{
    memset(filter, 0, sizeof(*filter));
    filter->limit = record == &group_record ? -1 : 512;
    int64_t key = native_integer(match, "keytype", -1);
    filter->value = native_string(match, "match_value", NULL);
    if (key < 0 || !filter->value) return SQLITE_MISMATCH;
    const char *value = filter->value;
    if (record == &system_record || record == &config_record) {
        switch (key) {
        case 0: if (deleting) filter->where = "AUTOID=?1"; break;
        case 1: filter->where = "KEY=?1"; break;
        case 3: if (!deleting) filter->where = "1"; break;
        }
    } else if (record == &group_record) {
        /* New ContactGroupTab keys are NOT the old CustomTagTab enumeration. */
        switch (key) {
        case 0: filter->where = "1"; break;
        case 1: filter->where = "AUTOID=?1"; break;
        case 2: filter->where = "GROUPID=?1"; break;
        case 3: if (!deleting) return list_filter(filter, "GROUPID"); break;
        case 4:
            if (!deleting) {
                /* contact.dll 0x100898e0 / 0x1008ab10, not an equality test. */
                GString *pattern = g_string_new("%");
                for (const char *p = value; *p; ++p) {
                    if (strchr("%&()/[]_", *p)) g_string_append_c(pattern, '/');
                    g_string_append_c(pattern, *p);
                }
                g_string_append_c(pattern, '%');
                filter->storage = g_string_free(pattern, FALSE);
                filter->value = filter->storage;
                filter->where = "GROUPNAMECN LIKE replace(lower(?1),' ','') ESCAPE '/' OR "
                                "GROUPNAMEEN LIKE replace(lower(?1),' ','') ESCAPE '/'";
            }
            break;
        }
    } else if (record == &member_record) {
        switch (key) {
        case 1: filter->where = "CTAGID=?1"; break;
        case 2: filter->where = "CID=?1"; break;
        case 5: filter->where = "1"; break;
        }
    } else if (record == &friend_record) {
        switch (key) {
        case 0: if (deleting) filter->where = "AUTOID=?1"; break;
        case 1: filter->where = "FRIENDACCOUNT=?1"; break;
        case 3: if (!deleting) filter->where = "FRIENDGROUPID=?1"; break;
        case 6: filter->where = "GROUPMEMBERID=?1"; break;
        case 11: filter->where = "1"; break;
        case 12: if (!deleting) filter->where = "1"; break;
        case 13:
            if (*value) return list_filter(filter, "FRIENDACCOUNT");
            if (!deleting) filter->where = "1";
            break;
        }
    } else if (record == &remark_record) {
        switch (key) {
        case 1: filter->where = "REMARKACCOUNT=?1"; break;
        case 2:
            if (*value) return list_filter(filter, "REMARKACCOUNT");
            filter->where = "1"; break;
        case 3: case 4: filter->where = "1"; break;
        case 5: filter->where = "REMARK LIKE '%'||?1||'%'"; break;
        }
    } else if (record == &contact_record) {
        int64_t limit = native_integer(match, "limitCount", 512);
        int64_t offset = native_integer(match, "offsetCount", 0);
        if (limit < 0 || limit > INT_MAX || offset < 0 || offset > INT_MAX) return SQLITE_RANGE;
        filter->limit = (int)limit;
        filter->offset = (int)offset;
        switch (key) {
        case 0: if (deleting) filter->where = "AUTOID=?1"; break;
        case 1:
            if (!deleting && strchr(value, ',')) return list_filter(filter, "CONTACTID");
            filter->where = "CONTACTID=?1"; break;
        case 3: if (!deleting) filter->where = "ACCOUNT=?1"; break;
        case 13: if (!deleting) filter->where = "EMAIL=?1"; break;
        case 39:
            if (!deleting) filter->where =
                "BINDNO LIKE '%'||?1||'%' OR MOBILEPHONE LIKE '%'||?1||'%' OR "
                "IPPHONE LIKE '%'||?1||'%' OR OFFICEPHONE LIKE '%'||?1||'%' OR "
                "OTHERPHONE LIKE '%'||?1||'%' OR SHORTPHONE LIKE '%'||?1||'%' OR "
                "VOIP LIKE '%'||?1||'%' OR HOMEPHONE LIKE '%'||?1||'%' OR "
                "OTHERPHONE2 LIKE '%'||?1||'%' OR OFFICEPHONE2 LIKE '%'||?1||'%' OR "
                "ESPACENUMBER LIKE '%'||?1||'%'";
            break;
        case 40:
            if (!deleting && *value) return list_filter(filter, "ACCOUNT");
            filter->where = deleting ? "1" : "ACCOUNT!=''"; break;
        case 41:
            if (!deleting) {
                filter->storage = g_strdup(value);
                filter->list = g_ptr_array_new();
                GString *where = g_string_new(NULL);
                char *save = NULL;
                for (char *word = strtok_r(filter->storage, " \t\r\n", &save); word;
                     word = strtok_r(NULL, " \t\r\n", &save)) {
                    if (filter->list->len) g_string_append(where, " AND ");
                    g_ptr_array_add(filter->list, word);
                    guint index = filter->list->len;
                    g_string_append_printf(where,
                        "(QPINYIN LIKE '%%'||?%u||'%%' OR NAME LIKE '%%'||?%u||'%%' OR "
                        "ACCOUNT LIKE '%%'||?%u||'%%' OR WORKID LIKE '%%'||?%u||'%%' OR "
                        "EMAIL LIKE '%%'||?%u||'%%' OR MOBILEPHONE LIKE '%%'||?%u||'%%' OR "
                        "PERSONMOBILELIST LIKE '%%'||?%u||'%%')", index,index,index,index,index,index,index);
                }
                if (!filter->list->len) g_string_append(where, "0");
                filter->owned_where = g_string_free(where, FALSE);
                filter->where = filter->owned_where;
            }
            break;
        case 46:
            if (!deleting) filter->where =
                "BINDNO=?1 OR (NOT EXISTS(SELECT 1 FROM ContactTab WHERE BINDNO=?1) AND "
                "(MOBILEPHONE=?1 OR IPPHONE=?1 OR OFFICEPHONE=?1 OR OTHERPHONE=?1 OR "
                "SHORTPHONE=?1 OR VOIP=?1 OR HOMEPHONE=?1 OR OTHERPHONE2=?1 OR "
                "OFFICEPHONE2=?1 OR ESPACENUMBER=?1 OR PERSONMOBILELIST LIKE '%'||?1||'%'))";
            break;
        case 47: filter->where = deleting ? "ACCOUNT=?1" : "SHOWACCOUNT=?1"; break;
        case 48: if (!deleting) filter->where = "1"; break;
        case 49: filter->where = "ISEXTERNALCONTACT=CAST(?1 AS INTEGER)"; break;
        case 51: if (!deleting) filter->where = "ACCOUNT!='' AND TIDTYPE!=3"; break;
        case 52: if (!deleting) filter->where = "ACCOUNT!='' AND TIDTYPE=3"; break;
        case 53:
            if (deleting) filter->where = "ISHIDDEN=0 OR ISHIDDEN IS NULL OR SENIORMODE=0 OR SENIORMODE IS NULL";
            break;
        case 54:
            if (!deleting) filter->where = "UPDATETIMESTAMP!=0 AND UPDATETIMESTAMP<CAST(?1 AS INTEGER)";
            break;
        case 55: if (!deleting) return list_filter(filter, "WORKID"); break;
        }
    }
    return filter->where ? SQLITE_OK : SQLITE_MISUSE;
}

static int bind_filter(sqlite3_stmt *statement, const struct contact_filter *filter)
{
    if (filter->list) {
        for (guint i = 0; i < filter->list->len; ++i) {
            int result = sqlite3_bind_text(statement, (int)i + 1, g_ptr_array_index(filter->list, i), -1, SQLITE_STATIC);
            if (result) return result;
        }
    } else if (sqlite3_bind_parameter_count(statement))
        return sqlite3_bind_text(statement, 1, filter->value, -1, SQLITE_STATIC);
    return SQLITE_OK;
}

static int bind_record(sqlite3_stmt *statement, const struct contact_record *record,
                       struct json_object *row)
{
    if (!json_object_is_type(row, json_type_object)) return SQLITE_MISMATCH;
    for (size_t i = 0; i < record->count; ++i) {
        const struct contact_field *field = &record->fields[i];
        struct json_object *value = native_get(row, field->json);
        int result;
        if (!i && json_object_get_int64(value) <= 0) result = sqlite3_bind_null(statement, 1);
        else if (field->kind == C_TEXT) {
            if (value && !json_object_is_type(value, json_type_string)) return SQLITE_MISMATCH;
            result = sqlite3_bind_text(statement, (int)i + 1, value ? json_object_get_string(value) : "",
                                       value ? json_object_get_string_len(value) : 0, SQLITE_STATIC);
        } else {
            if (value && !json_object_is_type(value, json_type_int)) return SQLITE_MISMATCH;
            int64_t number = value ? json_object_get_int64(value) : field->kind == C_DEFAULT_ONE;
            result = sqlite3_bind_int64(statement, (int)i + 1, number);
        }
        if (result) return result;
    }
    if (record == &contact_record) {
        const char *name = native_string(row, "name", "");
        if (!g_utf8_validate(name, -1, NULL)) return SQLITE_MISMATCH;
        char *reversed = g_utf8_strreverse(name, -1);
        int result = sqlite3_bind_text(statement, (int)record->count + 1, reversed, -1, g_free);
        if (result) return result;
        return sqlite3_bind_int64(statement, (int)record->count + 2, g_utf8_strlen(name, -1));
    }
    return SQLITE_OK;
}

static int64_t insert_records(sqlite3 *db, const struct contact_record *record,
                              struct json_object *param, const char *field, int batch)
{
    if (!db) return -1;
    struct json_object *data = native_get(param, field);
    int64_t count = batch ? native_integer(param, "_arraylen", -1) : 1;
    if (count <= 0 || (batch && (!json_object_is_type(data, json_type_array) ||
        (uint64_t)count != json_object_array_length(data)))) return -1;
    /* Savepoints also make a batch all-or-nothing on a caller's open transaction. */
    int result = sqlite3_exec(db, "SAVEPOINT contact_batch", NULL, NULL, NULL);
    sqlite3_stmt *statement = NULL;
    if (!result) result = sqlite3_prepare_v2(db, record->insert_sql, -1, &statement, NULL);
    int64_t affected = 0;
    for (int64_t i = 0; !result && i < count; ++i) {
        struct json_object *row = batch ? json_object_array_get_idx(data, (size_t)i) : data;
        result = bind_record(statement, record, row);
        if (!result) {
            int step = sqlite3_step(statement);
            result = step == SQLITE_DONE ? SQLITE_OK : step;
        }
        if (!result) { affected += sqlite3_changes(db); result = sqlite3_reset(statement); }
    }
    sqlite3_finalize(statement);
    if (!result) result = sqlite3_exec(db, "RELEASE contact_batch", NULL, NULL, NULL);
    if (result) {
        sqlite3_exec(db, "ROLLBACK TO contact_batch;RELEASE contact_batch", NULL, NULL, NULL);
        return -1;
    }
    return batch ? affected : sqlite3_last_insert_rowid(db);
}

static int select_records(sqlite3 *db, const struct contact_record *record,
                           struct json_object *param, struct json_object **output)
{
    struct contact_filter filter;
    int result = record_filter(record, native_get(param, "_matchinfo"), 0, &filter);
    if (!db && !result) result = SQLITE_MISUSE;
    sqlite3_stmt *statement = NULL;
    if (!result) {
        const char *order = record == &group_record ? " ORDER BY INDEXNO" : "";
        char *sql = sqlite3_mprintf("%s WHERE (%s)%s LIMIT %d OFFSET %d", record->select_sql,
                                     filter.where, order, filter.limit, filter.offset);
        result = sql ? sqlite3_prepare_v2(db, sql, -1, &statement, NULL) : SQLITE_NOMEM;
        sqlite3_free(sql);
    }
    if (!result) result = bind_filter(statement, &filter);
    struct json_object *rows = NULL;
    if (!result) result = collect_rows(statement, &rows, record);
    sqlite3_finalize(statement);
    free_filter(&filter);
    *output = json_object_new_object();
    if (result) { json_object_put(rows); set_string(*output, "reason", sqlite3_errstr(result)); }
    else {
        size_t count = rows ? json_object_array_length(rows) : 0;
        json_object_object_add(*output, record->list, rows);
        set_int(*output, "_retlen", (int64_t)count);
    }
    return result;
}

static int64_t delete_records(sqlite3 *db, const struct contact_record *record, struct json_object *param)
{
    struct contact_filter filter;
    int result = record_filter(record, native_get(param, "_matchinfo"), 1, &filter);
    if (!db && !result) result = SQLITE_MISUSE;
    sqlite3_stmt *statement = NULL;
    if (!result) {
        char *sql = sqlite3_mprintf("DELETE FROM %s WHERE (%s)", record->table, filter.where);
        result = sql ? sqlite3_prepare_v2(db, sql, -1, &statement, NULL) : SQLITE_NOMEM;
        sqlite3_free(sql);
    }
    if (!result) result = bind_filter(statement, &filter);
    if (!result) {
        int step = sqlite3_step(statement);
        result = step == SQLITE_DONE ? SQLITE_OK : step;
    }
    sqlite3_finalize(statement);
    free_filter(&filter);
    return result ? -1 : sqlite3_changes(db);
}

static int64_t delete_members(struct json_object *param)
{
    struct json_object *match = native_get(param, "_multimatchinfo");
    struct json_object *list = native_get(match, "datalist");
    int64_t count = native_integer(match, "datalen", -1);
    int64_t operation = native_integer(match, "operationtype", -1);
    if (!user_db || count < 0 || !json_object_is_type(list, json_type_array) ||
        (uint64_t)count != json_object_array_length(list)) return -1;
    const char *first = NULL, *second = NULL;
    for (int64_t i = 0; i < count; ++i) {
        struct json_object *item = json_object_array_get_idx(list, (size_t)i);
        int64_t type = native_integer(item, "keytype", -1);
        const char *value = native_string(item, "match_value", NULL);
        if (!value) return -1;
        if (type == (operation == 4 ? 2 : operation)) first = value;
        if (operation == 4 && type == 1) second = value;
    }
    const char *sql = NULL;
    switch (operation) {
    case 0: sql = "DELETE FROM ContactCustomTagTab WHERE AUTOID=?1"; break;
    case 1: sql = "DELETE FROM ContactCustomTagTab WHERE CTAGID=?1"; break;
    case 2: sql = "DELETE FROM ContactCustomTagTab WHERE CID=?1"; break;
    case 4: sql = "DELETE FROM ContactCustomTagTab WHERE CID=?1 AND CTAGID=?2"; break;
    case 5: sql = "DELETE FROM ContactCustomTagTab"; break;
    }
    if (!sql || (operation != 5 && !first) || (operation == 4 && !second)) return -1;
    sqlite3_stmt *statement = NULL;
    int result = sqlite3_prepare_v2(user_db, sql, -1, &statement, NULL);
    if (!result && operation != 5) result = sqlite3_bind_text(statement, 1, first, -1, SQLITE_STATIC);
    if (!result && operation == 4) result = sqlite3_bind_text(statement, 2, second, -1, SQLITE_STATIC);
    if (!result) {
        int step = sqlite3_step(statement);
        result = step == SQLITE_DONE ? SQLITE_OK : step;
    }
    sqlite3_finalize(statement);
    return result ? -1 : sqlite3_changes(user_db);
}

struct contact_command {
    int command;
    char operation;
    const struct contact_record *record;
    const char *field, *description;
};
static const struct contact_command contact_commands[] = {
    {2,'i',&system_record,"_keyvalue","tup_sqlite_add_sysconfig"},
    {3,'d',&system_record,NULL,"tup_sqlite_del_sysconfig"},
    {4,'q',&system_record,NULL,"tup_sqlite_query_sysconfig"},
    {9,'i',&contact_record,"_contactinfo","tup_sqlite_add_contact"},
    {10,'b',&contact_record,"_contactinfolist","tup_sqlite_add_contactlist"},
    {11,'d',&contact_record,NULL,"tup_sqlite_delete_contactlist"},
    {12,'q',&contact_record,NULL,"tup_sqlite_query_contact"},
    {13,'i',&config_record,"_keyvalue","tup_sqlite_add_userconfig"},
    {14,'d',&config_record,NULL,"tup_sqlite_delete_userconfig"},
    {15,'q',&config_record,NULL,"tup_sqlite_query_userconfig"},
    {16,'b',&config_record,"_keyvaluelist","tup_sqlite_add_userconfiglist"},
    {28,'i',&friend_record,"_friendshipinfo","tup_sqlite_add_friendship"},
    {29,'b',&friend_record,"_friendinfolist","tup_sqlite_add_friendshiplist"},
    {30,'d',&friend_record,NULL,"tup_sqlite_delete_friendship"},
    {31,'q',&friend_record,NULL,"tup_sqlite_query_friendship"},
    {32,'i',&member_record,"_contactgroupmeminfo","tup_sqlite_add_contactgroupmem"},
    {33,'b',&member_record,"_contactgroupmeminfolist","tup_sqlite_add_contactgroupmemlist"},
    {34,'m',&member_record,NULL,"tup_sqlite_delete_contactgroupmem"},
    {35,'q',&member_record,NULL,"tup_sqlite_query_contactgroupmem"},
    {36,'i',&remark_record,"_remark","tup_sqlite_add_remark"},
    {37,'b',&remark_record,"_remarklist","tup_sqlite_add_remarklist"},
    {38,'q',&remark_record,NULL,"tup_sqlite_query_remark"},
    {50,'i',&group_record,"_new_contactgroupinfo","tup_sqlite_add_new_contactgroup"},
    {51,'b',&group_record,"_new_contactgroupinfolist","tup_sqlite_add_new_contactgrouplist"},
    {52,'d',&group_record,NULL,"tup_sqlite_delete_contactgroup"},
    {53,'q',&group_record,NULL,"tup_sqlite_query_new_contactgroup"}
};

static struct json_object *handle_request(const struct native_request *request)
{
    struct json_object *reply = json_object_new_object();
    set_int(reply, "rsp", request->cmd);
    json_object_object_add(reply, "sno", json_object_get(native_get(request->root, "sno")));
    const char *description = "unsupported contact database command";
    int result = 1;
    if (request->cmd == 1) {
        description = "tup_sqlite_init_db";
        int status = json_object_is_type(request->param, json_type_object) ? initialize(request->param) : SQLITE_MISUSE;
        result = status != SQLITE_OK;
        set_int(reply, "ret", result);
    } else {
        const struct contact_command *command = NULL;
        for (size_t i = 0; i < ARRAY_SIZE(contact_commands); ++i)
            if (contact_commands[i].command == request->cmd) { command = &contact_commands[i]; break; }
        if (command) {
            description = command->description;
            sqlite3 *db = command->record == &system_record ? system_db : user_db;
            struct json_object *match = native_get(request->param, "_matchinfo");
            const char *reason = NULL;
            if (command->operation == 'q' || command->operation == 'd') {
                if (!json_object_is_type(match, json_type_object)) reason = "param is not correct!";
                else if (!json_object_is_type(native_get(match, "keytype"), json_type_int))
                    reason = "keytype is not correct!";
                else if (!json_object_is_type(native_get(match, "match_value"), json_type_string))
                    reason = "match_value is not correct!";
            }
            if (reason) {
                if (request->cmd == 14) set_int(reply, "ret", -1);
                else {
                    struct json_object *data = json_object_new_object();
                    set_string(data, "reason", reason);
                    json_object_object_add(reply, "param", data);
                }
                set_int(reply, "result", 1);
                set_string(reply, "description", native_string(request->root, "description", description));
                return reply;
            }
            if (command->operation == 'q') {
                struct json_object *data = NULL;
                int status = select_records(db, command->record, request->param, &data);
                result = status ? ((request->cmd == 15 || request->cmd == 35) ? -1 : 1) : 0;
                json_object_object_add(reply, "param", data);
            } else {
                int64_t ret;
                if (command->operation == 'm') ret = delete_members(request->param);
                else if (command->operation == 'd') ret = delete_records(db, command->record, request->param);
                else ret = insert_records(db, command->record, request->param, command->field, command->operation == 'b');
                result = ret < 0;
                /* DeleteFriendship uses sendResult, unlike the other mutations. */
                if (request->cmd != 30) set_int(reply, "ret", ret);
            }
        } else {
            struct json_object *data = json_object_new_object();
            set_string(data, "reason", description);
            json_object_object_add(reply, "param", data);
        }
    }
    set_int(reply, "result", result);
    set_string(reply, "description", native_string(request->root, "description", description));
    return reply;
}
