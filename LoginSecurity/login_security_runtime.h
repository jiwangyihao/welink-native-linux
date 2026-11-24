/* Private runtime for wk_login/wk_security. Public entry points are void cdecl.
 * Workers only enqueue owned JSON; ls_dispatch runs callbacks on the FFI owner.
 * Shutdown never joins or calls JS. Epochs isolate shutdown/re-init, and the
 * worker clears old state before servicing the next epoch. Libraries/callbacks
 * must remain pinned until process exit because the worker is process-lived. */
#ifndef WELINK_LOGIN_SECURITY_RUNTIME_H
#define WELINK_LOGIN_SECURITY_RUNTIME_H

#include "native_rpc.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <stdio.h>
#include <time.h>
#include <sys/stat.h>
#include <unistd.h>
#include <openssl/crypto.h>

#define LS_EXPORT __attribute__((visibility("default")))
typedef void (*ls_callback)(const char *);
struct ls_job {
    struct ls_job *next;
    struct json_object *root;
    unsigned generation, epoch;
};
struct ls_message {
    struct ls_message *next;
    unsigned generation, epoch;
    int guarded;
    size_t length;
    char text[];
};
struct ls_runtime {
    pthread_mutex_t lock;
    pthread_cond_t wake;
    pthread_t thread;
    ls_callback callback;
    struct ls_job *head, *tail;
    struct ls_message *out_head, *out_tail;
    atomic_int stopping;
    atomic_uint generation, epoch;
    unsigned active_generation, active_epoch;
    unsigned invalidate_commands, guarded_replies;
    int running, accepting, dispatching;
    time_t due;
    void (*dispatch)(struct json_object *);
    void (*tick)(void);
    void (*clear)(void);
    FILE *log;
    size_t log_limit;
};
#define LS_RUNTIME_INIT { .lock = PTHREAD_MUTEX_INITIALIZER, .wake = PTHREAD_COND_INITIALIZER }

static inline void ls_string(struct json_object *o, const char *k, const char *v)
{ json_object_object_add(o, k, json_object_new_string(v ? v : "")); }
static inline void ls_int(struct json_object *o, const char *k, int64_t v)
{ json_object_object_add(o, k, json_object_new_int64(v)); }
static inline void ls_copy(struct json_object *dst, const char *to,
                           struct json_object *src, const char *from)
{ json_object_object_add(dst, to, json_object_get(native_get(src, from))); }

static inline void ls_message_free(struct ls_message *message)
{
    OPENSSL_cleanse(message->text,message->length);
    free(message);
}

static inline void ls_emit(struct ls_runtime *r, struct json_object *o)
{
    if (!o) return;
    const char *text=json_object_to_json_string_ext(o,JSON_C_TO_STRING_PLAIN);
    size_t length=text?strlen(text):0;
    struct ls_message *message=length && length<SIZE_MAX-sizeof(*message)
        ? malloc(sizeof(*message)+length+1) : NULL;
    if (!message) { json_object_put(o); return; }
    memcpy(message->text,text,length+1);
    message->length=length;
    message->next=NULL;
    message->epoch=r->active_epoch;
    message->generation=r->active_generation;
    unsigned reply=(unsigned)native_integer(o,"rsp",UINT32_MAX)&0x2ffff;
    message->guarded=(r->invalidate_commands && native_get(o,"notify")) ||
        (reply<32 && (r->guarded_replies&(1u<<reply)));
    pthread_mutex_lock(&r->lock);
    int current=r->accepting && !r->stopping &&
        message->epoch==atomic_load(&r->epoch) &&
        (!message->guarded || message->generation==atomic_load(&r->generation));
    if (current) {
        if (r->out_tail) r->out_tail->next=message;
        else r->out_head=message;
        r->out_tail=message;
        if (r->log) {
            long pos=ftell(r->log);
            if (pos>=0 && (size_t)pos<r->log_limit) {
                fprintf(r->log,"%lld queued command=%lld result=%lld notify=%lld\n",
                    (long long)time(NULL),(long long)native_integer(o,"rsp",-1),
                    (long long)native_integer(o,"result",0),
                    (long long)native_integer(o,"notify",-1));
                fflush(r->log);
            }
        }
    }
    pthread_mutex_unlock(&r->lock);
    if (!current) ls_message_free(message);
    json_object_put(o);
}

/* Call only on the JS/FFI owner thread. No lock crosses the callback. Recursive
 * pumping is suppressed; callbacks may safely call shutdown followed by init. */
