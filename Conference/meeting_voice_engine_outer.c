#include "meeting_voice_engine_outer.h"
#include "meeting_voice_math.h"
#include <math.h>
#include <string.h>

_Static_assert(WELINK_VOICE_FILTERED_HISTORY_HOPS*WELINK_VOICE_PROJECTION_HOP == 3*WELINK_VOICE_FRAME,
               "the oldest frame after projection is two frames behind the current one");

static void reset_wrapper(struct welink_voice_engine_outer *s) {
    memset(s->activity_history,0,sizeof s->activity_history);
    s->activity=0.0f; s->output_ratio_db=0.0f; s->residual_ratio_db=0.0f;
    s->smoothed_db=0.0f; s->gain=1.0f;
    s->activity_next=0; s->freeze_hangover=0;
}
static int fail(struct welink_voice_engine_outer *s, float *output) {
    if(s) { s->core.failed=1; s->core.fields_bound=0; }
    if(output) memset(output,0,160*sizeof *output);
    return -1;
}
int welink_voice_engine_outer_init(struct welink_voice_engine_outer *s, const void *model, size_t bytes) {
    if(!s) return -1;
    reset_wrapper(s);
    return welink_voice_engine_init(&s->core,model,bytes);
}
int welink_voice_engine_outer_restore(struct welink_voice_engine_outer *s, const void *record, size_t bytes) {
    if(!s) return -1;
    reset_wrapper(s);
    return welink_voice_engine_restore(&s->core,record,bytes);
}
int welink_voice_engine_outer_frame(struct welink_voice_engine_outer *s, const float input[160],
    const struct welink_voice_media_control *media, float output[160]) {
    if(!s || !input || !output || !media || !isfinite(media->before_db) ||
       !isfinite(media->after_db)) return fail(s,output);
    const float difference=media->before_db-media->after_db;
    if(!isfinite(difference)) return fail(s,output);
    if(difference>20.0f) s->freeze_hangover=10;
    else if(s->freeze_hangover) --s->freeze_hangover;
    const struct welink_voice_control control={s->activity,media->learn_after_idle,
                                               media->freeze_source==1 && s->freeze_hangover>0};
    if(welink_voice_engine_frame(&s->core,input,&control,output)<0) return fail(s,output);

    /* Compare unattenuated output with the high-pass input from two frames
     * earlier, not the raw PCM. Projection has already written the current
     * frame, so its next slot starts the delayed reference. */
    const struct welink_voice_projection *projection=&s->core.projection;
    unsigned slot=projection->next;
    float input_power=0.0f, output_power=0.0f, error_power=0.0f;
    for(unsigned i=0;i<WELINK_VOICE_FRAME;i+=WELINK_VOICE_PROJECTION_HOP) {
        const float *reference=projection->filtered[slot];
        for(unsigned j=0;j<WELINK_VOICE_PROJECTION_HOP;++j) {
            const float x=reference[j], y=output[i+j], residual=x-y;
            input_power+=x*x; output_power+=y*y; error_power+=residual*residual;
        }
        if(++slot==WELINK_VOICE_FILTERED_HISTORY_HOPS) slot=0;
    }
    const float epsilon=as_float(UINT32_C(0x322bcc77));
    input_power+=epsilon; output_power+=epsilon; error_power+=epsilon;
    const float ratio=output_power/input_power, residual_ratio=input_power/error_power;
    if(!isfinite(ratio) || !isfinite(residual_ratio) || ratio<=0.0f || residual_ratio<=0.0f)
        return fail(s,output);
    const float output_db=(float)(10.0*log10((double)ratio));
    const float residual_db=(float)(10.0*log10((double)residual_ratio));
    if(!isfinite(output_db) || !isfinite(residual_db)) return fail(s,output);
    s->output_ratio_db=output_db; s->residual_ratio_db=residual_db;
    s->activity_history[s->activity_next]=residual_db;
    if(++s->activity_next==300) s->activity_next=0;
    /* Circular storage avoids a 299-float move while retaining the original
     * chronological sum (a running sum would accumulate different rounding). */
    float sum=0.0f;
    for(unsigned i=s->activity_next;i<300;++i) sum+=s->activity_history[i];
    for(unsigned i=0;i<s->activity_next;++i) sum+=s->activity_history[i];
    s->activity=sum/300.0f;
    if(output_db>s->smoothed_db && output_db>-12.0f) s->smoothed_db=output_db+s->smoothed_db*0.0f;
    else s->smoothed_db=s->smoothed_db*as_float(UINT32_C(0x3f6b851f))+
                        output_db*as_float(UINT32_C(0x3da3d70a));
    float gain_db;
    if(s->smoothed_db < -18.0f) gain_db=-30.0f;
    else if(s->smoothed_db < -10.0f) gain_db=s->smoothed_db*3.75f-(-30.0f);
    else gain_db=0.0f;
    const float exponent=gain_db/20.0f;
    s->gain=(float)pow(10.0,(double)exponent);
    if(!isfinite(s->activity) || !isfinite(s->gain)) return fail(s,output);
    for(unsigned i=0;i<160;++i) output[i]*=s->gain;
    return 160;
}
