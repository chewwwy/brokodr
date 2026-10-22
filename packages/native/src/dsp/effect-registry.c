/*
 * Bro.Kodr DSP core — effect registry. C port of dsp/effects/registry.js.
 * See effect-registry.h.
 */

#include "brokodr/dsp/effect-registry.h"

#include <string.h>

#include "brokodr/dsp/character.h"
#include "brokodr/dsp/drive.h"
#include "brokodr/dsp/dynamics.h"
#include "brokodr/dsp/eq.h"
#include "brokodr/dsp/modulation.h"
#include "brokodr/dsp/spectral.h"
#include "brokodr/dsp/talkbox.h"
#include "brokodr/dsp/time-fx.h"
#include "brokodr/dsp/vocoder.h"

/* The enum is EFFECT_CLASSES' order and param-keys.h counts the same 22. */
typedef char bk_registry_count_check[(BK_FX_COUNT == BK_EFFECT_TYPE_COUNT) ? 1 : -1];

static const char *const NAMES[BK_FX_COUNT] = {
    "eq",      "comp",   "limiter", "gate",    "transient", "dist",      "sat",    "crush",
    "pitch",   "vocoder", "talkbox", "chorus",  "flanger",   "phaser",    "tremolo", "ringmod",
    "freqshift", "delay", "reverb",  "character", "glitch",  "noise"};

const char *bk_effect_type_name(int type) {
  if (type < 0 || type >= BK_FX_COUNT) return NULL;
  return NAMES[type];
}

int bk_effect_type_from_name(const char *name) {
  int t;
  if (name == NULL) return -1;
  for (t = 0; t < BK_FX_COUNT; t++) {
    if (strcmp(NAMES[t], name) == 0) return t;
  }
  return -1;
}

size_t bk_effect_size(int type) {
  switch (type) {
    case BK_FX_EQ: return sizeof(bk_eq);
    case BK_FX_COMP: return sizeof(bk_compressor);
    case BK_FX_LIMITER: return sizeof(bk_limiter);
    case BK_FX_GATE: return sizeof(bk_gate);
    case BK_FX_TRANSIENT: return sizeof(bk_transient_shaper);
    case BK_FX_DIST: return sizeof(bk_drive);
    case BK_FX_SAT: return sizeof(bk_drive);
    case BK_FX_CRUSH: return sizeof(bk_crush);
    case BK_FX_PITCH: return sizeof(bk_pitch_formant);
    case BK_FX_VOCODER: return sizeof(bk_vocoder);
    case BK_FX_TALKBOX: return sizeof(bk_talkbox);
    case BK_FX_CHORUS: return sizeof(bk_chorus);
    case BK_FX_FLANGER: return sizeof(bk_flanger);
    case BK_FX_PHASER: return sizeof(bk_phaser);
    case BK_FX_TREMOLO: return sizeof(bk_tremolo);
    case BK_FX_RINGMOD: return sizeof(bk_ring_mod);
    case BK_FX_FREQSHIFT: return sizeof(bk_frequency_shifter);
    case BK_FX_DELAY: return sizeof(bk_delay);
    case BK_FX_REVERB: return sizeof(bk_reverb);
    case BK_FX_CHARACTER: return sizeof(bk_character);
    case BK_FX_GLITCH: return sizeof(bk_glitch);
    case BK_FX_NOISE: return sizeof(bk_noise_gen);
    default: return 0;
  }
}

size_t bk_effect_storage_floats(int type, double sample_rate, int max_block) {
  switch (type) {
    case BK_FX_COMP: return bk_compressor_storage_floats(sample_rate);
    case BK_FX_LIMITER: return bk_limiter_storage_floats(sample_rate);
    case BK_FX_DIST:
    case BK_FX_SAT: return BK_DRIVE_SCRATCH_FLOATS(max_block);
    case BK_FX_TALKBOX: return bk_talkbox_storage_floats(sample_rate, max_block);
    case BK_FX_CHORUS: return bk_chorus_storage_floats(sample_rate);
    case BK_FX_FLANGER: return bk_flanger_storage_floats(sample_rate);
    case BK_FX_DELAY: return bk_delay_storage_floats(sample_rate);
    case BK_FX_REVERB: return bk_reverb_storage_floats(sample_rate);
    case BK_FX_CHARACTER: return bk_character_storage_floats(sample_rate);
    case BK_FX_GLITCH: return bk_glitch_storage_floats(sample_rate);
    default: return 0;
  }
}

