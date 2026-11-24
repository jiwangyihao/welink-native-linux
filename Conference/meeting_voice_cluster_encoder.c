#include "meeting_voice_cluster_encoder.h"
#include "meeting_voice_cluster_backbone.h"
#include "meeting_voice_quant.h"
#include "meeting_voice_pool.h"
#include <math.h>
#include <stdint.h>
#include <string.h>

enum { BLOCK = 50*40*32, RING = 3*20*576, TEMP = 960 };
/* expansion channels, output channels, stride, residual */
static const struct layout { unsigned exp, out, step, residual; } layers[] = {
    {128,32,2,0}, {128,32,1,1}, {128,32,1,1}, {128,32,1,1},
    {128,64,1,0}, {256,64,1,1}, {256,64,1,1}, {384,96,1,0},
    {576,96,1,1}, {576,160,2,0}, {960,160,1,1}, {960,320,1,0}
};

static inline float weight(const unsigned char *p) {
    uint32_t u=(uint32_t)p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;
    float f; memcpy(&f,&u,4); return f;
}
static inline float clip(float x) { return !(x>=0.0f) ? 0.0f : x>=6.0f ? 6.0f : x; }
size_t welink_voice_cluster_work_floats(void) { return 2*BLOCK+RING+TEMP; }

/* Only retain three temporal rows of expanded activations. The original dot
 * product traverses physical ring slots, not chronological order; preserve
 * that order so float rounding at the next int8 quantizer is reproducible. */
static const unsigned char *layer(const unsigned char *p, const struct layout l,
    const float *in, float *out, unsigned nt, unsigned nf, unsigned nc,
    float *ring, float *dw, unsigned char *q, int expand, unsigned preceding_blocks) {
    welink_voice_qmap up, down;
    if (expand) p=welink_voice_qbind(&up,p,nc,l.exp);
    const unsigned char *kernel=p, *bias=p+4*9*l.exp;
    p=welink_voice_qbind(&down,bias+4*l.exp,l.exp,l.out);
    const unsigned row=nf*l.exp, fo=(nf+l.step-1)/l.step;
    /* The original clears samples, but not the physical write cursor, on block import.
     * Every full block writes nt rows, plus a zero row if the final center is used. */
    const unsigned writes=nt+((nt-1)%l.step==0);
    const unsigned first=(preceding_blocks%3)*(writes%3)%3;
    memset(ring+((first+2)%3)*row,0,row*sizeof(float));
    for (unsigned t=0;t<=nt;++t) {
        const unsigned slot=(first+t)%3;
        float *dest=ring+slot*row;
        if (t==nt && (t-1)%l.step) break;
        if (t==nt) memset(dest,0,row*sizeof(float));
        else if (!expand) memcpy(dest,in+t*row,row*sizeof(float));
        else for(unsigned f=0;f<nf;++f) {
            float *v=dest+f*l.exp;
            welink_voice_qapply(&up,in+(t*nf+f)*nc,v,q);
            for(unsigned c=0;c<l.exp;++c) v[c]=clip(v[c]);
        }
        if (!t || (t-1)%l.step) continue;
        const unsigned center_t=t-1, to=center_t/l.step, oldest=(slot+1)%3;
        for(unsigned f=0;f<fo;++f) {
            const unsigned center_f=f*l.step;
            for(unsigned c=0;c<l.exp;++c) {
                float sum=0.0f;
                for(unsigned s=0;s<3;++s) {
                    const unsigned kt=(s+3-oldest)%3;
                    const float *rowp=ring+s*row;
                    for(unsigned kf=0;kf<3;++kf) {
                        int ix=(int)center_f+(int)kf-1;
                        if ((unsigned)ix<nf)
                            /* The desktop kernel rounds the product and sum only once. */
                            sum=fmaf(rowp[(unsigned)ix*l.exp+c],weight(kernel+4*((3*kf+kt)*l.exp+c)),sum);
                    }
                }
                dw[c]=clip(weight(bias+4*c)+sum);
            }
            float *v=out+(to*fo+f)*l.out;
            welink_voice_qapply(&down,dw,v,q);
            if(l.residual) {
                const float *skip=in+(center_t*nf+center_f)*nc;
                for(unsigned c=0;c<nc;++c) v[c]+=skip[c];
            }
        }
    }
    return p;
}

int welink_voice_cluster_encode_v2(const void *model, size_t bytes,
    const float features[8000], unsigned preceding_blocks,
    float *work, size_t nwork, float encoded[256]) {
    if (!model || !features || !work || !encoded || nwork<welink_voice_cluster_work_floats()) return -1;
    float *input=work, *output=input+BLOCK, *ring=output+BLOCK, *dw=ring+RING;
    if (welink_pnr_cluster_first_conv_v2(model,bytes,features,input)) return -1;
    unsigned char q[2560];
    const unsigned char *p=(const unsigned char *)model+0x504;
    const struct layout stem={32,32,1,1};
    p=layer(p,stem,input,output,50,40,32,ring,dw,q,0,preceding_blocks);
    unsigned nt=50,nf=40,nc=32;
    for(unsigned b=0;b<sizeof(layers)/sizeof(layers[0]);++b) {
        const struct layout l=layers[b]; float *temp=input; input=output;output=temp;
        p=layer(p,l,input,output,nt,nf,nc,ring,dw,q,1,preceding_blocks);
        nt=(nt+l.step-1)/l.step; nf=(nf+l.step-1)/l.step; nc=l.out;
    }
    welink_voice_qmap tail, pooled;
    p=welink_voice_qbind(&tail,p,320,128);
    for(unsigned i=0;i<13*10;++i) {
        float *v=input+i*128; welink_voice_qapply(&tail,output+i*320,v,q);
        for(unsigned c=0;c<128;++c) v[c]=clip(v[c]);
    }
    welink_voice_cluster_pool((const float (*)[10][128])input,(float (*)[20])output);
    welink_voice_qbind(&pooled,p,2560,256);
    welink_voice_qapply(&pooled,output,encoded,q);
    return 0;
}
