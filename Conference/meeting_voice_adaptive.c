#include "meeting_voice_adaptive.h"
#include "meeting_voice_math.h"

_Static_assert(sizeof(struct welink_voice_lane)==16, "PNR lane record size");

enum { IDLE_LIMIT=800, WEIGHT_LIMIT=6000 };

static void update_lane(struct welink_voice_lane *s, float frame_mean, float second_moment) {
    float prior=s->mean;
    if (s->weight>0.0f) {
        float limit=3.4e19f/s->weight;
        if (limit<prior) prior=limit;
    }
    float weight=s->weight<WEIGHT_LIMIT ? s->weight : WEIGHT_LIMIT;
    float next_weight=weight+1.0f;
    float mean=(weight*prior+frame_mean)/next_weight;
    float second=((prior*prior+s->variance)*weight+second_moment)/next_weight;
    s->mean=mean;
    s->variance=second-mean*mean;
    s->weight=next_weight;
}

void welink_voice_adapt_frame(struct welink_voice_adaptive *state,
                             float *features, size_t n, const float *scale,
                             const float *bias, float activity,
                             int learn_after_idle, int frozen) {
    struct welink_voice_lane *p=&state->primary, *s=&state->secondary;
    p->idle=activity>=1.0f ? 0.0f : p->idle+1.0f;
    s->idle=activity>=5.0f ? 0.0f : s->idle+1.0f;
    if (!frozen && (activity>=1.0f || p->idle<IDLE_LIMIT || learn_after_idle>0)) {
        float sum=0.0f, squares=0.0f;
        for (size_t i=0;i<n;++i) {
            float x=features[i];
            sum+=x;
            squares+=x*x;
        }
        float mean=sum/(float)n, second=squares/(float)n;
        update_lane(p,mean,second);
        if (activity>=5.0f || s->idle<IDLE_LIMIT) update_lane(s,mean,second);
    }
    float mean=p->mean, var=p->variance;
    if (s->weight>=IDLE_LIMIT) {
        mean=(mean+s->mean)*0.5f;
        var=(var+s->variance)*0.5f;
    }
    float inv=1.0f/vqe_root(var+1.0e-6f);
    for (size_t i=0;i<n;++i) features[i]=((features[i]-mean)*inv)*scale[i]+bias[i];
}
