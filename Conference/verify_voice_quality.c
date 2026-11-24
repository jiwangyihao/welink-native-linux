/* Differential regression for enrollment frames: reference is the previous
 * selected channel, even when the previous frame was unvoiced. Build with
 * meeting_voice_gate.c, -O2 -ffp-contract=off -ffunction-sections
 * -Wl,--gc-sections -lm -lcrypto. No audio, SDK or account required. */
#define OPENSSL_API_COMPAT 0x10100000L
#include "meeting_voice_gate.h"
#include <openssl/sha.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    const unsigned counts[]={0,0,1,1,2,2,3,4,5,5,5,6,7,8};
    const unsigned char golden[32]={0xce,0x3f,0xe0,0x51,0x02,0x68,0xfc,0x8d,
        0x8a,0x0d,0x92,0x59,0x72,0x6d,0xbe,0x84,0xf6,0x82,0x45,0x24,
        0x57,0xbe,0x3f,0x85,0x81,0x78,0x7b,0xda,0x9d,0xb0,0x39,0x6d};
    struct welink_voice_quality quality={0}; float last[514]={0}, early[514], late[514];
    SHA256_CTX ctx; SHA256_Init(&ctx);
    for(int t=0;t<14;++t) {
        const int side=t%2, gain=(1+(t*11+side*5)%23)*900, selected=t!=1 && t!=5 && t!=10;
        for(int i=0;i<514;++i) {
            early[i]=(float)(gain*((i*(t+3+9*side)+7*side+3*t)%13-6));
            late[i]=t==3 || t==9 ? (float)(3*((i+t+side)%7)-9) : last[i]+(21+t*19)*((i*7+t)%3-1);
        }
        if(welink_voice_quality_push(&quality,early,selected?late:NULL,selected) || quality.frames!=counts[t]) {
            fprintf(stderr,"frame %d: quality update failed or counted the wrong frame\n",t); return 1;
        }
        const float row[]={quality.low,quality.middle,quality.high,quality.reduction_sum,quality.reduction_mean};
        const uint32_t n=quality.frames; SHA256_Update(&ctx,row,sizeof row); SHA256_Update(&ctx,&n,sizeof n);
        memcpy(last,early,sizeof last);
    }
    unsigned char digest[32]; SHA256_Final(digest,&ctx);
    if(memcmp(digest,golden,sizeof digest) || welink_voice_quality_result(&quality)!=WELINK_VOICE_BAD_SPECTRAL_QUALITY) {
        fputs("delayed-reference quality gate differs from the pinned numerical reference\n",stderr); return 1;
    }
    puts("14 frames: previous-channel capture, spectral statistics and rejection match"); return 0;
}
