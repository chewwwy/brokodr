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

import { applyFades, cropTo, findContentBounds, normalizeTo, toMono, buildPeaks } from "./sample-edit";

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

/**
 * Applies the export chain to a copy. Order matters: trim, then normalise, then fade.
 *
 * The arithmetic lives in `sample-edit.ts` and is shared with the BROBEATS sample editor,
 * so the fade curve and normalise behaviour you hear when auditioning a sample are the
 * same ones that end up in the exported file. The only thing that differs is how the trim
 * bounds are arrived at: here from a silence threshold, there from a dragged handle.
 */
export function processForExport(
  src: { l: Float32Array; r: Float32Array },
  sampleRate: number,
  opts: ExportOptions,
): { l: Float32Array; r: Float32Array } {
  const bounds =
    opts.trimSilenceDb !== null
      ? findContentBounds(src, sampleRate, opts.trimSilenceDb)
      : { start: 0, end: src.l.length };

  const out = cropTo(src, bounds.start, bounds.end);
  if (opts.normalizeDb !== null) normalizeTo(out, opts.normalizeDb);
  applyFades(out, sampleRate, opts.fadeInMs, opts.fadeOutMs);
  if (opts.mono) toMono(out);
  return out;
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

function readAscii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

export interface DecodedWav {
  data: Float32Array;
  sampleRate: number;
  channels: number;
}

/**
 * Reads a RIFF/WAVE file back to a mono Float32Array — the exact inverse of `encodeWav`,
 * and the reason the sample store can keep real `.wav` files on disk rather than an
 * opaque blob format: what it writes opens in any DAW, and what any DAW writes loads
 * here.
 *
 * Deliberately not `decodeAudioData`: that needs a live AudioContext, so restoring a kit
 * would be impossible while the engine is in standby — which is precisely when it has to
 * happen, on the first paint after a reload. This parser only handles PCM and IEEE
 * float, which is all WAV actually is; a compressed .wav (ADPCM, µ-law) returns null and
 * the caller falls back to the browser decoder.
 *
 * Chunks are walked rather than assumed at offset 36: files written by other tools carry
 * LIST/fact/bext chunks ahead of `data`, and a fixed offset reads them as audio.
 */
export function decodeWav(buffer: ArrayBuffer): DecodedWav | null {
  if (buffer.byteLength < 44) return null;
  const view = new DataView(buffer);
  if (readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") return null;

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  let o = 12;
  while (o + 8 <= buffer.byteLength) {
    const id = readAscii(view, o, 4);
    const size = view.getUint32(o + 4, true);
    const body = o + 8;
    if (id === "fmt " && size >= 16) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE stores the real format in the GUID's first two bytes.
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      dataOffset = body;
      dataBytes = Math.min(size, buffer.byteLength - body);
    }
    o = body + size + (size & 1);
  }

  if (dataOffset < 0 || channels < 1 || sampleRate < 1) return null;
  if (format !== 1 && format !== 3) return null;

  const bytesPerSample = bits >> 3;
  if (bytesPerSample < 1) return null;
  const frames = Math.floor(dataBytes / (bytesPerSample * channels));
  const out = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataOffset + (i * channels + c) * bytesPerSample;
      let s = 0;
      if (format === 3) {
        s = bits === 64 ? view.getFloat64(p, true) : view.getFloat32(p, true);
      } else if (bits === 8) {
        s = (view.getUint8(p) - 128) / 128;
      } else if (bits === 16) {
        s = view.getInt16(p, true) / 32768;
      } else if (bits === 24) {
        const u = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16);
        s = (u & 0x800000 ? u - 0x1000000 : u) / 8388608;
      } else if (bits === 32) {
        s = view.getInt32(p, true) / 2147483648;
      } else {
        return null;
      }
      sum += Number.isFinite(s) ? s : 0;
    }
    out[i] = channels > 1 ? sum / channels : sum;
  }

  return { data: out, sampleRate, channels };
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

/**
 * Rough peak envelope for drawing a take's waveform in the recorder strip — one absolute
 * peak per point, drawn mirrored around the centre line.
 *
 * The sample editor wants the true min/max per point instead, so it calls `buildPeaks()`
 * directly; this stays as the simpler shape the existing strip is drawn from.
 */
export function buildWaveform(take: Take, points: number): Float32Array {
  const out = new Float32Array(points);
  if (!take.wet.l.length) return out;
  const mm = buildPeaks(take.wet, points);
  for (let p = 0; p < points; p++) {
    out[p] = Math.max(Math.abs(mm[p * 2]), Math.abs(mm[p * 2 + 1]));
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
