/* Native entity slice of the original IM SQLite command bus.
 * Protocol evidence: im_sqlite_plugin.dll, RVAs 0x2db00..0x6a130.
 * Storage evidence: im_ecsdata.dll ComposeSQL/Bind/Extract implementations.
 * Handles and encryption belong to the service; this file never opens a DB.
 */
#include "im_transport_db.h"
#include <stdlib.h>
#include <time.h>

struct entity_field {
    const char *column;
    const char *json;
    char type;                 /* s=text, i=int32, u=uint32, c=legacy char */
    int initial;
    unsigned output;
};
struct entity_model {
    const char *database, *table, *insert, *create, *indexes;
    const struct entity_field *fields;
    size_t nfields, ninsert;
    const char *const *columns;
    size_t ncolumns;
};
#include "im_transport_db_entities_data.inc"

struct entity_sql {
    GString *text;
    struct json_object *values;
    int error;
};

static int entity_object(struct json_object *v)
{
    return json_object_is_type(v, json_type_object);
}

static int entity_array(struct json_object *v)
{
    return json_object_is_type(v, json_type_array);
}

static int entity_int(struct json_object *v)
{
    return json_object_is_type(v, json_type_int);
}

/* JsonCpp's isInt/isUInt also accept integral real values within range. */
static int entity_number(struct json_object *v, int unsigned_value)
{
    int64_t low = unsigned_value ? 0 : INT32_MIN;
    int64_t high = unsigned_value ? UINT32_MAX : INT32_MAX;
    if (entity_int(v)) {
        int64_t n = json_object_get_int64(v);
        return n >= low && n <= high;
    }
    if (!json_object_is_type(v, json_type_double)) return 0;
    double n = json_object_get_double(v);
    return n >= (double)low && n <= (double)high && n == (double)(int64_t)n;
}

static int64_t entity_integer(struct json_object *o, const char *key, int64_t missing)
{
    struct json_object *v = native_get(o, key);
    return entity_number(v, 0) || entity_number(v, 1) ? json_object_get_int64(v) : missing;
}

static int entity_text(struct json_object *v)
{
    return json_object_is_type(v, json_type_string);
}

static struct json_object *entity_reason(const char *message)
{
    struct json_object *p = json_object_new_object();
    json_object_object_add(p, "reason", json_object_new_string(message));
    return p;
}

/* Snapshot the first failing handle's diagnostic before reset, finalize or
 * rollback can replace it. Success paths allocate nothing. */
static int entity_status(sqlite3 *db, int rc, struct json_object **error)
{
    if (error && !*error && rc != SQLITE_OK && rc != SQLITE_ROW && rc != SQLITE_DONE) {
        const char *message = db && (sqlite3_errcode(db) & 0xff) == (rc & 0xff) ?
            sqlite3_errmsg(db) : sqlite3_errstr(rc);
        *error = entity_reason(message);
    }
    return rc;
}

static void entity_sql_init(struct entity_sql *q, const char *sql)
{
    q->text = g_string_new(sql);
    q->values = json_object_new_array();
    q->error = q->values ? SQLITE_OK : SQLITE_NOMEM;
}

static void entity_sql_clear(struct entity_sql *q)
{
    g_string_free(q->text, TRUE);
    json_object_put(q->values);
}

static void entity_value(struct entity_sql *q, struct json_object *v)
{
    g_string_append_c(q->text, '?');
    if (json_object_array_add(q->values, json_object_get(v)) != 0)
        q->error = SQLITE_NOMEM;
}

static void entity_string_value(struct entity_sql *q, const char *s)
{
    struct json_object *v = json_object_new_string(s);
    if (!v) q->error = SQLITE_NOMEM;
    entity_value(q, v);
    json_object_put(v);
}

static void entity_integer_value(struct entity_sql *q, int64_t n)
{
    struct json_object *v = json_object_new_int64(n);
    if (!v) q->error = SQLITE_NOMEM;
    entity_value(q, v);
    json_object_put(v);
}

static int64_t entity_match_number(struct json_object *v)
{
    return entity_text(v) ? strtoll(json_object_get_string(v), NULL, 10) : 0;
}

static void entity_equal(struct entity_sql *q, const char *column,
                         struct json_object *v, int numeric)
{
    g_string_append_printf(q->text, "%s = ", column);
    if (numeric) entity_integer_value(q, entity_match_number(v));
    else entity_string_value(q, entity_text(v) ? json_object_get_string(v) : "");
}

/* Match arrays are bound, never interpolated as SQL. Empty vectors select no rows. */
static void entity_in(struct entity_sql *q, const char *column, struct json_object *a)
{
    g_string_append_printf(q->text, "%s IN (", column);
    size_t n = entity_array(a) ? json_object_array_length(a) : 0;
    size_t used = 0;
    for (size_t i = 0; i < n; ++i) {
        struct json_object *v = json_object_array_get_idx(a, i);
        if (!entity_text(v)) continue;
        if (used++) g_string_append_c(q->text, ',');
        entity_value(q, v);
    }
    if (!used) g_string_append(q->text, "NULL");
    g_string_append_c(q->text, ')');
}

/* Contact list selectors use the original comma-separated string convention. */
static void entity_csv_in(struct entity_sql *q, const char *column, const char *s)
{
    g_string_append_printf(q->text, "%s IN (", column);
    size_t length = strlen(s), start = 0, used = 0;
    if (length && s[length - 1] == ',') --length;
    for (size_t i = 0; i <= length; ++i) {
        if (i != length && s[i] != ',') continue;
        if (used++) g_string_append_c(q->text, ',');
        struct json_object *v = json_object_new_string_len(s + start, (int)(i - start));
        entity_value(q, v);
        json_object_put(v);
        start = i + 1;
    }
    g_string_append_c(q->text, ')');
}

static void entity_like(struct entity_sql *q, const char *column, const char *s,
                        int escape, int both)
{
    GString *pattern = g_string_new(both ? "%" : "");
    for (; *s; ++s) {
        if (escape && (*s == '/' || *s == '%' || *s == '_'))
            g_string_append_c(pattern, '/');
        g_string_append_c(pattern, *s);
    }
    g_string_append_c(pattern, '%');
    g_string_append_printf(q->text, "%s LIKE ", column);
    entity_string_value(q, pattern->str);
    if (escape) g_string_append(q->text, " ESCAPE '/'");
    g_string_free(pattern, TRUE);
}

static int entity_prepare(sqlite3 *db, struct entity_sql *q, sqlite3_stmt **s,
                           struct json_object **error)
{
    *s = NULL;
    if (!db) return entity_status(NULL, SQLITE_CANTOPEN, error);
    if (q->error) return q->error;
    int rc = sqlite3_prepare_v2(db, q->text->str, -1, s, NULL);
    size_t n = json_object_array_length(q->values);
    for (size_t i = 0; rc == SQLITE_OK && i < n; ++i) {
        struct json_object *v = json_object_array_get_idx(q->values, i);
        if (entity_int(v)) rc = sqlite3_bind_int64(*s, (int)i + 1, json_object_get_int64(v));
        else if (json_object_is_type(v, json_type_double))
            rc = sqlite3_bind_int64(*s, (int)i + 1, json_object_get_int64(v));
        else if (entity_text(v)) rc = sqlite3_bind_text(*s, (int)i + 1,
            json_object_get_string(v), json_object_get_string_len(v), SQLITE_TRANSIENT);
        else rc = sqlite3_bind_null(*s, (int)i + 1);
    }
    return entity_status(db, rc, error);
}

