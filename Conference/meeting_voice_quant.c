#include "meeting_voice_quant.h"
#include <float.h>
#include <stddef.h>
#include <string.h>

_Static_assert(sizeof(float)==4 && FLT_RADIX==2 && FLT_MANT_DIG==24 && FLT_EVAL_METHOD==0,
    "use IEEE binary32, not x87 excess precision");

static inline float read_f32le(const unsigned char *p) {
    uint32_t u=(uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
    float f; memcpy(&f,&u,sizeof(f)); return f;
}

const unsigned char *welink_voice_qbind(welink_voice_qmap *m,
    const unsigned char *p, unsigned inputs, unsigned outputs) {
    m->inputs=inputs; m->outputs=outputs;
    m->input_scale=read_f32le(p+4); m->input_zero=read_f32le(p+8);
    m->output_scale=read_f32le(p)*m->input_scale;
    m->weights=p+12; m->biases=m->weights+(size_t)inputs*outputs;
    return m->biases+4u*outputs;
}

void welink_voice_qapply(const welink_voice_qmap *m, const float *input,
                         float *output, unsigned char *scratch) {
    /* The original divides (not reciprocal-multiplies), adds a zero point,
     * then 0.5f and truncates. Negative or unordered results map to zero. */
    for (unsigned i=0;i<m->inputs;++i) {
        float q=(input[i]/m->input_scale + m->input_zero)+0.5f;
        scratch[i]=!(q>0.0f) ? 0 : q>=127.0f ? 127 : (unsigned char)q;
    }
    const unsigned char *w=m->weights;
    for (unsigned j=0;j<m->outputs;++j) {
        /* Largest original input row is 2560; the exact sum fits int32_t. */
        int32_t acc=0;
        for (unsigned i=0;i<m->inputs;++i) {
            const int32_t s=((int32_t)w[i]^128)-128;
            acc+=s*scratch[i];
        }
        output[j]=(float)acc*m->output_scale + read_f32le(m->biases+4u*j);
        w+=m->inputs;
    }
}
