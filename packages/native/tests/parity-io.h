/*
 * Shared plumbing for the DSP parity producers.
 *
 * Each ported module gets a parity-<module>.c that runs a battery of cases and
 * dumps them here; scripts/verify-<module>-parity.mjs replays the identical
 * battery through the original JavaScript and diffs. The battery is defined in
 * the C and only in the C — the JS reads the parameters back out of the stream
 * rather than keeping its own copy of the case table, so the two sides cannot
 * drift apart, because there is nothing to keep in sync.
 *
 * Stream format ("BKPARITY", version 3). Little-endian throughout, which is
 * every target the app ships to (x86-64 and arm64, native and wasm):
 *
 *   magic[8]  "BKPARITY"
 *   u32       version = 3
 *   u32       record count (patched on close)
 *   records...
 *
 * Each record:
 *
 *   char[32]  name, NUL-padded — which object and which path was exercised
 *   u32       n_params
 *   u32       n_f64
 *   u32       n_f32
 *   u32       pad (keeps the f64 payload 8-byte aligned)
 *   f64[n_params]   the case parameters, read back by the JS side
 *   f64[n_f64]      the double-precision result
 *   f32[n_f32]      the float32-path result
 *   pad to a multiple of 8
 *
 * Version 3 is generic on purpose. Version 2 (parity-biquad.c) hard-codes the
 * biquad's field layout; rather than churn a module that is already verified
 * green, the reader supports both and every module from here on uses 3.
 *
 * Stimulus comes from an integer LCG and exact constants, never from sin().
 * That is deliberate: if the input signal came out of libm then libm divergence
 * in the *stimulus* would be indistinguishable from divergence in the code
 * under test, and the measurement would be worthless.
 */

#ifndef BROKODR_PARITY_IO_H
#define BROKODR_PARITY_IO_H

#include <stdio.h>
#include <string.h>

#define BK_PARITY_VERSION 3u
#define BK_PARITY_NAME_LEN 32

enum {
  BK_SIG_IMPULSE = 0,
  BK_SIG_STEP = 1,
  BK_SIG_NOISE = 2,
  BK_SIG_RAMP = 3, /* periodic, exact binary fractions — for the pitch tracker */
  BK_SIG_ZERO = 4  /* silence, to reach the "no energy" early-out branches */
};

static unsigned int bk_parity_records = 0;

/* A run-time 0.0 / 0.0, for injecting NaN into test input. A constant 0.0 / 0.0 does not
   compile on MSVC (C2124), and NAN has the opposite sign bit to what gcc folds 0.0 / 0.0
   to, so the volatile keeps every toolchain's pinned bits unchanged (see utils.c). */
static inline double bk_test_nan(void) {
  volatile double z = 0.0;
  return z / z;
}

static void bk_w_u32(FILE *f, unsigned int v) { fwrite(&v, 4, 1, f); }

/* Deterministic stimulus. The LCG runs on uint32 so JS can reproduce it bit for
   bit with Math.imul and >>> 0; the mantissa never exceeds 24 bits, so the
   conversion to double is exact on both sides. */
static void bk_fill_signal(double *dst, size_t n, int signal) {
  size_t i;
  unsigned int state = 0x13572468u;
  for (i = 0; i < n; i++) {
    switch (signal) {
      case BK_SIG_IMPULSE:
        dst[i] = (i == 0) ? 1.0 : 0.0;
        break;
      case BK_SIG_STEP:
        /* Held, then released, so the release transient is exercised too. */
        dst[i] = (i < n / 2) ? 0.5 : 0.0;
        break;
      case BK_SIG_RAMP:
        /* Sawtooth, period 256 (187.5 Hz at 48 kHz). Exact binary fractions:
           no rounding anywhere in the stimulus. */
        dst[i] = ((double)(i % 256) / 128.0) - 1.0;
        break;
      case BK_SIG_ZERO:
        dst[i] = 0.0;
        break;
      default:
        state = state * 1664525u + 1013904223u;
        dst[i] = ((double)(state >> 8) / 16777216.0) * 2.0 - 1.0;
        break;
    }
  }
}

static void bk_parity_open(FILE *f) {
  fwrite("BKPARITY", 1, 8, f);
  bk_w_u32(f, BK_PARITY_VERSION);
  bk_w_u32(f, 0u); /* record count, patched by bk_parity_close */
  bk_parity_records = 0;
}

static void bk_parity_emit(FILE *f, const char *name, const double *params, unsigned int n_params,
                           const double *out64, unsigned int n_f64, const float *out32,
                           unsigned int n_f32) {
  char nm[BK_PARITY_NAME_LEN];
  unsigned int written, pad;

  memset(nm, 0, sizeof(nm));
  strncpy(nm, name, sizeof(nm) - 1);
  fwrite(nm, 1, sizeof(nm), f);
  bk_w_u32(f, n_params);
  bk_w_u32(f, n_f64);
  bk_w_u32(f, n_f32);
  bk_w_u32(f, 0u);
  if (n_params) fwrite(params, 8, n_params, f);
  if (n_f64) fwrite(out64, 8, n_f64, f);
  if (n_f32) fwrite(out32, 4, n_f32, f);
  written = n_f32 * 4u;
  pad = (8u - (written % 8u)) % 8u;
  while (pad--) fputc(0, f);
  bk_parity_records++;
}

static int bk_parity_close(FILE *f) {
  if (fseek(f, 12, SEEK_SET) != 0) return 0;
  bk_w_u32(f, bk_parity_records);
  return 1;
}

#endif /* BROKODR_PARITY_IO_H */
