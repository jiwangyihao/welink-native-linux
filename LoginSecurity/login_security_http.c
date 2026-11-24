/* Compass protocol recovered from http_with_rs.dll 7.47.6.95:
 * RVAs 0xab00 request, 0xba90 response, 0xcd80 addresses, 0x7bf0 routing.
 * The supplied RS domain is authoritative; no guessed service endpoints.
 * Certificate fallback means custom CA -> platform CA with verification still
 * enabled, never a TLS verification downgrade. No body/header logging. */
#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "login_security_http.h"
#include "native_rpc.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <arpa/inet.h>
#include <openssl/rand.h>
#include <openssl/crypto.h>

static pthread_once_t http_once=PTHREAD_ONCE_INIT;
static CURLcode http_init_result;
static void http_init(void) { http_init_result=curl_global_init(CURL_GLOBAL_DEFAULT); }
static void string_free(char *s) { if(s) { OPENSSL_cleanse(s,strlen(s)); free(s); } }
static void clear_json(struct json_object *o)
{
    if (json_object_is_type(o,json_type_string))
        OPENSSL_cleanse((void *)json_object_get_string(o),(size_t)json_object_get_string_len(o));
    else if (json_object_is_type(o,json_type_object)) {
        json_object_object_foreach(o,k,v) { (void)k; clear_json(v); }
    } else if (json_object_is_type(o,json_type_array))
        for(size_t i=0;i<json_object_array_length(o);i++) clear_json(json_object_array_get_idx(o,i));
}
void ls_http_result_clear(struct ls_http_result *r)
{
    if(!r) return;
    clear_json(r->json); json_object_put(r->json);
    if(r->body.data) { OPENSSL_cleanse(r->body.data,r->body.length); free(r->body.data); }
    if(r->cookies.data) { OPENSSL_cleanse(r->cookies.data,r->cookies.length); free(r->cookies.data); }
    for(struct curl_slist *p=r->headers;p;p=p->next) OPENSSL_cleanse(p->data,strlen(p->data));
    free(r->ca_path);
    curl_slist_free_all(r->headers); memset(r,0,sizeof(*r));
}
void ls_http_context_clear(struct ls_http_context *c)
{
    clear_json(c->settings); json_object_put(c->settings);
    json_object_put(c->compass); json_object_put(c->addresses); json_object_put(c->last_ips);
    json_object_put(c->standby);
    memset(c,0,sizeof(*c));
}
int ls_http_set_rs(struct ls_http_context *c,struct json_object *settings)
{
    struct json_object *copy=NULL;
    if (!json_object_is_type(settings,json_type_object) || json_object_deep_copy(settings,&copy,NULL)) return EINVAL;
    int changed=strcmp(native_string(c->settings,"rs_url",""),native_string(settings,"rs_url",""));
    clear_json(c->settings); json_object_put(c->settings); c->settings=copy;
    if(changed) {
        json_object_put(c->compass); c->compass=NULL;
        json_object_put(c->addresses); c->addresses=NULL;
        json_object_put(c->last_ips); c->last_ips=NULL;
        json_object_put(c->standby); c->standby=NULL;
        c->queried=0; c->enabled=0;
    }
    return 0;
}
struct json_object *ls_http_compass_config(struct ls_http_context *c) { return c->compass; }
int ls_http_context_copy(struct ls_http_context *destination,const struct ls_http_context *source)
{
    if(!destination || !source) return EINVAL;
    if(destination==source) return 0;
    struct ls_http_context next={0};
    if((source->settings && json_object_deep_copy(source->settings,&next.settings,NULL)) ||
       (source->last_ips && json_object_deep_copy(source->last_ips,&next.last_ips,NULL))) {
        ls_http_context_clear(&next); return ENOMEM;
    }
    next.compass=json_object_get(source->compass);
    next.addresses=json_object_get(source->addresses);
    next.standby=json_object_get(source->standby);
    next.queried=source->queried; next.ttl=source->ttl; next.enabled=source->enabled;
    ls_http_context_clear(destination); *destination=next;
    return 0;
}
static int append(struct ls_http_buffer *b,const void *data,size_t n)
{
    if(n>(size_t)INT_MAX-1-b->length) return 0;
    size_t need=b->length+n+1;
    if(need>b->capacity) {
        size_t cap=b->capacity?b->capacity:4096;
        while(cap<need) { if(cap>(size_t)INT_MAX/2) { cap=need; break; } cap*=2; }
        char *p=realloc(b->data,cap); if(!p) return 0;
        b->data=p; b->capacity=cap;
    }
    memcpy(b->data+b->length,data,n); b->length+=n; b->data[b->length]=0; return 1;
}
static size_t body_cb(void *data,size_t size,size_t count,void *arg)
{
    if(count && size>SIZE_MAX/count) return 0;
    size_t n=size*count; return append(arg,data,n)?n:0;
}
static size_t header_cb(void *data,size_t size,size_t count,void *arg)
{
    if(count && size>SIZE_MAX/count) return 0;
    size_t n=size*count; const char *line=data; struct ls_http_result *r=arg;
    if(n>=5 && !strncasecmp(line,"HTTP/",5)) {
        curl_slist_free_all(r->headers); r->headers=NULL;
        r->cookies.length=0; if(r->cookies.data) r->cookies.data[0]=0;
    } else {
        size_t end=n; while(end && (line[end-1]=='\r'||line[end-1]=='\n')) end--;
        if(end) {
            char *copy=strndup(line,end); if(!copy) return 0;
            struct curl_slist *h=curl_slist_append(r->headers,copy); string_free(copy);
            if(!h) return 0; r->headers=h;
        }
        if(n>11 && !strncasecmp(line,"set-cookie:",11)) {
            size_t start=11; while(start<end && (line[start]==' '||line[start]=='\t')) start++;
            if(r->cookies.length && !append(&r->cookies,";",1)) return 0;
            if(!append(&r->cookies,line+start,end-start)) return 0;
        }
    }
    return n;
}
static int cancelled(const struct ls_http_options *o)
{
    return (o->cancel && atomic_load(o->cancel)) ||
        (o->generation && atomic_load(o->generation)!=o->expected_generation) ||
        (o->cancel_check && o->cancel_check(o->cancel_context));
}
struct progress_context { const struct ls_http_options *options; const struct ls_http_stream *stream; };
static int progress(void *arg,curl_off_t a,curl_off_t b,curl_off_t c,curl_off_t d)
{
    const struct progress_context *context=arg;
    if(cancelled(context->options)) return 1;
    return context->stream->progress ? context->stream->progress(context->stream->context,a,b,c,d) : 0;
}
static int cert_error(CURLcode e)
{ return e==CURLE_PEER_FAILED_VERIFICATION || e==CURLE_SSL_CACERT_BADFILE || e==CURLE_SSL_CERTPROBLEM || e==CURLE_SSL_ISSUER_ERROR; }
static struct json_object *option(struct ls_http_context *c,const struct ls_http_options *o,const char *key)
{
    struct json_object *v=native_get(o->settings,key); return v?v:native_get(c->settings,key);
}
static const char *string_option(struct ls_http_context *c,const struct ls_http_options *o,const char *key)
{
    struct json_object *v=option(c,o,key); return json_object_is_type(v,json_type_string)?json_object_get_string(v):"";
}
static int complete(const struct ls_http_result *r,const struct ls_http_options *o)
{ return !cancelled(o) && r->transport==CURLE_OK && (o->require_http_200?r->status==200:((r->status>=200 && r->status<300)||r->status==304)); }
static void parse_json(struct ls_http_result *r)
{
    if(!r->body.data) return;
    struct json_tokener *tok=json_tokener_new(); if(!tok) return;
    json_tokener_set_flags(tok,JSON_TOKENER_STRICT|JSON_TOKENER_VALIDATE_UTF8);
    r->json=json_tokener_parse_ex(tok,r->body.data,(int)r->body.length+1);
    if(json_tokener_get_error(tok)!=json_tokener_success) { json_object_put(r->json); r->json=NULL; }
    json_tokener_free(tok);
}
struct attempt_resources { struct curl_slist *headers,*resolve; };
static void attempt_clear(CURL *curl,struct attempt_resources *resources)
{
    curl_easy_setopt(curl,CURLOPT_HTTPHEADER,NULL);
    curl_easy_setopt(curl,CURLOPT_RESOLVE,NULL);
    curl_easy_setopt(curl,CURLOPT_XFERINFOFUNCTION,NULL);
    curl_easy_setopt(curl,CURLOPT_XFERINFODATA,NULL);
    for(struct curl_slist *p=resources->headers;p;p=p->next) OPENSSL_cleanse(p->data,strlen(p->data));
    curl_slist_free_all(resources->headers); curl_slist_free_all(resources->resolve);
}

