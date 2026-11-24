/* Focused synthetic driver for the real dynamically loaded contact library.
 * Build/run only after source completion; argv[1] is the built ia32 .so.
 * It creates only a fresh mkdtemp tree and never touches a real profile/network.
 */
#define _GNU_SOURCE
#include "contact_sqlite_plugin.h"
#include <dlfcn.h>
#include <errno.h>
#include <ftw.h>
#include <glib.h>
#include <json-c/json.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "contact regression: %s:%d: %s\n", __FILE__, __LINE__, #x); exit(1); } } while (0)
static struct {
    int (*SqliteServiceStartup)(contact_callback);
    void (*ContactPluginSetLogPath)(const char *);
    void (*SqliteRecvMsgImport)(const char *);
    void (*GabSqliteQueryAll)(const char *, contact_callback);
    void (*GabSqliteExec)(const char *, contact_callback);
    void (*GabSqliteQueryAllWithKey)(const char *, contact_callback, const char *);
    void (*GabSqliteExecWithKey)(const char *, contact_callback, const char *);
    int (*ContactPluginDispatchCallbacks)(void);
    void (*ContactPluginShutdown)(void);
} api;
static struct json_object *last_rpc, *last_direct;
static unsigned rpc_calls, direct_calls;
static int stop_in_rpc, reenter_direct;
static int64_t serial;
static pthread_t main_thread;

static struct json_object *get(struct json_object *object, const char *name)
{
    struct json_object *value = NULL;
    CHECK(object && json_object_is_type(object, json_type_object));
    CHECK(json_object_object_get_ex(object, name, &value));
    return value;
}

static int64_t integer(struct json_object *object, const char *name)
{
    struct json_object *value = get(object, name);
    CHECK(json_object_is_type(value, json_type_int));
    return json_object_get_int64(value);
}

static void nested_callback(const char *text)
{
    struct json_object *result = json_tokener_parse(text);
    CHECK(result && integer(result, "code") == 0);
    CHECK(integer(json_object_array_get_idx(get(result, "data"), 0), "nested") == 7);
    json_object_put(result);
}

static void rpc_callback(const char *text)
{
    CHECK(pthread_equal(pthread_self(), main_thread));
    json_object_put(last_rpc);
    last_rpc = json_tokener_parse(text);
    CHECK(last_rpc);
    ++rpc_calls;
    if (stop_in_rpc) { stop_in_rpc = 0; api.ContactPluginShutdown(); }
}

static void direct_callback(const char *text)
{
    CHECK(pthread_equal(pthread_self(), main_thread));
    json_object_put(last_direct);
    last_direct = json_tokener_parse(text);
    CHECK(last_direct);
    ++direct_calls;
    if (reenter_direct) {
        reenter_direct = 0;
        api.GabSqliteQueryAll("SELECT 7 AS nested", nested_callback);
    }
}

static struct json_object *rpc(int command, const char *param)
{
    struct json_object *request = json_object_new_object();
    json_object_object_add(request, "cmd", json_object_new_int(command));
    json_object_object_add(request, "sno", json_object_new_int64(++serial));
    json_object_object_add(request, "description", json_object_new_string("synthetic-contact"));
    struct json_object *data = json_tokener_parse(param);
    CHECK(data);
    json_object_object_add(request, "param", data);
    unsigned before = rpc_calls;
    api.SqliteRecvMsgImport(json_object_to_json_string_ext(request, JSON_C_TO_STRING_PLAIN));
    CHECK(rpc_calls == before);
    CHECK(api.ContactPluginDispatchCallbacks() == 1);
    CHECK(rpc_calls == before + 1);
    CHECK(integer(last_rpc, "rsp") == command && integer(last_rpc, "sno") == serial);
    CHECK(!strcmp(json_object_get_string(get(last_rpc, "description")), "synthetic-contact"));
    json_object_put(request);
    return last_rpc;
}

