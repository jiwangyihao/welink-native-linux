/* Native implementation of the shipped wk_security command bus.
 * Evidence: 7.47.6.95 wk_security.dll, RVA 0x1a2c0/0x1a690/0x17810.
 * The vendor checks the embedded PKCS#7 signature, NOT the PE image digest or
 * certificate trust chain (PKCS7_NOVERIFY|PKCS7_NOCHAIN). This deliberately does
 * not advertise full Authenticode integrity verification. KIA is a different,
 * proprietary Windows DLL (kia_check_file.dll!IsKIAFile); missing/disabled KIA
 * uses the vendor's failure results 2/3, never a successful clean verdict.
 * Dependencies: json-c, OpenSSL libcrypto, pthread; compile as C11, -m32. */
#define _POSIX_C_SOURCE 200809L
#include "login_security_runtime.h"
#include "login_security_dispatch.h"
#include <fcntl.h>
#include <sys/mman.h>
#include <openssl/pkcs7.h>
#include <openssl/err.h>
#include <openssl/asn1.h>
#include <openssl/objects.h>

static struct ls_runtime security_runtime = LS_RUNTIME_INIT;
static int kia_enabled;
struct signature_result { int result, where, last_error; const char *message; };

static uint16_t security_u16(const unsigned char *p)
{ return (uint16_t)p[0] | (uint16_t)p[1] << 8; }
static uint32_t security_u32(const unsigned char *p)
{ return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24; }

static struct signature_result verify_signature(const char *path)
{
    struct signature_result r = {1,30,0,"verify file path empty"};
    if (!path || !*path) return r;
    int fd = open(path,O_RDONLY|O_CLOEXEC);
    if (fd < 0) {
        r.result = 3; r.last_error = errno; r.message = "CreateFile failed";
        return r;
    }
    struct stat st;
    if (fstat(fd,&st) || st.st_size <= 0 || !S_ISREG(st.st_mode) ||
        (uintmax_t)st.st_size > SIZE_MAX) {
        r.result = 3; r.last_error = errno ? errno : EINVAL;
        r.message = "CreateFileMapping failed";
        close(fd); return r;
    }
    size_t size = (size_t)st.st_size;
    const unsigned char *map = mmap(NULL,size,PROT_READ,MAP_PRIVATE,fd,0);
    close(fd);
    if (map == MAP_FAILED) {
        r.result = 3; r.last_error = errno; r.message = "MapViewOfFile operate failed";
        return r;
    }
    PKCS7 *p7 = NULL;
    BIO *input = NULL;
    r.where = 40; r.result = 4;
    r.message = "MapViewOfFile dosheader operate failed";
    if (size < 64 || security_u16(map) != 0x5a4d) goto done;
    size_t pe = security_u32(map+60);
    r.message = "MapViewOfFile ntheader operate failed";
    if (pe > size || size-pe < 24 || security_u32(map+pe) != 0x4550) goto done;
    size_t optional = pe+24, optional_size = security_u16(map+pe+20);
    if (optional_size > size-optional || optional_size < 2) goto done;
    uint16_t magic = security_u16(map+optional);
    size_t directory = magic == 0x10b ? 96 : magic == 0x20b ? 112 : 0;
    if (!directory || optional_size < directory+40) goto done;
    size_t cert = security_u32(map+optional+directory+32);
    size_t cert_size = security_u32(map+optional+directory+36);
    r.where = 70; r.result = 5;
    r.message = "signature dwSize too large or doesn't signed.";
    if (cert_size < 8 || cert_size-8 > 0x200000 || cert > size ||
        cert_size > size-cert || security_u16(map+cert+6) != 2) goto done;
    size_t record_size = security_u32(map+cert);
    if (record_size < 8 || record_size > cert_size) goto done;
    const unsigned char *der = map+cert+8;
    ERR_clear_error();
    p7 = d2i_PKCS7(NULL,&der,(long)(record_size-8));
    r.where = 90; r.result = 6;
    r.message = "get pkcs7 from Signature failed.";
    if (!p7 || !PKCS7_type_is_signed(p7) || !p7->d.sign ||
        !p7->d.sign->contents || !p7->d.sign->contents->type) goto done;
    PKCS7 *contents = p7->d.sign->contents;
    /* d is a tagged union. Only the unknown SPC IndirectDataContent OID
     * decodes through d.other; PKCS7 data uses d.data instead. */
    char content_oid[48];
    int oid_length = OBJ_obj2txt(content_oid,sizeof(content_oid),contents->type,1);
    if (oid_length != (int)sizeof("1.3.6.1.4.1.311.2.1.4")-1 ||
        strcmp(content_oid,"1.3.6.1.4.1.311.2.1.4") ||
        !contents->d.other || contents->d.other->type != V_ASN1_SEQUENCE) goto done;
    ASN1_STRING *sequence = contents->d.other->value.sequence;
    if (!sequence) goto done;
    const unsigned char *content = ASN1_STRING_get0_data(sequence);
    if (!content) goto done;
    int n = ASN1_STRING_length(sequence), tag, cls;
    long content_length = 0;
    if (n <= 0) goto done;
    int flags = ASN1_get_object(&content,&content_length,&tag,&cls,n);
    if ((flags & 0x80) || tag != V_ASN1_SEQUENCE || cls != V_ASN1_UNIVERSAL ||
        content_length < 0 || content_length > INT_MAX) goto done;
    input = BIO_new_mem_buf(content,(int)content_length);
    r.result = 7; r.message = "get bio from pkcs7 struct failed.";
    if (!input) goto done;
    r.result = 8; r.message = "PKCS7 signature verification failed";
    if (PKCS7_verify(p7,NULL,NULL,input,NULL,PKCS7_NOVERIFY|PKCS7_NOCHAIN) == 1) {
        r.result = 0; r.where = 100; r.message = "success.";
    }
done:
    BIO_free(input);
    PKCS7_free(p7);
    ERR_clear_error();
    munmap((void *)map,size);
    return r;
}

