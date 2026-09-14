/**
 * Bro.Kodr — sample editing.
 *
 * The maths behind the BROBEATS sample editor: crop, gain, normalise, fade, reverse, and
 * transient slicing. All of it offline and non-destructive — an edit is a small plain
 * object describing what to do, and `renderEdit()` applies it to a copy. The captured
 * audio is never written to, so dragging a trim handle is free to re-render on every
 * mouse move and "revert" costs nothing.
 *
 * ## Why this module exists separately from recorder.ts
 *
 * `recorder.ts` already had trim/normalise/fade, but locked inside `processForExport()`
 * and driven by `ExportOptions` — a shape built for "write a WAV to disk", where trim
 * means "strip silence below a threshold". The editor needs the same arithmetic driven by
 * where the user dragged a handle to. Rather than copy the loops into a second file and
 * let the two drift, the primitives live here and `processForExport()` calls them. There
 * is one fade curve and one normalise in the codebase, not two that disagree.
 *
 * ## Order of operations
 *
 * Fixed, and it matters:
 *
 *   1. **crop** — everything downstream should only ever see the audio you kept
 *   2. **reverse**
 *   3. **gain** — the manual trim
 *   4. **normalise** — after gain, so it acts as a ceiling rather than being undone by it
 *   5. **fades** — last, so a fade is never scaled back up into a click
 *
 * Normalising before fading is the part people get wrong: fade first and the fade-in's
 * near-silent head becomes the peak the normaliser divides by on a short sample.
 */

export interface SampleEdit {
  /** First frame kept, inclusive. */
  startFrame: number;
  /** Last frame kept, exclusive. */
  endFrame: number;
  /** Manual level trim in dB. 0 is untouched. */
  gainDb: number;
  /** Peak-normalise to this dBFS after gain. Null leaves levels alone. */
  normalizeDb: number | null;
  fadeInMs: number;
  fadeOutMs: number;
  reverse: boolean;
  mono: boolean;
}

export interface StereoBuffer {
  l: Float32Array;
  r: Float32Array;
}

export function defaultEdit(frames: number): SampleEdit {
  return {
    startFrame: 0,
    endFrame: frames,
    gainDb: 0,
    normalizeDb: null,
    fadeInMs: 0,
    fadeOutMs: 4,
    reverse: false,
    mono: false,
  };
}

/** True when the edit would change nothing, so callers can skip a render entirely. */
export function isIdentityEdit(e: SampleEdit, frames: number): boolean {
  return (
    e.startFrame === 0 &&
    e.endFrame === frames &&
    e.gainDb === 0 &&
    e.normalizeDb === null &&
    e.fadeInMs === 0 &&
    e.fadeOutMs === 0 &&
    !e.reverse &&
    !e.mono
  );
}

// ------------------------------------------------------------------ primitives

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(g: number): number {
  return 20 * Math.log10(Math.max(g, 1e-9));
}

export function peakOf(l: Float32Array, r: Float32Array): number {
  let p = 0;
  for (let i = 0; i < l.length; i++) {
    const a = Math.abs(l[i]);
    const b = Math.abs(r[i]);
    if (a > p) p = a;
    if (b > p) p = b;
  }
  return p;
}

/**
 * RMS across both channels, in dBFS. -Infinity for digital silence and for an empty
 * buffer, matching how the meters report a dead signal (see components/meters.tsx).
 * Note this deliberately does NOT route through gainToDb: that clamps at 1e-9 to keep
 * param maths finite, which would report silence as a misleading -180 dBFS instead.
 * Callers that render this into a layout must handle the non-finite case.
 */
export function rmsDb(l: Float32Array, r: Float32Array): number {
  if (!l.length) return -Infinity;
  let s = 0;
  for (let i = 0; i < l.length; i++) s += l[i] * l[i] + r[i] * r[i];
  const g = Math.sqrt(s / (l.length * 2));
  return g > 1e-7 ? 20 * Math.log10(g) : -Infinity;
}

