/* Output head of the campus v2 PNR cluster encoder, not an audio-to-voiceprint API.
 * Compile without fast-math/reassociation and with -ffp-contract=off to reproduce SSE rounding.
 * Keep the package model mapped read-only for the call. Features are NOT raw PCM.
 * This module never opens a microphone, stores a biometric, or enables the shield.
 */
#include <float.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

_Static_assert(sizeof(float) == 4 && FLT_RADIX == 2 && FLT_MANT_DIG == 24,
               "this model requires IEEE binary32");
static inline float little_float(const unsigned char *p) {
    uint32_t bits = (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
                    ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    float value;
    memcpy(&value, &bits, sizeof value);
    return value;
}

static float project_row(const unsigned char *weights, const float *x, size_t n, float bias) {
    for (size_t k = 0; k < n; ++k) bias += x[k] * little_float(weights + 4 * k);
    return bias;
}

/* Version 2 only. The caller authenticates the package; header/size are not a signature.
 * Returns 0 on success, -1 for a missing/wrong-layout input; no output on error.
 */
int welink_pnr_cluster_head_v2(const void *model, size_t bytes,
                               const float features[256], float embedding[128]) {
    enum { inputs=256, width=512, outputs=128, model_bytes=2896332 };
    const size_t head_bytes = 4u * (width*inputs + width + 1 + outputs*width + outputs);
    const unsigned char *data = model;
    if (!data || !features || !embedding || bytes != model_bytes || memcmp(data, "\0\0\0\2", 4)) return -1;
    const unsigned char *w1 = data + (bytes - head_bytes), *b1 = w1 + 4u*width*inputs;
    const unsigned char *activation = b1 + 4u*width, *w2 = activation + 4;
    const unsigned char *b2 = w2 + 4u*outputs*width;
    const float slope = little_float(activation);
    float hidden[width];
    for (size_t j = 0; j < width; ++j) {
        float v = project_row(w1 + 4u*j*inputs, features, inputs, little_float(b1 + 4*j));
        hidden[j] = v < 0.0f ? v*slope : v;
    }
    for (size_t j = 0; j < outputs; ++j)
        embedding[j] = project_row(w2 + 4u*j*width, hidden, width, little_float(b2 + 4*j));
    return 0;
}
