/*
 * Bro.Kodr DSP core — Smart Voice. C port of dsp/core/beat-classify.js.
 * Read beat-classify.h first: it names the five things in this module that are
 * easy to port wrongly (Math.max under a logarithm, the int32 pending slot id,
 * the negative class index, the observable float32 rounding, and the four
 * ToInt32 setters) and this file is where all five are honoured.
 *
 * Everything below is a line-for-line transcription of the JS, with the
 * comments that explain *why* the JS is shaped that way left in the JS. What is
 * commented here is only what the C has to do differently, and the places where
 * a plausible-looking C idiom would silently diverge.
 */

#include "brokodr/dsp/beat-classify.h"

#include <assert.h>
#include <math.h>
#include <string.h>

#include "brokodr/dsp/utils.h"

/* --- the factory profile ------------------------------------------------ */

/* FACTORY_CENTROIDS, flattened. The literals are the JS's own, digit for digit:
   they are measured numbers, and a "tidied" 0.13 for 0.130 would be a different
   centroid. */
static const float FACTORY_CENTROIDS[BK_VOICE_CLASS_COUNT * BK_ONSET_FEATURE_COUNT] = {
    0.336f, 0.658f, 0.006f, 0.104f, /* kick  */
    0.278f, 0.467f, 0.255f, 1.0f,   /* snare */
    0.0f,   0.123f, 0.877f, 1.0f,   /* hat   */
    0.001f, 0.869f, 0.13f,  0.797f  /* clap  */
};

/* FACTORY_ATTACK, flattened to the same 4-wide stride with the unused zcr slot
   written 0 — see the JS note on why one distance function serves both tables. */
static const float FACTORY_ATTACK[BK_VOICE_CLASS_COUNT * BK_ONSET_FEATURE_COUNT] = {
    0.127f, 0.865f, 0.008f, 0.0f, /* kick  */
    0.394f, 0.448f, 0.158f, 0.0f, /* snare */
    0.0f,   0.062f, 0.938f, 0.0f, /* hat   */
    0.001f, 0.884f, 0.116f, 0.0f  /* clap  */
};

static const int DEFAULT_CLASS_PADS[BK_VOICE_CLASS_COUNT] = {0, 1, 2, 5};

/* AXIS_WEIGHT is module-private in the JS and plain Numbers, so `double`. */
static const double AXIS_WEIGHT[BK_ONSET_FEATURE_COUNT] = {1.4, 1.4, 1.4, 1.0};

void bk_smart_voice_defaults(double *out) {
  out[BK_VOICE_ENABLED] = 0.0;
  out[BK_VOICE_SENSITIVITY] = 2.1;
  out[BK_VOICE_FLOOR_DB] = -42.0;
  out[BK_VOICE_MIN_GAP_MS] = 45.0;
  out[BK_VOICE_FEATURE_MS] = 8.0;
  out[BK_VOICE_MODE] = (double)BK_VOICE_FAST;
  out[BK_VOICE_MARGIN] = 0.62;
  out[BK_VOICE_VEL_MIN] = 0.32;
  out[BK_VOICE_VEL_DB] = 26.0;
  out[BK_VOICE_MONITOR] = 0.0;
}

void bk_smart_voice_factory_centroids(float *out) {
  memcpy(out, FACTORY_CENTROIDS, sizeof(FACTORY_CENTROIDS));
}

void bk_smart_voice_factory_attack(float *out) {
  memcpy(out, FACTORY_ATTACK, sizeof(FACTORY_ATTACK));
}

void bk_smart_voice_default_class_pads(int *out) {
  memcpy(out, DEFAULT_CLASS_PADS, sizeof(DEFAULT_CLASS_PADS));
}

int bk_smart_voice_hist_floats(double sample_rate) { return bk_onset_hist_floats(sample_rate); }

/* --- construction ------------------------------------------------------- */

