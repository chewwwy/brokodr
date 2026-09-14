/**
 * Bro.Kodr — BROBEATS synthesised drum kit (backend-agnostic).
 *
 * The default kit is generated, not sampled. An 808 kick is a sine with a pitch
 * envelope; a snare is a tuned body plus filtered noise; a hat is bandpassed noise with
 * a fast decay. We already own oscillators, filters and noise, so the starter kit costs
 * zero megabytes, works on first launch with nothing to download, and — the part that
 * matters musically — its tune and decay are knobs instead of being baked into a file.
 *
 * Drag-and-drop replaces any pad with a real sample whenever the user wants one. This
 * is what is there before they have loaded anything, not a cage.
 *
 * Rendering happens OFFLINE, into a buffer, whenever a generator param changes. That is
 * deliberate: `DrumVoice` then only ever plays buffers, so synthesised pads and sampled
 * pads share exactly one playback path. Re-rendering a one-second kick is a few hundred
 * microseconds and happens on a control command, never on the audio thread.
 *
 * No `#private`, no `extends` — both break the React Native worklet compiler used by
 * the Android build.
 */

import { clamp, TWO_PI, dbToGain, sanitize } from "./utils.js";

/** Kinds the generator understands. Stable ids — kits store them. */
export const DRUM_KINDS = ["kick", "snare", "hat", "clap", "tom", "rim"];

/** Longest one-shot we will ever render, in seconds. Bounds the allocation. */
const MAX_SECONDS = 4;

/**
 * Default generator params per kind. Every value is a plain number so a kit document
 * serialises as JSON and tolerates new fields being appended later.
 */
export const DRUM_SYNTH_DEFAULTS = {
  kick: { tune: 52, drop: 34, pitchDecay: 45, decay: 420, drive: 0.35, click: 0.3, level: 0 },
  snare: { tune: 190, body: 0.5, decay: 180, noiseDecay: 150, tone: 2400, snap: 0.6, level: 0 },
  hat: { tune: 8200, decay: 55, resonance: 1.6, tone: 0.6, level: -3 },
  clap: { tune: 1400, spread: 24, decay: 200, tone: 0.55, level: -2 },
  tom: { tune: 140, drop: 12, pitchDecay: 80, decay: 320, drive: 0.2, level: -1 },
  rim: { tune: 1700, decay: 42, tone: 0.7, level: -4 },
};

/** Exponential decay coefficient for a time constant in ms. */
function decayCoef(sr, ms) {
  return Math.exp(-1 / (sr * Math.max(ms, 0.5) * 0.001));
}

/** Soft saturation — the same tanh-ish curve the drive modules use, kept cheap. */
function softClip(x, amount) {
  if (amount <= 0) return x;
  const k = 1 + amount * 9;
  return Math.tanh(x * k) / Math.tanh(k);
}

/** White noise with a fast xorshift — deterministic per render, so kits are repeatable. */
function makeNoise(seed) {
  let s = seed | 0 || 22222;
  return function next() {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s / 2147483648) * 0.5;
  };
}

/**
 * One-pole state-variable bandpass, used inline so the generators stay self-contained
 * and do not drag Biquad's per-sample coefficient machinery into an offline loop.
 */
function makeBandpass(sr, freq, q) {
  const f = 2 * Math.sin((Math.PI * clamp(freq, 20, sr * 0.45)) / sr);
  const damp = 1 / Math.max(q, 0.5);
  let low = 0;
  let band = 0;
  return function process(x) {
    low += f * band;
    const high = x - low - damp * band;
    band += f * high;
    return band;
  };
}

function makeHighpass(sr, freq) {
  const f = 2 * Math.sin((Math.PI * clamp(freq, 20, sr * 0.45)) / sr);
  let low = 0;
  let band = 0;
  return function process(x) {
    low += f * band;
    const high = x - low - 0.8 * band;
    band += f * high;
    return high;
  };
}

// ------------------------------------------------------------------ generators

function renderKick(sr, p, out) {
  const n = Math.min(out.length, Math.ceil(sr * Math.min((p.decay * 3) / 1000 + 0.05, MAX_SECONDS)));
  const ampC = decayCoef(sr, p.decay);
  const pitchC = decayCoef(sr, p.pitchDecay);
  const base = clamp(p.tune, 20, 200);
  // The drop is expressed in semitones so it behaves musically when the tune changes.
  const top = base * Math.pow(2, clamp(p.drop, 0, 48) / 12);
  const hp = makeHighpass(sr, 18);

  let amp = 1;
  let pitchEnv = 1;
  let phase = 0;
  const clickN = Math.ceil(sr * 0.003);

  for (let i = 0; i < n; i++) {
    const f = base + (top - base) * pitchEnv;
    phase += (TWO_PI * f) / sr;
    if (phase > TWO_PI) phase -= TWO_PI;

    let x = Math.sin(phase) * amp;
    // A short burst of the fundamental's transient so it cuts on small speakers.
    if (i < clickN) x += (1 - i / clickN) * p.click * (i % 2 ? -1 : 1) * 0.5;
    x = softClip(x, p.drive);

    out[i] = sanitize(hp(x));
    amp *= ampC;
    pitchEnv *= pitchC;
  }
  return n;
}

