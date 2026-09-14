/*
 * Parity dump for the C port of dsp/core/delay-line.js.
 *
 * Producer half of the oracle; scripts/verify-delay-line-parity.mjs is the
 * consumer. See parity-io.h for the stream format.
 *
 * What this module needs proving, beyond "the arithmetic matches":
 *
 *   - The buffer is float32 on both sides. A `double` C buffer would be more
 *     accurate and would therefore *diverge* from the web build, which under
 *     route (c) is a bug. So every DelayLine case also emits the final buffer
 *     contents as an f32 payload: if the write path stopped rounding, that
 *     payload moves even when the read output still looks fine.
 *
 *   - The negative-index modulo idiom. The JS reads
 *     `((i0 % size) + size) % size` on a *float* i0 that is routinely
 *     negative; C does it on an int. Those agree only because C's % truncates
 *     toward zero like JS's does, which is a language fact worth a test rather
 *     than a comment. The swept delays deliberately straddle the wrap point.
 *
 *   - Clamp behaviour at both ends of the delay range, including delays well
 *     past the end of the line and negative delays, which callers do hit when
 *     an LFO oversteps.
 *
 *   - Filter state carrying across process() calls in the oversampler. It is
 *     called per block in the real engine, so the battery calls it four times
 *     in a row and concatenates, rather than once over a long buffer.
 *
 * The shapers are pure polynomials and a clamp. No libm in the nonlinearity on
 * purpose: if the shaper called tanh() then libm spread inside the *stimulus*
 * to the filters would be indistinguishable from divergence in the code under
 * test, which is the same trap parity-io.h avoids for the input signal.
 *
 * Usage: parity-delay-line <out.bin>
 */

#include "brokodr/dsp/delay-line.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

#define MAX_N 4096
#define MAX_BUF 8192
#define MAX_BLOCK 256

static double sig[MAX_N];
static double payload[MAX_N * 2];
static float storage[MAX_BUF];
static float f32pay[MAX_BUF];
static float in_block[MAX_BLOCK * 4];
static float out_block[MAX_BLOCK * 4];
static float up_store[MAX_BLOCK * 4];

/* --- the shapers, mirrored exactly in the JS runner -------------------- */

enum { SHAPE_IDENTITY = 0, SHAPE_CLAMP = 1, SHAPE_CUBIC = 2 };

static double shape_identity(double x, void *user) {
  (void)user;
  return x;
}

static double shape_clamp(double x, void *user) {
  (void)user;
  return bk_clamp(x, -1.0, 1.0);
}

/* x - x^3/3: no branch, no libm, and it generates enough harmonic content
   above Nyquist to make the oversampler's filters matter. */
static double shape_cubic(double x, void *user) {
  (void)user;
  return x - (x * x * x) / 3.0;
}

static bk_shaper_fn shaper_for(int id) {
  if (id == SHAPE_CLAMP) return shape_clamp;
  if (id == SHAPE_CUBIC) return shape_cubic;
  return shape_identity;
}

/* --- delay trajectories ------------------------------------------------- */

/* How the read delay moves over the run. Static exercises one fixed fractional
   offset; SWEEP walks the whole legal range and past both ends so the clamps
   fire; MODULATED is the chorus case, where the delay changes every sample and
   the interpolator is what is actually under test. */
enum { DELAY_FIXED = 0, DELAY_SWEEP = 1, DELAY_MODULATED = 2 };

static double delay_at(int mode, double base, unsigned int i, unsigned int n, int size) {
  switch (mode) {
    case DELAY_SWEEP:
      /* -4 .. size+4, so both clamps are crossed. Exact binary fractions. */
      return -4.0 + ((double)i / (double)n) * ((double)size + 8.0);
    case DELAY_MODULATED:
      /* Triangle around `base`, +/-3.5 samples, period 64. No sin(). */
      {
        const unsigned int ph = i % 64u;
        const double tri = ph < 32u ? (double)ph / 32.0 : 2.0 - (double)ph / 32.0;
        return base + (tri * 2.0 - 1.0) * 3.5;
      }
    default:
      return base;
  }
}

