#ifndef MEETING_VOICE_ENGINE_OUTER_H
#define MEETING_VOICE_ENGINE_OUTER_H
#include "meeting_voice_engine.h"

/* Recovered 10245c60 frame wrapper: two-frame input alignment, 300-frame
 * residual-energy activity, ten-frame freeze hangover and output attenuation.
 * This still needs the REAL original upstream media controls. It does not
 * derive them from raw energy or a timer and does not certify enrollment. */
struct welink_voice_media_control {
    int learn_after_idle;             /* outer+0x120a14, not activity */
    int freeze_source;                /* media+0x1b2a */
    float before_db, after_db;        /* media+0x2e34, media+0x2e38 */
};
struct welink_voice_engine_outer {
    struct welink_voice_engine core;
    float activity_history[300];
    float activity, output_ratio_db, residual_ratio_db, smoothed_db, gain;
    unsigned activity_next, freeze_hangover;
};
int welink_voice_engine_outer_init(struct welink_voice_engine_outer *, const void *model, size_t bytes);
/* Resets both temporal layers and all frame-wrapper state on a record change. */
int welink_voice_engine_outer_restore(struct welink_voice_engine_outer *, const void *record, size_t bytes);
/* Caller must bind cluster fields or restore a valid complete record first.
 * Exactly 160 input/output floats, no overlap, no allocations or I/O. Returns
 * 160 on success (including initial silence), -1 on fatal/zeroed output. */
int welink_voice_engine_outer_frame(struct welink_voice_engine_outer *, const float input[160],
    const struct welink_voice_media_control *, float output[160]);
#endif
