#ifndef MEETING_VOICE_SYNTHESIS_H
#define MEETING_VOICE_SYNTHESIS_H
#include "meeting_voice_temporal.h"

/* 22 signed analysis projections supply lookahead for the learned masks.
 * Independent state per stream. Model is authenticated and owned by caller. */
struct welink_voice_synthesis {
    const float *slope, *weights, *bias, *basis;
    float signed_history[22][512], tail[20];
    unsigned next;
};
int welink_voice_synthesis_init(struct welink_voice_synthesis *,const void *model,size_t bytes);
/* Write this hop's signed projection to signed_history[next] before calling.
 * Advances every hop, even with no decoded frames. n=1 primes the overlap;
 * n=8 writes 160 samples and returns 160. n=0 and n=1 write no output. */
unsigned welink_voice_synthesis_push(struct welink_voice_synthesis *,const float decoded[][128],
                                     unsigned n,float output[160]);
#endif
