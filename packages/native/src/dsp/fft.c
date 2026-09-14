/*
 * Bro.Kodr DSP core — FFT / Hann / cepstral envelope. C port of fft.js.
 *
 * Line-for-line against the JS, including the float32 stores. Read fft.h first
 * if you are wondering why the working buffers are not double.
 */

#include "brokodr/dsp/fft.h"

#include <math.h>

/* --- FFT ---------------------------------------------------------------- */

int bk_fft_table_len(int size) {
  return size > 0 ? size >> 1 : 0;
}

int bk_fft_rev_len(int size) {
  return size > 0 ? size : 0;
}

int bk_fft_init(bk_fft *f, int size, float *cos_storage, float *sin_storage,
                unsigned int *rev_storage) {
  int i, j, levels;

  if (size < 0) return -1;
  /* Mirrors `if ((size & (size - 1)) !== 0) throw`. size == 0 passes, as in the
     JS, and gives a transform that does nothing. */
  if ((size & (size - 1)) != 0) return -1;

  f->size = size;
  f->half = size >> 1;

  /* JS: Math.log2(size) | 0. For size 0 that is -Infinity | 0 == 0; counting
     set-bit positions gives 0 for both 0 and 1, which matches. */
  levels = 0;
  while ((1 << levels) < size) levels++;
  /* Belt-and-braces invariant, not a behaviour change: for every input the
     power-of-two check above lets through, (1 << levels) == size exactly (and
     size == 0 gives levels == 0). It can never fire for a legal size. It is
     here because the consequence of it being false is not "wrong numbers" —
     the bit-reversal below would emit indices up to 2 * size and the transform
     would write off the end of re/im. In a realtime audio host that is a
     crash, not a glitch, so refuse to initialise instead. */
  if (size != 0 && (1 << levels) != size) return -1;
  f->levels = levels;

  f->cos_t = cos_storage;
  f->sin_t = sin_storage;
  f->rev = rev_storage;

  /* Twiddles. The multiply/divide order is the JS's exactly — (2 * PI * i) / size,
     not 2 * PI * (i / size) — because the two do not round identically. */
  for (i = 0; i < f->half; i++) {
    f->cos_t[i] = (float)cos((2.0 * BK_PI * (double)i) / (double)size);
    f->sin_t[i] = (float)sin((2.0 * BK_PI * (double)i) / (double)size);
  }

  for (i = 0; i < size; i++) {
    int x = i;
    unsigned int r = 0u;
    for (j = 0; j < levels; j++) {
      r = (r << 1) | (unsigned int)(x & 1);
      x >>= 1;
    }
    f->rev[i] = r;
  }
  return 0;
}

void bk_fft_transform(const bk_fft *f, float *re, float *im, int inverse) {
  const int n = f->size;
  const unsigned int *rev = f->rev;
  double sign;
  int i, sz;

  for (i = 0; i < n; i++) {
    int j = (int)rev[i];
    if (j > i) {
      float t = re[i];
      re[i] = re[j];
      re[j] = t;
      t = im[i];
      im[i] = im[j];
      im[j] = t;
    }
  }

  sign = inverse ? 1.0 : -1.0;
  for (sz = 2; sz <= n; sz <<= 1) {
    const int halfsize = sz >> 1;
    const int step = n / sz;
    for (i = 0; i < n; i += sz) {
      int j = i;
      int k = 0;
      for (; j < i + halfsize; j++, k += step) {
        const double c = (double)f->cos_t[k];
        const double s = sign * (double)f->sin_t[k];
        const int l = j + halfsize;
        /* Doubles in, float32 out — the rounding here is load-bearing. */
        const double tre = (double)re[l] * c - (double)im[l] * s;
        const double tim = (double)re[l] * s + (double)im[l] * c;
        re[l] = (float)((double)re[j] - tre);
        im[l] = (float)((double)im[j] - tim);
        /* re[j]/im[j] still hold their pre-butterfly values: l != j always,
           since halfsize >= 1. Same read-then-write order as the JS. */
        re[j] = (float)((double)re[j] + tre);
        im[j] = (float)((double)im[j] + tim);
      }
    }
  }
}

/* --- Hann window -------------------------------------------------------- */

void bk_hann_window(float *w, int size) {
  int i;
  for (i = 0; i < size; i++) {
    w[i] = (float)(0.5 - 0.5 * cos((2.0 * BK_PI * (double)i) / (double)size));
  }
}

/* --- CepstralEnvelope --------------------------------------------------- */

int bk_cepstral_env_len(int fft_size) {
  return fft_size > 0 ? (fft_size >> 1) + 1 : 1;
}

int bk_cepstral_envelope_init(bk_cepstral_envelope *c, int fft_size,
                              float *cos_storage, float *sin_storage,
                              unsigned int *rev_storage, float *re_storage,
                              float *im_storage, float *env_storage) {
  int i;
  if (bk_fft_init(&c->fft, fft_size, cos_storage, sin_storage, rev_storage) != 0) return -1;
  c->n = fft_size;
  c->re = re_storage;
  c->im = im_storage;
  c->env = env_storage;
  /* new Float32Array(...) is zero-filled; the compute() path leaves the top
     half of re/im untouched for small sizes, so start from the same place. */
  for (i = 0; i < fft_size; i++) {
    c->re[i] = 0.0f;
    c->im[i] = 0.0f;
  }
  for (i = 0; i < bk_cepstral_env_len(fft_size); i++) c->env[i] = 0.0f;
  return 0;
}

const float *bk_cepstral_envelope_compute(bk_cepstral_envelope *c, const float *mag,
                                          double lifter) {
  const int n = c->n;
  const int half = n >> 1;
  float *re = c->re;
  float *im = c->im;
  double inv, ld;
  int i;

  for (i = 0; i <= half; i++) {
    const double v = log((double)mag[i] + 1e-7);
    re[i] = (float)v;
    im[i] = 0.0f;
    if (i > 0 && i < half) {
      re[n - i] = (float)v;
      im[n - i] = 0.0f;
    }
  }

  bk_fft_transform(&c->fft, re, im, 1);

  /* JS: const L = Math.max(2, Math.min(lifter, half - 1)).
     bk_max/bk_min, not ternaries, so a NaN lifter stays NaN — see utils.h. */
  ld = bk_max(2.0, bk_min(lifter, (double)half - 1.0));
  /* And here is the quirk the header warns about. The JS then does
       for (let i = L; i <= n - L; i++) { re[i] = 0; im[i] = 0; }
     If L is fractional, every index is fractional, every write goes to a
     non-canonical property on a Float32Array and is silently dropped — the
     liftering is a no-op. If L is NaN the loop condition is false immediately,
     also a no-op. Only an integral L actually zeroes anything, so that is the
     only case that does anything here. Faithful, not clever. */
  if (!isnan(ld) && ld == floor(ld)) {
    const int L = (int)ld;
    /* ld is >= 2 and <= max(2, half - 1), so L and n - L stay in range. */
    for (i = L; i <= n - L; i++) {
      re[i] = 0.0f;
      im[i] = 0.0f;
    }
  }

  bk_fft_transform(&c->fft, re, im, 0);

  inv = 1.0 / (double)n;
  for (i = 0; i <= half; i++) {
    c->env[i] = (float)exp((double)re[i] * inv);
  }
  return c->env;
}