static void rpc_ok(int command, const char *param)
{
    CHECK(integer(rpc(command, param), "result") == 0);
}

static void init(const char *root, const char *account, int success)
{
    char *param = g_strdup_printf("{\"dbPath\":\"%s\",\"userAccount\":\"%s\","
        "\"kmcStorePath\":\"%s\",\"kmcStoreBakPath\":\"%s\",\"enableGabLib\":true}",
        root, account, root, root);
    struct json_object *reply = rpc(1, param);
    CHECK((integer(reply, "result") == 0) == success);
    CHECK(integer(reply, "ret") == (success ? 0 : 1));
    g_free(param);
}

static struct json_object *sql(const char *text, const char *keys, int query)
{
    unsigned before = direct_calls;
    if (keys) {
        if (query) api.GabSqliteQueryAllWithKey(text, direct_callback, keys);
        else api.GabSqliteExecWithKey(text, direct_callback, keys);
    } else if (query) api.GabSqliteQueryAll(text, direct_callback);
    else api.GabSqliteExec(text, direct_callback);
    CHECK(direct_calls == before + 1); /* per-call pointers never need pinning */
    return last_direct;
}

static struct json_object *first_row(struct json_object *reply)
{
    CHECK(integer(reply, "code") == 0);
    struct json_object *rows = get(reply, "data");
    CHECK(json_object_is_type(rows, json_type_array) && json_object_array_length(rows) >= 1);
    return json_object_array_get_idx(rows, 0);
}

static void *foreign_dispatch(void *unused)
{
    (void)unused;
    CHECK(api.ContactPluginDispatchCallbacks() == -EPERM);
    return NULL;
}

static char *read_file(const char *path, gsize *length)
{
    char *text = NULL;
    CHECK(g_file_get_contents(path, &text, length, NULL));
    return text;
}

static void same_file(const char *path, const char *expected, gsize length)
{
    gsize actual_length;
    char *actual = read_file(path, &actual_length);
    CHECK(length == actual_length && !memcmp(expected, actual, length));
    g_free(actual);
}

static int remove_fixture(const char *path, const struct stat *st, int kind, struct FTW *walk)
{
    (void)st; (void)kind; (void)walk;
    return remove(path);
}

int main(int argc, char **argv)
{
    CHECK(argc == 2);
    void *library = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!library) fprintf(stderr, "dlopen: %s\n", dlerror());
    CHECK(library);
#define LOAD(name) do { *(void **)(&api.name) = dlsym(library, #name); CHECK(api.name); } while (0)
    LOAD(SqliteServiceStartup); LOAD(ContactPluginSetLogPath); LOAD(SqliteRecvMsgImport);
    LOAD(GabSqliteQueryAll); LOAD(GabSqliteExec); LOAD(GabSqliteQueryAllWithKey); LOAD(GabSqliteExecWithKey);
    LOAD(ContactPluginDispatchCallbacks); LOAD(ContactPluginShutdown);
