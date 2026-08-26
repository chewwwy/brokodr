/**
 * Bro.Kodr — recorder and file export.
 *
 * The capture itself happens on the audio thread (see worklet-processor.js): two taps,
 * one post-input-gain "clean" and one post-chain "processed", written into a shared
 * circular buffer and drained into JS chunks by the backend. This module is everything
 * that happens after: take management, offline post-processing and encoding.
 *
 * Encoding is WAV only, and that is a deliberate choice rather than a shortcut:
 *   - WAV is lossless, universal, and imports into every DAW without a transcode step,
 *     which is what you want from a voice-processing tool's output.
 *   - 16/24-bit integer and 32-bit float are all written natively here.
 *   - MP3/AAC would need a bundled encoder (lamejs/ffmpeg.wasm, several MB). Not shipped,
 *     so it is not offered in the UI — an export button that silently produces a WAV with
 *     an .mp3 extension would be worse than not having it.
 *
 * All post-processing (normalise, trim, fade) is offline and non-destructive: it runs on a
 * copy when you export, the captured take is never overwritten.
 */

export type BitDepth = 16 | 24 | 32;

export interface Take {
  id: string;
  name: string;
  createdAt: number;
  sampleRate: number;
  frames: number;
  /** Processed capture — the sound you were monitoring. */
  wet: { l: Float32Array; r: Float32Array };
  /** Pre-effects capture, for reprocessing later. Null when shared memory is unavailable. */
  dry: { l: Float32Array; r: Float32Array } | null;
  /** Preset/chain label active when it was recorded, for provenance. */
  chainLabel: string;
}

export interface ExportOptions {
  source: "wet" | "dry";
  bitDepth: BitDepth;
  /** Peak-normalise to this dBFS. Null leaves levels untouched. */
  normalizeDb: number | null;
  /** Strip leading/trailing silence below this dBFS threshold. */
  trimSilenceDb: number | null;
  fadeInMs: number;
  fadeOutMs: number;
  mono: boolean;
}

export const DEFAULT_EXPORT: ExportOptions = {
  source: "wet",
  bitDepth: 24,
  normalizeDb: null,
  trimSilenceDb: null,
  fadeInMs: 0,
  fadeOutMs: 5,
  mono: false,
};

