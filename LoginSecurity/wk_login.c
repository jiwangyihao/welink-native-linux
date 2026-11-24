/* Native Linux wk_login protocol implementation, reconstructed from the shipped
 * 7.47.6.95 DLL (not from recorded credentials). Commands 1..13 and notify 1..4
 * are the original JSON bus. QR creation/polling and SSO UI are in HwAccount.js;
 * command 4 exchanges their code with the actual HTTPS LoginPReg service.
 * Dependencies: libcurl, json-c, OpenSSL libcrypto, pthread. No Wine backend.
 * Credentials/tokens live only in memory; persistence remains the caller's KMC
 * and SQLite responsibility. Logging is limited to command/result identifiers. */
#define _DEFAULT_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "login_security_runtime.h"
#include "login_security_dispatch.h"
#include "login_security_crypto.h"
#include "login_security_identity.h"
#include "login_security_http.h"
#include <curl/curl.h>
#include <openssl/rand.h>
#include <strings.h>

#define LOGIN_GENERAL 10001
#define LOGIN_PARAM 10002
#define LOGIN_TIMEOUT 10003
#define LOGIN_NETWORK 10004
#define LOGIN_CERT 10005
#define LOGIN_REAUTH 10013
#define LOGIN_HTTP 10025
#define LOGIN_DECRYPT 10026
#define LOGIN_LOCAL_IP 10029

/* Request kind is the native FSM's connectType, not the UI login_type. */
enum login_request_kind { LOGIN_AUTH_REQUEST, LOGIN_REFRESH_REQUEST, LOGIN_RECONNECT_REQUEST };
enum login_retry_policy { LOGIN_NO_RETRY, LOGIN_RETRY_SHORT, LOGIN_RETRY_RANDOM,
                          LOGIN_RETRY_LINEAR, LOGIN_RETRY_RATE };

static struct ls_runtime login_runtime = LS_RUNTIME_INIT;
static struct ls_http_context login_transport;
static struct {
    struct json_object *auth, *data, *device;
    EVP_PKEY *key;
    int key_configured, intent, status, reconnecting, phase;
    enum login_request_kind timer_kind;
    time_t last_refresh;
    unsigned retry_seconds;
    char serial[67];
    char *cookies, *expired_auth_code;
} login;
struct login_response {
    struct ls_http_buffer body, cookies;
    struct json_object *json;
    long status;
    int error;
};

static int login_generation_current(void)
{
    return !atomic_load(&login_runtime.stopping) &&
        atomic_load(&login_runtime.generation)==login_runtime.active_generation;
}

static void login_clean_free(char *text)
{ if (text) { OPENSSL_cleanse(text,strlen(text)); free(text); } }
static void login_wipe_json(struct json_object *o)
{
    if (json_object_is_type(o,json_type_string)) {
        OPENSSL_cleanse((void *)json_object_get_string(o),(size_t)json_object_get_string_len(o));
    } else if (json_object_is_type(o,json_type_object)) {
        json_object_object_foreach(o,k,v) { (void)k; login_wipe_json(v); }
    } else if (json_object_is_type(o,json_type_array)) {
        for (size_t i=0;i<json_object_array_length(o);i++) login_wipe_json(json_object_array_get_idx(o,i));
    }
}
static void login_drop(struct json_object **o)
{ if (*o) { login_wipe_json(*o); json_object_put(*o); *o = NULL; } }
static struct json_object *login_clone(struct json_object *o)
{
    struct json_object *copy = NULL;
    if (!o) return json_object_new_object();
    if (json_object_deep_copy(o,&copy,NULL)) return NULL;
    return copy;
}
static const char *login_string(struct json_object *o, const char *key)
{ return native_string(o,key,""); }

static int login_header(struct curl_slist **headers,const char *name,const char *value)
{
    if (strchr(value,'\r') || strchr(value,'\n')) return 0;
    size_t a=strlen(name), b=strlen(value);
    if (b>SIZE_MAX-a-3) return 0;
    char *line=malloc(a+b+3);
    if (!line) return 0;
    memcpy(line,name,a); line[a]=':'; line[a+1]=' ';
    memcpy(line+a+2,value,b+1);
    struct curl_slist *list=curl_slist_append(*headers,line);
    login_clean_free(line);
    if (!list) return 0;
    *headers=list; return 1;
}