static CURLcode configure_attempt(struct ls_http_context *c,CURL *curl,const char *url,
    struct curl_slist *headers,const struct ls_http_options *o,
    const char *host,const char *port,const char *ip,int system_ca,struct attempt_resources *resources)
{
    for(struct curl_slist *p=headers;p;p=p->next) {
        if(strchr(p->data,'\r')||strchr(p->data,'\n')) return CURLE_BAD_FUNCTION_ARGUMENT;
        struct curl_slist *next=curl_slist_append(resources->headers,p->data);
        if(!next) return CURLE_OUT_OF_MEMORY;
        resources->headers=next;
    }
    int has_trace=0;
    for(struct curl_slist *p=headers;p;p=p->next) {
        const char *colon=strchr(p->data,':');
        if(colon && colon-p->data==7 && !strncasecmp(p->data,"traceid",7)) {
            has_trace=1; break;
        }
    }
    if(!has_trace) {
        unsigned char random[16]; char trace[52];
        if(RAND_bytes(random,sizeof(random))!=1) return CURLE_FAILED_INIT;
        random[6]=(random[6]&15)|64; random[8]=(random[8]&63)|128;
        snprintf(trace,sizeof(trace),"traceid: pc-{%02X%02X%02X%02X-%02X%02X-%02x%02x-%02X%02X-%02X%02X%02X%02X%02X%02X}",
            random[0],random[1],random[2],random[3],random[4],random[5],random[6],random[7],
            random[8],random[9],random[10],random[11],random[12],random[13],random[14],random[15]);
        struct curl_slist *next=curl_slist_append(resources->headers,trace);
        if(!next) return CURLE_OUT_OF_MEMORY;
        resources->headers=next;
    }
    char line[384];
    int size;
    if(ip && *ip) {
        unsigned char address[16];
        if(inet_pton(AF_INET,ip,address)!=1 && inet_pton(AF_INET6,ip,address)!=1) return CURLE_BAD_FUNCTION_ARGUMENT;
        size=snprintf(line,sizeof line,strchr(ip,':')?"%s:%s:[%s]":"%s:%s:%s",host,port,ip);
    } else {
        /* easy_reset does not clear DNS overrides installed by CURLOPT_RESOLVE.
         * Explicitly remove the previous IP before the real DNS fallback. */
        size=snprintf(line,sizeof line,"-%s:%s",host,port);
    }
    if(size<0 || (size_t)size>=sizeof line) return CURLE_URL_MALFORMAT;
    resources->resolve=curl_slist_append(NULL,line);
    if(!resources->resolve) return CURLE_OUT_OF_MEMORY;
    curl_easy_setopt(curl,CURLOPT_RESOLVE,resources->resolve);
    curl_easy_setopt(curl,CURLOPT_URL,url);
    curl_easy_setopt(curl,CURLOPT_PROTOCOLS_STR,"https,http");
    curl_easy_setopt(curl,CURLOPT_FOLLOWLOCATION,0L);
    curl_easy_setopt(curl,CURLOPT_NOSIGNAL,1L);
    /* A proxy's successful CONNECT is not an origin HTTP response. In
     * particular, it must never trigger a download restart before origin TLS. */
    curl_easy_setopt(curl,CURLOPT_SUPPRESS_CONNECT_HEADERS,1L);
    /* A cached keep-alive connection must not bypass the chosen failover IP. */
    curl_easy_setopt(curl,CURLOPT_FRESH_CONNECT,1L);
    curl_easy_setopt(curl,CURLOPT_HTTPHEADER,resources->headers);
    if(o->connect_timeout_ms)
        curl_easy_setopt(curl,CURLOPT_CONNECTTIMEOUT_MS,o->connect_timeout_ms<0?0L:o->connect_timeout_ms);
    else curl_easy_setopt(curl,CURLOPT_CONNECTTIMEOUT,o->connect_timeout>0?o->connect_timeout:5L);
    if(o->total_timeout_ms)
        curl_easy_setopt(curl,CURLOPT_TIMEOUT_MS,o->total_timeout_ms<0?0L:o->total_timeout_ms);
    else curl_easy_setopt(curl,CURLOPT_TIMEOUT,o->total_timeout>0?o->total_timeout:10L);
    long verify=json_object_get_int64(option(c,o,"verify_mode"))!=0;
    curl_easy_setopt(curl,CURLOPT_SSL_VERIFYPEER,verify);
    curl_easy_setopt(curl,CURLOPT_SSL_VERIFYHOST,verify?2L:0L);
    const char *ca=string_option(c,o,"ca_cert_path");
    if(verify && *ca && !system_ca) {
        struct stat st;
        if(!stat(ca,&st) && S_ISDIR(st.st_mode)) curl_easy_setopt(curl,CURLOPT_CAPATH,ca);
        else curl_easy_setopt(curl,CURLOPT_CAINFO,ca);
    }
    if(!o->omit_client_identity) {
        const char *certificate=string_option(c,o,"client_cert_path");
        const char *key=string_option(c,o,"client_key_path");
        if(*certificate) {
            curl_easy_setopt(curl,CURLOPT_SSLCERT,certificate);
            const char *type=string_option(c,o,"client_cert_type");
            if(*type) curl_easy_setopt(curl,CURLOPT_SSLCERTTYPE,type);
        }
        if(*key) {
            curl_easy_setopt(curl,CURLOPT_SSLKEY,key);
            const char *type=string_option(c,o,"client_key_type");
            if(*type) curl_easy_setopt(curl,CURLOPT_SSLKEYTYPE,type);
            curl_easy_setopt(curl,CURLOPT_KEYPASSWD,string_option(c,o,"client_priv_keypw"));
        }
    }
    const char *proxy=string_option(c,o,"proxy_addr");
    curl_easy_setopt(curl,CURLOPT_PROXY,proxy);
    if(*proxy) {
        curl_easy_setopt(curl,CURLOPT_PROXYPORT,(long)json_object_get_int64(option(c,o,"proxy_port")));
        curl_easy_setopt(curl,CURLOPT_PROXYUSERNAME,string_option(c,o,"proxy_account"));
        curl_easy_setopt(curl,CURLOPT_PROXYPASSWORD,string_option(c,o,"proxy_pwd"));
        curl_easy_setopt(curl,CURLOPT_PROXYAUTH,(long)CURLAUTH_ANY);
    }
    return CURLE_OK;
}

