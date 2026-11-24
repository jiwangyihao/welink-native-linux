#include "meeting_voice_record_state.h"
#include <string.h>

/* Campus mmr_media.dll: the save operation gathers 53 distinct four-word
 * slots from three regions. Its inverse also initializes the shadow slots,
 * which need not agree with the primary slots before restoration. */
static const struct bank { unsigned first, stride, separation, rows, columns; } banks[] = {
    { 0x14b0c, 0, 0, 1, 1 },
    { 0x2200, 0xaa0, 0x38, 6, 2 },
    { 0x214b4, 0xac0, 0x28, 20, 2 }
};
enum { FIELD_OFFSET = 0x200, SLOT_BYTES = 16 };
_Static_assert(FIELD_OFFSET+(1+6*2+20*2)*SLOT_BYTES == 0x550, "PNR middle field extents");

int welink_pnr_save_middle(const void *state, size_t n, void *record, size_t bytes) {
    if (!state || !record || n < WELINK_PNR_STATE_BYTES_REQUIRED || bytes != WELINK_PNR_RECORD_BYTES) return -1;
    unsigned char *out=(unsigned char *)record+FIELD_OFFSET;
    for (unsigned b=0;b<sizeof banks/sizeof banks[0];++b) {
        const struct bank *bank=&banks[b];
        const unsigned char *base=(const unsigned char *)state+bank->first;
        for (unsigned row=0;row<bank->rows;++row) for (unsigned col=0;col<bank->columns;++col) {
            memcpy(out,base+row*bank->stride+col*bank->separation,SLOT_BYTES);
            out+=SLOT_BYTES;
        }
    }
    return 0;
}

int welink_pnr_restore_middle(const void *record, size_t bytes, void *state, size_t n) {
    if (!record || !state || bytes != WELINK_PNR_RECORD_BYTES || n < WELINK_PNR_STATE_BYTES_REQUIRED) return -1;
    const unsigned char *in=(const unsigned char *)record+FIELD_OFFSET;
    for (unsigned b=0;b<sizeof banks/sizeof banks[0];++b) {
        const struct bank *bank=&banks[b];
        unsigned char *base=(unsigned char *)state+bank->first;
        for (unsigned row=0;row<bank->rows;++row) for (unsigned col=0;col<bank->columns;++col) {
            unsigned char *slot=base+row*bank->stride+col*bank->separation;
            memcpy(slot,in,SLOT_BYTES);
            memcpy(slot+SLOT_BYTES,in,SLOT_BYTES);
            in+=SLOT_BYTES;
        }
    }
    return 0;
}
