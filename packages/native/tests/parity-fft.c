/*
 * Parity dump for the C port of dsp/core/fft.js.
 *
 * Producer half of the oracle; scripts/verify-fft-parity.mjs is the consumer.
 * See parity-io.h for the stream format.
 *
 * What needs proving here, beyond "the arithmetic matches":
 *
 *   - The working buffers are float32 on both sides. The JS holds re/im, the
 *     twiddles and the window in Float32Array, so every butterfly rounds its
 *     two outputs to float32 before the next stage reads them. A `double` C
 *     buffer would be more accurate and would therefore diverge from the web
 *     build on every bin, which under route (c) is a bug. So the transform
 *     cases emit the whole re/im pair as an f32 payload — if the C ever stops
 *     rounding mid-stage, the payload moves even though the spectrum still
 *     looks plausible.
 *
 *   - The twiddle tables themselves, separately from the transforms they
 *     drive. A table that is off in the last float32 bit is nearly invisible
 *     downstream but is still a divergence, so cos/sin/rev are dumped raw.
 *
 *   - The bit-reversal permutation, at every size from 0 up to 2048. This is
 *     the part a port gets wrong silently: a wrong `levels` still produces a
 *     self-consistent-looking transform.
 *
 *   - Which sizes are accepted. The JS throws on a non-power-of-two, and its
 *     test `(size & (size - 1)) !== 0` lets 0 through, which gives an FFT whose
 *     transform does nothing. The C accepts 0 for exactly that reason, and the
 *     accept/reject table is what pins the two agreeing.
 *
 *   - The lifter clamp in CepstralEnvelope, including the fractional and NaN
 *     cases where the JS loop writes to non-integral Float32Array indices and
 *     the liftering silently becomes a no-op. That is carried over on purpose,
 *     so it has to be measured on purpose.
 *
 * Stimulus is the parity-io.h LCG and exact binary fractions, never sin(): if
 * the input came out of libm, libm spread in the *stimulus* would be
 * indistinguishable from divergence in the code under test.
 *
 * CepstralEnvelope is deliberately not exercised at fftSize 0. The JS survives
 * it — writes to a zero-length Float32Array are dropped and it returns NaN —
 * but in C the same code is an out-of-bounds write, and no caller does it.
 * Reproducing undefined behaviour for its own sake is not parity.
 *
 * Usage: parity-fft <out.bin>
 */

#include "brokodr/dsp/fft.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

#define MAX_FFT 2048
#define MAX_HALF (MAX_FFT / 2)
#define MAX_BINS (MAX_HALF + 1)

/* One FFT object at a time, so one set of tables is enough. */
static float cos_t[MAX_HALF];
static float sin_t[MAX_HALF];
static unsigned int rev_t[MAX_FFT];
static float re_buf[MAX_FFT];
static float im_buf[MAX_FFT];
static float env_buf[MAX_BINS];

static double stim[MAX_FFT];
static double mag[MAX_BINS];
static float pay32[MAX_FFT * 2];
static double pay64[MAX_FFT * 2];

static const int SIZES[] = {0, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048};
static const int N_SIZES = (int)(sizeof(SIZES) / sizeof(SIZES[0]));

/* Sizes the JS constructor is asked about. Powers of two, near-misses, zero and
   negatives — the whole point is that both engines answer identically. */
static const int ACCEPT_ASKS[] = {-16, -8,  -3,  -1, 0,  1,    2,    3,    5,   6,   7,  8,
                                  9,   12,  15,  16, 17, 31,   32,   33,   63,  64,  96, 1000,
                                  1023, 1024, 1025, 2047, 2048};
static const int N_ACCEPT = (int)(sizeof(ACCEPT_ASKS) / sizeof(ACCEPT_ASKS[0]));

