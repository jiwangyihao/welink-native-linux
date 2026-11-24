#include "meeting_voice_gate.h"
#include "meeting_voice_cluster_fields.h"
#include "meeting_voice_cluster_backbone.h"
#include "meeting_voice_math.h"
#include <math.h>
#include <stdint.h>
#include <string.h>

#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "Pinned voice models require little-endian binary32"
#endif

static int finite_samples(const float *p, size_t n) {
    for(size_t i=0;i<n;++i) if(!isfinite(p[i])) return 0;
    return 1;
}
static float squares(const float *p, size_t n) {
    float sum=0.0f;
    for(size_t i=0;i<n;++i) sum+=p[i]*p[i];
    return sum;
}
static float pcm_db(float power) {
    return power>0.0f ? (float)(20.0*log10((double)vqe_root(power))) : -INFINITY;
}
static int pcm_bounds(const float *p, size_t n, float *power, int *constant) {
    if(!p || !n || n>WELINK_VOICE_MAX_SAMPLES) return WELINK_VOICE_INVALID_PCM;
    float sum=0.0f; int same=1;
    for(size_t i=0;i<n;++i) {
        const float x=p[i];
        if(!isfinite(x) || x < -1.0f || x > 1.0f) return WELINK_VOICE_INVALID_PCM;
        same &= x==p[0];
        sum+=x*x;
    }
    *power=sum; *constant=same;
    return 0;
}
int welink_voice_input_rejection(const float *pcm, size_t samples) {
    float power; int constant;
    int result=pcm_bounds(pcm,samples,&power,&constant);
    if(result) return result;
    if(samples<WELINK_VOICE_MIN_QUALIFIED) return WELINK_VOICE_TOO_SHORT;
    /* Even assigning ALL input energy to the minimum qualified duration cannot
     * pass -53 dB. This is a necessary rejection only, never a VAD substitute. */
    if(pcm_db(power/(float)WELINK_VOICE_MIN_QUALIFIED)<-53.0f) return WELINK_VOICE_TOO_QUIET;
    return constant ? WELINK_VOICE_CONSTANT_PCM : 0;
}
static float gate_exp(float x);
/* 102033a0 specialized to its actual enrollment base, 10.0f. The original
 * uses this polynomial, so substituting powf subtly changes the levelled PCM. */
static float gate_pow10(float exponent) {
    const float x=1.25f, square=x*x;
    float a=x*as_float(UINT32_C(0x3c677861))-as_float(UINT32_C(0x3e29383a));
    const float b=x*as_float(UINT32_C(0x3f5810d8))-as_float(UINT32_C(0x401e2024));
    a=a*square+b;
    a*=square*square;
    float c=x*as_float(UINT32_C(0x4092b3e3))-as_float(UINT32_C(0x40b5fb4c));
    const float d=x*as_float(UINT32_C(0x40a5a113))-as_float(UINT32_C(0x4012eb5b));
    c=c*square+d;
    const float logarithm=(a+c)+3.0f*as_float(UINT32_C(0x3f317218));
    return gate_exp(logarithm*exponent);
}
int welink_voice_qualified_level(float *qualified, size_t samples, float *original_rms) {
    if(!original_rms || samples%160) return WELINK_VOICE_INVALID_PCM;
    float power; int constant;
    int result=pcm_bounds(qualified,samples,&power,&constant);
    if(result) return result;
    if(samples<WELINK_VOICE_MIN_QUALIFIED) return WELINK_VOICE_TOO_SHORT;
    const float rms=vqe_root(power/(float)samples);
    const float level=power>0.0f ? (float)(20.0*log10((double)rms)) : -INFINITY;
    if(level < -53.0f) return WELINK_VOICE_TOO_QUIET;
    if(constant) return WELINK_VOICE_CONSTANT_PCM;
    if(level < -39.0f) {
        /* 101d3dae rounds the exponent to binary32 before the VQE pow call. */
        const float exponent=(float)((double)(-39.0f-level)/20.0);
        const float gain=gate_pow10(exponent);
        if(!isfinite(gain)) return WELINK_VOICE_INVALID_PCM;
        for(size_t i=0;i<samples;++i) qualified[i]*=gain;
    }
    *original_rms=rms;
    return 0;
}
int welink_voice_qualified_fields(const void *model, size_t bytes,
    float *qualified, size_t samples, float *work, size_t work_floats,
    float head[128], float direction[256], float *original_rms) {
    if(!model || bytes!=WELINK_PNR_CLUSTER_V2_MODEL_BYTES || memcmp(model,"\0\0\0\2",4) ||
       !work || work_floats<welink_voice_cluster_fields_work_floats() || !head || !direction)
        return WELINK_VOICE_INVALID_PCM;
    const int result=welink_voice_qualified_level(qualified,samples,original_rms);
    if(result) return result;
    return welink_voice_cluster_fields_v2(model,bytes,qualified,samples,work,work_floats,head,direction);
}

