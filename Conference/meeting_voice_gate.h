#ifndef MEETING_VOICE_GATE_H
#define MEETING_VOICE_GATE_H
#include <stddef.h>

/* Recovered numerical subroutines only. These APIs do not certify that raw
 * microphone PCM passed the original first-pass media pipeline. In particular,
 * the reference/processed spectra below MUST be its actual delayed spectra;
 * substituting the cluster frontend or the raw input makes a different gate. */
enum {
    WELINK_VOICE_MIN_QUALIFIED = 80000,
    WELINK_VOICE_MAX_SAMPLES = 160000,
    WELINK_VOICE_CALIBRATION_FRAMES = 1000,
    WELINK_VOICE_VAD_MODEL_BYTES = 1453576
};
enum welink_voice_rejection {
    WELINK_VOICE_NO_REJECTION = 0,
    WELINK_VOICE_INVALID_PCM = -1,
    WELINK_VOICE_TOO_SHORT = -2,
    WELINK_VOICE_TOO_QUIET = -3,
    WELINK_VOICE_CONSTANT_PCM = -4,
    WELINK_VOICE_BAD_SPECTRAL_QUALITY = -5,
    WELINK_VOICE_BAD_REDUCTION = -6,
    WELINK_VOICE_BAD_SUPPRESSION = -7
};
/* Necessary rejection checks, NOT an acceptance classifier. A return of zero
 * still requires all original first-pass qualification and calibration. */
int welink_voice_input_rejection(const float *pcm, size_t samples);
/* Original post-selection level gate and gain adjustment. Input is already
 * selected normalized PCM, in complete 160-sample frames. Changes input only
 * after validation; original_rms is the PRE-gain calibration amplitude basis. */
int welink_voice_qualified_level(float *qualified, size_t samples, float *original_rms);
/* Calls the existing cluster model only after qualified-level preparation.
 * Output is explicitly two fields, NOT a 2384-byte public enrollment record. */
int welink_voice_qualified_fields(const void *cluster_model, size_t model_bytes,
    float *qualified, size_t samples, float *work, size_t work_floats,
    float head[128], float direction[256], float *original_rms);

struct welink_voice_quality {
    float low, middle, high, reduction_sum, reduction_mean;
    unsigned frames;
    float previous[2*(256-3)]; /* Only bins 3..255 contribute to residual dB. */
};
/* Zero-initialize at enrollment start. Push every frame, including unvoiced
 * frames. captured is the selected channel at 101fefdb, before subsequent
 * processing; processed is its final spectrum at 101ff343. The reducer uses
 * the PREVIOUS capture (outer+0xa0d84), even across a channel change.
 * processed may be NULL only when selected == 0. */
int welink_voice_quality_push(struct welink_voice_quality *, const float captured[514],
                             const float processed[514], int selected);
int welink_voice_quality_result(const struct welink_voice_quality *);
struct welink_voice_suppression { unsigned frames; float reduction_sum; };
/* Original second pass compares output with input from TWO frames earlier.
 * Caller supplies that alignment and skips the first two outputs. */
int welink_voice_suppression_push(struct welink_voice_suppression *,
                                 const float delayed_input[160], const float output[160]);
int welink_voice_suppression_result(const struct welink_voice_suppression *);
int welink_voice_calibration_frame(float original_rms, unsigned frame_index, float output[160]);

/* Pinned vadModel.bin v1, SHA-256:
 * 01b877db2f0966e19b925ee667044b9566cf21c6e1f24d49cadd238ecc7d1b2d.
 * Authenticate before init. These are the 10243f00/10243900 scalar model and
 * hangover boundaries, not a replacement for their upstream spectral producer.
 * Windows and Linux libm tanh may differ at rounding boundaries; numerical
 * parity must be checked independently before exposing public enrollment. */
struct welink_voice_vad_layer {
    const float *input_weights, *recurrent_weights, *input_bias, *recurrent_bias;
    float cell[128], hidden[128];
};
struct welink_voice_vad {
    struct welink_voice_vad_layer layers[2];
    const float *weights, *bias;
    unsigned active_history, active_run, inactive_run, initialized, failed;
};
int welink_voice_vad_init(struct welink_voice_vad *, const void *model, size_t bytes);
/* Inputs to the writeback decision in 10243900. Field offsets distinguish
 * the channel from the outer media state; none is inferred from audio. */
struct welink_voice_vad_route {
    int channel_mode, channel_2e0e, outer_110b92, channel_2e42, channel_2e4c;
};
/* Input is the upstream complex spectrum, not PCM or cluster-model bands.
 * Returns 0/1 hangover selection, or -1. Only the original mode-4 writeback
 * route changes spectrum. Optional mask receives 257 gains and must not
 * overlap spectrum. A failed frame never writes back to spectrum. */
int welink_voice_vad_spectrum(struct welink_voice_vad *, float spectrum[514],
    const struct welink_voice_vad_route *, float mask[257]);
#endif