int main(int argc, char **argv) {
  FILE *f;
  bk_fft fft;
  int i, k;

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

  /* --- which sizes are legal ------------------------------------------- */
  for (i = 0; i < N_ACCEPT; i++) {
    const int size = ACCEPT_ASKS[i];
    int rc;
    /* Only hand real storage to asks that fit; a rejected ask never touches it,
       and an accepted ask is by construction a power of two <= 2048. */
    rc = bk_fft_init(&fft, size, cos_t, sin_t, rev_t);
    pay64[i * 2] = (double)size;
    pay64[i * 2 + 1] = rc == 0 ? 0.0 : 1.0;
  }
  bk_parity_emit(f, "FFT.accept", NULL, 0, pay64, (unsigned int)(N_ACCEPT * 2), NULL, 0);

  /* --- geometry and tables --------------------------------------------- */
  for (i = 0; i < N_SIZES; i++) {
    const int size = SIZES[i];
    const double params[1] = {(double)size};
    const int half = bk_fft_table_len(size);

    if (bk_fft_init(&fft, size, cos_t, sin_t, rev_t) != 0) {
      fprintf(stderr, "size %d unexpectedly rejected\n", size);
      return 1;
    }

    pay64[0] = (double)fft.size;
    pay64[1] = (double)fft.half;
    pay64[2] = (double)fft.levels;
    bk_parity_emit(f, "FFT.meta", params, 1, pay64, 3, NULL, 0);

    /* rev travels as f64 because it is an exact integer permutation and has to
       match exactly, not to within a tolerance. */
    for (k = 0; k < bk_fft_rev_len(size); k++) pay64[k] = (double)fft.rev[k];
    for (k = 0; k < half; k++) {
      pay32[k] = fft.cos_t[k];
      pay32[half + k] = fft.sin_t[k];
    }
    bk_parity_emit(f, "FFT.tables", params, 1, pay64, (unsigned int)bk_fft_rev_len(size), pay32,
                   (unsigned int)(half * 2));
  }

  /* --- transforms ------------------------------------------------------- */
  {
    static const int t_sizes[] = {0, 2, 4, 8, 16, 64, 256, 1024, 2048};
    static const int t_sigs[] = {BK_SIG_IMPULSE, BK_SIG_STEP, BK_SIG_NOISE, BK_SIG_RAMP,
                                 BK_SIG_ZERO};
    int si, inv, sg;

    for (si = 0; si < (int)(sizeof(t_sizes) / sizeof(t_sizes[0])); si++) {
      const int size = t_sizes[si];
      if (bk_fft_init(&fft, size, cos_t, sin_t, rev_t) != 0) return 1;

      for (inv = 0; inv < 2; inv++) {
        for (sg = 0; sg < (int)(sizeof(t_sigs) / sizeof(t_sigs[0])); sg++) {
          /* params: size, inverse, signal into re, signal into im */
          const double params[4] = {(double)size, (double)inv, (double)t_sigs[sg],
                                    (double)BK_SIG_ZERO};
          bk_fill_signal(stim, (size_t)size, t_sigs[sg]);
          for (i = 0; i < size; i++) {
            re_buf[i] = (float)stim[i];
            im_buf[i] = 0.0f;
          }
          bk_fft_transform(&fft, re_buf, im_buf, inv);
          for (i = 0; i < size; i++) {
            pay32[i] = re_buf[i];
            pay32[size + i] = im_buf[i];
          }
          bk_parity_emit(f, "FFT.transform", params, 4, NULL, 0, pay32,
                         (unsigned int)(size * 2));
        }
      }
    }

    /* A genuinely complex input: a real-only spectrum is conjugate-symmetric
       and would hide a sign error in the imaginary half of the butterfly. */
    {
      static const int c_sizes[] = {8, 64, 256, 2048};
      static const int c_pairs[][2] = {{BK_SIG_NOISE, BK_SIG_RAMP}, {BK_SIG_RAMP, BK_SIG_NOISE}};
      int ci, pi;
      for (ci = 0; ci < 4; ci++) {
        const int size = c_sizes[ci];
        if (bk_fft_init(&fft, size, cos_t, sin_t, rev_t) != 0) return 1;
        for (inv = 0; inv < 2; inv++) {
          for (pi = 0; pi < 2; pi++) {
            const double params[4] = {(double)size, (double)inv, (double)c_pairs[pi][0],
                                      (double)c_pairs[pi][1]};
            bk_fill_signal(stim, (size_t)size, c_pairs[pi][0]);
            for (i = 0; i < size; i++) re_buf[i] = (float)stim[i];
            bk_fill_signal(stim, (size_t)size, c_pairs[pi][1]);
            for (i = 0; i < size; i++) im_buf[i] = (float)stim[i];
            bk_fft_transform(&fft, re_buf, im_buf, inv);
            for (i = 0; i < size; i++) {
              pay32[i] = re_buf[i];
              pay32[size + i] = im_buf[i];
            }
            bk_parity_emit(f, "FFT.transform", params, 4, NULL, 0, pay32,
                           (unsigned int)(size * 2));
          }
        }
      }
    }

    /* Forward, then unnormalised inverse, then the caller's 1/n. Should come
       back to the input; the runner checks that it does, which is the one
       property a bit-for-bit diff against a broken JS could not catch. */
    {
      static const int r_sizes[] = {2, 8, 64, 1024};
      static const int r_sigs[] = {BK_SIG_IMPULSE, BK_SIG_NOISE, BK_SIG_RAMP};
      int ri, rs;
      for (ri = 0; ri < 4; ri++) {
        const int size = r_sizes[ri];
        if (bk_fft_init(&fft, size, cos_t, sin_t, rev_t) != 0) return 1;
        for (rs = 0; rs < 3; rs++) {
          const double params[2] = {(double)size, (double)r_sigs[rs]};
          bk_fill_signal(stim, (size_t)size, r_sigs[rs]);
          for (i = 0; i < size; i++) {
            re_buf[i] = (float)stim[i];
            im_buf[i] = 0.0f;
          }
          bk_fft_transform(&fft, re_buf, im_buf, 0);
          bk_fft_transform(&fft, re_buf, im_buf, 1);
          for (i = 0; i < size; i++) {
            /* float store of a double divide, exactly as the JS would write it
               back into its Float32Array. */
            re_buf[i] = (float)((double)re_buf[i] / (double)size);
            im_buf[i] = (float)((double)im_buf[i] / (double)size);
          }
          for (i = 0; i < size; i++) {
            pay32[i] = re_buf[i];
            pay32[size + i] = im_buf[i];
          }
          bk_parity_emit(f, "FFT.roundtrip", params, 2, NULL, 0, pay32,
                         (unsigned int)(size * 2));
        }
      }
    }
  }

  /* --- Hann window ------------------------------------------------------ */
  {
    static const int h_sizes[] = {1, 2, 3, 4, 8, 16, 64, 256, 1024, 2048};
    int hi;
    for (hi = 0; hi < (int)(sizeof(h_sizes) / sizeof(h_sizes[0])); hi++) {
      const int size = h_sizes[hi];
      const double params[1] = {(double)size};
      /* hannWindow takes any size, power of two or not — it never builds an
         FFT. Size 3 is in here to say so. */
      bk_hann_window(pay32, size);
      bk_parity_emit(f, "hannWindow", params, 1, NULL, 0, pay32, (unsigned int)size);
    }
  }

  /* --- CepstralEnvelope ------------------------------------------------- */
  {
    bk_cepstral_envelope cep;
    /* The interesting lifters: below the clamp floor, at it, ordinary, past
       half-1 so the upper clamp fires, fractional and NaN (both no-ops in the
       JS, see fft.c), and negative. */
    static const double LIFTERS[] = {0.0, 1.0, 2.0, 3.0, 8.0, 32.0, 1e9, 4.5, -5.0};
    static const int c_sizes[] = {4, 8, 16, 64, 256, 1024};
    int ci, li;

    for (ci = 0; ci < (int)(sizeof(c_sizes) / sizeof(c_sizes[0])); ci++) {
      const int size = c_sizes[ci];
      const int bins = bk_cepstral_env_len(size);
      for (li = 0; li < (int)(sizeof(LIFTERS) / sizeof(LIFTERS[0])); li++) {
        const double params[5] = {(double)size, LIFTERS[li], (double)BK_SIG_NOISE, 1.0, 1.0};
        if (bk_cepstral_envelope_init(&cep, size, cos_t, sin_t, rev_t, re_buf, im_buf,
                                      env_buf) != 0)
          return 1;
        bk_fill_signal(mag, (size_t)bins, BK_SIG_NOISE);
        for (i = 0; i < bins; i++) mag[i] = fabs(mag[i]);
        for (i = 0; i < bins; i++) pay32[i] = (float)mag[i];
        {
          const float *env = bk_cepstral_envelope_compute(&cep, pay32, LIFTERS[li]);
          for (i = 0; i < bins; i++) pay32[i] = env[i];
        }
        bk_parity_emit(f, "CepstralEnvelope", params, 5, NULL, 0, pay32, (unsigned int)bins);
      }
    }

    /* NaN travels in the stream as NaN, so it gets its own pass rather than
       sitting in the LIFTERS table, where writing it as a literal would rely on
       NAN being available and finite-math flags being off. */
    for (ci = 0; ci < 2; ci++) {
      const int size = ci == 0 ? 64 : 256;
      const int bins = bk_cepstral_env_len(size);
      const double nan_lifter = strtod("NAN", NULL);
      const double params[5] = {(double)size, nan_lifter, (double)BK_SIG_NOISE, 1.0, 1.0};
      if (bk_cepstral_envelope_init(&cep, size, cos_t, sin_t, rev_t, re_buf, im_buf, env_buf) != 0)
        return 1;
      bk_fill_signal(mag, (size_t)bins, BK_SIG_NOISE);
      for (i = 0; i < bins; i++) pay32[i] = (float)fabs(mag[i]);
      {
        const float *env = bk_cepstral_envelope_compute(&cep, pay32, nan_lifter);
        for (i = 0; i < bins; i++) pay32[i] = env[i];
      }
      bk_parity_emit(f, "CepstralEnvelope", params, 5, NULL, 0, pay32, (unsigned int)bins);
    }

    /* Magnitude spectra that are not noise: silence (every bin hits the 1e-7
       floor inside the log), an impulse, a step, and scales far enough from
       unity to move the log into a different part of its range. */
    {
      static const struct {
        int size;
        double lifter;
        int signal;
        double scale;
      } SPECIALS[] = {
          {256, 8.0, BK_SIG_ZERO, 1.0},
          {256, 8.0, BK_SIG_IMPULSE, 1.0},
          {256, 8.0, BK_SIG_STEP, 1.0},
          {256, 8.0, BK_SIG_RAMP, 1.0},
          {256, 8.0, BK_SIG_NOISE, 1024.0},
          {256, 8.0, BK_SIG_NOISE, 9.5367431640625e-07}, /* 2^-20, exact */
          {64, 2.0, BK_SIG_ZERO, 1.0},
          {1024, 511.0, BK_SIG_NOISE, 1.0}, /* lifter exactly at the upper clamp */
      };
      int spi;
      for (spi = 0; spi < (int)(sizeof(SPECIALS) / sizeof(SPECIALS[0])); spi++) {
        const int size = SPECIALS[spi].size;
        const int bins = bk_cepstral_env_len(size);
        const double params[5] = {(double)size, SPECIALS[spi].lifter, (double)SPECIALS[spi].signal,
                                  SPECIALS[spi].scale, 1.0};
        if (bk_cepstral_envelope_init(&cep, size, cos_t, sin_t, rev_t, re_buf, im_buf, env_buf) !=
            0)
          return 1;
        bk_fill_signal(mag, (size_t)bins, SPECIALS[spi].signal);
        for (i = 0; i < bins; i++) pay32[i] = (float)(fabs(mag[i]) * SPECIALS[spi].scale);
        {
          const float *env = bk_cepstral_envelope_compute(&cep, pay32, SPECIALS[spi].lifter);
          for (i = 0; i < bins; i++) pay32[i] = env[i];
        }
        bk_parity_emit(f, "CepstralEnvelope", params, 5, NULL, 0, pay32, (unsigned int)bins);
      }
    }

    /* Two calls on the same object. compute() is supposed to overwrite all of
       re/im every time; if either engine ever leaves a stale tail behind, the
       second envelope diverges and this is the case that says so. */
    {
      static const int r_sizes[] = {64, 256};
      int ri;
      for (ri = 0; ri < 2; ri++) {
        const int size = r_sizes[ri];
        const int bins = bk_cepstral_env_len(size);
        const double params[5] = {(double)size, 8.0, (double)BK_SIG_NOISE, 1.0, 2.0};
        int call;
        if (bk_cepstral_envelope_init(&cep, size, cos_t, sin_t, rev_t, re_buf, im_buf, env_buf) !=
            0)
          return 1;
        bk_fill_signal(mag, (size_t)bins, BK_SIG_NOISE);
        for (call = 0; call < 2; call++) {
          const double scale = call == 0 ? 1.0 : 0.25;
          float *in = pay32 + MAX_BINS; /* scratch above the payload */
          for (i = 0; i < bins; i++) in[i] = (float)(fabs(mag[i]) * scale);
          {
            const float *env = bk_cepstral_envelope_compute(&cep, in, 8.0);
            for (i = 0; i < bins; i++) pay32[call * bins + i] = env[i];
          }
        }
        bk_parity_emit(f, "CepstralEnvelope.reuse", params, 5, NULL, 0, pay32,
                       (unsigned int)(bins * 2));
      }
    }
  }

  if (!bk_parity_close(f)) {
    fprintf(stderr, "failed to patch record count\n");
    return 1;
  }
  fclose(f);
  fprintf(stderr, "%s: %u records\n", argv[1], bk_parity_records);
  return 0;
}
