/*
 * Bro.Kodr DSP core — onset detection. C port of dsp/core/onset.js.
 * Read onset.h first: it names the three things in this module that are easy
 * to port wrongly (the float32 lag history, the three `| 0` lengths, and the
 * int32 position store) and this file is where all three are honoured.
 *
 * Everything below is a line-for-line transcription of the JS, with the
 * comments that explain *why* the JS is shaped that way left in the JS. What
 * is commented here instead is only what the C has to do differently, and the
 * places where a plausible-looking C idiom would silently diverge.
 */

#include "brokodr/dsp/onset.h"

#include <math.h>
#include <string.h>

/* --- ES ToInt32 --------------------------------------------------------- */

/*
 * `(x) | 0` in JavaScript. NOT `(int)x`.
 *
 * For every sample rate a human will ever use these agree, which is exactly
 * what makes the difference dangerous: the divergence only appears at the
 * rates a fuzzer or a broken device descriptor reaches, where a C cast of an
 * out-of-range double is undefined behaviour (in practice INT_MIN on x86, or
 * anything at all after the optimiser has reasoned about it) while ToInt32 is
 * a defined modular wrap. The wrap is observable: it is how gapFrames can come
 * out negative, which disables the refractory period.
 *
 * fmod on a finite double is exact — no rounding is introduced here, so the
 * result is the mathematically correct residue, which is what ES specifies.
 */
int bk_onset_to_int32(double x) {
  double t;
  unsigned int u;
  int r;

  /* ToInt32(NaN) = ToInt32(+/-Inf) = +0. Kept for the specification, not for
     the measured behaviour: without it a non-finite x reaches `(unsigned
     int)t` through trunc and fmod, which is undefined, and both toolchains
     measured here happen to land on 0 anyway. The negatives are a different
     story — x86-64 wraps them and wasm saturates to zero, which is why the
     battery holds the two builds of this function to each other. */
  if (!isfinite(x)) return 0;

  t = trunc(x);
  t = fmod(t, 4294967296.0);
  if (t < 0.0) t += 4294967296.0;
  u = (unsigned int)t;
  /* Reinterpret rather than convert: a uint32 above INT_MAX converted to int
     is implementation-defined, and this module's whole point is that the wrap
     is specified. */
  memcpy(&r, &u, sizeof(r));
  return r;
}

/*
 * There is deliberately no second wrap helper here for the `positions` store.
 * Storing a JS Number into an Int32Array *is* ToInt32 — the same operation
 * `| 0` performs — so the store below goes through bk_onset_to_int32 as well.
 * Frame counters are exact integers far below 2^53 in both languages, so the
 * conversion to double on the way in is exact and the two paths are the same
 * function. One wrap in the module means one thing for the battery to assert,
 * and it can assert it directly instead of trying to run a detector for the
 * 2^31 samples it would take to reach the wrap through the counter.
 */

/* --- defaults and sizing ------------------------------------------------ */

void bk_onset_defaults(double *out) {
  out[BK_ONSET_SENSITIVITY] = 1.9;
  out[BK_ONSET_FLOOR_DB] = -48.0;
  out[BK_ONSET_MIN_GAP_MS] = 45.0;
  out[BK_ONSET_FEATURE_MS] = 22.0;
  out[BK_ONSET_LOW_CROSS_HZ] = 180.0;
  out[BK_ONSET_HIGH_CROSS_HZ] = 5000.0;
}

int bk_onset_lag_len(double sample_rate) {
  double sr = (sample_rate == 0.0 || isnan(sample_rate)) ? 48000.0 : sample_rate;
  int n = bk_onset_to_int32(BK_ONSET_LAG_MS * 0.001 * sr);
  return n < 1 ? 1 : n;
}

int bk_onset_hist_floats(double sample_rate) {
  return 3 * bk_onset_lag_len(sample_rate);
}

/* --- construction ------------------------------------------------------- */

