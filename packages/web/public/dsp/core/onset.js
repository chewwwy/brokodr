/**
 * Bro.Kodr DSP core — onset detection.
 *
 * Finds the moment a hit *starts* in a stream of audio, and describes its timbre in a
 * handful of cheap numbers. Two callers, one implementation:
 *
 *   - BROBEATS slicing (now): run a finished recording through it offline to chop a
 *     breakbeat or a mouth-drum take across the pads at its transients.
 *   - Smart Voice (Phase 4): run the live mic through the identical code so a beatbox
 *     hit fires a pad. The features this produces are exactly what the classifier needs.
 *
 * Writing it streaming-first is what makes that possible. Nothing here looks ahead, keeps
 * the whole signal, or allocates once running, so the offline pass and the live pass are
 * genuinely the same code path rather than two implementations that drift apart.
 *
 * ## Why not the FFT
 *
 * `spectral.js` works on 1024-point frames. At 48k that is a 21 ms window, and a spectral
 * flux detector built on it cannot place an onset tighter than that — you would hear the
 * kit lag behind your mouth. The whole detector here is time-domain: three band-split
 * envelope followers and a derivative. A hit is reported in the same block it arrives in,
 * so latency is one block — under 3 ms at 128 frames. Measured against synthetic kit
 * pieces it places the transient within 1 ms of true (see `scripts/verify-dsp.mjs`).
 *
 * ## How the detection actually works
 *
 *   signal -> split into low / mid / high
 *   each band -> fast envelope (1.5 ms attack)
 *   onset when any band's envelope is well above what that same band's envelope was
 *   8 ms ago, the full-band level is above the noise floor, and the refractory period
 *   since the last hit has elapsed.
 *
 * Two choices here matter, and both were made because the obvious version failed a test:
 *
 * **Per-band, not full-band.** A hi-hat landing 250 ms after a kick is inaudible to a
 * full-band detector — the kick is still ringing, and the hat is quiet by comparison, so
 * the full-band envelope barely moves. In the high band the kick does not exist and the
 * hat is the loudest thing that has ever happened. Taking the *max* rise across the three
 * bands rather than the sum is the whole point: a hit only has to be new in one band to
 * be a new hit.
 *
 * **Compared against 8 ms ago, not against a slow envelope.** The textbook version is a
 * fast/slow envelope pair, and it fails on a drum roll: after a loud kick, a slow envelope
 * with a musical release time is still sitting near that kick's peak, so the next hit
 * 60 ms later only reaches ~1.5x it and never clears the threshold. A reference that is
 * simply the same envelope a moment ago decays with the music instead of lagging behind
 * it, so consecutive hits are compared against the gap between them.
 *
 * Using a *ratio* rather than an absolute level is what makes it work on a quiet performer
 * and a loud one without a threshold knob per session: it fires on change, not on loudness.
 * The refractory period is what stops one hit's body re-triggering as several — 45 ms by
 * default, which caps the detector at ~22 hits a second.
 *
 * ## Features
 *
 * At each onset, four numbers are captured from a short window *after* the transient:
 * the three band energies (normalised so they sum to 1, which makes them level-invariant)
 * and the zero-crossing rate. A kick is nearly all low band with a very low ZCR; a hi-hat
 * is nearly all high band with a high one; a snare sits in the middle with a broad
 * spread. That separation is what a nearest-centroid classifier needs, and it is why no
 * ML model is required for this job.
 */

import { Biquad, FilterType } from "./biquad.js";
import { EnvelopeFollower } from "./utils.js";

/** Numbers per onset in the feature buffer: low, mid, high, zcr. */
export const FEATURE_COUNT = 4;

/** Most onsets one process() call will report. A block is a few ms; this is generous. */
const MAX_HITS_PER_BLOCK = 8;

/** Slots in the commit ring. See `commitCount` for why the ring exists at all. */
const COMMIT_RING = 16;