static int stream_terminal(const struct ls_http_result *r,const struct ls_http_options *o,const struct ls_http_stream *stream)
{
    if(cancelled(o)) return 0;
    if(stream->terminal) return stream->terminal(r->transport,r->status,stream->context);
    return stream->transport_only ? r->transport==CURLE_OK : complete(r,o);
}

static CURLcode stream_direct(struct ls_http_context *c,CURL *curl,const char *url,
    struct curl_slist *headers,const struct ls_http_options *o,const struct ls_http_stream *stream,
    const char *host,const char *port,const char *ip,int system_ca,unsigned attempt,
    struct ls_http_result *r)
{
    ls_http_result_clear(r);
    if(cancelled(o)) { r->transport=CURLE_ABORTED_BY_CALLBACK; return r->transport; }
    curl_easy_reset(curl);
    struct attempt_resources resources={0};
    struct progress_context progress_state={o,stream};
    CURLcode ret=configure_attempt(c,curl,url,headers,o,host,port,ip,system_ca,&resources);
    if(!ret && json_object_get_int64(option(c,o,"verify_mode"))) {
        const char *custom=string_option(c,o,"ca_cert_path");
        const char *selected=custom;
        r->used_system_ca=system_ca || !*custom;
        if(r->used_system_ca) {
            char *default_file=NULL,*default_directory=NULL;
            curl_easy_getinfo(curl,CURLINFO_CAINFO,&default_file);
            curl_easy_getinfo(curl,CURLINFO_CAPATH,&default_directory);
            selected=default_file && *default_file ? default_file : default_directory;
        }
        if(selected && *selected) {
            r->ca_path=strdup(selected);
            if(!r->ca_path) ret=CURLE_OUT_OF_MEMORY;
        }
    }
    if(!ret) ret=stream->prepare(curl,attempt,url,stream->context);
    if(!ret) {
        curl_easy_setopt(curl,CURLOPT_NOPROGRESS,0L);
        curl_easy_setopt(curl,CURLOPT_XFERINFOFUNCTION,progress);
        curl_easy_setopt(curl,CURLOPT_XFERINFODATA,&progress_state);
        ret=cancelled(o)?CURLE_ABORTED_BY_CALLBACK:curl_easy_perform(curl);
        curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&r->status);
        char *primary=NULL;
        curl_easy_getinfo(curl,CURLINFO_PRIMARY_IP,&primary);
        if(primary) snprintf(r->primary_ip,sizeof r->primary_ip,"%s",primary);
    }
    if(cancelled(o)) ret=CURLE_ABORTED_BY_CALLBACK;
    snprintf(r->target_host,sizeof r->target_host,"%s",host);
    r->target_port=(unsigned)strtoul(port,NULL,10);
    attempt_clear(curl,&resources);
    r->transport=ret;
    return ret;
}

