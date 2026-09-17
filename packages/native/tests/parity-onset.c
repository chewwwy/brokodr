/*
 * Parity battery for the onset detector. See parity-io.h for the stream format
 * and scripts/verify-onset-parity.mjs for the side that replays it through the
 * original JavaScript.
 *
 * This battery is shaped differently from the ones before drum-synth, because
 * what it measures is different. onset.c produces no audio: its output is a
 * list of frame positions, a strength per hit, and four features per hit. A
 * sample of float drift either side of a threshold does not move a number
 * slightly — it adds or drops a whole hit and renumbers every hit after it. So
 * a -120 dBFS tolerance check is the wrong instrument here, and the battery is
 * built in layers instead:
 *
 *   1. EXACT. Defaults, ToInt32, the history sizing, the parameter clamps and
 *      the six crossover coefficients. No libm on any path that matters, so
 *      these are held to exact equality with the JS and are a hard gate.
 *
 *   2. BEHAVIOURAL. Whole detection passes over synthetic kit patterns, both
 *      through bk_onset_detect and block-by-block through bk_onset_process.
 *      Positions, strengths, features and the commit ring's bookkeeping all
 *      come out, and the JS side checks them for agreement *and* for the
 *      invariants that make the detector correct regardless of agreement
 *      (hits monotone, refractory period honoured, features normalised).
 *
 *   3. STRUCTURAL. reset() leaves the detector indistinguishable from a fresh
 *      one; a NaN or an Inf in the stream does not permanently silence it;
 *      the commit ring reports staleness at exactly the right boundaries.
 *
 * ## The stimulus
 *
 * A detector needs *transients*, which bk_fill_signal's five signals do not
 * provide, so this file has its own generator. Every operation in it is
 * integer arithmetic or IEEE-754 add/subtract/multiply/divide — never sin(),
 * never exp(). That restriction is what makes the stimulus reproducible bit
 * for bit in JavaScript: the four arithmetic operations are exactly specified
 * and identically rounded in C and in JS, while libm is not. The decay
 * envelopes are repeated multiplications for the same reason, and the noise
 * is the same 24-bit LCG the shared generator uses, on its own stream.
 *
 * ## What is deliberately not tested here
 *
 * ToInt32's wrap into negative numbers is asserted at the function and not
 * through a running detector. Reaching it through `gapFrames` needs a sample
 * rate near 4.3e9, and the lag history at that rate is 412 MB — a detector
 * that cannot be built in a browser and should not be built in a test. The
 * position store goes through the same single ToInt32, so it is covered by the
 * same records; reaching *its* wrap would need 2^31 processed samples.
 */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include "brokodr/dsp/onset.h"
#include "parity-io.h"

/* Biggest detection pass the battery runs, in frames, and the most hits any
   record reports. Both are sized for the longest case below with headroom. */
#define MAX_FRAMES 262144
#define MAX_HITS 32
#define MAX_BLOCKS 96

/* Waveform shapes for the stimulus generator. */
enum {
  STIM_CLICK = 0,  /* one-sample impulse per hit: the sharpest possible onset */
  STIM_KICK = 1,   /* 60 Hz square, slow decay: all energy in the low band */
  STIM_HAT = 2,    /* differenced noise, fast decay: all energy in the high band */
  STIM_SNARE = 3,  /* both at once: the broad-spectrum middle case */
  STIM_SILENCE = 4,
  STIM_DC = 5,     /* a step and then nothing: level without transients */
  /* Broadband noise from the shared generator, scaled. Not a drum at all, and
     that is the point: a detector that fires constantly on noise is useless
     live, so what this case pins is how *few* hits come out of it. */
  STIM_NOISE = 6
};

/*
 * Writes `hits` bursts of `kind` into dst, one every gap_ms.
 *
 * Mirrored exactly in verify-onset-parity.mjs. Everything that advances state
 * — the LCG, the previous-noise sample, the envelope — advances on the same
 * schedule regardless of which waveform is selected, including for the
 * waveforms that ignore the noise. That is not an accident to be tidied up: it
 * is what keeps the two implementations in step without either side keeping a
 * copy of the other's numbers.
 */
static void stim(double *dst, size_t n, double sr, int kind, int hits, double gap_ms, double amp,
                 int poison) {
  unsigned int state = 0x2468ace0u; /* its own stream, not bk_fill_signal's */
  double prev_noise = 0.0;
  size_t i;
  int h, hp = 1;

  for (i = 0; i < n; i++) dst[i] = 0.0;

  if (kind == STIM_SILENCE) {
    /* fall through to poisoning: silence plus a NaN is a real input */
  } else if (kind == STIM_DC) {
    for (i = 0; i < n; i++) dst[i] = amp;
  } else if (kind == STIM_NOISE) {
    bk_fill_signal(dst, n, BK_SIG_NOISE);
    /* amp is always a power of two in the table, so this scaling is exact. */
    for (i = 0; i < n; i++) dst[i] = dst[i] * amp;
  } else {
    hp = bk_onset_to_int32(sr / 120.0); /* 60 Hz square, half-period in frames */
    if (hp < 1) hp = 1;

    for (h = 0; h < hits; h++) {
      int start_i = bk_onset_to_int32((double)h * gap_ms * 0.001 * sr);
      size_t start, k;
      double env = amp;
      double decay = (kind == STIM_HAT) ? 0.997 : 0.9995;

      if (start_i < 0) continue;
      start = (size_t)start_i;

      for (k = 0; start + k < n; k++) {
        double noise, diff, w;

        state = state * 1664525u + 1013904223u;
        noise = ((double)(state >> 8) / 16777216.0) * 2.0 - 1.0;
        diff = noise - prev_noise; /* first difference: a high-band emphasis */
        prev_noise = noise;

        if (kind == STIM_CLICK) w = (k == 0) ? 1.0 : 0.0;
        else if (kind == STIM_KICK) w = ((k / (size_t)hp) & 1u) ? -1.0 : 1.0;
        else if (kind == STIM_HAT) w = diff * 0.5;
        else w = (((k / (size_t)hp) & 1u) ? -0.5 : 0.5) + diff * 0.25;

        dst[start + k] += env * w;
        env = env * decay;
        /* Burst over at about -120 dBFS. An exact power of two, so the
           comparison flips on the same sample in both languages. */
        if (env < 1.0 / 1048576.0) break;
      }
    }
  }

  if (poison) {
    /* A NaN, an Inf and a -Inf dropped into the stream at fixed fractions. The
       detector must survive all three: a non-finite sample reaching an
       envelope follower poisons it permanently, and the only symptom is a
       detector that silently never fires again. */
    if (n > 16) {
      dst[n / 8] = NAN;
      dst[n / 4] = INFINITY;
      dst[n / 4 + 1] = -INFINITY;
    }
  }
}

/* --- case table --------------------------------------------------------- */

/*
 * One detection case. NaN in any of the six parameter slots means "leave at
 * the default", which is exactly what bk_onset_init already does with a
 * non-finite opts entry and what omitting the key does in the JS.
 */
typedef struct {
  const char *name;
  double sr;
  int kind;
  int hits;
  double gap_ms;
  double amp;
  int n;
  int block_size;
  int poison;
  double sens, floor_db, min_gap, feature_ms, low_cross, high_cross;
} onset_case;

#define D NAN /* "default" */

