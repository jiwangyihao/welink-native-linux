#include "meeting_voice_frontend.h"
#include <math.h>
#include <string.h>
#include "meeting_voice_frontend_tables.inc"
#include "meeting_voice_fft16.inc"

/* Pack even/odd real samples into 256 complex inputs. The pinned frontend
 * runs two 16-point FFT passes, then separates conjugate pairs. Preserve the
 * float roundings: small differences can cross an int8 quantization boundary. */
static void transform(const float *input, const float *window, unsigned count, float bins[514]) {
    float columns[16][32], x[32], y[32];
    for (unsigned j=0;j<16;++j) {
        for (unsigned t=0;t<16;++t) {
            unsigned i=2*(j+16*t);
            x[2*t]=i<count ? input[i]*window[i] : 0.0f;
            x[2*t+1]=i<count ? input[i+1]*window[i+1] : 0.0f;
        }
        voice_fft16(columns[j],x);
    }
    for (unsigned k=0;k<16;++k) {
        x[0]=columns[0][2*k]; x[1]=columns[0][2*k+1];
        for (unsigned j=1;j<16;++j) {
            const float *w=fft_twiddle[(j-1)*16+k];
            float r=columns[j][2*k], i=columns[j][2*k+1];
            x[2*j]=w[0]*r-w[1]*i;
            x[2*j+1]=w[0]*i+w[1]*r;
        }
        voice_fft16(y,x);
        for (unsigned j=0;j<16;++j) {
            unsigned idx=2*(k+16*j); bins[idx]=y[2*j]; bins[idx+1]=y[2*j+1];
        }
    }
    float r0=bins[0], i0=bins[1];
    bins[0]=i0+r0; bins[512]=r0-i0; bins[1]=bins[513]=0.0f;
    for (unsigned k=1;k<=128;++k) {
        unsigned a=2*k,b=2*(256-k);
        float ar=bins[a], ai=bins[a+1], br=bins[b], bi=bins[b+1];
        float plus=br+ar, minus=br-ar, imagdiff=(-bi)+ai, imagsum=ai-(-bi);
        const float *w=split_twiddle[k-1];
        float u=imagsum*w[0]-minus*w[1], v=w[0]*minus+imagsum*w[1];
        bins[a]=(u+plus)*0.5f; bins[a+1]=(v+imagdiff)*0.5f;
        bins[b]=(plus-u)*0.5f; bins[b+1]=(v-imagdiff)*0.5f;
    }
}

void welink_voice_capture_spectrum(float history[480], const float pcm[160], float spectrum[514]) {
    memmove(history,history+160,320*sizeof(float));
    for(unsigned i=0;i<160;++i) history[320+i]=pcm[i]*32768.0f;
    transform(history,window480,480,spectrum);
}

void welink_voice_frontend_init(struct welink_voice_frontend *state) {
    memset(state,0,sizeof(*state));
}

int welink_voice_frontend_push(struct welink_voice_frontend *state,
    const float pcm[160], float spectrum[514], float bands[100][80]) {
    float bins[514];
    memmove(state->history,state->history+160,320*sizeof(float));
    memcpy(state->history+320,pcm,160*sizeof(float));
    if (spectrum) transform(state->history,window480,480,spectrum);
    transform(state->history+80,window400,400,bins);
    for (unsigned k=1;k<256;++k) {
        float r=bins[2*k], i=bins[2*k+1]; bins[k]=r*r+i*i;
    }
    const float *weight=taps;
    for (unsigned b=0;b<80;++b) {
        const float *power=bins+first_bin[b]; float sum=0.0f;
        for(unsigned j=0;j<band_width[b];++j) sum+=*weight++ * power[j];
        bands[state->frame][b]=(float)log((double)sum+1e-6);
    }
    if (++state->frame<100) return 0;
    float mean[80]={0};
    for(unsigned t=0;t<100;++t) for(unsigned b=0;b<80;++b) mean[b]+=bands[t][b];
    for(unsigned b=0;b<80;++b) mean[b]/=100.0f;
    for(unsigned t=0;t<100;++t) for(unsigned b=0;b<80;++b) bands[t][b]-=mean[b];
    state->frame=0;
    return 1;
}