static CURLcode stream_attempt(struct ls_http_context *c,CURL *curl,const char *url,
    struct curl_slist *headers,const struct ls_http_options *o,const struct ls_http_stream *stream,
    const char *host,const char *port,const char *ip,unsigned *number,struct ls_http_result *r)
{
    CURLcode ret=stream_direct(c,curl,url,headers,o,stream,host,port,ip,0,(*number)++,r);
    if(!cancelled(o) && cert_error(ret) && *string_option(c,o,"ca_cert_path")) {
        ret=stream_direct(c,curl,url,headers,o,stream,host,port,ip,1,(*number)++,r);
        r->ca_fallback=1;
    }
    if(cancelled(o)) { r->transport=CURLE_ABORTED_BY_CALLBACK; return r->transport; }
    if(stream_terminal(r,o,stream) && ret==CURLE_OK && *r->primary_ip) {
        if(!c->last_ips) c->last_ips=json_object_new_object();
        json_object_object_add(c->last_ips,host,json_object_new_string(r->primary_ip));
    }
    return ret;
}

struct buffered_request { const char *method; const void *body; size_t size; struct ls_http_result *result; };
static CURLcode buffered_prepare(CURL *curl,unsigned attempt,const char *url,void *opaque)
{
    (void)attempt; (void)url;
    struct buffered_request *request=opaque;
    if(!strcmp(request->method,"HEAD")) curl_easy_setopt(curl,CURLOPT_NOBODY,1L);
    else if(strcmp(request->method,"GET") || request->size) {
        curl_easy_setopt(curl,CURLOPT_POSTFIELDS,request->body?request->body:"");
        curl_easy_setopt(curl,CURLOPT_POSTFIELDSIZE_LARGE,(curl_off_t)request->size);
    }
    curl_easy_setopt(curl,CURLOPT_CUSTOMREQUEST,request->method);
    curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,body_cb);
    curl_easy_setopt(curl,CURLOPT_WRITEDATA,&request->result->body);
    curl_easy_setopt(curl,CURLOPT_HEADERFUNCTION,header_cb);
    curl_easy_setopt(curl,CURLOPT_HEADERDATA,request->result);
    return CURLE_OK;
}