static const onset_case CASES[] = {
    /* name              sr      kind        hits gap    amp    n      blk  poi  sens flr  gap  feat low  high */
    {"click-4",          48000, STIM_CLICK,   4, 120.0, 0.5,   32768, 128, 0,   D,   D,   D,   D,   D,   D},
    {"kick-4",           48000, STIM_KICK,    4, 200.0, 0.5,   65536, 128, 0,   D,   D,   D,   D,   D,   D},
    {"hat-6",            48000, STIM_HAT,     6, 90.0,  0.5,   32768, 128, 0,   D,   D,   D,   D,   D,   D},
    {"snare-4",          48000, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   D,   D,   D,   D,   D,   D},
    /* The case the per-band max exists for: a hat landing while a kick still
       rings. Two passes, one per kind, at the same spacing — the detector must
       find the hat's rise in the high band where the kick does not live. */
    {"roll-kick-fast",   48000, STIM_KICK,   12, 55.0,  0.5,   49152, 128, 0,   D,   D,   D,   D,   D,   D},
    {"roll-hat-fast",    48000, STIM_HAT,    16, 50.0,  0.5,   49152, 128, 0,   D,   D,   D,   D,   D,   D},
    /* Sixteen hits fills the commit ring exactly and never overwrites a slot,
       so the "that measurement is gone" branch of read_committed stays dead.
       Twenty-four overruns it by eight, which is what a live caller that stops
       draining actually does to it. Kept under MAX_HITS so nothing truncates. */
    {"roll-hat-overrun", 48000, STIM_HAT,    24, 50.0,  0.5,   65536, 128, 0,   D,   D,   D,   D,   D,   D},
    /* Refractory period: hits closer together than minGapMs must be merged. */
    {"gap-too-close",    48000, STIM_CLICK,   8, 20.0,  0.5,   32768, 128, 0,   D,   D,   D,   D,   D,   D},
    {"gap-min",          48000, STIM_CLICK,   8, 20.0,  0.5,   32768, 128, 0,   D,   D,   5.0, D,   D,   D},
    {"gap-max",          48000, STIM_CLICK,   8, 120.0, 0.5,   65536, 128, 0,   D,   D,   500.0, D, D,   D},
    /* Level: below the gate nothing is an onset however sharp it is. */
    {"quiet-below-floor",48000, STIM_CLICK,   4, 120.0, 0.001953125, 32768, 128, 0, D, D,  D,   D,   D,   D},
    {"quiet-low-floor",  48000, STIM_CLICK,   4, 120.0, 0.001953125, 32768, 128, 0, D, -90.0, D, D,  D,   D},
    {"loud-high-floor",  48000, STIM_CLICK,   4, 120.0, 0.5,   32768, 128, 0,   D,   -6.0, D,  D,   D,   D},
    /* Sensitivity at both stops. */
    {"sens-min",         48000, STIM_SNARE,   6, 110.0, 0.5,   49152, 128, 0,   1.05, D,  D,   D,   D,   D},
    {"sens-max",         48000, STIM_SNARE,   6, 110.0, 0.5,   49152, 128, 0,   8.0,  D,  D,   D,   D,   D},
    /* Feature window at both stops: changes the features, not the positions. */
    {"feat-min",         48000, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   D,   D,   D,   3.0, D,   D},
    {"feat-max",         48000, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   D,   D,   D,   120.0, D, D},
    /* Crossovers at both stops: changes which band a hit reads as. */
    {"cross-narrow",     48000, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   D,   D,   D,   D,   1000.0, 1500.0},
    {"cross-wide",       48000, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   D,   D,   D,   D,   40.0, 16000.0},
    /* Sample rates, including the two the app actually runs at and the ones a
       device descriptor can hand us. */
    {"sr-8k",             8000, STIM_SNARE,   4, 150.0, 0.5,   16384, 128, 0,   D,   D,   D,   D,   D,   D},
    {"sr-44k1",          44100, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   D,   D,   D,   D,   D,   D},
    {"sr-96k",           96000, STIM_SNARE,   4, 150.0, 0.5,   98304, 128, 0,   D,   D,   D,   D,   D,   D},
    {"sr-192k",         192000, STIM_SNARE,   4, 100.0, 0.5,  196608, 256, 0,   D,   D,   D,   D,   D,   D},
    {"sr-falsy",             0, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   D,   D,   D,   D,   D,   D},
    /* Not-a-number, which is falsy in JS and so must fall back to 48 kHz just
       like zero does. The stimulus is generated at NaN in both languages —
       every burst start is ToInt32(NaN) = 0, so they stack at frame 0 — and
       the detector then runs at the fallback rate. If the fallback is dropped
       the whole detector goes to NaN and finds nothing, which the hit count
       and the no-non-finite invariant both see. */
    {"sr-nan",             NAN, STIM_CLICK,   1, 0.0,   0.5,   16384, 128, 0,   D,   D,   D,   D,   D,   D},
    /* Quiet, tight window. A hat burst at 2^-15 with a sample rate low enough
       that ToInt32(featureMs * 0.001 * sr) is 0 and the max(1, ...) clamp
       takes over, so every feature window is exactly one frame. One frame of
       three near-zero band energies is how the band-share total gets down to
       1e-13 — the only place the `total > 1e-12` guard in commit_features is
       anywhere near firing. Measured: its eight commits straddle the guard,
       with totals at 1.38e-13 (below it) and 3.10e-12 (just above). */
    {"qtw",                333, STIM_HAT,     8, 400.0, 0.000030517578125, 2048, 128, 0, 1.5, -90.0, 50.0, 3.0, 200.0, 4000.0},
    /* Block sizes. The detector is streaming, so the block boundary must make
       no difference at all to where the hits land. */
    {"blk-1",            48000, STIM_CLICK,   3, 120.0, 0.5,   16384, 1,   0,   D,   D,   D,   D,   D,   D},
    {"blk-64",           48000, STIM_CLICK,   3, 120.0, 0.5,   16384, 64,  0,   D,   D,   D,   D,   D,   D},
    {"blk-128",          48000, STIM_CLICK,   3, 120.0, 0.5,   16384, 128, 0,   D,   D,   D,   D,   D,   D},
    {"blk-1024",         48000, STIM_CLICK,   3, 120.0, 0.5,   16384, 1024, 0,  D,   D,   D,   D,   D,   D},
    {"blk-default",      48000, STIM_CLICK,   3, 120.0, 0.5,   16384, 0,   0,   D,   D,   D,   D,   D,   D},
    /* Degenerate input. */
    {"silence",          48000, STIM_SILENCE, 0, 0.0,   0.0,   16384, 128, 0,   D,   D,   D,   D,   D,   D},
    {"dc-step",          48000, STIM_DC,      0, 0.0,   0.5,   16384, 128, 0,   D,   D,   D,   D,   D,   D},
    {"empty",            48000, STIM_CLICK,   0, 0.0,   0.0,   0,     128, 0,   D,   D,   D,   D,   D,   D},
    {"one-sample",       48000, STIM_CLICK,   1, 0.0,   0.5,   1,     128, 0,   D,   D,   D,   D,   D,   D},
    /* A hit right at the end, so its feature window is still open when the
       buffer runs out and only the synthetic tail can close it. */
    {"tail-open-window", 48000, STIM_CLICK,   2, 340.0, 0.5,   16512, 128, 0,   D,   D,   D,   D,   D,   D},
    {"tail-long-window", 48000, STIM_CLICK,   2, 340.0, 0.5,   16512, 128, 0,   D,   D,   D, 120.0, D,   D},
    /* The same open window at a sample rate low enough that
       ToInt32(featureMs * 0.001 * sr) is 0, so the feature window is the one
       frame the max(1, ...) clamp gives it and detect()'s synthetic tail is
       nothing but its `+ block_size` term. The second click lands on the last
       frame the buffer has, which leaves that window open with nowhere to
       close: measured, without the block the tail is zero frames long, the
       window never closes, and the last hit keeps the zero features it was
       pushed with. */
    {"tail-tiny-window",   250, STIM_CLICK,   2, 4092.0, 0.5,  1024, 128, 0,  1.5, -90.0, 5.0, 3.0, 200.0, 4000.0},
    /* Non-finite samples in the stream. */
    {"poison-click",     48000, STIM_CLICK,   4, 120.0, 0.5,   32768, 128, 1,   D,   D,   D,   D,   D,   D},
    {"poison-silence",   48000, STIM_SILENCE, 0, 0.0,   0.0,   16384, 128, 1,   D,   D,   D,   D,   D,   D},
    /* More hits in one block than the block-local arrays can report, which is
       the only way pendingIndex goes to -1 and a commit is dropped. Needs a
       block long enough to hold nine hits at the shortest legal gap. */
    {"noise-broadband",  48000, STIM_NOISE,   0, 0.0,   0.5,   32768, 128, 0,   D,   D,   D,   D,   D,   D},
    {"noise-quiet",      48000, STIM_NOISE,   0, 0.0,   0.001953125, 32768, 128, 0, D, D, D,  D,   D,   D},
    {"overflow-hits",    48000, STIM_CLICK,  12, 6.0,   0.5,   32768, 16384, 0, 1.05, -90.0, 5.0, 3.0, D, D},
};