/**
 * How far back each band's envelope is compared against, in ms.
 *
 * This is the single most consequential constant in the file. Too short and the fast
 * envelope has not moved enough between now and then for any hit to clear the threshold;
 * too long and the reference reaches back past the previous hit, so a drum roll reads as
 * one sustained event. 8 ms is about two cycles of the lowest band and comfortably
 * shorter than the 45 ms refractory period, which means consecutive hits always compare
 * against the gap between them rather than against each other.
 */
const LAG_MS = 8;

export const ONSET_DEFAULTS = {
  /** How far the fast envelope must exceed the slow one to count as a hit. */
  sensitivity: 1.9,
  /** Absolute noise gate in dBFS — below this nothing is an onset, however sharp. */
  floorDb: -48,
  /** Refractory period: the shortest gap between two hits, in ms. */
  minGapMs: 45,
  /** Feature window after the transient, in ms. Long enough to read timbre, short
   *  enough to finish before the next hit can arrive. */
  featureMs: 22,
  /** Crossover between the low and mid bands, Hz. */
  lowCrossHz: 180,
  /** Crossover between the mid and high bands, Hz. */
  highCrossHz: 5000,
};

/**
 * Streaming onset detector.
 *
 * Feed it mono blocks. After each `process()` call, `count` onsets were found this block;
 * their absolute frame positions are in `positions`, their strengths in `strengths`, and
 * their features in `features` (FEATURE_COUNT numbers per hit, hit-major).
 *
 * A hit is reported at the moment it is *detected*, but its features are only complete
 * `featureMs` later. Rather than delay every report, the feature window is filled in as
 * the audio arrives and the hit is reported immediately with the features captured so
 * far — `pendingFeature` says whether the most recent hit is still being measured. For
 * offline slicing this never matters; live, it is the difference between a pad that
 * fires on time and one that fires 22 ms late.
 */
export class OnsetDetector {
  constructor(sampleRate, opts) {
    this.sr = sampleRate || 48000;

    this.sensitivity = ONSET_DEFAULTS.sensitivity;
    this.floorDb = ONSET_DEFAULTS.floorDb;
    this.minGapMs = ONSET_DEFAULTS.minGapMs;
    this.featureMs = ONSET_DEFAULTS.featureMs;
    this.lowCrossHz = ONSET_DEFAULTS.lowCrossHz;
    this.highCrossHz = ONSET_DEFAULTS.highCrossHz;
    if (opts) for (const k in opts) this.setParam(k, opts[k]);

    // Band split. Low and high are second-order; the mid is what is left, taken as a
    // band-pass rather than a subtraction so a phase-cancelling notch cannot appear at
    // the crossovers.
    this.lowFilter = new Biquad(this.sr);
    this.midFilter = new Biquad(this.sr);
    this.highFilter = new Biquad(this.sr);

    // One fast envelope per band. See the header note on why detection is per-band
    // rather than on the full signal.
    this.fastLow = new EnvelopeFollower(this.sr, 1.5, 40, false);
    this.fastMid = new EnvelopeFollower(this.sr, 1.5, 40, false);
    this.fastHigh = new EnvelopeFollower(this.sr, 1.5, 40, false);
    // Full-band level, used only as the noise gate — detection is per-band, but whether
    // there is any signal at all worth looking at is a whole-signal question.
    this.level = new EnvelopeFollower(this.sr, 1.5, 40, false);

    // Each band's envelope from LAG_MS ago. A hit is a rise against what that same band
    // was doing a moment earlier, which is a reference that decays with the music instead
    // of lagging behind it.
    this.lagLen = Math.max(1, (LAG_MS * 0.001 * this.sr) | 0);
    this.lagPos = 0;
    this.histLow = new Float32Array(this.lagLen);
    this.histMid = new Float32Array(this.lagLen);
    this.histHigh = new Float32Array(this.lagLen);

    // Band energy accumulators for the feature window.
    this.accLow = 0;
    this.accMid = 0;
    this.accHigh = 0;
    this.accZc = 0;
    this.accFrames = 0;
    this.lastSign = 0;

    this.frames = 0;
    this.lastHitFrame = -1e9;
    this.windowLeft = 0;
    this.pendingFeature = false;
    this.pendingIndex = -1;

    this.count = 0;
    this.positions = new Int32Array(MAX_HITS_PER_BLOCK);
    this.strengths = new Float32Array(MAX_HITS_PER_BLOCK);
    this.features = new Float32Array(MAX_HITS_PER_BLOCK * FEATURE_COUNT);

    // A hit's features are only finished `featureMs` after it is reported, which is
    // several blocks later — by which time `features` has been re-indexed from zero for
    // the newer block and the old slot may have been overwritten. So every completed
    // measurement is *also* written, in hit order, to this ring. A caller that wants
    // finished features (the offline slicer, and any classifier that can wait a frame)
    // watches `commitCount` climb and drains the ring; a caller that wants the hit the
    // instant it happens (live pad triggering) ignores the ring and eats the partial
    // features in `features`. Both are served without either delaying the other.
    this.commitCount = 0;
    this.commitRing = new Float32Array(COMMIT_RING * FEATURE_COUNT);

    this.#refresh();
  }

