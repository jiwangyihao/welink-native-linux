#include "meeting_voice_synthesis.h"
#include <math.h>
#include <string.h>

enum { MASK_PARAMETERS=PNR_HOURGLASS_OFFSET+6*PNR_TEMPORAL_BANK_BYTES };
_Static_assert(MASK_PARAMETERS+sizeof(float)*(1+128*512+512+40*512)==PNR_TEMPORAL_MODEL_SIZE,
               "synthesis basis ends at the end of the pinned model");
int welink_voice_synthesis_init(struct welink_voice_synthesis *s,const void *model,size_t bytes) {
    if(!s || !model || bytes!=PNR_TEMPORAL_MODEL_SIZE || (uintptr_t)model%_Alignof(float) ||
       memcmp(model,"\0\0\0\2",4)) return -1;
    const float *p=(const float *)((const unsigned char *)model+MASK_PARAMETERS);
    s->slope=p; s->weights=p+1; s->bias=s->weights+128*512; s->basis=s->bias+512;
    memset(s->signed_history,0,sizeof s->signed_history); memset(s->tail,0,sizeof s->tail);
    s->next=0;
    return 0;
}
static void masked_frame(const struct welink_voice_synthesis *s,const float *code,
                         const float *signed_input,float masked[512]) {
    float active[128]; const float slope=*s->slope;
    for(unsigned k=0;k<128;++k) active[k]=code[k]<0 ? code[k]*slope : code[k];
    const float *w=s->weights;
    for(unsigned j=0;j<512;j+=32) {
        float tile[32]; memcpy(tile,s->bias+j,sizeof tile);
        for(unsigned k=0;k<128;++k,w+=32)
            for(unsigned c=0;c<32;++c) tile[c]+=active[k]*w[c];
        for(unsigned c=0;c<32;++c) {
            const float mask=(float)(1.0/(1.0+exp(-(double)tile[c])));
            masked[j+c]=signed_input[j+c]*mask;
        }
    }
}
unsigned welink_voice_synthesis_push(struct welink_voice_synthesis *s,const float decoded[][128],
                                     unsigned n,float output[160]) {
    if(++s->next==22) s->next=0;
    if(!n) return 0;
    unsigned idx=n==1 ? 0 : s->next;
    for(unsigned f=0;f<n;++f) {
        float masked[512]; masked_frame(s,decoded[f],s->signed_history[idx],masked);
        if(++idx==22) idx=0;
        for(unsigned j=n==1 ? 20u : 0u;j<40;++j) {
            const float *w=s->basis+j*512; float sample=0.0f;
            for(unsigned k=0;k<512;++k) sample+=w[k]*masked[k];
            if(j<20) output[f*20+j]=sample+s->tail[j];
            else s->tail[j-20]=sample;
        }
    }
    return n==8 ? 160 : 0;
}