static const int CASE_COUNT = (int)(sizeof(CASES) / sizeof(CASES[0]));

/* Packs a case into the parameter vector the JS reads back. */
static void case_params(const onset_case *c, double *p) {
  p[0] = c->sr;
  p[1] = (double)c->kind;
  p[2] = (double)c->hits;
  p[3] = c->gap_ms;
  p[4] = c->amp;
  p[5] = (double)c->n;
  p[6] = (double)c->block_size;
  p[7] = (double)c->poison;
  p[8] = c->sens;
  p[9] = c->floor_db;
  p[10] = c->min_gap;
  p[11] = c->feature_ms;
  p[12] = c->low_cross;
  p[13] = c->high_cross;
}
#define CASE_PARAMS 14

static void case_opts(const onset_case *c, double *o) {
  o[BK_ONSET_SENSITIVITY] = c->sens;
  o[BK_ONSET_FLOOR_DB] = c->floor_db;
  o[BK_ONSET_MIN_GAP_MS] = c->min_gap;
  o[BK_ONSET_FEATURE_MS] = c->feature_ms;
  o[BK_ONSET_LOW_CROSS_HZ] = c->low_cross;
  o[BK_ONSET_HIGH_CROSS_HZ] = c->high_cross;
}

/* Working buffers. Static rather than stack: MAX_FRAMES doubles is 2 MB, and
   the wasm build's default stack is nowhere near that. */
static double g_sig[MAX_FRAMES];
static float g_mono[MAX_FRAMES];
static float g_block[MAX_FRAMES];
static float g_hist[3 * 2048]; /* 8 ms at 192 kHz is 1536 floats a band */
static int g_pos[MAX_HITS];
static float g_str[MAX_HITS];
static float g_feat[MAX_HITS * BK_ONSET_FEATURE_COUNT];

/* --- layer 1: exact ----------------------------------------------------- */

static const double TO_INT32_CASES[] = {
    0.0,          -0.0,        0.5,          -0.5,         1.0,          -1.0,
    1.5,          -1.5,        2.5,          -2.5,         42.0,         -42.0,
    2147483646.0, 2147483647.0, 2147483647.5, 2147483648.0, 2147483649.0,
    -2147483647.0, -2147483648.0, -2147483649.0,
    4294967295.0, 4294967296.0, 4294967296.5, 4294967297.0, 4294967300.0,
    -4294967295.0, -4294967296.0, -4294967297.0,
    8589934592.0, 8589934594.0, -8589934594.0,
    1e10,         -1e10,       1e15,         -1e15,        1e18,         -1e18,
    /* The three rates that would make gapFrames negative, at minGapMs 5, 45
       and 500 — the wrap this function exists for, visited without building
       the 412 MB history a live detector at those rates would need. */
    429496729600.0, 47721858500.0, 4294967296.0 * 2.0 + 17.0,
    /* Not-a-number and the infinities: ToInt32 sends all three to +0. */
    NAN,          INFINITY,    -INFINITY,
    /* Beyond 2^53, where the double is no longer an exact integer but the
       modular reduction is still exactly specified. */
    1e30,         -1e30,       1.7976931348623157e308,
};
static const int TO_INT32_COUNT = (int)(sizeof(TO_INT32_CASES) / sizeof(TO_INT32_CASES[0]));

static const double SR_CASES[] = {
    8000.0, 11025.0, 22050.0, 44100.0, 48000.0, 88200.0, 96000.0, 192000.0, 384000.0,
    /* Falsy, negative and absurd. The first becomes 48000; the others are
       taken at face value, exactly as `sampleRate || 48000` does. */
    0.0, -0.0, NAN, 1.0, 100.0, -48000.0, 1e9, 1e12, 429496729600.0,
};
static const int SR_COUNT = (int)(sizeof(SR_CASES) / sizeof(SR_CASES[0]));

/* Every parameter at, inside and beyond both of its stops, plus the two kinds
   of input setParam is required to ignore. Key -1 is "unknown". */
static const double CLAMP_CASES[][2] = {
    {BK_ONSET_SENSITIVITY, 1.0},   {BK_ONSET_SENSITIVITY, 1.05},  {BK_ONSET_SENSITIVITY, 3.0},
    {BK_ONSET_SENSITIVITY, 8.0},   {BK_ONSET_SENSITIVITY, 99.0},  {BK_ONSET_SENSITIVITY, -5.0},
    {BK_ONSET_FLOOR_DB, -200.0},   {BK_ONSET_FLOOR_DB, -90.0},    {BK_ONSET_FLOOR_DB, -48.0},
    {BK_ONSET_FLOOR_DB, -6.0},     {BK_ONSET_FLOOR_DB, 0.0},      {BK_ONSET_FLOOR_DB, 120.0},
    {BK_ONSET_MIN_GAP_MS, 0.0},    {BK_ONSET_MIN_GAP_MS, 5.0},    {BK_ONSET_MIN_GAP_MS, 45.0},
    {BK_ONSET_MIN_GAP_MS, 500.0},  {BK_ONSET_MIN_GAP_MS, 5000.0},
    {BK_ONSET_FEATURE_MS, 0.0},    {BK_ONSET_FEATURE_MS, 3.0},    {BK_ONSET_FEATURE_MS, 22.0},
    {BK_ONSET_FEATURE_MS, 120.0},  {BK_ONSET_FEATURE_MS, 1200.0},
    {BK_ONSET_LOW_CROSS_HZ, 0.0},  {BK_ONSET_LOW_CROSS_HZ, 40.0}, {BK_ONSET_LOW_CROSS_HZ, 180.0},
    {BK_ONSET_LOW_CROSS_HZ, 1000.0}, {BK_ONSET_LOW_CROSS_HZ, 24000.0},
    {BK_ONSET_HIGH_CROSS_HZ, 0.0}, {BK_ONSET_HIGH_CROSS_HZ, 1500.0},
    {BK_ONSET_HIGH_CROSS_HZ, 5000.0}, {BK_ONSET_HIGH_CROSS_HZ, 16000.0},
    {BK_ONSET_HIGH_CROSS_HZ, 96000.0},
    {-1.0, 7.0}, {6.0, 7.0}, {999.0, 7.0},
    {BK_ONSET_SENSITIVITY, NAN},   {BK_ONSET_SENSITIVITY, INFINITY},
    {BK_ONSET_FLOOR_DB, -INFINITY},
};
static const int CLAMP_COUNT = (int)(sizeof(CLAMP_CASES) / sizeof(CLAMP_CASES[0]));