function renderTom(sr, p, out) {
  return renderKick(sr, { ...p, click: 0 }, out);
}

function renderSnare(sr, p, out) {
  const n = Math.min(out.length, Math.ceil(sr * Math.min((Math.max(p.decay, p.noiseDecay) * 3) / 1000 + 0.05, MAX_SECONDS)));
  const bodyC = decayCoef(sr, p.decay);
  const noiseC = decayCoef(sr, p.noiseDecay);
  const noise = makeNoise(9187);
  const bp = makeBandpass(sr, p.tone, 0.9);
  const hp = makeHighpass(sr, 180);
  const f1 = clamp(p.tune, 80, 600);
  const f2 = f1 * 1.47; // the second mode of a drum head, slightly inharmonic

  let bodyAmp = 1;
  let noiseAmp = 1;
  let ph1 = 0;
  let ph2 = 0;
  const bodyMix = clamp(p.body, 0, 1);

  for (let i = 0; i < n; i++) {
    ph1 += (TWO_PI * f1) / sr;
    ph2 += (TWO_PI * f2) / sr;
    if (ph1 > TWO_PI) ph1 -= TWO_PI;
    if (ph2 > TWO_PI) ph2 -= TWO_PI;

    const body = (Math.sin(ph1) * 0.7 + Math.sin(ph2) * 0.3) * bodyAmp;
    const snares = hp(bp(noise())) * noiseAmp * (1 + p.snap * 2);

    out[i] = sanitize(softClip(body * bodyMix + snares * (1 - bodyMix * 0.5), 0.15));
    bodyAmp *= bodyC;
    noiseAmp *= noiseC;
  }
  return n;
}

function renderHat(sr, p, out) {
  const n = Math.min(out.length, Math.ceil(sr * Math.min((p.decay * 4) / 1000 + 0.01, MAX_SECONDS)));
  const ampC = decayCoef(sr, p.decay);
  const noise = makeNoise(4421);
  const bp = makeBandpass(sr, p.tune, p.resonance);
  const hp = makeHighpass(sr, clamp(p.tune * 0.6, 200, 12000));
  // Six inharmonic square partials is the classic metallic-hat recipe; mixing them
  // under the noise is what stops it sounding like a plain noise burst.
  const ratios = [2, 3.01, 4.17, 5.43, 6.79, 8.21];
  const baseF = clamp(p.tune, 1000, 14000) * 0.18;
  const ph = new Float32Array(ratios.length);
  let amp = 1;
  const metal = clamp(p.tone, 0, 1);

  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = 0; k < ratios.length; k++) {
      ph[k] += (TWO_PI * baseF * ratios[k]) / sr;
      if (ph[k] > TWO_PI) ph[k] -= TWO_PI;
      m += Math.sin(ph[k]) >= 0 ? 1 : -1;
    }
    m /= ratios.length;

    const x = (m * metal + noise() * 2 * (1 - metal)) * amp;
    out[i] = sanitize(hp(bp(x)) * 1.6);
    amp *= ampC;
  }
  return n;
}

function renderClap(sr, p, out) {
  const n = Math.min(out.length, Math.ceil(sr * Math.min((p.decay * 3) / 1000 + 0.08, MAX_SECONDS)));
  const noise = makeNoise(31337);
  const bp = makeBandpass(sr, p.tune, 1.1 + p.tone);
  const hp = makeHighpass(sr, 500);
  const tailC = decayCoef(sr, p.decay);
  // A clap is three fast slaps then a room tail — the slaps are what make it read as
  // hands rather than a noise gate.
  const slapGapSamples = Math.max(1, Math.round((sr * clamp(p.spread, 4, 80)) / 1000));
  const slapC = decayCoef(sr, 12);

  let tail = 0;
  let slap = 1;
  let nextSlap = slapGapSamples;
  let slapsLeft = 2;

  for (let i = 0; i < n; i++) {
    if (i === nextSlap && slapsLeft > 0) {
      slap = 1;
      slapsLeft--;
      nextSlap += slapGapSamples;
    }
    if (slapsLeft === 0 && tail === 0 && slap < 0.4) tail = 0.7;

    const env = slap + tail;
    out[i] = sanitize(hp(bp(noise() * 2)) * env * 1.3);
    slap *= slapC;
    tail *= tailC;
  }
  return n;
}