int main(int argc, char **argv) {
  FILE *f;
  int i, j, m;

  if (argc < 2) {
    fprintf(stderr, "usage: %s <out.bin>\n", argv[0]);
    return 2;
  }
  f = fopen(argv[1], "wb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 1;
  }
  bk_parity_open(f);

  /* --- bk_delay_line_size ---------------------------------------------- */

  {
    /* The sizing rule, on its own, over the boundary cases: below the floor of
       4, exactly on it, fractional (so ceil matters), and negative. */
    static const double asks[] = {-10.0, -1.0, 0.0, 0.5, 1.0, 3.0, 4.0, 4.5,
                                  7.0,   7.5,  8.0, 63.5, 64.0, 100.25, 1023.0, 2048.0};
    const int n = (int)(sizeof(asks) / sizeof(asks[0]));
    double p[1];
    int k = 0;
    for (i = 0; i < n; i++) {
      payload[k++] = asks[i];
      payload[k++] = (double)bk_delay_line_size(asks[i]);
    }
    p[0] = 2.0; /* arity marker: pairs of (input, output) */
    bk_parity_emit(f, "size", p, 1, payload, (unsigned int)k, NULL, 0);
  }

  /* --- DelayLine: linear and cubic reads -------------------------------- */

  {
    /* Sizes chosen around the wrap: 8 is smaller than the run, so the write
       pointer laps the buffer many times; 37 is prime, so the wrap never
       aligns with the delay period; 1024 never wraps within the run. */
    static const double maxes[] = {8.0, 37.0, 64.0, 1024.0};
    static const double bases[] = {0.0, 1.0, 3.5, 11.25, 40.0};
    const int n_max = (int)(sizeof(maxes) / sizeof(maxes[0]));
    const int n_base = (int)(sizeof(bases) / sizeof(bases[0]));
    static const int sigs[3] = {BK_SIG_IMPULSE, BK_SIG_NOISE, BK_SIG_RAMP};
    int cubic;

    for (cubic = 0; cubic < 2; cubic++)
      for (i = 0; i < n_max; i++)
        for (j = 0; j < n_base; j++)
          for (m = 0; m < 3; m++) {
            bk_delay_line d;
            double p[7];
            unsigned int t;
            const unsigned int n = 1024u;
            const int dmode = (m == 0) ? DELAY_FIXED : (m == 1 ? DELAY_SWEEP : DELAY_MODULATED);
            const int size = bk_delay_line_size(maxes[i]);
            bk_fill_signal(sig, n, sigs[m]);
            bk_delay_line_init(&d, storage, maxes[i]);
            for (t = 0; t < n; t++) {
              /* Write then read, the order the delay effects use. */
              bk_delay_line_write(&d, sig[t]);
              {
                const double dl = delay_at(dmode, bases[j], t, n, size);
                payload[t] = cubic ? bk_delay_line_read_cubic(&d, dl) : bk_delay_line_read(&d, dl);
              }
            }
            /* The buffer itself, so a lost float32 rounding shows up. */
            for (t = 0; t < (unsigned int)size; t++) f32pay[t] = d.buf[t];
            p[0] = maxes[i];
            p[1] = (double)cubic;
            p[2] = bases[j];
            p[3] = (double)dmode;
            p[4] = (double)sigs[m];
            p[5] = (double)n;
            p[6] = (double)d.w;
            bk_parity_emit(f, "DelayLine", p, 7, payload, n, f32pay, (unsigned int)size);
          }
  }

  /* --- DelayLine: float32 rounding is visible --------------------------- */

  {
    /* Values with more than 24 bits of mantissa, plus the sanitize() bounds.
       Written one per sample and read back at an integer delay, so the only
       thing between input and output is the float32 store. */
    static const double vals[] = {
      0.1,          1.0 / 3.0,     0.7071067811865476, 1.0000000596046448,
      1e-19,        1e-18,         1.0000001e-18,      1e30,
      1.0000001e30, 1e31,          -1.0 / 3.0,         -0.1,
      123456789.5,  0.30000000000000004,
    };
    const int n = (int)(sizeof(vals) / sizeof(vals[0]));
    bk_delay_line d;
    double p[2];
    int k = 0;
    bk_delay_line_init(&d, storage, 64.0);
    for (i = 0; i < n; i++) {
      bk_delay_line_write(&d, vals[i]);
      payload[k++] = vals[i];
      payload[k++] = bk_delay_line_read(&d, 0.0); /* the sample just written */
    }
    /* Infinities and NaN: sanitize() is supposed to swallow all three. */
    bk_delay_line_write(&d, INFINITY);
    payload[k++] = INFINITY;
    payload[k++] = bk_delay_line_read(&d, 0.0);
    bk_delay_line_write(&d, -INFINITY);
    payload[k++] = -INFINITY;
    payload[k++] = bk_delay_line_read(&d, 0.0);
    bk_delay_line_write(&d, NAN);
    payload[k++] = NAN;
    payload[k++] = bk_delay_line_read(&d, 0.0);
    p[0] = 2.0;
    p[1] = 64.0;
    bk_parity_emit(f, "roundtrip", p, 2, payload, (unsigned int)k, NULL, 0);
  }

  /* --- Allpass ---------------------------------------------------------- */

  {
    /* g and delay are public in the JS and callers do mutate them, so the
       battery sets them rather than trusting the constructor defaults. g at
       0.99 is the near-unstable end; the negative g is used by the reverb. */
    static const double maxes[] = {16.0, 53.0, 256.0};
    static const double gs[] = {0.0, 0.5, 0.7, 0.99, -0.5};
    const int n_max = (int)(sizeof(maxes) / sizeof(maxes[0]));
    const int n_g = (int)(sizeof(gs) / sizeof(gs[0]));
    static const int sigs[2] = {BK_SIG_IMPULSE, BK_SIG_NOISE};

    for (i = 0; i < n_max; i++)
      for (j = 0; j < n_g; j++)
        for (m = 0; m < 2; m++) {
          bk_allpass a;
          double p[5];
          unsigned int t;
          const unsigned int n = 2048u;
          bk_fill_signal(sig, n, sigs[m]);
          bk_allpass_init(&a, storage, maxes[i]);
          a.g = gs[j];
          for (t = 0; t < n; t++) payload[t] = bk_allpass_process(&a, sig[t]);
          p[0] = maxes[i];
          p[1] = gs[j];
          p[2] = a.delay;
          p[3] = (double)sigs[m];
          p[4] = (double)n;
          bk_parity_emit(f, "Allpass", p, 5, payload, n, NULL, 0);
        }
  }

  /* --- Allpass: clear() resets it -------------------------------------- */

  {
    /* Run it, clear it, run the same stimulus again: the second half must equal
       the first. A clear() that missed the write pointer passes every test
       above and fails this one. */
    bk_allpass a;
    double p[2];
    unsigned int t;
    const unsigned int n = 512u;
    bk_fill_signal(sig, n, BK_SIG_NOISE);
    bk_allpass_init(&a, storage, 53.0);
    for (t = 0; t < n; t++) payload[t] = bk_allpass_process(&a, sig[t]);
    bk_allpass_clear(&a);
    for (t = 0; t < n; t++) payload[n + t] = bk_allpass_process(&a, sig[t]);
    p[0] = 53.0;
    p[1] = (double)n;
    bk_parity_emit(f, "Allpass.clear", p, 2, payload, n * 2u, NULL, 0);
  }

  /* --- makeLP (bk_lp2) -------------------------------------------------- */

  {
    /* Coefficients first, then the impulse and noise responses. The cutoffs
       above sr * 0.49 are there for the Math.min clamp, and the NaN cutoff is
       there because Math.min(NaN, k) is NaN in JS and a naive C ternary would
       quietly return k instead. */
    static const double rates[] = {48000.0, 44100.0, 192000.0};
    static const double cuts[] = {20.0, 1000.0, 20000.0, 23520.0, 24000.0, 96000.0, 1e9};
    const int n_sr = (int)(sizeof(rates) / sizeof(rates[0]));
    const int n_cut = (int)(sizeof(cuts) / sizeof(cuts[0]));
    static const int sigs[2] = {BK_SIG_IMPULSE, BK_SIG_NOISE};

    for (i = 0; i < n_sr; i++)
      for (j = 0; j < n_cut; j++)
        for (m = 0; m < 2; m++) {
          bk_lp2 lp;
          double p[4];
          unsigned int t;
          const unsigned int n = 1024u;
          bk_fill_signal(sig, n, sigs[m]);
          bk_lp2_init(&lp, rates[i], cuts[j]);
          payload[0] = lp.b0;
          payload[1] = lp.b1;
          payload[2] = lp.b2;
          payload[3] = lp.a1;
          payload[4] = lp.a2;
          for (t = 0; t < n; t++) payload[5 + t] = bk_lp2_process(&lp, sig[t]);
          p[0] = rates[i];
          p[1] = cuts[j];
          p[2] = (double)sigs[m];
          p[3] = (double)n;
          bk_parity_emit(f, "makeLP", p, 4, payload, n + 5u, NULL, 0);
        }

    /* The NaN cutoff on its own: coefficients only, since every sample after
       that is NaN and carries no extra information. */
    {
      bk_lp2 lp;
      double p[4];
      bk_lp2_init(&lp, 48000.0, NAN);
      payload[0] = lp.b0;
      payload[1] = lp.b1;
      payload[2] = lp.b2;
      payload[3] = lp.a1;
      payload[4] = lp.a2;
      p[0] = 48000.0;
      p[1] = NAN;
      p[2] = -1.0;
      p[3] = 0.0;
      bk_parity_emit(f, "makeLP", p, 4, payload, 5u, NULL, 0);
    }
  }

  /* --- Oversampler4x ---------------------------------------------------- */

  {
    static const double rates[] = {48000.0, 44100.0};
    static const int blocks[] = {64, 128};
    static const int shapes[3] = {SHAPE_IDENTITY, SHAPE_CLAMP, SHAPE_CUBIC};
    /* 0.5 stays inside the clamp, 2.0 drives well past it, and 1.0 sits on the
       knee. The 4x zero-stuff gain means the filters see 4x these. */
    static const double gains[] = {0.5, 1.0, 2.0};
    static const int sigs[2] = {BK_SIG_NOISE, BK_SIG_RAMP};
    int bi, si, gi, sg;

    for (i = 0; i < 2; i++)
      for (bi = 0; bi < 2; bi++)
        for (sg = 0; sg < 3; sg++)
          for (gi = 0; gi < 3; gi++)
            for (si = 0; si < 2; si++) {
              bk_oversampler4x os;
              double p[7];
              const int block = blocks[bi];
              const unsigned int n = (unsigned int)block * 4u; /* four calls */
              unsigned int t, b;
              bk_fill_signal(sig, n, sigs[si]);
              bk_oversampler4x_init(&os, up_store, rates[i], block);
              /* Four successive blocks, because the engine calls it per block
                 and the six filters have to carry state across the boundary. */
              for (b = 0; b < 4u; b++) {
                for (t = 0; t < (unsigned int)block; t++)
                  in_block[t] = (float)(sig[b * (unsigned int)block + t] * gains[gi]);
                bk_oversampler4x_process(&os, in_block, (size_t)block, shaper_for(shapes[sg]), NULL,
                                         out_block);
                for (t = 0; t < (unsigned int)block; t++) f32pay[b * (unsigned int)block + t] = out_block[t];
              }
              p[0] = rates[i];
              p[1] = (double)block;
              p[2] = (double)shapes[sg];
              p[3] = gains[gi];
              p[4] = (double)sigs[si];
              p[5] = (double)n;
              p[6] = 4.0; /* calls */
              bk_parity_emit(f, "Oversampler4x", p, 7, NULL, 0, f32pay, n);
            }
  }

  /* --- Oversampler4x: in-place, and reset() ----------------------------- */

  {
    /* The JS says output may alias input. Prove it: same buffer in and out,
       against the same run with separate buffers. */
    bk_oversampler4x os;
    double p[3];
    unsigned int t;
    const int block = 64;
    bk_fill_signal(sig, (unsigned int)block, BK_SIG_NOISE);
    bk_oversampler4x_init(&os, up_store, 48000.0, block);
    for (t = 0; t < (unsigned int)block; t++) in_block[t] = (float)sig[t];
    bk_oversampler4x_process(&os, in_block, (size_t)block, shape_cubic, NULL, in_block);
    for (t = 0; t < (unsigned int)block; t++) f32pay[t] = in_block[t];

    /* reset() then the same stimulus: must reproduce the first block exactly. */
    bk_oversampler4x_reset(&os);
    for (t = 0; t < (unsigned int)block; t++) in_block[t] = (float)sig[t];
    bk_oversampler4x_process(&os, in_block, (size_t)block, shape_cubic, NULL, out_block);
    for (t = 0; t < (unsigned int)block; t++) f32pay[(unsigned int)block + t] = out_block[t];

    p[0] = 48000.0;
    p[1] = (double)block;
    p[2] = (double)SHAPE_CUBIC;
    bk_parity_emit(f, "Oversampler4x.io", p, 3, NULL, 0, f32pay, (unsigned int)block * 2u);
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