static inline int ls_dispatch(struct ls_runtime *r)
{
    pthread_mutex_lock(&r->lock);
    if (r->dispatching) { pthread_mutex_unlock(&r->lock); return 0; }
    r->dispatching=1;
    pthread_mutex_unlock(&r->lock);
    int delivered=0;
    for (unsigned drained=0;drained<64;drained++) {
        pthread_mutex_lock(&r->lock);
        struct ls_message *message=r->out_head;
        if (!message) { pthread_mutex_unlock(&r->lock); break; }
        r->out_head=message->next;
        if (!r->out_head) r->out_tail=NULL;
        int current=r->accepting && message->epoch==atomic_load(&r->epoch) &&
            (!message->guarded || message->generation==atomic_load(&r->generation));
        ls_callback cb=current?r->callback:NULL;
        pthread_mutex_unlock(&r->lock);
        if (cb) { cb(message->text); delivered++; }
        ls_message_free(message);
    }
    pthread_mutex_lock(&r->lock);
    r->dispatching=0;
    pthread_mutex_unlock(&r->lock);
    return delivered;
}

static inline void ls_reply(struct ls_runtime *r, struct json_object *request,
                            int result, struct json_object *param)
{
    struct json_object *o = json_object_new_object();
    if (!o) { json_object_put(param); return; }
    ls_copy(o,"rsp",request,"cmd");
    if (json_object_is_type(native_get(request,"sno"),json_type_int) &&
        native_integer(request,"sno",-1)>=0 && native_integer(request,"sno",-1)<=UINT32_MAX)
        ls_copy(o,"sno",request,"sno");
    if (json_object_is_type(native_get(request,"description"),json_type_string))
        ls_copy(o,"description",request,"description");
    ls_int(o,"result",result);
    if (param) json_object_object_add(o,"param",param);
    ls_emit(r,o);
}

static inline void ls_notify(struct ls_runtime *r, int code, const char *description,
                             struct json_object *param)
{
    struct json_object *o = json_object_new_object();
    if (!o) { json_object_put(param); return; }
    ls_int(o,"notify",code);
    ls_string(o,"description",description);
    json_object_object_add(o,"param",param);
    ls_emit(r,o);
}

static inline void ls_schedule(struct ls_runtime *r, unsigned seconds)
{
    pthread_mutex_lock(&r->lock);
    if (r->accepting && r->active_epoch==atomic_load(&r->epoch) &&
        r->active_generation==atomic_load(&r->generation)) {
        r->due=seconds?time(NULL)+seconds:0;
        pthread_cond_signal(&r->wake);
    }
    pthread_mutex_unlock(&r->lock);
}

static void *ls_worker(void *arg)
{
    struct ls_runtime *r=arg;
    unsigned state_epoch=0;
    pthread_mutex_lock(&r->lock);
    for (;;) {
        unsigned epoch=atomic_load(&r->epoch);
        if (state_epoch!=epoch) {
            pthread_mutex_unlock(&r->lock);
            if (r->clear) r->clear();
            pthread_mutex_lock(&r->lock);
            state_epoch=epoch;
            continue;
        }
        while (!r->head && state_epoch==atomic_load(&r->epoch)) {
            if (r->accepting && r->due) {
                struct timespec deadline={r->due,0};
                int err=pthread_cond_timedwait(&r->wake,&r->lock,&deadline);
                if (err==ETIMEDOUT && r->due && time(NULL)>=r->due) break;
            } else pthread_cond_wait(&r->wake,&r->lock);
        }
        if (state_epoch!=atomic_load(&r->epoch)) continue;
        struct ls_job *job=r->head;
        if (job) {
            r->head=job->next;
            if (!r->head) r->tail=NULL;
            r->active_generation=job->generation;
        } else {
            r->due=0;
            r->active_generation=atomic_load(&r->generation);
        }
        r->active_epoch=state_epoch;
        atomic_store(&r->stopping,0);
        pthread_mutex_unlock(&r->lock);
        if (job) {
            if (job->epoch==state_epoch) r->dispatch(job->root);
            json_object_put(job->root);
            free(job);
        } else if (r->tick) r->tick();
        pthread_mutex_lock(&r->lock);
    }
}

