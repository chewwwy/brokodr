/**
 * Bro.Kodr — Voice Lab character presets and morph dials.
 *
 * A character is nothing more than an ordinary effect chain: these presets are built from
 * the same registry modules the rack already offers, so a generated voice and a live mic
 * get identical treatment and anything here can be opened up and edited by hand afterwards.
 * There is no separate "voice engine" hiding behind them.
 *
 * The heavy lifting is done by `pitch` (independent pitch and formant shifting with the
 * preserve flag). That separation is the whole trick:
 *
 *   - PITCH alone moves the perceived note and sounds like a tape speed change.
 *   - FORMANT alone resizes the apparent vocal tract — a big head or a small one — at the
 *     same note. Formant up with pitch barely moved is what makes Toy and Cartoon read as
 *     small rather than merely high.
 *   - JITTER / SHIMMER add cycle-to-cycle pitch and level instability. This, not pitch, is
 *     what actually separates a young voice from an old one: an aged larynx loses
 *     periodicity. It is also what makes Ghost sound unwell.
 *
 * Every preset states only what matters for the sound; `withDefaults` fills the rest, so
 * these survive new params being appended to a module later.
 */

import type { ChainSnapshot, SlotState } from "./engine-client";
import { DEFAULT_IO } from "./engine-client";
import type { ParamDef } from "./param-schema";
import { withDefaults } from "./param-schema";

let uid = 900_000; // Far above the rack's own counter so ids can never collide.

function fx(type: string, params: Record<string, number> = {}, mix?: number): SlotState {
  return { id: ++uid, type, params: withDefaults(type, params), mix: mix ?? 1, bypassed: false, collapsed: false };
}

function chain(slots: SlotState[]): ChainSnapshot {
  return { slots, io: { ...DEFAULT_IO } };
}

export interface VoiceCharacter {
  id: string;
  name: string;
  /** One line, shown under the button — what it does, not marketing. */
  blurb: string;
  chain: ChainSnapshot;
}

/**
 * The twelve characters. Order is deliberate: small voices, then large ones, then
 * synthetic, then the human-age pair, then the three atmospherics.
 */