static void refresh(bk_onset *d) {
  /* Q of 0.707 on the crossovers: flat, no resonant bump colouring the band
     energies. */
  double centre, q;
  bk_biquad_set(&d->low_filter, BK_FILTER_LOWPASS, d->low_cross_hz, 0.707, 0.0);
  bk_biquad_set(&d->high_filter, BK_FILTER_HIGHPASS, d->high_cross_hz, 0.707, 0.0);
  centre = sqrt(d->low_cross_hz * d->high_cross_hz);
  q = centre / bk_max(1.0, d->high_cross_hz - d->low_cross_hz);
  bk_biquad_set(&d->mid_filter, BK_FILTER_BANDPASS, centre, bk_max(0.3, q), 0.0);
}

void bk_onset_set_param(bk_onset *d, int key, double value) {
  if (!isfinite(value)) return;
  switch (key) {
    case BK_ONSET_SENSITIVITY:
      d->sensitivity = bk_max(1.05, bk_min(8.0, value));
      break;
    case BK_ONSET_FLOOR_DB:
      d->floor_db = bk_max(-90.0, bk_min(-6.0, value));
      break;
    case BK_ONSET_MIN_GAP_MS:
      d->min_gap_ms = bk_max(5.0, bk_min(500.0, value));
      break;
    case BK_ONSET_FEATURE_MS:
      d->feature_ms = bk_max(3.0, bk_min(120.0, value));
      break;
    case BK_ONSET_LOW_CROSS_HZ:
      d->low_cross_hz = bk_max(40.0, bk_min(1000.0, value));
      break;
    case BK_ONSET_HIGH_CROSS_HZ:
      d->high_cross_hz = bk_max(1500.0, bk_min(16000.0, value));
      break;
    default:
      /* Unknown key: the JS returns *before* its refresh. Not cosmetic — the
         biquads cache their last-set parameters, so whether refresh ran is
         invisible in the coefficients but visible in a subsequent set() being
         a no-op or not. Keeping the early return keeps that identical. */
      return;
  }
  /* `if (this.lowFilter) this.#refresh()`. The guard exists because the
     constructor applies opts before the filters are built. The C equivalent is
     the `built` flag below, set by bk_onset_init after the biquads are
     initialised.

     In C the guard turns out to be belt-and-braces: bk_biquad_init resets
     type/freq/q/gain_db to sentinels, so coefficients cached by a refresh that
     ran before the filters existed cannot survive init, and removing the guard
     is unobservable. Kept because it is what the JS does, and because the
     next person to reorder bk_onset_init would be relying on that accident. */
  if (d->low_filter.sr != 0.0) refresh(d);
}

void bk_onset_init(bk_onset *d, double sample_rate, const double *opts, float *hist_storage) {
  double defs[BK_ONSET_PARAM_COUNT];
  int i;

  memset(d, 0, sizeof(*d));

  /* `sampleRate || 48000`: 0, -0 and NaN are the falsy doubles. */
  d->sr = (sample_rate == 0.0 || isnan(sample_rate)) ? 48000.0 : sample_rate;

  bk_onset_defaults(defs);
  d->sensitivity = defs[BK_ONSET_SENSITIVITY];
  d->floor_db = defs[BK_ONSET_FLOOR_DB];
  d->min_gap_ms = defs[BK_ONSET_MIN_GAP_MS];
  d->feature_ms = defs[BK_ONSET_FEATURE_MS];
  d->low_cross_hz = defs[BK_ONSET_LOW_CROSS_HZ];
  d->high_cross_hz = defs[BK_ONSET_HIGH_CROSS_HZ];

  /* The filters do not exist yet, so these must not refresh — and they cannot,
     because low_filter.sr is still 0 from the memset. That is the same
     ordering the JS relies on, expressed the only way C can express it. */
  if (opts) {
    for (i = 0; i < BK_ONSET_PARAM_COUNT; i++) bk_onset_set_param(d, i, opts[i]);
  }

  bk_biquad_init(&d->low_filter, d->sr);
  bk_biquad_init(&d->mid_filter, d->sr);
  bk_biquad_init(&d->high_filter, d->sr);

  bk_env_follower_init(&d->fast_low, d->sr, 1.5, 40.0, 0);
  bk_env_follower_init(&d->fast_mid, d->sr, 1.5, 40.0, 0);
  bk_env_follower_init(&d->fast_high, d->sr, 1.5, 40.0, 0);
  bk_env_follower_init(&d->level, d->sr, 1.5, 40.0, 0);

  d->lag_len = bk_onset_lag_len(d->sr);
  d->lag_pos = 0;
  d->hist_low = hist_storage;
  d->hist_mid = hist_storage + d->lag_len;
  d->hist_high = hist_storage + 2 * d->lag_len;
  memset(hist_storage, 0, (size_t)(3 * d->lag_len) * sizeof(float));

  d->acc_low = 0.0;
  d->acc_mid = 0.0;
  d->acc_high = 0.0;
  d->acc_zc = 0.0;
  d->acc_frames = 0.0;
  d->last_sign = 0;

  d->frames = 0;
  d->last_hit_frame = -1000000000LL; /* -1e9 */
  d->window_left = 0;
  d->pending_feature = 0;
  d->pending_index = -1;

  d->count = 0;
  d->commit_count = 0;

  refresh(d);
}