static struct login_response login_http(struct json_object *params,const char *path,
                                       const char *body,int kind)
{
    struct login_response r={0};
    r.error=LOGIN_GENERAL;
    CURLU *url=curl_url();
    struct curl_slist *headers=NULL;
    char *encoded_url=NULL;
    if (!url) goto done;
    const char *host=login_string(params,"middle_ground_addr");
    long port=(long)native_integer(params,"middle_ground_port",443);
    char number[24]; snprintf(number,sizeof(number),"%ld",port);
    r.error=LOGIN_PARAM;
    if (!*host || port<=0 || port>65535 ||
        curl_url_set(url,CURLUPART_SCHEME,"https",0) ||
        curl_url_set(url,CURLUPART_HOST,host,0) ||
        curl_url_set(url,CURLUPART_PORT,number,0) ||
        curl_url_set(url,CURLUPART_PATH,path,0) ||
        curl_url_get(url,CURLUPART_URL,&encoded_url,0)) goto done;
    const char *lang=native_string(params,"middle_ground_lang","en");
    int platform=(int)native_integer(params,"platform",100);
    const char *agent=(platform==100 || platform==101 || kind==2) ? "WeLink-meeting" : "";
    char masked_serial[67];
    login_security_mask_uuid(login.serial,masked_serial,sizeof(masked_serial));
    if (!login_header(&headers,"Content-Type",kind==1?"application/x-www-form-urlencoded":"application/json") ||
        !login_header(&headers,"User-Agent",agent) || !login_header(&headers,"host",host) ||
        !login_header(&headers,"lang",lang)) goto done;
    if (kind==0 && (!login_header(&headers,"tmpCode",login_string(params,"tmp_code")) ||
                   !login_header(&headers,"uuid",masked_serial))) goto done;
    if (kind==1) {
        const char *token=login_string(login.data,"crypt_token");
        size_t length=strlen(token)+7;
        char *cookie=malloc(length);
        if (!cookie) goto done;
        snprintf(cookie,length,"token=%s",token);
        int ok=login_header(&headers,"Cookie",cookie) &&
            login_header(&headers,"x-wlk-Authorization",token) && login_header(&headers,"uuid",masked_serial);
        login_clean_free(cookie);
        if (!ok) goto done;
    }
    if (kind==2 && !login_header(&headers,"setPasswordToken",login_string(params,"set_pwd_token"))) goto done;
    struct ls_http_options options={
        .settings=params, .connect_timeout=5, .total_timeout=10,
        .cancel=&login_runtime.stopping, .require_http_200=1,
        .generation=kind==0 ? &login_runtime.generation : NULL,
        .expected_generation=login_runtime.active_generation
    };
    struct ls_http_result response={0};
    CURLcode code=ls_http_perform(&login_transport,encoded_url,"POST",body,strlen(body),headers,&options,&response);
    r.body=response.body; memset(&response.body,0,sizeof(response.body));
    r.cookies=response.cookies; memset(&response.cookies,0,sizeof(response.cookies));
    r.json=response.json; response.json=NULL;
    r.status=response.status;
    ls_http_result_clear(&response);
    if (code==CURLE_OPERATION_TIMEDOUT) r.error=LOGIN_TIMEOUT;
    else if (code==CURLE_PEER_FAILED_VERIFICATION || code==CURLE_SSL_CACERT_BADFILE ||
             code==CURLE_SSL_CERTPROBLEM || code==CURLE_SSL_ISSUER_ERROR) r.error=LOGIN_CERT;
    else if (code!=CURLE_OK) r.error=LOGIN_NETWORK;
    else r.error=r.status==200 && json_object_is_type(r.json,json_type_object) ? 0 : LOGIN_HTTP;
done:
    curl_free(encoded_url);
    /* curl_slist stores credentials; wipe values before freeing the list. */
    for (struct curl_slist *p=headers;p;p=p->next) OPENSSL_cleanse(p->data,strlen(p->data));
    curl_slist_free_all(headers);
    curl_url_cleanup(url);
    return r;
}
static void login_response_free(struct login_response *r)
{
    login_drop(&r->json);
    if (r->body.data) { OPENSSL_cleanse(r->body.data,r->body.length); free(r->body.data); }
    if (r->cookies.data) { OPENSSL_cleanse(r->cookies.data,r->cookies.length); free(r->cookies.data); }
}

