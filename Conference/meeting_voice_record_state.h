#ifndef MEETING_VOICE_RECORD_STATE_H
#define MEETING_VOICE_RECORD_STATE_H
#include <stddef.h>
/* Middle field of the campus 2384-byte PNR enrollment record, not a generator
 * of learned state. Slots are opaque bit patterns, not inferred float values.
 * state uses the pinned native PNR state layout. Buffers must not overlap.
 * Only the middle field is saved; restore updates both copies in the engine.
 * On invalid extents neither routine writes to the destination. */
enum { WELINK_PNR_RECORD_BYTES = 0x950, WELINK_PNR_STATE_BYTES_REQUIRED = 0x214b4 + 19*0xac0 + 0x28 + 32 };
int welink_pnr_save_middle(const void *state, size_t state_bytes, void *record, size_t record_bytes);
int welink_pnr_restore_middle(const void *record, size_t record_bytes, void *state, size_t state_bytes);
#endif
