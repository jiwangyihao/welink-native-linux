#include "meeting_voice_temporal.h"
#include <float.h>
#include <string.h>

_Static_assert(sizeof(float)==4 && FLT_RADIX==2 && FLT_MANT_DIG==24 && FLT_EVAL_METHOD==0,
               "use binary32, compile without FP contraction or fast math");
#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "PNR v2 coefficients are little endian"
#endif
static const unsigned char *bind_qmap(struct pnr_temporal_qmap *q,float *adjusted,
                                      const unsigned char *p,unsigned inputs,unsigned outputs) {
    const float *bias=(const float *)(p+(size_t)inputs*outputs), *f=bias+outputs;
    q->weights=(const int8_t *)p; q->input_scale=f[1]; q->zero=f[2]; q->scale=f[0]*f[1];
    const float correction=q->scale*q->zero;
    for(unsigned j=0;j<outputs;++j) {
        const int8_t *row=q->weights+(size_t)j*inputs;
        float v=0;
        for(unsigned k=0;k<inputs;++k) v-=(float)row[k]*correction;
        adjusted[j]=bias[j]+v;
    }
    return (const unsigned char *)(f+3);
}
void pnr_temporal_bind(struct pnr_temporal_bank *b,const unsigned char *p) {
    const float *f=(const float *)bind_qmap(&b->expand,b->expand_bias,p,128,512);
    b->slope[0]=f++; b->scale[0]=f; f+=512; b->offset[0]=f; f+=512;
    b->kernel=f; f+=3*512; b->bias=f; f+=512;
    b->slope[1]=f++; b->scale[1]=f; f+=512; b->offset[1]=f; f+=512;
    bind_qmap(&b->reduce,b->reduce_bias,(const unsigned char *)f,512,128);
    for(unsigned i=0;i<2;++i) b->norm[i]=(struct welink_voice_adaptive){.primary.variance=1,.secondary.variance=1};
}
static inline void apply_qmap(const struct pnr_temporal_qmap *q,const float *bias,
                              const float *input,unsigned inputs,float *out,unsigned outputs) {
    unsigned char quant[PNR_EXPANDED];
    for(unsigned k=0;k<inputs;++k) {
        float x=(input[k]/q->input_scale+q->zero)+0.5f;
        quant[k]=!(x>0) ? 0 : x>=127 ? 127 : (unsigned char)x;
    }
    const int8_t *row=q->weights;
    for(unsigned j=0;j<outputs;++j,row+=inputs) {
        int32_t acc=0;
        for(unsigned k=0;k<inputs;++k) acc+=row[k]*quant[k];
        out[j]=(float)acc*q->scale+bias[j];
    }
}
static void activate(struct pnr_temporal_bank *b,unsigned idx,float *x,float activity,int learn,int frozen) {
    const float slope=*b->slope[idx];
    for(unsigned k=0;k<512;++k) if(x[k]<0) x[k]*=slope;
    welink_voice_adapt_frame(&b->norm[idx],x,512,b->scale[idx],b->offset[idx],activity,learn,frozen);
}
void pnr_temporal_expand(struct pnr_temporal_bank *b,const float in[128],float out[512],float act,int learn,int frozen) {
    apply_qmap(&b->expand,b->expand_bias,in,128,out,512); activate(b,0,out,act,learn,frozen);
}
void pnr_temporal_normalize(struct pnr_temporal_bank *b,float frame[512],float act,int learn,int frozen) {
    activate(b,1,frame,act,learn,frozen);
}
void pnr_temporal_reduce(const struct pnr_temporal_bank *b,const float in[512],float out[128]) {
    apply_qmap(&b->reduce,b->reduce_bias,in,512,out,128);
}
int welink_voice_downsample_init(struct welink_voice_downsample *s,const void *model,size_t bytes) {
    if(!s || !model || bytes!=PNR_TEMPORAL_MODEL_SIZE || (uintptr_t)model%_Alignof(float) ||
       memcmp(model,"\0\0\0\2",4)) return -1;
    const unsigned char *p=model;
    s->mix=(const float *)(p+PNR_INPUT_MIX_OFFSET); s->mix_bias=s->mix+128*512;
    memset(s->skip,0,sizeof s->skip);
    memset(s->skip_next,0,sizeof s->skip_next);
    s->decoded=0;
    for(unsigned l=0;l<3;++l) {
        struct pnr_down_level *level=s->levels+l;
        pnr_temporal_bind(&level->bank,p+PNR_HOURGLASS_OFFSET+l*PNR_TEMPORAL_BANK_BYTES);
        memset(level->ring,0,sizeof level->ring); level->next=level->has_residual=level->has_pending=0;
    }
    return 0;
}
/* Original float matrix has tiles of 32 outputs, not 128 independent rows. */
static void mix_input(const struct welink_voice_downsample *s,const float *in,float *out) {
    const float *w=s->mix;
    for(unsigned j=0;j<128;j+=32) {
        memcpy(out+j,s->mix_bias+j,32*sizeof(float));
        for(unsigned k=0;k<512;++k,w+=32)
            for(unsigned c=0;c<32;++c) out[j+c]+=in[k]*w[c];
    }
}
int welink_voice_downsample_push(struct welink_voice_downsample *s,const float in[512],float pooled[128],
                                 float activity,int learn,int frozen) {
    float x[128],reduced[128],depth[512];
    mix_input(s,in,x);
    for(unsigned l=0;l<3;++l) {
        struct pnr_down_level *b=s->levels+l;
        unsigned cur=b->next,old=(cur+1)%3,mid=(cur+2)%3;
        pnr_temporal_expand(&b->bank,x,b->ring[cur],activity,learn,frozen); b->next=old;
        if(!b->has_residual) {
            memcpy(b->residual,x,sizeof x); b->has_residual=1; return 0;
        }
        const float *w=b->bank.kernel;
        for(unsigned k=0;k<512;++k)
            depth[k]=((b->ring[old][k]*w[k]+b->ring[mid][k]*w[512+k])+b->ring[cur][k]*w[1024+k])+b->bank.bias[k];
        pnr_temporal_normalize(&b->bank,depth,activity,learn,frozen);
        pnr_temporal_reduce(&b->bank,depth,reduced);
        static const unsigned skip_base[3]={0,20,28}, skip_length[3]={20,8,2};
        unsigned *pos=&s->skip_next[l];
        memcpy(s->skip[skip_base[l]+*pos],reduced,sizeof reduced);
        if(++*pos==skip_length[l]) *pos=0;
        for(unsigned k=0;k<128;++k) reduced[k]+=b->residual[k];
        memcpy(b->residual,x,sizeof x);
        if(!b->has_pending) { memcpy(b->pending,reduced,sizeof reduced); b->has_pending=1; return 0; }
        for(unsigned k=0;k<128;++k) x[k]=b->pending[k]>reduced[k] ? b->pending[k] : reduced[k];
        b->has_pending=0;
    }
    memcpy(pooled,x,sizeof x); return 1;
}
