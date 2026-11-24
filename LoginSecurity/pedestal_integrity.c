/* Pedestal's application integrity operation, not a database initializer.
 * Original sqlite_plugin.dll 7.47.6.95 RVAs:
 * 0x634c0 asynchronous command worker, 0x6d000 aggregate result,
 * 0x6e8a0 diagnostics/30-anomaly limit, 0x68640 SHA256,
 * 0x6c1d0 CBC padding, 0x6aef0 whitebox rounds, 0x70560 immutable asset list.
 * The original checks ordinary JS/CSS/HTML/SVG/JSON/XML bytes, not PE signatures.
 * Native builds explicitly use their own compiled SHA256 baseline. Neither mode
 * trusts a runtime sidecar or learns expected digests from the current files.
 * Requires json-c, OpenSSL libcrypto, pthread and libdl. No Windows runtime. */
#define _GNU_SOURCE
#include "pedestal_integrity.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <fcntl.h>
#include <unistd.h>
#include <dlfcn.h>
#include <sys/stat.h>
#include <openssl/evp.h>
#include <openssl/crypto.h>

#ifdef PEDESTAL_NATIVE_INTEGRITY
#include "native_integrity_manifest.h"
#define INTEGRITY_ASSETS pedestal_native_integrity_assets
#else
#include "pedestal_integrity_vendor.h"
#define INTEGRITY_ASSETS pedestal_vendor_assets
#endif
#define INTEGRITY_COUNT (sizeof(INTEGRITY_ASSETS)/sizeof(INTEGRITY_ASSETS[0]))
_Static_assert(INTEGRITY_COUNT>0,"An empty integrity manifest cannot establish integrity");

struct integrity_job {
    struct integrity_job *next;
    struct native_request request;
    native_callback callback;
    unsigned epoch;
};
struct integrity_message {
    struct integrity_message *next;
    native_callback callback;
    unsigned epoch;
    size_t length;
    char text[];
};
struct integrity_counts { unsigned mismatches,errors,anomalies; };
static struct {
    pthread_mutex_t mutex;
    pthread_cond_t wake;
    pthread_t worker;
    struct integrity_job *head,*tail;
    struct integrity_message *out_head,*out_tail;
    atomic_uint epoch;
    int running,accepting,dispatching;
} integrity={.mutex=PTHREAD_MUTEX_INITIALIZER,.wake=PTHREAD_COND_INITIALIZER};

