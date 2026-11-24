#ifndef MEETING_VOICE_ADAPTIVE_H
#define MEETING_VOICE_ADAPTIVE_H
#include <stddef.h>

/* One layer has independent primary and secondary statistics. The enrollment
 * record saves the primary four floats and restores them into both lanes. */
struct welink_voice_lane { float mean, variance, weight, idle; };
struct welink_voice_adaptive { struct welink_voice_lane primary, secondary; };

/* features is modified in place; scale and bias are the layer parameters.
 * n is the nonzero feature width of the layer. The control inputs correspond
 * to the current activity and the two engine gates, not user consent. */
void welink_voice_adapt_frame(struct welink_voice_adaptive *state,
                             float *features, size_t n, const float *scale,
                             const float *bias, float activity,
                             int learn_after_idle, int frozen);
#endif
