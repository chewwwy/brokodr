/*
 * Bro.Kodr DSP core — parameter keys. GENERATED, DO NOT EDIT.
 *
 * Sources:   packages/web/src/web/audio/param-schema.ts (chain effect params)
 *            packages/web/src/web/audio/backend.ts (pad, rack, looper, transport params)
 * Generator: scripts/gen-param-keys.mjs
 *
 * Regenerate with `bun scripts/gen-param-keys.mjs`. CI runs the same script
 * with --check, so an edit to the schema that misses this header fails there
 * rather than silently driving the wrong parameter at runtime.
 *
 * The value of each key is the param's index inside its own effect type's
 * list, which is what the command ring carries. Indices are append-only:
 * param-schema.ts forbids reordering because presets and the wire format
 * both depend on them holding still.
 */

#ifndef BROKODR_DSP_PARAM_KEYS_H
#define BROKODR_DSP_PARAM_KEYS_H

/* No effect type has a param at this index; use it for "not present". */
#define BK_PARAM_NONE (-1)

/* character — Character */
enum {
  BK_P_CHARACTER_MODE = 0,
  BK_P_CHARACTER_AMOUNT = 1,
  BK_P_CHARACTER_DRIVE = 2,
  BK_P_CHARACTER_NOISE = 3,
  BK_P_CHARACTER_WOBBLE = 4,
  BK_P_CHARACTER_OUTPUT = 5,
  BK_P_CHARACTER_COUNT = 6
};
#define BK_P_CHARACTER_QUALITY_KEY BK_PARAM_NONE

/* chorus — Chorus */
enum {
  BK_P_CHORUS_RATE = 0,
  BK_P_CHORUS_DEPTH = 1,
  BK_P_CHORUS_DELAY = 2,
  BK_P_CHORUS_VOICES = 3,
  BK_P_CHORUS_SPREAD = 4,
  BK_P_CHORUS_FEEDBACK = 5,
  BK_P_CHORUS_COUNT = 6
};
#define BK_P_CHORUS_QUALITY_KEY BK_PARAM_NONE

/* comp — Compressor */
enum {
  BK_P_COMP_THRESHOLD = 0,
  BK_P_COMP_RATIO = 1,
  BK_P_COMP_ATTACK = 2,
  BK_P_COMP_RELEASE = 3,
  BK_P_COMP_KNEE = 4,
  BK_P_COMP_MAKEUP = 5,
  BK_P_COMP_DETECTOR = 6,
  BK_P_COMP_LOOKAHEAD = 7,
  BK_P_COMP_COUNT = 8
};
#define BK_P_COMP_QUALITY_KEY BK_PARAM_NONE

/* crush — Bit Crusher */
enum {
  BK_P_CRUSH_BITS = 0,
  BK_P_CRUSH_RATE = 1,
  BK_P_CRUSH_DITHER = 2,
  BK_P_CRUSH_DRIVE = 3,
  BK_P_CRUSH_OUTPUT = 4,
  BK_P_CRUSH_SMOOTH = 5,
  BK_P_CRUSH_COUNT = 6
};
#define BK_P_CRUSH_QUALITY_KEY BK_PARAM_NONE

/* delay — Delay */
enum {
  BK_P_DELAY_TIME = 0,
  BK_P_DELAY_SYNC = 1,
  BK_P_DELAY_BPM = 2,
  BK_P_DELAY_FEEDBACK = 3,
  BK_P_DELAY_PINGPONG = 4,
  BK_P_DELAY_LOWPASS = 5,
  BK_P_DELAY_HIGHPASS = 6,
  BK_P_DELAY_MODDEPTH = 7,
  BK_P_DELAY_MODRATE = 8,
  BK_P_DELAY_SPREAD = 9,
  BK_P_DELAY_CROSSFEED = 10,
  BK_P_DELAY_SATURATE = 11,
  BK_P_DELAY_COUNT = 12
};
#define BK_P_DELAY_QUALITY_KEY BK_PARAM_NONE

/* dist — Distortion */
enum {
  BK_P_DIST_DRIVE = 0,
  BK_P_DIST_CURVE = 1,
  BK_P_DIST_TONE = 2,
  BK_P_DIST_TONEMODE = 3,
  BK_P_DIST_BIAS = 4,
  BK_P_DIST_PREHP = 5,
  BK_P_DIST_OUTPUT = 6,
  BK_P_DIST_OVERSAMPLE = 7,
  BK_P_DIST_COUNT = 8
};
#define BK_P_DIST_QUALITY_KEY BK_PARAM_NONE