static void set_string(struct json_object *o,const char *key,const char *value)
{ if(o) json_object_object_add(o,key,json_object_new_string(value)); }
static void set_int(struct json_object *o,const char *key,int64_t value)
{ if(o) json_object_object_add(o,key,json_object_new_int64(value)); }
static void hex_encode(const unsigned char *bytes,size_t n,char *out)
{
    static const char hex[]="0123456789ABCDEF";
    for(size_t i=0;i<n;i++) { out[2*i]=hex[bytes[i]>>4]; out[2*i+1]=hex[bytes[i]&15]; }
    out[2*n]=0;
}
#ifdef PEDESTAL_NATIVE_INTEGRITY
static int hex_decode_sha256(const char *text,unsigned char out[32])
{
    if(!text || strlen(text)!=64) return EINVAL;
    for(size_t i=0;i<32;i++) {
        unsigned value=0;
        for(size_t j=0;j<2;j++) {
            unsigned char c=(unsigned char)text[i*2+j];
            unsigned nibble=c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:16;
            if(nibble>15) return EINVAL;
            value=(value<<4)|nibble;
        }
        out[i]=(unsigned char)value;
    }
    return 0;
}
#else
static uint32_t load_le32(const unsigned char *p)
{ return (uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24; }
static void vendor_encrypt_digest(const unsigned char digest[32],unsigned char cipher[80])
{
    unsigned char plain[81],previous[16];
    hex_encode(digest,32,(char *)plain);
    memset(plain+64,16,16);
    memcpy(previous,pedestal_vendor_iv,sizeof(previous));
    for(unsigned block=0;block<5;block++) {
        unsigned char mixed[16]; uint32_t x[4],next[4];
        for(unsigned i=0;i<16;i++) mixed[i]=plain[block*16+i]^previous[i];
        for(unsigned i=0;i<4;i++) x[i]=load_le32(mixed+i*4);
        for(unsigned round=0;round<10;round++) {
            for(unsigned column=0;column<4;column++) {
                const uint32_t *table=pedestal_vendor_tboxes+round*4096+column*1024;
                next[column]=table[x[column]&255]^
                    table[256+((x[(column+1)&3]>>8)&255)]^
                    table[512+((x[(column+2)&3]>>16)&255)]^
                    table[768+(x[(column+3)&3]>>24)];
            }
            memcpy(x,next,sizeof(x));
        }
        for(unsigned i=0;i<4;i++) for(unsigned j=0;j<4;j++)
            previous[i*4+j]=cipher[block*16+i*4+j]=(unsigned char)(x[i]>>(j*8));
    }
}
#endif

static int cancelled(unsigned epoch) { return epoch!=atomic_load(&integrity.epoch); }
static int safe_relative_path(const char *path)
{
    if(!path || !*path || *path=='/' || strchr(path,'\\')) return 0;
    const char *p=path;
    while(*p) {
        const char *slash=strchr(p,'/'); size_t n=slash?(size_t)(slash-p):strlen(p);
        if(!n || (n==1 && *p=='.') || (n==2 && p[0]=='.' && p[1]=='.')) return 0;
        if(!slash) return 1;
        p=slash+1;
    }
    return 0;
}
static int parent_directory(char *path)
{
    char *slash=strrchr(path,'/');
    if(!slash || slash==path) return ENOENT;
    *slash=0; return 0;
}
static int is_directory(const char *path)
{ struct stat st; return !stat(path,&st) && S_ISDIR(st.st_mode); }

static int application_root(char root[PATH_MAX])
{
    /* Prefer the containing library's real application layout. Never inspect
     * DB parameters or cwd: they point to user dbdata, not installed assets. */
    Dl_info library;
    char path[PATH_MAX];
    if(dladdr((void *)&pedestal_integrity_execute,&library) && library.dli_fname &&
       realpath(library.dli_fname,path) && !parent_directory(path)) {
        const char *name=strrchr(path,'/'); name=name?name+1:path;
        if(!strcmp(name,"pedestal") && !parent_directory(path)) {
            memcpy(root,path,strlen(path)+1); return 0;
        }
        do {
            name=strrchr(path,'/'); name=name?name+1:path;
            if(!strcmp(name,"app")) { memcpy(root,path,strlen(path)+1); return 0; }
        } while(!parent_directory(path));
    }
    ssize_t n=readlink("/proc/self/exe",path,sizeof(path)-1);
    if(n<=0 || (size_t)n>=sizeof(path)-1) return ENOENT;
    path[n]=0;
    if(parent_directory(path)) return ENOENT;
    int size=snprintf(root,PATH_MAX,"%s/resources/app",path);
    if(size<0 || size>=PATH_MAX) return ENAMETOOLONG;
    if(is_directory(root)) return 0;
    char native[PATH_MAX];
    size=snprintf(native,sizeof(native),"%s/app",path);
    if(size>0 && (size_t)size<sizeof(native) && is_directory(native))
        memcpy(root,native,(size_t)size+1);
    /* Even a missing packaged resources/app has a definite root. Its missing
     * assets are reported individually, like the original empty-install case. */
    return 0;
}

static int digest_file(EVP_MD_CTX *context,int fd,unsigned epoch,unsigned char digest[32])
{
    unsigned char buffer[65536]; unsigned length=0;
    if(EVP_DigestInit_ex(context,EVP_sha256(),NULL)!=1) return EIO;
    for(;;) {
        if(cancelled(epoch)) return ECANCELED;
        ssize_t n=read(fd,buffer,sizeof(buffer));
        if(n<0) { if(errno==EINTR) continue; return errno; }
        if(!n) break;
        if(EVP_DigestUpdate(context,buffer,(size_t)n)!=1) return EIO;
    }
    if(EVP_DigestFinal_ex(context,digest,&length)!=1 || length!=32) return EIO;
    return cancelled(epoch)?ECANCELED:0;
}
static char *diagnostic_path(const char *relative)
{
#ifdef PEDESTAL_NATIVE_INTEGRITY
    return strdup(relative);
#else
    static const char prefix[]="\\resources\\app\\";
    size_t n=strlen(relative),p=sizeof(prefix)-1;
    char *text=malloc(p+n+1); if(!text) return NULL;
    memcpy(text,prefix,p);
    for(size_t i=0;i<n;i++) text[p+i]=relative[i]=='/'?'\\':relative[i];
    text[p+n]=0; return text;
#endif
}
static void timestamp_field(struct json_object *error,const char *key,time_t seconds)
{
    char value[32]=""; struct tm tm;
    if(localtime_r(&seconds,&tm)) strftime(value,sizeof(value),"%Y-%m-%d %H:%M:%S",&tm);
    set_string(error,key,value);
}
static void native_profile(struct json_object *param)
{
#ifdef PEDESTAL_NATIVE_INTEGRITY
    set_string(param,"integrity_profile","native-build");
    set_string(param,"integrity_build",pedestal_native_integrity_build);
#else
    (void)param;
#endif
}

static int check_assets(unsigned epoch,struct integrity_counts *counts,struct json_object **out)
{
    char root[PATH_MAX];
    int error=application_root(root);
    struct json_object *param=json_object_new_object();
    if(!param) return ENOMEM;
    *out=param;
    native_profile(param);
    if(error) { set_string(param,"failReason","application asset root unavailable"); return 102; }
    int directory=open(root,O_RDONLY|O_DIRECTORY|O_CLOEXEC);
    EVP_MD_CTX *context=EVP_MD_CTX_new();
    if(!context) {
        if(directory>=0) close(directory);
        set_string(param,"failReason","cannot allocate SHA256 context"); return 102;
    }
    int result=0;
    for(size_t i=0;i<INTEGRITY_COUNT;i++) {
        if(cancelled(epoch)) { result=ECANCELED; goto done; }
        const char *relative=INTEGRITY_ASSETS[i].relative_path;
        struct json_object *detail=NULL;
        unsigned char actual[32];
        struct stat attributes={0};
        int mismatch=0,failure=0;
        if(!safe_relative_path(relative)) {
            failure=1; detail=json_object_new_object();
            set_string(detail,"error_path_msg","file path is empty");
        } else {
            int fd=directory<0?-1:openat(directory,relative,O_RDONLY|O_CLOEXEC|O_NONBLOCK);
            if(fd<0) {
                failure=1; detail=json_object_new_object();
                set_string(detail,"error_file_msg","file is not exist");
            } else {
                int status=fstat(fd,&attributes);
                error=status?errno:!S_ISREG(attributes.st_mode)?EINVAL:digest_file(context,fd,epoch,actual);
                close(fd);
                if(error==ECANCELED) { result=ECANCELED; goto done; }
                if(error) {
                    failure=1; detail=json_object_new_object();
                    set_string(detail,"file_sha_error","file sha256 empty");
                } else {
#ifdef PEDESTAL_NATIVE_INTEGRITY
                    unsigned char expected[32];
                    if(hex_decode_sha256(INTEGRITY_ASSETS[i].sha256_hex,expected)) {
                        failure=1; detail=json_object_new_object();
                        set_string(detail,"file_sha_error","invalid native build SHA256");
                    } else if(memcmp(actual,expected,sizeof(actual))) {
                        char actual_hex[65],expected_hex[65];
                        hex_encode(actual,32,actual_hex); hex_encode(expected,32,expected_hex);
                        failure=1; detail=json_object_new_object(); mismatch=1;
                        set_string(detail,"file_sha256",actual_hex);
                        set_string(detail,"expected_sha256",expected_hex);
                    }
#else
                    unsigned char cipher[80];
                    vendor_encrypt_digest(actual,cipher);
                    if(memcmp(cipher,INTEGRITY_ASSETS[i].encrypted_sha256,sizeof(cipher))) {
                        char actual_hex[161],expected_hex[161];
                        hex_encode(cipher,80,actual_hex);
                        hex_encode(INTEGRITY_ASSETS[i].encrypted_sha256,80,expected_hex);
                        failure=1; detail=json_object_new_object(); mismatch=1;
                        set_string(detail,"encrypt_file_sha",actual_hex);
                        set_string(detail,"sha_encrypt",expected_hex);
                    }
#endif
                }
            }
        }
        if(failure && !detail) { result=ENOMEM; goto done; }
        if(detail) {
            char key[40]; snprintf(key,sizeof(key),"errorFile_%u",counts->anomalies);
            char *path=diagnostic_path(relative?relative:"");
            set_string(detail,"failReason",path?path:relative?relative:""); free(path);
            if(mismatch) {
                /* Legacy createTime has the POSIX metadata-change time on Linux. */
                timestamp_field(detail,"createTime",attributes.st_ctime);
                timestamp_field(detail,"modifyTime",attributes.st_mtime);
                timestamp_field(detail,"accessTime",attributes.st_atime);
                char length[32]; snprintf(length,sizeof(length),"%lld",(long long)attributes.st_size);
                set_string(detail,"fileLen",length);
                counts->mismatches++;
            } else counts->errors++;
            counts->anomalies++;
            json_object_object_add(param,key,detail);
            if(counts->anomalies>=30) break;
        }
    }
    /* Vendor counters latch failures across checks within one SDK lifecycle.
     * A shutdown/re-init epoch starts a fresh lifecycle, without stale replies. */
    result=counts->mismatches?101:counts->errors?102:0;
    if(result==102) set_int(param,"error_count",counts->errors);
#ifndef PEDESTAL_NATIVE_INTEGRITY
    if(!json_object_object_length(param)) { json_object_put(param); *out=NULL; }
#endif
done:
    EVP_MD_CTX_free(context);
    if(directory>=0) close(directory);
    return result;
}

static void free_job(struct integrity_job *job)
{ native_release(&job->request); free(job); }
static void free_message(struct integrity_message *message)
{ OPENSSL_cleanse(message->text,message->length); free(message); }
static void queue_result(const struct integrity_job *job,int result,struct json_object *param)
{
    struct json_object *reply=json_object_new_object();
    if(!reply) { json_object_put(param); return; }
    json_object_object_add(reply,"rsp",json_object_get(native_get(job->request.root,"cmd")));
    struct json_object *sno=native_get(job->request.root,"sno");
    if(json_object_is_type(sno,json_type_int)) json_object_object_add(reply,"sno",json_object_get(sno));
    set_int(reply,"result",result);
    set_string(reply,"description",native_string(job->request.root,"description","tup_sqlite_examin_encrypt_file"));
    /* Unlike native_respond, the original includes param:null on clean vendor scans. */
    json_object_object_add(reply,"param",param);
    const char *text=json_object_to_json_string_ext(reply,JSON_C_TO_STRING_PLAIN);
    size_t length=text?strlen(text):0;
    struct integrity_message *message=length && length<SIZE_MAX-sizeof(*message)
        ? malloc(sizeof(*message)+length+1):NULL;
    if(message) {
        message->next=NULL; message->callback=job->callback; message->epoch=job->epoch;
        message->length=length; memcpy(message->text,text,length+1);
        pthread_mutex_lock(&integrity.mutex);
        int current=integrity.accepting && !cancelled(job->epoch);
        if(current) {
            if(integrity.out_tail) integrity.out_tail->next=message;
            else integrity.out_head=message;
            integrity.out_tail=message;
        }
        pthread_mutex_unlock(&integrity.mutex);
        if(!current) free_message(message);
    }
    json_object_put(reply);
}
static void *integrity_worker(void *unused)
{
    (void)unused;
    unsigned state_epoch=0;
    struct integrity_counts latched={0};
    pthread_mutex_lock(&integrity.mutex);
    for(;;) {
        while(!integrity.head) pthread_cond_wait(&integrity.wake,&integrity.mutex);
        struct integrity_job *job=integrity.head;
        integrity.head=job->next;
        if(!integrity.head) integrity.tail=NULL;
        pthread_mutex_unlock(&integrity.mutex);
        if(!cancelled(job->epoch)) {
            if(state_epoch!=job->epoch) { memset(&latched,0,sizeof(latched)); state_epoch=job->epoch; }
            struct integrity_counts counts=latched;
            struct json_object *param=NULL;
            int result=check_assets(job->epoch,&counts,&param);
            if(!cancelled(job->epoch) && result!=ECANCELED) {
                if(result==ENOMEM) {
                    param=json_object_new_object(); native_profile(param);
                    set_string(param,"failReason","unexpected interrupt"); result=102;
                }
                latched=counts;
                queue_result(job,result,param);
            } else json_object_put(param);
        }
        free_job(job);
        pthread_mutex_lock(&integrity.mutex);
    }
}

void pedestal_integrity_execute(const struct native_request *request,native_callback callback)
{
    if(!request || !request->root || !callback) return;
    int command=(int)(request->cmd&0x2ffff);
    if(command!=80 && command!=91) return;
    struct integrity_job *job=calloc(1,sizeof(*job));
    if(!job) return;
    if(json_object_deep_copy(request->root,&job->request.root,NULL)) { free(job); return; }
    job->request.param=native_get(job->request.root,"param");
    job->request.cmd=request->cmd; job->callback=callback;
    pthread_mutex_lock(&integrity.mutex);
    if(!integrity.accepting) {
        integrity.accepting=1;
        atomic_fetch_add(&integrity.epoch,1);
    }
    job->epoch=atomic_load(&integrity.epoch);
    if(!integrity.running) {
        int error=pthread_create(&integrity.worker,NULL,integrity_worker,NULL);
        if(error) {
            pthread_mutex_unlock(&integrity.mutex);
            struct json_object *param=json_object_new_object(); native_profile(param);
            set_string(param,"failReason","cannot start integrity worker");
            queue_result(job,102,param); free_job(job); return;
        }
        integrity.running=1; pthread_detach(integrity.worker);
    }
    if(integrity.tail) integrity.tail->next=job;
    else integrity.head=job;
    integrity.tail=job;
    pthread_cond_signal(&integrity.wake);
    pthread_mutex_unlock(&integrity.mutex);
}
int pedestal_integrity_dispatch(void)
{
    pthread_mutex_lock(&integrity.mutex);
    if(integrity.dispatching) { pthread_mutex_unlock(&integrity.mutex); return 0; }
    integrity.dispatching=1;
    pthread_mutex_unlock(&integrity.mutex);
    int delivered=0;
    for(unsigned drained=0;drained<64;drained++) {
        pthread_mutex_lock(&integrity.mutex);
        struct integrity_message *message=integrity.out_head;
        if(!message) { pthread_mutex_unlock(&integrity.mutex); break; }
        integrity.out_head=message->next;
        if(!integrity.out_head) integrity.out_tail=NULL;
        int current=integrity.accepting && !cancelled(message->epoch);
        pthread_mutex_unlock(&integrity.mutex);
        if(current) { message->callback(message->text); delivered++; }
        free_message(message);
    }
    pthread_mutex_lock(&integrity.mutex);
    integrity.dispatching=0;
    pthread_mutex_unlock(&integrity.mutex);
    return delivered;
}
void pedestal_integrity_shutdown(void)
{
    pthread_mutex_lock(&integrity.mutex);
    integrity.accepting=0;
    atomic_fetch_add(&integrity.epoch,1);
    struct integrity_job *jobs=integrity.head;
    struct integrity_message *messages=integrity.out_head;
    integrity.head=integrity.tail=NULL;
    integrity.out_head=integrity.out_tail=NULL;
    pthread_cond_signal(&integrity.wake);
    pthread_mutex_unlock(&integrity.mutex);
    while(jobs) { struct integrity_job *next=jobs->next; free_job(jobs); jobs=next; }
    while(messages) { struct integrity_message *next=messages->next; free_message(messages); messages=next; }
    /* No join and no callbacks. The worker is process-lived; a subsequent
     * execute starts a fresh epoch after cancelled work has left its hash loop. */
}
