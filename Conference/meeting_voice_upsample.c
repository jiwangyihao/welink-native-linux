#include "meeting_voice_upsample.h"
#include <string.h>

int welink_voice_upsample_init(struct welink_voice_upsample *s,const void *model,size_t bytes) {
    if(!s || !model || bytes!=PNR_TEMPORAL_MODEL_SIZE || (uintptr_t)model%_Alignof(float) ||
       memcmp(model,"\0\0\0\2",4)) return -1;
    const unsigned char *p=model;
    for(unsigned l=0;l<3;++l) {
        struct pnr_up_level *b=s->levels+l;
        pnr_temporal_bind(&b->bank,p+PNR_HOURGLASS_OFFSET+(3+l)*PNR_TEMPORAL_BANK_BYTES);
        memset(b->ring,0,sizeof b->ring); b->next=0; b->primed=0;
    }
    return 0;
}

unsigned welink_voice_upsample_push(struct welink_voice_upsample *s,struct welink_voice_downsample *enc,
                                    const float latent[128],float decoded[8][128],float activity,
                                    int learn,int frozen) {
    static const unsigned base[3]={28,20,0}, cap[3]={2,8,20};
    float first[2][128], second[4][128], skip_input[128], depth[512];
    const float *in=latent;
    unsigned count=1;
    for(unsigned level=0;level<3;++level) {
        struct pnr_up_level *b=s->levels+level;
        float *out=level==0 ? &first[0][0] : level==1 ? &second[0][0] : &decoded[0][0];
        unsigned cursor=enc->decoded ? enc->skip_next[2-level] : 0, written=0;
        for(unsigned t=0;t<2*count;++t) {
            const float *plain=in+128*(t/2), *skip=enc->skip[base[level]+cursor];
            if(++cursor==cap[level]) cursor=0;
            for(unsigned k=0;k<128;++k) skip_input[k]=skip[k]+plain[k];
            unsigned cur=b->next,old=(cur+1)%3,mid=(cur+2)%3;
            pnr_temporal_expand(&b->bank,skip_input,b->ring[cur],activity,learn,frozen); b->next=old;
            if(b->primed) {
                const float *w=b->bank.kernel;
                for(unsigned k=0;k<512;++k)
                    depth[k]=((b->ring[old][k]*w[k]+b->ring[mid][k]*w[512+k])+b->ring[cur][k]*w[1024+k])+b->bank.bias[k];
                pnr_temporal_normalize(&b->bank,depth,activity,learn,frozen);
                float *y=out+written*128; pnr_temporal_reduce(&b->bank,depth,y);
                for(unsigned k=0;k<128;++k) y[k]+=b->residual[k];
                ++written;
            }
            memcpy(b->residual,plain,sizeof b->residual); b->primed=1;
        }
        in=out; count=written;
    }
    enc->decoded=1; return count;
}