/* Each case is the JS class's `new C(sampleRate, maxBlock)`: the classes that
   ignore maxBlock in the JS take no max_block here. */
const bk_effect_vt *bk_effect_create(int type, void *mem, float *storage, double sample_rate,
                                     int max_block) {
  switch (type) {
    case BK_FX_EQ: bk_eq_init((bk_eq *)mem, sample_rate, max_block); return &bk_eq_vt;
    case BK_FX_COMP: bk_compressor_init((bk_compressor *)mem, sample_rate, storage); return &bk_compressor_vt;
    case BK_FX_LIMITER: bk_limiter_init((bk_limiter *)mem, sample_rate, storage); return &bk_limiter_vt;
    case BK_FX_GATE: bk_gate_init((bk_gate *)mem, sample_rate); return &bk_gate_vt;
    case BK_FX_TRANSIENT:
      bk_transient_shaper_init((bk_transient_shaper *)mem, sample_rate);
      return &bk_transient_shaper_vt;
    case BK_FX_DIST: bk_dist_init((bk_drive *)mem, sample_rate, max_block, storage); return &bk_drive_vt;
    case BK_FX_SAT: bk_sat_init((bk_drive *)mem, sample_rate, max_block, storage); return &bk_drive_vt;
    case BK_FX_CRUSH: bk_crush_init((bk_crush *)mem, sample_rate); return &bk_crush_vt;
    case BK_FX_PITCH: bk_pitch_formant_init((bk_pitch_formant *)mem, sample_rate); return &bk_pitch_formant_vt;
    case BK_FX_VOCODER: bk_vocoder_init((bk_vocoder *)mem, sample_rate, max_block); return &bk_vocoder_vt;
    case BK_FX_TALKBOX:
      bk_talkbox_init((bk_talkbox *)mem, sample_rate, max_block, storage);
      return &bk_talkbox_vt;
    case BK_FX_CHORUS: bk_chorus_init((bk_chorus *)mem, sample_rate, storage); return &bk_chorus_vt;
    case BK_FX_FLANGER: bk_flanger_init((bk_flanger *)mem, sample_rate, storage); return &bk_flanger_vt;
    case BK_FX_PHASER: bk_phaser_init((bk_phaser *)mem, sample_rate); return &bk_phaser_vt;
    case BK_FX_TREMOLO: bk_tremolo_init((bk_tremolo *)mem, sample_rate); return &bk_tremolo_vt;
    case BK_FX_RINGMOD: bk_ring_mod_init((bk_ring_mod *)mem, sample_rate); return &bk_ring_mod_vt;
    case BK_FX_FREQSHIFT:
      bk_frequency_shifter_init((bk_frequency_shifter *)mem, sample_rate);
      return &bk_frequency_shifter_vt;
    case BK_FX_DELAY: bk_delay_init((bk_delay *)mem, sample_rate, storage); return &bk_delay_vt;
    case BK_FX_REVERB: bk_reverb_init((bk_reverb *)mem, sample_rate, storage); return &bk_reverb_vt;
    case BK_FX_CHARACTER: bk_character_init((bk_character *)mem, sample_rate, storage); return &bk_character_vt;
    case BK_FX_GLITCH: bk_glitch_init((bk_glitch *)mem, sample_rate, storage); return &bk_glitch_vt;
    case BK_FX_NOISE: bk_noise_gen_init((bk_noise_gen *)mem, sample_rate); return &bk_noise_gen_vt;
    default: return NULL;
  }
}

int bk_effect_set_random(int type, void *mem, bk_random_fn fn, void *user) {
  switch (type) {
    case BK_FX_CRUSH: bk_crush_set_random((bk_crush *)mem, fn, user); return 1;
    case BK_FX_VOCODER: bk_vocoder_set_random((bk_vocoder *)mem, fn, user); return 1;
    case BK_FX_FLANGER: bk_flanger_set_random((bk_flanger *)mem, fn, user); return 1;
    case BK_FX_PHASER: bk_phaser_set_random((bk_phaser *)mem, fn, user); return 1;
    case BK_FX_TREMOLO: bk_tremolo_set_random((bk_tremolo *)mem, fn, user); return 1;
    case BK_FX_CHARACTER: bk_character_set_random((bk_character *)mem, fn, user); return 1;
    case BK_FX_GLITCH: bk_glitch_set_random((bk_glitch *)mem, fn, user); return 1;
    case BK_FX_NOISE: bk_noise_gen_set_random((bk_noise_gen *)mem, fn, user); return 1;
    default: return 0;
  }
}

