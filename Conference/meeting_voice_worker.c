/* Linux fixed-profile PNR. Stdio only: no microphone, network or persistent
 * audio. Enrollment calibrates the campus models on selected speech; calls
 * freeze the enrolled statistics rather than emulate the desktop live learner. */
#define _POSIX_C_SOURCE 200809L
#include "meeting_voice_engine.h"
#include "meeting_voice_gate.h"
#include "meeting_voice_cluster_backbone.h"
#include "meeting_voice_cluster_fields.h"
#include "meeting_voice_frontend.h"
#include <math.h>
#include <stddef.h>
#define OPENSSL_API_COMPAT 0x10100000L
#include <openssl/sha.h>
#include <errno.h>
#include <fenv.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <unistd.h>

#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "Worker wire format is little-endian IEEE binary32"
#endif
_Static_assert(sizeof(float)==4, "worker PCM and record representation");

enum { EXIT_INPUT=65, EXIT_UNAVAILABLE=69, EXIT_MEMORY=71, EXIT_IO=74, EXIT_MODEL=78 };
struct model_spec { const char *name; size_t bytes; unsigned char sha256[32]; };
static const struct model_spec filter_model={
    "pnrModel.bin",PNR_TEMPORAL_MODEL_SIZE,
    {0xb0,0x71,0x42,0x70,0x06,0x11,0x1b,0x72,0xb1,0xd6,0x91,0x37,0x6c,0x86,0xb9,0xe8,
     0xc7,0x0c,0x8e,0xb6,0x47,0xeb,0xd1,0x5a,0x24,0x9d,0xb7,0x39,0x06,0xc3,0x55,0x5c}
};
static const struct model_spec cluster_model={
    "pnrClusterModel.bin",WELINK_PNR_CLUSTER_V2_MODEL_BYTES,
    {0x41,0xb5,0x3d,0xec,0x92,0x71,0xa9,0x46,0x40,0x31,0x31,0x57,0xdb,0x73,0xbc,0xab,
     0x65,0xe4,0x9b,0xb0,0x7d,0xd8,0xe1,0xbd,0x9e,0x85,0x53,0x5c,0xed,0xcb,0x50,0x0a}
};
static const struct model_spec vad_model={
    "vadModel.bin",WELINK_VOICE_VAD_MODEL_BYTES,
    {0x01,0xb8,0x77,0xdb,0x2f,0x09,0x66,0xe1,0x9b,0x92,0x5e,0xe6,0x67,0x04,0x4b,0x95,
     0x66,0xcf,0x21,0xc6,0xe1,0xf2,0x4d,0x49,0xca,0xdd,0x23,0x8e,0xcc,0x7d,0x1b,0x2d}
};
static void erase(void *memory, size_t bytes) {
    volatile unsigned char *p=memory;
    while(bytes--) *p++=0;
}
static int error(int exit_code, const char *code) {
    /* Codes are fixed internal literals, never caller data, paths or PCM. */
    fprintf(stderr,"{\"ok\":false,\"code\":\"%s\"}\n",code);
    return exit_code;
}
/* Optional destination: a capability probe hashes the same file without
 * allocating a model or starting capture. With a destination, authenticate
 * exactly the private bytes later passed to the numerical engine. */