static int login_map_error(int code)
{
    static const struct { int server,native; } map[] = {
        {401,10008},{1031,10018},{1000,10006},{1030,10006},{1100,10006},
        {1101,10006},{1102,10006},{1103,10006},{1108,10028},{1200,10006},
        {1201,10006},{1202,10006},{1145,10012},{1146,10007},{1021,10008},
        {1052,10008},{1055,10008},{4003,10016},{4006,10017},{4004,10013},
        {4005,10013},{41566,10017},{41567,10013},{41516,10013},{41568,10014},
        {41524,10015},{41594,10020},{41543,10021},{412000,10012},{41506,10022},
        {41505,10023},{41580,10001},{41581,10001},{41597,10026},{41598,10027},
        {41900,10001}
    };
    for (size_t i=0;i<sizeof(map)/sizeof(*map);i++) if (map[i].server==code) return map[i].native;
    return LOGIN_GENERAL;
}
static int login_result(struct login_response *r, int logout,
                        const char **message,const char **server_code,char number[32])
{
    *message=""; *server_code="";
    if (r->error) return r->error;
    if (!logout && *login_string(r->json,"crypt_token")) return 0;
    if (logout) {
        const char *code=login_string(r->json,"code");
        /* Vendor's logout parser treats any nonempty string code as success. */
        if (*code) return 0;
    }
    struct json_object *code=native_get(r->json,"code");
    if (json_object_is_type(code,json_type_int)) {
        snprintf(number,32,"%lld",(long long)json_object_get_int64(code));
        *server_code=number;
        *message=login_string(r->json,"message");
        int mapped=login_map_error(json_object_get_int(code));
        if (mapped!=LOGIN_GENERAL) return mapped;
    }
    *server_code=native_string(r->json,"errorCode",*server_code);
    *message=native_string(r->json,"errorMessage",*message);
    char *end; long n=strtol(*server_code,&end,10);
    if (!**server_code || *end || n>INT_MAX || n<INT_MIN) return LOGIN_GENERAL;
    if (logout) return n==0 ? 0 : (int)n;
    return login_map_error((int)n);
}