export function takeDuration(t: Take): number {
  return t.frames / t.sampleRate;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(2).padStart(5, "0")}`;
}

// ------------------------------------------------------------- post-process

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function peakOf(l: Float32Array, r: Float32Array): number {
  let p = 0;
  for (let i = 0; i < l.length; i++) {
    const a = Math.abs(l[i]);
    const b = Math.abs(r[i]);
    if (a > p) p = a;
    if (b > p) p = b;
  }
  return p;
}

/** Applies the export chain to a copy. Order matters: trim, then normalise, then fade. */
export function processForExport(
  src: { l: Float32Array; r: Float32Array },
  sampleRate: number,
  opts: ExportOptions,
): { l: Float32Array; r: Float32Array } {
  let l = src.l;
  let r = src.r;

  if (opts.trimSilenceDb !== null) {
    const thr = dbToGain(opts.trimSilenceDb);
    let start = 0;
    let end = l.length;
    while (start < end && Math.max(Math.abs(l[start]), Math.abs(r[start])) < thr) start++;
    while (end > start && Math.max(Math.abs(l[end - 1]), Math.abs(r[end - 1])) < thr) end--;
    // Keep 5ms of pre-roll so the first transient isn't clipped off.
    const pad = Math.round(sampleRate * 0.005);
    start = Math.max(0, start - pad);
    end = Math.min(l.length, end + pad);
    l = l.slice(start, end);
    r = r.slice(start, end);
  } else {
    l = l.slice();
    r = r.slice();
  }

  if (opts.normalizeDb !== null) {
    const peak = peakOf(l, r);
    if (peak > 1e-9) {
      const g = dbToGain(opts.normalizeDb) / peak;
      for (let i = 0; i < l.length; i++) {
        l[i] *= g;
        r[i] *= g;
      }
    }
  }

  const fi = Math.min(l.length, Math.round((opts.fadeInMs / 1000) * sampleRate));
  for (let i = 0; i < fi; i++) {
    // Equal-power fade — a linear ramp audibly dips in the middle.
    const g = Math.sin((Math.PI / 2) * (i / fi));
    l[i] *= g;
    r[i] *= g;
  }
  const fo = Math.min(l.length, Math.round((opts.fadeOutMs / 1000) * sampleRate));
  for (let i = 0; i < fo; i++) {
    const g = Math.sin((Math.PI / 2) * (i / fo));
    const idx = l.length - 1 - i;
    l[idx] *= g;
    r[idx] *= g;
  }

  if (opts.mono) {
    for (let i = 0; i < l.length; i++) {
      const m = (l[i] + r[i]) * 0.5;
      l[i] = m;
      r[i] = m;
    }
  }

  return { l, r };
}

// ----------------------------------------------------------------- encoding

/**
 * Writes a canonical RIFF/WAVE file. 16 and 24 bit use PCM (format 1) with TPDF dither at
 * the target LSB; 32 bit uses IEEE float (format 3) and is bit-exact with what the engine
 * produced.
 */
export function encodeWav(
  l: Float32Array,
  r: Float32Array,
  sampleRate: number,
  bitDepth: BitDepth,
  mono: boolean,
): Blob {
  const channels = mono ? 1 : 2;
  const frames = l.length;
  const bytesPerSample = bitDepth === 16 ? 2 : bitDepth === 24 ? 3 : 4;
  const dataBytes = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const isFloat = bitDepth === 32;
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, isFloat ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let o = 44;
  // Dither amplitude = 1 LSB peak-to-peak, TPDF (sum of two rectangular sources). This is
  // the correct thing to do when reducing word length; without it quantisation error
  // correlates with the signal and you hear it as grit on fades.
  const lsb = isFloat ? 0 : 1 / (bitDepth === 16 ? 32768 : 8388608);

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      let s = c === 0 ? l[i] : r[i];
      if (!Number.isFinite(s)) s = 0;
      if (isFloat) {
        view.setFloat32(o, s, true);
        o += 4;
        continue;
      }
      s += (Math.random() + Math.random() - 1) * lsb * 0.5;
      s = s < -1 ? -1 : s > 1 ? 1 : s;
      if (bitDepth === 16) {
        view.setInt16(o, Math.round(s * 32767), true);
        o += 2;
      } else {
        const v = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388607)));
        const u = v < 0 ? v + 0x1000000 : v;
        view.setUint8(o, u & 0xff);
        view.setUint8(o + 1, (u >> 8) & 0xff);
        view.setUint8(o + 2, (u >> 16) & 0xff);
        o += 3;
      }
    }
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

export function exportTake(take: Take, opts: ExportOptions): { blob: Blob; filename: string } {
  const src = opts.source === "dry" && take.dry ? take.dry : take.wet;
  const processed = processForExport(src, take.sampleRate, opts);
  const blob = encodeWav(processed.l, processed.r, take.sampleRate, opts.bitDepth, opts.mono);
  const safe = take.name.replace(/[^a-z0-9-_ ]/gi, "").trim() || "take";
  const suffix = opts.source === "dry" ? "-clean" : "";
  const filename = `${safe}${suffix}-${opts.bitDepth}bit.wav`;
  return { blob, filename };
}

/** Decodes a take into an AudioBuffer for in-app playback. */
export function takeToAudioBuffer(ctx: BaseAudioContext, take: Take, source: "wet" | "dry"): AudioBuffer {
  const src = source === "dry" && take.dry ? take.dry : take.wet;
  const buf = ctx.createBuffer(2, Math.max(1, src.l.length), take.sampleRate);
  // The capture buffers may be views on a SharedArrayBuffer; copyToChannel is typed for a
  // plain ArrayBuffer only, but it copies out of either.
  buf.copyToChannel(src.l as Float32Array<ArrayBuffer>, 0);
  buf.copyToChannel(src.r as Float32Array<ArrayBuffer>, 1);
  return buf;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick — revoking synchronously can cancel the download in Chromium.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Rough peak envelope for drawing a take's waveform. */
export function buildWaveform(take: Take, points: number): Float32Array {
  const out = new Float32Array(points);
  const l = take.wet.l;
  const r = take.wet.r;
  if (!l.length) return out;
  const per = l.length / points;
  for (let p = 0; p < points; p++) {
    const start = Math.floor(p * per);
    const end = Math.min(l.length, Math.floor((p + 1) * per));
    let peak = 0;
    for (let i = start; i < end; i++) {
      const a = Math.abs(l[i]);
      const b = Math.abs(r[i]);
      if (a > peak) peak = a;
      if (b > peak) peak = b;
    }
    out[p] = peak;
  }
  return out;
}

let takeCounter = 0;

export function nextTakeName(): string {
  takeCounter++;
  const d = new Date();
  const stamp = `${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return `Take ${String(takeCounter).padStart(2, "0")} ${stamp}`;
}