void bk_smart_voice_reset_centroids(bk_smart_voice *v) {
  int c, f;
  for (c = 0; c < BK_VOICE_CLASS_COUNT; c++) {
    for (f = 0; f < BK_ONSET_FEATURE_COUNT; f++) {
      const int i = c * BK_ONSET_FEATURE_COUNT + f;
      v->centroids[i] = FACTORY_CENTROIDS[i];
      /* The JS reads FACTORY_ATTACK[c][f] only for f < 3 and writes 0
         otherwise; the flattened table already carries that 0, so copying it
         wholesale is the same store. */
      v->attack[i] = FACTORY_ATTACK[i];
    }
  }
}

void bk_smart_voice_init(bk_smart_voice *v, double sample_rate, const double *opts,
                         float *hist_storage) {
  double det_opts[BK_ONSET_PARAM_COUNT];
  double defaults[BK_VOICE_PARAM_COUNT];
  int i, k;

  memset(v, 0, sizeof(*v));

  /* `sampleRate || 48000`: zero and NaN both fall through to the default, and
     so does -0, which is falsy in JS and compares equal to 0.0 here. */
  v->sr = (sample_rate == 0.0 || isnan(sample_rate)) ? 48000.0 : sample_rate;

  bk_smart_voice_defaults(defaults);
  v->enabled = defaults[BK_VOICE_ENABLED] != 0.0;
  v->mode = (int)defaults[BK_VOICE_MODE];
  v->margin = defaults[BK_VOICE_MARGIN];
  v->vel_min = defaults[BK_VOICE_VEL_MIN];
  v->vel_db = defaults[BK_VOICE_VEL_DB];
  v->monitor = defaults[BK_VOICE_MONITOR] != 0.0;
  v->floor_db = defaults[BK_VOICE_FLOOR_DB];

  /* The JS constructor hands the detector six keys: four of VOICE_DEFAULTS'
     own and the two crossovers from ONSET_DEFAULTS. Passing ONSET_DEFAULTS'
     crossovers is the same as omitting them, but it is written out because the
     JS writes it out, and the two would stop being the same the moment either
     default moved. */
  bk_onset_defaults(det_opts);
  det_opts[BK_ONSET_SENSITIVITY] = defaults[BK_VOICE_SENSITIVITY];
  det_opts[BK_ONSET_FLOOR_DB] = defaults[BK_VOICE_FLOOR_DB];
  det_opts[BK_ONSET_MIN_GAP_MS] = defaults[BK_VOICE_MIN_GAP_MS];
  det_opts[BK_ONSET_FEATURE_MS] = defaults[BK_VOICE_FEATURE_MS];
  /* `new OnsetDetector(this.sr, ...)` — the already-defaulted rate, not the
     raw argument. The detector defaults a zero or NaN rate the same way, so
     the two agree on every input; passed this way because that is the call the
     JS makes, and the agreement is a coincidence of two defaults matching
     rather than something to rely on. */
  bk_onset_init(&v->det, v->sr, det_opts, hist_storage);

  bk_smart_voice_reset_centroids(v);

  for (i = 0; i < BK_VOICE_CLASS_COUNT; i++) v->class_pad[i] = DEFAULT_CLASS_PADS[i];

  v->fire_count = 0;
  for (i = 0; i < BK_VOICE_PEND_SLOTS; i++) v->pend_id[i] = -1;

  v->onset_count = 0;
  v->drained = 0;

  v->capture_class = -1;
  v->capture_count = 0;

  v->hit_count = 0;
  v->last_class = -1;
  v->last_conf = 0.0;
  v->last_vel = 0.0;
  v->last_stage = 0;
  v->last_strength = 0.0;
  v->corrections = 0;
  v->level = 0.0;

  /* Not sprung into existence on the first classify() call — see the JS note.
     In C the shape is fixed anyway, but the *initial values* are observable
     through a meter read taken before any hit, so they are the JS's. */
  v->scratch_ratio = 1.0;
  v->scratch_conf = 0.0;

  /* `opts` applied exactly as set_param would apply it, so that init(opts) and
     init(NULL) + set_param are the same thing by construction. A non-finite
     entry means "absent", which needs no special case: set_param already
     ignores one, exactly as the JS does. */
  if (opts) {
    for (k = 0; k < BK_VOICE_PARAM_COUNT; k++) bk_smart_voice_set_param(v, k, opts[k]);
  }
}