#undef LOAD
    CHECK(!dlsym(library, "GabReadZipFile")); /* proven-dead original export removed */
    main_thread = pthread_self();
    char temporary[] = "/tmp/welink-contact-regression-XXXXXX";
    char *root = mkdtemp(temporary);
    CHECK(root);
    api.ContactPluginSetLogPath(root);
    CHECK(api.SqliteServiceStartup(NULL) != 0);
    CHECK(api.ContactPluginDispatchCallbacks() == 0);
    CHECK(api.SqliteServiceStartup(rpc_callback) == 0);
    init(root, "public", 1);
    rpc_ok(2, "{\"_keyvalue\":{\"id\":0,\"strkey\":\"system-key\",\"strvalue\":\"value\"}}");
    rpc_ok(4, "{\"_matchinfo\":{\"keytype\":1,\"match_value\":\"system-key\"}}");
    CHECK(integer(get(last_rpc, "param"), "_retlen") == 1);
    rpc_ok(3, "{\"_matchinfo\":{\"keytype\":1,\"match_value\":\"system-key\"}}");
    init(root, "synthetic", 1);
    CHECK(integer(first_row(sql("SELECT version FROM schema_update_historay", NULL, 1)), "version") == 1);

    CHECK(integer(sql("REPLACE INTO ct_config(key,value) VALUES(?,?)",
          "{\"0\":\"fixture\",\"1\":\"中文 O''Neil \\\\ \\n \\u0012\",\"len\":2,\"type\":2}", 0), "count") == 1);
    struct json_object *row = first_row(sql("SELECT value FROM ct_config WHERE key=?",
        "{\"0\":\"fixture\",\"len\":1,\"type\":4}", 1));
    CHECK(!strcmp(json_object_get_string(get(row, "value")), "中文 O''Neil \\ \n \022"));
    row = first_row(sql("SELECT 9223372036854775806 AS i,2.5 AS f,'中文' AS t,NULL AS n,x'00ff' AS b", NULL, 1));
    CHECK(integer(row, "i") == INT64_C(9223372036854775806));
    CHECK(json_object_get_double(get(row, "f")) == 2.5);
    struct json_object *ignored;
    CHECK(!json_object_object_get_ex(row, "n", &ignored));
    CHECK(!json_object_object_get_ex(row, "b", &ignored));
    CHECK(get(sql("SELECT 1 WHERE 0", NULL, 1), "data") == NULL);
    CHECK(json_object_array_length(get(sql("SELECT 1 WHERE 0", "{\"len\":0,\"type\":4}", 1), "data")) == 0);
    CHECK(json_object_array_get_idx(get(sql("SELECT NULL AS a", NULL, 1), "data"), 0) == NULL);
    CHECK(integer(sql("SELECT ?", "{\"len\":1}", 1), "code") != 0);
    CHECK(integer(sql("SELECT ?", "not-json", 1), "code") != 0);
    CHECK(integer(sql("SELECT ?; DELETE FROM ct_config", "{\"0\":1,\"len\":1}", 1), "code") != 0);
    CHECK(integer(sql("INSERT INTO ct_config(key,value) VALUES('fixture','overwrite')", NULL, 0), "code") != 0);
    reenter_direct = 1;
    CHECK(integer(sql("SELECT 1 AS outer_value", NULL, 1), "code") == 0);
    CHECK(!reenter_direct);

    rpc_ok(9, "{\"_contactinfo\":{\"account\":\"alpha\",\"contact_id\":\"c1\",\"name\":\"张三\",\"workId\":\"w1\",\"mobile\":\"123\",\"tidType\":3,\"updateTimestamp\":1700000000000}}");
    rpc_ok(10, "{\"_arraylen\":2,\"_contactinfolist\":[{\"account\":\"comma,user\",\"name\":\"Comma\"},{\"account\":\"o'neil\",\"name\":\"O'Neil\"}]}");
    rpc_ok(12, "{\"_matchinfo\":{\"keytype\":40,\"match_value\":\"'comma,user','o''neil'\"}}");
    CHECK(integer(get(last_rpc, "param"), "_retlen") == 2);
    CHECK(integer(rpc(10, "{\"_arraylen\":2,\"_contactinfolist\":[{\"account\":\"rollback\",\"name\":\"Rollback\"},false]}"), "result") != 0);
    rpc_ok(12, "{\"_matchinfo\":{\"keytype\":3,\"match_value\":\"rollback\"}}");
    CHECK(integer(get(last_rpc, "param"), "_retlen") == 0);
    rpc_ok(12, "{\"_matchinfo\":{\"keytype\":52,\"match_value\":\"\",\"limitCount\":1,\"offsetCount\":0}}");
    CHECK(integer(get(last_rpc, "param"), "_retlen") == 1);
    rpc_ok(12, "{\"_matchinfo\":{\"keytype\":46,\"match_value\":\"123\"}}");
    CHECK(integer(get(last_rpc, "param"), "_retlen") == 1);
    rpc_ok(11, "{\"_matchinfo\":{\"keytype\":1,\"match_value\":\"c1\"}}");
    rpc_ok(13, "{\"_keyvalue\":{\"strkey\":\"user-key\",\"strvalue\":\"config\"}}");
    rpc_ok(16, "{\"_arraylen\":1,\"_keyvaluelist\":[{\"strkey\":\"other-key\",\"strvalue\":\"other\"}]}");
    rpc_ok(15, "{\"_matchinfo\":{\"keytype\":3,\"match_value\":\"\"}}");
    CHECK(integer(get(last_rpc, "param"), "_retlen") == 2);
    rpc_ok(14, "{\"_matchinfo\":{\"keytype\":1,\"match_value\":\"other-key\"}}");
    CHECK(integer(rpc(15, "{\"_matchinfo\":{\"keytype\":99,\"match_value\":\"\"}}"), "result") == -1);
    CHECK(integer(rpc(15, "{\"_matchinfo\":{\"keytype\":\"bad\",\"match_value\":\"\"}}"), "result") == 1);

    rpc_ok(28, "{\"_friendshipinfo\":{\"friendAccount\":\"friend1\",\"friendGroupId\":\"g1\"}}");
    rpc_ok(29, "{\"_arraylen\":1,\"_friendinfolist\":[{\"friendAccount\":\"friend2\"}]}");
    rpc_ok(31, "{\"_matchinfo\":{\"keytype\":13,\"match_value\":\"'friend1','friend2'\"}}");
    CHECK(integer(get(last_rpc, "param"), "_retlen") == 2);
    rpc_ok(30, "{\"_matchinfo\":{\"keytype\":1,\"match_value\":\"friend2\"}}");
    CHECK(!json_object_object_get_ex(last_rpc, "ret", &ignored));
    rpc_ok(32, "{\"_contactgroupmeminfo\":{\"contact_id\":\"c1\",\"group_id\":\"g1\"}}");
    rpc_ok(33, "{\"_arraylen\":1,\"_contactgroupmeminfolist\":[{\"contact_id\":\"c2\",\"group_id\":\"g1\"}]}");
    rpc_ok(35, "{\"_matchinfo\":{\"keytype\":1,\"match_value\":\"g1\"}}");
    CHECK(integer(get(last_rpc, "param"), "_retlen") == 2);
    rpc_ok(34, "{\"_multimatchinfo\":{\"operationtype\":4,\"datalen\":2,\"datalist\":[{\"keytype\":2,\"match_value\":\"c1\"},{\"keytype\":1,\"match_value\":\"g1\"}]}}");
    rpc_ok(36, "{\"_remark\":{\"employeeAccount\":\"friend1\",\"remark\":\"中文\"}}");
    rpc_ok(37, "{\"_arraylen\":1,\"_remarklist\":[{\"employeeAccount\":\"friend2\",\"remark\":\"other\"}]}");
    rpc_ok(38, "{\"_matchinfo\":{\"keytype\":5,\"match_value\":\"中文\"}}");
    CHECK(integer(get(last_rpc, "param"), "_retlen") == 1);
    rpc_ok(50, "{\"_new_contactgroupinfo\":{\"groupId\":\"g1\",\"groupNameCn\":\"分组\",\"indexNo\":2}}");
    rpc_ok(51, "{\"_arraylen\":1,\"_new_contactgroupinfolist\":[{\"groupId\":\"g2\",\"groupNameEn\":\"Group\",\"indexNo\":1}]}");
    rpc_ok(53, "{\"_matchinfo\":{\"keytype\":0,\"match_value\":\"\"}}");
    CHECK(integer(get(last_rpc, "param"), "_retlen") == 2);
    rpc_ok(52, "{\"_matchinfo\":{\"keytype\":2,\"match_value\":\"g2\"}}");

    unsigned before = rpc_calls;
    api.SqliteRecvMsgImport("{\"cmd\":999,\"sno\":999,\"param\":{}}");
    pthread_t thread;
    CHECK(!pthread_create(&thread, NULL, foreign_dispatch, NULL));
    CHECK(!pthread_join(thread, NULL));
    CHECK(rpc_calls == before);
    CHECK(api.ContactPluginDispatchCallbacks() == 1);
    CHECK(integer(last_rpc, "result") != 0);
    api.SqliteRecvMsgImport("{\"cmd\":999,\"sno\":1000,\"param\":{}}");
    api.ContactPluginShutdown();
    CHECK(api.ContactPluginDispatchCallbacks() == 0);
    CHECK(rpc_calls == before + 1);

    char *metadata_path = g_build_filename(root, "synthetic", "config.db", NULL);
    char *user_path = g_build_filename(root, "synthetic", "user.db", NULL);
    char *gab_path = g_build_filename(root, "synthetic", "gab.db", NULL);
    gsize metadata_length, user_length, gab_length;
    char *metadata = read_file(metadata_path, &metadata_length);
    char *user_bytes = read_file(user_path, &user_length);
    char *gab_bytes = read_file(gab_path, &gab_length);
    CHECK(user_length > 16 && memcmp(user_bytes, "SQLite format 3", 15));
    CHECK(gab_length > 16 && memcmp(gab_bytes, "SQLite format 3", 15));
    struct stat st;
    CHECK(!stat(user_path, &st) && (st.st_mode & 077) == 0);
    char *wrong_key = g_memdup2(metadata, metadata_length);
    wrong_key[metadata_length - 1] = wrong_key[metadata_length - 1] == 'A' ? 'B' : 'A';
    CHECK(g_file_set_contents(metadata_path, wrong_key, (gssize)metadata_length, NULL));
    CHECK(api.SqliteServiceStartup(rpc_callback) == 0);
    init(root, "synthetic", 0);
    api.ContactPluginShutdown();
    same_file(user_path, user_bytes, user_length);
    same_file(gab_path, gab_bytes, gab_length);
    same_file(metadata_path, wrong_key, metadata_length);
    CHECK(!unlink(metadata_path));
    CHECK(api.SqliteServiceStartup(rpc_callback) == 0);
    init(root, "synthetic", 0);
    CHECK(access(metadata_path, F_OK) && errno == ENOENT);
    api.ContactPluginShutdown();
    same_file(user_path, user_bytes, user_length);
    same_file(gab_path, gab_bytes, gab_length);
    CHECK(g_file_set_contents(metadata_path, metadata, (gssize)metadata_length, NULL));
    CHECK(api.SqliteServiceStartup(rpc_callback) == 0);
    init(root, "synthetic", 1);
    CHECK(integer(first_row(sql("SELECT count(*) AS n FROM ct_config WHERE key='fixture'", NULL, 1)), "n") == 1);
    stop_in_rpc = 1;
    api.SqliteRecvMsgImport("{\"cmd\":1,\"sno\":1001,\"param\":{\"userAccount\":\"\"}}");
    api.SqliteRecvMsgImport("{\"cmd\":999,\"sno\":1002,\"param\":{}}");
    CHECK(api.ContactPluginDispatchCallbacks() == 1);
    CHECK(api.ContactPluginDispatchCallbacks() == 0);
    api.ContactPluginShutdown();
    json_object_put(last_rpc); json_object_put(last_direct);
    g_free(metadata_path); g_free(user_path); g_free(gab_path);
    g_free(metadata); g_free(wrong_key); g_free(user_bytes); g_free(gab_bytes);
    CHECK(!dlclose(library));
    CHECK(!nftw(root, remove_fixture, 32, FTW_DEPTH | FTW_PHYS));
    puts("contact synthetic regression passed");
    return 0;
}
