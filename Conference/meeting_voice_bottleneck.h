#ifndef MEETING_VOICE_BOTTLENECK_H
#define MEETING_VOICE_BOTTLENECK_H
#include "meeting_voice_temporal.h"

enum { PNR_BOTTLENECK_LEVELS=20, PNR_BOTTLENECK_HISTORY=5*(2+4+8+16) };
struct welink_voice_bottleneck {
    struct pnr_temporal_bank banks[PNR_BOTTLENECK_LEVELS];
    unsigned oldest[PNR_BOTTLENECK_LEVELS];
    float history[PNR_BOTTLENECK_HISTORY][PNR_EXPANDED];
};
/* Same model ownership and alignment contract as welink_voice_downsample_init. */
int welink_voice_bottleneck_init(struct welink_voice_bottleneck *,const void *model,size_t bytes);
/* One call per emitted downsample output, never per raw 20-sample hop.
 * head is the enrolled 128-float speaker vector; use only with consent. */
void welink_voice_bottleneck_push(struct welink_voice_bottleneck *,const float pooled[128],
                                  const float head[128],float output[128],float activity,
                                  int learn_after_idle,int frozen);
#endif
