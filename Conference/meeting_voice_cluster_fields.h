#ifndef MEETING_VOICE_CLUSTER_FIELDS_H
#define MEETING_VOICE_CLUSTER_FIELDS_H
#include <stddef.h>

/* Field producer inside the original enrollment operation, not the public
 * enrollment operation. Input: mono 16 kHz float PCM AFTER the outer quality
 * gate and level adjustment. Ignores a final partial second, uses at most ten
 * full seconds. The outer recorder, unlike this subroutine, also rejects short
 * or unsuitable speech. Authenticate the model before calling. Buffers must
 * not overlap. Workspace units are floats and can be reused on every call.
 * Returns blocks used (1..10), or -1 before publishing any output fields.
 * Record byte offsets: mean128 at 0, direction_sum256 at 0x550. The intervening
 * 0x350 bytes are produced separately; do not fill them with invented values.
 */
size_t welink_voice_cluster_fields_work_floats(void);
int welink_voice_cluster_fields_v2(const void *model, size_t bytes,
    const float *prepared, size_t samples, float *work, size_t work_floats,
    float mean128[128], float direction_sum256[256]);
#endif