  setParam(key, value) {
    if (!Number.isFinite(value)) return;
    if (key === "sensitivity") this.sensitivity = Math.max(1.05, Math.min(8, value));
    else if (key === "floorDb") this.floorDb = Math.max(-90, Math.min(-6, value));
    else if (key === "minGapMs") this.minGapMs = Math.max(5, Math.min(500, value));
    else if (key === "featureMs") this.featureMs = Math.max(3, Math.min(120, value));
    else if (key === "lowCrossHz") this.lowCrossHz = Math.max(40, Math.min(1000, value));
    else if (key === "highCrossHz") this.highCrossHz = Math.max(1500, Math.min(16000, value));
    else return;
    if (this.lowFilter) this.#refresh();
  }

  reset() {
    this.lowFilter.reset();
    this.midFilter.reset();
    this.highFilter.reset();
    this.fastLow.reset();
    this.fastMid.reset();
    this.fastHigh.reset();
    this.level.reset();
    this.histLow.fill(0);
    this.histMid.fill(0);
    this.histHigh.fill(0);
    this.lagPos = 0;
    this.accLow = 0;
    this.accMid = 0;
    this.accHigh = 0;
    this.accZc = 0;
    this.accFrames = 0;
    this.lastSign = 0;
    this.frames = 0;
    this.lastHitFrame = -1e9;
    this.windowLeft = 0;
    this.pendingFeature = false;
    this.pendingIndex = -1;
    this.count = 0;
    this.commitCount = 0;
  }

