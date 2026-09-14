/*
 * Parity dump for the C port of dsp/core/utils.js.
 *
 * Producer half of the oracle; scripts/verify-utils-parity.mjs is the consumer.
 * See parity-io.h for the stream format and why the battery lives only here.
 *
 * Two conventions in this file:
 *
 *   - Scalar functions are emitted interleaved. params[0] is the arity, and the
 *     payload is groups of (arity inputs, one output). The inputs therefore
 *     travel in the stream, so the JS side does not hold a copy of the sweep
 *     and cannot drift from it — including the NaN and infinity cases, which
 *     are the ones most worth agreeing on.
 *
 *   - Stateful objects put their configuration in params and their per-sample
 *     output in the f64 payload. Where the JS reaches for Math.random(), the C
 *     port takes the random sample as an argument (see utils.h) and the battery
 *     feeds it the deterministic stimulus, so those paths are testable too.
 *
 * Usage: parity-utils <out.bin>
 */

#include "brokodr/dsp/utils.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

#define MAX_N 8192
#define MAX_GROUP 4096

static double payload[MAX_GROUP * 4];
static double sig[MAX_N];

/* Values chosen to sit on every branch boundary in utils.js: the 1e-18 denormal
   cut and the 1e30 bounds of sanitize(), the 1e-9 floor in gainToDb(), zero,
   both signed zeros, both infinities and a NaN. */
static const double edges[] = {
  0.0,     -0.0,    1e-19,   -1e-19,  1e-18,   -1e-18,  1.0000001e-18,
  1e-9,    -1e-9,   0.25,    -0.25,   0.5,     -0.5,    1.0,
  -1.0,    2.0,     -2.0,    12.0,    -96.0,   1e9,     -1e9,
  1e29,    -1e29,   1e30,    -1e30,   1.0000001e30,     -1.0000001e30,
  1e31,    -1e31,
};
static const int n_edges = (int)(sizeof(edges) / sizeof(edges[0]));

static void emit_scalar1(FILE *f, const char *name, double (*fn)(double)) {
  double p[1];
  int i;
  int k = 0;
  for (i = 0; i < n_edges; i++) {
    payload[k++] = edges[i];
    payload[k++] = fn(edges[i]);
  }
  /* Infinities and NaN last, so a reader eyeballing the dump sees them. */
  payload[k++] = INFINITY;
  payload[k++] = fn(INFINITY);
  payload[k++] = -INFINITY;
  payload[k++] = fn(-INFINITY);
  payload[k++] = NAN;
  payload[k++] = fn(NAN);
  p[0] = 1.0;
  bk_parity_emit(f, name, p, 1, payload, (unsigned int)k, NULL, 0);
}

