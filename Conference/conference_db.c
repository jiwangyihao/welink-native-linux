/* Campus conference_db ABI, called on the owning conference renderer thread.
 * The key files, encrypted SQLite format, table and column types match the
 * original Windows database. No account/number, ticket or row is logged. */
#include "native_rpc.h"
#include "native_storage.h"
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#define EXPORT __attribute__((visibility("default")))
#define N(a) (sizeof(a) / sizeof((a)[0]))
#define FIELDS "AUTOID,ACCOUNT,NAME,NAMEEN,RECORDTYPE,CALLNUMBER,CONFID,GROUPID,DURATION,ISREAD,STARTTIME,ISVIDEO,ISCALLSUCCESS,ISCALLOUT,CALLRECORDINGPATH,ATTENDEESINFO,EXPARAM,CALLID"
#define SELECT_ROWS "SELECT " FIELDS " FROM CallRecordTab WHERE "
#define PAGE " ORDER BY STARTTIME DESC,AUTOID DESC LIMIT ?6"
#define KEYS (JSON_C_OBJECT_ADD_KEY_IS_NEW | JSON_C_OBJECT_KEY_IS_CONSTANT)

enum { OK, DB_ERROR, BAD_REQUEST = 3 };
static const struct { const char *name; int string; } fields[] = {
    {"autoId",0},{"account",1},{"name",1},{"nameEn",1},{"recordType",0},{"callNumber",1},
    {"confId",1},{"groupId",1},{"duration",0},{"isRead",0},{"startTime",0},{"isVideo",0},
    {"isCallSuccess",0},{"isCallOut",0},{"callRecordingPath",1},{"attendeesInfo",1},{"exParam",1},{"callId",0}
};
/* Placeholder numbers 1..8 correspond to matchInfoList.keyType below. */
static const int key_types[] = {1,2,100,101,102,103,104,105};
enum { ID=1, TYPE=2, OUT=4, SUCCESS=8, START=16, LIMIT=32, END=64, CALL=128 };
static const struct filter { const char *sql; unsigned keys; } queries[] = {
    {SELECT_ROWS "STARTTIME<?5" PAGE, START|LIMIT}, {NULL,0},
    {SELECT_ROWS "RECORDTYPE=?2 AND STARTTIME<?5" PAGE, TYPE|START|LIMIT},
    {SELECT_ROWS "ISCALLOUT=?3 AND ISCALLSUCCESS=?4 AND STARTTIME<?5" PAGE, OUT|SUCCESS|START|LIMIT},
    {SELECT_ROWS "ISCALLOUT=?3 AND ISCALLSUCCESS=?4 AND STARTTIME BETWEEN ?5 AND ?7" PAGE, OUT|SUCCESS|START|END|LIMIT},
    {SELECT_ROWS "STARTTIME BETWEEN ?5 AND ?7" PAGE, START|END|LIMIT},
    {SELECT_ROWS "CALLID=?8" PAGE, CALL|LIMIT}
}, deletes[] = {
    {"DELETE FROM CallRecordTab",0}, {"DELETE FROM CallRecordTab WHERE AUTOID=?1",ID},
    {"DELETE FROM CallRecordTab WHERE RECORDTYPE=?2",TYPE},
    {"DELETE FROM CallRecordTab WHERE ISCALLOUT=?3 AND ISCALLSUCCESS=?4",OUT|SUCCESS}
};
static sqlite3 *db;
static sqlite3_stmt *add, *reads[N(queries)], *removes[N(deletes)];
static void (*notify)(const char *);
static int log_fd = -1;
static off_t log_max;

