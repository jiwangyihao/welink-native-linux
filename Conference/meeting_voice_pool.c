#include "meeting_voice_pool.h"
#include "meeting_voice_math.h"
#include <math.h>

void welink_voice_cluster_pool(const float frames[13][10][128], float stats[128][20]) {
    for (unsigned f=0;f<10;++f) {
        for (unsigned c=0;c<128;++c) {
            float sum=0.0f, squares=0.0f;
            for (unsigned t=0;t<13;++t) {
                float x=frames[t][f][c]; sum+=x; squares+=x*x;
            }
            float mean=sum/13.0f;
            float variance=fabsf(squares/13.0f-mean*mean);
            /* The model has thirteen frames but uses 50/49 here, not 13/12.
             * Multiplication first rounds to binary32; division is binary64. */
            stats[c][f]=mean;
            stats[c][10+f]=vqe_root((float)((double)(variance*50.0f)/49.0));
        }
    }
}