static void emit_layer1(FILE *f) {
  double p[4], o64[16];
  int i;

  bk_onset_defaults(o64);
  bk_parity_emit(f, "defaults", NULL, 0, o64, BK_ONSET_PARAM_COUNT, NULL, 0);

  for (i = 0; i < TO_INT32_COUNT; i++) {
    p[0] = TO_INT32_CASES[i];
    o64[0] = (double)bk_onset_to_int32(p[0]);
    bk_parity_emit(f, "to-int32", p, 1, o64, 1, NULL, 0);
  }

  for (i = 0; i < SR_COUNT; i++) {
    p[0] = SR_CASES[i];
    o64[0] = (double)bk_onset_lag_len(p[0]);
    o64[1] = (double)bk_onset_hist_floats(p[0]);
    bk_parity_emit(f, "lag-len", p, 1, o64, 2, NULL, 0);
  }

  /*
   * The tail length detectOnsets uses is `Math.ceil((featureMs * 0.001 * sr) | 0)`,
   * and the port drops the ceil on the grounds that ToInt32 has already made
   * the value integral. That is an argument, not a measurement, so it gets
   * measured: the C emits the un-ceiled ToInt32 and the JS emits the ceil of
   * it. If they ever differ, this record says so instead of a comment being
   * quietly wrong.
   */
  for (i = 0; i < SR_COUNT; i++) {
    p[0] = SR_CASES[i];
    p[1] = 22.0;
    o64[0] = (double)bk_onset_to_int32(22.0 * 0.001 * p[0]);
    p[1] = 3.0;
    o64[1] = (double)bk_onset_to_int32(3.0 * 0.001 * p[0]);
    p[1] = 120.0;
    o64[2] = (double)bk_onset_to_int32(120.0 * 0.001 * p[0]);
    p[1] = 0.0;
    bk_parity_emit(f, "ceil-noop", p, 2, o64, 3, NULL, 0);
  }

  /* Clamps, read back as the whole parameter block so a key that wrote to the
     wrong field is caught as well as one that clamped wrongly. */
  for (i = 0; i < CLAMP_COUNT; i++) {
    bk_onset d;
    bk_onset_init(&d, 48000.0, NULL, g_hist);
    bk_onset_set_param(&d, (int)CLAMP_CASES[i][0], CLAMP_CASES[i][1]);
    o64[0] = d.sensitivity;
    o64[1] = d.floor_db;
    o64[2] = d.min_gap_ms;
    o64[3] = d.feature_ms;
    o64[4] = d.low_cross_hz;
    o64[5] = d.high_cross_hz;
    p[0] = CLAMP_CASES[i][0];
    p[1] = CLAMP_CASES[i][1];
    bk_parity_emit(f, "clamp", p, 2, o64, 6, NULL, 0);
  }

  /*
   * The crossover coefficients. refresh() is the one place in this module that
   * calls libm (sqrt, and the biquad's own trig), so these are where a libm
   * divergence would show up first — and because every band energy the
   * detector reports is filtered through them, a coefficient that is wrong in
   * the twelfth decimal is a feature that is wrong in the sixth.
   */
  {
    static const double CROSS[][3] = {
        {48000.0, 180.0, 5000.0},  {48000.0, 40.0, 16000.0}, {48000.0, 1000.0, 1500.0},
        {44100.0, 180.0, 5000.0},  {96000.0, 180.0, 5000.0}, {192000.0, 180.0, 5000.0},
        {8000.0, 180.0, 5000.0},   {8000.0, 40.0, 16000.0},  {22050.0, 500.0, 8000.0},
    };
    int n = (int)(sizeof(CROSS) / sizeof(CROSS[0]));
    for (i = 0; i < n; i++) {
      bk_onset d;
      double opts[BK_ONSET_PARAM_COUNT];
      double co[15];
      int k;
      for (k = 0; k < BK_ONSET_PARAM_COUNT; k++) opts[k] = NAN;
      opts[BK_ONSET_LOW_CROSS_HZ] = CROSS[i][1];
      opts[BK_ONSET_HIGH_CROSS_HZ] = CROSS[i][2];
      bk_onset_init(&d, CROSS[i][0], opts, g_hist);
      co[0] = d.low_filter.b0; co[1] = d.low_filter.b1; co[2] = d.low_filter.b2;
      co[3] = d.low_filter.a1; co[4] = d.low_filter.a2;
      co[5] = d.mid_filter.b0; co[6] = d.mid_filter.b1; co[7] = d.mid_filter.b2;
      co[8] = d.mid_filter.a1; co[9] = d.mid_filter.a2;
      co[10] = d.high_filter.b0; co[11] = d.high_filter.b1; co[12] = d.high_filter.b2;
      co[13] = d.high_filter.a1; co[14] = d.high_filter.a2;
      p[0] = CROSS[i][0];
      p[1] = CROSS[i][1];
      p[2] = CROSS[i][2];
      bk_parity_emit(f, "filters", p, 3, co, 15, NULL, 0);
    }
  }
}

/*
 * The same crossovers, reached by setting the parameters *after* construction
 * instead of handing them to it.
 *
 * bk_onset_set_param has to recompute the filters, and the guard that stops it
 * doing so before the biquads exist (`low_filter.sr != 0.0`) is one edit away
 * from never recomputing at all. Nothing else in this battery would notice:
 * every other record constructs its detector with the options already in
 * place, so init's own refresh() does all the work and set_param's is never
 * needed. A slicing UI that moves the crossover sliders on a running detector
 * is the entire audience for that code path.
 *
 * Two starting points per row, because the failure has two shapes. From the
 * defaults, a set that never refreshes leaves the *default* coefficients. From
 * a different pair of crossovers, it leaves those — and it also probes the
 * biquads' idempotence cache, which is what would make a refresh that does run
 * decide it has nothing to do. Both must land on exactly the coefficients the
 * constructor would have produced, which is asserted against the "filters"
 * records above without needing the JS at all.
 */
#define LATE_SLOTS 27