/* eq — Parametric EQ */
enum {
  BK_P_EQ_HP_FREQ = 0,
  BK_P_EQ_HP_SLOPE = 1,
  BK_P_EQ_LS_FREQ = 2,
  BK_P_EQ_LS_GAIN = 3,
  BK_P_EQ_B1_FREQ = 4,
  BK_P_EQ_B1_GAIN = 5,
  BK_P_EQ_B1_Q = 6,
  BK_P_EQ_B2_FREQ = 7,
  BK_P_EQ_B2_GAIN = 8,
  BK_P_EQ_B2_Q = 9,
  BK_P_EQ_B3_FREQ = 10,
  BK_P_EQ_B3_GAIN = 11,
  BK_P_EQ_B3_Q = 12,
  BK_P_EQ_HS_FREQ = 13,
  BK_P_EQ_HS_GAIN = 14,
  BK_P_EQ_LP_FREQ = 15,
  BK_P_EQ_LP_SLOPE = 16,
  BK_P_EQ_OUTPUT = 17,
  BK_P_EQ_COUNT = 18
};
#define BK_P_EQ_QUALITY_KEY BK_PARAM_NONE

/* flanger — Flanger */
enum {
  BK_P_FLANGER_RATE = 0,
  BK_P_FLANGER_DEPTH = 1,
  BK_P_FLANGER_DELAY = 2,
  BK_P_FLANGER_FEEDBACK = 3,
  BK_P_FLANGER_INVERT = 4,
  BK_P_FLANGER_DAMP = 5,
  BK_P_FLANGER_STEREO = 6,
  BK_P_FLANGER_SHAPE = 7,
  BK_P_FLANGER_COUNT = 8
};
#define BK_P_FLANGER_QUALITY_KEY BK_PARAM_NONE

/* freqshift — Frequency Shifter */
enum {
  BK_P_FREQSHIFT_FREQ = 0,
  BK_P_FREQSHIFT_FEEDBACK = 1,
  BK_P_FREQSHIFT_COUNT = 2
};
#define BK_P_FREQSHIFT_QUALITY_KEY BK_PARAM_NONE

/* gate — Noise Gate */
enum {
  BK_P_GATE_THRESHOLD = 0,
  BK_P_GATE_RANGE = 1,
  BK_P_GATE_ATTACK = 2,
  BK_P_GATE_RELEASE = 3,
  BK_P_GATE_HOLD = 4,
  BK_P_GATE_HYSTERESIS = 5,
  BK_P_GATE_SCFREQ = 6,
  BK_P_GATE_COUNT = 7
};
#define BK_P_GATE_QUALITY_KEY BK_PARAM_NONE

/* glitch — Glitch / Stutter */
enum {
  BK_P_GLITCH_PROBABILITY = 0,
  BK_P_GLITCH_BPM = 1,
  BK_P_GLITCH_DIVISION = 2,
  BK_P_GLITCH_REPEATS = 3,
  BK_P_GLITCH_REVERSE = 4,
  BK_P_GLITCH_PITCH = 5,
  BK_P_GLITCH_FREEZE = 6,
  BK_P_GLITCH_COUNT = 7
};
#define BK_P_GLITCH_QUALITY_KEY BK_PARAM_NONE

/* limiter — Limiter */
enum {
  BK_P_LIMITER_CEILING = 0,
  BK_P_LIMITER_RELEASE = 1,
  BK_P_LIMITER_COUNT = 2
};
#define BK_P_LIMITER_QUALITY_KEY BK_PARAM_NONE

/* noise — Noise Bed */
enum {
  BK_P_NOISE_LEVEL = 0,
  BK_P_NOISE_TYPE = 1,
  BK_P_NOISE_FOLLOW = 2,
  BK_P_NOISE_TONE = 3,
  BK_P_NOISE_COUNT = 4
};
#define BK_P_NOISE_QUALITY_KEY BK_PARAM_NONE

