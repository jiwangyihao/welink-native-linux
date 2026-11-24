#include "meeting_voice_projection.h"
#include <math.h>
#include <stdint.h>
#include <string.h>

#if __BYTE_ORDER__ != __ORDER_LITTLE_ENDIAN__
#error "The pinned PNR model contains little-endian binary32 coefficients"
#endif

enum { MODEL_BYTES=4596040, MODEL_HEADER=4, BANK_BYTES=0x24a20,
       INPUT_WEIGHTS=MODEL_HEADER+20*BANK_BYTES, HOP=WELINK_VOICE_PROJECTION_HOP,
       WIDTH=WELINK_VOICE_PROJECTION_WIDTH, ROW=2*HOP };
_Static_assert(sizeof(float)==4 && INPUT_WEIGHTS+(ROW+2)*WIDTH*4<=MODEL_BYTES,
               "PNR projection table extents");

int welink_voice_projection_init(struct welink_voice_projection *s,
                                 const void *model, size_t bytes) {
    if (!s || !model || bytes!=MODEL_BYTES || (uintptr_t)model%_Alignof(float) ||
        memcmp(model,"\0\0\0\2",MODEL_HEADER)!=0) return -1;
    const float *w=(const float *)((const unsigned char *)model+INPUT_WEIGHTS);
    *s=(struct welink_voice_projection){ .weights=w, .scale=w+ROW*WIDTH,
         .bias=w+(ROW+1)*WIDTH, .stats={.primary={.variance=1},.secondary={.variance=1}} };
    return 0;
}

void welink_voice_projection_push(struct welink_voice_projection *s,
                                  const float samples[HOP], float projected[WIDTH],
                                  float normalized[WIDTH], float activity,
                                  int learn_after_idle, int frozen) {
    float *now=s->filtered[s->next];
    const float *previous=s->filtered[s->next ? s->next-1 : WELINK_VOICE_FILTERED_HISTORY_HOPS-1];
    float x2=s->x2, x1=s->x1, y2=s->y2, y1=s->y1;
    for (unsigned j=0;j<HOP;++j) {
        float x=samples[j];
        float y=(((x*0x1.f4c06a0000000p-1f+x1*-0x1.f4c06a0000000p+0f)+x2*0x1.f4c06a0000000p-1f)-y1*-0x1.f4a0c60000000p+0f)-y2*0x1.e9c0180000000p-1f;
        now[j]=y; x2=x1; x1=x; y2=y1; y1=y;
    }
    s->x2=x2; s->x1=x1; s->y2=y2; s->y1=y1;
    if(++s->next==WELINK_VOICE_FILTERED_HISTORY_HOPS) s->next=0;
    const float *w=s->weights;
    for (unsigned i=0;i<WIDTH;++i,w+=ROW) {
        float v=0;
        for (unsigned j=0;j<HOP;++j) v+=previous[j]*w[j];
        for (unsigned j=0;j<HOP;++j) v+=now[j]*w[HOP+j];
        projected[i]=v;
        normalized[i]=fabsf(v);
    }
    welink_voice_adapt_frame(&s->stats,normalized,WIDTH,s->scale,s->bias,activity,learn_after_idle,frozen);
}
