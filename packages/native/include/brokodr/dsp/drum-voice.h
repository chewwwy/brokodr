/*
 * Bro.Kodr DSP core — BROBEATS drum voice.
 * C port of dsp/core/drum-voice.js. See biquad.h for the porting rules.
 *
 * One pad: a sample buffer played through an ADSR, a 4-point Hermite
 * resampler and a constant-power pan stage, summed additively into the rack's
 * bus.
 *
 * Three things here differ from the JS, all of them forced:
 *
 *   1. SAMPLE DATA IS BORROWED, NEVER OWNED. setBuffer in the JS is a pointer
 *      handoff of a SAB-backed Float32Array; so is this. The voice keeps a
 *      `const float *` it does not free, and the caller must outlive it. The
 *      buffer stays float32 because that is what the JS holds and what the
 *      sample store produces — reading it as double would make this port
 *      *more* accurate than the web build, which under route (c) is a bug.
 *
 *   2. PARAMS ARE NUMBERS, NOT STRINGS. DrumVoice.setParam takes "attack";
 *      this takes BK_PAD_P_ATTACK from the generated param-keys.h, which is
 *      the index the command ring already carries (PAD_KEY in backend.ts and
 *      in worklet-processor.js). The worklet does that mapping today, so
 *      nothing new is being invented here — the string lookup simply does not
 *      belong on the audio thread.
 *
 *   3. trigger() TAKES AN EXPLICIT VELOCITY. The JS reads `undefined` as 1;
 *      C has no undefined, so the caller passes 1 itself. Every other
 *      velocity, in range or out of it, behaves identically (it is clamped).
 *
 * Divergence from the JS comes from cos/sin (the pan law) and exp (the decay
 * and release coefficients), all of which are evaluated at control rate only —
 * never per sample. scripts/verify-drum-voice-parity.mjs measures it.
 */

#ifndef BROKODR_DSP_DRUM_VOICE_H
#define BROKODR_DSP_DRUM_VOICE_H

#include <stddef.h>

#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Round-robin layers per pad. Four is enough to kill the machine-gun effect. */
#define BK_DRUM_MAX_LAYERS 4

/* Mirrors TRIGGER_MODE in drum-voice.js. Values are part of the wire contract:
   the "mode" pad param carries them. */
enum bk_trigger_mode {
  BK_TRIGGER_GATE = 0,   /* note-off releases — playing by hand */
  BK_TRIGGER_ONESHOT = 1 /* no note-off exists; `hold` auto-releases */
};

/* Mirrors the module-private ENV in drum-voice.js. Exposed because the parity
   battery has to read the stage back, and because the rack asks "is this pad
   still sounding". */
enum bk_drum_env_stage {
  BK_DRUM_ENV_IDLE = 0,
  BK_DRUM_ENV_ATTACK = 1,
  BK_DRUM_ENV_DECAY = 2,
  BK_DRUM_ENV_SUSTAIN = 3,
  BK_DRUM_ENV_RELEASE = 4
};

/* One round-robin layer. `data` is borrowed (see note 1 above). */
typedef struct {
  const float *data;
  int frames;
  double rate; /* the sample's own rate, for the playback ratio */
} bk_drum_layer;

typedef struct {
  double sr;
  /* Stored to mirror the JS constructor, which keeps it and never reads it.
     Nothing here is block-sized, because nothing here allocates. */
  int max_block;

  bk_drum_layer layers[BK_DRUM_MAX_LAYERS];
  int layer_count;
  int next_layer;

  /* --- params, all set through bk_drum_voice_set_param --- */
  double attack_ms;
  double decay_ms;
  double sustain;
  double release_ms;
  double hold_ms;
  double pitch;
  double start_offset;
  int reverse;
  double gain; /* linear, already through dbToGain */
  double pan;  /* -1..1, as set; the law lives in the two smoothers */
  int mode;
  double vel_amount;
  int choke_group;
  int muted;

  /* --- playback state --- */
  int active;
  int layer;
  double pos;
  double step;
  double vel_gain;

  /* --- envelope state --- */
  int stage;
  double env;
  double attack_inc;
  double decay_coef;
  double release_coef;
  /* Frames until the ONESHOT auto-release. -1 means "no hold", which is not
     the same as 0 — 0 would fire on the next frame. */
  int hold_left;
  int choking;
  double choke_inc;

  bk_smoother pan_l;
  bk_smoother pan_r;

  /* Peak of the last block, for the pad's level ring in the UI. */
  double meter;
} bk_drum_voice;

void bk_drum_voice_init(bk_drum_voice *v, double sample_rate, int max_block);

/* Install a sample into a round-robin layer. Structural, not real-time: pass
   data == NULL to empty the layer. `frames` and `src_rate` are ignored when
   data is NULL, exactly as the JS ignores them. */
void bk_drum_voice_set_buffer(bk_drum_voice *v, int layer_index, const float *data, int frames,
                              double src_rate);
void bk_drum_voice_clear_buffers(bk_drum_voice *v);

/* `key` is one of BK_PAD_P_* from param-keys.h. An unknown key is ignored,
   which is what the JS switch does by having no default. */
void bk_drum_voice_set_param(bk_drum_voice *v, int key, double value);

/* Note-on. `velocity` is 0..1 and is clamped. Pass 1 for "full", which is what
   the JS default does. Does nothing when no layer holds a sample. */
void bk_drum_voice_trigger(bk_drum_voice *v, double velocity);
/* Note-off. Only meaningful in GATE mode; ONESHOT uses `hold` instead. */
void bk_drum_voice_release(bk_drum_voice *v);
/* Cut this voice for a choke group (closed hat killing an open hat). */
void bk_drum_voice_choke(bk_drum_voice *v);
void bk_drum_voice_reset(bk_drum_voice *v);

/* Render ADDITIVELY into L/R — the rack sums sixteen of these into one bus, so
   a copy-then-sum would cost an extra pass per voice. Never allocates. */
void bk_drum_voice_process(bk_drum_voice *v, float *l, float *r, size_t frames);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_DRUM_VOICE_H */
