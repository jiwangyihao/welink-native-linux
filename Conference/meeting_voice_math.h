#ifndef MEETING_VOICE_MATH_H
#define MEETING_VOICE_MATH_H
#include <float.h>
#include <stdint.h>
#include <string.h>

_Static_assert(sizeof(float)==4 && FLT_RADIX==2 && FLT_MANT_DIG==24 && FLT_EVAL_METHOD==0,
               "voice statistics require binary32 arithmetic");
static inline uint32_t as_word(float x) { uint32_t u; memcpy(&u,&x,4); return u; }
static inline float as_float(uint32_t u) { float x; memcpy(&x,&u,4); return x; }

/* Same operation order as the VQE root approximation. In particular,
 * replacing this by sqrtf changes very small variances and quantizer ties. */
static inline float vqe_root(float x) {
    float inv=as_float(UINT32_C(0x5f3759df)-(as_word(x)>>1));
    for (unsigned i=0;i<2;++i) inv=((3.0f-(inv*x)*inv)*0.5f)*inv;
    uint32_t e=UINT32_C(0x3f800000)-(as_word(inv)&UINT32_C(0x7f800000));
    float m=as_float(as_word(inv)+e);
    float y=as_float(as_word(0x1.69696ap+0f-m*0x1.e1e1e2p-2f)+e);
    for (unsigned i=0;i<2;++i) y=(2.0f-inv*y)*y;
    return y;
}
#endif