/* phaser — Phaser */
enum {
  BK_P_PHASER_RATE = 0,
  BK_P_PHASER_DEPTH = 1,
  BK_P_PHASER_CENTER = 2,
  BK_P_PHASER_STAGES = 3,
  BK_P_PHASER_FEEDBACK = 4,
  BK_P_PHASER_Q = 5,
  BK_P_PHASER_STEREO = 6,
  BK_P_PHASER_SHAPE = 7,
  BK_P_PHASER_COUNT = 8
};
#define BK_P_PHASER_QUALITY_KEY BK_PARAM_NONE

/* pitch — Pitch / Formant */
enum {
  BK_P_PITCH_PITCH = 0,
  BK_P_PITCH_FINE = 1,
  BK_P_PITCH_FORMANT = 2,
  BK_P_PITCH_PRESERVE = 3,
  BK_P_PITCH_LIFTER = 4,
  BK_P_PITCH_QUALITY = 5,
  BK_P_PITCH_JITTER = 6,
  BK_P_PITCH_SHIMMER = 7,
  BK_P_PITCH_COUNT = 8
};
#define BK_P_PITCH_QUALITY_KEY 5

/* reverb — Reverb */
enum {
  BK_P_REVERB_DECAY = 0,
  BK_P_REVERB_SIZE = 1,
  BK_P_REVERB_DAMPING = 2,
  BK_P_REVERB_PREDELAY = 3,
  BK_P_REVERB_WIDTH = 4,
  BK_P_REVERB_HIGHPASS = 5,
  BK_P_REVERB_MODULATION = 6,
  BK_P_REVERB_DIFFUSION = 7,
  BK_P_REVERB_COUNT = 8
};
#define BK_P_REVERB_QUALITY_KEY BK_PARAM_NONE

/* ringmod — Ring Mod */
enum {
  BK_P_RINGMOD_FREQ = 0,
  BK_P_RINGMOD_SHAPE = 1,
  BK_P_RINGMOD_MODE = 2,
  BK_P_RINGMOD_SWEEPRATE = 3,
  BK_P_RINGMOD_SWEEPDEPTH = 4,
  BK_P_RINGMOD_COUNT = 5
};
#define BK_P_RINGMOD_QUALITY_KEY BK_PARAM_NONE

/* sat — Saturation */
enum {
  BK_P_SAT_DRIVE = 0,
  BK_P_SAT_CURVE = 1,
  BK_P_SAT_TONE = 2,
  BK_P_SAT_TONEMODE = 3,
  BK_P_SAT_BIAS = 4,
  BK_P_SAT_PREHP = 5,
  BK_P_SAT_OUTPUT = 6,
  BK_P_SAT_OVERSAMPLE = 7,
  BK_P_SAT_COUNT = 8
};
#define BK_P_SAT_QUALITY_KEY BK_PARAM_NONE

/* talkbox — Talk Box */
enum {
  BK_P_TALKBOX_CARRIER = 0,
  BK_P_TALKBOX_PITCH = 1,
  BK_P_TALKBOX_FOLLOW = 2,
  BK_P_TALKBOX_GLIDE = 3,
  BK_P_TALKBOX_ORDER = 4,
  BK_P_TALKBOX_TRACT = 5,
  BK_P_TALKBOX_TRACTQ = 6,
  BK_P_TALKBOX_BRIGHTNESS = 7,
  BK_P_TALKBOX_BREATH = 8,
  BK_P_TALKBOX_SQUELCH = 9,
  BK_P_TALKBOX_DRIVE = 10,
  BK_P_TALKBOX_OUTPUT = 11,
  BK_P_TALKBOX_SOURCE = 12,
  BK_P_TALKBOX_COUNT = 13
};
#define BK_P_TALKBOX_QUALITY_KEY BK_PARAM_NONE

/* transient — Transient Shaper */
enum {
  BK_P_TRANSIENT_ATTACK = 0,
  BK_P_TRANSIENT_SUSTAIN = 1,
  BK_P_TRANSIENT_SPEED = 2,
  BK_P_TRANSIENT_COUNT = 3
};
#define BK_P_TRANSIENT_QUALITY_KEY BK_PARAM_NONE

/* tremolo — Tremolo / Pan */
enum {
  BK_P_TREMOLO_RATE = 0,
  BK_P_TREMOLO_DEPTH = 1,
  BK_P_TREMOLO_SHAPE = 2,
  BK_P_TREMOLO_MODE = 3,
  BK_P_TREMOLO_PHASE = 4,
  BK_P_TREMOLO_COUNT = 5
};
#define BK_P_TREMOLO_QUALITY_KEY BK_PARAM_NONE