/* --- control ------------------------------------------------------------ */

void bk_smart_voice_set_param(bk_smart_voice *v, int key, double value) {
  if (!isfinite(value)) return;
  switch (key) {
    case BK_VOICE_ENABLED: {
      const int on = value >= 0.5;
      if (on && !v->enabled) bk_smart_voice_reset_detector(v);
      v->enabled = on;
      break;
    }
    case BK_VOICE_MODE:
      v->mode = value >= 0.5 ? BK_VOICE_ACCURATE : BK_VOICE_FAST;
      break;
    /* bk_max/bk_min rather than fmax/fmin throughout: the non-finite case is
       already returned above, so only the ordering matters here, but these are
       the functions every Math.max in the port goes through and using the
       other pair would be a latent divergence the moment the guard moves. */
    case BK_VOICE_MARGIN:
      v->margin = bk_max(0.05, bk_min(0.99, value));
      break;
    case BK_VOICE_VEL_MIN:
      v->vel_min = bk_max(0.0, bk_min(0.95, value));
      break;
    case BK_VOICE_VEL_DB:
      v->vel_db = bk_max(3.0, bk_min(60.0, value));
      break;
    case BK_VOICE_MONITOR:
      v->monitor = value >= 0.5;
      break;
    case BK_VOICE_FLOOR_DB:
      /* Two different clamps on one value, and that is the JS: Smart Voice
         keeps it clamped to [-90, -6] for the velocity map and forwards the
         *unclamped* value to the detector, which applies its own range. */
      v->floor_db = bk_max(-90.0, bk_min(-6.0, value));
      bk_onset_set_param(&v->det, BK_ONSET_FLOOR_DB, value);
      break;
    case BK_VOICE_SENSITIVITY:
      bk_onset_set_param(&v->det, BK_ONSET_SENSITIVITY, value);
      break;
    case BK_VOICE_MIN_GAP_MS:
      bk_onset_set_param(&v->det, BK_ONSET_MIN_GAP_MS, value);
      break;
    case BK_VOICE_FEATURE_MS:
      bk_onset_set_param(&v->det, BK_ONSET_FEATURE_MS, value);
      break;
    case BK_VOICE_LOW_CROSS_HZ:
      bk_onset_set_param(&v->det, BK_ONSET_LOW_CROSS_HZ, value);
      break;
    case BK_VOICE_HIGH_CROSS_HZ:
      bk_onset_set_param(&v->det, BK_ONSET_HIGH_CROSS_HZ, value);
      break;
    default:
      /* An unknown key is ignored, exactly as the JS ignores an unknown
         string. Notably it does NOT reach the detector, so it cannot trigger
         a filter recompute. */
      break;
  }
}

void bk_smart_voice_set_centroid(bk_smart_voice *v, double cls, double feature, double value) {
  const int c = bk_onset_to_int32(cls);
  const int f = bk_onset_to_int32(feature);
  if (c < 0 || c >= BK_VOICE_CLASS_COUNT || f < 0 || f >= BK_ONSET_FEATURE_COUNT) return;
  if (!isfinite(value)) return;
  v->centroids[c * BK_ONSET_FEATURE_COUNT + f] = (float)value;
}