static CURLcode attempt(struct ls_http_context *c,const char *url,const char *method,const void *body,size_t n,
    struct curl_slist *headers,const struct ls_http_options *o,const char *host,const char *port,
    const char *ip,struct ls_http_result *r)
{
    CURL *curl=curl_easy_init();
    if(!curl) { r->transport=CURLE_OUT_OF_MEMORY; return r->transport; }
    struct buffered_request request={method,body,n,r};
    struct ls_http_stream stream={.prepare=buffered_prepare,.context=&request};
    unsigned number=0;
    CURLcode result=stream_attempt(c,curl,url,headers,o,&stream,host,port,ip,&number,r);
    parse_json(r); curl_easy_cleanup(curl);
    return result;
}
static int compare_member_names(const void *left,const void *right)
{ return strcmp(*(const char *const *)left,*(const char *const *)right); }

/* Json::Value's recursive flattening at RVA 0xee30 uses the immediate member
 * name, array suffixes "[index]", and only string leaves. */
static int flatten_standby(struct json_object *output,struct json_object *value,const char *key)
{
    if(json_object_is_type(value,json_type_object)) {
        size_t count=(size_t)json_object_object_length(value);
        if(count<2) {
            json_object_object_foreach(value,name,child) {
                if(flatten_standby(output,child,name)) return ENOMEM;
            }
            return 0;
        }
        if(count>SIZE_MAX/sizeof(char *)) return ENOMEM;
        const char **names=malloc(count*sizeof(*names));
        if(!names) return ENOMEM;
        size_t index=0;
        json_object_object_foreach(value,name,child) { (void)child; names[index++]=name; }
        qsort(names,count,sizeof(*names),compare_member_names);
        /* JsonCpp member enumeration is lexical. This matters when different
         * nested objects flatten to the same immediate member name. */
        int error=0;
        for(index=0;index<count && !error;index++)
            error=flatten_standby(output,native_get(value,names[index]),names[index]);
        free(names); return error;
    }
    if(json_object_is_type(value,json_type_array)) {
        size_t length=strlen(key);
        if(length>SIZE_MAX-32) return ENOMEM;
        char *indexed=malloc(length+32);
        if(!indexed) return ENOMEM;
        memcpy(indexed,key,length);
        int error=0;
        for(size_t i=0;i<json_object_array_length(value) && !error;i++) {
            snprintf(indexed+length,32,"[%zu]",i);
            error=flatten_standby(output,json_object_array_get_idx(value,i),indexed);
        }
        free(indexed); return error;
    }
    struct json_object *leaf=json_object_is_type(value,json_type_string)
        ? json_object_get(value) : json_object_new_string("");
    if(!leaf) return ENOMEM;
    if(json_object_object_add(output,key,leaf)) { json_object_put(leaf); return ENOMEM; }
    return 0;
}