static void login_failure(struct json_object *request,int result,const char *message,
                          const char *server_code,const char *set_password)
{
    if (request) {
        struct json_object *p=json_object_new_object();
        ls_string(p,"message",message);
        ls_string(p,"middleGroundErrorCode",server_code);
        ls_string(p,"middleGroundSetPasswordToken",set_password);
        ls_reply(&login_runtime,request,result,p);
    }
    struct json_object *p=json_object_new_object();
    ls_int(p,"error_code",result); ls_string(p,"message",message);
    ls_string(p,"middleGroundErrorCode",server_code);
    ls_notify(&login_runtime,1,"welink_login_on_error",p);
}
static void login_status_event(void)
{
    static const struct { const char *out,*in; } fields[] = {
        {"uuid","uid"},{"tenantid","userType"},{"onebox_address","oneboxUrl"},
        {"middle_ground_token","crypt_token"},{"middle_ground_sso_login_url","ssoLoginUrl"},
        {"middle_ground_tenant_admin_portal","tenantAdminPortal"},
        {"middle_ground_phone_number","phoneNumber"},{"middle_ground_country_code","countryCode"},
        {"maa_uri","desktopMaa"},{"meeting_login_url","meetingurl"},{"email","email"},
        {"middle_ground_refreshtoken","refresh_token"}
    };
    struct json_object *p=json_object_new_object();
    ls_int(p,"login_status",login.status); ls_int(p,"loginIntent",login.intent);
    for (size_t i=0;i<sizeof(fields)/sizeof(*fields);i++)
        ls_string(p,fields[i].out,login_string(login.data,fields[i].in));
    ls_int(p,"imGray",native_integer(login.data,"x-wlk-gray",0));
    ls_string(p,"middle_ground_onebox_cookie",login.cookies);
    json_object_object_add(p,"is_refreshtoken_or_reconnect",json_object_new_boolean(login.reconnecting));
    if (native_get(login.data,"hmenus")) ls_copy(p,"hmenus",login.data,"hmenus");
    struct json_object *config=native_get(login.data,"welinkPcConfig"), *sets=native_get(login.data,"busisets");
    json_object_object_add(p,"middle_ground_configuration",config?json_object_get(config):json_object_new_object());
    json_object_object_add(p,"busisets",sets?json_object_get(sets):json_object_new_object());
    ls_notify(&login_runtime,2,"welink_login_on_login_status_change",p);
}
static struct json_object *login_success_param(void)
{
    static const struct { const char *out,*in; } fields[] = {
        {"uuid","uid"},{"tenantid","userType"},{"middleGroundExpiredPwdTip","expiredPwdTip"},
        {"middleGroundSetPasswordToken","setPasswordToken"},{"email","email"},
        {"middleGroundPhoneNumber","phoneNumber"},{"middleGroundCountryCode","countryCode"},
        {"middleGroundToken","crypt_token"}
    };
    struct json_object *p=json_object_new_object();
    for (size_t i=0;i<sizeof(fields)/sizeof(*fields);i++)
        ls_string(p,fields[i].out,login_string(login.data,fields[i].in));
    json_object_object_add(p,"middleGroundNeedChangePassword",
        json_object_new_boolean(!strcmp(login_string(login.data,"needChangePassword"),"1")));
    ls_string(p,"middleGroundSetUMCookie",login.cookies);
    if (native_get(login.data,"hmenus")) ls_copy(p,"hmenus",login.data,"hmenus");
    return p;
}
static int login_install_response(struct login_response *r,const char *used_code)
{
    struct json_object *data=login_clone(login.data);
    if (!data) return ENOMEM;
    /* Refresh replies omit unchanged fields; the DLL retains their old values. */
    json_object_object_foreach(r->json,key,value) {
        if (!value || (json_object_is_type(value,json_type_string) && !json_object_get_string_len(value))) continue;
        struct json_object *copy=NULL;
        if (json_object_deep_copy(value,&copy,NULL)) { json_object_put(data); return ENOMEM; }
        json_object_object_add(data,key,copy);
    }
    /* These scalar fields are assigned on every response, unlike strings. */
    ls_int(data,"expires_in",native_integer(r->json,"expires_in",7200));
    ls_int(data,"refresh_expires_in",native_integer(r->json,"refresh_expires_in",0));
    ls_int(data,"x-wlk-gray",native_integer(r->json,"x-wlk-gray",0));
    ls_string(data,"needChangePassword",login_string(r->json,"needChangePassword"));
    char *expired=NULL;
    if (*used_code && strcmp(used_code,login.expired_auth_code?login.expired_auth_code:"")) {
        expired=strdup(used_code);
        if (!expired) { login_drop(&data); return ENOMEM; }
    }
    /* Serialize token publication with lifecycle-command enqueue. A cancelled
     * response must not install credentials even if curl already completed. */
    pthread_mutex_lock(&login_runtime.lock);
    if (!login_generation_current()) {
        pthread_mutex_unlock(&login_runtime.lock);
        login_clean_free(expired);
        login_drop(&data);
        return ECANCELED;
    }
    login_drop(&login.data); login.data=data;
    if (r->cookies.length) {
        login_clean_free(login.cookies); login.cookies=r->cookies.data;
        memset(&r->cookies,0,sizeof(r->cookies));
    }
    if (expired) {
        login_clean_free(login.expired_auth_code);
        login.expired_auth_code=expired;
    }
    pthread_mutex_unlock(&login_runtime.lock);
    return 0;
}
static int login_key(void)
{
    if (!login.key_configured) {
        login.key=login_read_key(login_default_public_key);
        login.key_configured=1;
    }
    return login.key!=NULL;
}
static int login_encrypted_field(struct json_object *body,const char *field,const char *plain)
{
    char *cipher=login_rsa_base64(login.key,plain);
    if (!cipher) return 0;
    int valid=!*plain || *cipher;
    if (valid) ls_string(body,field,cipher);
    login_clean_free(cipher); return valid;
}
static struct json_object *login_request_body(const char **path,const char **used_code)
{
    if (!login_key()) return NULL;
    struct json_object *p=login.auth, *body=json_object_new_object();
    if (!body) return NULL;
    int type=(int)native_integer(p,"login_type",0),ok=1;
    /* RVA 0x24510 chooses credentials independently of request kind:
     * normal/penetrate use the stored refresh token when present, otherwise
     * their retained credentials. Type 4 uses the caller-supplied refresh token.
     * SSO/QR may use a code only until a successful response consumes it. */
    const char *token=type==4?login_string(p,"refreshtoken"):login_string(login.data,"refresh_token");
    const char *code=login_string(p,"middle_ground_auth_code");
    int code_login=(type==1 || type==2) && *code &&
        strcmp(code,login.expired_auth_code?login.expired_auth_code:"");
    *used_code=code_login?code:"";
    if (code_login) {
        *path=type==1 ? "/mcloud/mag/pc/v9/callback/LoginPReg" : "/mcloud/mag/pc/v6/code/LoginPReg";
        ls_string(body,"code",code);
        if (type==1) ls_string(body,"authType",native_string(p,"auth_type","phone"));
    } else if (*token || type==1 || type==2) {
        /* An empty token after a consumed SSO/QR code is still sent to the
         * refresh endpoint as in 0x26c50/0x27880; never replay that used code. */
        *path="/mcloud/mag/pc/v9/refresh/LoginPReg";
        ls_string(body,"refresh_token",token);
    } else {
        *path="/mcloud/mag/pc/v11/LoginPReg";
        ok=login_encrypted_field(body,"loginName",login_string(p,"username")) &&
           login_encrypted_field(body,"authValue",login_string(p,"auth_value"));
        /* password was already RSA-encrypted by command 13 in the shipped JS. */
        ls_string(body,"password",login_string(p,"password"));
        ls_string(body,"authType",native_string(p,"auth_type","phone"));
    }
    ok=ok && login_encrypted_field(body,"tenantid",login_string(p,"tenantid"));
    ls_string(body,"publicKeyFlag","0");
    ls_string(body,"thirdAuthType",native_string(p,"third_auth_type","1"));
    /* No native WeDesk provisioning: retain the original unprovisioned form. */
    ls_string(body,"TID",""); ls_string(body,"TCC","0");
    if (!ok) { login_drop(&body); return NULL; }
    json_object_object_add(body,"deviceInfo",json_object_get(login.device));
    return body;
}
static int login_validate(struct json_object *p)
{
    int type=(int)native_integer(p,"login_type",0);
    if (type<0 || type>4) return LOGIN_PARAM;
    if ((type==0 || type==3) && (!*login_string(p,"username") ||
        !json_object_is_type(native_get(p,"password"),json_type_string))) return LOGIN_PARAM;
    if ((type==1 || type==2) && !*login_string(p,"middle_ground_auth_code")) return LOGIN_PARAM;
    if (type==4 && !*login_string(p,"refreshtoken")) return LOGIN_PARAM;
    if (!native_integer(p,"is_speed_login",0) && !*login_string(p,"local_ip")) return LOGIN_LOCAL_IP;
    if (!*login_string(p,"middle_ground_addr") || !native_integer(p,"middle_ground_port",443)) return LOGIN_PARAM;
    return 0;
}