void bk_smart_voice_set_attack_centroid(bk_smart_voice *v, double cls, double band, double value) {
  const int c = bk_onset_to_int32(cls);
  const int b = bk_onset_to_int32(band);
  /* `b > 2`, not `b >= BK_ONSET_FEATURE_COUNT`: the zcr slot of the attack
     table is not writable, because it does not exist at stage 1. */
  if (c < 0 || c >= BK_VOICE_CLASS_COUNT || b < 0 || b > 2) return;
  if (!isfinite(value)) return;
  v->attack[c * BK_ONSET_FEATURE_COUNT + b] = (float)value;
}

void bk_smart_voice_set_class_pad(bk_smart_voice *v, double cls, double pad) {
  const int c = bk_onset_to_int32(cls);
  if (c < 0 || c >= BK_VOICE_CLASS_COUNT) return;
  /* `pad < 0 ? -1 : pad | 0`. The sign test is on the *uncoerced* double, so
     -0.5 mutes the class where ToInt32(-0.5) would have been a pad 0, and NaN
     fails the test and coerces to pad 0. Both are the JS. */
  v->class_pad[c] = pad < 0.0 ? -1 : bk_onset_to_int32(pad);
}

void bk_smart_voice_set_capture(bk_smart_voice *v, double cls) {
  const int c = bk_onset_to_int32(cls);
  v->capture_class = (c >= 0 && c < BK_VOICE_CLASS_COUNT) ? c : -1;
}

void bk_smart_voice_clear_captures(bk_smart_voice *v) { v->capture_count = 0; }

int bk_smart_voice_read_capture(const bk_smart_voice *v, long long n, float *out) {
  long long base;
  int i;
  if (n < 0 || n >= v->capture_count || n < v->capture_count - BK_VOICE_CAP_SLOTS) return 0;
  base = (n % BK_VOICE_CAP_SLOTS) * BK_VOICE_CAP_STRIDE;
  for (i = 0; i < BK_VOICE_CAP_STRIDE; i++) out[i] = v->captures[base + i];
  return 1;
}

void bk_smart_voice_reset_detector(bk_smart_voice *v) {
  int i;
  bk_onset_reset(&v->det);
  v->fire_count = 0;
  v->onset_count = 0;
  v->drained = 0;
  /* Only `pend_id` and `pend_read` are cleared, and that is deliberate in the
     JS: invalidating the id is what makes a slot unreachable, so the class,
     velocity, strength, countdown and fired flag left behind in it are dead
     and rewritten on the next registration. Zeroing them here as well would be
     tidier and would diverge — a battery that reads a stale slot field after a
     reset has to see the stale value. */
  for (i = 0; i < BK_VOICE_PEND_SLOTS; i++) {
    v->pend_id[i] = -1;
    v->pend_read[i] = 0;
  }
  v->level = 0.0;
}

void bk_smart_voice_reset(bk_smart_voice *v) {
  bk_smart_voice_reset_detector(v);
  v->capture_class = -1;
  v->capture_count = 0;
  v->hit_count = 0;
  v->last_class = -1;
  v->last_conf = 0.0;
  v->last_vel = 0.0;
  v->last_stage = 0;
  v->last_strength = 0.0;
  v->corrections = 0;
  v->last_band[0] = 0.0f;
  v->last_band[1] = 0.0f;
  v->last_band[2] = 0.0f;
  /* Note what is NOT reset, matching the JS: the centroid tables, the class
     pads, the capture ring's contents (only its count), scratch_ratio and
     scratch_conf. A reset is "forget the performance", not "forget the
     profile" — dropping the calibration on a transport stop would be a bug
     the user would experience as their training evaporating. */
}

/* --- classify ----------------------------------------------------------- */

/*
 * distanceTo. `features` and `centroids` are float32 and the arithmetic is
 * double, which is what the JS does when it reads a Float32Array element into
 * a Number — so the loads widen and nothing rounds until a store.
 */
