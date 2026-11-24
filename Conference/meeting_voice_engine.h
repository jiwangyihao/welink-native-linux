#ifndef MEETING_VOICE_ENGINE_H
#define MEETING_VOICE_ENGINE_H
#include "meeting_voice_projection.h"
#include "meeting_voice_bottleneck.h"
#include "meeting_voice_upsample.h"
#include "meeting_voice_synthesis.h"
#include "meeting_voice_record_state.h"

/* Numerical PNR boundary, not the public recorder or its VAD/quality pipeline.
 * Authenticate the immutable model before init and keep it alive throughout.
 * Every stream owns a separate state. No allocation or I/O occurs here.
 * Compile for binary32 SSE2, without fast-math or floating-point contraction. */
enum { WELINK_VOICE_FRAME = 160, WELINK_VOICE_RECORD_SLOTS = 53 };
struct welink_voice_control {
    float activity;
    int learn_after_idle, frozen;
};
struct welink_voice_engine {
    struct welink_voice_projection projection;
    struct welink_voice_downsample downsample;
    struct welink_voice_bottleneck bottleneck;
    struct welink_voice_upsample upsample;
    struct welink_voice_synthesis synthesis;
    const void *model;
    float head[128], direction[256];
    unsigned initialized, fields_bound, started, failed;
};
int welink_voice_engine_init(struct welink_voice_engine *, const void *model, size_t bytes);
/* Bind actual cluster fields, or independent synthetic fields for numerical
 * interop. This is NOT acceptance of an enrollment; no record is produced. */
int welink_voice_engine_fields(struct welink_voice_engine *, const float head[128],
                               const float direction[256]);
/* Checks the entire LE record, including all 53 learned lanes. It does not
 * authenticate a speaker, consent, record provenance, or the outer quality gate. */
int welink_voice_record_validate(const void *record, size_t bytes);
/* Resets temporal state and restores every primary AND shadow lane. On error
 * the engine is invalidated. Call init to recover; never continue an old stream. */
int welink_voice_engine_restore(struct welink_voice_engine *, const void *record, size_t bytes);
/* Exactly the original 20-sample scheduling boundary. Returns 0 (no output),
 * 160 (complete output), or -1 (fatal; output is zeroed and state invalidated).
 * Controls must come from the original upstream producer, never an inferred
 * timer/energy gate. Buffers must not overlap. */
int welink_voice_engine_hop(struct welink_voice_engine *, const float input[20],
                            const struct welink_voice_control *, float output[160]);
/* Eight hops, with zero output during startup latency. Returns 160 on success
 * (including startup silence), or -1. No error ever returns input unchanged. */
int welink_voice_engine_frame(struct welink_voice_engine *, const float input[160],
                              const struct welink_voice_control *, float output[160]);
/* Numerical snapshot in record order: projection, down[3][2], up[3][2],
 * bottleneck[20][2]. Initial/default lanes may be inspected in fixtures but
 * are deliberately not serialized as an enrollment record by this API. */
int welink_voice_engine_snapshot(const struct welink_voice_engine *,
                                 struct welink_voice_lane lanes[53]);
#endif
