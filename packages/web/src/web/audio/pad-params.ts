/**
 * Bro.Kodr — BROBEATS parameter tables.
 *
 * Two separate sets, and the distinction matters:
 *
 *   VOICE params (`PAD_PARAM_DEFS`) shape playback of whatever is on the pad — envelope,
 *   pitch, pan, choke. They apply equally to a synthesised kick and to a sample dragged
 *   in from disk, because `DrumVoice` cannot tell those apart. Their keys match `PAD_KEY`
 *   in backend.ts, which is the wire format.
 *
 *   SYNTH params (`SYNTH_PARAM_DEFS`) drive the generator in `dsp/core/drum-synth.js` and
 *   exist only on synth pads. Turning one re-renders the one-shot on the UI thread, so
 *   they never reach the audio thread at all — the finished buffer does.
 *
 * Both reuse `ParamDef` so the existing `Knob` draws them with no special cases.
 */

import type { ParamDef } from "./param-schema";

/** Voice params, in the order the pad editor lays them out. */
export const PAD_PARAM_DEFS: ParamDef[] = [
  // --- envelope
  { key: "attack", label: "Attack", kind: "knob", min: 0, max: 500, def: 0.5, unit: "ms", curve: "log", decimals: 1, group: "ENVELOPE" },
  { key: "decay", label: "Decay", kind: "knob", min: 1, max: 4000, def: 400, unit: "ms", curve: "log", decimals: 0, group: "ENVELOPE" },
  { key: "sustain", label: "Sustain", kind: "knob", min: 0, max: 1, def: 1, decimals: 2, group: "ENVELOPE" },
  { key: "release", label: "Release", kind: "knob", min: 1, max: 4000, def: 60, unit: "ms", curve: "log", decimals: 0, group: "ENVELOPE" },
  { key: "hold", label: "Hold", kind: "knob", min: 0, max: 4000, def: 0, unit: "ms", curve: "log", decimals: 0, group: "ENVELOPE" },

  // --- playback
  { key: "pitch", label: "Pitch", kind: "knob", min: -36, max: 36, def: 0, unit: "st", decimals: 1, group: "PLAYBACK" },
  { key: "start", label: "Start", kind: "knob", min: 0, max: 0.99, def: 0, decimals: 2, group: "PLAYBACK" },
  { key: "reverse", label: "Reverse", kind: "toggle", min: 0, max: 1, def: 0, group: "PLAYBACK" },
  { key: "velAmount", label: "Vel", kind: "knob", min: 0, max: 1, def: 0.7, decimals: 2, group: "PLAYBACK" },

  // --- mix
  { key: "gain", label: "Level", kind: "knob", min: -60, max: 12, def: 0, unit: "dB", decimals: 1, group: "MIX" },
  { key: "pan", label: "Pan", kind: "knob", min: -1, max: 1, def: 0, decimals: 2, group: "MIX" },
  { key: "mute", label: "Mute", kind: "toggle", min: 0, max: 1, def: 0, group: "MIX" },

  // --- behaviour
  {
    key: "mode",
    label: "Trigger",
    kind: "select",
    min: 0,
    max: 1,
    def: 1,
    options: ["Gate", "One-shot"],
    group: "BEHAVIOUR",
  },
  {
    key: "choke",
    label: "Choke",
    kind: "select",
    min: 0,
    max: 8,
    def: 0,
    step: 1,
    options: ["Off", "1", "2", "3", "4", "5", "6", "7", "8"],
    group: "BEHAVIOUR",
  },
];

export const PAD_PARAM_BY_KEY: Record<string, ParamDef> = Object.fromEntries(
  PAD_PARAM_DEFS.map((d) => [d.key, d]),
);

/** Groups in display order. */
export const PAD_PARAM_GROUPS = ["ENVELOPE", "PLAYBACK", "MIX", "BEHAVIOUR"] as const;

const LEVEL: ParamDef = { key: "level", label: "Level", kind: "knob", min: -24, max: 12, def: 0, unit: "dB", decimals: 1 };

/**
 * Generator knobs per kind. Ranges are chosen to stay musical across the whole sweep —
 * a kick that tunes to 120Hz is a tom, not a broken kick.
 */