int bk_effect_quality_key(int type) {
  switch (type) {
    case BK_FX_EQ: return BK_P_EQ_QUALITY_KEY;
    case BK_FX_COMP: return BK_P_COMP_QUALITY_KEY;
    case BK_FX_LIMITER: return BK_P_LIMITER_QUALITY_KEY;
    case BK_FX_GATE: return BK_P_GATE_QUALITY_KEY;
    case BK_FX_TRANSIENT: return BK_P_TRANSIENT_QUALITY_KEY;
    case BK_FX_DIST: return BK_P_DIST_QUALITY_KEY;
    case BK_FX_SAT: return BK_P_SAT_QUALITY_KEY;
    case BK_FX_CRUSH: return BK_P_CRUSH_QUALITY_KEY;
    case BK_FX_PITCH: return BK_P_PITCH_QUALITY_KEY;
    case BK_FX_VOCODER: return BK_P_VOCODER_QUALITY_KEY;
    case BK_FX_TALKBOX: return BK_P_TALKBOX_QUALITY_KEY;
    case BK_FX_CHORUS: return BK_P_CHORUS_QUALITY_KEY;
    case BK_FX_FLANGER: return BK_P_FLANGER_QUALITY_KEY;
    case BK_FX_PHASER: return BK_P_PHASER_QUALITY_KEY;
    case BK_FX_TREMOLO: return BK_P_TREMOLO_QUALITY_KEY;
    case BK_FX_RINGMOD: return BK_P_RINGMOD_QUALITY_KEY;
    case BK_FX_FREQSHIFT: return BK_P_FREQSHIFT_QUALITY_KEY;
    case BK_FX_DELAY: return BK_P_DELAY_QUALITY_KEY;
    case BK_FX_REVERB: return BK_P_REVERB_QUALITY_KEY;
    case BK_FX_CHARACTER: return BK_P_CHARACTER_QUALITY_KEY;
    case BK_FX_GLITCH: return BK_P_GLITCH_QUALITY_KEY;
    case BK_FX_NOISE: return BK_P_NOISE_QUALITY_KEY;
    default: return BK_PARAM_NONE;
  }
}

int bk_effect_param_count(int type) {
  switch (type) {
    case BK_FX_EQ: return BK_P_EQ_COUNT;
    case BK_FX_COMP: return BK_P_COMP_COUNT;
    case BK_FX_LIMITER: return BK_P_LIMITER_COUNT;
    case BK_FX_GATE: return BK_P_GATE_COUNT;
    case BK_FX_TRANSIENT: return BK_P_TRANSIENT_COUNT;
    case BK_FX_DIST: return BK_P_DIST_COUNT;
    case BK_FX_SAT: return BK_P_SAT_COUNT;
    case BK_FX_CRUSH: return BK_P_CRUSH_COUNT;
    case BK_FX_PITCH: return BK_P_PITCH_COUNT;
    case BK_FX_VOCODER: return BK_P_VOCODER_COUNT;
    case BK_FX_TALKBOX: return BK_P_TALKBOX_COUNT;
    case BK_FX_CHORUS: return BK_P_CHORUS_COUNT;
    case BK_FX_FLANGER: return BK_P_FLANGER_COUNT;
    case BK_FX_PHASER: return BK_P_PHASER_COUNT;
    case BK_FX_TREMOLO: return BK_P_TREMOLO_COUNT;
    case BK_FX_RINGMOD: return BK_P_RINGMOD_COUNT;
    case BK_FX_FREQSHIFT: return BK_P_FREQSHIFT_COUNT;
    case BK_FX_DELAY: return BK_P_DELAY_COUNT;
    case BK_FX_REVERB: return BK_P_REVERB_COUNT;
    case BK_FX_CHARACTER: return BK_P_CHARACTER_COUNT;
    case BK_FX_GLITCH: return BK_P_GLITCH_COUNT;
    case BK_FX_NOISE: return BK_P_NOISE_COUNT;
    default: return 0;
  }
}