static int entity_execute(sqlite3 *db, struct entity_sql *q, struct json_object **error)
{
    sqlite3_stmt *s = NULL;
    int rc = entity_prepare(db, q, &s, error);
    if (rc == SQLITE_OK) {
        rc = entity_status(db, sqlite3_step(s), error);
        if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    int end = entity_status(db, sqlite3_finalize(s), error);
    return rc == SQLITE_OK ? end : rc;
}

static int entity_transaction(sqlite3 *db, int rc, struct json_object **error)
{
    if (rc == SQLITE_OK) {
        rc = entity_status(db, sqlite3_exec(db, "RELEASE im_entities", NULL, NULL, NULL), error);
        if (rc == SQLITE_OK) return rc;
    }
    sqlite3_exec(db, "ROLLBACK TO im_entities", NULL, NULL, NULL);
    sqlite3_exec(db, "RELEASE im_entities", NULL, NULL, NULL);
    return rc;
}

static int entity_install_schema(sqlite3 *db, const struct entity_model *m)
{
    if (!db) return SQLITE_CANTOPEN;
    int rc = sqlite3_exec(db, "SAVEPOINT im_entities", NULL, NULL, NULL);
    if (rc != SQLITE_OK) return rc;
    rc = sqlite3_exec(db, m->create, NULL, NULL, NULL);
    /* Older genuine profiles may lack columns added by later SDK releases. */
    for (size_t c = 0; rc == SQLITE_OK && c < m->ncolumns; ++c) {
        char name[64];
        size_t len = strcspn(m->columns[c], " \t");
        if (len >= sizeof(name)) { rc = SQLITE_MISUSE; break; }
        memcpy(name, m->columns[c], len);
        name[len] = 0;
        char *sql = sqlite3_mprintf("PRAGMA table_info(\"%w\")", m->table);
        sqlite3_stmt *s = NULL;
        if (!sql) { rc = SQLITE_NOMEM; break; }
        rc = sqlite3_prepare_v2(db, sql, -1, &s, NULL);
        sqlite3_free(sql);
        int found = 0;
        if (rc == SQLITE_OK) {
            while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
                const char *existing = (const char *)sqlite3_column_text(s, 1);
                if (existing && sqlite3_stricmp(existing, name) == 0) found = 1;
            }
            if (rc == SQLITE_DONE) rc = SQLITE_OK;
        }
        int end = sqlite3_finalize(s);
        if (rc == SQLITE_OK) rc = end;
        if (rc == SQLITE_OK && !found) {
            sql = sqlite3_mprintf("ALTER TABLE \"%w\" ADD COLUMN %s", m->table, m->columns[c]);
            if (!sql) rc = SQLITE_NOMEM;
            else rc = sqlite3_exec(db, sql, NULL, NULL, NULL);
            sqlite3_free(sql);
        }
    }
    if (rc == SQLITE_OK) rc = sqlite3_exec(db, m->indexes, NULL, NULL, NULL);
    return entity_transaction(db, rc, NULL);
}

int im_db_entities_schema(struct im_db_context *context)
{
    for (size_t i = 0; i < G_N_ELEMENTS(entity_models); ++i) {
        const struct entity_model *m = entity_models[i];
        int rc = entity_install_schema(im_db_database(context, m->database), m);
        if (rc != SQLITE_OK) return rc;
    }
    /* Fresh original history.db and conversation.db both contain GroupNoteTab;
     * its command handlers continue to use the original conversationdb route. */
    return entity_install_schema(im_db_database(context, "historydb"), &note_model);
}

static int entity_bind_row(sqlite3_stmt *s, const struct entity_model *m,
                           struct json_object *row)
{
    int rc = SQLITE_OK;
    for (size_t i = 0; rc == SQLITE_OK && i < m->ninsert; ++i) {
        const struct entity_field *f = m->fields + i;
        struct json_object *v = f->json ? native_get(row, f->json) : NULL;
        int slot = (int)i + 1;
        if (!strcmp(f->column, "AUTOID") && (!entity_number(v, 0) || json_object_get_int64(v) <= 0))
            rc = sqlite3_bind_null(s, slot);
        else if (f->type == 's') {
            const char *text = entity_text(v) ? json_object_get_string(v) : "";
            int length = entity_text(v) ? json_object_get_string_len(v) : 0;
            rc = sqlite3_bind_text(s, slot, text, length, SQLITE_TRANSIENT);
        } else if (f->type == 'r' || f->type == 'l') {
            const char *name = native_string(row, "membername", "");
            if (f->type == 'l') rc = sqlite3_bind_int(s, slot, (int)g_utf8_strlen(name, -1));
            else {
                char *reverse = g_utf8_strreverse(name, -1);
                rc = sqlite3_bind_text(s, slot, reverse, -1, SQLITE_TRANSIENT);
                g_free(reverse);
            }
        } else if (f->type == 'c') {
            /* The legacy parser assigns an integer to std::string::operator=(char). */
            int present = entity_number(v, 0);
            char byte = (char)(present ? json_object_get_int(v) : 0);
            rc = sqlite3_bind_text(s, slot, &byte, present ? 1 : 0, SQLITE_TRANSIENT);
        } else {
            int64_t n = entity_number(v, f->type == 'u') ? json_object_get_int64(v) : f->initial;
            /* The unsigned protocol flag is still bound through vendor BindInt. */
            rc = sqlite3_bind_int(s, slot, (int32_t)n);
        }
    }
    return rc;
}

static int entity_add(sqlite3 *db, const struct entity_model *m, struct json_object *rows,
                       size_t count, int batch, int reorder, int *result,
                       struct json_object **error)
{
    if (!db) return entity_status(NULL, SQLITE_CANTOPEN, error);
    int rc = entity_status(db, sqlite3_exec(db, "SAVEPOINT im_entities", NULL, NULL, NULL), error);
    if (rc != SQLITE_OK) return rc;
    sqlite3_stmt *s = NULL;
    rc = entity_status(db, sqlite3_prepare_v2(db, m->insert, -1, &s, NULL), error);
    for (int pass = 0; rc == SQLITE_OK && pass < (reorder ? 2 : 1); ++pass) {
        for (size_t i = 0; rc == SQLITE_OK && i < count; ++i) {
            struct json_object *row = batch ? json_object_array_get_idx(rows, i) : rows;
            if (!entity_object(row)) { rc = SQLITE_MISMATCH; break; }
            if (reorder) {
                const char *id = m == &index_model || m == &item_model ? "autoId" :
                    m == &category_model || m == &emoji_model ? "autoid" : "id";
                int positive = entity_number(native_get(row, id), 0) && entity_integer(row, id, 0) > 0;
                if (positive != (pass == 0)) continue;
            }
            if (m == &member_model) {
                const char *name = native_string(row, "membername", "");
                const char *extra = native_string(row, "exparams", "");
                if (strlen(name) > 0x100000 || strlen(extra) > 0x100000) {
                    rc = SQLITE_TOOBIG;
                    break;
                }
            }
            rc = entity_status(db, entity_bind_row(s, m, row), error);
            if (rc == SQLITE_OK) {
                rc = entity_status(db, sqlite3_step(s), error);
                if (rc == SQLITE_DONE) {
                    rc = SQLITE_OK;
                    *result = (int32_t)sqlite3_last_insert_rowid(db);
                }
            }
            int reset = entity_status(db, sqlite3_reset(s), error);
            if (rc == SQLITE_OK) rc = reset;
            if (rc == SQLITE_OK) rc = entity_status(db, sqlite3_clear_bindings(s), error);
        }
    }
    int end = entity_status(db, sqlite3_finalize(s), error);
    if (rc == SQLITE_OK) rc = end;
    rc = entity_transaction(db, rc, error);
    if (rc == SQLITE_OK && batch) *result = 1;
    return rc;
}

static void entity_select(struct entity_sql *q, const struct entity_model *m)
{
    entity_sql_init(q, "SELECT ");
    for (size_t i = 0; i < m->nfields; ++i) {
        if (i) g_string_append_c(q->text, ',');
        g_string_append_printf(q->text, "\"%s\"", m->fields[i].column);
    }
    g_string_append_printf(q->text, " FROM %s WHERE ", m->table);
}

static struct json_object *entity_row(sqlite3_stmt *s, const struct entity_model *m)
{
    struct json_object *row = json_object_new_object();
    for (size_t i = 0; i < m->nfields; ++i) {
        const struct entity_field *f = m->fields + i;
        if (!f->output || !f->json) continue;
        struct json_object *v;
        if (f->type == 's' || f->type == 'c') {
            const char *text = (const char *)sqlite3_column_text(s, (int)i);
            v = json_object_new_string_len(text ? text : "", sqlite3_column_bytes(s, (int)i));
        } else if (f->type == 'b') v = json_object_new_int64(sqlite3_column_int64(s, (int)i));
        else v = json_object_new_int(sqlite3_column_int(s, (int)i));
        json_object_object_add(row, f->json, v);
    }
    return row;
}

static int entity_group_active(struct json_object *row)
{
    const char *text = native_string(row, "exparams", "");
    struct json_object *extra = *text ? json_tokener_parse(text) : NULL;
    struct json_object *state = native_get(extra, "groupState");
    int active = !entity_number(state, 1) || json_object_get_int64(state) == 0;
    json_object_put(extra);
    return active;
}

