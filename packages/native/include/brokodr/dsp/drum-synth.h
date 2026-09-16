/*
 * Bro.Kodr DSP core — BROBEATS synthesised drum kit.
 * C port of dsp/core/drum-synth.js. See biquad.h for the porting rules.
 *
 * Six generators — kick, snare, hat, clap, tom, rim — rendered OFFLINE into a
 * buffer whenever a generator param changes, plus the factory sixteen-pad
 * layout that names which generator sits under which finger. Nothing in this
 * file runs on the audio thread: bk_drum_rack only ever plays buffers, so a
 * synthesised pad and a dragged-in sample share exactly one playback path.
 *
 * THIS IS THE FIRST MODULE PORTED WITHOUT A JS BIT-PARITY GATE, AND THAT IS A
 * DECISION, NOT AN OVERSIGHT.
 *
 * The desktop build is the product; the web build is a demo (brobeats-plan.md,
 * "JS parity is a porting aid, not a gate"). For every module before this one
 * the JS agreement came out bit-identical for free, so it was pinned and kept
 * as a canary. Here it cannot, for two structural reasons that are properties
 * of the algorithm rather than bugs in either side:
 *
 *   1. GLOBAL PEAK NORMALISATION. bk_drum_render finds the render's loudest
 *      sample and scales the WHOLE buffer by 0.89/peak. One ULP of libm spread
 *      that happens to land on the peak sample rescales every other sample, so
 *      a single last-place difference is not local — it is a gain change.
 *
 *   2. A COMPARATOR ON A TRANSCENDENTAL. The hat sums six inharmonic square
 *      partials as `sin(ph) >= 0 ? 1 : -1`. One ULP either side of a zero
 *      crossing flips that term from +1 to -1 — a ~30% instantaneous step, not
 *      a small numeric drift. A 900 ms ride does ~260k of those comparisons,
 *      so landing on a crossing is near-certain rather than unlikely.
 *
 * So parity-drum-synth.c is a SELF-CONSISTENCY and BEHAVIOURAL battery: the
 * integer structure (frame counts, fade lengths, the defaults and layout
 * tables, which kinds exist) is still gated against the JS, because that part
 * is exact arithmetic and free to check; the audio is held to envelope and
 * brightness bands, and to invariants — deterministic per seed, no NaN, ends
 * in a true zero. Native-versus-wasm bit-identity is measured and its count
 * pinned as a floor, so a change in the spread still shows up, but it is not
 * what decides whether this ships.
 *
 * Three things differ from the JS, all behaviour-preserving:
 *
 *   1. THE CALLER OWNS THE OUTPUT BUFFER. renderDrum() allocates its scratch
 *      per call; the DSP core does not allocate, anywhere, ever — and the rule
 *      does not get a hole punched in it just because this path is offline.
 *      Pass a buffer of bk_drum_render_capacity(sr) floats to get exactly what
 *      the JS produces. A SHORTER buffer truncates the render, and does so on
 *      purpose: the JS's own `Math.min(out.length, ...)` says truncate, it is
 *      simply unreachable from renderDrum() because the scratch it allocates
 *      is always long enough. The battery reaches it by passing less.
 *
 *      The JS then copies scratch[0..frames) into a fresh array and normalises
 *      the copy; the C normalises in place. Identical by construction — the
 *      normalise-and-fade pass only ever reads and writes [0, frames).
 *
 *   2. PARAMS ARE A FLAT STRUCT, NOT A MERGED OBJECT. The JS spreads the
 *      kind's defaults under the caller's overrides. The C fills a
 *      bk_drum_params from bk_drum_defaults() and lets the caller overwrite
 *      fields, which is the same operation with the allocation removed. The
 *      struct is the UNION of every kind's params: a generator reads only its
 *      own fields, exactly as the JS renderers do, so a field another kind
 *      owns cannot affect it. NOT generated from param-keys.h — these params
 *      never travel the command ring (the host re-renders a pad and ships the
 *      buffer, not the knob), so there is no wire order to agree with.
 *
 *   3. THE KIND IS AN ENUM, NOT A STRING. bk_drum_kind_from_name maps the
 *      stable ids kits store onto it, and returns BK_DRUM_KIND_NONE for an id
 *      this build does not know — which is renderDrum()'s `return null` for an
 *      unknown kind, kept as a real branch rather than an assert, because a
 *      kit document written by a newer build is a thing that will happen.
 *
 * libm is everywhere in here (exp, tanh, sin, pow, via bk_db_to_gain), so the
 * volatile-input caution in brobeats-plan.md applies to any micro-benchmark of
 * it: LLVM constant-folds sin()/pow() on literal arguments with the HOST's
 * libm, which makes cc and emcc agree for reasons that have nothing to do with
 * what ships.
 */

#ifndef BROKODR_DSP_DRUM_SYNTH_H
#define BROKODR_DSP_DRUM_SYNTH_H

#include <stddef.h>

#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Longest one-shot that will ever be rendered, in seconds. Bounds the buffer
   the caller has to find. Mirrors MAX_SECONDS in the JS. */
#define BK_DRUM_MAX_SECONDS 4

