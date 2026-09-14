'worklet';
/**
 * Bro.Kodr DSP core — FFT and STFT scaffolding.
 *
 * Iterative in-place radix-2 FFT with precomputed twiddles and bit-reversal table.
 * Allocation happens only in the constructor; transform() is allocation-free so it is
 * safe on the audio thread. This is the substrate for pitch shifting, formant shifting
 * and the spectrum analyser.
 */

export class FFT {
  constructor(size) {
    if ((size & (size - 1)) !== 0) throw new Error("FFT size must be a power of two");
    this.size = size;
    this.half = size >> 1;
    this.levels = Math.log2(size) | 0;

    this.cos = new Float32Array(this.half);
    this.sin = new Float32Array(this.half);
    for (let i = 0; i < this.half; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((2 * Math.PI * i) / size);
    }

    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let j = 0; j < this.levels; j++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.rev[i] = r;
    }
  }

  /**
   * In-place complex FFT. re/im are Float32Array(size).
   * inverse=true computes the unnormalised inverse (caller scales by 1/size).
   */
  transform(re, im, inverse = false) {
    const n = this.size;
    const rev = this.rev;

    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }

    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const halfsize = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + halfsize; j++, k += step) {
          const c = this.cos[k];
          const s = sign * this.sin[k];
          const l = j + halfsize;
          const tre = re[l] * c - im[l] * s;
          const tim = re[l] * s + im[l] * c;
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}

/** Periodic Hann window — correct COLA behaviour for overlap-add at hop = N/4. */
export function hannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
}

/**
 * Cepstral spectral-envelope estimator.
 *
 * Envelope = IFFT of log-magnitude, truncated to `lifter` coefficients (low-time
 * liftering), then exponentiated. Separating envelope (formants / timbre) from the
 * fine structure (pitch harmonics) is what makes independent formant shifting possible:
 * we divide the envelope out, warp it, and multiply it back.
 */
export class CepstralEnvelope {
  constructor(fftSize) {
    this.n = fftSize;
    this.fft = new FFT(fftSize);
    this.re = new Float32Array(fftSize);
    this.im = new Float32Array(fftSize);
    this.env = new Float32Array((fftSize >> 1) + 1);
  }

  /**
   * @param mag Float32Array(n/2+1) magnitude spectrum
   * @param lifter number of cepstral coefficients to keep (higher = follows harmonics more)
   * @returns Float32Array(n/2+1) smooth spectral envelope (linear magnitude)
   */
  compute(mag, lifter) {
    const n = this.n;
    const half = n >> 1;
    const re = this.re;
    const im = this.im;

    for (let i = 0; i <= half; i++) {
      const v = Math.log(mag[i] + 1e-7);
      re[i] = v;
      im[i] = 0;
      if (i > 0 && i < half) {
        re[n - i] = v;
        im[n - i] = 0;
      }
    }

    this.fft.transform(re, im, true);

    const L = Math.max(2, Math.min(lifter, half - 1));
    for (let i = L; i <= n - L; i++) {
      re[i] = 0;
      im[i] = 0;
    }

    this.fft.transform(re, im, false);

    const inv = 1 / n;
    for (let i = 0; i <= half; i++) {
      this.env[i] = Math.exp(re[i] * inv);
    }
    return this.env;
  }
}