static int entity_query(sqlite3 *db, struct entity_sql *q, const struct entity_model *m,
                        size_t limit, int active, struct json_object **rows,
                        size_t *total, int *maxid, struct json_object **error)
{
    sqlite3_stmt *s = NULL;
    int rc = entity_prepare(db, q, &s, error);
    *rows = NULL;
    *total = 0;
    *maxid = 0;
    size_t added = 0;
    if (rc == SQLITE_OK) {
        while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
            ++*total;
            if (added >= limit) { rc = SQLITE_DONE; break; }
            struct json_object *row = entity_row(s, m);
            if (active && !entity_group_active(row)) { json_object_put(row); continue; }
            if (!*rows) *rows = json_object_new_array();
            if (!row || !*rows || json_object_array_add(*rows, row)) {
                json_object_put(row);
                rc = SQLITE_NOMEM;
                break;
            }
            *maxid = (int)native_integer(row, "id", 0);
            ++added;
        }
        if (rc == SQLITE_DONE) rc = SQLITE_OK;
    }
    entity_status(db, rc, error);
    int end = entity_status(db, sqlite3_finalize(s), error);
    return rc == SQLITE_OK ? end : rc;
}

static int entity_multimatch(struct json_object *p, struct json_object **match)
{
    *match = native_get(p, "_multimatchinfo");
    struct json_object *a = native_get(*match, "datalist");
    int64_t n = entity_integer(*match, "datalen", -1);
    return entity_object(*match) && entity_array(a) && n >= 0 &&
        n <= 46 && (uint64_t)n <= json_object_array_length(a) &&
        entity_number(native_get(*match, "operationtype"), 1);
}

static struct json_object *entity_match(struct json_object *m, int key)
{
    struct json_object *a = native_get(m, "datalist");
    int64_t n = entity_integer(m, "datalen", 0);
    for (int64_t i = 0; i < n; ++i) {
        struct json_object *v = json_object_array_get_idx(a, (size_t)i);
        if (entity_integer(v, "keytype", 0) == key) return native_get(v, "match_value");
    }
    return NULL;
}

static const char *entity_match_text(struct json_object *m, int key)
{
    struct json_object *v = entity_match(m, key);
    return entity_text(v) ? json_object_get_string(v) : "";
}

static void entity_intersection(struct entity_sql *q, struct json_object *accounts);

static int entity_simple_predicate(struct entity_sql *q, const struct entity_model *m,
                                   int key, struct json_object *v, int deleting)
{
    const char *column = NULL;
    int numeric = 0, all = 0, list = 0;
    const char *text = entity_text(v) ? json_object_get_string(v) : "";
    if (m == &custom_model) {
        if (key == 5) all = 1;
        else if (key == 1) column = "CTAGID";
        else if (deleting && key == 0) { column = "AUTOID"; numeric = 1; }
    } else if (m == &custommem_model) {
        if (key == 5) all = 1;
        else if (key == 1) column = "CTAGID";
        else if (key == 2) column = "CID";
    } else if (m == &staff_model) {
        if (key == 38) all = 1;
        else if (key == 1) { column = "STAFFID"; numeric = 1; }
        else if (key == 2) column = "ACCOUNT";
        else if (deleting && key == 0) { column = "AUTOID"; numeric = 1; }
        else if (!deleting && key == 11) column = "EMAIL";
        else if (!deleting && key == 37) {
            char *pattern = g_strconcat("%", text, NULL);
            g_string_append(q->text, "MOBILEPHONE LIKE ");
            entity_string_value(q, pattern);
            g_string_append(q->text, " OR OFFICEPHONE = ");
            entity_string_value(q, pattern);
            g_string_append(q->text, " OR OTHERPHONE = ");
            entity_string_value(q, pattern);
            g_free(pattern);
            return 1;
        }
    } else if (m == &contact_model) {
        if (key == 1) {
            if (!deleting && strchr(text, ',')) {
                entity_csv_in(q, "CONTACTID", text);
                return 1;
            }
            column = "CONTACTID";
        } else if (key == 40) {
            if (deleting) all = 1;
            else if (!*text) {
                g_string_append(q->text, "CONTACTID != '' AND CONTACTID != '0'");
                return 1;
            } else {
                entity_csv_in(q, "ACCOUNT", text);
                return 1;
            }
        } else if (key == 47) column = "SHOWACCOUNT";
        else if (key == 49) { column = "ISEXTERNALCONTACT"; numeric = 1; }
        else if (deleting && key == 0) { column = "AUTOID"; numeric = 1; }
        else if (!deleting && key == 3) column = "ACCOUNT";
        else if (!deleting && key == 13) column = "EMAIL";
        else if (!deleting && key == 48) {
            g_string_append(q->text, *text ? "0" : "CONTACTID IS NOT NULL");
            return 1;
        } else if (!deleting && (key == 39 || key == 41 || key == 46)) {
            static const char *const names[] = {
                "NAME", "QPINYIN", "FOREIGNNAME", "NATIVENAME",
                "NICKNAME", "DEPTNAMECN", "ADDRESS"
            };
            static const char *const phones[] = {
                "BINDNO", "MOBILEPHONE", "IPPHONE", "OFFICEPHONE", "OTHERPHONE",
                "SHORTPHONE", "VOIP", "HOMEPHONE", "OTHERPHONE2",
                "OFFICEPHONE2", "ESPACENUMBER", "EMAIL", "FAX", "SHOWACCOUNT"
            };
            if (key == 41) {
                for (size_t i = 0; i < G_N_ELEMENTS(names); ++i) {
                    if (i) g_string_append(q->text, " OR ");
                    entity_like(q, names[i], text, 0, 1);
                }
                g_string_append(q->text, " OR ");
            }
            size_t n = key == 41 ? G_N_ELEMENTS(phones) : 11;
            for (size_t i = 0; i < n; ++i) {
                if (i) g_string_append(q->text, " OR ");
                if (key == 46) entity_equal(q, phones[i], v, 0);
                else entity_like(q, phones[i], text, 0, 1);
            }
            return 1;
        }
    } else if (m == &group_model) {
        if (key == 16) all = 1;
        else if (key == 1) column = "GROUPID";
        else if (key == 0) { column = "AUTOID"; numeric = 1; }
        else if (key == 31) { column = "GROUPID"; list = 1; }
    } else if (m == &config_model) {
        if (key == 7) all = 1;
        else if (key == 1) column = "GROUPID";
        else if (deleting && key == 0) { column = "AUTOID"; numeric = 1; }
    } else if (m == &collection_model) {
        if (key == 5) all = 1;
        else if (key == 0) column = "COLLECTIONID";
    } else if (m == &collectionmem_model) {
        if (key == 4) all = 1;
        else if (key == 1) column = "COLLECTIONID";
        else if (key == 2) column = "GROUPID";
    } else if (m == &avatar_model || m == &official_model) {
        if (key == 2) all = 1;
        else if (key == 0) { column = "AUTOID"; numeric = 1; }
        else if (key == 1) column = m == &avatar_model ? "ACCOUNT" : "NODEID";
    } else if (m == &category_model) {
        if (key == 6) all = 1;
        else if (key == 1) column = "CATEGORYID";
        else if (key == 2) { column = "CATEGORYID"; list = 1; }
        else if (key == 3) { column = "SOURCETYPE"; numeric = 1; }
        else if (deleting && key == 0) { column = "AUTOID"; numeric = 1; }
    } else if (m == &emoji_model) {
        if (key == 6) all = 1;
        else if (key == 1) { column = "EMOJITYPE"; numeric = 1; }
        else if (key == 2) column = "CATEGORYID";
        else if (key == 3) column = "EMOJIID";
        else if (key == 4) { column = "EMOJIID"; list = 1; }
        else if (deleting && key == 0) { column = "AUTOID"; numeric = 1; }
    } else if (m == &item_model) {
        if (key == 5) all = 1;
        else if (key == 1) column = "CATEGORYID";
        else if (key == 2) column = "EMOJIID";
        else if (key == 3) { column = "EMOJIID"; list = 1; }
        else if (deleting && key == 0) { column = "AUTOID"; numeric = 1; }
    } else if (m == &index_model) {
        if (key == 0) all = 1;
        else if (key == 2) column = "GROUPID";
    }
    if (all) g_string_append_c(q->text, '1');
    else if (!column) return 0;
    else if (list) entity_in(q, column, v);
    else entity_equal(q, column, v, numeric);
    return 1;
}

