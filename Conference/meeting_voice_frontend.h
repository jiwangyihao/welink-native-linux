#ifndef WELINK_VOICE_FRONTEND_H
#define WELINK_VOICE_FRONTEND_H

/* Pinned campus PNR cluster input, already gated/levelled, mono 16 kHz.
 * One call accepts 160 float samples. A non-NULL spectrum receives the 257
 * interleaved long-window complex bins. On the 100th call it returns 1 and `bands` holds a
 * complete [100][80] mean-normalized block; otherwise it returns 0. Use the
 * same output block until completion. History crosses blocks; reset by init.
 * This is not microphone acquisition, enrollment or a speaker-isolated track.
 */
enum { WELINK_PNR_HOP=160, WELINK_PNR_BINS=257, WELINK_PNR_BANDS=80, WELINK_PNR_FRAMES=100 };
struct welink_voice_frontend {
    float history[480];
    unsigned frame;
};
/* Analyze a 10 ms normalized microphone frame in signed-16 amplitude units.
 * Each capture owns a zero-initialized 30 ms history. No cluster bands here. */
void welink_voice_capture_spectrum(float history[480], const float pcm[160], float spectrum[514]);
void welink_voice_frontend_init(struct welink_voice_frontend *state);
int welink_voice_frontend_push(struct welink_voice_frontend *state,
    const float pcm[160], float spectrum[514], float bands[100][80]);
#endif