static enum login_retry_policy login_recovery_policy(int error)
{
    /* RVA 0x1a480's terminal predicate with the exported path's force-retry
     * flag clear; 0x32a10 supplies linear errors, 0x32a60 network/upgrading.
     * GENERAL, CERT and REAUTH are terminal, not five-second retries. */
    switch (error) {
    case 10024: return LOGIN_RETRY_RATE;
    case LOGIN_TIMEOUT: case 10010: return LOGIN_RETRY_RANDOM;
    case 10007: case 10012: case 10015: case LOGIN_HTTP:
    case LOGIN_DECRYPT: case 10027: return LOGIN_RETRY_LINEAR;
    case LOGIN_NETWORK: return LOGIN_RETRY_SHORT;
    case LOGIN_GENERAL: case LOGIN_CERT: case LOGIN_REAUTH:
    default: return LOGIN_NO_RETRY;
    }
}

static unsigned login_reconnect_delay(enum login_retry_policy policy)
{
    /* Only failed reconnects enter the backoff in RVA 0x1b260. A failed,
     * recoverable renewal first starts one reconnect immediately. */
    switch (policy) {
    case LOGIN_RETRY_RATE: return 600;
    case LOGIN_RETRY_RANDOM: {
        unsigned random;
        return RAND_bytes((unsigned char *)&random,sizeof(random))==1
            ? 10+random%20 : 20;
    }
    case LOGIN_RETRY_LINEAR:
        return login.retry_seconds<3600?login.retry_seconds+10:login.retry_seconds;
    case LOGIN_RETRY_SHORT: return 5;
    default: return 0;
    }
}