void bk_onset_reset(bk_onset *d) {
  bk_biquad_reset(&d->low_filter);
  bk_biquad_reset(&d->mid_filter);
  bk_biquad_reset(&d->high_filter);
  bk_env_follower_reset(&d->fast_low);
  bk_env_follower_reset(&d->fast_mid);
  bk_env_follower_reset(&d->fast_high);
  bk_env_follower_reset(&d->level);
  memset(d->hist_low, 0, (size_t)d->lag_len * sizeof(float));
  memset(d->hist_mid, 0, (size_t)d->lag_len * sizeof(float));
  memset(d->hist_high, 0, (size_t)d->lag_len * sizeof(float));
  d->lag_pos = 0;
  d->acc_low = 0.0;
  d->acc_mid = 0.0;
  d->acc_high = 0.0;
  d->acc_zc = 0.0;
  d->acc_frames = 0.0;
  d->last_sign = 0;
  d->frames = 0;
  d->last_hit_frame = -1000000000LL;
  d->window_left = 0;
  d->pending_feature = 0;
  d->pending_index = -1;
  d->count = 0;
  d->commit_count = 0;
  /* Note what reset() does NOT do: it leaves the filter coefficients and their
     idempotence cache alone, clearing only the recursion state. Same as the
     JS, whose Biquad.reset() is z1 = z2 = 0. */
}

/* --- feature commit ----------------------------------------------------- */

static void commit_features(bk_onset *d) {
  int idx = d->pending_index;
  double total, low, mid, high, secs, zcr, zn;
  int base, r;

  d->pending_feature = 0;
  d->window_left = 0;
  /* idx < 0 means the hit overflowed BK_ONSET_MAX_HITS and was never reported.
     There is no output entry for it, so it must not advance the ring either —
     the ring's whole job is to stay one-for-one with the hits the caller
     actually saw. */
  if (idx < 0 || idx >= BK_ONSET_MAX_HITS) return;

  total = d->acc_low + d->acc_mid + d->acc_high;
  low = 0.0;
  mid = 0.0;
  high = 0.0;
  if (total > 1e-12) {
    low = d->acc_low / total;
    mid = d->acc_mid / total;
    high = d->acc_high / total;
  }
  secs = d->acc_frames / d->sr;
  zcr = secs > 0.0 ? d->acc_zc / secs : 0.0;
  zn = bk_min(1.0, zcr / 8000.0);

  base = idx * BK_ONSET_FEATURE_COUNT;
  d->features[base] = (float)low;
  d->features[base + 1] = (float)mid;
  d->features[base + 2] = (float)high;
  d->features[base + 3] = (float)zn;

  r = (int)(d->commit_count % BK_ONSET_COMMIT_RING) * BK_ONSET_FEATURE_COUNT;
  d->commit_ring[r] = (float)low;
  d->commit_ring[r + 1] = (float)mid;
  d->commit_ring[r + 2] = (float)high;
  d->commit_ring[r + 3] = (float)zn;
  d->commit_count++;
}

/* --- the detector ------------------------------------------------------- */

