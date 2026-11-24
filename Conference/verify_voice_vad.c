/* Offline regression. Build with meeting_voice_gate.c, -O2 -ffp-contract=off
 * -ffunction-sections -Wl,--gc-sections -lm -lcrypto. Pass vadModel.bin as argv[1].
 * Expected bytes come from the pinned 32-bit 10243900 numerical routine on
 * the integer-generated spectra below, not from another build of the port. */
#define OPENSSL_API_COMPAT 0x10100000L
#include "meeting_voice_gate.h"
#include <openssl/sha.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void spectrum(unsigned t, float bins[514]) {
    memset(bins,0,514*sizeof *bins);
    if(!((t>=8 && t<114) || (t>=192 && t<204))) return;
    for(unsigned h=1;h<39;++h) {
        int k=(4+(t/19)%3)*h, amp=(950000+((t*2377+h*899)%80000))/(1+h/3);
        if(k>=255) break;
        unsigned phase=(t+h)%4;
        for(int off=-1;off<=1;++off) {
            int v=amp*(off<0 ? 2 : (off ? 1 : 4));
            bins[2*(k+off)+(phase&1)]+=(float)(phase&2 ? -((v+3)/4) : v/4);
        }
    }
}
static int digest_matches(const unsigned char digest[32], const char *expected) {
    char hex[65];
    for(size_t i=0;i<32;++i) snprintf(hex+i*2,3,"%02x",digest[i]);
    if(!strcmp(hex,expected)) return 1;
    fprintf(stderr,"digest %s, expected %s\n",hex,expected); return 0;
}
int main(int argc,char **argv) {
    if(argc!=2) { fprintf(stderr,"usage: %s vadModel.bin\n",argv[0]); return 64; }
    FILE *fp=fopen(argv[1],"rb");
    if(!fp) { perror(argv[1]); return 66; }
    const size_t len=WELINK_VOICE_VAD_MODEL_BYTES;
    void *model=malloc(len);
    if(!model) return 71;
    if(fread(model,1,len,fp)!=len || fgetc(fp)!=EOF || ferror(fp)) return 65;
    fclose(fp);
    unsigned char digest[32]; SHA256(model,len,digest);
    if(!digest_matches(digest,"01b877db2f0966e19b925ee667044b9566cf21c6e1f24d49cadd238ecc7d1b2d")) return 65;
    struct welink_voice_vad a,b;
    if(welink_voice_vad_init(&a,model,len) || welink_voice_vad_init(&b,model,len)) return 1;
    const struct welink_voice_vad_route routes[]={
        {4,0,0,0,0},{3,0,0,0,0},{4,-1,0,0,0},{4,0,2,0,0},{4,0,0,1,0},{4,0,0,0,65536}
    };
    SHA256_CTX ctx; SHA256_Init(&ctx);
    for(unsigned t=0;t<216;++t) {
        float bins[514], other[514], mask[257]; spectrum(t,bins); memcpy(other,bins,sizeof bins);
        const struct welink_voice_vad_route *route=&routes[t%6];
        const int32_t keep=welink_voice_vad_spectrum(&a,bins,route,mask);
        const int keep_without_mask=welink_voice_vad_spectrum(&b,other,route,NULL);
        if(keep!=((t>=9 && t<171) || t>=192) || keep_without_mask!=keep || memcmp(bins,other,sizeof bins)) {
            fprintf(stderr,"frame %u: selection or optional-mask writeback differs\n",t); return 1;
        }
        SHA256_Update(&ctx,&keep,sizeof keep); SHA256_Update(&ctx,mask,sizeof mask); SHA256_Update(&ctx,bins,sizeof bins);
    }
    free(model); SHA256_Final(digest,&ctx);
    if(!digest_matches(digest,"487b1a653baaa20efe1b5679c2b4e915d3bc10be510b443aaaf3a1952289155e")) return 1;
    puts("216 frames: reference decisions, masks, and routed spectra match"); return 0;
}
