/**
 * Bro.Kodr — parameter schema.
 *
 * The single source of truth for every user-facing parameter in the engine. It drives
 * three things at once, which is why it exists instead of being hardcoded per module:
 *
 *   1. The UI — each rack module renders itself from its param list. Adding a knob to
 *      a DSP module means adding one entry here, not writing a new React component.
 *   2. The wire format — the index of a param inside `params[]` IS the numeric key sent
 *      over the lock-free command ring. The same array is handed to the DSP engine at
 *      `add` time as `paramNames`, so both sides agree without sending strings per
 *      change. This is the reason the order of `params` must never be shuffled.
 *   3. Presets — `defaultParams()` gives the complete parameter set for a module, so a
 *      preset saved today still loads after new params are appended to the end.
 *
 * Rules for editing this file:
 *   - APPEND new params to the end of a module's list. Never reorder or delete.
 *   - `key` must exactly match the string the DSP module's `setParam` switch expects.
 *   - Effect `type` ids must match `dsp/effects/registry.js` — presets store them.
 */

export type ParamCurve = "lin" | "log";
export type ParamKind = "knob" | "select" | "toggle";

export interface ParamDef {
  /** DSP-side param name — must match the module's setParam switch. */
  key: string;
  label: string;
  kind: ParamKind;
  min: number;
  max: number;
  def: number;
  /** Display unit suffix. */
  unit?: string;
  /** log = perceptually-even for frequency/time; lin = everything else. */
  curve?: ParamCurve;
  /** Decimal places shown in the readout. */
  decimals?: number;
  /** Quantise the value (e.g. 1 for integer counts). */
  step?: number;
  /** Option labels for `select` kind — index is the value sent to the DSP. */
  options?: string[];
  /** Visually groups params into a labelled row inside the module. */
  group?: string;
  /** Renders at double width — used for the primary control of a module. */
  wide?: boolean;
}

export type EffectCategory = "dynamics" | "tone" | "voice" | "drive" | "modulation" | "space" | "character";

export interface EffectDef {
  /** Registry id. Stable forever — presets depend on it. */
  type: string;
  name: string;
  /** Short label for the compact rack header. */
  short: string;
  category: EffectCategory;
  blurb: string;
  /** Default dry/wet for a freshly added instance. Utility modules default to 1. */
  defaultMix: number;
  /** Meter readout semantics, shown next to the module title. */
  meter?: { label: string; kind: "gr" | "level" | "activity" };
  /** Module exposes a `visual` curve (currently the EQ response). */
  hasCurve?: boolean;
  /** Latency warning shown in the module header. */
  latency?: string;
  params: ParamDef[];
}

const FILTER_SLOPES = ["12 dB", "24 dB", "36 dB", "48 dB"];
const LFO_SHAPES = ["Sine", "Triangle", "Saw", "Square", "S&H"];
const SYNC_DIVISIONS = ["Free", "1/1", "1/2", "1/4", "1/8", "1/16", "1/4T", "1/8T", "1/8D", "1/16D"];
const DRIVE_CURVES = ["Tanh", "Tube", "Fold", "Clip", "Diode", "Fuzz"];