static double distance_to(const float *features, int f_off, const float *centroids, int cls,
                          int axes) {
  double d = 0.0;
  const int base = cls * BK_ONSET_FEATURE_COUNT;
  int i;
  for (i = 0; i < axes; i++) {
    const double diff = (double)features[f_off + i] - (double)centroids[base + i];
    d += diff * diff * AXIS_WEIGHT[i];
  }
  return d;
}

int bk_smart_voice_classify(bk_smart_voice *v, const float *features, int axes,
                            const float *table) {
  int best = -1;
  double best_d = INFINITY;
  double second_d = INFINITY;
  double ratio;
  int c;

  for (c = 0; c < BK_VOICE_CLASS_COUNT; c++) {
    const double d = distance_to(features, 0, table, c, axes);
    /* `d < best_d` and `d < second_d`, both strict and both false for a NaN d,
       which is the only way `best` can stay -1. See hazard 3 in the header:
       that outcome is unreachable with finite features and finite centroids,
       and the battery gates it rather than this code branching on it. */
    if (d < best_d) {
      second_d = best_d;
      best_d = d;
      best = c;
    } else if (d < second_d) {
      second_d = d;
    }
  }

  ratio = second_d > 1e-12 ? sqrt(best_d / second_d) : 1.0;
  v->scratch_ratio = ratio;
  v->scratch_conf = bk_max(0.0, bk_min(1.0, 1.0 - ratio));
  return best;
}

double bk_smart_voice_velocity_from(const bk_smart_voice *v, double db) {
  const double t = (db - v->floor_db) / v->vel_db;
  /* The JS's ternary chain, not bk_clamp: `t < 0 ? 0 : t > 1 ? 1 : t` passes a
     NaN t through both false arms and returns NaN, where a clamp built out of
     min and max would too but one built out of comparisons might not. Written
     the same way it is written there so the question does not arise. */
  const double c = t < 0.0 ? 0.0 : (t > 1.0 ? 1.0 : t);
  return v->vel_min + (1.0 - v->vel_min) * c;
}

/* --- audio -------------------------------------------------------------- */

/* #emit. Note the ordering: hit_count and every readout move *before* the pad
   test, so a class muted with pad -1 still counts as a hit and still lights the
   panel. Firing is what it loses, not existing. */
static void emit(bk_smart_voice *v, int cls, double vel, int stage, double conf,
                 double strength) {
  /* Hazard 3, and the one place in this file where the C cannot simply do what
     the JS does. `cls` is -1 only when every distance in classify compared
     NaN, which the header argues is unreachable: the stage-1 vector's NaN arm
     writes exact zeros, the stage-2 vector comes from a commit ring onset's
     battery gates as finite, and both centroid tables reject non-finite
     writes. The assert is that argument made executable — the parity harness
     builds without NDEBUG, so a mutation or a hole in the reasoning aborts the
     battery loudly instead of reading off the front of class_pad.
     Under NDEBUG the assert is gone and the fallback is what the JS actually
     does with `classPad[-1]`: `undefined < 0` is false so the drop test
     passes, and `firePad[n] = undefined` stores 0. Hence pad 0, not a mute and
     not an out-of-bounds load. fire_class still records the -1. */
  int pad;
  int n;

  assert(cls >= 0 && cls < BK_VOICE_CLASS_COUNT);
  pad = (cls >= 0 && cls < BK_VOICE_CLASS_COUNT) ? v->class_pad[cls] : 0;

  v->hit_count++;
  v->last_class = cls;
  v->last_conf = conf;
  v->last_vel = vel;
  v->last_stage = stage;
  v->last_strength = strength;

  if (pad < 0 || v->fire_count >= BK_VOICE_FIRE_MAX) return;
  n = v->fire_count++;
  v->fire_pad[n] = pad;
  v->fire_vel[n] = (float)vel;
  v->fire_class[n] = cls;
  v->fire_stage[n] = stage;
  v->fire_conf[n] = (float)conf;
}