  /**
   * Processes one mono block. Returns the number of onsets found in it.
   *
   * `block` is read, never written — the caller's audio is untouched, which is what lets
   * the live path tap the signal without being in its way.
   */
  process(block, frames) {
    const n = frames === undefined ? block.length : frames;
    const floor = Math.pow(10, this.floorDb / 20);
    const gapFrames = (this.minGapMs * 0.001 * this.sr) | 0;
    const windowFrames = Math.max(1, (this.featureMs * 0.001 * this.sr) | 0);
    let count = 0;

    for (let i = 0; i < n; i++) {
      const x = block[i];
      // A NaN reaching the envelope followers poisons them permanently, and the only
      // symptom is a detector that silently never fires again.
      const s = Number.isFinite(x) ? x : 0;

      const lo = this.lowFilter.process(s);
      const mid = this.midFilter.process(s);
      const hi = this.highFilter.process(s);

      const fLo = this.fastLow.process(lo);
      const fMid = this.fastMid.process(mid);
      const fHi = this.fastHigh.process(hi);
      const f = this.level.process(s);

      // Read the lagged values before overwriting the slot: at this index sits exactly
      // what was written lagLen frames ago.
      const lp = this.lagPos;
      const pLo = this.histLow[lp];
      const pMid = this.histMid[lp];
      const pHi = this.histHigh[lp];
      this.histLow[lp] = fLo;
      this.histMid[lp] = fMid;
      this.histHigh[lp] = fHi;
      this.lagPos = lp + 1 >= this.lagLen ? 0 : lp + 1;

      // The strongest rise across the three bands is the onset signal. Taking the max
      // rather than the sum is the whole point: a hit only has to be new in *one* band
      // to be a new hit, so a hi-hat lands even while a kick is still ringing underneath
      // it. A sum would let the kick's residual dominate and swallow the hat.
      const rLo = pLo > 1e-9 ? fLo / pLo : fLo > 1e-9 ? 99 : 0;
      const rMid = pMid > 1e-9 ? fMid / pMid : fMid > 1e-9 ? 99 : 0;
      const rHi = pHi > 1e-9 ? fHi / pHi : fHi > 1e-9 ? 99 : 0;
      // A band only gets a vote if it actually carries signal — otherwise a band sitting
      // in near-silence produces a huge ratio out of two tiny numbers and fires on noise.
      const bandFloor = floor * 0.5;
      let ratio = 0;
      if (fLo > bandFloor && rLo > ratio) ratio = rLo;
      if (fMid > bandFloor && rMid > ratio) ratio = rMid;
      if (fHi > bandFloor && rHi > ratio) ratio = rHi;

      // Feature accumulation runs whenever a window is open.
      if (this.windowLeft > 0) {
        this.accLow += lo * lo;
        this.accMid += mid * mid;
        this.accHigh += hi * hi;
        const sign = s > 0 ? 1 : s < 0 ? -1 : this.lastSign;
        if (sign !== this.lastSign && this.lastSign !== 0) this.accZc++;
        this.lastSign = sign;
        this.accFrames++;
        this.windowLeft--;
        if (this.windowLeft === 0) this.#commitFeatures();
      }

      const sinceHit = this.frames - this.lastHitFrame;
      if (f > floor && sinceHit > gapFrames && ratio > this.sensitivity) {
        // A hit while a previous window is still open closes that one early rather than
        // discarding it: a half-measured hit still classifies, a dropped one does not.
        if (this.windowLeft > 0) this.#commitFeatures();

        this.lastHitFrame = this.frames;
        if (count < MAX_HITS_PER_BLOCK) {
          this.positions[count] = this.frames;
          // Strength is how far above the running level the transient reached, mapped
          // to roughly 0..1 so it can drive velocity directly.
          this.strengths[count] = Math.min(1, Math.max(0, (ratio - 1) / 6));
          this.pendingIndex = count;
          count++;
        } else {
          this.pendingIndex = -1;
        }
        this.accLow = 0;
        this.accMid = 0;
        this.accHigh = 0;
        this.accZc = 0;
        this.accFrames = 0;
        this.windowLeft = windowFrames;
        this.pendingFeature = true;
      }

      this.frames++;
    }

    this.count = count;
    return count;
  }

  /**
   * Normalises the accumulated window into the pending hit's feature slot, and appends
   * the same four numbers to the commit ring so a caller that missed the block-local
   * slot can still read them.
   */
  #commitFeatures() {
    const idx = this.pendingIndex;
    this.pendingFeature = false;
    this.windowLeft = 0;
    // idx < 0 means the hit overflowed MAX_HITS_PER_BLOCK and was never reported. There
    // is no output entry for it, so it must not advance the ring either — the ring's
    // whole job is to stay one-for-one with the hits the caller actually saw.
    if (idx < 0 || idx >= MAX_HITS_PER_BLOCK) return;

    const total = this.accLow + this.accMid + this.accHigh;
    let low = 0;
    let mid = 0;
    let high = 0;
    if (total > 1e-12) {
      low = this.accLow / total;
      mid = this.accMid / total;
      high = this.accHigh / total;
    }
    // Zero crossings per second, scaled to 0..1 across a musically useful range so every
    // feature lands on the same axis and the classifier needs no per-feature weighting.
    const secs = this.accFrames / this.sr;
    const zcr = secs > 0 ? this.accZc / secs : 0;
    const zn = Math.min(1, zcr / 8000);