static void login_end_session(void)
{
    login.intent=0; login.phase=0; login.status=0; login.reconnecting=0;
    login.timer_kind=LOGIN_AUTH_REQUEST;
    ls_schedule(&login_runtime,0);
    login_drop(&login.data);
    login_clean_free(login.cookies); login.cookies=NULL;
    login_clean_free(login.expired_auth_code); login.expired_auth_code=NULL;
}

static void login_server_error(const char *code,const char *message)
{
    if (!*code) return;
    struct json_object *p=json_object_new_object();
    ls_string(p,"middleGroundErrorCode",code); ls_string(p,"message",message);
    ls_notify(&login_runtime,4,"welink_login_on_server_error",p);
}
static void login_authenticate(struct json_object *request,enum login_request_kind kind)
{
    for (;;) {
        if (!login.auth || !login.intent || !login_generation_current()) return;
        int result=login_validate(login.auth);
        const char *path=NULL,*used_code="";
        struct json_object *body=NULL;
        if (!result && !login.device) {
            if (login_security_identity(&login.device,login.serial)) result=LOGIN_GENERAL;
        }
        if (!result) { body=login_request_body(&path,&used_code); if (!body) result=LOGIN_DECRYPT; }
        if (result) {
            login_end_session();
            login_failure(request,result,"","",""); login_status_event(); return;
        }
        struct login_response r=login_http(login.auth,path,json_object_to_json_string_ext(body,JSON_C_TO_STRING_PLAIN),0);
        /* deviceInfo is shared identity, not secret request-owned data. */
        json_object_object_del(body,"deviceInfo"); login_drop(&body);
        char number[32]; const char *message,*server_code;
        result=login_result(&r,0,&message,&server_code,number);
        if (!login_generation_current()) { login_response_free(&r); return; }
        if (!result) {
            int error=login_install_response(&r,used_code);
            if (error==ECANCELED) { login_response_free(&r); return; }
            if (error) result=LOGIN_GENERAL;
        }
        if (!result) {
            login.phase=2; login.status=2;
            login.reconnecting=kind!=LOGIN_AUTH_REQUEST; login.retry_seconds=0;
            login.timer_kind=LOGIN_REFRESH_REQUEST;
            if (request) ls_reply(&login_runtime,request,0,login_success_param());
            login_status_event();
            long seconds=(long)native_integer(login.data,"expires_in",7200)/2;
            if (seconds<30) seconds=30;
            if (seconds>INT_MAX) seconds=INT_MAX;
            ls_schedule(&login_runtime,(unsigned)seconds);
            login_response_free(&r);
            return;
        }
        if (kind!=LOGIN_AUTH_REQUEST) {
            /* ProcLoginResult reports a nonempty server error before applying
             * the FSM predicate. Recoverable errors do not call OnError. */
            login_server_error(server_code,message);
            enum login_retry_policy policy=login_recovery_policy(result);
            if (policy!=LOGIN_NO_RETRY) {
                ls_schedule(&login_runtime,0);
                login.phase=1;
                login.timer_kind=LOGIN_RECONNECT_REQUEST;
                /* 0x1ef90 suppresses the visible connecting transition for
                 * transient errors except server-upgrading (10010). phase
                 * still becomes CONNECTING: cmd7/11 cannot restart refresh. */
                if (result==10010) { login.status=1; login_status_event(); }
                if (kind==LOGIN_REFRESH_REQUEST) {
                    login_response_free(&r);
                    kind=LOGIN_RECONNECT_REQUEST;
                    request=NULL;
                    continue;
                }
                login.retry_seconds=login_reconnect_delay(policy);
                ls_schedule(&login_runtime,login.retry_seconds);
                login_response_free(&r);
                return;
            }
        }
        const char *set_password=login_string(r.json,"setPasswordToken");
        login_end_session();
        login_failure(request,result,message,server_code,set_password);
        if (kind==LOGIN_AUTH_REQUEST && result==LOGIN_GENERAL)
            login_server_error(server_code,message);
        login_status_event();
        login_response_free(&r);
        return;
    }
}