/* #stage1. */
static void stage1(bk_smart_voice *v, int slot, int allow_early) {
  bk_onset *det = &v->det;
  const double e_lo = det->fast_low.env;
  const double e_mid = det->fast_mid.env;
  const double e_hi = det->fast_high.env;
  const double total = e_lo * e_lo + e_mid * e_mid + e_hi * e_hi;
  float *band = v->band_scratch;
  double db, vel;
  int cls1, capturing, allow_fire;
  double conf1;

  /* Each share is computed in double and *stored* as float32, and the distance
     below reads the stored value back — so this rounding is upstream of the
     stage-1 commit comparison, not cosmetic. See hazard 4. */
  if (total > 1e-12) {
    band[0] = (float)((e_lo * e_lo) / total);
    band[1] = (float)((e_mid * e_mid) / total);
    band[2] = (float)((e_hi * e_hi) / total);
  } else {
    /* Exact zeros, which is what keeps a NaN envelope from producing a NaN
       feature vector: NaN fails `total > 1e-12` and lands here. That is one of
       the two legs of hazard 3's unreachability argument.

       Belt and braces, though, not the load-bearing leg: onset.c's per-sample
       `isfinite(x) ? (double)x : 0.0` means a non-finite *sample* never reaches
       the band filters, the biquads bk_sanitize their own state, and every
       parameter setter rejects non-finite values — so the envelopes are always
       finite and `total` is always finite. Mutation testing confirmed it: with
       a poison row whose stage 1 reads the envelopes in the very block the NaN
       arrives in (`poison-stage1-nan`), the arm is still only ever entered on
       near-silence. What it is actually defending in practice is the divide,
       not the NaN. */
    band[0] = 0.0f;
    band[1] = 0.0f;
    band[2] = 0.0f;
  }
  band[3] = 0.0f;
  v->last_band[0] = band[0];
  v->last_band[1] = band[1];
  v->last_band[2] = band[2];
  v->pend_band[slot * 3] = band[0];
  v->pend_band[slot * 3 + 1] = band[1];
  v->pend_band[slot * 3 + 2] = band[2];

  /* `20 * Math.log10(Math.max(1e-9, det.level.env))`. bk_gain_to_db is exactly
     that expression, built on bk_max so a NaN level reports NaN instead of the
     -180 dB that fmax would invent. See hazard 1. */
  db = bk_gain_to_db(det->level.env);
  vel = bk_smart_voice_velocity_from(v, db);

  /* Against the attack table on three axes, not the feature table on four. */
  cls1 = bk_smart_voice_classify(v, band, 3, v->attack);
  conf1 = v->scratch_conf;

  v->pend_class[slot] = cls1;
  v->pend_vel[slot] = (float)vel;
  v->pend_read[slot] = 1;

  capturing = v->capture_class >= 0;
  allow_fire = !capturing || v->monitor;
  if (allow_early && allow_fire && v->mode == BK_VOICE_FAST && v->scratch_ratio < v->margin) {
    /* The velocity emitted here is the double, while the rack later gets the
       float32 out of pend_vel on a stage-2 fire. That asymmetry is the JS's:
       `#emit(cls1, vel, ...)` passes the unrounded local. */
    emit(v, cls1, vel, 1, conf1, (double)v->pend_strength[slot]);
    v->pend_fired[slot] = 1;
  }
}