    const base = idx * FEATURE_COUNT;
    this.features[base] = low;
    this.features[base + 1] = mid;
    this.features[base + 2] = high;
    this.features[base + 3] = zn;

    const r = (this.commitCount % COMMIT_RING) * FEATURE_COUNT;
    this.commitRing[r] = low;
    this.commitRing[r + 1] = mid;
    this.commitRing[r + 2] = high;
    this.commitRing[r + 3] = zn;
    this.commitCount++;
  }

  /**
   * Copies committed measurement number `n` (0-based, in hit order) into `out`.
   * Returns false if that measurement has been overwritten or has not happened yet —
   * drain promptly and this never occurs.
   */
  readCommitted(n, out) {
    if (n < 0 || n >= this.commitCount || n < this.commitCount - COMMIT_RING) return false;
    const r = (n % COMMIT_RING) * FEATURE_COUNT;
    for (let i = 0; i < FEATURE_COUNT; i++) out[i] = this.commitRing[r + i];
    return true;
  }

  #refresh() {
    // Q of 0.707 on the crossovers: flat, no resonant bump colouring the band energies.
    this.lowFilter.set(FilterType.LOWPASS, this.lowCrossHz, 0.707, 0);
    this.highFilter.set(FilterType.HIGHPASS, this.highCrossHz, 0.707, 0);
    const centre = Math.sqrt(this.lowCrossHz * this.highCrossHz);
    const q = centre / Math.max(1, this.highCrossHz - this.lowCrossHz);
    this.midFilter.set(FilterType.BANDPASS, centre, Math.max(0.3, q), 0);
  }
}

/**
 * Offline convenience: runs a whole mono buffer through a detector in blocks and returns
 * every onset it found.
 *
 * This is what BROBEATS slicing calls. It exists here rather than in the UI so there is
 * exactly one answer to "where are the hits" in the codebase — the slice points you see
 * drawn on the waveform are the same positions the live detector would have fired at.
 */
export function detectOnsets(mono, sampleRate, opts, blockSize = 128) {
  const det = new OnsetDetector(sampleRate, opts);
  const positions = [];
  const strengths = [];
  const features = [];
  const block = new Float32Array(blockSize);
  const scratch = new Float32Array(FEATURE_COUNT);
  let drained = 0;

  // Offline we want *finished* features, not the partial ones available the instant a hit
  // is reported, so positions are collected as they come and the measurements are drained
  // from the commit ring as they complete a few blocks later. The two are matched by
  // order: the Nth commit belongs to the Nth hit.
  const drain = () => {
    while (drained < det.commitCount && drained < positions.length) {
      if (!det.readCommitted(drained, scratch)) break;
      features[drained] = [scratch[0], scratch[1], scratch[2], scratch[3]];
      drained++;
    }
  };

  for (let off = 0; off < mono.length; off += blockSize) {
    const n = Math.min(blockSize, mono.length - off);
    for (let i = 0; i < n; i++) block[i] = mono[off + i];
    for (let i = n; i < blockSize; i++) block[i] = 0;
    const found = det.process(block, n);
    for (let h = 0; h < found; h++) {
      positions.push(det.positions[h]);
      strengths.push(det.strengths[h]);
      features.push([0, 0, 0, 0]);
    }
    drain();
  }

  // A hit near the end of the buffer still has its window open. Offline there is no
  // "later" for it to finish in, so it is given one: silence, long enough to close the
  // longest window the params allow. The measurement is then whatever real audio the
  // window caught before the buffer ran out, which is the honest answer.
  const tailFrames = Math.ceil((det.featureMs * 0.001 * det.sr) | 0) + blockSize;
  for (let off = 0; off < tailFrames && det.windowLeft > 0; off += blockSize) {
    block.fill(0);
    det.process(block, blockSize);
    drain();
  }
  drain();

  return { positions, strengths, features };
}
