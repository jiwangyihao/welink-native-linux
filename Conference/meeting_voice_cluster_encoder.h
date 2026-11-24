#ifndef MEETING_VOICE_CLUSTER_ENCODER_H
#define MEETING_VOICE_CLUSTER_ENCODER_H
#include <stddef.h>
/* Pinned campus v2 cluster encoder. The caller authenticates the model, owns
 * and reuses aligned float workspace, and must not overlap input or output.
 * One block = 100 mean-normalized frames x 80 bands. Output is the 256-value
 * input to the existing projection head, not the complete enrollment record.
 * preceding_blocks counts complete blocks since this enrollment began (zero
 * for an independent block). It preserves the original summation order. */
size_t welink_voice_cluster_work_floats(void);
int welink_voice_cluster_encode_v2(const void *model, size_t bytes,
    const float features[8000], unsigned preceding_blocks,
    float *work, size_t work_floats, float encoded[256]);
#endif