static void login_logout(struct json_object *request,int invalid)
{
    int result=0;
    const char *message="", *server_code="";
    char number[32];
    struct login_response response={0};
    login.intent=0; login.phase=0; login.timer_kind=LOGIN_AUTH_REQUEST;
    ls_schedule(&login_runtime,0);
    if (!invalid && login.auth && *login_string(login.data,"crypt_token")) {
        CURL *escape=curl_easy_init();
        char *refresh=escape?curl_easy_escape(escape,login_string(login.data,"refresh_token"),0):NULL;
        if (!refresh) result=LOGIN_GENERAL;
        else {
            const char *third=native_string(login.auth,"third_auth_type","1");
            const char *tenant=login_string(login.auth,"tenantid");
            size_t n=strlen(refresh)+strlen(third)+strlen(tenant)+64;
            char *body=malloc(n);
            if (!body) result=LOGIN_GENERAL;
            else {
                snprintf(body,n,"refresh_token=%s&thirdAuthType=%s&tenantid=%s&publicKeyFlag=df",refresh,third,tenant);
                response=login_http(login.auth,"/mcloud/mag/pc/v2/sso/logout",body,1);
                login_clean_free(body);
                result=login_result(&response,1,&message,&server_code,number);
            }
        }
        curl_free(refresh); curl_easy_cleanup(escape);
    }
    if (request) {
        if (result) login_failure(request,result,message,server_code,"");
        else ls_reply(&login_runtime,request,0,NULL);
    }
    login.status=0; login.reconnecting=0;
    login_drop(&login.auth); login_drop(&login.data);
    login_clean_free(login.cookies); login.cookies=NULL;
    login_clean_free(login.expired_auth_code); login.expired_auth_code=NULL;
    login_status_event();
    login_response_free(&response);
}
static void login_change_password(struct json_object *request)
{
    struct json_object *p=native_get(request,"param"), *body=json_object_new_object();
    ls_string(body,"loginName",login_string(p,"username"));
    ls_string(body,"password",login_string(p,"new_password"));
    ls_string(body,"publicKeyFlag","df");
    if (*login_string(p,"tenantid")) ls_string(body,"tenantid",login_string(p,"tenantid"));
    ls_string(body,"thirdAuthType",native_string(p,"third_auth_type","1"));
    struct login_response r=login_http(p,"/mcloud/mag/pc/v11/LoginPReg",
                                      json_object_to_json_string_ext(body,JSON_C_TO_STRING_PLAIN),2);
    login_drop(&body);
    const char *message,*server_code; char number[32];
    int result=login_result(&r,0,&message,&server_code,number);
    if (result) login_failure(request,result,message,server_code,login_string(r.json,"setPasswordToken"));
    else ls_reply(&login_runtime,request,0,NULL);
    login_response_free(&r);
}
static void login_refresh(int forced)
{
    /* FSM events 4/5 are accepted only in ONLINE state, not during reconnect. */
    if (login.phase!=2 || !login.intent || !login.auth || !login_generation_current()) return;
    if (!native_integer(login.auth,"is_speed_login",0) &&
        !*login_string(login.auth,"local_ip")) return;
    time_t now=time(NULL);
    if (!forced && login.last_refresh && now-login.last_refresh<20) return;
    login.last_refresh=now;
    ls_schedule(&login_runtime,0);
    login_authenticate(NULL,LOGIN_REFRESH_REQUEST);
}
static void login_reconnect(void)
{
    if (!login.intent || !login.auth || !login_generation_current()) return;
    if (!native_integer(login.auth,"is_speed_login",0) &&
        !*login_string(login.auth,"local_ip")) return;
    ls_schedule(&login_runtime,0);
    login.timer_kind=LOGIN_RECONNECT_REQUEST;
    if (login.phase!=1) {
        login.phase=1; login.status=1;
        login_status_event();
    }
    login_authenticate(NULL,LOGIN_RECONNECT_REQUEST);
}

static void login_tick(void)
{
    if (login.timer_kind==LOGIN_RECONNECT_REQUEST) login_reconnect();
    else if (login.timer_kind==LOGIN_REFRESH_REQUEST) login_refresh(1);
}