static int snap_cross(double *o, int i, const bk_onset *d) {
  const bk_biquad *fs[3];
  int k;
  fs[0] = &d->low_filter;
  fs[1] = &d->mid_filter;
  fs[2] = &d->high_filter;
  for (k = 0; k < 3; k++) {
    o[i++] = fs[k]->b0;
    o[i++] = fs[k]->b1;
    o[i++] = fs[k]->b2;
    o[i++] = fs[k]->a1;
    o[i++] = fs[k]->a2;
  }
  /* The idempotence cache too: a refresh that ran but was short-circuited and
     one that never ran leave identical coefficients and different caches. */
  for (k = 0; k < 3; k++) {
    o[i++] = (double)fs[k]->type;
    o[i++] = fs[k]->freq;
    o[i++] = fs[k]->q;
    o[i++] = fs[k]->gain_db;
  }
  return i;
}

/* The crossover pair the second variant starts from: legal, and different from
   every target pair in the table. */
#define LATE_FROM_LOW 300.0
#define LATE_FROM_HIGH 9000.0

static void emit_filters_late(FILE *f) {
  static const double CROSS[][3] = {
      {48000.0, 180.0, 5000.0},  {48000.0, 40.0, 16000.0}, {48000.0, 1000.0, 1500.0},
      {44100.0, 180.0, 5000.0},  {96000.0, 180.0, 5000.0}, {192000.0, 180.0, 5000.0},
      {8000.0, 180.0, 5000.0},   {8000.0, 40.0, 16000.0},  {22050.0, 500.0, 8000.0},
  };
  int n = (int)(sizeof(CROSS) / sizeof(CROSS[0])), i;

  for (i = 0; i < n; i++) {
    bk_onset d;
    double opts[BK_ONSET_PARAM_COUNT];
    double o64[2 * LATE_SLOTS];
    double p[5];
    int k, at = 0;

    /* Variant 0: from the defaults. */
    bk_onset_init(&d, CROSS[i][0], NULL, g_hist);
    bk_onset_set_param(&d, BK_ONSET_LOW_CROSS_HZ, CROSS[i][1]);
    bk_onset_set_param(&d, BK_ONSET_HIGH_CROSS_HZ, CROSS[i][2]);
    at = snap_cross(o64, at, &d);

    /* Variant 1: from a different pair, so the cache is already populated with
       coefficients that have to be thrown away. */
    for (k = 0; k < BK_ONSET_PARAM_COUNT; k++) opts[k] = NAN;
    opts[BK_ONSET_LOW_CROSS_HZ] = LATE_FROM_LOW;
    opts[BK_ONSET_HIGH_CROSS_HZ] = LATE_FROM_HIGH;
    bk_onset_init(&d, CROSS[i][0], opts, g_hist);
    bk_onset_set_param(&d, BK_ONSET_LOW_CROSS_HZ, CROSS[i][1]);
    bk_onset_set_param(&d, BK_ONSET_HIGH_CROSS_HZ, CROSS[i][2]);
    at = snap_cross(o64, at, &d);

    p[0] = CROSS[i][0];
    p[1] = CROSS[i][1];
    p[2] = CROSS[i][2];
    p[3] = LATE_FROM_LOW;
    p[4] = LATE_FROM_HIGH;
    bk_parity_emit(f, "filters-late", p, 5, o64, 2 * LATE_SLOTS, NULL, 0);
  }
}

/* --- layer 2: whole detection passes ------------------------------------ */

/*
 * "<layer>:<case>", which is what a failure line reads as. The layer prefix is
 * how the JS side knows which reference path to replay; the case name is how a
 * human knows which row of the table to look at.
 */
static const char *rec_name(const char *layer, const char *name) {
  static char buf[BK_PARITY_NAME_LEN];
  size_t i = 0, j;
  for (j = 0; layer[j] && i + 1 < sizeof(buf); j++) buf[i++] = layer[j];
  if (i + 1 < sizeof(buf)) buf[i++] = ':';
  for (j = 0; name[j] && i + 1 < sizeof(buf); j++) buf[i++] = name[j];
  buf[i] = '\0';
  return buf;
}

static void build_case_signal(const onset_case *c) {
  int i;
  stim(g_sig, (size_t)c->n, c->sr == 0.0 ? 48000.0 : c->sr, c->kind, c->hits, c->gap_ms, c->amp,
       c->poison);
  /* The detector reads float32, which is what the device layer delivers and
     what the JS Float32Array holds, so the stimulus is rounded once here and
     both languages then see the identical samples. */
  for (i = 0; i < c->n; i++) g_mono[i] = (float)g_sig[i];
}

static void emit_detect(FILE *f, const onset_case *c) {
  double p[CASE_PARAMS], opts[BK_ONSET_PARAM_COUNT], o64[1 + MAX_HITS];
  float o32[MAX_HITS + MAX_HITS * BK_ONSET_FEATURE_COUNT];
  bk_onset_result res;
  int i, found;

  case_params(c, p);
  case_opts(c, opts);
  build_case_signal(c);

  res.positions = g_pos;
  res.strengths = g_str;
  res.features = g_feat;
  res.capacity = MAX_HITS;
  res.count = 0;

  found = bk_onset_detect(g_mono, (size_t)c->n, c->sr, opts, c->block_size, g_hist, g_block, &res);

  for (i = 0; i < 1 + MAX_HITS; i++) o64[i] = 0.0;
  for (i = 0; i < MAX_HITS + MAX_HITS * BK_ONSET_FEATURE_COUNT; i++) o32[i] = 0.0f;

  o64[0] = (double)found;
  for (i = 0; i < MAX_HITS && i < found; i++) o64[1 + i] = (double)g_pos[i];
  for (i = 0; i < MAX_HITS && i < found; i++) o32[i] = g_str[i];
  for (i = 0; i < MAX_HITS * BK_ONSET_FEATURE_COUNT; i++) o32[MAX_HITS + i] = g_feat[i];

  bk_parity_emit(f, rec_name("detect", c->name), p, CASE_PARAMS, o64, 1 + MAX_HITS, o32,
                 MAX_HITS + MAX_HITS * BK_ONSET_FEATURE_COUNT);
}

/*
 * The same passes again, but with the output arrays deliberately too small.
 *
 * This is the one place the C API differs from the JavaScript in shape rather
 * than in arithmetic. The JS pushes onto arrays that grow, so it cannot
 * overflow and has nothing to bound; C writes into a caller's fixed buffer and
 * so carries a capacity, a written count and a found count that the JS does
 * not have. Three things follow that no other record can see:
 *
 *   - the bound itself. `pushed < capacity` is off by one from
 *     `pushed <= capacity`, and with every other record passing capacity
 *     MAX_HITS — comfortably above any case's hit count — the branch is never
 *     taken at all and the off-by-one is invisible.
 *
 *   - found vs written. bk_onset_detect returns the number of hits it *found*
 *     and stores the same number in res->count. Under a capacity that bites,
 *     that is no longer the number of hits it *wrote*, and the two stores stop
 *     being interchangeable. A caller reading res->count as "rows I may read"
 *     would then walk off the end of its own buffer, so which number lands
 *     there matters. It is checked against the JS's uncapped hit count, which
 *     is the found number by construction.
 *
 *   - the drain's second guard. `drained < pushed` is what stops the feature
 *     drain from attributing a committed measurement to a hit that was never
 *     recorded. Without it the drain follows commit_count instead, straight
 *     past the end of the features array.
 *
 * All three of those failures write past `capacity`, which is why the buffers
 * here are twice MAX_HITS wide and pre-filled with a sentinel no real position
 * or feature can take. The region past the capacity is then asserted untouched
 * — and asserted on C's own numbers, with no reference implementation needed,
 * because "the callee stayed inside the buffer I gave it" is not a parity
 * question. The extra width is headroom for the mutants to land in: a drain
 * that runs to commit_count on the longest case wants about 24 rows, and
 * writing those into memory the record does not own would corrupt the heap
 * instead of failing the check.
 *
 * Within the capacity the values are compared to the JS as usual, including
 * the slots a short case leaves unwritten: those must still hold the sentinel
 * (positions, strengths) or the zero bk_onset_detect memsets in (features), so
 * a run that writes one row too many is caught from the other side too.
 */