/** Copies out [start, end). Always returns fresh arrays — never a view on the source. */
export function cropTo(src: StereoBuffer, start: number, end: number): StereoBuffer {
  const a = Math.max(0, Math.min(src.l.length, Math.floor(start)));
  const b = Math.max(a, Math.min(src.l.length, Math.floor(end)));
  return { l: src.l.slice(a, b), r: src.r.slice(a, b) };
}

/** In place. */
export function applyGain(buf: StereoBuffer, gain: number) {
  if (gain === 1) return;
  for (let i = 0; i < buf.l.length; i++) {
    buf.l[i] *= gain;
    buf.r[i] *= gain;
  }
}

/** In place. Silence is left alone rather than amplified into noise. */
export function normalizeTo(buf: StereoBuffer, targetDb: number) {
  const peak = peakOf(buf.l, buf.r);
  if (peak <= 1e-9) return;
  applyGain(buf, dbToGain(targetDb) / peak);
}

/** In place. */
export function reverseBuffer(buf: StereoBuffer) {
  buf.l.reverse();
  buf.r.reverse();
}

/** In place. */
export function toMono(buf: StereoBuffer) {
  for (let i = 0; i < buf.l.length; i++) {
    const m = (buf.l[i] + buf.r[i]) * 0.5;
    buf.l[i] = m;
    buf.r[i] = m;
  }
}

/**
 * In place, equal-power. A linear ramp audibly dips in the middle of a crossfade and
 * sounds slow at the top of a fade-in; a quarter-sine holds perceived loudness steady.
 */
export function applyFades(buf: StereoBuffer, sampleRate: number, fadeInMs: number, fadeOutMs: number) {
  const n = buf.l.length;
  const fi = Math.min(n, Math.round((fadeInMs / 1000) * sampleRate));
  for (let i = 0; i < fi; i++) {
    const g = Math.sin((Math.PI / 2) * (i / fi));
    buf.l[i] *= g;
    buf.r[i] *= g;
  }
  const fo = Math.min(n, Math.round((fadeOutMs / 1000) * sampleRate));
  for (let i = 0; i < fo; i++) {
    const g = Math.sin((Math.PI / 2) * (i / fo));
    const idx = n - 1 - i;
    buf.l[idx] *= g;
    buf.r[idx] *= g;
  }
}

/**
 * Finds the first and last frame above `thresholdDb`, with a little pre-roll kept so the
 * transient that crosses the threshold is not itself clipped off. Returns the whole buffer
 * when everything is below the threshold — silence trimmed to nothing is never what the
 * user meant.
 */
export function findContentBounds(
  src: StereoBuffer,
  sampleRate: number,
  thresholdDb: number,
  preRollMs = 5,
): { start: number; end: number } {
  const thr = dbToGain(thresholdDb);
  const n = src.l.length;
  let start = 0;
  let end = n;
  while (start < end && Math.max(Math.abs(src.l[start]), Math.abs(src.r[start])) < thr) start++;
  while (end > start && Math.max(Math.abs(src.l[end - 1]), Math.abs(src.r[end - 1])) < thr) end--;
  if (start >= end) return { start: 0, end: n };
  const pad = Math.round(sampleRate * (preRollMs / 1000));
  return { start: Math.max(0, start - pad), end: Math.min(n, end + pad) };
}

// --------------------------------------------------------------------- render

/** Applies an edit to a copy. The source is never modified. */
export function renderEdit(src: StereoBuffer, sampleRate: number, edit: SampleEdit): StereoBuffer {
  const out = cropTo(src, edit.startFrame, edit.endFrame);
  if (edit.reverse) reverseBuffer(out);
  if (edit.gainDb !== 0) applyGain(out, dbToGain(edit.gainDb));
  if (edit.normalizeDb !== null) normalizeTo(out, edit.normalizeDb);
  applyFades(out, sampleRate, edit.fadeInMs, edit.fadeOutMs);
  if (edit.mono) toMono(out);
  return out;
}

