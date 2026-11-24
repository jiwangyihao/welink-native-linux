#ifndef MEETING_VOICE_PROJECTION_H
#define MEETING_VOICE_PROJECTION_H
#include "meeting_voice_adaptive.h"

/* One 160-sample input at the original PNR filter boundary is eight hops.
 * The caller owns activity/gate decisions. This stage neither captures audio
 * nor decides that a speaker has enrolled. */
enum { WELINK_VOICE_PROJECTION_HOP=20, WELINK_VOICE_PROJECTION_WIDTH=512,
       WELINK_VOICE_FILTERED_HISTORY_HOPS=24 }; /* Current frame plus two previous frames. */
struct welink_voice_projection {
    const float *weights, *scale, *bias;
    struct welink_voice_adaptive stats;
    float x2, x1, y2, y1;
    float filtered[WELINK_VOICE_FILTERED_HISTORY_HOPS][WELINK_VOICE_PROJECTION_HOP];
    unsigned next; /* Next hop to overwrite, hence the oldest retained hop. */
};
/* Provide an aligned, authenticated, immutable, memory-mapped campus v2
 * pnrModel.bin and keep the mapping alive. On error state is unchanged. */
int welink_voice_projection_init(struct welink_voice_projection *state,
                                 const void *model, size_t bytes);
/* Input and outputs do not overlap. signed_projection is the signal saved to
 * the model's delay line; normalized is the input to its following layer. */
void welink_voice_projection_push(struct welink_voice_projection *state,
                                  const float samples[20], float signed_projection[512],
                                  float normalized[512], float activity,
                                  int learn_after_idle, int frozen);
#endif