int bk_onset_process(bk_onset *d, const float *block, size_t n) {
  const double floor_gain = pow(10.0, d->floor_db / 20.0);
  const int gap_frames = bk_onset_to_int32(d->min_gap_ms * 0.001 * d->sr);
  int window_frames = bk_onset_to_int32(d->feature_ms * 0.001 * d->sr);
  const double band_floor = floor_gain * 0.5;
  int count = 0;
  size_t i;

  if (window_frames < 1) window_frames = 1; /* Math.max(1, ...) */

  for (i = 0; i < n; i++) {
    const float x = block[i];
    /* A NaN reaching the envelope followers poisons them permanently, and the
       only symptom is a detector that silently never fires again. */
    const double s = isfinite(x) ? (double)x : 0.0;

    const double lo = bk_biquad_process(&d->low_filter, s);
    const double mid = bk_biquad_process(&d->mid_filter, s);
    const double hi = bk_biquad_process(&d->high_filter, s);

    const double f_lo = bk_env_follower_process(&d->fast_low, lo);
    const double f_mid = bk_env_follower_process(&d->fast_mid, mid);
    const double f_hi = bk_env_follower_process(&d->fast_high, hi);
    const double f = bk_env_follower_process(&d->level, s);

    /* Read the lagged values before overwriting the slot: at this index sits
       exactly what was written lag_len frames ago. The reads promote float32
       to double and the writes round back, which is what the JS
       Float32Arrays do and therefore what the ratio below is computed from. */
    const int lp = d->lag_pos;
    const double p_lo = (double)d->hist_low[lp];
    const double p_mid = (double)d->hist_mid[lp];
    const double p_hi = (double)d->hist_high[lp];
    double r_lo, r_mid, r_hi, ratio, since_hit;

    d->hist_low[lp] = (float)f_lo;
    d->hist_mid[lp] = (float)f_mid;
    d->hist_high[lp] = (float)f_hi;
    d->lag_pos = lp + 1 >= d->lag_len ? 0 : lp + 1;

    r_lo = p_lo > 1e-9 ? f_lo / p_lo : (f_lo > 1e-9 ? 99.0 : 0.0);
    r_mid = p_mid > 1e-9 ? f_mid / p_mid : (f_mid > 1e-9 ? 99.0 : 0.0);
    r_hi = p_hi > 1e-9 ? f_hi / p_hi : (f_hi > 1e-9 ? 99.0 : 0.0);

    ratio = 0.0;
    if (f_lo > band_floor && r_lo > ratio) ratio = r_lo;
    if (f_mid > band_floor && r_mid > ratio) ratio = r_mid;
    if (f_hi > band_floor && r_hi > ratio) ratio = r_hi;

    if (d->window_left > 0) {
      int sign;
      d->acc_low += lo * lo;
      d->acc_mid += mid * mid;
      d->acc_high += hi * hi;
      sign = s > 0.0 ? 1 : (s < 0.0 ? -1 : d->last_sign);
      if (sign != d->last_sign && d->last_sign != 0) d->acc_zc += 1.0;
      d->last_sign = sign;
      d->acc_frames += 1.0;
      d->window_left--;
      if (d->window_left == 0) commit_features(d);
    }

    since_hit = (double)(d->frames - d->last_hit_frame);
    if (f > floor_gain && since_hit > (double)gap_frames && ratio > d->sensitivity) {
      /* A hit while a previous window is still open closes that one early
         rather than discarding it: a half-measured hit still classifies, a
         dropped one does not. */
      if (d->window_left > 0) commit_features(d);

      d->last_hit_frame = d->frames;
      if (count < BK_ONSET_MAX_HITS) {
        /* `positions` is an Int32Array in the JS, so the store wraps. */
        d->positions[count] = bk_onset_to_int32((double)d->frames);
        d->strengths[count] = (float)bk_min(1.0, bk_max(0.0, (ratio - 1.0) / 6.0));
        d->pending_index = count;
        count++;
      } else {
        d->pending_index = -1;
      }
      d->acc_low = 0.0;
      d->acc_mid = 0.0;
      d->acc_high = 0.0;
      d->acc_zc = 0.0;
      d->acc_frames = 0.0;
      d->window_left = window_frames;
      d->pending_feature = 1;
    }

    d->frames++;
  }

  d->count = count;
  return count;
}

int bk_onset_read_committed(const bk_onset *d, long long n, float *out) {
  int r, i;
  if (n < 0 || n >= d->commit_count || n < d->commit_count - BK_ONSET_COMMIT_RING) return 0;
  r = (int)(n % BK_ONSET_COMMIT_RING) * BK_ONSET_FEATURE_COUNT;
  for (i = 0; i < BK_ONSET_FEATURE_COUNT; i++) out[i] = d->commit_ring[r + i];
  return 1;
}