function renderRim(sr, p, out) {
  const n = Math.min(out.length, Math.ceil(sr * Math.min((p.decay * 5) / 1000 + 0.01, MAX_SECONDS)));
  const ampC = decayCoef(sr, p.decay);
  const noise = makeNoise(777);
  const bp = makeBandpass(sr, p.tune, 3.2);
  const f = clamp(p.tune, 200, 6000);
  let amp = 1;
  let phase = 0;
  const woodiness = clamp(p.tone, 0, 1);

  for (let i = 0; i < n; i++) {
    phase += (TWO_PI * f) / sr;
    if (phase > TWO_PI) phase -= TWO_PI;
    const x = Math.sin(phase) * woodiness + noise() * 2 * (1 - woodiness);
    out[i] = sanitize(bp(x) * amp * 1.5);
    amp *= ampC;
  }
  return n;
}

const RENDERERS = {
  kick: renderKick,
  snare: renderSnare,
  hat: renderHat,
  clap: renderClap,
  tom: renderTom,
  rim: renderRim,
};

// ------------------------------------------------------------------ public API

/**
 * Render one drum into a freshly allocated mono buffer.
 *
 * Offline only — called from a control command when a generator param changes, never
 * from the audio callback.
 *
 * @param {string} kind    one of DRUM_KINDS
 * @param {number} sr      sample rate
 * @param {object} [params] partial overrides on DRUM_SYNTH_DEFAULTS[kind]
 * @returns {{ data: Float32Array, frames: number, kind: string }|null}
 */
export function renderDrum(kind, sr, params) {
  const fn = RENDERERS[kind];
  if (!fn) return null;

  const p = { ...DRUM_SYNTH_DEFAULTS[kind], ...(params || {}) };
  const scratch = new Float32Array(Math.ceil(sr * MAX_SECONDS));
  const frames = fn(sr, p, scratch);
  if (frames <= 0) return null;

  const data = scratch.subarray(0, frames).slice();

  // Normalise to a consistent working level, then apply the kind's own trim. Without
  // this, changing the decay of a kick also changes how loud it is, which makes the
  // knob feel broken.
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  const g = (peak > 1e-6 ? 0.89 / peak : 1) * dbToGain(p.level || 0);
  for (let i = 0; i < frames; i++) data[i] = sanitize(data[i] * g);

  // A 2 ms fade-out guarantees no click at the end regardless of where the decay landed.
  const fade = Math.min(Math.round(sr * 0.002), frames);
  for (let i = 0; i < fade; i++) {
    data[frames - 1 - i] *= i / fade;
  }

  return { data, frames, kind };
}

/**
 * The factory 16-pad layout. Row 1 is the core beatbox set — kick, snare, closed hat,
 * open hat — because those are the four Smart Voice classifies, and they need to sit
 * under the fingers in the obvious place.
 */
export const DEFAULT_KIT_LAYOUT = [
  { pad: 0, kind: "kick", name: "Kick", params: {} },
  { pad: 1, kind: "snare", name: "Snare", params: {} },
  { pad: 2, kind: "hat", name: "Hat Cl", params: { decay: 45 }, choke: 1 },
  { pad: 3, kind: "hat", name: "Hat Op", params: { decay: 320 }, choke: 1 },
  { pad: 4, kind: "kick", name: "Sub", params: { tune: 41, decay: 700, drop: 18, click: 0.05 } },
  { pad: 5, kind: "clap", name: "Clap", params: {} },
  { pad: 6, kind: "rim", name: "Rim", params: {} },
  { pad: 7, kind: "snare", name: "Snare 2", params: { tune: 240, decay: 110, snap: 0.85 } },
  { pad: 8, kind: "tom", name: "Tom Lo", params: { tune: 110 } },
  { pad: 9, kind: "tom", name: "Tom Mid", params: { tune: 165 } },
  { pad: 10, kind: "tom", name: "Tom Hi", params: { tune: 230 } },
  { pad: 11, kind: "hat", name: "Ride", params: { tune: 5200, decay: 900, tone: 0.8 } },
  { pad: 12, kind: "kick", name: "Kick 2", params: { tune: 64, decay: 240, drive: 0.6 } },
  { pad: 13, kind: "clap", name: "Snap", params: { spread: 8, decay: 90 } },
  { pad: 14, kind: "rim", name: "Click", params: { tune: 3200, decay: 18, tone: 0.2 } },
  { pad: 15, kind: "hat", name: "Shaker", params: { tune: 6400, decay: 90, tone: 0.1 } },
];