export const VOICE_CHARACTERS: VoiceCharacter[] = [
  {
    id: "toy",
    name: "TOY",
    blurb: "Tiny plastic voice — formant way up, pitch only a little.",
    chain: chain([
      fx("pitch", { pitch: 5, formant: 11, preserve: 1, lifter: 28 }),
      fx("eq", { hpFreq: 220, b2Freq: 3200, b2Gain: 4, hsFreq: 7000, hsGain: 3 }),
      fx("sat", { drive: 3, curve: 1, output: -1 }, 0.5),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "cartoon",
    name: "CARTOON",
    blurb: "Chipmunk. Pitch and tract both up hard, bright and forward.",
    chain: chain([
      fx("pitch", { pitch: 9, formant: 7, preserve: 1, lifter: 24 }),
      fx("eq", { hpFreq: 260, b2Freq: 4000, b2Gain: 3, hsFreq: 8000, hsGain: 4 }),
      fx("comp", { threshold: -20, ratio: 3, attack: 6, release: 90, makeup: 3 }),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "child",
    name: "CHILD",
    blurb: "Smaller head, slightly higher note, no roughness at all.",
    chain: chain([
      fx("pitch", { pitch: 3, formant: 5, preserve: 1, jitter: 0, shimmer: 0 }),
      fx("eq", { hpFreq: 180, b2Freq: 2800, b2Gain: 2, hsFreq: 6000, hsGain: 2 }),
      fx("comp", { threshold: -18, ratio: 2.5, attack: 10, release: 120, makeup: 2 }),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "giant",
    name: "GIANT",
    blurb: "Huge tract, low note, a slow room so it sounds physically big.",
    chain: chain([
      fx("pitch", { pitch: -7, formant: -9, preserve: 1, lifter: 70 }),
      fx("eq", { lsFreq: 120, lsGain: 5, b3Freq: 5000, b3Gain: -3, lpFreq: 9000 }),
      fx("sat", { drive: 5, curve: 1, output: -1 }, 0.4),
      fx("reverb", { decay: 2.6, size: 0.9, predelay: 40, damping: 0.5 }, 0.28),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "monster",
    name: "MONSTER",
    blurb: "Low, wide and torn up — drive plus a growling sub layer.",
    chain: chain([
      fx("pitch", { pitch: -10, formant: -6, preserve: 1, jitter: 14, shimmer: 10, lifter: 80 }),
      fx("dist", { drive: 32, curve: 4, tone: -2, bias: 0.12, output: -4 }, 0.7),
      fx("eq", { lsFreq: 140, lsGain: 6, b2Freq: 1800, b2Gain: -4, lpFreq: 7000 }),
      fx("character", { mode: 2, amount: 45, drive: 20, wobble: 12 }, 0.5),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "devil",
    name: "DEVIL",
    blurb: "Doubled an octave down with a hard edge and a long tail.",
    chain: chain([
      fx("pitch", { pitch: -12, formant: -4, preserve: 1, jitter: 8, lifter: 90 }),
      fx("dist", { drive: 24, curve: 2, bias: 0.2, output: -3 }, 0.55),
      fx("ringmod", { freq: 32, shape: 0, mode: 0 }, 0.14),
      fx("eq", { lsFreq: 110, lsGain: 4, hsFreq: 6500, hsGain: -3 }),
      fx("reverb", { decay: 3.2, size: 0.8, damping: 0.35, predelay: 25 }, 0.3),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "robot",
    name: "ROBOT",
    blurb: "Formant locked and ring-modulated — no human wobble left.",
    chain: chain([
      fx("pitch", { pitch: 0, formant: 0, preserve: 0, quality: 1 }),
      fx("ringmod", { freq: 90, shape: 3, mode: 0 }, 0.65),
      fx("crush", { bits: 7, rate: 11025, smooth: 0.2, output: -2 }, 0.45),
      fx("eq", { hpFreq: 200, b2Freq: 1600, b2Gain: 5, b2Q: 2.2, lpFreq: 6500 }),
      fx("comp", { threshold: -24, ratio: 8, attack: 1, release: 40, makeup: 4 }),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "alien",
    name: "ALIEN",
    blurb: "Frequency-shifted so the harmonics stop being a harmonic series.",
    chain: chain([
      fx("pitch", { pitch: 2, formant: -3, preserve: 1, jitter: 18 }),
      fx("freqshift", { freq: 47, feedback: 0.2 }, 0.5),
      fx("flanger", { rate: 0.28, depth: 0.55, feedback: 0.35, invert: 1 }, 0.4),
      fx("eq", { hpFreq: 240, b1Freq: 900, b1Gain: -4, hsFreq: 7500, hsGain: 3 }),
      fx("delay", { time: 180, feedback: 0.3, pingpong: 1 }, 0.2),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "elderly",
    name: "ELDERLY",
    blurb: "The real age control: roughness and lost brightness, not just pitch.",
    chain: chain([
      fx("pitch", { pitch: -1.5, formant: -1, preserve: 1, jitter: 26, shimmer: 32 }),
      fx("eq", { hpFreq: 140, b2Freq: 3000, b2Gain: -4, hsFreq: 6000, hsGain: -6, lpFreq: 8500 }),
      fx("noise", { level: -34, type: 1, follow: 0.7, tone: 0.6 }, 0.35),
      fx("comp", { threshold: -16, ratio: 2, attack: 18, release: 200, makeup: 2 }),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "whisper",
    name: "WHISPER",
    blurb: "Breath bed and a steep tilt — pitch untouched, so it stays intelligible.",
    chain: chain([
      fx("pitch", { pitch: 0, formant: 1, preserve: 1, shimmer: 18 }),
      fx("noise", { level: -20, type: 0, follow: 0.9, tone: 0.8 }, 0.6),
      fx("eq", { hpFreq: 320, lsGain: -6, b3Freq: 4500, b3Gain: 5, hsFreq: 9000, hsGain: 4 }),
      fx("comp", { threshold: -30, ratio: 4, attack: 4, release: 80, makeup: 8 }),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "announcer",
    name: "ANNOUNCER",
    blurb: "Movie trailer: a touch lower, heavily levelled, tape-warmed.",
    chain: chain([
      fx("pitch", { pitch: -2, formant: -2, preserve: 1 }),
      fx("eq", { hpFreq: 80, lsFreq: 150, lsGain: 4, b2Freq: 2500, b2Gain: 3, hsFreq: 8000, hsGain: 1 }),
      fx("comp", { threshold: -26, ratio: 5, attack: 8, release: 160, makeup: 7, knee: 6 }),
      fx("sat", { drive: 8, curve: 1, output: -2 }, 0.4),
      fx("reverb", { decay: 1.4, size: 0.6, predelay: 30, damping: 0.6 }, 0.14),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
  {
    id: "ghost",
    name: "GHOST",
    blurb: "Jitter pushed past age into instability, drowned in a long tail.",
    chain: chain([
      fx("pitch", { pitch: 1, formant: 3, preserve: 1, jitter: 68, shimmer: 46 }),
      fx("tremolo", { rate: 4.5, depth: 0.35, shape: 0 }, 0.5),
      fx("eq", { hpFreq: 300, b2Freq: 2200, b2Gain: -3, lpFreq: 7000 }),
      fx("reverb", { decay: 5.5, size: 1, damping: 0.3, predelay: 60, modulation: 0.6 }, 0.5),
      fx("delay", { time: 420, feedback: 0.42, lowpass: 4000 }, 0.25),
      fx("limiter", { ceiling: -0.5 }),
    ]),
  },
];

/**
 * Morph dials — the "tweak the generated voice" layer that sits on top of a character.
 *
 * Each dial is a single number the panel owns; `applyMorph` writes it into whichever
 * module actually implements it, adding that module if the character chain doesn't have
 * one. Keeping the mapping here (rather than in the component) means the panel never
 * needs to know which effect provides "breath".
 */
export const MORPH_DIALS: ParamDef[] = [
  { key: "pitch", label: "Pitch", kind: "knob", min: -12, max: 12, def: 0, unit: "st", decimals: 1, step: 0.5, wide: true },
  { key: "tract", label: "Vocal Tract", kind: "knob", min: -12, max: 12, def: 0, unit: "st", decimals: 1, step: 0.5, wide: true },
  { key: "rough", label: "Roughness", kind: "knob", min: 0, max: 100, def: 0, unit: "%", decimals: 0 },
  { key: "breath", label: "Breath", kind: "knob", min: 0, max: 100, def: 0, unit: "%", decimals: 0 },
  { key: "bright", label: "Brightness", kind: "knob", min: -12, max: 12, def: 0, unit: "dB", decimals: 1 },
  { key: "vibRate", label: "Vib Rate", kind: "knob", min: 0.1, max: 9, def: 5, unit: "Hz", decimals: 2, curve: "log" },
  { key: "vibDepth", label: "Vib Depth", kind: "knob", min: 0, max: 100, def: 0, unit: "%", decimals: 0 },
];

export type MorphState = Record<string, number>;

export const DEFAULT_MORPH: MorphState = Object.fromEntries(MORPH_DIALS.map((d) => [d.key, d.def]));

/**
 * Returns a copy of `base` with the morph dials folded in. Offsets are *added* to what the
 * character already does, so PITCH at 0 means "whatever this character chose", not "0
 * semitones" — otherwise every dial would fight the preset the moment it was touched.
 */
export function applyMorph(base: ChainSnapshot, morph: MorphState): ChainSnapshot {
  const slots = base.slots.map((s) => ({ ...s, params: { ...s.params } }));

  const find = (type: string) => slots.find((s) => s.type === type);
  const ensure = (type: string, params: Record<string, number>, mix: number) => {
    const existing = find(type);
    if (existing) return existing;
    const added = fx(type, params, mix);
    // Voice-shaping additions belong before the limiter, which stays last.
    const limiter = slots.findIndex((s) => s.type === "limiter");
    slots.splice(limiter === -1 ? slots.length : limiter, 0, added);
    return added;
  };

  // --- pitch, tract, roughness all live on the pitch module.
  const p = ensure("pitch", { preserve: 1 }, 1);
  p.params.pitch = clamp((p.params.pitch ?? 0) + morph.pitch, -24, 24);
  p.params.formant = clamp((p.params.formant ?? 0) + morph.tract, -24, 24);
  if (morph.rough > 0) {
    // One dial drives both, with shimmer running hotter — level instability reads as age
    // sooner than pitch instability does.
    p.params.jitter = clamp((p.params.jitter ?? 0) + morph.rough * 0.6, 0, 100);
    p.params.shimmer = clamp((p.params.shimmer ?? 0) + morph.rough * 0.8, 0, 100);
  }

  // --- breath: a noise bed keyed to the voice's own envelope.
  if (morph.breath > 0) {
    const n = ensure("noise", { type: 0, follow: 0.9, tone: 0.75 }, 0.5);
    // 0..100 % -> -60..-18 dB. Below about -55 dB it is inaudible, so the low end of the
    // dial is effectively off rather than wasted travel.
    n.params.level = -60 + (morph.breath / 100) * 42;
  }

  // --- brightness: a high shelf, folded into whatever EQ is already there.
  if (Math.abs(morph.bright) > 0.05) {
    const e = ensure("eq", { hsFreq: 7000 }, 1);
    e.params.hsGain = clamp((e.params.hsGain ?? 0) + morph.bright, -24, 24);
  }

  // --- vibrato: chorus is the only module that modulates delay time, which is the closest
  // thing to pitch vibrato the rack has. Honest about it in the UI.
  if (morph.vibDepth > 0) {
    const c = ensure("chorus", { voices: 1, spread: 0, feedback: 0, delay: 8 }, 1);
    c.params.rate = morph.vibRate;
    c.params.depth = (morph.vibDepth / 100) * 0.5;
    c.mix = 0.5 + (morph.vibDepth / 100) * 0.5;
  }

  return { slots, io: { ...base.io } };
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
