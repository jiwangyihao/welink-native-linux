#ifndef MEETING_VOICE_TEMPORAL_H
#define MEETING_VOICE_TEMPORAL_H
#include "meeting_voice_adaptive.h"
#include <stdint.h>

enum { PNR_CHANNELS=128, PNR_EXPANDED=512, PNR_DOWNSAMPLE_LEVELS=3,
       PNR_TEMPORAL_MODEL_SIZE=4596040, PNR_TEMPORAL_BANK_BYTES=0x24a20,
       PNR_INPUT_MIX_OFFSET=0x2f1a84, PNR_HOURGLASS_OFFSET=0x331c84 };

/* All maps refer to an aligned, authenticated, immutable LE campus v2 model.
 * The dequantization bias is cached with the same rounding as the SDK. */
struct pnr_temporal_qmap {
    const int8_t *weights;
    float input_scale, zero, scale;
};
struct pnr_temporal_bank {
    struct pnr_temporal_qmap expand, reduce;
    float expand_bias[PNR_EXPANDED], reduce_bias[PNR_CHANNELS];
    const float *slope[2], *scale[2], *offset[2], *kernel, *bias;
    struct welink_voice_adaptive norm[2];
};
void pnr_temporal_bind(struct pnr_temporal_bank *, const unsigned char *descriptor);
void pnr_temporal_expand(struct pnr_temporal_bank *,const float input[128],float output[512],
                         float activity,int learn_after_idle,int frozen);
void pnr_temporal_normalize(struct pnr_temporal_bank *,float frame[512],float activity,
                            int learn_after_idle,int frozen);
void pnr_temporal_reduce(const struct pnr_temporal_bank *,const float input[512],float output[128]);
struct pnr_down_level {
    struct pnr_temporal_bank bank;
    float ring[3][PNR_EXPANDED], residual[PNR_CHANNELS], pending[PNR_CHANNELS];
    unsigned next, has_residual, has_pending;
};
struct welink_voice_downsample {
    const float *mix, *mix_bias;
    struct pnr_down_level levels[PNR_DOWNSAMPLE_LEVELS];
    float skip[20+8+2][PNR_CHANNELS];
    unsigned skip_next[PNR_DOWNSAMPLE_LEVELS];
    unsigned decoded;
};
int welink_voice_downsample_init(struct welink_voice_downsample *,const void *model,size_t bytes);
/* Input is a normalized 512-channel output of welink_voice_projection_push.
 * Returns 1 with 128 outputs when all three max-pools have emitted, 0 otherwise;
 * a return of 0 leaves output untouched. Separate state per stream. */
int welink_voice_downsample_push(struct welink_voice_downsample *,const float input[512],
                                 float pooled[128],float activity,int learn_after_idle,int frozen);
#endif