static int entity_member_predicate(struct entity_sql *q, struct json_object *m, int deleting)
{
    int op = (int)entity_integer(m, "operationtype", -1);
    int second = -1;
    const char *column = NULL;
    int numeric = 0;
    if (deleting) {
        if (op == 7) { g_string_append_c(q->text, '1'); return 1; }
        if (op == 0) {
            entity_equal(q, "AUTOID", entity_match(m, 0), 1);
            return 1;
        }
        if (op == 14) { entity_in(q, "GROUPID", entity_match(m, 14)); return 1; }
        if (op == 13) {
            entity_equal(q, "GROUPID", entity_match(m, 1), 0);
            g_string_append(q->text, " AND ");
            entity_in(q, "ACCOUNT", entity_match(m, 13));
            return 1;
        }
        if (op == 1) column = "GROUPID";
        else if (op == 3) { column = "ACCOUNT"; second = 1; }
        else if (op == 12) { column = "SHOWACCOUNT"; second = 1; }
        else if (op == 6) {
            entity_equal(q, "GROUPID", entity_match(m, 1), 0);
            g_string_append(q->text, " AND ");
            entity_equal(q, "MEMBERSTAFFID", entity_match(m, 6), 1);
            return 1;
        } else return 0;
    } else {
        if (op == 1) column = "GROUPID";
        else if (op == 2) { column = "MEMBERSTAFFID"; numeric = 1; }
        else if (op == 3 || op == 12) {
            column = op == 3 ? "ACCOUNT" : "SHOWACCOUNT";
            if (*entity_match_text(m, 1)) second = 1;
        } else if (op == 6) {
            entity_equal(q, "GROUPID", entity_match(m, 1), 0);
            g_string_append(q->text, " AND ");
            entity_equal(q, "MEMBERSTAFFID", entity_match(m, 2), 1);
            return 1;
        } else if (op == 9) {
            entity_like(q, "ACCOUNT", entity_match_text(m, 9), 1, 1);
            g_string_append(q->text, " OR ");
            entity_like(q, "MEMBERNAME", entity_match_text(m, 9), 1, 1);
            g_string_append(q->text, " OR ");
            entity_equal(q, "QPINYIN", entity_match(m, 9), 0);
            return 1;
        } else if (op == 13) {
            entity_in(q, "ACCOUNT", entity_match(m, 13));
            return 1;
        } else if (op == 14) {
            entity_in(q, "GROUPID", entity_match(m, 14));
            int64_t id = entity_match_number(entity_match(m, 0));
            if (id > 0) {
                g_string_append(q->text, " AND AUTOID > ");
                entity_integer_value(q, id);
            }
            g_string_append(q->text, " ORDER BY AUTOID ASC");
            return 1;
        } else if (op == 15) {
            g_string_append(q->text, "GROUPID IN (");
            entity_intersection(q, entity_match(m, 15));
            g_string_append(q->text, ") GROUP BY GROUPID");
            return 1;
        } else if (op == 16 || op == 17 || op == 19) {
            entity_equal(q, "ACCOUNT", entity_match(m, 3), 0);
            g_string_append(q->text, " AND ");
            if (op == 19) {
                g_string_append_c(q->text, '(');
                entity_equal(q, "MUTESTATE", entity_match(m, 18), 1);
                g_string_append(q->text, " OR ");
                entity_equal(q, "MEMBERTYPE", entity_match(m, 16), 1);
                g_string_append(q->text, " OR ");
                entity_equal(q, "MARKSTATE", entity_match(m, 17), 1);
                g_string_append_c(q->text, ')');
            } else entity_equal(q, op == 16 ? "MEMBERTYPE" : "MARKSTATE", entity_match(m, op), 1);
            return 1;
        } else return 0;
    }
    entity_equal(q, column, entity_match(m, op), numeric);
    if (second == 1) {
        g_string_append(q->text, " AND ");
        entity_equal(q, "GROUPID", entity_match(m, 1), 0);
    }
    if (!deleting && op == 1) g_string_append(q->text, " ORDER BY AUTOID ASC");
    return 1;
}

static int entity_group_predicate(struct entity_sql *q, struct json_object *m)
{
    int op = (int)entity_integer(m, "operationtype", -1);
    if ((op == 8 || op == 27) && !*entity_match_text(m, op)) {
        g_string_append_c(q->text, '0');
        return 1;
    }
    if (op == 1 || op == 8) {
        entity_equal(q, op == 1 ? "GROUPID" : "GROUPTYPE", entity_match(m, op), op == 8);
    } else if (op == 16) {
        struct json_object *ids = entity_match(m, 31);
        if (entity_array(ids) && json_object_array_length(ids)) entity_in(q, "GROUPID", ids);
        else g_string_append_c(q->text, '1');
    } else if (op == 17) {
        struct json_object *words = entity_match(m, 17);
        size_t count = entity_array(words) ? json_object_array_length(words) : 0;
        if (!count) { g_string_append_c(q->text, '0'); return 1; }
        for (int column = 0; column < 2; ++column) {
            if (column) g_string_append(q->text, " OR ");
            g_string_append_c(q->text, '(');
            for (size_t i = 0; i < count; ++i) {
                if (i) g_string_append(q->text, " AND ");
                struct json_object *v = json_object_array_get_idx(words, i);
                entity_like(q, column ? "ENNAME" : "NAME",
                    entity_text(v) ? json_object_get_string(v) : "", 1, 1);
            }
            g_string_append_c(q->text, ')');
        }
    } else if (op == 27) {
        g_string_append(q->text, "GROUPID IN (SELECT DISTINCT GROUPID FROM UniGroupMemberTab WHERE ");
        entity_csv_in(q, "ACCOUNT", entity_match_text(m, 27));
        g_string_append_c(q->text, ')');
    } else return 0;
    return 1;
}

static int entity_link_delete(struct entity_sql *q, const struct entity_model *model,
                              struct json_object *m)
{
    int custom = model == &custommem_model;
    int op = (int)entity_integer(m, "operationtype", -1);
    if (op == (custom ? 5 : 4)) g_string_append_c(q->text, '1');
    else if (op == 0) entity_equal(q, "AUTOID", entity_match(m, 0), 1);
    else if (op == 1) entity_equal(q, custom ? "CTAGID" : "COLLECTIONID", entity_match(m, 1), 0);
    else if (op == 2) entity_equal(q, custom ? "CID" : "GROUPID", entity_match(m, 2), 0);
    else if (op == (custom ? 4 : 3)) {
        entity_equal(q, custom ? "CTAGID" : "COLLECTIONID", entity_match(m, 1), 0);
        g_string_append(q->text, " AND ");
        entity_equal(q, custom ? "CID" : "GROUPID", entity_match(m, 2), 0);
    } else return 0;
    return 1;
}

static const char *entity_group_column(int key)
{
    static const char *const columns[] = {
        "AUTOID", "GROUPID", "GROUP_GROUPID", "CAPACITY", "NAME", "ENNAME", "OWNER",
        "DESC", "GROUPTYPE", "JOINFLAG", "MANIFESTO", "MSGPOLICYTYPE", "STATE",
        "SETTOP", "ORDERBY", "TIMESTAMP", NULL, NULL, "ISFIXED", "EXPARAMS",
        "SINGLEFILESPACE", "GROUPSPACEID", "GROUPSPACENAME", "ISINITGROUPNAME",
        "SYNCMEMBERTIME2", "SINGLEFILESPACESTR", "TEAMNOTIFYISREAD", NULL,
        "TENANTID", "CROSSCROPGROUP", "GROUPEXTDATA", NULL, "ISGROUPDISABLESENDMSG",
        "ENABLEEXTERNALDISPLAY", "SHOWHISMSGPOLICY", "DEFAULTICONLIST", "GROUPICON", "MARKSTATE"
    };
    return key >= 0 && (size_t)key < G_N_ELEMENTS(columns) ? columns[key] : NULL;
}