static int model_load(int directory, const struct model_spec *spec, unsigned char **result) {
    if(result) *result=NULL;
    int fd=openat(directory,spec->name,O_RDONLY|O_CLOEXEC|O_NOFOLLOW|O_NONBLOCK);
    if(fd<0) return EXIT_MODEL;
    struct stat st;
    if(fstat(fd,&st) || !S_ISREG(st.st_mode) || st.st_size!=(off_t)spec->bytes) {
        close(fd); return EXIT_MODEL;
    }
    unsigned char *data=result ? malloc(spec->bytes) : NULL;
    if(result && !data) { close(fd); return EXIT_MEMORY; }
    SHA256_CTX hash;
    unsigned char scratch[16384], digest[32], extra;
    size_t have=0;
    int status=EXIT_MODEL;
    if(SHA256_Init(&hash)!=1) goto done;
    while(have<spec->bytes) {
        size_t chunk=spec->bytes-have;
        if(!data && chunk>sizeof scratch) chunk=sizeof scratch;
        unsigned char *dst=data ? data+have : scratch;
        ssize_t n=read(fd,dst,chunk);
        if(n<0 && errno==EINTR) continue;
        if(n<=0 || SHA256_Update(&hash,dst,(size_t)n)!=1) goto done;
        have+=(size_t)n;
    }
    ssize_t n;
    do n=read(fd,&extra,1); while(n<0 && errno==EINTR);
    if(n!=0 || SHA256_Final(digest,&hash)!=1 || memcmp(digest,spec->sha256,sizeof digest)) goto done;
    if(result) { *result=data; data=NULL; }
    status=0;
done:
    erase(&hash,sizeof hash); free(data); close(fd);
    return status;
}
static int report_model_error(int status) {
    return error(status,status==EXIT_MEMORY ? "PNR_MEMORY_EXHAUSTED" : "PNR_MODEL_AUTHENTICATION_FAILED");
}
static int report_rejection(int result) {
    const char *code="PNR_INVALID_PCM";
    if(result==WELINK_VOICE_TOO_SHORT) code="PNR_TOO_SHORT";
    else if(result==WELINK_VOICE_TOO_QUIET) code="PNR_TOO_QUIET";
    else if(result==WELINK_VOICE_CONSTANT_PCM) code="PNR_CONSTANT_PCM";
    else if(result==WELINK_VOICE_BAD_SPECTRAL_QUALITY) code="PNR_BAD_SPECTRAL_QUALITY";
    else if(result==WELINK_VOICE_BAD_REDUCTION) code="PNR_NOISY_RECORDING";
    return error(EXIT_INPUT,code);
}

struct profile {
    float head[128];
    struct welink_voice_lane lanes[WELINK_VOICE_RECORD_SLOTS];
    float direction[256];
};
_Static_assert(offsetof(struct profile,lanes)==0x200 && offsetof(struct profile,direction)==0x550 &&
               sizeof(struct profile)==WELINK_PNR_RECORD_BYTES,"voice profile wire layout");

/* Compact only selected frames in place. Evaluate each model-masked speech
 * spectrum against its own captured spectrum (the quality reducer lags one
 * frame). This Linux front end is not the Windows adaptive preprocessing chain. */
static int select_speech(float *pcm, size_t *count, const unsigned char *model) {
    struct welink_voice_vad vad;
    if(welink_voice_vad_init(&vad,model,vad_model.bytes)) return EXIT_MODEL;
    const struct welink_voice_vad_route readonly={0};
    struct welink_voice_quality quality={0};
    float history[480]={0}, bins[514], masked[514], gains[257];
    size_t used=0;
    int previous=0, status=0;
    for(size_t i=0;i+160<=*count;i+=160) {
        welink_voice_capture_spectrum(history,pcm+i,bins);
        int voiced=welink_voice_vad_spectrum(&vad,bins,&readonly,gains);
        if(voiced<0 || welink_voice_quality_push(&quality,bins,masked,previous)) { status=EXIT_INPUT; break; }
        if(voiced) {
            for(unsigned k=0;k<257;++k) { masked[2*k]=gains[k]*bins[2*k]; masked[2*k+1]=gains[k]*bins[2*k+1]; }
            if(used!=i) memcpy(pcm+used,pcm+i,160*sizeof *pcm);
            used+=160;
        }
        previous=voiced;
    }
    if(!status && previous && welink_voice_quality_push(&quality,bins,masked,1)) status=EXIT_INPUT;
    if(status) status=report_rejection(WELINK_VOICE_INVALID_PCM);
    else {
        int rejection=used<WELINK_VOICE_MIN_QUALIFIED ? WELINK_VOICE_TOO_SHORT : welink_voice_quality_result(&quality);
        if(rejection) status=report_rejection(rejection);
    }
    *count=used;
    erase(&vad,sizeof vad); erase(&quality,sizeof quality); erase(history,sizeof history);
    erase(masked,sizeof masked); erase(bins,sizeof bins); erase(gains,sizeof gains);
    return status;
}

