/*
 * Parity dump for the C biquad port.
 *
 * This program is the *producer* half of the parity oracle. It runs a battery
 * of filter configurations and writes every parameter, coefficient and output
 * sample to a binary stream. scripts/verify-biquad-parity.mjs then replays the
 * exact same battery through the original dsp/core/biquad.js and diffs.
 *
 * The battery is defined here and only here. The JS side reads the parameters
 * back out of the stream rather than keeping its own copy of the case table,
 * so the two sides cannot drift apart — there is nothing to keep in sync.
 *
 * Stimulus is generated from an integer LCG and exact constants, never from
 * sin(). That is deliberate: if the input signal came out of libm, then libm
 * divergence in the *stimulus* would be indistinguishable from divergence in
 * the *filter*, and the measurement would be worthless. Frequency response is
 * covered separately and analytically via magnitude_db().
 *
 * Usage: parity-biquad <out.bin>
 */

#include "brokodr/dsp/biquad.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAG_POINTS 64
#define MAX_N 4096

enum { KIND_BIQUAD = 1, KIND_CASCADE = 2, KIND_SVF = 3 };
enum { SIG_IMPULSE = 0, SIG_STEP = 1, SIG_NOISE = 2 };

/* Deterministic stimulus. The LCG runs on uint32 so JS can reproduce it
   bit-for-bit with Math.imul and >>> 0; the mantissa never exceeds 24 bits so
   the conversion to double is exact on both sides. */
static void fill_signal(double *dst, size_t n, int signal) {
  size_t i;
  unsigned int state = 0x13572468u;
  for (i = 0; i < n; i++) {
    switch (signal) {
      case SIG_IMPULSE:
        dst[i] = (i == 0) ? 1.0 : 0.0;
        break;
      case SIG_STEP:
        /* Held, then released, so the release transient is exercised too. */
        dst[i] = (i < n / 2) ? 0.5 : 0.0;
        break;
      default:
        state = state * 1664525u + 1013904223u;
        dst[i] = ((double)(state >> 8) / 16777216.0) * 2.0 - 1.0;
        break;
    }
  }
}

static void w_u32(FILE *f, unsigned int v) { fwrite(&v, 4, 1, f); }
static void w_f64(FILE *f, double v) { fwrite(&v, 8, 1, f); }

/* One case: header, coefficients, double-path output, float-path output,
   magnitude response. */
static void emit_case(FILE *f, int kind, double type, double freq, double q, double gain_db,
                      double stages, double active, double mode, int signal, unsigned int n) {
  static double sig[MAX_N];
  static double out_d[MAX_N];
  static float out_f[MAX_N];
  static double mag_freq[MAG_POINTS];
  static double mag_db[MAG_POINTS];

  bk_biquad bq;
  bk_biquad_cascade cs;
  bk_svf svf;
  unsigned int i;
  double coef[5] = {0, 0, 0, 0, 0};

  fill_signal(sig, n, signal);
  for (i = 0; i < n; i++) out_f[i] = (float)sig[i];

  /* Magnitude probe frequencies: 20 Hz .. 20 kHz, log spaced. Written into the
     stream so the JS uses bit-identical frequencies and the comparison isolates
     magnitude_db() itself. */
  for (i = 0; i < MAG_POINTS; i++) {
    double t = (double)i / (double)(MAG_POINTS - 1);
    mag_freq[i] = 20.0 * pow(1000.0, t);
  }

  if (kind == KIND_BIQUAD) {
    bk_biquad_init(&bq, 48000.0);
    bk_biquad_set(&bq, (int)type, freq, q, gain_db);
    coef[0] = bq.b0; coef[1] = bq.b1; coef[2] = bq.b2; coef[3] = bq.a1; coef[4] = bq.a2;
    for (i = 0; i < n; i++) out_d[i] = bk_biquad_process(&bq, sig[i]);
    for (i = 0; i < MAG_POINTS; i++) mag_db[i] = bk_biquad_magnitude_db(&bq, mag_freq[i]);
    /* Fresh instance for the float block path, so it starts from the same
       zero state rather than inheriting the double run's history. */
    bk_biquad_init(&bq, 48000.0);
    bk_biquad_set(&bq, (int)type, freq, q, gain_db);
    bk_biquad_process_block(&bq, out_f, n);
  } else if (kind == KIND_CASCADE) {
    bk_biquad_cascade_init(&cs, 48000.0, (int)stages);
    bk_biquad_cascade_set(&cs, (int)type, freq, q, gain_db);
    if (active >= 0) bk_biquad_cascade_set_active(&cs, (int)active);
    coef[0] = cs.stages[0].b0; coef[1] = cs.stages[0].b1; coef[2] = cs.stages[0].b2;
    coef[3] = cs.stages[0].a1; coef[4] = cs.stages[0].a2;
    for (i = 0; i < n; i++) out_d[i] = bk_biquad_cascade_process(&cs, sig[i]);
    for (i = 0; i < MAG_POINTS; i++) mag_db[i] = bk_biquad_cascade_magnitude_db(&cs, mag_freq[i]);
    bk_biquad_cascade_init(&cs, 48000.0, (int)stages);
    bk_biquad_cascade_set(&cs, (int)type, freq, q, gain_db);
    if (active >= 0) bk_biquad_cascade_set_active(&cs, (int)active);
    bk_biquad_cascade_process_block(&cs, out_f, n);
  } else {
    bk_svf_init(&svf, 48000.0);
    bk_svf_set(&svf, freq, q);
    coef[0] = svf.g; coef[1] = svf.k; coef[2] = svf.a1; coef[3] = svf.a2; coef[4] = svf.a3;
    for (i = 0; i < n; i++) out_d[i] = bk_svf_process(&svf, sig[i], (int)mode);
    for (i = 0; i < MAG_POINTS; i++) mag_db[i] = 0.0; /* SVF has no magnitude_db */
    bk_svf_init(&svf, 48000.0);
    bk_svf_set(&svf, freq, q);
    bk_svf_process_block(&svf, out_f, n, (int)mode);
  }

  w_u32(f, (unsigned int)kind);
  w_u32(f, (unsigned int)signal);
  w_u32(f, n);
  w_u32(f, 0u); /* pad, keeps the doubles 8-byte aligned */
  w_f64(f, type);
  w_f64(f, freq);
  w_f64(f, q);
  w_f64(f, gain_db);
  w_f64(f, stages);
  w_f64(f, active);
  w_f64(f, mode);
  for (i = 0; i < 5; i++) w_f64(f, coef[i]);
  fwrite(out_d, 8, n, f);
  fwrite(out_f, 4, n, f);
  fwrite(mag_freq, 8, MAG_POINTS, f);
  fwrite(mag_db, 8, MAG_POINTS, f);
}