const char *ls_http_standby_domain(const struct ls_http_context *c,const char *host)
{
    if(!c || !host || !json_object_is_type(c->standby,json_type_object)) return NULL;
    const char *suffix=strstr(host,".com");
    size_t length=strlen(host);
    if(!suffix || length>=256) return NULL;
    char needle[256];
    size_t prefix=(size_t)(suffix-host);
    memcpy(needle,host,prefix); memcpy(needle+prefix,suffix+4,length-prefix-3);
    const char *selected=NULL,*selected_key=NULL;
    /* Original storage is std::map: choose the first matching flattened key
     * lexically, not JSON source-member order. Values are never synthesized. */
    json_object_object_foreach(c->standby,key,value) {
        const char *candidate=json_object_get_string(value);
        if(candidate && *candidate && strlen(candidate)<256 &&
           !strpbrk(candidate,"/:@?#\\ \t\r\n") && strstr(candidate,needle) &&
           (!selected_key || strcmp(key,selected_key)<0)) {
            selected=candidate; selected_key=key;
        }
    }
    return selected;
}
static CURLcode update_compass(struct ls_http_context *c,struct json_object *o)
{
    if(!json_object_is_type(o,json_type_object)) return CURLE_WEIRD_SERVER_REPLY;
    struct json_object *copy=NULL;
    if(json_object_deep_copy(o,&copy,NULL)) return CURLE_OUT_OF_MEMORY;
    int64_t stamp=native_integer(copy,"lastUpdateTime",0);
    int changed=!c->compass || stamp!=native_integer(c->compass,"lastUpdateTime",0);
    if(changed) {
        struct json_object *addresses=json_object_new_object(),*standby=json_object_new_object();
        CURLcode error=CURLE_OK;
        if(!addresses || !standby) error=CURLE_OUT_OF_MEMORY;
        struct json_object *dns=native_get(copy,"httpDns");
        if(!error && json_object_is_type(dns,json_type_array)) for(size_t i=0;i<json_object_array_length(dns) && !error;i++) {
            struct json_object *entry=json_object_array_get_idx(dns,i),*ips=native_get(entry,"ipV4s");
            const char *domain=native_string(entry,"domain","");
            if(!*domain || !json_object_is_type(ips,json_type_array)) continue;
            size_t count=json_object_array_length(ips);
            struct json_object *selected=json_object_new_array();
            if(!selected) { error=CURLE_OUT_OF_MEMORY; break; }
            /* Vendor independently samples its access/active/standby IPv4 slots. */
            for(size_t k=0;k<3 && count && !error;k++) {
                uint32_t random;
                if(RAND_bytes((unsigned char *)&random,sizeof(random))!=1) { error=CURLE_FAILED_INIT; break; }
                struct json_object *ip=json_object_array_get_idx(ips,random%count);
                unsigned char addr[4];
                if(!json_object_is_type(ip,json_type_string)||inet_pton(AF_INET,json_object_get_string(ip),addr)!=1) continue;
                int duplicate=0;
                for(size_t j=0;j<json_object_array_length(selected);j++)
                    if(!strcmp(json_object_get_string(ip),json_object_get_string(json_object_array_get_idx(selected,j)))) duplicate=1;
                if(!duplicate) {
                    struct json_object *value=json_object_new_string(json_object_get_string(ip));
                    if(!value || json_object_array_add(selected,value)) { json_object_put(value); error=CURLE_OUT_OF_MEMORY; }
                }
            }
            if(error || json_object_object_add(addresses,domain,selected)) {
                json_object_put(selected); if(!error) error=CURLE_OUT_OF_MEMORY;
            }
        }
        if(!error && flatten_standby(standby,native_get(copy,"standbyDomainConfig"),"")) error=CURLE_OUT_OF_MEMORY;
        if(error) { json_object_put(addresses); json_object_put(standby); json_object_put(copy); return error; }
        json_object_put(c->addresses); c->addresses=addresses;
        json_object_put(c->standby); c->standby=standby;
    }
    json_object_put(c->compass); c->compass=copy;
    c->enabled=native_integer(copy,"enable",0)!=0;
    c->ttl=(long)native_integer(copy,"ttl",300); if(c->ttl<0) c->ttl=0;
    c->queried=time(NULL);
    return CURLE_OK;
}
CURLcode ls_http_query_compass(struct ls_http_context *c,const struct ls_http_options *request_options,int force)
{
    if(!c || !request_options) return CURLE_BAD_FUNCTION_ARGUMENT;
    pthread_once(&http_once,http_init);
    if(http_init_result) return http_init_result;
    if(cancelled(request_options)) return CURLE_ABORTED_BY_CALLBACK;
    const char *rs=native_string(c->settings,"rs_url","");
    if(!*rs || strpbrk(rs,"/@?#\\ \t\r\n")) return CURLE_URL_MALFORMAT;
    if(!force && c->compass && c->queried && time(NULL)-c->queried<c->ttl) return CURLE_OK;
    char *authorities[2]={strdup(rs),NULL}; if(!authorities[0]) return CURLE_OUT_OF_MEMORY;
    CURLcode result=CURLE_URL_MALFORMAT;
    const char *match=strstr(rs,".com"); const char *replace=".cn"; size_t old=4;
    if(!match) { match=strstr(rs,".cn"); replace=".com"; old=3; }
    if(match) {
        size_t length=strlen(rs)+strlen(replace)-old;
        authorities[1]=malloc(length+1);
        if(!authorities[1]) { free(authorities[0]); return CURLE_OUT_OF_MEMORY; }
        size_t prefix=(size_t)(match-rs); memcpy(authorities[1],rs,prefix);
        strcpy(authorities[1]+prefix,replace);
        strcpy(authorities[1]+prefix+strlen(replace),match+old);
    }
    struct ls_http_options o=*request_options;
    o.settings=c->settings; o.connect_timeout=10; o.total_timeout=30;
    o.connect_timeout_ms=0; o.total_timeout_ms=0; o.require_http_200=1;
    /* Compass must never inherit a service's mTLS identity or token headers. */
    o.omit_client_identity=1;
    struct curl_slist *headers=curl_slist_append(NULL,"Content-Type: application/json");
    if(!headers) { result=CURLE_OUT_OF_MEMORY; goto finished; }
    for(size_t i=0;i<2 && authorities[i] && !cancelled(&o);i++) {
        const char *authority=authorities[i],*app="6489640385";
        if(strstr(authority,"compass.clouduat.welink.huawei")||strstr(authority,"compass.uat.welink.huawei"))
            app="7344063024";
        else if(strstr(authority,"compass.gamma.welink.huawei")) app="9847854332";
        size_t length=strlen(authority)+40; char *url=malloc(length);
        if(!url) { result=CURLE_OUT_OF_MEMORY; break; }
        snprintf(url,length,"https://%s/compass/api/v1/hosts",authority);
        CURLU *parsed=curl_url(); char *host=NULL,*port=NULL;
        if(!parsed || curl_url_set(parsed,CURLUPART_URL,url,0) ||
           curl_url_get(parsed,CURLUPART_HOST,&host,0) ||
           curl_url_get(parsed,CURLUPART_PORT,&port,CURLU_DEFAULT_PORT)) {
            result=parsed?CURLE_URL_MALFORMAT:CURLE_OUT_OF_MEMORY;
            curl_free(host); curl_free(port); curl_url_cleanup(parsed); free(url); continue;
        }
        struct json_object *body=json_object_new_object();
        if(!body) {
            result=CURLE_OUT_OF_MEMORY;
            curl_free(host); curl_free(port); curl_url_cleanup(parsed); free(url); break;
        }
        json_object_object_add(body,"appId",json_object_new_string(app));
        json_object_object_add(body,"userTenantId",json_object_new_string(native_string(c->settings,"userTenantId","")));
        json_object_object_add(body,"userAccount",json_object_new_string(native_string(c->settings,"userAccount","")));
        const char *text=json_object_to_json_string_ext(body,JSON_C_TO_STRING_PLAIN);
        struct ls_http_result r={0};
        const char *last=native_string(c->last_ips,host,"");
        int used_last=*last!=0;
        attempt(c,url,"POST",text,strlen(text),headers,&o,host,port,used_last?last:NULL,&r);
        int success=complete(&r,&o) && json_object_is_type(r.json,json_type_object);
        if(!success && used_last && !cancelled(&o)) {
            attempt(c,url,"POST",text,strlen(text),headers,&o,host,port,NULL,&r);
            success=complete(&r,&o) && json_object_is_type(r.json,json_type_object);
        }
        result=r.transport ? r.transport : r.status!=200 ? CURLE_HTTP_RETURNED_ERROR : CURLE_WEIRD_SERVER_REPLY;
        if(success) result=update_compass(c,r.json);
        ls_http_result_clear(&r); json_object_put(body);
        curl_free(host); curl_free(port); curl_url_cleanup(parsed); free(url);
        if(result==CURLE_OK || result==CURLE_OUT_OF_MEMORY) break;
    }
finished:
    curl_slist_free_all(headers); free(authorities[0]); free(authorities[1]);
    return cancelled(request_options)?CURLE_ABORTED_BY_CALLBACK:result;
}