static void close_db(void) {
    sqlite3_finalize(add); add = NULL;
    for (size_t i=0; i<N(reads); i++) { sqlite3_finalize(reads[i]); reads[i]=NULL; }
    for (size_t i=0; i<N(removes); i++) { sqlite3_finalize(removes[i]); removes[i]=NULL; }
    if (db) sqlite3_close(db);
    db=NULL;
}
static int initialize(struct json_object *p) {
    close_db(); /* Never retain a previous account on failure. */
    const char *dir=native_string(p,"dbPath",""), *kmc=native_string(p,"kmcStorePath",""), *user=native_string(p,"userAccount","");
    if (dir[0]!='/' || kmc[0]!='/' || !*user || strchr(user,'/') || strchr(user,'\\') || !strcmp(user,".") || !strcmp(user,"..")) return BAD_REQUEST;
    char filename[PATH_MAX], metadata[PATH_MAX];
    if (snprintf(filename,sizeof(filename),"%s/user.db",dir)>=(int)sizeof(filename) ||
        snprintf(metadata,sizeof(metadata),"%s/user_config.db",dir)>=(int)sizeof(metadata)) return BAD_REQUEST;
    if (native_storage_mkdirs(dir) || native_storage_mkdirs(kmc)) return DB_ERROR;
    struct stat st;
    int create;
    if (!lstat(filename,&st)) { if (!S_ISREG(st.st_mode)) return DB_ERROR; create=st.st_size==0; }
    else { if (errno!=ENOENT) return DB_ERROR; create=1; }
    struct native_storage_key key;
    if (native_storage_load_key(metadata,kmc,user,create,&key)) return DB_ERROR;
    int rc=native_storage_open(filename,key.password,1,&db);
    native_storage_clear_key(&key);
    if (rc!=SQLITE_OK) return DB_ERROR;
    rc=sqlite3_exec(db,"CREATE TABLE IF NOT EXISTS CallRecordTab("
        "AUTOID INTEGER PRIMARY KEY AUTOINCREMENT,ACCOUNT VARCHAR(64),NAME VARCHAR(128),NAMEEN VARCHAR(128),"
        "RECORDTYPE INTEGER,CALLNUMBER VARCHAR(64),CONFID VARCHAR(32),GROUPID VARCHAR(64),DURATION INTEGER,"
        "ISREAD INTEGER,STARTTIME INTEGER,ISVIDEO INTEGER,ISCALLSUCCESS INTEGER,ISCALLOUT INTEGER,"
        "CALLRECORDINGPATH VARCHAR(256),ATTENDEESINFO VARCHAR(1024),EXPARAM VARCHAR(2048),CALLID INTEGER);"
        "CREATE INDEX IF NOT EXISTS CALLRECORD_STARTTIME_INDEX ON CallRecordTab(STARTTIME)",NULL,NULL,NULL);
    if (rc!=SQLITE_OK) { close_db(); return DB_ERROR; }
    return OK;
}
static int insert_row(struct json_object *row) {
    if (!json_object_is_type(row,json_type_object)) return BAD_REQUEST;
    if (!add && sqlite3_prepare_v2(db,"INSERT INTO CallRecordTab(" FIELDS ") VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",-1,&add,NULL)!=SQLITE_OK) return DB_ERROR;
    int rc=SQLITE_OK;
    for (size_t i=0; i<N(fields) && rc==SQLITE_OK; i++) {
        struct json_object *v=native_get(row,fields[i].name);
        int index=(int)i+1;
        if (fields[i].string) {
            const int text=json_object_is_type(v,json_type_string);
            rc=sqlite3_bind_text(add,index,text?json_object_get_string(v):"",text?json_object_get_string_len(v):0,SQLITE_STATIC);
        } else {
            int64_t n=json_object_is_type(v,json_type_int) || json_object_is_type(v,json_type_boolean) ? json_object_get_int64(v) : 0;
            rc=i==0 && !n ? sqlite3_bind_null(add,index) : sqlite3_bind_int64(add,index,n);
        }
    }
    if (rc==SQLITE_OK) rc=sqlite3_step(add);
    sqlite3_reset(add); sqlite3_clear_bindings(add);
    return rc==SQLITE_DONE?OK:DB_ERROR;
}
static int insert_batch(struct json_object *p) {
    struct json_object *list=native_get(p,"dataList");
    int64_t count=native_integer(p,"listLen",-1);
    if (!json_object_is_type(list,json_type_array) || count<0 || (uint64_t)count!=json_object_array_length(list)) return BAD_REQUEST;
    if (sqlite3_exec(db,"BEGIN IMMEDIATE",NULL,NULL,NULL)!=SQLITE_OK) return DB_ERROR;
    int result=OK;
    for (int64_t i=0; result==OK && i<count; i++) result=insert_row(json_object_array_get_idx(list,(size_t)i));
    if (result==OK && sqlite3_exec(db,"COMMIT",NULL,NULL,NULL)!=SQLITE_OK) result=DB_ERROR;
    if (result!=OK) sqlite3_exec(db,"ROLLBACK",NULL,NULL,NULL);
    return result;
}
static int append_row(sqlite3_stmt *st,struct json_object *list) {
    struct json_object *row=json_object_new_object();
    if (!row) return DB_ERROR;
    for (size_t i=0;i<N(fields);i++) {
        struct json_object *v;
        if (fields[i].string) {
            const char *t=(const char *)sqlite3_column_text(st,(int)i);
            v=json_object_new_string_len(t?t:"",t?sqlite3_column_bytes(st,(int)i):0);
        } else v=json_object_new_int64(sqlite3_column_int64(st,(int)i));
        if (!v || json_object_object_add_ex(row,fields[i].name,v,KEYS)) { json_object_put(v); json_object_put(row); return DB_ERROR; }
    }
    if (json_object_array_add(list,row)) { json_object_put(row); return DB_ERROR; }
    return OK;
}
static int filter_rows(struct json_object *p,int reading,struct json_object *rows) {
    int64_t op=native_integer(p,"operationType",-1);
    struct json_object *list=native_get(p,"matchInfoList");
    if (op<0 || (uint64_t)op>=(reading?N(queries):N(deletes)) || !json_object_is_type(list,json_type_array)) return BAD_REQUEST;
    const struct filter *plan=(reading?queries:deletes)+op;
    size_t len=json_object_array_length(list);
    if (!plan->sql || len>N(key_types)) return BAD_REQUEST;
    int64_t value[N(key_types)]; unsigned mask=0;
    for (size_t i=0;i<len;i++) {
        struct json_object *item=json_object_array_get_idx(list,i), *v=native_get(item,"matchValue");
        int64_t key=native_integer(item,"keyType",-1); size_t k=0;
        while (k<N(key_types) && key_types[k]!=key) k++;
        if (k==N(key_types) || (mask&(1u<<k)) || !json_object_is_type(v,json_type_string)) return BAD_REQUEST;
        const char *str=json_object_get_string(v); char *end=NULL;
        errno=0; value[k]=strtoll(str,&end,10);
        if (errno || end==str || end-str!=json_object_get_string_len(v)) return BAD_REQUEST;
        mask |= 1u<<k;
    }
    if (mask!=plan->keys || ((mask&LIMIT) && value[5]<0)) return BAD_REQUEST;
    sqlite3_stmt **slot=(reading?reads:removes)+op;
    if (!*slot && sqlite3_prepare_v2(db,plan->sql,-1,slot,NULL)!=SQLITE_OK) return DB_ERROR;
    sqlite3_stmt *st=*slot; int rc=SQLITE_OK, result=OK;
    for (size_t k=0;k<N(key_types) && rc==SQLITE_OK;k++) if (mask&(1u<<k)) rc=sqlite3_bind_int64(st,(int)k+1,value[k]);
    if (rc==SQLITE_OK) while ((rc=sqlite3_step(st))==SQLITE_ROW) { if (append_row(st,rows)!=OK) { result=DB_ERROR; break; } }
    if (rc!=SQLITE_DONE) result=DB_ERROR;
    sqlite3_reset(st);sqlite3_clear_bindings(st);
    return result;
}
EXPORT void conference_db_set_log_path(const char *path,int level,int max_kib,int backups) {
    (void)backups; /* This port logs numeric failures only; stop at the configured size. */
    if (log_fd>=0) close(log_fd);
    log_fd=-1;
    if (!path || *path!='/' || level<0 || max_kib<=0 || native_storage_mkdirs(path)) return;
    char name[PATH_MAX];
    if (snprintf(name,sizeof(name),"%s/native_call_history.log",path)>=(int)sizeof(name)) return;
    int fd=open(name,O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK,0600);
    if (fd<0) return;
    struct stat st;
    if (fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_nlink!=1 || st.st_uid!=geteuid()) { close(fd);return; }
    log_max=(off_t)(max_kib>1048576?1048576:max_kib)*1024;log_fd=fd;
}
EXPORT void conference_db_init(void (*callback)(const char *)) { close_db();notify=callback; }
static int deliver(const char *text) { notify(text);return 0; }
EXPORT void conference_db_send_msg(const char *text) {
    struct native_request req;
    if (!notify || native_parse(&req,text)) return;
    struct json_object *answer=NULL; int rc=DB_ERROR;
    if (req.cmd==2) rc=initialize(req.param);
    else if (req.cmd==3) { close_db();rc=OK; }
    else if (req.cmd==7) {
        struct json_object *rows=json_object_new_array(); answer=json_object_new_object();
        if (rows && answer) {
            rc=db?filter_rows(req.param,1,rows):DB_ERROR;
            json_object_object_add_ex(answer,"listLen",json_object_new_int64((int64_t)json_object_array_length(rows)),KEYS);
            json_object_object_add_ex(answer,"dataList",rows,KEYS);
        } else { json_object_put(rows);json_object_put(answer);answer=NULL; }
    } else if (db) switch(req.cmd) {
        case 4: rc=insert_row(req.param);break;
        case 5: rc=insert_batch(req.param);break;
        case 6: rc=filter_rows(req.param,0,NULL);break;
        default:rc=BAD_REQUEST;break;
    }
    if (rc && log_fd>=0) { struct stat st;if (!fstat(log_fd,&st) && st.st_size<log_max) dprintf(log_fd,"cmd=%lld result=%d\n",(long long)req.cmd,rc); }
    native_respond(deliver,&req,rc,answer);native_release(&req);
}
EXPORT void conference_db_shutdown(void) {
    close_db();notify=NULL;if (log_fd>=0) close(log_fd);log_fd=-1;
}
