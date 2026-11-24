#ifndef MEETING_VOICE_POOL_H
#define MEETING_VOICE_POOL_H
/* One cluster-encoder block after the 320 -> 128 projection and ReLU6.
 * Input [time=13][frequency=10][channel=128], output [channel=128][20]:
 * ten means followed by ten adjusted deviations. Buffers must not overlap.
 * Compile with binary32 evaluation and -ffp-contract=off, without fast math. */
void welink_voice_cluster_pool(const float frames[13][10][128], float stats[128][20]);
#endif