static int perform_domain(struct ls_http_context *c,CURL *curl,const char *url,
    const char *host,const char *port,struct curl_slist *headers,const struct ls_http_options *o,
    const struct ls_http_stream *stream,unsigned *number,struct ls_http_result *r)
{
    const char *last=native_string(c->last_ips,host,"");
    if(*last && strcmp(last,host)) {
        stream_attempt(c,curl,url,headers,o,stream,host,port,last,number,r);
        if(stream_terminal(r,o,stream) || r->transport==CURLE_ABORTED_BY_CALLBACK) return 1;
    }
    if(c->enabled && c->queried && time(NULL)-c->queried<c->ttl) {
        struct json_object *ips=native_get(c->addresses,host);
        if(json_object_is_type(ips,json_type_array)) for(size_t i=0;i<json_object_array_length(ips);i++) {
            const char *ip=json_object_get_string(json_object_array_get_idx(ips,i));
            if(*last && !strcmp(ip,last)) continue;
            stream_attempt(c,curl,url,headers,o,stream,host,port,ip,number,r);
            if(stream_terminal(r,o,stream) || r->transport==CURLE_ABORTED_BY_CALLBACK) return 1;
        }
    }
    stream_attempt(c,curl,url,headers,o,stream,host,port,NULL,number,r);
    return stream_terminal(r,o,stream) || r->transport==CURLE_ABORTED_BY_CALLBACK;
}

