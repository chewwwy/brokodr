/*
 * Bro.Kodr DSP core — BROBEATS drum voice. C port of dsp/core/drum-voice.js.
 * See drum-voice.h for what differs from the JS and why.
 */

#include "brokodr/dsp/drum-voice.h"

#include <math.h>

/* Choke fade, in ms. Long enough not to click, short enough to read as
   instant. Module-private in the JS too. */
#define BK_DRUM_CHOKE_MS 4.0

/*
 * Math.round, which is not round() and not rint(): it rounds half AWAY from
 * zero for positives (0.5 -> 1) where rint() under the default rounding mode
 * rounds half to even (0.5 -> 0). Both call sites here take non-negative
 * values, so floor(x + 0.5) is the whole story; it is spelled out rather than
 * reached for out of habit because the difference is a one-frame hold error
 * that only shows on exact halves.
 */
static double js_round(double x) { return floor(x + 0.5); }

/*
 * JS `x || 0`, for the linear-interpolation edge case. Anything falsy becomes
 * +0, which for a Float32Array read means NaN -> 0 and -0 -> +0. The NaN case
 * is the one that matters: a sample store that handed the voice a NaN would
 * otherwise poison the whole block through the resampler.
 */
static double js_or_zero(double x) { return (x == 0.0 || isnan(x)) ? 0.0 : x; }

static void recalc_env(bk_drum_voice *v) {
  const double sr = v->sr;
  /*
   * The `<= 0` arm is redundant and is kept because the JS has it: with the
   * floor below, max(1, 0) is 1 and 1/1 is 1, which is exactly what the arm
   * returns, and set_param clamps attack_ms to >= 0 so no negative ever
   * reaches here either. The floor is the part that does the work — without
   * it a sub-millisecond attack gives an increment above 1. Mutation testing
   * finds the arm's test unkillable for that reason; that is an equivalent
   * mutant, not a hole in the battery.
   */
  v->attack_inc = v->attack_ms <= 0.0 ? 1.0 : 1.0 / bk_max(1.0, (v->attack_ms * sr) / 1000.0);
  /* Exponential decay/release as a per-sample coefficient. The 5x factor makes
     the stated time read as "time to effectively silent" rather than one tau,
     which is what a musician expects a decay knob to mean. */
  v->decay_coef = exp(-5.0 / bk_max(1.0, (v->decay_ms * sr) / 1000.0));
  v->release_coef = exp(-5.0 / bk_max(1.0, (v->release_ms * sr) / 1000.0));
}

void bk_drum_voice_init(bk_drum_voice *v, double sample_rate, int max_block) {
  int i;

  v->sr = sample_rate;
  v->max_block = max_block;

  for (i = 0; i < BK_DRUM_MAX_LAYERS; i++) {
    v->layers[i].data = NULL;
    v->layers[i].frames = 0;
    v->layers[i].rate = sample_rate;
  }
  v->layer_count = 0;
  v->next_layer = 0;

  v->attack_ms = 0.5;
  v->decay_ms = 400.0;
  v->sustain = 1.0;
  v->release_ms = 60.0;
  v->hold_ms = 0.0;
  v->pitch = 0.0;
  v->start_offset = 0.0;
  v->reverse = 0;
  v->gain = 1.0;
  v->pan = 0.0;
  v->mode = BK_TRIGGER_ONESHOT;
  v->vel_amount = 0.7;
  v->choke_group = 0;
  v->muted = 0;

  v->active = 0;
  v->layer = 0;
  v->pos = 0.0;
  v->step = 1.0;
  v->vel_gain = 1.0;

  v->stage = BK_DRUM_ENV_IDLE;
  v->env = 0.0;
  v->attack_inc = 0.0;
  v->decay_coef = 0.0;
  v->release_coef = 0.0;
  v->hold_left = 0;
  v->choking = 0;
  v->choke_inc = 1.0 / bk_max(1.0, (BK_DRUM_CHOKE_MS * sample_rate) / 1000.0);

  /* Pan is smoothed so dragging the control never zips. 0.7071 is centre under
     the constant-power law. */
  bk_smoother_init(&v->pan_l, sample_rate, 15.0, 0.7071);
  bk_smoother_init(&v->pan_r, sample_rate, 15.0, 0.7071);

  v->meter = 0.0;

  recalc_env(v);
}