#define CAP_TEST 4
#define CAP_GUARD (2 * MAX_HITS)
#define CAP_POS_SENTINEL (-987654321)
#define CAP_F32_SENTINEL (-8.5e30f)
#define CAP_N64 (6 + CAP_TEST)
#define CAP_N32 (CAP_TEST + CAP_TEST * BK_ONSET_FEATURE_COUNT)

static int g_cap_pos[CAP_GUARD];
static float g_cap_str[CAP_GUARD];
static float g_cap_feat[CAP_GUARD * BK_ONSET_FEATURE_COUNT];

static void emit_cap(FILE *f, const onset_case *c) {
  double p[CASE_PARAMS], opts[BK_ONSET_PARAM_COUNT], o64[CAP_N64];
  float o32[CAP_N32];
  bk_onset_result res;
  int i, found, dirty_pos = 0, dirty_str = 0, dirty_feat = 0;

  case_params(c, p);
  case_opts(c, opts);
  build_case_signal(c);

  for (i = 0; i < CAP_GUARD; i++) g_cap_pos[i] = CAP_POS_SENTINEL;
  for (i = 0; i < CAP_GUARD; i++) g_cap_str[i] = CAP_F32_SENTINEL;
  for (i = 0; i < CAP_GUARD * BK_ONSET_FEATURE_COUNT; i++) g_cap_feat[i] = CAP_F32_SENTINEL;

  res.positions = g_cap_pos;
  res.strengths = g_cap_str;
  res.features = g_cap_feat;
  res.capacity = CAP_TEST;
  /* Deliberately not zero going in, so a build that never writes count at all
     is distinguishable from one that writes the wrong number. */
  res.count = -1;

  found = bk_onset_detect(g_mono, (size_t)c->n, c->sr, opts, c->block_size, g_hist, g_block, &res);

  for (i = CAP_TEST; i < CAP_GUARD; i++)
    if (g_cap_pos[i] != CAP_POS_SENTINEL) dirty_pos++;
  for (i = CAP_TEST; i < CAP_GUARD; i++)
    if (g_cap_str[i] != CAP_F32_SENTINEL) dirty_str++;
  for (i = CAP_TEST * BK_ONSET_FEATURE_COUNT; i < CAP_GUARD * BK_ONSET_FEATURE_COUNT; i++)
    if (g_cap_feat[i] != CAP_F32_SENTINEL) dirty_feat++;

  o64[0] = (double)found;
  o64[1] = (double)res.count;
  o64[2] = (double)CAP_TEST;
  o64[3] = (double)dirty_pos;
  o64[4] = (double)dirty_str;
  o64[5] = (double)dirty_feat;
  for (i = 0; i < CAP_TEST; i++) o64[6 + i] = (double)g_cap_pos[i];
  for (i = 0; i < CAP_TEST; i++) o32[i] = g_cap_str[i];
  for (i = 0; i < CAP_TEST * BK_ONSET_FEATURE_COUNT; i++) o32[CAP_TEST + i] = g_cap_feat[i];

  bk_parity_emit(f, rec_name("cap", c->name), p, CASE_PARAMS, o64, CAP_N64, o32, CAP_N32);
}

/*
 * The same signal driven through bk_onset_process directly, reporting the
 * per-block bookkeeping bk_onset_detect hides: how many hits each block found,
 * whether a measurement was still open when the block ended, and how far the
 * commit counter had got. This is the live caller's view — Smart Voice reads
 * exactly these numbers — and it is the only way the pendingFeature flag and
 * the commit ring's timing are observable at all.
 *
 * It also snapshots the block-local `count` and `features` array after every
 * block. Those are not redundant with the drained ring: the ring holds
 * *finished* measurements, while `features` is what a live caller reads the
 * instant a hit fires, partial window and all, and it is re-indexed from zero
 * every block without being cleared. Nothing else in this battery reads it, so
 * without this a wrong slot, a missing write or a stale row in the live path
 * is invisible — the offline path would still be perfect. `count` is emitted
 * separately from the return value for the same reason: they are two stores of
 * the same number, and only one of them is the one Smart Voice reads.
 */
#define STREAM_SLOTS 4
static double g_stream64[1 + STREAM_SLOTS * MAX_BLOCKS];
static float g_stream32[BK_ONSET_COMMIT_RING * BK_ONSET_FEATURE_COUNT +
                        MAX_BLOCKS * BK_ONSET_MAX_HITS * BK_ONSET_FEATURE_COUNT];
#define STREAM_N64 (1 + STREAM_SLOTS * MAX_BLOCKS)
#define STREAM_FEAT_BASE (BK_ONSET_COMMIT_RING * BK_ONSET_FEATURE_COUNT)
#define STREAM_N32 (STREAM_FEAT_BASE + MAX_BLOCKS * BK_ONSET_MAX_HITS * BK_ONSET_FEATURE_COUNT)

static void emit_stream(FILE *f, const onset_case *c) {
  double p[CASE_PARAMS], opts[BK_ONSET_PARAM_COUNT];
  double *o64 = g_stream64;
  float *o32 = g_stream32;
  bk_onset d;
  int bs = c->block_size <= 0 ? 128 : c->block_size;
  int i, blocks = 0, drained = 0;
  size_t off;

  case_params(c, p);
  case_opts(c, opts);
  build_case_signal(c);

  for (i = 0; i < STREAM_N64; i++) o64[i] = 0.0;
  for (i = 0; i < STREAM_N32; i++) o32[i] = 0.0f;

  bk_onset_init(&d, c->sr, opts, g_hist);

  for (off = 0; off < (size_t)c->n && blocks < MAX_BLOCKS; off += (size_t)bs) {
    size_t bn = (size_t)bs < (size_t)c->n - off ? (size_t)bs : (size_t)c->n - off;
    int found = bk_onset_process(&d, g_mono + off, bn);
    int k;
    o64[1 + STREAM_SLOTS * blocks] = (double)found;
    o64[2 + STREAM_SLOTS * blocks] = (double)d.pending_feature;
    o64[3 + STREAM_SLOTS * blocks] = (double)d.commit_count;
    o64[4 + STREAM_SLOTS * blocks] = (double)d.count;
    for (k = 0; k < BK_ONSET_MAX_HITS * BK_ONSET_FEATURE_COUNT; k++) {
      o32[STREAM_FEAT_BASE + blocks * BK_ONSET_MAX_HITS * BK_ONSET_FEATURE_COUNT + k] =
          d.features[k];
    }
    blocks++;
    /* Drain politely, as the offline caller does, so the features recorded
       here are the finished ones rather than the partial block-local pass. */
    while (drained < BK_ONSET_COMMIT_RING &&
           bk_onset_read_committed(&d, (long long)drained,
                                   o32 + drained * BK_ONSET_FEATURE_COUNT)) {
      drained++;
    }
  }
  o64[0] = (double)blocks;

  bk_parity_emit(f, rec_name("stream", c->name), p, CASE_PARAMS, o64, STREAM_N64, o32, STREAM_N32);
}