export const SYNTH_PARAM_DEFS: Record<string, ParamDef[]> = {
  kick: [
    { key: "tune", label: "Tune", kind: "knob", min: 20, max: 120, def: 52, unit: "Hz", curve: "log", decimals: 1 },
    { key: "drop", label: "Drop", kind: "knob", min: 0, max: 60, def: 34, unit: "st", decimals: 0 },
    { key: "pitchDecay", label: "P.Decay", kind: "knob", min: 2, max: 300, def: 45, unit: "ms", curve: "log", decimals: 0 },
    { key: "decay", label: "Decay", kind: "knob", min: 20, max: 2000, def: 420, unit: "ms", curve: "log", decimals: 0 },
    { key: "drive", label: "Drive", kind: "knob", min: 0, max: 1, def: 0.35, decimals: 2 },
    { key: "click", label: "Click", kind: "knob", min: 0, max: 1, def: 0.3, decimals: 2 },
    LEVEL,
  ],
  snare: [
    { key: "tune", label: "Tune", kind: "knob", min: 80, max: 600, def: 190, unit: "Hz", curve: "log", decimals: 0 },
    { key: "body", label: "Body", kind: "knob", min: 0, max: 1, def: 0.5, decimals: 2 },
    { key: "decay", label: "Decay", kind: "knob", min: 20, max: 1200, def: 180, unit: "ms", curve: "log", decimals: 0 },
    { key: "noiseDecay", label: "N.Decay", kind: "knob", min: 10, max: 1200, def: 150, unit: "ms", curve: "log", decimals: 0 },
    { key: "tone", label: "Tone", kind: "knob", min: 300, max: 9000, def: 2400, unit: "Hz", curve: "log", decimals: 0 },
    { key: "snap", label: "Snap", kind: "knob", min: 0, max: 1, def: 0.6, decimals: 2 },
    LEVEL,
  ],
  hat: [
    { key: "tune", label: "Tune", kind: "knob", min: 1500, max: 12000, def: 8200, unit: "Hz", curve: "log", decimals: 0 },
    { key: "decay", label: "Decay", kind: "knob", min: 5, max: 1500, def: 55, unit: "ms", curve: "log", decimals: 0 },
    { key: "resonance", label: "Reso", kind: "knob", min: 0.3, max: 8, def: 1.6, decimals: 2 },
    { key: "tone", label: "Tone", kind: "knob", min: 0, max: 1, def: 0.6, decimals: 2 },
    LEVEL,
  ],
  clap: [
    { key: "tune", label: "Tune", kind: "knob", min: 300, max: 4000, def: 1400, unit: "Hz", curve: "log", decimals: 0 },
    { key: "spread", label: "Spread", kind: "knob", min: 2, max: 60, def: 24, unit: "ms", decimals: 0 },
    { key: "decay", label: "Decay", kind: "knob", min: 20, max: 900, def: 200, unit: "ms", curve: "log", decimals: 0 },
    { key: "tone", label: "Tone", kind: "knob", min: 0, max: 1, def: 0.55, decimals: 2 },
    LEVEL,
  ],
  tom: [
    { key: "tune", label: "Tune", kind: "knob", min: 50, max: 400, def: 140, unit: "Hz", curve: "log", decimals: 0 },
    { key: "drop", label: "Drop", kind: "knob", min: 0, max: 40, def: 12, unit: "st", decimals: 0 },
    { key: "pitchDecay", label: "P.Decay", kind: "knob", min: 5, max: 400, def: 80, unit: "ms", curve: "log", decimals: 0 },
    { key: "decay", label: "Decay", kind: "knob", min: 30, max: 1500, def: 320, unit: "ms", curve: "log", decimals: 0 },
    { key: "drive", label: "Drive", kind: "knob", min: 0, max: 1, def: 0.2, decimals: 2 },
    LEVEL,
  ],
  rim: [
    { key: "tune", label: "Tune", kind: "knob", min: 400, max: 4000, def: 1700, unit: "Hz", curve: "log", decimals: 0 },
    { key: "decay", label: "Decay", kind: "knob", min: 5, max: 400, def: 42, unit: "ms", curve: "log", decimals: 0 },
    { key: "tone", label: "Tone", kind: "knob", min: 0, max: 1, def: 0.7, decimals: 2 },
    LEVEL,
  ],
};

/** Display names for the generator kinds, for the pad's source picker. */
export const SYNTH_KIND_LABELS: Record<string, string> = {
  kick: "Kick",
  snare: "Snare",
  hat: "Hat / Cymbal",
  clap: "Clap",
  tom: "Tom",
  rim: "Rim / Click",
};

/**
 * Default pad-to-key map for playing the grid from the computer keyboard: the two
 * bottom rows of a QWERTY board under the left and right hands, laid out so the row on
 * screen matches the row under your fingers.
 */
export const PAD_KEYBOARD = ["z", "x", "c", "v", "a", "s", "d", "f", "q", "w", "e", "r", "1", "2", "3", "4"];