/* --- offline convenience ------------------------------------------------ */

/* The JS closes over `drained`, `positions.length` and the detector; C passes
   them. `pushed` is the JS's positions.length — the number of hits actually
   recorded, which is what gates the drain. */
static void drain(bk_onset *d, bk_onset_result *res, int pushed, int *drained) {
  float scratch[BK_ONSET_FEATURE_COUNT];
  while ((long long)(*drained) < d->commit_count && *drained < pushed) {
    int base, i;
    if (!bk_onset_read_committed(d, *drained, scratch)) break;
    base = *drained * BK_ONSET_FEATURE_COUNT;
    for (i = 0; i < BK_ONSET_FEATURE_COUNT; i++) res->features[base + i] = scratch[i];
    (*drained)++;
  }
}

int bk_onset_detect(const float *mono, size_t n, double sample_rate, const double *opts,
                    int block_size, float *scratch, float *block, bk_onset_result *res) {
  bk_onset det;
  size_t off;
  long long tail_frames;
  int pushed = 0;
  int drained = 0;
  int total = 0;

  /* The JS default argument. Only its being positive is observable: the
     detector is streaming and its output does not depend on where the block
     boundaries fall, which the battery pins by running the same stimulus at
     block sizes 1, 64, 128 and 1024 and demanding identical hits. */
  if (block_size <= 0) block_size = 128;

  bk_onset_init(&det, sample_rate, opts, scratch);

  /* Zeroed here and assigned again at the single exit below, so this store is
     for a caller that reads the result after a detect that found nothing to
     do, not for any path through this function. */
  res->count = 0;
  memset(res->features, 0, (size_t)(res->capacity * BK_ONSET_FEATURE_COUNT) * sizeof(float));

  for (off = 0; off < n; off += (size_t)block_size) {
    size_t bn = (size_t)block_size < n - off ? (size_t)block_size : n - off;
    size_t i;
    int found, h;

    for (i = 0; i < bn; i++) block[i] = mono[off + i];
    /* The JS zero-pads the staging buffer past bn and then passes bn, so the
       padding is never read. Kept because a future caller that passes the full
       block_size would otherwise read the previous block's tail. */
    for (i = bn; i < (size_t)block_size; i++) block[i] = 0.0f;

    found = bk_onset_process(&det, block, bn);
    for (h = 0; h < found; h++) {
      total++;
      if (pushed < res->capacity) {
        res->positions[pushed] = det.positions[h];
        res->strengths[pushed] = det.strengths[h];
        /* features stay zero until a commit fills them in, matching the
           JS's features.push([0, 0, 0, 0]) placeholder. */
        pushed++;
      }
    }
    drain(&det, res, pushed, &drained);
  }

  /*
   * A hit near the end of the buffer still has its window open. Offline there
   * is no "later" for it to finish in, so it is given one: silence, long enough
   * to close the longest window the params allow. The measurement is then
   * whatever real audio the window caught before the buffer ran out, which is
   * the honest answer.
   *
   * `Math.ceil((featureMs * 0.001 * sr) | 0)` in the JS — the ceil is applied
   * to an already-integral ToInt32 result and does nothing. Transcribed as the
   * ToInt32 alone, which is the same value; the redundancy is noted rather
   * than reproduced because there is no ceil in C that could differ from it.
   */
  tail_frames = (long long)bk_onset_to_int32(det.feature_ms * 0.001 * det.sr) + block_size;
  for (off = 0; (long long)off < tail_frames && det.window_left > 0; off += (size_t)block_size) {
    int i;
    for (i = 0; i < block_size; i++) block[i] = 0.0f;
    /* Note the full block_size, not bn: the tail is always a whole block. And
       note that the JS discards this call's return value, so a hit found in
       the tail silence is never recorded — mirrored deliberately. */
    bk_onset_process(&det, block, (size_t)block_size);
    drain(&det, res, pushed, &drained);
  }
  drain(&det, res, pushed, &drained);

  res->count = total;
  return total;
}