int main(int argc, char **argv) {
  FILE *f;
  int i, j, k;

  if (argc < 2) {
    fprintf(stderr, "usage: parity-utils <out.bin>\n");
    return 2;
  }
  f = fopen(argv[1], "wb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 1;
  }
  bk_parity_open(f);

  /* --- scalars --------------------------------------------------------- */

  emit_scalar1(f, "sanitize", bk_sanitize);
  emit_scalar1(f, "dbToGain", bk_db_to_gain);
  emit_scalar1(f, "gainToDb", bk_gain_to_db);
  emit_scalar1(f, "semitonesToRatio", bk_semitones_to_ratio);

  {
    /* clamp: x against every ordered and inverted (lo > hi) bound pair. The
       inverted pairs matter — the JS returns hi in that case, and anything
       "tidier" in the C would be a behaviour change. */
    static const double bounds[][2] = {{0.0, 1.0}, {-1.0, 1.0}, {1.0, 0.0}, {10.0, 23880.0}, {0.02, 0.02}};
    const int nb = (int)(sizeof(bounds) / sizeof(bounds[0]));
    double p[1];
    k = 0;
    for (i = 0; i < n_edges; i++)
      for (j = 0; j < nb; j++) {
        payload[k++] = edges[i];
        payload[k++] = bounds[j][0];
        payload[k++] = bounds[j][1];
        payload[k++] = bk_clamp(edges[i], bounds[j][0], bounds[j][1]);
      }
    p[0] = 3.0;
    bk_parity_emit(f, "clamp", p, 1, payload, (unsigned int)k, NULL, 0);
  }

  {
    double p[1];
    k = 0;
    for (i = 0; i < n_edges; i++)
      for (j = 0; j <= 8; j++) {
        const double t = (double)j / 8.0;
        payload[k++] = edges[i];
        payload[k++] = -edges[i] * 0.5;
        payload[k++] = t;
        payload[k++] = bk_lerp(edges[i], -edges[i] * 0.5, t);
      }
    p[0] = 3.0;
    bk_parity_emit(f, "lerp", p, 1, payload, (unsigned int)k, NULL, 0);
  }

  {
    /* polyBlep: t swept across both correction windows and the flat middle, dt
       from silly-small to larger than the window it corrects. */
    static const double dts[] = {0.0, -0.001, 1e-6, 0.001, 0.01, 0.25, 0.5, 1.0};
    const int nd = (int)(sizeof(dts) / sizeof(dts[0]));
    double p[1];
    k = 0;
    for (j = 0; j < nd; j++)
      for (i = 0; i <= 64; i++) {
        const double t = (double)i / 64.0;
        payload[k++] = t;
        payload[k++] = dts[j];
        payload[k++] = bk_poly_blep(t, dts[j]);
      }
    p[0] = 2.0;
    bk_parity_emit(f, "polyBlep", p, 1, payload, (unsigned int)k, NULL, 0);
  }

  /* --- Smoother -------------------------------------------------------- */

  {
    /* ms below the 0.01 floor exercises the clamp in setTime; the 1e-9 snap in
       next() is what the long tail of each run is actually testing. */
    static const double cfg[][4] = {
      /* sr, ms, initial, target */
      {48000.0, 10.0, 0.0, 1.0},
      {48000.0, 0.001, 0.0, 1.0}, /* below the 0.01 ms floor */
      {48000.0, 250.0, -1.0, 0.5},
      {48000.0, 1.0, 0.25, 0.25}, /* already settled */
      {44100.0, 50.0, 1.0, -1.0},
      {96000.0, 5.0, 0.0, 1e-12}, /* target inside the snap threshold */
    };
    const int nc = (int)(sizeof(cfg) / sizeof(cfg[0]));
    const unsigned int n = 2048u;
    for (i = 0; i < nc; i++) {
      bk_smoother s;
      double p[5];
      unsigned int t;
      bk_smoother_init(&s, cfg[i][0], cfg[i][1], cfg[i][2]);
      bk_smoother_set(&s, cfg[i][3]);
      for (t = 0; t < n; t++) {
        if (t == n / 2) bk_smoother_set(&s, -cfg[i][3]); /* reverse mid-run */
        payload[t] = bk_smoother_next(&s);
      }
      /* The settled flag rides along at the end: an exact-equality getter is
         exactly the kind of thing that breaks quietly under a sloppy port. */
      payload[n] = bk_smoother_settled(&s) ? 1.0 : 0.0;
      p[0] = cfg[i][0]; p[1] = cfg[i][1]; p[2] = cfg[i][2]; p[3] = cfg[i][3]; p[4] = (double)n;
      bk_parity_emit(f, "Smoother", p, 5, payload, n + 1u, NULL, 0);
    }
  }

  /* --- EnvelopeFollower ------------------------------------------------ */

  {
    static const double cfg[][3] = {
      /* attackMs, releaseMs, rms */
      {10.0, 100.0, 0.0}, {0.001, 0.001, 0.0}, {1.0, 500.0, 1.0},
      {50.0, 50.0, 1.0},  {0.5, 2000.0, 0.0},
    };
    const int nc = (int)(sizeof(cfg) / sizeof(cfg[0]));
    const int sigs[4] = {BK_SIG_IMPULSE, BK_SIG_STEP, BK_SIG_NOISE, BK_SIG_RAMP};
    for (i = 0; i < nc; i++)
      for (j = 0; j < 4; j++) {
        bk_env_follower e;
        double p[6];
        unsigned int t;
        const unsigned int n = 2048u;
        bk_fill_signal(sig, n, sigs[j]);
        bk_env_follower_init(&e, 48000.0, cfg[i][0], cfg[i][1], (int)cfg[i][2]);
        for (t = 0; t < n; t++) payload[t] = bk_env_follower_process(&e, sig[t]);
        p[0] = 48000.0; p[1] = cfg[i][0]; p[2] = cfg[i][1]; p[3] = cfg[i][2];
        p[4] = (double)sigs[j]; p[5] = (double)n;
        bk_parity_emit(f, "EnvelopeFollower", p, 6, payload, n, NULL, 0);
      }
  }

  /* --- LFO ------------------------------------------------------------- */

  {
    /* Rates chosen so the phase wrap lands both on and between sample
       boundaries, plus one above Nyquist to prove the wrap still behaves. */
    static const double rates[] = {0.1, 2.0, 375.0, 1000.0, 30000.0};
    const int nr = (int)(sizeof(rates) / sizeof(rates[0]));
    int shape;
    for (shape = 0; shape <= 4; shape++)
      for (i = 0; i < nr; i++) {
        bk_lfo l;
        double p[5];
        unsigned int t;
        const unsigned int n = 2048u;
        /* The stimulus doubles as the sample-and-hold random source, so shape 4
           is deterministic here and genuinely compared. */
        bk_fill_signal(sig, n, BK_SIG_NOISE);
        bk_lfo_init(&l, 48000.0);
        l.shape = shape;
        bk_lfo_set_rate(&l, rates[i]);
        bk_lfo_set_phase(&l, -0.75); /* negative phase: floor(), not trunc() */
        for (t = 0; t < n; t++) payload[t] = bk_lfo_next_with(&l, sig[t]);
        p[0] = 48000.0; p[1] = rates[i]; p[2] = (double)shape; p[3] = -0.75; p[4] = (double)n;
        bk_parity_emit(f, "LFO", p, 5, payload, n, NULL, 0);
      }
  }

  /* --- DCBlocker ------------------------------------------------------- */

  {
    static const double hzs[] = {20.0, 5.0, 200.0};
    const int nh = (int)(sizeof(hzs) / sizeof(hzs[0]));
    const int sigs[3] = {BK_SIG_STEP, BK_SIG_NOISE, BK_SIG_RAMP};
    for (i = 0; i < nh; i++)
      for (j = 0; j < 3; j++) {
        bk_dc_blocker d;
        double p[4];
        unsigned int t;
        const unsigned int n = 4096u;
        bk_fill_signal(sig, n, sigs[j]);
        bk_dc_blocker_init(&d, 48000.0, hzs[i]);
        /* Offset the stimulus so there is real DC to remove. */
        for (t = 0; t < n; t++) payload[t] = bk_dc_blocker_process(&d, sig[t] * 0.5 + 0.25);
        p[0] = 48000.0; p[1] = hzs[i]; p[2] = (double)sigs[j]; p[3] = (double)n;
        bk_parity_emit(f, "DCBlocker", p, 4, payload, n, NULL, 0);
      }
  }

  /* --- PitchTracker ---------------------------------------------------- */

  {
    /* RAMP is a 187.5 Hz sawtooth, so the tracker should lock; NOISE should
       come back unvoiced; ZERO takes the no-energy early-out. */
    const int sigs[3] = {BK_SIG_RAMP, BK_SIG_NOISE, BK_SIG_ZERO};
    static const double rates[] = {48000.0, 44100.0};
    for (i = 0; i < 2; i++)
      for (j = 0; j < 3; j++) {
        bk_pitch_tracker pt;
        double p[6];
        unsigned int t, blocks = 0;
        const unsigned int n = 8192u;
        const unsigned int block = 512u;
        bk_fill_signal(sig, n, sigs[j]);
        bk_pitch_tracker_init(&pt, rates[i], 60.0, 900.0);
        for (t = 0; t < n; t++) {
          bk_pitch_tracker_push(&pt, sig[t]);
          if ((t + 1) % block == 0) {
            payload[blocks * 2] = bk_pitch_tracker_analyze(&pt);
            payload[blocks * 2 + 1] = pt.confidence;
            blocks++;
          }
        }
        p[0] = rates[i]; p[1] = 60.0; p[2] = 900.0; p[3] = (double)sigs[j];
        p[4] = (double)n; p[5] = (double)block;
        bk_parity_emit(f, "PitchTracker", p, 6, payload, blocks * 2u, NULL, 0);
      }
  }

  /* --- Oscillator ------------------------------------------------------ */

  {
    static const double freqs[] = {0.0, -100.0, 55.0, 440.0, 1000.0, 11025.0};
    const int nf = (int)(sizeof(freqs) / sizeof(freqs[0]));
    static const double pws[] = {0.1, 0.5, 0.9};
    int mode;
    for (mode = 0; mode < 2; mode++)
      for (i = 0; i < nf; i++)
        for (j = 0; j < 3; j++) {
          bk_oscillator o;
          double p[5];
          unsigned int t;
          const unsigned int n = 2048u;
          if (mode == 0 && j > 0) continue; /* pw is irrelevant to saw() */
          bk_oscillator_init(&o, 48000.0);
          bk_oscillator_set_freq(&o, freqs[i]);
          o.pw = pws[j];
          for (t = 0; t < n; t++)
            payload[t] = mode == 0 ? bk_oscillator_saw(&o) : bk_oscillator_pulse(&o);
          p[0] = 48000.0; p[1] = freqs[i]; p[2] = pws[j]; p[3] = (double)mode; p[4] = (double)n;
          bk_parity_emit(f, mode == 0 ? "Oscillator.saw" : "Oscillator.pulse", p, 5, payload, n,
                         NULL, 0);
        }
  }

  /* --- PinkNoise ------------------------------------------------------- */

  {
    /* The white source comes from the stimulus, not from an RNG, so the filter
       itself is what gets compared. Its float32 state is the whole point of
       this case: a port that held `b` in double would sail through everything
       else in this file and fail here. */
    const int sigs[2] = {BK_SIG_NOISE, BK_SIG_STEP};
    for (j = 0; j < 2; j++) {
      bk_pink_noise pn;
      double p[2];
      unsigned int t;
      const unsigned int n = 4096u;
      bk_fill_signal(sig, n, sigs[j]);
      bk_pink_noise_init(&pn);
      for (t = 0; t < n; t++) payload[t] = bk_pink_noise_process(&pn, sig[t]);
      p[0] = (double)sigs[j]; p[1] = (double)n;
      bk_parity_emit(f, "PinkNoise", p, 2, payload, n, NULL, 0);
    }
  }

  if (!bk_parity_close(f)) {
    fprintf(stderr, "cannot patch record count\n");
    fclose(f);
    return 1;
  }
  fprintf(stderr, "wrote %u records to %s\n", bk_parity_records, argv[1]);
  fclose(f);
  return 0;
}