export const EFFECTS: Record<string, EffectDef> = {
  // ------------------------------------------------------------------ tone
  eq: {
    type: "eq",
    name: "Parametric EQ",
    short: "EQ",
    category: "tone",
    blurb: "6-band: variable-slope HP, low shelf, 3 parametric peaks, high shelf, variable-slope LP.",
    defaultMix: 1,
    hasCurve: true,
    params: [
      { key: "hpFreq", label: "HP Freq", kind: "knob", min: 20, max: 1000, def: 20, unit: "Hz", curve: "log", decimals: 0, group: "High Pass" },
      { key: "hpSlope", label: "Slope", kind: "select", min: 0, max: 3, def: 0, options: FILTER_SLOPES, group: "High Pass" },
      { key: "lsFreq", label: "Freq", kind: "knob", min: 30, max: 500, def: 120, unit: "Hz", curve: "log", decimals: 0, group: "Low Shelf" },
      { key: "lsGain", label: "Gain", kind: "knob", min: -18, max: 18, def: 0, unit: "dB", decimals: 1, group: "Low Shelf" },
      { key: "b1Freq", label: "Freq", kind: "knob", min: 40, max: 2000, def: 300, unit: "Hz", curve: "log", decimals: 0, group: "Band 1" },
      { key: "b1Gain", label: "Gain", kind: "knob", min: -18, max: 18, def: 0, unit: "dB", decimals: 1, group: "Band 1" },
      { key: "b1Q", label: "Q", kind: "knob", min: 0.2, max: 12, def: 0.9, curve: "log", decimals: 2, group: "Band 1" },
      { key: "b2Freq", label: "Freq", kind: "knob", min: 200, max: 8000, def: 1200, unit: "Hz", curve: "log", decimals: 0, group: "Band 2" },
      { key: "b2Gain", label: "Gain", kind: "knob", min: -18, max: 18, def: 0, unit: "dB", decimals: 1, group: "Band 2" },
      { key: "b2Q", label: "Q", kind: "knob", min: 0.2, max: 12, def: 0.9, curve: "log", decimals: 2, group: "Band 2" },
      { key: "b3Freq", label: "Freq", kind: "knob", min: 1000, max: 18000, def: 4500, unit: "Hz", curve: "log", decimals: 0, group: "Band 3" },
      { key: "b3Gain", label: "Gain", kind: "knob", min: -18, max: 18, def: 0, unit: "dB", decimals: 1, group: "Band 3" },
      { key: "b3Q", label: "Q", kind: "knob", min: 0.2, max: 12, def: 0.9, curve: "log", decimals: 2, group: "Band 3" },
      { key: "hsFreq", label: "Freq", kind: "knob", min: 2000, max: 18000, def: 8000, unit: "Hz", curve: "log", decimals: 0, group: "High Shelf" },
      { key: "hsGain", label: "Gain", kind: "knob", min: -18, max: 18, def: 0, unit: "dB", decimals: 1, group: "High Shelf" },
      { key: "lpFreq", label: "LP Freq", kind: "knob", min: 500, max: 20000, def: 20000, unit: "Hz", curve: "log", decimals: 0, group: "Low Pass" },
      { key: "lpSlope", label: "Slope", kind: "select", min: 0, max: 3, def: 0, options: FILTER_SLOPES, group: "Low Pass" },
      { key: "output", label: "Output", kind: "knob", min: -24, max: 24, def: 0, unit: "dB", decimals: 1, group: "Output" },
    ],
  },

  // -------------------------------------------------------------- dynamics
  comp: {
    type: "comp",
    name: "Compressor",
    short: "COMP",
    category: "dynamics",
    blurb: "Log-domain feed-forward compressor with soft knee, stereo-linked detection and optional lookahead.",
    defaultMix: 1,
    meter: { label: "GR", kind: "gr" },
    params: [
      { key: "threshold", label: "Threshold", kind: "knob", min: -60, max: 0, def: -18, unit: "dB", decimals: 1, wide: true },
      { key: "ratio", label: "Ratio", kind: "knob", min: 1, max: 20, def: 4, unit: ":1", curve: "log", decimals: 1 },
      { key: "attack", label: "Attack", kind: "knob", min: 0.1, max: 200, def: 10, unit: "ms", curve: "log", decimals: 1 },
      { key: "release", label: "Release", kind: "knob", min: 5, max: 2000, def: 120, unit: "ms", curve: "log", decimals: 0 },
      { key: "knee", label: "Knee", kind: "knob", min: 0, max: 24, def: 6, unit: "dB", decimals: 1 },
      { key: "makeup", label: "Makeup", kind: "knob", min: -12, max: 24, def: 0, unit: "dB", decimals: 1 },
      { key: "detector", label: "Detector", kind: "select", min: 0, max: 1, def: 0, options: ["Peak", "RMS"] },
      { key: "lookahead", label: "Lookahead", kind: "knob", min: 0, max: 10, def: 0, unit: "ms", decimals: 1 },
    ],
  },
  limiter: {
    type: "limiter",
    name: "Limiter",
    short: "LIMIT",
    category: "dynamics",
    blurb: "Lookahead brickwall limiter with a sliding-maximum detector. Output never exceeds the ceiling.",
    defaultMix: 1,
    meter: { label: "GR", kind: "gr" },
    params: [
      { key: "ceiling", label: "Ceiling", kind: "knob", min: -24, max: 0, def: -0.3, unit: "dB", decimals: 1, wide: true },
      { key: "release", label: "Release", kind: "knob", min: 5, max: 500, def: 80, unit: "ms", curve: "log", decimals: 0 },
    ],
  },
  gate: {
    type: "gate",
    name: "Noise Gate",
    short: "GATE",
    category: "dynamics",
    blurb: "Hysteresis gate with hold, range and a sidechain highpass so LF rumble can't hold it open.",
    defaultMix: 1,
    meter: { label: "GR", kind: "gr" },
    params: [
      { key: "threshold", label: "Threshold", kind: "knob", min: -80, max: 0, def: -45, unit: "dB", decimals: 1, wide: true },
      { key: "range", label: "Range", kind: "knob", min: -90, max: 0, def: -60, unit: "dB", decimals: 0 },
      { key: "attack", label: "Attack", kind: "knob", min: 0.1, max: 50, def: 1, unit: "ms", curve: "log", decimals: 1 },
      { key: "release", label: "Release", kind: "knob", min: 5, max: 1000, def: 120, unit: "ms", curve: "log", decimals: 0 },
      { key: "hold", label: "Hold", kind: "knob", min: 0, max: 500, def: 40, unit: "ms", decimals: 0 },
      { key: "hysteresis", label: "Hysteresis", kind: "knob", min: 0, max: 20, def: 4, unit: "dB", decimals: 1 },
      { key: "scfreq", label: "SC HP", kind: "knob", min: 20, max: 800, def: 80, unit: "Hz", curve: "log", decimals: 0 },
    ],
  },
  transient: {
    type: "transient",
    name: "Transient Shaper",
    short: "TRANS",
    category: "dynamics",
    blurb: "Envelope-difference transient designer. Adds or removes attack and sustain independently of level.",
    defaultMix: 1,
    meter: { label: "GAIN", kind: "gr" },
    params: [
      { key: "attack", label: "Attack", kind: "knob", min: -12, max: 12, def: 0, unit: "dB", decimals: 1, wide: true },
      { key: "sustain", label: "Sustain", kind: "knob", min: -12, max: 12, def: 0, unit: "dB", decimals: 1 },
      { key: "speed", label: "Speed", kind: "knob", min: 0.2, max: 3, def: 1, decimals: 2 },
    ],
  },

  // ------------------------------------------------------------------ drive
  dist: {
    type: "dist",
    name: "Distortion",
    short: "DIST",
    category: "drive",
    blurb: "Six waveshapers, 4x oversampled so the harmonics stay above the audio band instead of aliasing down into it.",
    defaultMix: 1,
    params: [
      { key: "drive", label: "Drive", kind: "knob", min: 0, max: 40, def: 12, unit: "dB", decimals: 1, wide: true },
      { key: "curve", label: "Curve", kind: "select", min: 0, max: 5, def: 3, options: DRIVE_CURVES },
      { key: "tone", label: "Tone", kind: "knob", min: 200, max: 20000, def: 8000, unit: "Hz", curve: "log", decimals: 0 },
      { key: "tonemode", label: "Tone Mode", kind: "select", min: 0, max: 1, def: 0, options: ["Post LP", "Pre LP"] },
      { key: "bias", label: "Bias", kind: "knob", min: -0.5, max: 0.5, def: 0, decimals: 2 },
      { key: "prehp", label: "Pre HP", kind: "knob", min: 20, max: 800, def: 20, unit: "Hz", curve: "log", decimals: 0 },
      { key: "output", label: "Output", kind: "knob", min: -36, max: 12, def: -6, unit: "dB", decimals: 1 },
      { key: "oversample", label: "Oversample", kind: "toggle", min: 0, max: 1, def: 1 },
    ],
  },
  sat: {
    type: "sat",
    name: "Saturation",
    short: "SAT",
    category: "drive",
    blurb: "Same oversampled shaper core tuned for gentle analogue-style thickening rather than obvious breakup.",
    defaultMix: 1,
    params: [
      { key: "drive", label: "Drive", kind: "knob", min: 0, max: 24, def: 6, unit: "dB", decimals: 1, wide: true },
      { key: "curve", label: "Curve", kind: "select", min: 0, max: 5, def: 1, options: DRIVE_CURVES },
      { key: "tone", label: "Tone", kind: "knob", min: 200, max: 20000, def: 12000, unit: "Hz", curve: "log", decimals: 0 },
      { key: "tonemode", label: "Tone Mode", kind: "select", min: 0, max: 1, def: 0, options: ["Post LP", "Pre LP"] },
      { key: "bias", label: "Bias", kind: "knob", min: -0.5, max: 0.5, def: 0, decimals: 2 },
      { key: "prehp", label: "Pre HP", kind: "knob", min: 20, max: 800, def: 30, unit: "Hz", curve: "log", decimals: 0 },
      { key: "output", label: "Output", kind: "knob", min: -36, max: 12, def: -2, unit: "dB", decimals: 1 },
      { key: "oversample", label: "Oversample", kind: "toggle", min: 0, max: 1, def: 1 },
    ],
  },
  crush: {
    type: "crush",
    name: "Bit Crusher",
    short: "CRUSH",
    category: "drive",
    blurb: "Bit-depth quantiser plus sample-and-hold decimator, with TPDF dither and an optional anti-alias filter.",
    defaultMix: 1,
    params: [
      { key: "bits", label: "Bits", kind: "knob", min: 1, max: 24, def: 8, step: 1, decimals: 0, wide: true },
      { key: "rate", label: "Rate", kind: "knob", min: 500, max: 48000, def: 12000, unit: "Hz", curve: "log", decimals: 0 },
      { key: "dither", label: "Dither", kind: "knob", min: 0, max: 1, def: 0, decimals: 2 },
      { key: "drive", label: "Drive", kind: "knob", min: -12, max: 24, def: 0, unit: "dB", decimals: 1 },
      { key: "output", label: "Output", kind: "knob", min: -24, max: 12, def: 0, unit: "dB", decimals: 1 },
      { key: "smooth", label: "Smooth", kind: "knob", min: 0, max: 1, def: 0, decimals: 2 },
    ],
  },

  // ------------------------------------------------------------------ voice
  pitch: {
    type: "pitch",
    name: "Pitch / Formant",
    short: "PITCH",
    category: "voice",
    blurb:
      "Phase-vocoder pitch shifter with cepstral formant separation, so pitch and vocal-tract character move independently.",
    defaultMix: 1,
    latency: "Adds latency equal to the FFT size (Quality setting).",
    params: [
      { key: "pitch", label: "Pitch", kind: "knob", min: -24, max: 24, def: 0, unit: "st", step: 1, decimals: 0, wide: true },
      { key: "fine", label: "Fine", kind: "knob", min: -100, max: 100, def: 0, unit: "ct", decimals: 0 },
      { key: "formant", label: "Formant", kind: "knob", min: -12, max: 12, def: 0, unit: "st", decimals: 1 },
      { key: "preserve", label: "Preserve Formants", kind: "toggle", min: 0, max: 1, def: 1 },
      { key: "lifter", label: "Lifter", kind: "knob", min: 8, max: 120, def: 40, step: 1, decimals: 0 },
      { key: "quality", label: "Quality", kind: "select", min: 0, max: 3, def: 1, options: ["512 / Fast", "1024 / Normal", "2048 / High", "4096 / Best"] },
      // APPENDED — never reorder this list, the index is the wire key on the command ring.
      { key: "jitter", label: "Jitter", kind: "knob", min: 0, max: 100, def: 0, unit: "%", decimals: 0 },
      { key: "shimmer", label: "Shimmer", kind: "knob", min: 0, max: 100, def: 0, unit: "%", decimals: 0 },
    ],
  },
  vocoder: {
    type: "vocoder",
    name: "Vocoder",
    short: "VOCODE",
    category: "voice",
    blurb:
      "True channel vocoder: a bandpass filterbank splits your voice, envelope followers drive matching VCAs on a synth carrier.",
    defaultMix: 1,
    params: [
      { key: "bands", label: "Bands", kind: "knob", min: 4, max: 32, def: 20, step: 1, decimals: 0, wide: true },
      { key: "carrier", label: "Carrier", kind: "select", min: 0, max: 4, def: 1, options: ["Saw", "Square", "Pulse", "Supersaw", "Noise"] },
      { key: "pitch", label: "Carrier Pitch", kind: "knob", min: 40, max: 800, def: 110, unit: "Hz", curve: "log", decimals: 1 },
      { key: "follow", label: "Follow Voice", kind: "toggle", min: 0, max: 1, def: 0 },
      { key: "freqlo", label: "Low", kind: "knob", min: 60, max: 500, def: 150, unit: "Hz", curve: "log", decimals: 0, group: "Range" },
      { key: "freqhi", label: "High", kind: "knob", min: 2000, max: 16000, def: 7000, unit: "Hz", curve: "log", decimals: 0, group: "Range" },
      { key: "q", label: "Band Q", kind: "knob", min: 1, max: 20, def: 6, curve: "log", decimals: 1, group: "Range" },
      { key: "depth", label: "Depth", kind: "knob", min: 0, max: 1, def: 1, decimals: 2 },
      { key: "tone", label: "Tone Tilt", kind: "knob", min: -1, max: 1, def: 0, decimals: 2 },
      { key: "sibilance", label: "Sibilance", kind: "knob", min: 0, max: 1, def: 0.35, decimals: 2 },
      { key: "attack", label: "Attack", kind: "knob", min: 0.2, max: 50, def: 3, unit: "ms", curve: "log", decimals: 1 },
      { key: "release", label: "Release", kind: "knob", min: 2, max: 400, def: 25, unit: "ms", curve: "log", decimals: 0 },
      { key: "carrierlevel", label: "Carrier Leak", kind: "knob", min: 0, max: 1, def: 0, decimals: 2 },
      { key: "spread", label: "Stereo Spread", kind: "knob", min: 0, max: 1, def: 0.3, decimals: 2 },
      { key: "output", label: "Output", kind: "knob", min: -24, max: 18, def: 0, unit: "dB", decimals: 1 },
      { key: "source", label: "Carrier Source", kind: "select", min: 0, max: 1, def: 0, options: ["Internal Synth", "Audio File"], wide: true },
    ],
  },

  talkbox: {
    type: "talkbox",
    name: "Talk Box",
    short: "TALKBX",
    category: "voice",
    blurb:
      "Heil-style talk box. LPC fits your vocal tract in real time and drives an internal instrument through it — the tube-in-the-mouth sound, not a filterbank vocoder.",
    defaultMix: 1,
    meter: { label: "TUBE", kind: "activity" },
    params: [
      { key: "carrier", label: "Driver", kind: "select", min: 0, max: 5, def: 0, options: ["Saw", "Square", "Pulse", "Dual Saw", "Sub + Saw", "Noise"], wide: true },
      { key: "pitch", label: "Driver Pitch", kind: "knob", min: 40, max: 800, def: 110, unit: "Hz", curve: "log", decimals: 1 },
      { key: "follow", label: "Follow Voice", kind: "toggle", min: 0, max: 1, def: 1 },
      { key: "glide", label: "Glide", kind: "knob", min: 0, max: 300, def: 40, unit: "ms", decimals: 0 },
      { key: "order", label: "Tract Detail", kind: "knob", min: 8, max: 40, def: 22, step: 2, decimals: 0, group: "Tract" },
      { key: "tract", label: "Tract Size", kind: "knob", min: 0.5, max: 2, def: 1, decimals: 2, group: "Tract" },
      { key: "tractq", label: "Tract Q", kind: "knob", min: 0, max: 1, def: 0.9, decimals: 2, group: "Tract" },
      { key: "brightness", label: "Brightness", kind: "knob", min: -1, max: 1, def: 0.2, decimals: 2 },
      { key: "breath", label: "Breath", kind: "knob", min: 0, max: 1, def: 0.3, decimals: 2 },
      { key: "squelch", label: "Squelch", kind: "knob", min: -90, max: -10, def: -52, unit: "dB", decimals: 0 },
      { key: "drive", label: "Drive", kind: "knob", min: 0, max: 1, def: 0.25, decimals: 2 },
      { key: "output", label: "Output", kind: "knob", min: -24, max: 18, def: 0, unit: "dB", decimals: 1 },
      { key: "source", label: "Driver Source", kind: "select", min: 0, max: 1, def: 0, options: ["Internal Synth", "Audio File"], wide: true },
    ],
  },

  // ------------------------------------------------------------- modulation
  chorus: {
    type: "chorus",
    name: "Chorus",
    short: "CHOR",
    category: "modulation",
    blurb: "Up to 3 modulated voices per channel with Hermite-interpolated delay lines — no zipper on fast sweeps.",
    defaultMix: 0.5,
    params: [
      { key: "rate", label: "Rate", kind: "knob", min: 0.01, max: 8, def: 0.4, unit: "Hz", curve: "log", decimals: 2, wide: true },
      { key: "depth", label: "Depth", kind: "knob", min: 0, max: 1, def: 0.4, decimals: 2 },
      { key: "delay", label: "Delay", kind: "knob", min: 1, max: 40, def: 12, unit: "ms", decimals: 1 },
      { key: "voices", label: "Voices", kind: "select", min: 1, max: 3, def: 3, options: ["1", "2", "3"] },
      { key: "spread", label: "Spread", kind: "knob", min: 0, max: 1, def: 1, decimals: 2 },
      { key: "feedback", label: "Feedback", kind: "knob", min: -0.95, max: 0.95, def: 0, decimals: 2 },
    ],
  },
  flanger: {
    type: "flanger",
    name: "Flanger",
    short: "FLANG",
    category: "modulation",
    blurb: "Short modulated delay with polarity-invertible, damped feedback for jet-sweep comb effects.",
    defaultMix: 0.5,
    params: [
      { key: "rate", label: "Rate", kind: "knob", min: 0.01, max: 10, def: 0.25, unit: "Hz", curve: "log", decimals: 2, wide: true },
      { key: "depth", label: "Depth", kind: "knob", min: 0, max: 1, def: 0.5, decimals: 2 },
      { key: "delay", label: "Delay", kind: "knob", min: 0.2, max: 20, def: 1, unit: "ms", decimals: 2 },
      { key: "feedback", label: "Feedback", kind: "knob", min: -0.98, max: 0.98, def: 0.5, decimals: 2 },
      { key: "invert", label: "Invert", kind: "toggle", min: 0, max: 1, def: 0 },
      { key: "damp", label: "Damp", kind: "knob", min: 500, max: 20000, def: 8000, unit: "Hz", curve: "log", decimals: 0 },
      { key: "stereo", label: "Stereo", kind: "knob", min: 0, max: 0.5, def: 0.25, decimals: 2 },
      { key: "shape", label: "Shape", kind: "select", min: 0, max: 4, def: 0, options: LFO_SHAPES },
    ],
  },
  phaser: {
    type: "phaser",
    name: "Phaser",
    short: "PHASE",
    category: "modulation",
    blurb: "2-8 cascaded allpass stages swept by an LFO, with resonant feedback.",
    defaultMix: 0.5,
    params: [
      { key: "rate", label: "Rate", kind: "knob", min: 0.01, max: 10, def: 0.3, unit: "Hz", curve: "log", decimals: 2, wide: true },
      { key: "depth", label: "Depth", kind: "knob", min: 0, max: 1, def: 0.7, decimals: 2 },
      { key: "center", label: "Center", kind: "knob", min: 100, max: 4000, def: 800, unit: "Hz", curve: "log", decimals: 0 },
      { key: "stages", label: "Stages", kind: "select", min: 1, max: 8, def: 4, options: ["1", "2", "3", "4", "5", "6", "7", "8"] },
      { key: "feedback", label: "Feedback", kind: "knob", min: -0.9, max: 0.9, def: 0.3, decimals: 2 },
      { key: "q", label: "Q", kind: "knob", min: 0.3, max: 4, def: 0.7, decimals: 2 },
      { key: "stereo", label: "Stereo", kind: "knob", min: 0, max: 0.5, def: 0.25, decimals: 2 },
      { key: "shape", label: "Shape", kind: "select", min: 0, max: 4, def: 0, options: LFO_SHAPES },
    ],
  },
  tremolo: {
    type: "tremolo",
    name: "Tremolo / Pan",
    short: "TREM",
    category: "modulation",
    blurb: "Amplitude LFO with selectable shape. Switch to auto-pan or hard gate for rhythmic chopping.",
    defaultMix: 1,
    params: [
      { key: "rate", label: "Rate", kind: "knob", min: 0.05, max: 30, def: 5, unit: "Hz", curve: "log", decimals: 2, wide: true },
      { key: "depth", label: "Depth", kind: "knob", min: 0, max: 1, def: 0.5, decimals: 2 },
      { key: "shape", label: "Shape", kind: "select", min: 0, max: 4, def: 0, options: LFO_SHAPES },
      { key: "mode", label: "Mode", kind: "select", min: 0, max: 1, def: 0, options: ["Tremolo", "Auto-Pan"] },
      { key: "phase", label: "R Phase", kind: "knob", min: 0, max: 1, def: 0.5, decimals: 2 },
    ],
  },
  ringmod: {
    type: "ringmod",
    name: "Ring Mod",
    short: "RING",
    category: "modulation",
    blurb: "Four-quadrant multiply against an oscillator. The classic robot/Dalek timbre; AM mode keeps the carrier.",
    defaultMix: 1,
    params: [
      { key: "freq", label: "Freq", kind: "knob", min: 5, max: 4000, def: 200, unit: "Hz", curve: "log", decimals: 1, wide: true },
      { key: "shape", label: "Shape", kind: "select", min: 0, max: 3, def: 0, options: ["Sine", "Triangle", "Saw", "Square"] },
      { key: "mode", label: "Mode", kind: "select", min: 0, max: 1, def: 0, options: ["Ring", "AM"] },
      { key: "sweeprate", label: "Sweep Rate", kind: "knob", min: 0, max: 10, def: 0, unit: "Hz", decimals: 2 },
      { key: "sweepdepth", label: "Sweep Depth", kind: "knob", min: 0, max: 1, def: 0, decimals: 2 },
    ],
  },
  freqshift: {
    type: "freqshift",
    name: "Frequency Shifter",
    short: "FSHIFT",
    category: "modulation",
    blurb: "Hilbert-transform single-sideband shifter. Moves every partial by a fixed Hz — inharmonic, unlike pitch shift.",
    defaultMix: 1,
    params: [
      { key: "freq", label: "Shift", kind: "knob", min: -1000, max: 1000, def: 0, unit: "Hz", decimals: 1, wide: true },
      { key: "feedback", label: "Feedback", kind: "knob", min: 0, max: 0.9, def: 0, decimals: 2 },
    ],
  },

  // ------------------------------------------------------------------ space
  delay: {
    type: "delay",
    name: "Delay",
    short: "DELAY",
    category: "space",
    blurb: "Tempo-syncable stereo delay with ping-pong, filtered and saturated feedback, and modulated delay time.",
    defaultMix: 0.3,
    params: [
      { key: "time", label: "Time", kind: "knob", min: 1, max: 3900, def: 250, unit: "ms", curve: "log", decimals: 0, wide: true },
      { key: "sync", label: "Sync", kind: "select", min: 0, max: 9, def: 0, options: SYNC_DIVISIONS },
      { key: "bpm", label: "BPM", kind: "knob", min: 20, max: 300, def: 120, step: 1, decimals: 0 },
      { key: "feedback", label: "Feedback", kind: "knob", min: 0, max: 1.1, def: 0.35, decimals: 2 },
      { key: "pingpong", label: "Ping-Pong", kind: "toggle", min: 0, max: 1, def: 0 },
      { key: "lowpass", label: "Damp LP", kind: "knob", min: 500, max: 20000, def: 6000, unit: "Hz", curve: "log", decimals: 0 },
      { key: "highpass", label: "Damp HP", kind: "knob", min: 20, max: 2000, def: 180, unit: "Hz", curve: "log", decimals: 0 },
      { key: "moddepth", label: "Mod Depth", kind: "knob", min: 0, max: 1, def: 0, decimals: 2 },
      { key: "modrate", label: "Mod Rate", kind: "knob", min: 0.01, max: 5, def: 0.3, unit: "Hz", curve: "log", decimals: 2 },
      { key: "spread", label: "Spread", kind: "knob", min: 0, max: 1, def: 0, decimals: 2 },
      { key: "crossfeed", label: "Crossfeed", kind: "knob", min: 0, max: 1, def: 0, decimals: 2 },
      { key: "saturate", label: "Saturate", kind: "knob", min: 0, max: 1, def: 0, decimals: 2 },
    ],
  },
  reverb: {
    type: "reverb",
    name: "Reverb",
    short: "VERB",
    category: "space",
    blurb:
      "8x8 feedback delay network with Hadamard mixing and allpass diffusion — dense tail, no ringing comb resonances.",
    defaultMix: 0.25,
    params: [
      { key: "decay", label: "Decay", kind: "knob", min: 0, max: 0.995, def: 0.75, decimals: 3, wide: true },
      { key: "size", label: "Size", kind: "knob", min: 0.2, max: 3, def: 1, decimals: 2 },
      { key: "damping", label: "Damping", kind: "knob", min: 0, max: 0.99, def: 0.4, decimals: 2 },
      { key: "predelay", label: "Pre-Delay", kind: "knob", min: 0, max: 200, def: 12, unit: "ms", decimals: 0 },
      { key: "width", label: "Width", kind: "knob", min: 0, max: 1, def: 1, decimals: 2 },
      { key: "highpass", label: "Low Cut", kind: "knob", min: 20, max: 1000, def: 120, unit: "Hz", curve: "log", decimals: 0 },
      { key: "modulation", label: "Modulation", kind: "knob", min: 0, max: 1, def: 0.15, decimals: 2 },
      { key: "diffusion", label: "Diffusion", kind: "knob", min: 0, max: 0.9, def: 0.6, decimals: 2 },
    ],
  },

  // -------------------------------------------------------------- character
  character: {
    type: "character",
    name: "Character",
    short: "CHAR",
    category: "character",
    blurb: "Eight modelled transmission chains — telephone, AM radio, megaphone, walkie, cassette, vinyl, intercom, lo-fi tape.",
    defaultMix: 1,
    params: [
      {
        key: "mode",
        label: "Mode",
        kind: "select",
        min: 0,
        max: 7,
        def: 0,
        options: ["Telephone", "AM Radio", "Megaphone", "Walkie-Talkie", "Cassette", "Vinyl", "Intercom", "Lo-Fi Tape"],
        wide: true,
      },
      { key: "amount", label: "Amount", kind: "knob", min: 0, max: 1, def: 1, decimals: 2 },
      { key: "drive", label: "Drive Trim", kind: "knob", min: -12, max: 12, def: 0, unit: "dB", decimals: 1 },
      { key: "noise", label: "Noise", kind: "knob", min: 0, max: 3, def: 1, decimals: 2 },
      { key: "wobble", label: "Wobble", kind: "knob", min: 0, max: 3, def: 1, decimals: 2 },
      { key: "output", label: "Output", kind: "knob", min: -24, max: 18, def: 0, unit: "dB", decimals: 1 },
    ],
  },
  glitch: {
    type: "glitch",
    name: "Glitch / Stutter",
    short: "GLITCH",
    category: "character",
    blurb: "Tempo-locked buffer slicer: repeats, reverses and re-pitches slices on a probability roll. Freeze holds one slice.",
    defaultMix: 1,
    meter: { label: "ACTIVE", kind: "activity" },
    params: [
      { key: "probability", label: "Chance", kind: "knob", min: 0, max: 1, def: 0.35, decimals: 2, wide: true },
      { key: "bpm", label: "BPM", kind: "knob", min: 20, max: 300, def: 120, step: 1, decimals: 0 },
      { key: "division", label: "Slice", kind: "select", min: 1, max: 8, def: 4, options: ["1/beat", "2", "3", "4", "5", "6", "7", "8"] },
      { key: "repeats", label: "Repeats", kind: "knob", min: 1, max: 8, def: 2, step: 1, decimals: 0 },
      { key: "reverse", label: "Reverse", kind: "knob", min: 0, max: 1, def: 0, decimals: 2 },
      { key: "pitch", label: "Slice Pitch", kind: "knob", min: 0.25, max: 4, def: 1, curve: "log", decimals: 2 },
      { key: "freeze", label: "Freeze", kind: "toggle", min: 0, max: 1, def: 0 },
    ],
  },
  noise: {
    type: "noise",
    name: "Noise Bed",
    short: "NOISE",
    category: "character",
    blurb: "White / pink / brown noise layer with a level-follow mode, for hiss, air and transmission texture.",
    defaultMix: 1,
    params: [
      { key: "level", label: "Level", kind: "knob", min: -80, max: -6, def: -60, unit: "dB", decimals: 1, wide: true },
      { key: "type", label: "Type", kind: "select", min: 0, max: 2, def: 1, options: ["White", "Pink", "Brown"] },
      { key: "follow", label: "Follow", kind: "knob", min: 0, max: 1, def: 0, decimals: 2 },
      { key: "tone", label: "Tone", kind: "knob", min: 500, max: 20000, def: 20000, unit: "Hz", curve: "log", decimals: 0 },
    ],
  },
};