static void login_dispatch(struct json_object *request)
{
    int cmd=(int)(native_integer(request,"cmd",0)&0x2ffff);
    struct json_object *p=native_get(request,"param");
    switch (cmd) {
    case 1: {
        const char *key=login_string(p,"sso_pub_key");
        if (*key) { EVP_PKEY_free(login.key); login.key=login_read_key(key); login.key_configured=1; }
        ls_reply(&login_runtime,request,0,NULL);
        break;
    }
    case 2:
        ls_log_path(&login_runtime,login_string(p,"log_path"),2,512,2,"wk_login.log");
        ls_reply(&login_runtime,request,0,NULL); break;
    case 3:
        ls_reply(&login_runtime,request,0,NULL); login_reconnect(); break;
    case 4: {
        if (!login_generation_current()) break;
        struct json_object *auth=login_clone(p);
        if (!auth) { login_failure(request,LOGIN_GENERAL,"","",""); break; }
        login_drop(&login.auth); login.auth=auth;
        login_drop(&login.data); login_clean_free(login.cookies); login.cookies=NULL;
        login_clean_free(login.expired_auth_code); login.expired_auth_code=NULL;
        login.intent=1; login.phase=1; login.status=1; login.reconnecting=0;
        login.last_refresh=0; login.retry_seconds=0; login.timer_kind=LOGIN_AUTH_REQUEST;
        ls_schedule(&login_runtime,0);
        login_status_event(); login_authenticate(request,LOGIN_AUTH_REQUEST); break;
    }
    case 5: login_logout(request,json_object_get_boolean(native_get(p,"is_token_invalid"))); break;
    case 6: {
        static const char *keys[]={"local_ip","proxy_addr","proxy_port","proxy_account","proxy_pwd"};
        if (!login.auth) login.auth=json_object_new_object();
        for (size_t i=0;i<sizeof(keys)/sizeof(*keys);i++) {
            struct json_object *v=native_get(p,keys[i]), *copy=NULL;
            if (v && !json_object_deep_copy(v,&copy,NULL)) json_object_object_add(login.auth,keys[i],copy);
        }
        ls_reply(&login_runtime,request,0,NULL);
        if (login.intent && !*login_string(login.auth,"local_ip")) {
            login.phase=0; login.status=0; ls_schedule(&login_runtime,0); login_status_event();
        } else if (login.intent) login_reconnect();
        break;
    }
    case 7: ls_reply(&login_runtime,request,0,NULL); login_refresh(0); break;
    case 8: {
        int error=ls_http_set_rs(&login_transport,p);
        ls_reply(&login_runtime,request,error?LOGIN_GENERAL:0,NULL); break;
    }
    case 9: login_logout(NULL,1); ls_reply(&login_runtime,request,0,NULL); break;
    case 10: login_change_password(request); break;
    case 11: ls_reply(&login_runtime,request,0,NULL); login_refresh(1); break;
    case 12:
        if (!login.auth) login.auth=json_object_new_object();
        ls_string(login.auth,"middle_ground_lang",native_string(p,"language","en"));
        ls_reply(&login_runtime,request,0,NULL); break;
    case 13: {
        login_key();
        char *cipher=login_rsa_base64(login.key,login_string(p,"plain_text"));
        struct json_object *out=json_object_new_object();
        /* DLL returns result 0 even when PEM parsing/encryption yields empty. */
        ls_string(out,"encrypt_text",cipher);
        login_clean_free(cipher); ls_reply(&login_runtime,request,0,out); break;
    }
    default: break;
    }
}
static void login_clear(void)
{
    login_drop(&login.auth); login_drop(&login.data);
    ls_http_context_clear(&login_transport);
    json_object_put(login.device); login.device=NULL;
    EVP_PKEY_free(login.key); login_clean_free(login.cookies);
    login_clean_free(login.expired_auth_code);
    OPENSSL_cleanse(&login,sizeof(login));
}
LS_EXPORT void welink_login_init(ls_callback callback)
{
    ls_start(&login_runtime,callback,login_dispatch,login_tick,login_clear,
             (1u<<4)|(1u<<5)|(1u<<9),1u<<4);
}
LS_EXPORT void welink_login_send_msg(const char *text) { ls_send(&login_runtime,text); }
LS_EXPORT int welink_login_dispatch(void) { return ls_dispatch(&login_runtime); }
LS_EXPORT void welink_login_shutdown(void) { ls_stop(&login_runtime); }
LS_EXPORT void welink_login_set_log_path(const char *path,int level,int size,int count)
{ ls_log_path(&login_runtime,path,level,size,count,"wk_login.log"); }