/* --- layer 3: structural ------------------------------------------------ */

/*
 * reset() has to leave the detector indistinguishable from a fresh one. It is
 * hand-written field by field in both languages, so a field left out is
 * exactly the kind of mistake that survives every other test in this file: the
 * detector keeps working, just with one stale number inside it.
 *
 * The C emits the second pass of a reused-and-reset detector. The verify script
 * does the same in JS and additionally asserts this record equals the plain
 * "detect" record for the same case, which is the property that actually
 * matters and needs no reference implementation to check.
 */
static void emit_reset(FILE *f, const onset_case *c) {
  double p[CASE_PARAMS], opts[BK_ONSET_PARAM_COUNT], o64[1 + MAX_HITS];
  float o32[MAX_HITS + MAX_HITS * BK_ONSET_FEATURE_COUNT];
  bk_onset d;
  int bs = c->block_size <= 0 ? 128 : c->block_size;
  int i, pass, total = 0;
  size_t off;

  case_params(c, p);
  case_opts(c, opts);
  build_case_signal(c);

  for (i = 0; i < 1 + MAX_HITS; i++) o64[i] = 0.0;
  for (i = 0; i < MAX_HITS + MAX_HITS * BK_ONSET_FEATURE_COUNT; i++) o32[i] = 0.0f;

  bk_onset_init(&d, c->sr, opts, g_hist);

  for (pass = 0; pass < 2; pass++) {
    if (pass == 1) {
      bk_onset_reset(&d);
      total = 0;
      for (i = 0; i < 1 + MAX_HITS; i++) o64[i] = 0.0;
      for (i = 0; i < MAX_HITS + MAX_HITS * BK_ONSET_FEATURE_COUNT; i++) o32[i] = 0.0f;
    }
    for (off = 0; off < (size_t)c->n; off += (size_t)bs) {
      size_t bn = (size_t)bs < (size_t)c->n - off ? (size_t)bs : (size_t)c->n - off;
      int found = bk_onset_process(&d, g_mono + off, bn);
      int h;
      for (h = 0; h < found; h++) {
        if (total < MAX_HITS) {
          o64[1 + total] = (double)d.positions[h];
          o32[total] = d.strengths[h];
        }
        total++;
      }
    }
    o64[0] = (double)total;
  }

  /* The finished features of the second pass, drained from the ring. */
  for (i = 0; i < MAX_HITS && i < BK_ONSET_COMMIT_RING; i++) {
    float scratch[BK_ONSET_FEATURE_COUNT];
    int k;
    /* Only the last COMMIT_RING measurements are still readable; the rest have
       been overwritten, which is the ring working as designed. */
    if (!bk_onset_read_committed(&d, d.commit_count - 1 - i, scratch)) continue;
    for (k = 0; k < BK_ONSET_FEATURE_COUNT; k++) {
      o32[MAX_HITS + i * BK_ONSET_FEATURE_COUNT + k] = scratch[k];
    }
  }

  bk_parity_emit(f, rec_name("reset", c->name), p, CASE_PARAMS, o64, 1 + MAX_HITS, o32,
                 MAX_HITS + MAX_HITS * BK_ONSET_FEATURE_COUNT);
}

/*
 * Every field of the detector, dumped raw, at three moments: after a whole
 * signal has run through it, on a freshly constructed one, and on the first
 * one again after reset().
 *
 * The "reset" record above compares reset() by its *output* — the second pass
 * finds the same hits as a fresh pass — which is the property that matters but
 * is a coarse instrument. A field left out of reset() only changes the output
 * if that field can still swing a threshold eight milliseconds later; several
 * of them (lagPos, pendingIndex, commitCount, a follower's env) demonstrably
 * cannot on these signals, so the hits come out identical and reset() looks
 * fine while the detector carries a stale number forever. This record makes
 * the fields themselves the observable, so "reset forgot one" is a failure
 * regardless of whether this particular audio would have noticed.
 *
 * Three moments rather than two because both halves need pinning: fresh ==
 * post-reset is what reset() promises, and pre-reset != fresh is what stops
 * that comparison being vacuous — on silence every field is already zero and
 * a reset() that did nothing at all would pass.
 *
 * Deliberately included, not oversights:
 *   - The biquads' `type/freq/q/gainDb` idempotence cache. reset() does not
 *     touch the coefficients or the cache in either language (JS Biquad.reset()
 *     is z1 = z2 = 0), so those survive the reset by design and this record is
 *     what says so out loud.
 *   - The commit ring's contents, which reset() also leaves alone — only
 *     commitCount goes back to zero, which is enough to make every slot
 *     unreadable. So the ring is the one thing that legitimately differs
 *     between fresh and post-reset, and the checker excludes it from that
 *     equality while still comparing it across languages.
 */
#define STATE_SNAPS 3
#define STATE_FIELDS 63

static int snap_biquad(double *o, int i, const bk_biquad *f) {
  o[i++] = f->b0;
  o[i++] = f->b1;
  o[i++] = f->b2;
  o[i++] = f->a1;
  o[i++] = f->a2;
  o[i++] = f->z1;
  o[i++] = f->z2;
  o[i++] = (double)f->type;
  o[i++] = f->freq;
  o[i++] = f->q;
  o[i++] = f->gain_db;
  return i;
}

static int snap_follower(double *o, int i, const bk_env_follower *e) {
  o[i++] = e->env;
  o[i++] = e->ca;
  o[i++] = e->cr;
  o[i++] = (double)e->rms;
  return i;
}

/*
 * Writes STATE_FIELDS doubles, 3 * lag floats of lag history, and the commit
 * ring. Field order is mirrored verbatim on the JS side; changing it here
 * without changing it there is a failure the moment anything diverges, which
 * is the intent.
 *
 * `lag` is the record's layout width, computed from the case's sample rate
 * rather than read out of the detector, so a detector that got its own
 * lag_len wrong cannot quietly resize the record to fit — it under-fills
 * (visible as zeros) or gets truncated. The length itself is pinned directly
 * by the layer-1 "lag-len" records.
 */
static int snap_state(double *o, int i, float *h, int lag, const bk_onset *d) {
  int k, nh = lag < d->lag_len ? lag : d->lag_len;
  i = snap_biquad(o, i, &d->low_filter);
  i = snap_biquad(o, i, &d->mid_filter);
  i = snap_biquad(o, i, &d->high_filter);
  i = snap_follower(o, i, &d->fast_low);
  i = snap_follower(o, i, &d->fast_mid);
  i = snap_follower(o, i, &d->fast_high);
  i = snap_follower(o, i, &d->level);
  o[i++] = (double)d->lag_pos;
  o[i++] = d->acc_low;
  o[i++] = d->acc_mid;
  o[i++] = d->acc_high;
  o[i++] = d->acc_zc;
  o[i++] = d->acc_frames;
  o[i++] = (double)d->last_sign;
  o[i++] = (double)d->frames;
  o[i++] = (double)d->last_hit_frame;
  o[i++] = (double)d->window_left;
  o[i++] = (double)d->pending_feature;
  o[i++] = (double)d->pending_index;
  o[i++] = (double)d->count;
  o[i++] = (double)d->commit_count;
  for (k = 0; k < nh; k++) h[k] = d->hist_low[k];
  for (k = 0; k < nh; k++) h[lag + k] = d->hist_mid[k];
  for (k = 0; k < nh; k++) h[2 * lag + k] = d->hist_high[k];
  return i;
}