export const EFFECT_LIST: EffectDef[] = Object.values(EFFECTS);

export const CATEGORY_LABELS: Record<EffectCategory, string> = {
  tone: "Tone",
  dynamics: "Dynamics",
  drive: "Drive",
  voice: "Voice",
  modulation: "Modulation",
  space: "Space",
  character: "Character",
};

export const CATEGORY_ORDER: EffectCategory[] = ["tone", "dynamics", "drive", "voice", "modulation", "space", "character"];

/** Param name table in wire order — handed to the DSP engine at `add` time. */
export function paramNames(type: string): string[] {
  const def = EFFECTS[type];
  return def ? def.params.map((p) => p.key) : [];
}

/** Wire index for a param. -1 when unknown, which callers treat as "drop it". */
export function paramIndex(type: string, key: string): number {
  const def = EFFECTS[type];
  if (!def) return -1;
  for (let i = 0; i < def.params.length; i++) if (def.params[i].key === key) return i;
  return -1;
}

export function paramDef(type: string, key: string): ParamDef | undefined {
  return EFFECTS[type]?.params.find((p) => p.key === key);
}

/** Complete default parameter set for a module. */
export function defaultParams(type: string): Record<string, number> {
  const out: Record<string, number> = {};
  const def = EFFECTS[type];
  if (!def) return out;
  for (const p of def.params) out[p.key] = p.def;
  return out;
}