static void verify_one(struct json_object *request)
{
    struct signature_result r = verify_signature(native_string(native_get(request,"param"),"filePath",""));
    struct json_object *p = json_object_new_object();
    ls_int(p,"inWhere",r.where);
    ls_int(p,"lastErrorCode",r.last_error);
    ls_string(p,"message",r.message);
    ls_reply(&security_runtime,request,r.result,p);
}

static void verify_application(struct json_object *request)
{
    /* The shipped DLL's compiled manifest has exactly one entry, not a
     * recursive scan: FUN_10017810. Keep its observable inventory. */
    const char *root = native_string(native_get(request,"param"),"appRootDir","");
    const char *file = "api-ms-win-core-console-l1-1-0.dll";
    size_t n = strlen(root)+strlen(file)+2;
    char *path = malloc(n);
    if (!path) { ls_reply(&security_runtime,request,-ENOMEM,NULL); return; }
    snprintf(path,n,"%s%s%s",root,*root && root[strlen(root)-1]!='/'?"/":"",file);
    struct timespec start,end;
    clock_gettime(CLOCK_MONOTONIC,&start);
    struct signature_result r = verify_signature(path);
    clock_gettime(CLOCK_MONOTONIC,&end);
    struct json_object *p = json_object_new_object(), *errors = json_object_new_array();
    char date[32]; time_t now = time(NULL); struct tm tm;
    localtime_r(&now,&tm); strftime(date,sizeof(date),"%Y-%m-%d %H:%M:%S",&tm);
    json_object_object_add(p,"result",json_object_new_boolean(!r.result));
    ls_string(p,"operation_time",date);
    ls_int(p,"verified_files_count",1);
    ls_int(p,"exception_files_count",r.result != 0);
    ls_int(p,"time_taken",(end.tv_sec-start.tv_sec)*1000+(end.tv_nsec-start.tv_nsec)/1000000);
    if (r.result) {
        size_t len = n + strlen(r.message) + 64;
        char *error = malloc(len);
        if (error) {
            snprintf(error,len,"Error_code: %d Path: %s Message: %s",r.result,path,r.message);
            json_object_array_add(errors,json_object_new_string(error)); free(error);
        }
    }
    json_object_object_add(p,"error_list",errors);
    free(path);
    ls_reply(&security_runtime,request,0,p);
}

static void security_dispatch(struct json_object *request)
{
    int cmd = (int)(native_integer(request,"cmd",0) & 0x2ffff);
    struct json_object *p = native_get(request,"param");
    switch (cmd) {
    case 1: verify_one(request); break;
    case 2: verify_application(request); break;
    case 3:
        if (!json_object_is_type(native_get(p,"isKIAFileDetection"),json_type_boolean) ||
            !json_object_is_type(native_get(p,"kiaDllDir"),json_type_string)) {
            ls_reply(&security_runtime,request,-1,NULL); break;
        }
        kia_enabled = json_object_get_boolean(native_get(p,"isKIAFileDetection"));
        ls_reply(&security_runtime,request,kia_enabled ? 2 : 3,NULL);
        break;
    case 4:
        ls_reply(&security_runtime,request,!kia_enabled ? 3 :
                 json_object_is_type(native_get(p,"filePath"),json_type_string) ? 2 : -1,NULL);
        break;
    case 5: {
        struct json_object *files = native_get(p,"filePathList");
        int valid = json_object_is_type(files,json_type_array) &&
            json_object_array_length(files)>0 && json_object_array_length(files)<=100;
        ls_reply(&security_runtime,request,!kia_enabled ? 3 : valid ? 2 : -1,NULL);
        break;
    }
    default: break; /* Original ignores unknown commands; no invented success. */
    }
}

static void security_clear(void) { kia_enabled = 0; }
LS_EXPORT void welink_security_init(ls_callback callback)
{ ls_start(&security_runtime,callback,security_dispatch,NULL,security_clear,0,0); }
LS_EXPORT void welink_security_send_msg(const char *text) { ls_send(&security_runtime,text); }
LS_EXPORT int welink_security_dispatch(void) { return ls_dispatch(&security_runtime); }
LS_EXPORT void welink_security_shutdown(void) { ls_stop(&security_runtime); }
LS_EXPORT void welink_security_set_log_path(const char *path,int level,int size,int count)
{ ls_log_path(&security_runtime,path,level,size,count,"wk_security.log"); }