int main(int argc, char **argv) {
  /* freq / q / gainDb triplets, chosen to hit the places biquads misbehave:
     near-DC where transposed-DF-II earns its keep, near-Nyquist where the
     clamp bites, very low Q, very high Q, and heavy shelf gain both ways. */
  static const double params[][3] = {
    {20.0, 0.707, 0.0},
    {100.0, 0.5, 6.0},
    {1000.0, 1.2, 12.0},
    {1000.0, 0.02, -12.0},   /* q below the 0.02 floor, exercises the clamp */
    {5000.0, 8.0, -24.0},
    {23900.0, 0.707, 3.0},   /* above nyq*0.995, exercises the freq clamp */
    {5.0, 4.0, -6.0},        /* below the 10 Hz floor */
  };
  const int nparams = (int)(sizeof(params) / sizeof(params[0]));
  const int signals[3] = {SIG_IMPULSE, SIG_STEP, SIG_NOISE};
  const unsigned int lens[3] = {512u, 512u, 4096u};

  FILE *f;
  int t, p, s, st, m;
  unsigned int cases = 0;

  if (argc < 2) {
    fprintf(stderr, "usage: parity-biquad <out.bin>\n");
    return 2;
  }
  f = fopen(argv[1], "wb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 1;
  }

  fwrite("BKPARITY", 1, 8, f);
  w_u32(f, 2u);  /* format version */
  w_u32(f, 0u);  /* case count, patched below */

  for (t = 0; t <= 7; t++)
    for (p = 0; p < nparams; p++)
      for (s = 0; s < 3; s++) {
        emit_case(f, KIND_BIQUAD, (double)t, params[p][0], params[p][1], params[p][2],
                  -1.0, -1.0, -1.0, signals[s], lens[s]);
        cases++;
      }

  /* An unknown type must fall through to the passthrough coefficients, same as
     the JS default branch. */
  emit_case(f, KIND_BIQUAD, 99.0, 1000.0, 0.707, 0.0, -1.0, -1.0, -1.0, SIG_NOISE, 4096u);
  cases++;

  for (st = 1; st <= 4; st++)
    for (p = 0; p < nparams; p++) {
      emit_case(f, KIND_CASCADE, (double)BK_FILTER_LOWPASS, params[p][0], params[p][1],
                params[p][2], (double)st, -1.0, -1.0, SIG_NOISE, 4096u);
      cases++;
    }
  /* Partial cascades: stages allocated but only some engaged. */
  for (st = 0; st <= 4; st++) {
    emit_case(f, KIND_CASCADE, (double)BK_FILTER_HIGHPASS, 200.0, 0.707, 0.0, 4.0,
              (double)st, -1.0, SIG_NOISE, 4096u);
    cases++;
  }
  /* setActive beyond the stage count must clamp, not overrun. */
  emit_case(f, KIND_CASCADE, (double)BK_FILTER_PEAK, 800.0, 1.0, 9.0, 2.0, 7.0, -1.0,
            SIG_NOISE, 4096u);
  cases++;

  for (m = 0; m <= 2; m++)
    for (p = 0; p < nparams; p++)
      for (s = 0; s < 3; s++) {
        emit_case(f, KIND_SVF, -1.0, params[p][0], params[p][1], 0.0, -1.0, -1.0, (double)m,
                  signals[s], lens[s]);
        cases++;
      }

  if (fseek(f, 12, SEEK_SET) != 0) {
    fprintf(stderr, "cannot patch case count\n");
    fclose(f);
    return 1;
  }
  w_u32(f, cases);
  fclose(f);
  fprintf(stderr, "wrote %u cases to %s\n", cases, argv[1]);
  return 0;
}