static inline void ls_start(struct ls_runtime *r, ls_callback cb,
                            void (*dispatch)(struct json_object *),
                            void (*tick)(void), void (*clear)(void),
                            unsigned invalidate_commands, unsigned guarded_replies)
{
    pthread_mutex_lock(&r->lock);
    if (!r->accepting && cb) {
        if (!r->running) {
            r->dispatch=dispatch;
            r->tick=tick;
            r->clear=clear;
            r->invalidate_commands=invalidate_commands;
            r->guarded_replies=guarded_replies;
        }
        r->callback=cb;
        r->accepting=1;
        r->stopping=1;
        r->due=0;
        atomic_fetch_add(&r->epoch,1);
        atomic_fetch_add(&r->generation,1);
        if (!r->running) {
            if (!pthread_create(&r->thread,NULL,ls_worker,r)) {
                r->running=1;
                pthread_detach(r->thread);
            } else { r->accepting=0; r->callback=NULL; }
        }
        pthread_cond_signal(&r->wake);
    }
    pthread_mutex_unlock(&r->lock);
}

static inline void ls_send(struct ls_runtime *r, const char *text)
{
    if (!text) return;
    size_t n = strlen(text);
    if (n >= INT_MAX) return;
    struct json_tokener *tok = json_tokener_new();
    if (!tok) return;
    json_tokener_set_flags(tok,JSON_TOKENER_STRICT | JSON_TOKENER_VALIDATE_UTF8);
    struct json_object *o = json_tokener_parse_ex(tok,text,(int)n+1);
    int ok = json_tokener_get_error(tok) == json_tokener_success &&
        json_object_is_type(o,json_type_object) &&
        json_object_is_type(native_get(o,"cmd"),json_type_int) &&
        native_integer(o,"cmd",-1)>=0 && native_integer(o,"cmd",-1)<=UINT32_MAX;
    json_tokener_free(tok);
    if (!ok) { json_object_put(o); return; }
    struct ls_job *job = malloc(sizeof(*job));
    if (!job) { json_object_put(o); return; }
    job->root = o;
    job->next = NULL;
    pthread_mutex_lock(&r->lock);
    if (!r->running || !r->accepting) {
        pthread_mutex_unlock(&r->lock);
        json_object_put(o);
        free(job);
        return;
    }
    unsigned command = (unsigned)native_integer(o,"cmd",0) & 0x2ffff;
    if (command<32 && (r->invalidate_commands & (1u<<command))) {
        atomic_fetch_add(&r->generation,1);
        r->due = 0;
    }
    job->generation = atomic_load(&r->generation);
    job->epoch = atomic_load(&r->epoch);
    if (r->tail) r->tail->next = job;
    else r->head = job;
    r->tail = job;
    pthread_cond_signal(&r->wake);
    pthread_mutex_unlock(&r->lock);
}

static inline void ls_stop(struct ls_runtime *r)
{
    pthread_mutex_lock(&r->lock);
    r->accepting=0;
    r->callback=NULL;
    r->stopping=1;
    r->due=0;
    atomic_fetch_add(&r->epoch,1);
    atomic_fetch_add(&r->generation,1);
    struct ls_job *jobs=r->head;
    struct ls_message *messages=r->out_head;
    FILE *log=r->log;
    r->head=r->tail=NULL;
    r->out_head=r->out_tail=NULL;
    r->log=NULL;
    pthread_cond_signal(&r->wake);
    pthread_mutex_unlock(&r->lock);
    while (jobs) {
        struct ls_job *next=jobs->next;
        json_object_put(jobs->root);
        free(jobs);
        jobs=next;
    }
    while (messages) {
        struct ls_message *next=messages->next;
        ls_message_free(messages);
        messages=next;
    }
    if (log) fclose(log);
}

static inline void ls_log_path(struct ls_runtime *r, const char *path, int level,
                               int size_kb, int count, const char *name)
{
    (void)count; /* One bounded metadata-only file; never record user payloads. */
    FILE *file = NULL;
    if (path && *path && level >= 0 && size_kb > 0) {
        struct stat st;
        char *joined = NULL;
        if (!stat(path,&st) && S_ISDIR(st.st_mode)) {
            size_t n = strlen(path) + strlen(name) + 2;
            joined = malloc(n);
            if (joined) { snprintf(joined,n,"%s/%s",path,name); path = joined; }
        }
        if (!joined || *joined) file = fopen(path,"a");
        if (file) fchmod(fileno(file),0600);
        free(joined);
    }
    pthread_mutex_lock(&r->lock);
    if (r->log) fclose(r->log);
    r->log = file;
    r->log_limit = size_kb > 0 ? (size_t)size_kb * 1024 : 0;
    pthread_mutex_unlock(&r->lock);
}
#endif
