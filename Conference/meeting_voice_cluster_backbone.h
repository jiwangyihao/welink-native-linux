#ifndef MEETING_VOICE_CLUSTER_BACKBONE_H
#define MEETING_VOICE_CLUSTER_BACKBONE_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
    WELINK_PNR_CLUSTER_V2_MODEL_BYTES = 2896332,
    WELINK_PNR_CLUSTER_INPUT_FRAMES = 100,
    WELINK_PNR_CLUSTER_INPUT_BINS = 80,
    WELINK_PNR_CLUSTER_INPUT_FLOATS = 8000,
    WELINK_PNR_CLUSTER_FIRST_FRAMES = 50,
    WELINK_PNR_CLUSTER_FIRST_BINS = 40,
    WELINK_PNR_CLUSTER_FIRST_CHANNELS = 32,
    WELINK_PNR_CLUSTER_FIRST_FLOATS = 64000
};

/* First convolution + bias + ReLU6 ONLY, not the complete cluster backbone.
 * This does not produce the 256 inputs to meeting_voice_cluster_head.c.
 *
 * Model: pnrClusterModel.bin, including its 00 00 00 02 prefix.
 * SHA-256: 41b53dec9271a94640313157db73bcab65e49bb07dd8e1bd9e85535cedcb500a
 * The caller authenticates that model; length/header checks are not a signature.
 * Keep the model readable and unchanged throughout the call.
 *
 * Input is one already mean-normalized float32 acoustic block, NOT PCM:
 *     features[time * 80 + frequency], time=0..99, frequency=0..79.
 * Output is the first layer's complete activation tensor:
 *     activation[(time * 40 + frequency) * 32 + channel],
 *     time=0..49, frequency=0..39, channel=0..31.
 *
 * Model byte 4 starts float32-LE weights [32][3 frequency][3 time];
 * byte 0x484 starts 32 float32-LE biases. A kernel is not reversed.
 * For output (t,f,c), multiply input (2*t+kt-1, 2*f+kf-1) by
 * weight[c][kf][kt], zero-padding outside the input. Match the pinned desktop
 * kernel's binary32 lane reduction, then add the ninth product and bias and
 * clip to [0,6]. This order is fixed even on a host without vector instructions.
 *
 * Compile without fast-math/reassociation and with -ffp-contract=off. The
 * numeric oracle uses IEEE round-to-nearest with FTZ/DAZ disabled. Input and
 * output must be naturally aligned float arrays and must not overlap each
 * other or the model. No allocation, persistent state, devices or I/O occur.
 *
 * Returns 0 on success, -1 for NULL or a wrong model length/prefix. On -1,
 * output is unchanged. Array extents and model authenticity are caller duties.
 */
int welink_pnr_cluster_first_conv_v2(
    const void *model, size_t bytes,
    const float features[WELINK_PNR_CLUSTER_INPUT_FLOATS],
    float activation[WELINK_PNR_CLUSTER_FIRST_FLOATS]);

#ifdef __cplusplus
}
#endif
#endif