void bk_drum_voice_set_buffer(bk_drum_voice *v, int layer_index, const float *data, int frames,
                              double src_rate) {
  const int i = (int)bk_clamp((double)layer_index, 0.0, (double)(BK_DRUM_MAX_LAYERS - 1));
  bk_drum_layer *layer = &v->layers[i];
  int n = 0;
  int k;

  layer->data = data;
  layer->frames = data ? frames : 0;
  /* `srcRate || this.sr`: a zero or missing rate falls back to the engine's,
     which is what a buffer recorded in-app arrives with. */
  layer->rate = src_rate != 0.0 && !isnan(src_rate) ? src_rate : v->sr;

  /* layerCount is the highest occupied layer plus one, not a population count:
     a sample in layer 3 alone makes the round robin four long, holes included.
     That is the JS behaviour and the UI relies on it. */
  for (k = 0; k < BK_DRUM_MAX_LAYERS; k++) {
    if (v->layers[k].data && v->layers[k].frames > 0) n = k + 1;
  }
  v->layer_count = n;
  if (v->next_layer >= n) v->next_layer = 0;
}

void bk_drum_voice_clear_buffers(bk_drum_voice *v) {
  int i;
  for (i = 0; i < BK_DRUM_MAX_LAYERS; i++) {
    v->layers[i].data = NULL;
    v->layers[i].frames = 0;
  }
  v->layer_count = 0;
  v->next_layer = 0;
  v->active = 0;
  v->stage = BK_DRUM_ENV_IDLE;
  v->env = 0.0;
}

void bk_drum_voice_set_param(bk_drum_voice *v, int key, double value) {
  switch (key) {
    case BK_PAD_P_ATTACK:
      v->attack_ms = bk_clamp(value, 0.0, 2000.0);
      recalc_env(v);
      break;
    case BK_PAD_P_DECAY:
      v->decay_ms = bk_clamp(value, 1.0, 8000.0);
      recalc_env(v);
      break;
    case BK_PAD_P_SUSTAIN:
      v->sustain = bk_clamp(value, 0.0, 1.0);
      break;
    case BK_PAD_P_RELEASE:
      v->release_ms = bk_clamp(value, 1.0, 8000.0);
      recalc_env(v);
      break;
    case BK_PAD_P_HOLD:
      v->hold_ms = bk_clamp(value, 0.0, 8000.0);
      break;
    case BK_PAD_P_PITCH:
      v->pitch = bk_clamp(value, -36.0, 36.0);
      break;
    case BK_PAD_P_START:
      v->start_offset = bk_clamp(value, 0.0, 0.99);
      break;
    case BK_PAD_P_REVERSE:
      v->reverse = value >= 0.5;
      break;
    case BK_PAD_P_GAIN:
      v->gain = bk_db_to_gain(bk_clamp(value, -60.0, 12.0));
      break;
    case BK_PAD_P_PAN: {
      /* Constant-power law, so panning a kick off-centre does not make it
         quieter. */
      const double p = bk_clamp(value, -1.0, 1.0);
      const double a = ((p + 1.0) * BK_PI) / 4.0;
      v->pan = p;
      bk_smoother_set(&v->pan_l, cos(a));
      bk_smoother_set(&v->pan_r, sin(a));
      break;
    }
    case BK_PAD_P_MODE:
      v->mode = value >= 0.5 ? BK_TRIGGER_ONESHOT : BK_TRIGGER_GATE;
      break;
    case BK_PAD_P_VEL_AMOUNT:
      v->vel_amount = bk_clamp(value, 0.0, 1.0);
      break;
    case BK_PAD_P_CHOKE:
      v->choke_group = (int)js_round(bk_clamp(value, 0.0, 8.0));
      break;
    case BK_PAD_P_MUTE:
      v->muted = value >= 0.5;
      break;
    default:
      /* The JS switch has no default; an unknown wire key is ignored. */
      break;
  }
}

