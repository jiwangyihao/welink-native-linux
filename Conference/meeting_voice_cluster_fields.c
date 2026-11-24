#include "meeting_voice_cluster_fields.h"
#include "meeting_voice_cluster_encoder.h"
#include "meeting_voice_cluster_backbone.h"
#include "meeting_voice_frontend.h"
#include <math.h>
#include <string.h>

int welink_pnr_cluster_head_v2(const void *, size_t, const float [256], float [128]);

enum { SECOND = 16000, BANDS = WELINK_PNR_CLUSTER_INPUT_FLOATS };
size_t welink_voice_cluster_fields_work_floats(void) {
    return BANDS + welink_voice_cluster_work_floats();
}

int welink_voice_cluster_fields_v2(const void *model, size_t bytes,
    const float *prepared, size_t samples, float *work, size_t work_floats,
    float mean128[128], float direction_sum256[256]) {
    if (!model || bytes != WELINK_PNR_CLUSTER_V2_MODEL_BYTES ||
        memcmp(model, "\0\0\0\2", 4) || !prepared || samples < SECOND ||
        !work || work_floats < welink_voice_cluster_fields_work_floats() ||
        !mean128 || !direction_sum256) return -1;
    const unsigned blocks = samples >= 10u*SECOND ? 10u : (unsigned)(samples / SECOND);
    struct welink_voice_frontend front;
    welink_voice_frontend_init(&front);
    float xm1=0, xm2=0, ym1=0, ym2=0;
    float sum128[128]={0}, sum256[256]={0};
    for (unsigned b=0;b<blocks;++b) {
        for (unsigned f=0;f<100;++f) {
            float hop[WELINK_PNR_HOP];
            for (unsigned j=0;j<WELINK_PNR_HOP;++j) {
                const float x=*prepared++;
                float y = x*0x1.fa58360000000p-1f - xm1*0x1.fa58360000000p+0f;
                y += xm2*0x1.fa58360000000p-1f;
                y -= ym1*(-0x1.fa50360000000p+0f);
                y -= ym2*0x1.f4c06a0000000p-1f;
                xm2=xm1; xm1=x; ym2=ym1; ym1=y; hop[j]=y;
            }
            welink_voice_frontend_push(&front,hop,NULL,(float (*)[80])work);
        }
        float encoded[256], head[128];
        if (welink_voice_cluster_encode_v2(model,bytes,work,b,work+BANDS,work_floats-BANDS,encoded) ||
            welink_pnr_cluster_head_v2(model,bytes,encoded,head)) return -1;
        float sum_sq=0.0f;
        for(unsigned i=0;i<256;++i) sum_sq+=encoded[i]*encoded[i];
        const double divisor=(double)(float)sqrt((double)sum_sq)+2e-15;
        for(unsigned i=0;i<256;++i) sum256[i]+=(float)((double)encoded[i]/divisor);
        for(unsigned i=0;i<128;++i) sum128[i]+=head[i];
    }
    for(unsigned i=0;i<128;++i) mean128[i]=sum128[i]/(float)blocks;
    memcpy(direction_sum256,sum256,sizeof(sum256)); /* the original does not divide this sum */
    return (int)blocks;
}