/** Sums to mono in a fresh buffer, for analysis that does not care about the stereo image. */
export function toMonoBuffer(src: StereoBuffer): Float32Array {
  const out = new Float32Array(src.l.length);
  for (let i = 0; i < out.length; i++) out[i] = (src.l[i] + src.r[i]) * 0.5;
  return out;
}

// ------------------------------------------------------------------- waveform

/**
 * Min/max envelope over a frame range, interleaved as [min0, max0, min1, max1, ...].
 *
 * Min and max rather than a single absolute peak because it is what makes a waveform look
 * like a waveform: an asymmetric signal (most voices, any kick with DC offset) drawn from
 * absolute peaks mirrored around the centre reads as a symmetric blob and hides the shape
 * you are trying to cut on.
 *
 * `from`/`to` exist so zooming does not mean re-slicing the audio — the editor draws a
 * window straight out of the full-length source.
 */
export function buildPeaks(
  src: StereoBuffer,
  points: number,
  from = 0,
  to = src.l.length,
): Float32Array {
  const out = new Float32Array(points * 2);
  const a = Math.max(0, Math.min(src.l.length, Math.floor(from)));
  const b = Math.max(a, Math.min(src.l.length, Math.floor(to)));
  const span = b - a;
  if (span <= 0 || points <= 0) return out;
  const per = span / points;
  for (let p = 0; p < points; p++) {
    const s = a + Math.floor(p * per);
    // Always read at least one frame: zoomed in past one frame per pixel, per < 1 and
    // floor() would otherwise give an empty range and draw a gap.
    const e = Math.min(b, Math.max(s + 1, a + Math.floor((p + 1) * per)));
    let lo = 0;
    let hi = 0;
    for (let i = s; i < e; i++) {
      const vl = src.l[i];
      const vr = src.r[i];
      if (vl < lo) lo = vl;
      if (vr < lo) lo = vr;
      if (vl > hi) hi = vl;
      if (vr > hi) hi = vr;
    }
    out[p * 2] = lo;
    out[p * 2 + 1] = hi;
  }
  return out;
}

// -------------------------------------------------------------------- slicing

interface OnsetModule {
  detectOnsets: (
    mono: Float32Array,
    sampleRate: number,
    opts?: Record<string, number>,
    blockSize?: number,
  ) => { positions: number[]; strengths: number[]; features: number[][] };
  ONSET_DEFAULTS: Record<string, number>;
}

const ONSET_URL = "/dsp/core/onset.js";

let onsetPromise: Promise<OnsetModule | null> | null = null;
let onsetError: string | null = null;

/**
 * Loads the onset detector at runtime, the same way `loadDrumSynth()` loads the drum
 * generator and for the same reason: it lives in `public/dsp` because the audio thread
 * imports it too (Smart Voice will run this exact code live), so it is fetched as a plain
 * ES module rather than bundled into the app.
 *
 * The absolute-URL resolution is load-bearing in dev — see the note on `loadDrumSynth()`.
 */
export function loadOnset(): Promise<OnsetModule | null> {
  if (!onsetPromise) {
    const url =
      typeof document === "undefined" ? ONSET_URL : new URL(ONSET_URL, document.baseURI).href;
    onsetPromise = import(/* @vite-ignore */ url)
      .then((m) => m as OnsetModule)
      .catch((e) => {
        onsetError = e instanceof Error ? e.message : String(e);
        console.warn("[brobeats] onset detector failed to load:", onsetError);
        return null;
      });
  }
  return onsetPromise;
}

export function onsetLoadError(): string | null {
  return onsetError;
}

export interface Slice {
  startFrame: number;
  endFrame: number;
  /** 0..1, from the transient's rise. Maps straight onto pad velocity. */
  strength: number;
  /** [low, mid, high, zcr] — normalised band energies plus zero-crossing rate. */
  features: number[];
}

