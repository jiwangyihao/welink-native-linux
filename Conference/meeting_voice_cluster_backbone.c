/* Independently compiled first layer of the pinned campus PNR cluster encoder.
 * Evidence: mmr_media.dll SHA-256
 * bea0ed34f106dca1ae9131d43ffc62bff498e90d59a13d1058c6bd7c549450c9.
 *
 * Original call/data path:
 * - 0x1024aa30 initializes state, a two-frame ring, and its dimensions.
 * - 0x1024b910 binds model+4; 0x1024c3f0 specifies 1 -> 32 channels,
 *   3x3 kernels, frequency stride 2 and pad 1 on an 80x3 frequency/time strip.
 * - 0x1024b7a0 imports 8000 floats at state+0x148.
 * - 0x10249780 feeds 80-float rows, increments state[0], calls 0x10249a40.
 * - 0x10249a40 gathers [previous-2, previous-1, current] per frequency;
 *   frames 1,3,...,99 produce the 50 rows centered on frames 0,2,...,98.
 * - 0x102ada20 / 0x102af070 form the 40 nine-float patches. The desktop
 *   dot product reduces two four-lane groups, then adds the tail and bias.
 * - 0x10249c34 transposes channel/frequency; 0x1024b730 clips to [0,6].
 * Later layers are implemented in meeting_voice_cluster_encoder.c.
 */
#include "meeting_voice_cluster_backbone.h"

#include <float.h>
#include <stdint.h>
#include <string.h>

_Static_assert(sizeof(float) == 4 && FLT_RADIX == 2 && FLT_MANT_DIG == 24 &&
               FLT_EVAL_METHOD == 0, "this stage requires binary32 evaluation");

static inline float little_float(const unsigned char *p) {
    uint32_t bits = (uint32_t)p[0] | ((uint32_t)p[1] << 8) |
                    ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    float value;
    memcpy(&value, &bits, sizeof value);
    return value;
}

/* Preserve the desktop kernel's lane order without requiring AVX or FMA. */
static inline float dot4(const float *x, const unsigned char *w) {
    return (x[0]*little_float(w) + x[2]*little_float(w+8)) +
           (x[1]*little_float(w+4) + x[3]*little_float(w+12));
}

int welink_pnr_cluster_first_conv_v2(
    const void *model, size_t bytes,
    const float features[WELINK_PNR_CLUSTER_INPUT_FLOATS],
    float activation[WELINK_PNR_CLUSTER_FIRST_FLOATS]) {
    const unsigned char *data = model;
    if (!data || !features || !activation ||
        bytes != WELINK_PNR_CLUSTER_V2_MODEL_BYTES ||
        memcmp(data, "\0\0\0\2", 4)) return -1;

    const unsigned char *weights = data + 4, *biases = data + 0x484;
    for (int t = 0; t < WELINK_PNR_CLUSTER_FIRST_FRAMES; ++t) {
        for (int f = 0; f < WELINK_PNR_CLUSTER_FIRST_BINS; ++f) {
            /* Gather once for all 32 output channels, not once per channel. */
            float patch[9];
            for (int kf = 0; kf < 3; ++kf) {
                const int in_f = 2*f + kf - 1;
                for (int kt = 0; kt < 3; ++kt) {
                    const int in_t = 2*t + kt - 1;
                    patch[3*kf + kt] = in_f < 0 || in_t < 0 ? 0.0f :
                        features[in_t * WELINK_PNR_CLUSTER_INPUT_BINS + in_f];
                }
            }
            /* Upper bounds are 99 and 79 by the fixed output/kernel extents. */
            for (int c = 0; c < WELINK_PNR_CLUSTER_FIRST_CHANNELS; ++c) {
                const unsigned char *row = weights + 4*9*c;
                const float sum = (dot4(patch,row) + dot4(patch+4,row+16)) +
                                  patch[8]*little_float(row+32);
                float value = little_float(biases + 4*c) + sum;
                /* Map unordered comparisons to +0 before clipping. */
                if (!(value >= 0.0f)) value = 0.0f;
                if (value >= 6.0f) value = 6.0f;
                activation[(t * WELINK_PNR_CLUSTER_FIRST_BINS + f) *
                           WELINK_PNR_CLUSTER_FIRST_CHANNELS + c] = value;
            }
        }
    }
    return 0;
}