/**
 * Merge a stored (possibly older) param set over the current defaults, so presets
 * survive params being appended to a module later.
 */
export function withDefaults(type: string, stored: Record<string, number> | undefined): Record<string, number> {
  const out = defaultParams(type);
  if (!stored) return out;
  for (const k in stored) {
    if (k in out && Number.isFinite(stored[k])) out[k] = stored[k];
  }
  return out;
}

// ------------------------------------------------------------------ mapping
// Knob position (0..1) <-> parameter value. Frequencies and times use a log map so
// the low end of the range gets the resolution it needs; everything else is linear.

const LOG_FLOOR = 1e-4;

export function normToValue(p: ParamDef, t: number): number {
  const n = t < 0 ? 0 : t > 1 ? 1 : t;
  let v: number;
  if (p.curve === "log") {
    const lo = Math.max(p.min, LOG_FLOOR);
    const hi = Math.max(p.max, lo * 1.0001);
    v = lo * Math.pow(hi / lo, n);
  } else {
    v = p.min + (p.max - p.min) * n;
  }
  if (p.step) v = Math.round(v / p.step) * p.step;
  return clampParam(p, v);
}

export function valueToNorm(p: ParamDef, value: number): number {
  const v = clampParam(p, value);
  if (p.curve === "log") {
    const lo = Math.max(p.min, LOG_FLOOR);
    const hi = Math.max(p.max, lo * 1.0001);
    return Math.log(Math.max(v, lo) / lo) / Math.log(hi / lo);
  }
  return p.max === p.min ? 0 : (v - p.min) / (p.max - p.min);
}

export function clampParam(p: ParamDef, v: number): number {
  if (!Number.isFinite(v)) return p.def;
  return v < p.min ? p.min : v > p.max ? p.max : v;
}

export function formatParam(p: ParamDef, v: number): string {
  if (p.kind === "toggle") return v >= 0.5 ? "ON" : "OFF";
  if (p.kind === "select" && p.options) {
    const i = Math.round(v) - Math.round(p.min);
    return p.options[i] ?? String(v);
  }
  const d = p.decimals ?? 2;
  let text: string;
  if (p.unit === "Hz" && v >= 1000) text = `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)}k`;
  else text = v.toFixed(d);
  return p.unit ? `${text} ${p.unit}` : text;
}