int bk_smart_voice_process(bk_smart_voice *v, const float *block, size_t n) {
  bk_onset *det = &v->det;
  int found, h, s;
  float *feat = v->feat_scratch;

  v->fire_count = 0;
  if (!v->enabled) return 0;

  found = bk_onset_process(det, block, n);
  v->level = det->level.env;

  /* ---- stage 1 ---- */
  for (s = 0; s < BK_VOICE_PEND_SLOTS; s++) {
    if (v->pend_id[s] < 0 || v->pend_read[s]) continue;
    v->pend_wait[s]--;
    if (v->pend_wait[s] <= 0) stage1(v, s, 1);
  }

  for (h = 0; h < found; h++) {
    const long long id = v->onset_count++;
    const int slot = (int)(id % BK_VOICE_PEND_SLOTS);
    /* The store truncates to int32 and the comparison in stage 2 does not —
       see hazard 2. `pend_id` is `int` precisely so that this narrowing
       happens here, in the same place the JS's Int32Array does it. */
    v->pend_id[slot] = (int)id;
    v->pend_strength[slot] = det->strengths[h];
    v->pend_wait[slot] = BK_VOICE_STAGE1_DELAY_BLOCKS;
    v->pend_read[slot] = 0;
    v->pend_fired[slot] = 0;
    v->pend_class[slot] = -1;
    v->pend_vel[slot] = 0.0f;
  }

  /* ---- stage 2 ---- */
  if (v->drained < det->commit_count - BK_VOICE_PEND_SLOTS) {
    v->drained = det->commit_count - BK_VOICE_PEND_SLOTS;
  }
  while (v->drained < det->commit_count) {
    long long id;
    int slot, cls2, capturing;
    double conf2;

    if (!bk_onset_read_committed(det, v->drained, feat)) break;
    id = v->drained;
    v->drained++;
    slot = (int)(id % BK_VOICE_PEND_SLOTS);
    /* int promoted to long long against the untruncated id: identical to the
       JS's `this.pendId[slot] !== id`, including the way it stops matching
       forever past 2^31 onsets. */
    if ((long long)v->pend_id[slot] != id) continue;
    if (!v->pend_read[slot]) stage1(v, slot, 0);

    cls2 = bk_smart_voice_classify(v, feat, BK_ONSET_FEATURE_COUNT, v->centroids);
    conf2 = v->scratch_conf;
    capturing = v->capture_class >= 0;

    if (capturing) {
      const long long base = (v->capture_count % BK_VOICE_CAP_SLOTS) * BK_VOICE_CAP_STRIDE;
      int i;
      v->captures[base] = (float)v->capture_class;
      for (i = 0; i < BK_ONSET_FEATURE_COUNT; i++) v->captures[base + 1 + i] = feat[i];
      for (i = 0; i < 3; i++) {
        v->captures[base + BK_VOICE_CAP_ATTACK_OFFSET + i] = v->pend_band[slot * 3 + i];
      }
      v->captures[base + BK_VOICE_CAP_STRIDE - 1] = v->pend_strength[slot];
      v->capture_count++;
      v->last_class = cls2;
      v->last_conf = conf2;
      v->last_stage = 2;
      v->last_strength = (double)v->pend_strength[slot];
    }

    if (v->pend_fired[slot]) {
      if (cls2 != v->pend_class[slot]) v->corrections++;
    } else if (!capturing || v->monitor) {
      /* pend_vel is float32 here, where the stage-1 fire passed a double. */
      emit(v, cls2, (double)v->pend_vel[slot], 2, conf2, (double)v->pend_strength[slot]);
    }
    v->pend_id[slot] = -1;
  }

  return v->fire_count;
}

/* --- meters ------------------------------------------------------------- */

int bk_smart_voice_read_meters(const bk_smart_voice *v, double *out, int offset) {
  out[offset] = v->enabled ? 1.0 : 0.0;
  out[offset + 1] = (double)v->hit_count;
  out[offset + 2] = (double)v->last_class;
  out[offset + 3] = v->last_conf;
  out[offset + 4] = v->last_vel;
  out[offset + 5] = (double)v->last_stage;
  out[offset + 6] = v->level;
  out[offset + 7] = v->last_strength;
  out[offset + 8] = (double)v->capture_class;
  out[offset + 9] = (double)v->capture_count;
  out[offset + 10] = (double)v->corrections;
  out[offset + 11] = (double)v->onset_count;
  return BK_VOICE_METER_STRIDE;
}