/* Kinds the generator understands. The order is DRUM_KINDS' order and is part
   of the parity battery: kits store the *names*, but the battery's case table
   stores indices, and a reorder here has to read as a failure. */
enum {
  BK_DRUM_KICK = 0,
  BK_DRUM_SNARE = 1,
  BK_DRUM_HAT = 2,
  BK_DRUM_CLAP = 3,
  BK_DRUM_TOM = 4,
  BK_DRUM_RIM = 5,
  BK_DRUM_KIND_COUNT = 6,
  BK_DRUM_KIND_NONE = -1
};

/* Every generator param any kind owns, in one struct. A kind reads only its
   own fields — see note 2 above — so the unused ones are free.
   Which kind reads what:
     kick  tune drop pitch_decay decay drive click level
     snare tune body decay noise_decay tone snap level
     hat   tune decay resonance tone level
     clap  tune spread decay tone level
     tom   tune drop pitch_decay decay drive level   (click forced to 0)
     rim   tune decay tone level                                            */
typedef struct {
  double tune;
  double drop;
  double pitch_decay;
  double decay;
  double drive;
  double click;
  double level;
  double body;
  double noise_decay;
  double tone;
  double snap;
  double resonance;
  double spread;
} bk_drum_params;

/* Param ids, for the partial overrides the layout table carries. Hand-written
   (note 2): nothing on the wire depends on these values, so they exist only to
   let a table say "decay = 45" without naming a struct field. */
enum {
  BK_DS_TUNE = 0,
  BK_DS_DROP = 1,
  BK_DS_PITCH_DECAY = 2,
  BK_DS_DECAY = 3,
  BK_DS_DRIVE = 4,
  BK_DS_CLICK = 5,
  BK_DS_LEVEL = 6,
  BK_DS_BODY = 7,
  BK_DS_NOISE_DECAY = 8,
  BK_DS_TONE = 9,
  BK_DS_SNAP = 10,
  BK_DS_RESONANCE = 11,
  BK_DS_SPREAD = 12,
  BK_DS_PARAM_COUNT = 13
};

/* Most overrides an entry in the factory layout carries (pad 4, the Sub). */
#define BK_DRUM_MAX_OVERRIDES 4

typedef struct {
  int pad;
  int kind;
  const char *name;
  int choke; /* choke group, 0 = none — the rack's own convention */
  int n_overrides;
  struct {
    int key;
    double value;
  } overrides[BK_DRUM_MAX_OVERRIDES];
} bk_drum_layout_entry;

/* Pads in the factory layout. */
#define BK_DRUM_LAYOUT_COUNT 16

/* The factory sixteen-pad layout, verbatim from DEFAULT_KIT_LAYOUT. Row 1 is
   kick, snare, closed hat, open hat because those are the four Smart Voice
   classifies and they have to sit in the obvious place. */
extern const bk_drum_layout_entry bk_drum_default_layout[BK_DRUM_LAYOUT_COUNT];

/* "kick" -> BK_DRUM_KICK, anything unknown -> BK_DRUM_KIND_NONE. NULL is
   unknown, not a crash: it is what a kit field that never got written is. */
int bk_drum_kind_from_name(const char *name);

/* The stable id for a kind, or NULL when the kind is out of range. */
const char *bk_drum_kind_name(int kind);

/* Fill p with the kind's defaults. Fields the kind does not own are zeroed, so
   two kinds' defaults never bleed into one another through a reused struct.
   A kind out of range zeroes everything and is otherwise a no-op. */
void bk_drum_defaults(int kind, bk_drum_params *p);

/* Set one field by param id. Returns 0 for an id out of range, having changed
   nothing — an unknown override is dropped, as an unknown key in a JSON kit
   document is dropped by the spread in the JS. */
int bk_drum_param_set(bk_drum_params *p, int key, double value);

/* Resolve layout entry `index` into its kind and its fully merged params:
   the kind's defaults with the entry's overrides applied on top, which is
   exactly `{...DRUM_SYNTH_DEFAULTS[kind], ...entry.params}`. Returns the kind,
   or BK_DRUM_KIND_NONE for an index out of range (p untouched). */
int bk_drum_layout_resolve(size_t index, bk_drum_params *p);

/* How many floats bk_drum_render can ever write at this sample rate. Give it
   this much and the render is never truncated. */
size_t bk_drum_render_capacity(double sr);

/* Render one drum into a caller-owned mono buffer and return the frame count.
 *
 * Returns 0 — renderDrum()'s `null` — for an unknown kind, or when there was
 * no room to render a single frame. Offline only: called from a control
 * command when a generator param changes, never from the audio callback.
 *
 * The buffer comes back normalised to 0.89 peak with the kind's own level trim
 * applied, and with a 2 ms fade-out, so the last sample is always exactly zero
 * and no decay setting can click. Normalisation is why changing a kick's decay
 * does not change how loud it is, which is what makes the knob feel like a
 * decay knob.
 */
size_t bk_drum_render(int kind, double sr, const bk_drum_params *p, float *out, size_t out_len);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_DRUM_SYNTH_H */