static int entity_update_group(sqlite3 *db, struct json_object *m, struct json_object **error)
{
    int64_t count = entity_integer(m, "_datalen", -1);
    struct json_object *list = native_get(m, "_datalist");
    struct json_object *condition = native_get(m, "condition_value");
    const char *column = entity_group_column((int)entity_integer(m, "condition_keytype", -1));
    if (!entity_object(m) || !entity_array(list) || count < 1 ||
        (uint64_t)count > json_object_array_length(list) || !column || !entity_text(condition))
        return SQLITE_MISMATCH;
    struct entity_sql q;
    entity_sql_init(&q, "UPDATE GroupTab SET ");
    for (int64_t i = 0; i < count; ++i) {
        struct json_object *item = json_object_array_get_idx(list, (size_t)i);
        const char *field = entity_group_column((int)entity_integer(item, "keytype", -1));
        struct json_object *value = native_get(item, "match_value");
        int type = (int)entity_integer(item, "datatype", -1);
        if (!field || type < 0 ||
            (type == 0 ? !entity_number(value, 0) : !entity_text(value))) {
            q.error = SQLITE_MISMATCH;
            break;
        }
        if (i) g_string_append_c(q.text, ',');
        g_string_append_printf(q.text, "%s = ", field);
        entity_value(&q, value);
    }
    g_string_append_printf(q.text, " WHERE %s = ", column);
    entity_value(&q, condition);
    int rc = entity_execute(db, &q, error);
    entity_sql_clear(&q);
    return rc;
}

static int entity_update_match(sqlite3 *db, const struct entity_model *model,
                               struct json_object *m, struct json_object **error)
{
    int op = (int)entity_integer(m, "operationtype", -1);
    int key = 1, value = op, numeric = 1;
    const char *column = NULL, *condition = NULL;
    if (model == &config_model) {
        static const char *const columns[] = {
            NULL, NULL, "MUTENOTIFICATIONS", "SAVETOCONTACT", "STICKONTOP", "INVITEPERMISSION"
        };
        if (op >= 2 && op <= 5 && entity_integer(m, "datalen", 0) < 6)
            column = columns[op];
        condition = "GROUPID";
    } else if (model == &note_model && op == 2) {
        column = "GROUPNOTEITEM"; condition = "GROUPNOTEID"; key = 2; value = 3; numeric = 0;
    } else if (model == &category_model && (op == 4 || op == 5)) {
        column = op == 4 ? "INDEXNO" : "LASTSYNCTIME";
        condition = "CATEGORYID"; numeric = op == 4;
    } else if (model == &emoji_model && op == 5) {
        column = "INDEXNO"; condition = "EMOJIID"; key = 3;
    } else if (model == &item_model && op == 4) {
        column = "INDEXNO"; condition = "EMOJIID"; key = 2;
    }
    if (!column) return SQLITE_MISMATCH;
    struct entity_sql q;
    entity_sql_init(&q, "UPDATE ");
    g_string_append_printf(q.text, "%s SET ", model->table);
    entity_equal(&q, column, entity_match(m, value), numeric);
    g_string_append(q.text, " WHERE ");
    entity_equal(&q, condition, entity_match(m, key), 0);
    int rc = entity_execute(db, &q, error);
    entity_sql_clear(&q);
    return rc;
}

/* Command 107 uses the same conversation row encoder as the normal history
 * dispatcher, but reads its existing database without attaching another file. */
static const struct entity_field entity_conversation_fields[] = {
    {"AUTOID", "id", 'i', 0, 1},
    {"CONVERSATION_TYPE", "convtype", 'i', 0, 1},
    {"ACCOUNT", "account", 's', 0, 1},
    {"CONTACTAUTOID", "contactautoid", 'i', 0, 1},
    {"GROUPID", "groupid", 's', 0, 1},
    {"LAST_MESSAGE_RECORDID", "lastmessagerecordid", 'i', 0, 1},
    {"UNREADMSG", "unreadmsg", 'i', 0, 1},
    {"UNREADCALL", "unreadcall", 'i', 0, 1},
    {"ISDELETE", "isdelete", 'i', 0, 1},
    {"STICKONTOP", "stickontop", 'i', 0, 1},
    {"TIMESTAMP", "timestamp", 's', 0, 1},
    {"CONTACTID", "contactid", 's', 0, 1},
    {"LASTSERVERMESSAGEID", "lastservermessageid", 's', 0, 1},
    {"CONVERSATION_ID", "convid", 's', 0, 1},
    {"EXPARAMS", "exparams", 's', 0, 1},
    {"TOPOPERATETIME", "topoperatetime", 's', 0, 1},
    {"CONTACTINFO", "contact", 's', 0, 1},
    {"LASTMESSAGEINFO", "lastMessageInfo", 's', 0, 1},
    {"SENDERLASTMARKTIME", "senderLastMarkTime", 'b', 0, 1},
    {"RECEIVERLASTMARKTIME", "receiverLastMarkTime", 'b', 0, 1},
    {"UNREADCOUNT", "unReadCount", 'i', 0, 1},
    {"UNACCEPTCOUNT", "unAcceptCount", 'i', 0, 1},
    {"SOURCE", "source", 'i', 0, 1},
    {"MSGNOTDISTURB", "isSetMessageNotDisturb", 'i', 0, 1},
    {"DRAFT", "draft", 's', 0, 1},
    {"RCMSGSTATE", "rcMsgState", 'i', 0, 1},
    {"AUTOTRANSLATE", "autoTranslate", 'i', 0, 1},
    {"EMOJIREPLYMSGIDS", "emojiReplyMsgIds", 's', 0, 1},
    {"EMOJIREPLYTIMESTAMP", "emojiReplyTimestamp", 'b', 0, 1},
    {"INVITESYNCTIME", "inviteSyncTime", 'b', 0, 1},
    {"ISVIP", "isVip", 's', 0, 1},
    {"NLEVEL", "nlevel", 'i', 0, 1},
    {"APPREPLYMSGIDS", "appReplyMsgIds", 's', 0, 1},
    {"APPREPLYTIMESTAMP", "appReplyTimestamp", 'b', 0, 1},
    {"FIRSTTIMESTAMP", "firstTimestamp", 's', 0, 1},
    {"ISDELETEINHIS", "isDeleteInHis", 'i', -1, 1}
};
static const struct entity_model entity_conversation_model = {
    "conversationdb", "ConversationTab", NULL, NULL, NULL,
    entity_conversation_fields, G_N_ELEMENTS(entity_conversation_fields), 0, NULL, 0
};

static void entity_intersection(struct entity_sql *q, struct json_object *accounts)
{
    size_t n = entity_array(accounts) ? json_object_array_length(accounts) : 0;
    size_t used = 0;
    for (size_t i = 0; i < n; ++i) {
        struct json_object *account = json_object_array_get_idx(accounts, i);
        if (!entity_text(account)) continue;
        if (used++) g_string_append(q->text, " INTERSECT ");
        g_string_append(q->text, "SELECT GROUPID FROM UniGroupMemberTab WHERE ACCOUNT = ");
        entity_value(q, account);
    }
    if (!used) g_string_append(q->text, "SELECT GROUPID FROM UniGroupMemberTab WHERE 0");
}

static void entity_array_append(struct json_object **a, struct json_object *v)
{
    if (!*a) *a = json_object_new_array();
    json_object_array_add(*a, json_object_get(v));
}

static size_t entity_length(struct json_object *a)
{
    return entity_array(a) ? json_object_array_length(a) : 0;
}