CURLcode ls_http_perform_stream(struct ls_http_context *c,CURL *curl,const char *url,
    struct curl_slist *headers,const struct ls_http_options *o,
    const struct ls_http_stream *stream,struct ls_http_result *r)
{
    if(!r) return CURLE_BAD_FUNCTION_ARGUMENT;
    memset(r,0,sizeof(*r)); pthread_once(&http_once,http_init);
    if(!c || !curl || !url || !o || !stream || !stream->prepare) {
        r->transport=CURLE_BAD_FUNCTION_ARGUMENT; return r->transport;
    }
    if(http_init_result) { r->transport=http_init_result; return r->transport; }
    CURLU *parsed=curl_url();
    char *host=NULL,*port=NULL,*scheme=NULL,*user=NULL,*standby_url=NULL;
    r->transport=CURLE_URL_MALFORMAT;
    if(!parsed || curl_url_set(parsed,CURLUPART_URL,url,0) ||
       curl_url_get(parsed,CURLUPART_HOST,&host,0) || strlen(host)>=sizeof r->target_host ||
       curl_url_get(parsed,CURLUPART_PORT,&port,CURLU_DEFAULT_PORT) ||
       curl_url_get(parsed,CURLUPART_SCHEME,&scheme,0) ||
       (strcmp(scheme,"https") && strcmp(scheme,"http")) ||
       curl_url_get(parsed,CURLUPART_USER,&user,0)!=CURLUE_NO_USER) goto done;
    (void)ls_http_query_compass(c,o,0);
    if(cancelled(o)) { r->transport=CURLE_ABORTED_BY_CALLBACK; goto done; }
    unsigned number=0;
    if(perform_domain(c,curl,url,host,port,headers,o,stream,&number,r)) goto done;
    const char *standby=ls_http_standby_domain(c,host);
    if(standby && strcasecmp(standby,host) &&
       !curl_url_set(parsed,CURLUPART_HOST,standby,0) &&
       !curl_url_get(parsed,CURLUPART_URL,&standby_url,0))
        perform_domain(c,curl,standby_url,standby,port,headers,o,stream,&number,r);
done:
    if(cancelled(o)) r->transport=CURLE_ABORTED_BY_CALLBACK;
    curl_free(host); curl_free(port); curl_free(scheme); curl_free(user);
    curl_free(standby_url); curl_url_cleanup(parsed);
    return r->transport;
}

CURLcode ls_http_perform(struct ls_http_context *c,const char *url,const char *method,
    const void *body,size_t body_size,struct curl_slist *headers,const struct ls_http_options *o,struct ls_http_result *r)
{
    if(!r) return CURLE_BAD_FUNCTION_ARGUMENT;
    memset(r,0,sizeof(*r)); pthread_once(&http_once,http_init);
    if(!method || (!body && body_size)) {
        r->transport=CURLE_BAD_FUNCTION_ARGUMENT; return r->transport;
    }
    if(http_init_result) { r->transport=http_init_result; return r->transport; }
    CURL *curl=curl_easy_init();
    if(!curl) { r->transport=CURLE_OUT_OF_MEMORY; return r->transport; }
    struct buffered_request request={method,body,body_size,r};
    struct ls_http_stream stream={.prepare=buffered_prepare,.context=&request};
    CURLcode result=ls_http_perform_stream(c,curl,url,headers,o,&stream,r);
    parse_json(r); curl_easy_cleanup(curl);
    return result;
}