void bk_drum_voice_trigger(bk_drum_voice *v, double velocity) {
  const bk_drum_layer *layer;
  double ratio, start_frame, vel;

  if (v->layer_count == 0) return;

  v->layer = v->next_layer;
  v->next_layer = (v->next_layer + 1) % v->layer_count;

  layer = &v->layers[v->layer];
  ratio = bk_semitones_to_ratio(v->pitch) * (layer->rate / v->sr);
  v->step = ratio;

  start_frame = v->start_offset * (double)(layer->frames - 1);
  v->pos = v->reverse ? (double)(layer->frames - 1) - start_frame : start_frame;

  /* A hit that starts from silence starts AT its pan position — smoothing only
     exists to stop a knob move zipping mid-note. Without this, panning a pad
     hard left and hitting it immediately still leaks ~15ms of the old position
     into the right. */
  if (!v->active) {
    bk_smoother_reset(&v->pan_l, v->pan_l.target);
    bk_smoother_reset(&v->pan_r, v->pan_r.target);
  }

  vel = bk_clamp(velocity, 0.0, 1.0);
  /* velAmount 0 = every hit full level; 1 = velocity fully in charge. */
  v->vel_gain = 1.0 - v->vel_amount + v->vel_amount * vel * vel;

  v->stage = BK_DRUM_ENV_ATTACK;
  if (v->attack_ms <= 0.0) {
    v->env = 1.0;
    v->stage = BK_DRUM_ENV_DECAY;
  }
  v->hold_left = v->hold_ms > 0.0 ? (int)js_round((v->hold_ms * v->sr) / 1000.0) : -1;
  v->choking = 0;
  v->active = 1;
}

void bk_drum_voice_release(bk_drum_voice *v) {
  if (!v->active) return;
  if (v->mode == BK_TRIGGER_GATE && v->stage != BK_DRUM_ENV_IDLE) v->stage = BK_DRUM_ENV_RELEASE;
}

void bk_drum_voice_choke(bk_drum_voice *v) {
  if (v->active) v->choking = 1;
}

void bk_drum_voice_reset(bk_drum_voice *v) {
  v->active = 0;
  v->stage = BK_DRUM_ENV_IDLE;
  v->env = 0.0;
  v->pos = 0.0;
  v->choking = 0;
  v->meter = 0.0;
  /* reset(value), not reset(target): a reset parks the pan where it currently
     sits rather than where it was heading. */
  bk_smoother_reset(&v->pan_l, v->pan_l.value);
  bk_smoother_reset(&v->pan_r, v->pan_r.value);
}