static int entity_repeated(struct im_db_context *context, struct json_object *m,
                           struct json_object **out, int *result, struct json_object **error)
{
    struct json_object *items = native_get(m, "datalist");
    size_t count = 0;
    for (int64_t i = 0; i < entity_integer(m, "datalen", 0); ++i) {
        struct json_object *item = json_object_array_get_idx(items, (size_t)i);
        struct json_object *value = native_get(item, "match_value");
        if (entity_array(value)) {
            count = entity_length(value);
            if (count >= 10) break;
        }
    }
    if (count >= 10) {
        *out = entity_reason("match_value greater than equal to ten!");
        *result = -1;
        return SQLITE_OK;
    }
    if (!count) {
        *out = entity_reason("Account number is 0!");
        *result = 3;
        return SQLITE_OK;
    }
    struct entity_sql q;
    entity_select(&q, &group_model);
    g_string_append(q.text, "GROUPID IN (SELECT GROUPID FROM UniGroupMemberTab WHERE ");
    if (!entity_member_predicate(&q, m, 0)) {
        entity_sql_clear(&q);
        return SQLITE_MISMATCH;
    }
    g_string_append(q.text, ") AND (SELECT COUNT(*) FROM UniGroupMemberTab AS members "
        "WHERE members.GROUPID = GroupTab.GROUPID) = ");
    entity_integer_value(&q, (int64_t)count);
    struct json_object *groups = NULL, *conversations = NULL;
    size_t total = 0;
    int maxid = 0;
    int rc = entity_query(im_db_database(context, "userdb"), &q, &group_model,
                          900, 1, &groups, &total, &maxid, error);
    entity_sql_clear(&q);
    if (rc != SQLITE_OK) { json_object_put(groups); return rc; }
    if (!entity_length(groups)) {
        json_object_put(groups);
        *out = entity_reason("Repeated group not exist!");
        *result = 2;
        return SQLITE_OK;
    }
    struct json_object *ids = json_object_new_array();
    GHashTable *remaining = g_hash_table_new(g_str_hash, g_str_equal);
    for (size_t i = 0; i < entity_length(groups); ++i) {
        struct json_object *g = json_object_array_get_idx(groups, i);
        const char *id = native_string(g, "groupid", "");
        json_object_array_add(ids, json_object_new_string(id));
        g_hash_table_insert(remaining, (gpointer)id, g);
    }
    entity_select(&q, &entity_conversation_model);
    entity_in(&q, "GROUPID", ids);
    g_string_append(q.text, " ORDER BY TIMESTAMP DESC LIMIT 1024");
    json_object_put(ids);
    rc = entity_query(im_db_database(context, "conversationdb"), &q,
                      &entity_conversation_model, 1024, 0, &conversations, &total, &maxid, error);
    entity_sql_clear(&q);
    struct json_object *selected = NULL, *selected_conversations = NULL;
    if (rc == SQLITE_OK) {
        for (size_t i = 0; i < entity_length(conversations) && entity_length(selected) < 20; ++i) {
            struct json_object *c = json_object_array_get_idx(conversations, i);
            const char *id = native_string(c, "groupid", "");
            struct json_object *g = g_hash_table_lookup(remaining, id);
            if (!g || native_integer(g, "state", 0) == 1) continue;
            entity_array_append(&selected, g);
            entity_array_append(&selected_conversations, c);
            g_hash_table_remove(remaining, id);
        }
        for (size_t i = 0; i < entity_length(groups) && entity_length(selected) < 20; ++i) {
            struct json_object *g = json_object_array_get_idx(groups, i);
            if (native_integer(g, "state", 0) == 1 ||
                !g_hash_table_contains(remaining, native_string(g, "groupid", ""))) continue;
            entity_array_append(&selected, g);
        }
        *out = json_object_new_object();
        *result = entity_length(selected) != 0;
        json_object_object_add(*out, "_retlen", json_object_new_int64((int64_t)entity_length(selected)));
        json_object_object_add(*out, "_groupinfolist", selected);
        json_object_object_add(*out, "_conversationinfolist", selected_conversations);
    }
    g_hash_table_destroy(remaining);
    json_object_put(groups);
    json_object_put(conversations);
    return rc;
}

static int entity_filter_one(sqlite3 *db, struct json_object *p,
                             struct json_object **out, int *result, struct json_object **error)
{
    struct json_object *ids = native_get(p, "groupIdList");
    const char *account = native_string(p, "account", "");
    if (!entity_array(ids)) return SQLITE_MISMATCH;
    sqlite3_stmt *s = NULL;
    int rc = entity_status(db, sqlite3_prepare_v2(db,
        "SELECT ACCOUNT FROM UniGroupMemberTab WHERE GROUPID = ? ORDER BY AUTOID ASC",
        -1, &s, NULL), error);
    struct json_object *selected = NULL;
    for (size_t i = 0; rc == SQLITE_OK && i < json_object_array_length(ids); ++i) {
        struct json_object *id = json_object_array_get_idx(ids, i);
        if (!entity_text(id)) continue;
        rc = entity_status(db, sqlite3_bind_text(s, 1, json_object_get_string(id), -1, SQLITE_TRANSIENT), error);
        if (rc != SQLITE_OK) break;
        rc = sqlite3_step(s);
        int matches = 0;
        if (rc == SQLITE_ROW) {
            const char *stored = (const char *)sqlite3_column_text(s, 0);
            matches = stored && !strcmp(stored, account);
            rc = sqlite3_step(s);
            if (rc == SQLITE_ROW) matches = 0;
            while (rc == SQLITE_ROW) rc = sqlite3_step(s);
        }
        if (rc == SQLITE_DONE) {
            rc = SQLITE_OK;
            if (matches) entity_array_append(&selected, id);
        }
        entity_status(db, rc, error);
        int reset = entity_status(db, sqlite3_reset(s), error);
        if (rc == SQLITE_OK) rc = reset;
    }
    int end = entity_status(db, sqlite3_finalize(s), error);
    if (rc == SQLITE_OK) rc = end;
    if (rc == SQLITE_OK) {
        *out = json_object_new_object();
        json_object_object_add(*out, "resultGroupIdNum", json_object_new_int64((int64_t)entity_length(selected)));
        json_object_object_add(*out, "resultGroupIdList", selected);
        *result = 1;
    } else json_object_put(selected);
    return rc;
}

static int entity_old_group_order(const void *left, const void *right)
{
    const struct json_object *const *a = left, *const *b = right;
    return strcmp(native_string((struct json_object *)*a, "lastMessageTime", ""),
                  native_string((struct json_object *)*b, "lastMessageTime", ""));
}

static int entity_old_groups(struct im_db_context *context, struct json_object **out,
                             int *result, struct json_object **error)
{
    struct json_object *lists[2] = {NULL, NULL};
    int rc = SQLITE_OK;
    *result = 0;
    for (int type = 0; rc == SQLITE_OK && type < 2; ++type) {
        struct entity_sql q;
        entity_select(&q, &group_model);
        g_string_append(q.text, "GROUPTYPE = ");
        entity_integer_value(&q, type);
        struct json_object *groups = NULL;
        size_t total = 0;
        int maxid = 0;
        rc = entity_query(im_db_database(context, "userdb"), &q, &group_model,
                          SIZE_MAX, 1, &groups, &total, &maxid, error);
        entity_sql_clear(&q);
        GHashTable *lookup = g_hash_table_new(g_str_hash, g_str_equal);
        for (size_t i = 0; i < entity_length(groups); ++i) {
            struct json_object *g = json_object_array_get_idx(groups, i);
            g_hash_table_insert(lookup, (gpointer)native_string(g, "groupid", ""), g);
        }
        if (rc == SQLITE_OK && g_hash_table_size(lookup)) {
            char cutoff[32];
            g_snprintf(cutoff, sizeof(cutoff), "%" G_GINT64_FORMAT,
                       g_get_real_time() / 1000 - G_GINT64_CONSTANT(2592000000));
            int have_conversation = 0;
            size_t count = entity_length(groups);
            /* QueryGroupChat originally receives at most 500 IDs per call.
             * Keep the cutoff common to all chunks and sort only after merging. */
            for (size_t offset = 0; rc == SQLITE_OK && offset < count; offset += 500) {
                size_t end = offset + MIN((size_t)500, count - offset);
                entity_sql_init(&q, "SELECT GROUPID,TIMESTAMP FROM ConversationTab "
                                    "WHERE CONVERSATION_TYPE = 1 AND CONVERSATION_ID IN (");
                for (size_t i = offset; i < end; ++i) {
                    if (i != offset) g_string_append_c(q.text, ',');
                    struct json_object *g = json_object_array_get_idx(groups, i);
                    entity_value(&q, native_get(g, "groupid"));
                }
                g_string_append(q.text, ") AND TIMESTAMP <= ");
                entity_string_value(&q, cutoff);
                sqlite3_stmt *s = NULL;
                sqlite3 *conversation_db = im_db_database(context, "conversationdb");
                rc = entity_prepare(conversation_db, &q, &s, error);
                if (rc == SQLITE_OK) {
                    while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
                        have_conversation = 1;
                        const char *id = (const char *)sqlite3_column_text(s, 0);
                        const char *stamp = (const char *)sqlite3_column_text(s, 1);
                        struct json_object *g = id ? g_hash_table_lookup(lookup, id) : NULL;
                        if (!g) continue;
                        struct json_object *row = json_object_new_object();
                        static const char *const from[] = {"groupid", "grouptype", "name", "enname", "groupIcon"};
                        static const char *const to[] = {"groupId", "groupType", "groupName", "groupNameEn", "groupIcon"};
                        for (size_t i = 0; i < G_N_ELEMENTS(from); ++i)
                            json_object_object_add(row, to[i], json_object_get(native_get(g, from[i])));
                        json_object_object_add(row, "lastMessageTime", json_object_new_string(stamp ? stamp : ""));
                        entity_array_append(&lists[type], row);
                        json_object_put(row);
                    }
                    if (rc == SQLITE_DONE) rc = SQLITE_OK;
                }
                entity_status(conversation_db, rc, error);
                int finalized = entity_status(conversation_db, sqlite3_finalize(s), error);
                if (rc == SQLITE_OK) rc = finalized;
                entity_sql_clear(&q);
            }
            if (rc == SQLITE_OK && have_conversation) *result = 1;
        }
        g_hash_table_destroy(lookup);
        json_object_put(groups);
        if (lists[type]) json_object_array_sort(lists[type], entity_old_group_order);
    }
    if (rc == SQLITE_OK) {
        *out = json_object_new_object();
        json_object_object_add(*out, "fixedGroupInfoLen", json_object_new_int64((int64_t)entity_length(lists[0])));
        json_object_object_add(*out, "discussGroupInfoLen", json_object_new_int64((int64_t)entity_length(lists[1])));
        json_object_object_add(*out, "fixedGroupInfoList", lists[0]);
        json_object_object_add(*out, "discussGroupInfoList", lists[1]);
    } else {
        json_object_put(lists[0]);
        json_object_put(lists[1]);
    }
    return rc;
}

