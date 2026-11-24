#include "meeting_voice_bottleneck.h"
#include <string.h>

_Static_assert(4+PNR_BOTTLENECK_LEVELS*PNR_TEMPORAL_BANK_BYTES < PNR_INPUT_MIX_OFFSET,
               "bottleneck descriptors precede the input mixer");
int welink_voice_bottleneck_init(struct welink_voice_bottleneck *s,const void *model,size_t bytes) {
    if(!s || !model || bytes!=PNR_TEMPORAL_MODEL_SIZE || (uintptr_t)model%_Alignof(float) ||
       memcmp(model,"\0\0\0\2",4)) return -1;
    const unsigned char *p=(const unsigned char *)model+4;
    for(unsigned i=0;i<PNR_BOTTLENECK_LEVELS;++i,p+=PNR_TEMPORAL_BANK_BYTES)
        pnr_temporal_bind(s->banks+i,p);
    memset(s->oldest,0,sizeof s->oldest);
    memset(s->history,0,sizeof s->history);
    return 0;
}

void welink_voice_bottleneck_push(struct welink_voice_bottleneck *s,const float pooled[128],
                                  const float head[128],float output[128],float activity,
                                  int learn_after_idle,int frozen) {
    float hidden[512],alternate[128];
    const float *in=pooled;
    unsigned base=0;
    for(unsigned i=0;i<PNR_BOTTLENECK_LEVELS;++i) {
        struct pnr_temporal_bank *b=&s->banks[i];
        const unsigned dilation=1u<<(i%4), length=2*dilation, first=s->oldest[i];
        float *old=s->history[base+first];
        const float *middle=s->history[base+(first^dilation)];
        pnr_temporal_expand(b,in,hidden,activity,learn_after_idle,frozen);
        /* Interleaved [channel][tap], unlike the downsample kernels, which
         * store three complete channel vectors. Retire the oldest vector in place. */
        for(unsigned k=0;k<512;++k) {
            const float *w=b->kernel+3*k;
            float x=hidden[k];
            hidden[k]=b->bias[k]+(((old[k]*w[0]+0.0f)+middle[k]*w[1])+x*w[2]);
            old[k]=x;
        }
        s->oldest[i]=(first+1)&(length-1); base+=length;
        pnr_temporal_normalize(b,hidden,activity,learn_after_idle,frozen);
        float *out=(i&1) ? output : alternate;
        pnr_temporal_reduce(b,hidden,out);
        for(unsigned k=0;k<128;++k) out[k]+=in[k];
        if(i==0) for(unsigned k=0;k<128;++k) out[k]*=head[k];
        in=out;
    }
}