void bk_drum_voice_process(bk_drum_voice *v, float *l, float *r, size_t frames) {
  const bk_drum_layer *buf;
  const float *data;
  int n;
  double step, g, sustain, pos, env, peak;
  int stage, hold;
  size_t i;

  if (!v->active || v->muted) {
    v->meter = 0.0;
    /* Keep the pan smoother moving so it is settled by the next hit. */
    for (i = 0; i < frames; i++) {
      bk_smoother_next(&v->pan_l);
      bk_smoother_next(&v->pan_r);
    }
    return;
  }

  buf = &v->layers[v->layer];
  data = buf->data;
  n = buf->frames;
  if (!data || n <= 0) {
    /* Note what this does NOT do: the smoothers stand still. A voice whose
       sample was pulled out from under it goes idle mid-block, and the JS
       leaves the pan where it was. */
    v->active = 0;
    v->meter = 0.0;
    return;
  }

  step = v->reverse ? -v->step : v->step;
  g = v->gain * v->vel_gain;
  sustain = v->sustain;
  pos = v->pos;
  env = v->env;
  stage = v->stage;
  hold = v->hold_left;
  peak = 0.0;

  for (i = 0; i < frames; i++) {
    int idx;
    double frac, s, out, a;

    /* --- ran off either end of the sample -------------------------------- */
    /* The outer band is the JS's shape and is only a cheap gate: the inner
       test is the whole decision, and pos < 0 or pos >= n always satisfies the
       band whatever its width, so widening or narrowing it changes nothing.
       (Mutation testing agrees — a mutant on the band is equivalent.) The
       guard that does matter is the cubic branch's `idx < n - 2` below, which
       is what keeps data[idx + 2] inside the buffer. */
    if (pos < 1.0 || pos >= (double)n - 2.0) {
      /* Boundary-safe: cubic interpolation needs one frame either side, so the
         last two frames are played without it rather than reading out of
         bounds. */
      if (pos < 0.0 || pos >= (double)n) {
        stage = BK_DRUM_ENV_IDLE;
        break;
      }
    }

    /* --- envelope -------------------------------------------------------- */
    if (v->choking) {
      env -= v->choke_inc;
      if (env <= 0.0) {
        env = 0.0;
        stage = BK_DRUM_ENV_IDLE;
        break;
      }
    } else {
      switch (stage) {
        case BK_DRUM_ENV_ATTACK:
          env += v->attack_inc;
          if (env >= 1.0) {
            env = 1.0;
            stage = BK_DRUM_ENV_DECAY;
          }
          break;
        case BK_DRUM_ENV_DECAY:
          env = sustain + (env - sustain) * v->decay_coef;
          if (env - sustain < 1e-4) {
            env = sustain;
            /* sustain 0 means the decay knob IS the length of the sound: the
               voice is finished, not holding silence. Without this the pad
               stays "active" rendering zeros until the sample runs out, which
               keeps it out of the free pool and lights its meter ring
               forever. */
            stage = sustain < 1e-4 ? BK_DRUM_ENV_IDLE : BK_DRUM_ENV_SUSTAIN;
          }
          break;
        case BK_DRUM_ENV_SUSTAIN:
          env = sustain;
          if (sustain < 1e-4) stage = BK_DRUM_ENV_IDLE;
          break;
        case BK_DRUM_ENV_RELEASE:
          env *= v->release_coef;
          if (env < 1e-4) {
            env = 0.0;
            stage = BK_DRUM_ENV_IDLE;
          }
          break;
        default:
          break;
      }
      /* ONESHOT auto-release: the beatbox path has no note-off to wait for. */
      if (hold > 0) {
        hold--;
        if (hold == 0 && stage != BK_DRUM_ENV_RELEASE) stage = BK_DRUM_ENV_RELEASE;
      }
    }
    if (stage == BK_DRUM_ENV_IDLE) break;

    /* --- 4-point cubic Hermite resample ---------------------------------- */
    idx = (int)pos;
    frac = pos - (double)idx;
    if (idx >= 1 && idx < n - 2) {
      const double y0 = (double)data[idx - 1];
      const double y1 = (double)data[idx];
      const double y2 = (double)data[idx + 1];
      const double y3 = (double)data[idx + 2];
      const double c0 = y1;
      const double c1 = 0.5 * (y2 - y0);
      const double c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
      const double c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
      s = ((c3 * frac + c2) * frac + c1) * frac + c0;
    } else {
      /* Linear at the edges, where cubic would read past the buffer. */
      const double y0 = js_or_zero((double)data[idx]);
      const double y1 = js_or_zero((double)data[idx + 1 < n ? idx + 1 : idx]);
      s = y0 + (y1 - y0) * frac;
    }

    out = bk_sanitize(s * env * g);
    a = fabs(out);
    if (a > peak) peak = a;

    l[i] = (float)((double)l[i] + out * bk_smoother_next(&v->pan_l));
    r[i] = (float)((double)r[i] + out * bk_smoother_next(&v->pan_r));

    pos += step;
  }

  v->pos = pos;
  v->env = env;
  v->stage = stage;
  v->hold_left = hold;
  if (stage == BK_DRUM_ENV_IDLE) {
    v->active = 0;
    v->choking = 0;
    v->env = 0.0;
  }
  v->meter = peak;
}
