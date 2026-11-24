#include "meeting_voice_engine.h"
#include <float.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "PNR records and model coefficients require little-endian binary32"
#endif
_Static_assert(sizeof(float)==4 && FLT_RADIX==2 && FLT_MANT_DIG==24 && FLT_EVAL_METHOD==0,
               "use binary32 SSE2 without FP contraction or fast math");
_Static_assert(128*4 + 53*16 + 256*4 == WELINK_PNR_RECORD_BYTES, "PNR record layout");

static int finite_vector(const float *v, size_t n) {
    for(size_t i=0;i<n;++i) if(!isfinite(v[i])) return 0;
    return 1;
}
static int valid_lane(const struct welink_voice_lane *p, int learned) {
    return isfinite(p->mean) && fabsf(p->mean)<=0x1p60f &&
        isfinite(p->variance) && p->variance+1.0e-6f>0.0f && p->variance<=0x1p120f &&
        isfinite(p->weight) && p->weight>=(learned ? 1.0f : 0.0f) &&
        p->weight<=6001.0f && truncf(p->weight)==p->weight &&
        isfinite(p->idle) && p->idle>=0.0f && truncf(p->idle)==p->idle;
}
static struct welink_voice_adaptive *lane_at(struct welink_voice_engine *s, unsigned i) {
    if(!i) return &s->projection.stats;
    --i;
    if(i<6) return &s->downsample.levels[i/2].bank.norm[i%2];
    i-=6;
    if(i<6) return &s->upsample.levels[i/2].bank.norm[i%2];
    i-=6;
    return &s->bottleneck.banks[i/2].norm[i%2];
}
static const struct welink_voice_adaptive *const_lane_at(const struct welink_voice_engine *s, unsigned i) {
    if(!i) return &s->projection.stats;
    --i;
    if(i<6) return &s->downsample.levels[i/2].bank.norm[i%2];
    i-=6;
    if(i<6) return &s->upsample.levels[i/2].bank.norm[i%2];
    i-=6;
    return &s->bottleneck.banks[i/2].norm[i%2];
}
static int statistics_valid(const struct welink_voice_engine *s) {
    for(unsigned i=0;i<WELINK_VOICE_RECORD_SLOTS;++i) {
        const struct welink_voice_adaptive *a=const_lane_at(s,i);
        if(!valid_lane(&a->primary,0) || !valid_lane(&a->secondary,0)) return 0;
    }
    return 1;
}
static int fatal(struct welink_voice_engine *s, float *out) {
    if(s) { s->failed=1; s->fields_bound=0; }
    if(out) memset(out,0,WELINK_VOICE_FRAME*sizeof *out);
    return -1;
}
int welink_voice_engine_init(struct welink_voice_engine *s, const void *model, size_t bytes) {
    if(!s) return -1;
    s->initialized=0; s->fields_bound=0; s->started=0; s->failed=1; s->model=NULL;
    if(welink_voice_projection_init(&s->projection,model,bytes) ||
       welink_voice_downsample_init(&s->downsample,model,bytes) ||
       welink_voice_bottleneck_init(&s->bottleneck,model,bytes) ||
       welink_voice_upsample_init(&s->upsample,model,bytes) ||
       welink_voice_synthesis_init(&s->synthesis,model,bytes)) return -1;
    memset(s->head,0,sizeof s->head); memset(s->direction,0,sizeof s->direction);
    s->model=model; s->initialized=1; s->failed=0;
    return 0;
}
int welink_voice_engine_fields(struct welink_voice_engine *s, const float head[128],
                               const float direction[256]) {
    if(!s || !s->initialized || s->failed || s->started || !head || !direction ||
       !finite_vector(head,128) || !finite_vector(direction,256)) return -1;
    memcpy(s->head,head,sizeof s->head); memcpy(s->direction,direction,sizeof s->direction);
    s->fields_bound=1;
    return 0;
}
int welink_voice_record_validate(const void *record, size_t bytes) {
    if(!record || bytes!=WELINK_PNR_RECORD_BYTES) return -1;
    const unsigned char *p=record;
    double head_power=0, direction_power=0;
    for(unsigned i=0;i<128;++i) {
        float x; memcpy(&x,p+4*i,4);
        if(!isfinite(x)) return -1;
        head_power+=(double)x*x;
    }
    for(unsigned i=0;i<WELINK_VOICE_RECORD_SLOTS;++i) {
        struct welink_voice_lane lane;
        memcpy(&lane,p+0x200+i*sizeof lane,sizeof lane);
        if(!valid_lane(&lane,1)) return -1;
    }
    for(unsigned i=0;i<256;++i) {
        float x; memcpy(&x,p+0x550+4*i,4);
        if(!isfinite(x)) return -1;
        direction_power+=(double)x*x;
    }
    /* The tail is a sum of at most ten unit vectors, not their average.
     * Allow binary32 accumulation error, but never an empty/default record. */
    return head_power>0 && direction_power>0 && direction_power<=100.001 ? 0 : -1;
}
int welink_voice_engine_restore(struct welink_voice_engine *s, const void *record, size_t bytes) {
    if(!s || !s->initialized || !s->model || welink_voice_record_validate(record,bytes))
        return fatal(s,NULL);
    const void *model=s->model;
    if(welink_voice_engine_init(s,model,PNR_TEMPORAL_MODEL_SIZE)) return -1;
    const unsigned char *p=record;
    memcpy(s->head,p,sizeof s->head); memcpy(s->direction,p+0x550,sizeof s->direction);
    for(unsigned i=0;i<WELINK_VOICE_RECORD_SLOTS;++i) {
        struct welink_voice_adaptive *a=lane_at(s,i);
        memcpy(&a->primary,p+0x200+i*sizeof a->primary,sizeof a->primary);
        a->secondary=a->primary;
    }
    s->fields_bound=1;
    return 0;
}
int welink_voice_engine_hop(struct welink_voice_engine *s, const float input[20],
                            const struct welink_voice_control *control, float output[160]) {
    if(!s || !s->initialized || !s->fields_bound || s->failed || !input || !output ||
       !control || !isfinite(control->activity) ||
       (control->frozen!=0 && control->frozen!=1) || !finite_vector(input,20)) return fatal(s,output);
    s->started=1;
    float normalized[512], pooled[128], latent[128], decoded[8][128];
    float *signed_projection=s->synthesis.signed_history[s->synthesis.next];
    const float activity=control->activity;
    const int learn=control->learn_after_idle, frozen=control->frozen;
    welink_voice_projection_push(&s->projection,input,signed_projection,normalized,activity,learn,frozen);
    if(!finite_vector(signed_projection,512) || !finite_vector(normalized,512)) return fatal(s,output);
    unsigned n=0;
    if(welink_voice_downsample_push(&s->downsample,normalized,pooled,activity,learn,frozen)) {
        if(!finite_vector(pooled,128)) return fatal(s,output);
        welink_voice_bottleneck_push(&s->bottleneck,pooled,s->head,latent,activity,learn,frozen);
        if(!finite_vector(latent,128)) return fatal(s,output);
        n=welink_voice_upsample_push(&s->upsample,&s->downsample,latent,decoded,activity,learn,frozen);
        if((n!=1 && n!=8) || !finite_vector(&decoded[0][0],n*128)) return fatal(s,output);
    }
    if(!statistics_valid(s)) return fatal(s,output);
    const unsigned produced=welink_voice_synthesis_push(&s->synthesis,(const float (*)[128])decoded,n,output);
    if(!finite_vector(s->synthesis.tail,20) || (produced && !finite_vector(output,produced)))
        return fatal(s,output);
    return (int)produced;
}
int welink_voice_engine_frame(struct welink_voice_engine *s, const float input[160],
                              const struct welink_voice_control *control, float output[160]) {
    if(!input || !output) return fatal(s,output);
    unsigned emitted=0;
    for(unsigned i=0;i<8;++i) {
        const int n=welink_voice_engine_hop(s,input+20*i,control,output);
        if(n<0 || (n && emitted)) return fatal(s,output);
        if(n) emitted=1;
    }
    if(!emitted) memset(output,0,WELINK_VOICE_FRAME*sizeof *output);
    return WELINK_VOICE_FRAME;
}
int welink_voice_engine_snapshot(const struct welink_voice_engine *s,
                                 struct welink_voice_lane lanes[53]) {
    if(!s || !s->initialized || s->failed || !lanes || !statistics_valid(s)) return -1;
    for(unsigned i=0;i<WELINK_VOICE_RECORD_SLOTS;++i) lanes[i]=const_lane_at(s,i)->primary;
    return 0;
}
