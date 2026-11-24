#ifndef MEETING_VOICE_QUANT_H
#define MEETING_VOICE_QUANT_H
#include <stdint.h>

/* One channel-mixing projection in the pinned v2 campus PNR cluster model.
 * Internal API: the caller authenticates the complete model and supplies the
 * exact descriptor offset and dimensions from its fixed layout. No file I/O. */
typedef struct {
    unsigned inputs, outputs;
    float input_scale, input_zero, output_scale;
    const unsigned char *weights, *biases;
} welink_voice_qmap;

/* Returns the first byte after this descriptor. Bind once per model/layer. */
const unsigned char *welink_voice_qbind(welink_voice_qmap *map,
    const unsigned char *descriptor, unsigned inputs, unsigned outputs);
/* A single frequency/time position. scratch contains inputs bytes. */
void welink_voice_qapply(const welink_voice_qmap *map, const float *input,
                         float *output, unsigned char *scratch);
#endif