static void snap_ring(float *r, const bk_onset *d) {
  int k;
  for (k = 0; k < BK_ONSET_COMMIT_RING * BK_ONSET_FEATURE_COUNT; k++) r[k] = d->commit_ring[k];
}

/* A second lag history, so the fresh detector's zeroed one does not overwrite
   the used detector's before it has been read. */
static float g_hist_fresh[3 * 2048];
static double g_state64[1 + STATE_SNAPS * STATE_FIELDS];
static float g_state32[STATE_SNAPS * 3 * 2048 +
                       STATE_SNAPS * BK_ONSET_COMMIT_RING * BK_ONSET_FEATURE_COUNT];

static void emit_state(FILE *f, const onset_case *c) {
  double p[CASE_PARAMS], opts[BK_ONSET_PARAM_COUNT];
  double *o64 = g_state64;
  float *o32 = g_state32;
  bk_onset used, fresh;
  int bs = c->block_size <= 0 ? 128 : c->block_size;
  int i, lag, ring_base, rf, n32;
  size_t off;

  case_params(c, p);
  case_opts(c, opts);
  build_case_signal(c);

  lag = bk_onset_lag_len(c->sr);
  rf = BK_ONSET_COMMIT_RING * BK_ONSET_FEATURE_COUNT;
  ring_base = STATE_SNAPS * 3 * lag;
  n32 = ring_base + STATE_SNAPS * rf;

  for (i = 0; i < 1 + STATE_SNAPS * STATE_FIELDS; i++) o64[i] = 0.0;
  for (i = 0; i < n32; i++) o32[i] = 0.0f;
  o64[0] = (double)lag;

  /* Never drained, so the ring is left full and commit_count high — the
     dirtiest state a live caller can leave behind. */
  bk_onset_init(&used, c->sr, opts, g_hist);
  for (off = 0; off < (size_t)c->n; off += (size_t)bs) {
    size_t bn = (size_t)bs < (size_t)c->n - off ? (size_t)bs : (size_t)c->n - off;
    bk_onset_process(&used, g_mono + off, bn);
  }
  snap_state(o64, 1 + 0 * STATE_FIELDS, o32 + 0 * 3 * lag, lag, &used);
  snap_ring(o32 + ring_base + 0 * rf, &used);

  bk_onset_init(&fresh, c->sr, opts, g_hist_fresh);
  snap_state(o64, 1 + 1 * STATE_FIELDS, o32 + 1 * 3 * lag, lag, &fresh);
  snap_ring(o32 + ring_base + 1 * rf, &fresh);

  bk_onset_reset(&used);
  snap_state(o64, 1 + 2 * STATE_FIELDS, o32 + 2 * 3 * lag, lag, &used);
  snap_ring(o32 + ring_base + 2 * rf, &used);

  bk_parity_emit(f, rec_name("state", c->name), p, CASE_PARAMS, o64,
                 1 + STATE_SNAPS * STATE_FIELDS, o32, n32);
}

/*
 * The commit ring's boundaries, probed where they are actually wrong if they
 * are wrong: one before the oldest readable measurement, the oldest, the
 * newest, one past the newest, and a negative index. Dropping either half of
 * `n < 0 || n >= commitCount || n < commitCount - COMMIT_RING` leaves the
 * detector working perfectly and hands a classifier someone else's features.
 */
static void emit_stale(FILE *f, const onset_case *c) {
  double p[CASE_PARAMS], opts[BK_ONSET_PARAM_COUNT], o64[17];
  float o32[8 * BK_ONSET_FEATURE_COUNT];
  bk_onset d;
  int bs = c->block_size <= 0 ? 128 : c->block_size;
  int i;
  size_t off;
  long long probes[8];
  long long cc;

  case_params(c, p);
  case_opts(c, opts);
  build_case_signal(c);

  for (i = 0; i < 8 * BK_ONSET_FEATURE_COUNT; i++) o32[i] = 0.0f;

  bk_onset_init(&d, c->sr, opts, g_hist);
  /* No draining at all: the ring is left to overflow, which is what a live
     caller that stops listening does. */
  for (off = 0; off < (size_t)c->n; off += (size_t)bs) {
    size_t bn = (size_t)bs < (size_t)c->n - off ? (size_t)bs : (size_t)c->n - off;
    bk_onset_process(&d, g_mono + off, bn);
  }

  cc = d.commit_count;
  probes[0] = -1;
  probes[1] = 0;
  probes[2] = cc - BK_ONSET_COMMIT_RING - 1;
  probes[3] = cc - BK_ONSET_COMMIT_RING;
  probes[4] = cc - 2;
  probes[5] = cc - 1;
  probes[6] = cc;
  probes[7] = cc + 1;

  o64[0] = (double)cc;
  for (i = 0; i < 8; i++) {
    float scratch[BK_ONSET_FEATURE_COUNT] = {0.0f, 0.0f, 0.0f, 0.0f};
    int got = bk_onset_read_committed(&d, probes[i], scratch);
    int k;
    o64[1 + i] = (double)got;
    o64[9 + i] = (double)probes[i];
    for (k = 0; k < BK_ONSET_FEATURE_COUNT; k++) {
      o32[i * BK_ONSET_FEATURE_COUNT + k] = got ? scratch[k] : 0.0f;
    }
  }

  bk_parity_emit(f, rec_name("stale", c->name), p, CASE_PARAMS, o64, 17, o32,
                 8 * BK_ONSET_FEATURE_COUNT);
}

/* --- main --------------------------------------------------------------- */

int main(int argc, char **argv) {
  FILE *f;
  int i;

  if (argc < 2) {
    fprintf(stderr, "usage: %s <out.bin>\n", argv[0]);
    return 2;
  }
  f = fopen(argv[1], "wb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }

  bk_parity_open(f);
  emit_layer1(f);
  emit_filters_late(f);

  for (i = 0; i < CASE_COUNT; i++) {
    if (CASES[i].n > MAX_FRAMES) {
      fprintf(stderr, "case %s exceeds MAX_FRAMES\n", CASES[i].name);
      return 2;
    }
    if (CASES[i].block_size > MAX_FRAMES) {
      fprintf(stderr, "case %s block exceeds MAX_FRAMES\n", CASES[i].name);
      return 2;
    }
    emit_detect(f, &CASES[i]);
    emit_cap(f, &CASES[i]);
    emit_stream(f, &CASES[i]);
    emit_reset(f, &CASES[i]);
    emit_state(f, &CASES[i]);
    emit_stale(f, &CASES[i]);
  }

  if (!bk_parity_close(f)) {
    fprintf(stderr, "cannot patch record count\n");
    return 2;
  }
  fclose(f);
  return 0;
}