/* 10244ad0: bins 0..255, scaled squared magnitude, binary32 reduction,
 * sqrt rounded to float, then double log10. Bin 256 is deliberately excluded. */
static float spectral_db(float power) {
    const float amplitude=(float)sqrt((double)((power/257.0f)*0x1p-9f));
    const float level=amplitude>0.0f ? (float)(20.0*log10((double)amplitude)+6.0) : -92.3f;
    return level < -92.3 ? -92.3f : level;
}
static int quality_update(struct welink_voice_quality *s, const float processed[514]) {
    float power=0.0f, residual_power=0.0f;
    for(unsigned k=0;k<256;++k) {
        const float re=processed[2*k], im=processed[2*k+1];
        power+=(re*re+im*im)*0x1p-30f;
        if(k>=3) {
            const float dr=s->previous[2*(k-3)]-re, di=s->previous[2*(k-3)+1]-im;
            residual_power+=(dr*dr+di*di)*0x1p-30f;
        }
    }
    const float residual_db=spectral_db(residual_power), level=spectral_db(power);
    if(!isfinite(residual_db) || !isfinite(level)) return -1;
    if(level<=-50.0f) return 0;
    float low=0.0f, middle=0.0f, high=0.0f;
    for(unsigned k=3;k<49;++k) {
        const float re=processed[2*k], im=processed[2*k+1];
        low+=(im*im+re*re)*0x1p-30f;
    }
    float total=low+middle;
    for(unsigned k=49;k<97;++k) {
        const float re=processed[2*k], im=processed[2*k+1];
        middle+=(im*im+re*re)*0x1p-30f;
    }
    total+=middle;
    for(unsigned k=97;k<145;++k) {
        const float re=processed[2*k], im=processed[2*k+1];
        high+=(im*im+re*re)*0x1p-30f;
    }
    total+=high;
    for(unsigned k=145;k<257;++k) {
        const float re=processed[2*k], im=processed[2*k+1];
        total+=(im*im+re*re)*0x1p-30f;
    }
    if(!isfinite(total)) return -1;
    const double divisor=(double)total+2e-15;
    const unsigned count=s->frames+1;
    const float reduction=(s->reduction_sum+level)-residual_db;
    const float mean=reduction/((float)count+0x1p-52f);
    if(!isfinite(reduction) || !isfinite(mean)) return -1;
    s->low+=(float)((double)low/divisor);
    s->middle+=(float)((double)middle/divisor);
    s->high+=(float)((double)high/divisor);
    s->reduction_sum=reduction; s->reduction_mean=mean; s->frames=count;
    return 0;
}
int welink_voice_quality_push(struct welink_voice_quality *s, const float captured[514],
                             const float processed[514], int selected) {
    if(!s || !captured || (selected!=0 && selected!=1) || !finite_samples(captured,514)) return -1;
    if(selected && (!processed || s->frames>=1000 || !finite_samples(processed,514) ||
                    quality_update(s,processed))) return -1;
    memcpy(s->previous,captured+6,sizeof s->previous);
    return 0;
}
int welink_voice_quality_result(const struct welink_voice_quality *s) {
    if(!s || s->frames>1000 || !isfinite(s->low) || !isfinite(s->middle) ||
       !isfinite(s->high) || !isfinite(s->reduction_mean)) return WELINK_VOICE_INVALID_PCM;
    const float count=(float)((double)s->frames+1e-5);
    const float low=s->low/count, high=s->high/count, middle=s->middle/count;
    if((double)low<0.6 || (double)(high+middle)<0.01) return WELINK_VOICE_BAD_SPECTRAL_QUALITY;
    return s->reduction_mean<10.0f ? WELINK_VOICE_BAD_REDUCTION : 0;
}
int welink_voice_suppression_push(struct welink_voice_suppression *s,
                                 const float delayed_input[160], const float output[160]) {
    if(!s || !delayed_input || !output || !finite_samples(delayed_input,160) ||
       !finite_samples(output,160)) return -1;
    const float in=pcm_db(squares(delayed_input,160)/160.0f);
    const float out=pcm_db(squares(output,160)/160.0f);
    const float floor=(float)fmax(-92.3,(double)out);
    if(isnan(in) || isnan(out) || in==INFINITY || out==INFINITY) return -1;
    if(in-floor>7.0f && in>-60.0f) {
        if(s->frames>=1000) return -1;
        s->reduction_sum=(in+s->reduction_sum)-floor;
        ++s->frames;
    }
    return 0;
}
int welink_voice_suppression_result(const struct welink_voice_suppression *s) {
    if(!s || !isfinite(s->reduction_sum)) return WELINK_VOICE_INVALID_PCM;
    return s->frames>150 ? WELINK_VOICE_BAD_SUPPRESSION : 0;
}
int welink_voice_calibration_frame(float original_rms, unsigned index, float output[160]) {
    if(!output || !isfinite(original_rms) || original_rms<=0.0f || original_rms>1.0f ||
       index>=WELINK_VOICE_CALIBRATION_FRAMES) return -1;
    const float level=(index&1 ? -1.0f : 1.0f)*(original_rms*2.0f);
    for(unsigned i=0;i<160;++i) output[i]=level;
    return 0;
}