static int entity_userinfo(sqlite3 *db, struct json_object *p,
                           struct json_object **out, int *result, struct json_object **error)
{
    const char *account = native_string(native_get(p, "_matchinfo"), "accountid", NULL);
    if (!account || !*account) {
        *result = -1;
        *out = entity_reason(!account ? "accountid is not correct!" : "accountid is empty!");
        return SQLITE_OK;
    }
    struct entity_sql q;
    entity_sql_init(&q, "SELECT NAME,FOREIGNNAME FROM ContactTab WHERE ACCOUNT = ");
    entity_string_value(&q, account);
    g_string_append(q.text, " LIMIT 1");
    sqlite3_stmt *s = NULL;
    int rc = entity_prepare(db, &q, &s, error);
    if (rc == SQLITE_OK) {
        rc = sqlite3_step(s);
        if (rc == SQLITE_ROW) {
            struct json_object *row = json_object_new_object();
            json_object_object_add(row, "accountid", json_object_new_string(account));
            for (int i = 0; i < 2; ++i) {
                const char *text = (const char *)sqlite3_column_text(s, i);
                json_object_object_add(row, i ? "foreignName" : "name",
                                       json_object_new_string(text ? text : ""));
            }
            *out = json_object_new_object();
            json_object_object_add(*out, "UserInfo", row);
            *result = 1;
            rc = SQLITE_OK;
        } else if (rc == SQLITE_DONE) {
            *out = entity_reason("query userinfo by account from contact is failed!");
            *result = -1;
            rc = SQLITE_OK;
        }
    }
    entity_status(db, rc, error);
    int end = entity_status(db, sqlite3_finalize(s), error);
    if (rc == SQLITE_OK) rc = end;
    entity_sql_clear(&q);
    return rc;
}

struct entity_command {
    unsigned id;
    const struct entity_model *model;
    char operation;
    const char *field;
    size_t limit;
    const char *description;
};
#include "im_transport_db_entities_commands.inc"

static int entity_delete_match(sqlite3 *db, const struct entity_model *model,
                                struct json_object *p, struct json_object **error)
{
    struct json_object *m;
    if (!entity_multimatch(p, &m)) return SQLITE_MISMATCH;
    struct entity_sql q;
    entity_sql_init(&q, "DELETE FROM ");
    g_string_append_printf(q.text, "%s WHERE ", model->table);
    int valid = model == &member_model ? entity_member_predicate(&q, m, 1) :
                                        entity_link_delete(&q, model, m);
    int rc = valid ? entity_execute(db, &q, error) : SQLITE_MISMATCH;
    entity_sql_clear(&q);
    return rc;
}

static int entity_member_delete(sqlite3 *db, struct json_object *p, struct json_object **error)
{
    int rc = entity_status(db, sqlite3_exec(db, "SAVEPOINT im_entities", NULL, NULL, NULL), error);
    if (rc != SQLITE_OK) return rc;
    if (entity_array(p)) {
        size_t count = json_object_array_length(p);
        for (size_t i = 0; rc == SQLITE_OK && i < count; ++i)
            rc = entity_delete_match(db, &member_model, json_object_array_get_idx(p, i), error);
    } else rc = entity_delete_match(db, &member_model, p, error);
    return entity_transaction(db, rc, error);
}

static void entity_member_intersection_query(struct entity_sql *q, struct json_object *m)
{
    /* ExtractFromUniGroupMemberTab has a group-ID-only branch for this query;
     * all other fields retain FixedGroupMemberInfo's constructor defaults. */
    entity_sql_init(q, "SELECT ");
    for (size_t i = 0; i < member_model.nfields; ++i) {
        const struct entity_field *f = member_model.fields + i;
        if (i) g_string_append_c(q->text, ',');
        if (!strcmp(f->column, "GROUPID")) g_string_append(q->text, "GROUPID");
        else if (f->type == 's' || f->type == 'r') g_string_append(q->text, "''");
        else g_string_append_c(q->text, '0');
    }
    g_string_append(q->text, " FROM UniGroupMemberTab WHERE GROUPID IN (");
    entity_intersection(q, entity_match(m, 15));
    g_string_append(q->text, ") GROUP BY GROUPID");
}

static int entity_dispatch_query(sqlite3 *db, const struct entity_command *c,
                                 struct json_object *p, struct json_object **out,
                                 int *result, struct json_object **error)
{
    const struct entity_model *model = c->model;
    struct json_object *m = NULL;
    int key = -1, active = 0, valid = 1;
    struct entity_sql q;
    if (c->operation == 'M') {
        if (!entity_multimatch(p, &m)) return SQLITE_MISMATCH;
        key = (int)entity_integer(m, "operationtype", -1);
        if (model == &member_model && key == 15) entity_member_intersection_query(&q, m);
        else {
            entity_select(&q, model);
            if (model == &group_model) {
                valid = entity_group_predicate(&q, m);
                active = key == 17 || key == 27;
            } else if (model == &member_model) valid = entity_member_predicate(&q, m, 0);
            else if (key == 0) g_string_append_c(q.text, '1');
            else if (key == 1) entity_in(&q, "GROUPNOTEID", entity_match(m, 1));
            else valid = 0;
        }
    } else {
        m = native_get(p, "_matchinfo");
        struct json_object *v = native_get(m, "match_value");
        key = (int)entity_integer(m, "keytype", -1);
        if (!entity_object(m) || key < 0 || (!entity_text(v) && !entity_array(v)))
            return SQLITE_MISMATCH;
        entity_select(&q, model);
        valid = entity_simple_predicate(&q, model, key, v, 0);
        /* SingleExecute returns only the first matching row in the original SDK. */
        if ((model == &custom_model && key == 1) ||
            (model == &collection_model && key == 0) ||
            (model == &config_model && key == 1) ||
            (model == &staff_model && (key == 1 || key == 2)) ||
            (model == &contact_model && (key == 3 || key == 47 ||
                (key == 1 && !strchr(entity_text(v) ? json_object_get_string(v) : "", ',')))) ||
            (model == &category_model && key == 1) ||
            (model == &emoji_model && key == 3) ||
            (model == &item_model && key == 2) || (model == &index_model && key == 2))
            g_string_append(q.text, " LIMIT 1");
    }
    struct json_object *rows = NULL;
    size_t total = 0;
    int maxid = 0;
    int rc = valid ? entity_query(db, &q, model, c->limit, active, &rows, &total, &maxid, error) :
                     SQLITE_MISMATCH;
    entity_sql_clear(&q);
    if (rc != SQLITE_OK) { json_object_put(rows); return rc; }
    *out = json_object_new_object();
    json_object_object_add(*out, c->id == 127 ? "listLen" : "_retlen",
        json_object_new_int64((int64_t)entity_length(rows)));
    json_object_object_add(*out, c->field, rows);
    if (c->id == 40) {
        json_object_object_add(*out, "_retmaxrowid", json_object_new_int(maxid));
        json_object_object_add(*out, "_queryendflag", json_object_new_int(total <= 20480));
    }
    if (model == &custom_model || model == &custommem_model ||
        model == &group_model || model == &config_model || model == &member_model)
        *result = 1;
    else *result = total != 0;
    /* The collection-ID branch in the vendor wrapper explicitly returns false. */
    if (c->id == 66 && key == 1) *result = 0;
    return SQLITE_OK;
}