static int make_profile(int directory, float *pcm, size_t count, struct profile *profile) {
    unsigned char *model;
    int status=model_load(directory,&vad_model,&model);
    if(status) return report_model_error(status);
    status=select_speech(pcm,&count,model); free(model);
    if(status) return status;
    status=model_load(directory,&cluster_model,&model);
    if(status) return report_model_error(status);
    size_t nf=welink_voice_cluster_fields_work_floats();
    float *work=malloc(nf*sizeof *work), rms;
    if(!work) { free(model); return error(EXIT_MEMORY,"PNR_MEMORY_EXHAUSTED"); }
    int blocks=welink_voice_qualified_fields(model,cluster_model.bytes,pcm,count,work,nf,
                                           profile->head,profile->direction,&rms);
    erase(work,nf*sizeof *work); free(work); free(model);
    if(blocks<1) return report_rejection(blocks);
    status=model_load(directory,&filter_model,&model);
    if(status) return report_model_error(status);
    struct welink_voice_engine *engine=malloc(sizeof *engine);
    if(!engine) { free(model); return error(EXIT_MEMORY,"PNR_MEMORY_EXHAUSTED"); }
    int failed=welink_voice_engine_init(engine,model,filter_model.bytes) ||
               welink_voice_engine_fields(engine,profile->head,profile->direction);
    /* Only the already-qualified enrollment speech trains both statistic lanes. */
    const struct welink_voice_control learn_both={.activity=5.0f};
    float discard[160];
    for(size_t i=0;!failed && i<count;i+=160) {
        for(unsigned j=0;j<160;++j) pcm[i+j]*=32768.0f;
        failed=welink_voice_engine_frame(engine,pcm+i,&learn_both,discard)!=160;
    }
    failed=failed || welink_voice_engine_snapshot(engine,profile->lanes) ||
           welink_voice_record_validate(profile,sizeof *profile);
    erase(discard,sizeof discard); erase(engine,sizeof *engine); free(engine); free(model);
    return failed ? error(EXIT_INPUT,"PNR_CALIBRATION_FAILED") : 0;
}
static int enroll(int directory) {
    const size_t capacity=(size_t)WELINK_VOICE_MAX_SAMPLES*sizeof(float);
    float *pcm=malloc(capacity);
    if(!pcm) return error(EXIT_MEMORY,"PNR_MEMORY_EXHAUSTED");
    const size_t bytes=fread(pcm,1,capacity,stdin);
    int status=0;
    if(ferror(stdin)) status=error(EXIT_IO,"PNR_INPUT_IO_FAILED");
    else if(bytes==capacity) {
        const int extra=fgetc(stdin);
        if(extra!=EOF) status=error(EXIT_INPUT,"PNR_INPUT_TOO_LONG");
        else if(ferror(stdin)) status=error(EXIT_IO,"PNR_INPUT_IO_FAILED");
    }
    if(!status && bytes%sizeof(float)) status=error(EXIT_INPUT,"PNR_TRUNCATED_PCM");
    if(!status && bytes==0) status=error(EXIT_INPUT,"PNR_TOO_SHORT");
    if(!status) {
        int reject=welink_voice_input_rejection(pcm,bytes/sizeof(float));
        if(reject) status=report_rejection(reject);
    }
    struct profile record;
    if(!status) status=make_profile(directory,pcm,bytes/sizeof(float),&record);
    erase(pcm,bytes); free(pcm);
    if(!status && (fwrite(&record,1,sizeof record,stdout)!=sizeof record || fflush(stdout)))
        status=error(EXIT_IO,"PNR_OUTPUT_IO_FAILED");
    erase(&record,sizeof record);
    return status;
}
static int filter(int directory) {
    _Alignas(float) unsigned char record[WELINK_PNR_RECORD_BYTES];
    size_t bytes=fread(record,1,sizeof record,stdin);
    if(bytes!=sizeof record) {
        const int io=ferror(stdin);
        erase(record,sizeof record);
        return error(io ? EXIT_IO : EXIT_INPUT,io ? "PNR_INPUT_IO_FAILED" : "PNR_TRUNCATED_RECORD");
    }
    if(welink_voice_record_validate(record,sizeof record)) {
        erase(record,sizeof record); return error(EXIT_INPUT,"PNR_INVALID_RECORD");
    }
    unsigned char *model=NULL;
    int status=model_load(directory,&filter_model,&model);
    if(status) { erase(record,sizeof record); return report_model_error(status); }
    struct welink_voice_engine *engine=malloc(sizeof *engine);
    if(!engine) {
        erase(record,sizeof record); free(model);
        return error(EXIT_MEMORY,"PNR_MEMORY_EXHAUSTED");
    }
    if(welink_voice_engine_init(engine,model,filter_model.bytes) ||
       welink_voice_engine_restore(engine,record,sizeof record)) status=error(EXIT_INPUT,"PNR_RECORD_BIND_FAILED");
    erase(record,sizeof record);
    if(!status && (fwrite("RDY1",1,4,stdout)!=4 || fflush(stdout))) status=error(EXIT_IO,"PNR_OUTPUT_IO_FAILED");
    const struct welink_voice_control inference={.frozen=1};
    float packet[640], out[160];
    while(!status) {
        size_t n=fread(packet,1,sizeof packet,stdin);
        if(ferror(stdin)) { status=error(EXIT_IO,"PNR_INPUT_IO_FAILED"); break; }
        if(!n) break;
        if(n!=sizeof packet) { status=error(EXIT_INPUT,"PNR_TRUNCATED_PCM"); break; }
        for(unsigned i=0;i<640;++i) {
            if(!isfinite(packet[i]) || fabsf(packet[i])>1.0f) { status=error(EXIT_INPUT,"PNR_INVALID_PCM"); break; }
            packet[i]*=32768.0f;
        }
        for(unsigned i=0;!status && i<640;i+=160) {
            if(welink_voice_engine_frame(engine,packet+i,&inference,out)!=160) { status=error(EXIT_INPUT,"PNR_FILTER_FAILED"); break; }
            for(unsigned j=0;j<160;++j) {
                if(!isfinite(out[j])) { status=error(EXIT_INPUT,"PNR_FILTER_FAILED"); break; }
                packet[i+j]=fminf(1.0f,fmaxf(-1.0f,out[j]*0x1p-15f));
            }
        }
        if(!status && (fwrite(packet,1,sizeof packet,stdout)!=sizeof packet || fflush(stdout)))
            status=error(EXIT_IO,"PNR_OUTPUT_IO_FAILED");
    }
    erase(packet,sizeof packet); erase(out,sizeof out); erase(engine,sizeof *engine); free(engine); free(model);
    return status;
}
int main(int argc, char **argv) {
    if(argc!=3 || (strcmp(argv[1],"capabilities") && strcmp(argv[1],"enroll") && strcmp(argv[1],"filter")) || argv[2][0]!='/')
        return error(64,"PNR_USAGE");
    /* Prevent a core file from persisting stdin audio, model state or a record. */
    const struct rlimit no_core={0,0};
    if(setrlimit(RLIMIT_CORE,&no_core) || prctl(PR_SET_DUMPABLE,0,0,0,0) ||
       signal(SIGPIPE,SIG_IGN)==SIG_ERR || fesetenv(FE_DFL_ENV))
        return error(EXIT_UNAVAILABLE,"PNR_PROCESS_INITIALIZATION_FAILED");
    int directory=open(argv[2],O_RDONLY|O_DIRECTORY|O_CLOEXEC|O_NOFOLLOW);
    if(directory<0) return report_model_error(EXIT_MODEL);
    int status;
    if(!strcmp(argv[1],"capabilities")) {
        int can_filter=!model_load(directory,&filter_model,NULL);
        int can_enroll=can_filter && !model_load(directory,&cluster_model,NULL) && !model_load(directory,&vad_model,NULL);
        status=printf("{\"version\":1,\"enroll\":%s,\"filter\":%s}\n",can_enroll?"true":"false",can_filter?"true":"false")<0 || fflush(stdout) ? EXIT_IO : 0;
    } else status=!strcmp(argv[1],"enroll") ? enroll(directory) : filter(directory);
    close(directory);
    return status;
}