/* vocoder — Vocoder */
enum {
  BK_P_VOCODER_BANDS = 0,
  BK_P_VOCODER_CARRIER = 1,
  BK_P_VOCODER_PITCH = 2,
  BK_P_VOCODER_FOLLOW = 3,
  BK_P_VOCODER_FREQLO = 4,
  BK_P_VOCODER_FREQHI = 5,
  BK_P_VOCODER_Q = 6,
  BK_P_VOCODER_DEPTH = 7,
  BK_P_VOCODER_TONE = 8,
  BK_P_VOCODER_SIBILANCE = 9,
  BK_P_VOCODER_ATTACK = 10,
  BK_P_VOCODER_RELEASE = 11,
  BK_P_VOCODER_CARRIERLEVEL = 12,
  BK_P_VOCODER_SPREAD = 13,
  BK_P_VOCODER_OUTPUT = 14,
  BK_P_VOCODER_SOURCE = 15,
  BK_P_VOCODER_COUNT = 16
};
#define BK_P_VOCODER_QUALITY_KEY BK_PARAM_NONE

/* 22 effect types, 168 params. */
#define BK_EFFECT_TYPE_COUNT 22

/*
 * BROBEATS pad params. A pad is not a chain slot and has no effect type, so
 * these are one flat list shared by every pad: the value is the index on the
 * command ring (OP.PAD / PAD_FIELD.PARAM), which the worklet turns into the
 * string key DrumVoice.setParam takes. bk_drum_voice_set_param switches on
 * the number directly — the audio thread should not compare strings.
 */
enum {
  BK_PAD_P_ATTACK = 0,
  BK_PAD_P_DECAY = 1,
  BK_PAD_P_SUSTAIN = 2,
  BK_PAD_P_RELEASE = 3,
  BK_PAD_P_HOLD = 4,
  BK_PAD_P_PITCH = 5,
  BK_PAD_P_START = 6,
  BK_PAD_P_REVERSE = 7,
  BK_PAD_P_GAIN = 8,
  BK_PAD_P_PAN = 9,
  BK_PAD_P_MODE = 10,
  BK_PAD_P_VEL_AMOUNT = 11,
  BK_PAD_P_CHOKE = 12,
  BK_PAD_P_MUTE = 13,
  BK_PAD_P_COUNT = 14
};

/* Rack-wide params, one per rack rather than per pad (OP.DRUM). */
enum {
  BK_DRUM_P_GAIN = 0,
  BK_DRUM_P_MUTE = 1,
  BK_DRUM_P_SOLO = 2,
  BK_DRUM_P_ROUTE = 3,
  BK_DRUM_P_COUNT = 4
};

/*
 * Per-track looper params (OP.LOOP / LOOP_FIELD.PARAM). Same contract as the
 * pad list: the index IS the wire key, and bk_looper_set_track_param
 * switches on the number. The transport verbs — rec, play, stop, clear,
 * undo, clearAll — are NOT here; they carry no value and travel as their own
 * ring fields, so they are functions on bk_looper rather than params.
 */
enum {
  BK_LOOP_P_GAIN = 0,
  BK_LOOP_P_MUTE = 1,
  BK_LOOP_P_SOLO = 2,
  BK_LOOP_P_PAN = 3,
  BK_LOOP_P_SYNC = 4,
  BK_LOOP_P_SOURCE = 5,
  BK_LOOP_P_COUNT = 6
};

/* Looper-bus params, one per looper rather than per track (OP.LOOPER). */
enum {
  BK_LOOPER_P_GAIN = 0,
  BK_LOOPER_P_MUTE = 1,
  BK_LOOPER_P_COUNT = 2
};

/*
 * Transport params (OP.CLOCK). BK_CLOCK_P_RESET takes no value — the key
 * itself is the command — and is a param rather than a function because that
 * is how it arrives on the ring.
 */
enum {
  BK_CLOCK_P_BPM = 0,
  BK_CLOCK_P_BEATS_PER_BAR = 1,
  BK_CLOCK_P_QUANTIZE = 2,
  BK_CLOCK_P_RUN = 3,
  BK_CLOCK_P_RESET = 4,
  BK_CLOCK_P_COUNT = 5
};

#endif /* BROKODR_DSP_PARAM_KEYS_H */