export interface SliceOptions {
  /** How far the detector must see a band rise before calling it a hit. */
  sensitivity?: number;
  /** Noise gate in dBFS. */
  floorDb?: number;
  /** Shortest gap between two hits, in ms. */
  minGapMs?: number;
  /** Stop after this many slices. 16 fills a pad grid exactly. */
  maxSlices?: number;
}

/**
 * Turns a detector's raw hit list into contiguous slices.
 *
 * Each slice runs from its own onset to the next one, so the pieces tile the recording
 * with no gaps and no overlap — play all 16 pads in order and you get the original back.
 * The alternative, a fixed length per slice, cuts the tail off anything that rings and
 * leaves silence on anything that does not.
 *
 * Split out from `sliceAtTransients` so it can be tested: that function has to load a
 * module out of `public/dsp` over the network, which only exists in a browser, and this
 * is where the arithmetic that can actually be wrong lives.
 */
export function slicesFromOnsets(
  positions: ArrayLike<number>,
  strengths: ArrayLike<number>,
  features: ArrayLike<number[]>,
  totalFrames: number,
  maxSlices = 16,
): Slice[] {
  const out: Slice[] = [];
  const n = Math.min(positions.length, Math.max(0, maxSlices));
  for (let i = 0; i < n; i++) {
    const start = positions[i];
    // The last kept slice runs to the end of the audio, even when more onsets were found
    // past it — a truncated tail is better than a slice that stops mid-ring.
    const end = i === n - 1 ? totalFrames : positions[i + 1];
    if (!(end > start)) continue;
    out.push({
      startFrame: start,
      endFrame: Math.min(end, totalFrames),
      strength: strengths[i] ?? 1,
      features: features[i] ?? [0, 0, 0, 0],
    });
  }
  return out;
}

/**
 * Chops a buffer at its transients.
 *
 * Returns an empty array if the detector could not be loaded; the caller should fall back
 * to even division rather than failing.
 */
export async function sliceAtTransients(
  src: StereoBuffer,
  sampleRate: number,
  opts: SliceOptions = {},
): Promise<Slice[]> {
  const mod = await loadOnset();
  if (!mod) return [];

  const detectorOpts: Record<string, number> = {};
  if (opts.sensitivity !== undefined) detectorOpts.sensitivity = opts.sensitivity;
  if (opts.floorDb !== undefined) detectorOpts.floorDb = opts.floorDb;
  if (opts.minGapMs !== undefined) detectorOpts.minGapMs = opts.minGapMs;

  const mono = toMonoBuffer(src);
  const { positions, strengths, features } = mod.detectOnsets(mono, sampleRate, detectorOpts);
  return slicesFromOnsets(positions, strengths, features, src.l.length, opts.maxSlices ?? 16);
}

/** Fallback when no transients are found: equal pieces across the whole buffer. */
export function sliceEvenly(frames: number, count: number): Slice[] {
  const out: Slice[] = [];
  if (frames <= 0 || count <= 0) return out;
  const per = frames / count;
  for (let i = 0; i < count; i++) {
    const start = Math.floor(i * per);
    const end = i === count - 1 ? frames : Math.floor((i + 1) * per);
    if (end > start) out.push({ startFrame: start, endFrame: end, strength: 1, features: [0, 0, 0, 0] });
  }
  return out;
}

/**
 * Move slices that were cut from a trimmed region back onto the frame numbers of the whole
 * source buffer.
 *
 * Slicing runs on the kept region, not the whole capture — trim is the user saying "this is
 * the part I care about", and cutting the silence either side of it across the pads would
 * ignore that. But a `Slice` is stored as a range into the *source*, because that is what
 * survives the trim being dragged afterwards. This closes the gap: add the offset the region
 * started at, and the slices are in source frames again.
 */
export function shiftSlices(slices: Slice[], offset: number): Slice[] {
  if (!offset) return slices;
  return slices.map((s) => ({
    ...s,
    startFrame: s.startFrame + offset,
    endFrame: s.endFrame + offset,
  }));
}