static int entity_dispatch_delete(sqlite3 *db, const struct entity_command *c,
                                  struct json_object *p, int *result, struct json_object **error)
{
    struct json_object *m = native_get(p, "_matchinfo");
    struct json_object *v = native_get(m, "match_value");
    int key = (int)entity_integer(m, "keytype", -1);
    if (!entity_object(m) || key < 0 || (!entity_text(v) && !entity_array(v)))
        return SQLITE_MISMATCH;
    struct entity_sql q;
    entity_sql_init(&q, "DELETE FROM ");
    g_string_append_printf(q.text, "%s WHERE ", c->model->table);
    int valid = entity_simple_predicate(&q, c->model, key, v, 1);
    int rc = valid ? SQLITE_OK : SQLITE_MISMATCH;
    if (rc == SQLITE_OK && c->id == 30 && key == 16) {
        rc = entity_status(db, sqlite3_exec(db, "SAVEPOINT im_entities", NULL, NULL, NULL), error);
        if (rc == SQLITE_OK) {
            struct entity_sql kv;
            entity_sql_init(&kv, "REPLACE INTO UserCommonKeyValueTab(KEY,VALUE) VALUES(");
            entity_string_value(&kv, entity_text(v) ? json_object_get_string(v) : "");
            g_string_append(kv.text, ",'0')");
            rc = entity_execute(db, &kv, error);
            entity_sql_clear(&kv);
            if (rc == SQLITE_OK) rc = entity_execute(db, &q, error);
            rc = entity_transaction(db, rc, error);
        }
    } else if (rc == SQLITE_OK) rc = entity_execute(db, &q, error);
    if (rc == SQLITE_OK) {
        if (c->id == 11) *result = key == 5 ? sqlite3_changes(db) : sqlite3_changes(db) != 0;
        else *result = 1;
    }
    entity_sql_clear(&q);
    return rc;
}

static const char *entity_invalid_reason(const struct entity_command *c, struct json_object *p)
{
    if (!entity_object(p)) return "param is not correct!";
    if (c->operation == 'D' || c->operation == 'Q') {
        struct json_object *m = native_get(p, "_matchinfo");
        if (!entity_object(m)) return "param is not correct!";
        if (!entity_number(native_get(m, "keytype"), 1)) return "keytype is not correct!";
        struct json_object *v = native_get(m, "match_value");
        if (!entity_text(v) && !entity_array(v)) return "match_value is not correct!";
    } else if (c->operation == 'B') {
        if (!entity_array(native_get(p, c->field))) return "param is not correct!";
        const char *key = c->id == 125 ? "listLen" : "_arraylen";
        if (!entity_number(native_get(p, key), 1))
            return c->id == 125 ? "listLen is not correct!" : "_arraylen is not correct!";
    } else if (c->operation == 'M' || c->operation == 'U' ||
               c->operation == 'R' || c->operation == 'X') {
        struct json_object *m = native_get(p, "_multimatchinfo");
        if (!entity_object(m) || !entity_array(native_get(m, "datalist")))
            return "param is not correct!";
        if (!entity_number(native_get(m, "operationtype"), 1))
            return "operationtype is not correct!";
        if (!entity_number(native_get(m, "datalen"), 1)) return "datalen is not correct!";
    }
    return "param is not correct!";
}

int im_db_entities(struct im_db_context *context, const struct native_request *request,
                   struct json_object **reply)
{
    unsigned id = (unsigned)(request->cmd & 0x2ffff);
    const struct entity_command *c = NULL;
    for (size_t i = 0; i < G_N_ELEMENTS(entity_commands); ++i)
        if (entity_commands[i].id == id) { c = entity_commands + i; break; }
    if (!c) return 0;
    sqlite3 *db = im_db_database(context, c->model->database);
    struct json_object *p = request->param, *out = NULL, *m = NULL;
    struct json_object *error = NULL;
    int result = 1, rc = db ? SQLITE_OK : SQLITE_CANTOPEN;
    if (rc == SQLITE_OK && !entity_object(p) && !(id == 39 && entity_array(p)) && id != 130)
        rc = SQLITE_MISMATCH;
    if (rc == SQLITE_OK) switch (c->operation) {
    case 'A': {
        struct json_object *row = native_get(p, c->field);
        if (!entity_object(row) || (id == 32 && !entity_object(native_get(p, "_matchinfo"))))
            rc = SQLITE_MISMATCH;
        else rc = entity_add(db, c->model, row, 1, 0, 0, &result, &error);
        break;
    }
    case 'B': {
        struct json_object *rows = native_get(p, c->field);
        int64_t count = entity_integer(p, id == 125 ? "listLen" : "_arraylen", -1);
        if (!entity_array(rows) || count < 0 || (uint64_t)count > json_object_array_length(rows) ||
            (id == 33 && !entity_object(native_get(p, "_matchinfo")))) rc = SQLITE_MISMATCH;
        else if (!count && id != 22 && id != 104) result = id == 85 ? -1 : 0;
        else rc = entity_add(db, c->model, rows, (size_t)count, 1,
                              id != 10 && id != 14 && id != 22 && id != 85, &result, &error);
        break;
    }
    case 'D':
        rc = entity_dispatch_delete(db, c, p, &result, &error);
        break;
    case 'Q':
    case 'M':
        rc = entity_dispatch_query(db, c, p, &out, &result, &error);
        break;
    case 'X':
        rc = id == 39 ? entity_member_delete(db, p, &error) :
                       entity_delete_match(db, c->model, p, &error);
        break;
    case 'U':
        if (!entity_multimatch(p, &m)) rc = SQLITE_MISMATCH;
        else rc = entity_update_match(db, c->model, m, &error);
        break;
    case 'G':
        rc = entity_update_group(db, native_get(p, c->field), &error);
        if (rc == SQLITE_OK) result = sqlite3_changes(db) != 0;
        break;
    case 'L': {
        struct json_object *rows = native_get(p, c->field);
        int64_t count = entity_integer(p, "_matchinfolen", -1);
        if (!entity_array(rows) || count < 0 || (uint64_t)count > entity_length(rows))
            rc = SQLITE_MISMATCH;
        else {
            rc = entity_status(db, sqlite3_exec(db, "SAVEPOINT im_entities", NULL, NULL, NULL), &error);
            if (rc == SQLITE_OK) {
                int changed = 0;
                for (int64_t i = 0; rc == SQLITE_OK && i < count; ++i) {
                    rc = entity_update_group(db, json_object_array_get_idx(rows, (size_t)i), &error);
                    if (rc == SQLITE_OK && sqlite3_changes(db)) changed = 1;
                }
                rc = entity_transaction(db, rc, &error);
                result = changed;
            }
        }
        break;
    }
    case 'R':
        if (!entity_multimatch(p, &m)) rc = SQLITE_MISMATCH;
        else rc = entity_repeated(context, m, &out, &result, &error);
        break;
    case 'F':
        rc = entity_filter_one(db, p, &out, &result, &error);
        break;
    case 'O':
        rc = entity_old_groups(context, &out, &result, &error);
        break;
    case 'I':
        rc = entity_userinfo(db, p, &out, &result, &error);
        break;
    default:
        rc = SQLITE_MISUSE;
        break;
    }
    if (rc != SQLITE_OK) {
        json_object_put(out);
        if (rc == SQLITE_MISMATCH && !error) {
            result = -1;
            out = c->operation == 'A' || c->operation == 'G' ? NULL :
                entity_reason(entity_invalid_reason(c, p));
        } else {
            result = -rc;
            out = error ? error : entity_reason(sqlite3_errstr(rc));
            error = NULL;
        }
    }
    *reply = im_db_reply(request, result, out, c->description);
    json_object_put(error);
    return 1;
}
