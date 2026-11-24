#ifndef MEETING_VOICE_UPSAMPLE_H
#define MEETING_VOICE_UPSAMPLE_H
#include "meeting_voice_temporal.h"

struct pnr_up_level {
    struct pnr_temporal_bank bank;
    float ring[3][PNR_EXPANDED], residual[PNR_CHANNELS];
    unsigned next, primed;
};
struct welink_voice_upsample { struct pnr_up_level levels[3]; };
int welink_voice_upsample_init(struct welink_voice_upsample *s,const void *model,size_t bytes);
/* Call once per bottleneck output, before advancing the encoder again. Writes
 * one 128-channel frame on the first call and eight thereafter. Buffers do not
 * overlap. Reinitialize encoder and decoder together when changing stream. */
unsigned welink_voice_upsample_push(struct welink_voice_upsample *s,struct welink_voice_downsample *enc,
                                    const float latent[128],float decoded[8][128],float activity,
                                    int learn_after_idle,int frozen);
#endif