/* Scalar 10203080 polynomial, used by the original sigmoid, not libm expf. */
static float gate_exp(float x) {
    const int exponent=(int)(x*as_float(UINT32_C(0x3fb8aa3b)));
    x-=(float)exponent*as_float(UINT32_C(0x3f317218));
    const float square=x*x;
    float a=x*as_float(UINT32_C(0x394d4a8b))+as_float(UINT32_C(0x3ab91bcb));
    const float b=x*as_float(UINT32_C(0x3c0897a6))+as_float(UINT32_C(0x3d2aa390));
    a=a*square+b;
    a*=square*square;
    float c=x*as_float(UINT32_C(0x3e2aaa6a))+as_float(UINT32_C(0x3f00000a));
    const float d=x*as_float(UINT32_C(0x3f800001))+1.0f;
    c=c*square+d;
    return as_float(as_word(a+c)+((uint32_t)exponent<<23));
}
static float gate_sigmoid(float x) {
    if(x < -20.0f) return 0.0f;
    if(x > 20.0f) return 1.0f;
    return (float)(1.0/(1.0+(double)gate_exp(-x)));
}
int welink_voice_vad_init(struct welink_voice_vad *s, const void *model, size_t bytes) {
    if(!s) return -1;
    s->initialized=0; s->failed=1;
    if(!model || bytes!=WELINK_VOICE_VAD_MODEL_BYTES || (uintptr_t)model%_Alignof(float) ||
       memcmp(model,"\1\0\0\0",4)) return -1;
    const float *p=(const float *)((const unsigned char *)model+4);
    for(unsigned i=0;i<2;++i) {
        struct welink_voice_vad_layer *l=&s->layers[i];
        l->input_weights=p; p+=(i ? 128u : 257u)*512;
        l->recurrent_weights=p; p+=128*512;
        l->input_bias=p; p+=512;
        l->recurrent_bias=p; p+=512;
        memset(l->cell,0,sizeof l->cell); memset(l->hidden,0,sizeof l->hidden);
    }
    s->weights=p; s->bias=p+128*257;
    s->active_history=0; s->active_run=0; s->inactive_run=0;
    s->initialized=1; s->failed=0;
    return 0;
}
static int vad_layer(struct welink_voice_vad_layer *s, const float *input, unsigned inputs) {
    float gates[512];
    for(unsigned j=0;j<512;++j) {
        float sum=0.0f;
        const float *w=s->input_weights+j*inputs;
        for(unsigned k=0;k<inputs;++k) sum+=input[k]*w[k];
        float value=(s->input_bias[j]+s->recurrent_bias[j])+sum;
        sum=0.0f; w=s->recurrent_weights+j*128;
        for(unsigned k=0;k<128;++k) sum+=s->hidden[k]*w[k];
        value+=sum;
        if(!isfinite(value)) return -1;
        gates[j]=value;
    }
    for(unsigned j=0;j<128;++j) {
        const float i=gate_sigmoid(gates[j]), f=gate_sigmoid(gates[128+j]);
        const float g=(float)tanh((double)gates[256+j]), o=gate_sigmoid(gates[384+j]);
        s->cell[j]=f*s->cell[j]+g*i;
        s->hidden[j]=o*(float)tanh((double)s->cell[j]);
    }
    return 0;
}
int welink_voice_vad_spectrum(struct welink_voice_vad *s, float spectrum[514],
    const struct welink_voice_vad_route *route, float mask[257]) {
    if(!s || !s->initialized || s->failed) return -1;
    if(!route || !spectrum || !finite_samples(spectrum,514)) { s->failed=1; return -1; }
    float magnitude[257];
    for(unsigned k=0;k<257;++k) {
        const float re=spectrum[2*k], im=spectrum[2*k+1];
        const float ip=((im*0x1p-15f)*im)*0x1p-15f;
        const float rp=((re*0x1p-15f)*re)*0x1p-15f;
        const float power=ip+rp;
        if(!isfinite(power)) { s->failed=1; return -1; }
        magnitude[k]=vqe_root(power);
    }
    if(vad_layer(&s->layers[0],magnitude,257) || vad_layer(&s->layers[1],s->layers[0].hidden,128)) {
        s->failed=1; return -1;
    }
    const int writeback=route->channel_mode==4 && !route->channel_2e0e &&
        !route->outer_110b92 && !route->channel_2e42 && !route->channel_2e4c;
    float *const gains=mask ? mask : (writeback ? magnitude : NULL);
    unsigned voiced=0;
    for(unsigned j=0;j<257;++j) {
        const float *w=s->weights+j*128;
        float sum=0.0f;
        for(unsigned k=0;k<128;++k) sum+=s->layers[1].hidden[k]*w[k];
        const float value=gate_sigmoid(s->bias[j]+sum);
        if(!isfinite(value)) { s->failed=1; return -1; }
        if(gains) gains[j]=value;
        if(j>=3 && j<32 && value>0.6f) ++voiced;
    }
    if(writeback) for(unsigned j=0;j<257;++j) {
        spectrum[2*j]*=gains[j];
        spectrum[2*j+1]*=gains[j];
    }
    const int active=(float)voiced/29.0f>0.5f;
    if(!active) {
        s->active_history=s->active_history>2 ? s->active_history-2 : 0;
        if(s->active_run) --s->active_run;
        if(s->inactive_run<100) ++s->inactive_run;
        if(s->inactive_run>=15) s->active_run=0;
    } else {
        s->inactive_run=0;
        if(s->active_run<100) ++s->active_run;
        if(s->active_history<100) ++s->active_history;
        else s->active_history=100;
        if(s->active_run==50) s->active_history+=20;
    }
    return active || s->active_history!=0;
}
