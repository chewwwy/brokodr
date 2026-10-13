/*
 * Parity dump for the C port of dsp/core/drum-synth.js.
 *
 * Producer half of the oracle; scripts/verify-drum-synth-parity.mjs is the
 * consumer. See parity-io.h for the stream format, and drum-synth.h for why
 * this module is the first one whose audio is NOT held to bit-identity with
 * the JS: global peak normalisation plus a comparator on sin() mean a single
 * last-place difference is a gain change or a ±1 flip, not a rounding error.
 *
 * So the battery measures four different kinds of thing, and the consumer
 * treats each of them differently:
 *
 * 1. THE INTEGER STRUCTURE, WHICH IS STILL GATED AGAINST THE JS.
 *
 *    Frame counts, fade lengths, which kinds exist, the defaults table, the
 *    sixteen-pad layout down to its names and choke groups. None of that
 *    touches libm — it is exact arithmetic and string data — so the JS stays a
 *    hard oracle for it. The `kinds`, `defaults-*` and `layout-*` records
 *    carry no audio at all and exist only for this.
 *
 * 2. THE ENVELOPE AND THE BRIGHTNESS, WHICH ARE HELD TO BANDS.
 *
 *    Every render record reports peak, RMS, the point where 90% of the energy
 *    has arrived, a high-frequency emphasis ratio, and a zero-crossing count.
 *    That is enough to catch a filter wired to the wrong cutoff, an envelope
 *    running at the wrong rate, a noise seed that changed, or a partial
 *    dropped from the hat — while tolerating the ULP-level divergence the
 *    algorithm amplifies. The features are computed in plain double arithmetic
 *    with no libm anywhere, so the consumer can mirror them exactly and any
 *    difference it sees is a difference in the audio, never in the ruler.
 *
 * 3. INVARIANTS, WHICH ARE ABSOLUTE AND HOLD FOR EVERY CASE.
 *
 *    No non-finite sample ever leaves sanitize(). The last sample is exactly
 *    zero whenever the 2 ms fade has room, so no decay setting can click.
 *    A render is deterministic: the same params render the same buffer, bit
 *    for bit, which is what makes a kit repeatable.
 *
 *    That last one is why every case renders TWICE, into two buffers that are
 *    PREFILLED DIFFERENTLY — buf A with +0.25, buf B with -0.75. If the
 *    generator ever leaves a frame inside [0, frames) unwritten, the two
 *    renders disagree there and `repeat_diff` stops being zero. A single
 *    zero-filled buffer would have hidden exactly that, because an unwritten
 *    frame and a frame legitimately written as zero look the same.
 *
 * 4. NATIVE VERSUS WASM, WHICH IS MEASURED AND PINNED BUT NOT A GATE.
 *
 *    `fp` is an FNV-1a hash over all frames' float32 bytes, so whole-buffer
 *    byte identity is one number the consumer can count rather than a
 *    megabyte it has to diff. It is also what the equivalence pairs are
 *    asserted through: `tom-48k` versus `tom-click-ignored` (the tom forces
 *    click to 0, so a click override MUST change nothing) and `kick-48k`
 *    versus `kick-level-nan` (`p.level || 0` turns NaN into 0, so a NaN level
 *    MUST be identical to no level). Both pairs are byte-exact claims inside
 *    one build, where no cross-toolchain question arises.
 *
 * The `f32` payload is a decimated probe, not the whole render: a ride cymbal
 * is 173k samples and the hash already covers every one of them. The rule —
 * stride 1 + frames/1024, then the final 32 samples — is mirrored in the
 * consumer, and the tail matters because that is where the fade lives.
 *
 * Four cases are unreachable from the JS's own public API and are marked as
 * such by carrying an out_len below the capacity renderDrum() would have
 * allocated: the truncation cases (the JS's `Math.min(out.length, ...)` is
 * real, but its scratch is always long enough to make it moot) and the
 * absurd-sample-rate case that reaches the `peak <= 1e-6` branch — which needs
 * a render quiet enough that nothing else can get there. They are compared
 * across toolchains and against the invariants, not against the JS.
 */

#include <math.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "brokodr/dsp/drum-synth.h"
#include "parity-io.h"

/* 96 kHz for four seconds is the largest render the battery asks for. */
#define BUF_CAP 384000u
#define PROBE_MAX 1088u /* 1024 decimated + 32 tail, rounded up */
#define N_FEATURES 14

static float buf_a[BUF_CAP];
static float buf_b[BUF_CAP];
static double pay64[N_FEATURES];
static float pay32[PROBE_MAX];
static double params[4 + BK_DS_PARAM_COUNT];
static double meta[64];

/* The params struct as the flat thirteen, in BK_DS_* key order. Three records
   report params this way — the defaults, the resolved layout, and every render
   case — and writing the switch once is what stops those three drifting apart
   into three slightly different orders. */
static void flatten_params(const bk_drum_params *p, double *dst) {
  int j;
  for (j = 0; j < BK_DS_PARAM_COUNT; j++) {
    double v = 0;
    switch (j) {
      case BK_DS_TUNE: v = p->tune; break;
      case BK_DS_DROP: v = p->drop; break;
      case BK_DS_PITCH_DECAY: v = p->pitch_decay; break;
      case BK_DS_DECAY: v = p->decay; break;
      case BK_DS_DRIVE: v = p->drive; break;
      case BK_DS_CLICK: v = p->click; break;
      case BK_DS_LEVEL: v = p->level; break;
      case BK_DS_BODY: v = p->body; break;
      case BK_DS_NOISE_DECAY: v = p->noise_decay; break;
      case BK_DS_TONE: v = p->tone; break;
      case BK_DS_SNAP: v = p->snap; break;
      case BK_DS_RESONANCE: v = p->resonance; break;
      default: v = p->spread; break;
    }
    dst[j] = v;
  }
}

typedef struct {
  const char *name;
  int kind;    /* BK_DRUM_KIND_NONE for the unknown-kind case */
  double sr;
  size_t out_len; /* 0 = the capacity renderDrum would have allocated */
  int layout;     /* layout index, or -1 */
  int n_over;
  struct {
    int key;
    double value;
  } over[6];
} rcase;

#define NO_OVER 0, {{0, 0}}

static const rcase CASES[] = {
    /* The factory layout, every pad, at the rate the app runs at. */
    {"pad-00", BK_DRUM_KICK, 48000, 0, 0, NO_OVER},
    {"pad-01", BK_DRUM_SNARE, 48000, 0, 1, NO_OVER},
    {"pad-02", BK_DRUM_HAT, 48000, 0, 2, NO_OVER},
    {"pad-03", BK_DRUM_HAT, 48000, 0, 3, NO_OVER},
    {"pad-04", BK_DRUM_KICK, 48000, 0, 4, NO_OVER},
    {"pad-05", BK_DRUM_CLAP, 48000, 0, 5, NO_OVER},
    {"pad-06", BK_DRUM_RIM, 48000, 0, 6, NO_OVER},
    {"pad-07", BK_DRUM_SNARE, 48000, 0, 7, NO_OVER},
    {"pad-08", BK_DRUM_TOM, 48000, 0, 8, NO_OVER},
    {"pad-09", BK_DRUM_TOM, 48000, 0, 9, NO_OVER},
    {"pad-10", BK_DRUM_TOM, 48000, 0, 10, NO_OVER},
    {"pad-11", BK_DRUM_HAT, 48000, 0, 11, NO_OVER},
    {"pad-12", BK_DRUM_KICK, 48000, 0, 12, NO_OVER},
    {"pad-13", BK_DRUM_CLAP, 48000, 0, 13, NO_OVER},
    {"pad-14", BK_DRUM_RIM, 48000, 0, 14, NO_OVER},
    {"pad-15", BK_DRUM_HAT, 48000, 0, 15, NO_OVER},

    /* Every kind at its defaults, at three rates. 8 kHz is not a rate the app
       runs at; it is the only cheap way to push the filters into the
       sr * 0.45 clamp, which a 48 kHz case can never reach. */
    {"kick-48k", BK_DRUM_KICK, 48000, 0, -1, NO_OVER},
    {"snare-48k", BK_DRUM_SNARE, 48000, 0, -1, NO_OVER},
    {"hat-48k", BK_DRUM_HAT, 48000, 0, -1, NO_OVER},
    {"clap-48k", BK_DRUM_CLAP, 48000, 0, -1, NO_OVER},
    {"tom-48k", BK_DRUM_TOM, 48000, 0, -1, NO_OVER},
    {"rim-48k", BK_DRUM_RIM, 48000, 0, -1, NO_OVER},
    {"kick-44k1", BK_DRUM_KICK, 44100, 0, -1, NO_OVER},
    {"snare-44k1", BK_DRUM_SNARE, 44100, 0, -1, NO_OVER},
    {"hat-44k1", BK_DRUM_HAT, 44100, 0, -1, NO_OVER},
    {"clap-44k1", BK_DRUM_CLAP, 44100, 0, -1, NO_OVER},
    {"tom-44k1", BK_DRUM_TOM, 44100, 0, -1, NO_OVER},
    {"rim-44k1", BK_DRUM_RIM, 44100, 0, -1, NO_OVER},
    {"kick-96k", BK_DRUM_KICK, 96000, 0, -1, NO_OVER},
    {"hat-96k", BK_DRUM_HAT, 96000, 0, -1, NO_OVER},
    {"hat-8k", BK_DRUM_HAT, 8000, 0, -1, NO_OVER},
    {"snare-8k", BK_DRUM_SNARE, 8000, 0, -1, NO_OVER},

    /* Kick: both ends of every clamp, and both sides of every branch. */
    {"kick-tune-lo", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_TUNE, 5}}},
    {"kick-tune-hi", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_TUNE, 5000}}},
    {"kick-drop-zero", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_DROP, 0}}},
    {"kick-drop-hi", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_DROP, 96}}},
    {"kick-drive-zero", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_DRIVE, 0}}},
    {"kick-drive-max", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_DRIVE, 1}}},
    {"kick-click-zero", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_CLICK, 0}}},
    {"kick-click-max", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_CLICK, 1}}},

    /* click = +Infinity, which is not a knob position: it is the only input
       that makes the click burst's own BOUNDARY observable. At i == click_n
       the ramp (1 - i/click_n) is exactly 0.0, so on any finite click the
       term there is +-0.0 and adding it is a no-op — `i < click_n` and
       `i <= click_n` render the same buffer, and no case with a finite click
       can separate them. With click infinite the term at that one index is
       0.0 * inf = NaN, soft_clip carries the NaN through, and the highpass
       state stays NaN for the rest of the render: one branch, the whole tail.
       The earlier samples stay finite because soft_clip SATURATES the
       infinity — tanh(inf)/tanh(k) is 1/tanh(k) — so the filter is not
       already poisoned by the time the boundary arrives, which is what
       leaves the mutant room to show. That needs a non-zero drive, which the
       kick default has: soft_clip's `amount <= 0` arm would pass the
       infinity straight through and poison everything from sample 0. */
    {"kick-click-inf", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_CLICK, 0}}},
    {"kick-decay-tiny", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_DECAY, 0.1}}},
    {"kick-decay-max", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_DECAY, 5000}}},
    {"kick-pdecay-tiny", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_PITCH_DECAY, 0.2}}},
    {"kick-level-hot", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_LEVEL, 12}}},
    {"kick-level-quiet", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_LEVEL, -60}}},
    /* `dbToGain(p.level || 0)`: a NaN level must be identical to no level. */
    {"kick-level-nan", BK_DRUM_KICK, 48000, 0, -1, 1, {{BK_DS_LEVEL, 0}}},

    /* Snare: the body/noise mix, and a noise decay that outlives the body so
       the frame count comes from the other side of the Math.max. */
    {"snare-body-zero", BK_DRUM_SNARE, 48000, 0, -1, 1, {{BK_DS_BODY, 0}}},
    {"snare-body-one", BK_DRUM_SNARE, 48000, 0, -1, 1, {{BK_DS_BODY, 1}}},
    {"snare-body-over", BK_DRUM_SNARE, 48000, 0, -1, 1, {{BK_DS_BODY, 2}}},
    {"snare-snap-zero", BK_DRUM_SNARE, 48000, 0, -1, 1, {{BK_DS_SNAP, 0}}},
    {"snare-snap-hi", BK_DRUM_SNARE, 48000, 0, -1, 1, {{BK_DS_SNAP, 3}}},
    {"snare-tone-lo", BK_DRUM_SNARE, 48000, 0, -1, 1, {{BK_DS_TONE, 10}}},
    {"snare-tune-lo", BK_DRUM_SNARE, 48000, 0, -1, 1, {{BK_DS_TUNE, 10}}},
    {"snare-tune-hi", BK_DRUM_SNARE, 48000, 0, -1, 1, {{BK_DS_TUNE, 2000}}},
    {"snare-noisy", BK_DRUM_SNARE, 48000, 0, -1, 1, {{BK_DS_NOISE_DECAY, 900}}},

    /* Hat: the two ends of the metal/noise blend, the resonance clamp, and
       both ends of the tune clamp the six partials hang off. */
    {"hat-tone-zero", BK_DRUM_HAT, 48000, 0, -1, 1, {{BK_DS_TONE, 0}}},
    {"hat-tone-one", BK_DRUM_HAT, 48000, 0, -1, 1, {{BK_DS_TONE, 1}}},
    {"hat-res-lo", BK_DRUM_HAT, 48000, 0, -1, 1, {{BK_DS_RESONANCE, 0.1}}},
    {"hat-res-hi", BK_DRUM_HAT, 48000, 0, -1, 1, {{BK_DS_RESONANCE, 8}}},
    {"hat-tune-lo", BK_DRUM_HAT, 48000, 0, -1, 1, {{BK_DS_TUNE, 200}}},
    {"hat-tune-hi", BK_DRUM_HAT, 48000, 0, -1, 1, {{BK_DS_TUNE, 20000}}},
    /* tune 20000 puts `tune * 0.6` exactly ON the hat highpass clamp ceiling,
       which is the one value at which the clamp and no clamp agree. Pushing
       past it is what makes the ceiling itself observable. */
    {"hat-tune-huge", BK_DRUM_HAT, 48000, 0, -1, 1, {{BK_DS_TUNE, 30000}}},
    /* A pair that pins where the hat highpass clamp ceiling sits, exactly,
       with C against itself. At 44100 the SVF's own clamp (sr * 0.45 = 19845)
       binds below tune, and the base-frequency clamp saturates at 14000, so
       every tune-derived quantity in renderHat — base_f, the bandpass corner,
       the highpass corner — is already saturated at tune = 20000 and does not
       move at 30000. The two must render byte-identically.

       What makes the pair sharp: `tune * 0.6` is exactly 12000.0 at
       tune = 20000, sitting right ON the ceiling, so raising the ceiling
       leaves the low half untouched while the high half follows it up. See
       the equivalence claim in verify-drum-synth-parity.mjs. */
    {"hat-hp-sat-lo", BK_DRUM_HAT, 44100, 0, -1, 1, {{BK_DS_TUNE, 20000}}},
    {"hat-hp-sat-hi", BK_DRUM_HAT, 44100, 0, -1, 1, {{BK_DS_TUNE, 30000}}},
    {"hat-long", BK_DRUM_HAT, 48000, 0, -1, 1, {{BK_DS_DECAY, 900}}},

    /* Clap: the slap spacing at both clamps, and a decay short enough that the
       tail opens while the slaps are still firing. */
    {"clap-spread-lo", BK_DRUM_CLAP, 48000, 0, -1, 1, {{BK_DS_SPREAD, 1}}},
    {"clap-spread-hi", BK_DRUM_CLAP, 48000, 0, -1, 1, {{BK_DS_SPREAD, 200}}},
    {"clap-decay-short", BK_DRUM_CLAP, 48000, 0, -1, 1, {{BK_DS_DECAY, 20}}},
    {"clap-tone-zero", BK_DRUM_CLAP, 48000, 0, -1, 1, {{BK_DS_TONE, 0}}},

    /* The slap gap is Math.round(sr * spread / 1000), spelled floor(x + 0.5)
       here. Every other clap case lands that product on a whole number or on
       a fraction below a half — 48 kHz with any of 24, 4 or 80 ms is exactly
       1152, 192, 3840, and 44.1 kHz at the default 24 ms is 1058.4 — so the
       rounding is invisible: floor(x + 0.5) == floor(x) for all of them. At
       44.1 kHz and 25 ms the product is exactly 1102.5, the one input where
       the two disagree, and it disagrees on a half, which is the whole reason
       the C says floor(x + 0.5) instead of round(): JS Math.round(1102.5) is
       1103, and C's round() would agree here but not on a negative half. The
       gap moves every slap, so a one-sample error is audible in the
       fingerprint, not just in a band. */
    {"clap-gap-half", BK_DRUM_CLAP, 44100, 0, -1, 1, {{BK_DS_SPREAD, 25}}},

    /* The bk_max(1.0, ...) floor under that gap. Reaching it needs the
       product BELOW two samples, and since spread clamps up to 4 ms that
       means a sample rate under 375 Hz — nothing the app would ever ask for,
       but bk_drum_render does not clamp sr, so the guard is live code and the
       only way to cover it is to call it the way a caller could. At 300 Hz
       and 4 ms the product is 1.2: the floor is not what decides the gap
       (floor(1.7) is already 1), so this case pins the floor's VALUE rather
       than its presence — raising it to 2 doubles the slap spacing. */
    {"clap-tiny-sr", BK_DRUM_CLAP, 300, 0, -1, 1, {{BK_DS_SPREAD, 4}}},

    /* The same tiny rate with the tail cut to 20 ms, and the reason is the
       peak normalisation rather than the gap. Moving the gap moves when the
       slaps fire AND when the room tail opens, and with the default 200 ms
       tail the tail is nearly all of the render: shifting a decaying
       exponential by two samples multiplies it by a constant, and dividing
       the buffer by its own peak then divides that constant straight back
       out. The measured effect on the long case is 5e-8 relative on rms —
       under the one-ULP band, invisible, and correctly so, because it really
       is almost a pure gain change. At 20 ms the tail dies inside a handful
       of samples, so the slaps themselves are most of what the ruler sees
       and the same gap change reads 2.8e-4 relative on both peak and rms,
       four orders clear of the band. A feature set fed post-normalisation
       cannot see a change the normalisation undoes; the case has to make the
       change a change in SHAPE. */
    {"clap-tiny-sr-short", BK_DRUM_CLAP, 300, 0, -1, 2, {{BK_DS_SPREAD, 4}, {BK_DS_DECAY, 20}}},

    /* Rim and tom. The tom pair is an equivalence claim: renderTom forces
       click to 0, so an override on it must change nothing at all. */
    {"rim-tone-zero", BK_DRUM_RIM, 48000, 0, -1, 1, {{BK_DS_TONE, 0}}},
    {"rim-tone-one", BK_DRUM_RIM, 48000, 0, -1, 1, {{BK_DS_TONE, 1}}},
    {"rim-tune-hi", BK_DRUM_RIM, 48000, 0, -1, 1, {{BK_DS_TUNE, 9000}}},
    {"rim-tune-lo", BK_DRUM_RIM, 48000, 0, -1, 1, {{BK_DS_TUNE, 50}}},
    {"tom-click-ignored", BK_DRUM_TOM, 48000, 0, -1, 1, {{BK_DS_CLICK, 1}}},
    {"tom-drive-zero", BK_DRUM_TOM, 48000, 0, -1, 1, {{BK_DS_DRIVE, 0}}},

    /* A buffer LONGER than the four-second cap, with a duration formula that
       runs well past it: a kick at decay 5000 asks for 15.05 seconds.
       Every other case in this table sits either below the cap or exactly AT
       it, because out_len 0 means "the capacity renderDrum would have
       allocated", which is itself ceil(sr * MAX_SECONDS). At the cap the cap
       is invisible: frame_count hits its `want >= out_len` arm and returns
       out_len whatever MAX_SECONDS is. Here the buffer is roomier than four
       seconds, so the cap is the only thing deciding the frame count, and
       moving it or dropping it changes the answer. The JS is a hard oracle
       for that: renderDrum allocates ceil(sr * 4) and reports 192000 frames,
       so this is an exact FRAMES claim, not a band. */
    {"cap-over", BK_DRUM_KICK, 48000, 300000, -1, 1, {{BK_DS_DECAY, 5000}}},

    /* Unknown kind — renderDrum's `return null`, which is 0 frames here. */
    {"unknown-kind", BK_DRUM_KIND_NONE, 48000, 0, -1, NO_OVER},

    /* C-only, marked by an out_len below capacity. See the header. */
    {"trunc-kick", BK_DRUM_KICK, 48000, 1000, -1, NO_OVER},
    {"trunc-hat", BK_DRUM_HAT, 48000, 37, -1, NO_OVER},
    {"trunc-one", BK_DRUM_KICK, 48000, 1, -1, NO_OVER},
    {"trunc-two", BK_DRUM_KICK, 48000, 2, -1, NO_OVER},

    /* The one input in this table that makes render_hat's COMPARATOR
       observable: `m += (sin(ph[k]) >= 0) ? 1 : -1`. At every ordinary rate
       that comparator's boundary is unreachable — ph[k] lands exactly on a
       zero of sin only by accident, and no case here manages it — so `>= 0`
       and `> 0` render the same buffer and the difference between them is
       invisible. This case reaches the boundary by construction instead of by
       luck, and it does it on the ONLY value sin is exactly zero at that the
       accumulator can be pinned to: +0.0 itself.

       base_f is bk_clamp(tune, 1000, 14000) * 0.18, so tune 1e40 saturates it
       at 2520 Hz, and the six per-sample phase increments are
       2*pi * 2520 * RATIOS[k] / sr. At sr = 1e51 those run from 3.17e-47 to
       1.30e-46 as doubles — every one of them below 2^-150 = 7.01e-46, half
       the smallest float32 subnormal, with a factor of 5.4 to spare on the
       largest. ph[] is a float32 array (it mirrors the JS Float32Array), so
       each increment rounds to exactly +0.0 on the way in and ph[k] never
       leaves +0.0 for the whole render. The accumulator is parked on the
       comparator's boundary at every sample of every partial.

       There sin(+0.0) is +0.0: `>= 0` takes the +1 arm six times over, m is
       exactly +1, and tone = 1 sets metal to 1 and removes the noise term
       entirely, so the pre-filter signal is a bare positive decaying
       envelope. The mutated comparator takes the -1 arm instead, m is exactly
       -1, and because bp_run/hp_run are linear with zeroed state and the
       normalisation gain depends only on |peak|, the rendered buffer comes
       out exactly negated, sample for sample. What checks it is the sign
       invariant in verify-drum-synth-parity.mjs: C-only by buffer length, and
       it needs no JS side, since the claim is about a sign and not a value. */
    {"hat-phase-underflow", BK_DRUM_HAT, 1e51, 8, -1, 2, {{BK_DS_TUNE, 1e40}, {BK_DS_TONE, 1}}},

    /* The one input in this table that makes render_kick's phase WRAP GUARD
       observable: `if (phase > BK_TWO_PI) phase -= BK_TWO_PI;`. Everywhere
       else that guard is nearly unobservable on purpose, because
       sin(phase - 2*pi) == sin(phase) is an identity: move the threshold and
       the only thing that changes is the rounding of the subtraction, worth a
       few times 1e-9 relative, which no band that has to absorb libm spread
       can see. This case does not rely on rounding. It puts the accumulator
       exactly ON the threshold and lets the guard decide between two
       genuinely different phases.

       tune 20 is the low end of the kick's [20, 200] clamp and drop 0 makes
       top == base, so f is exactly 20 for the whole render and the increment
       is (2*pi * 20) / 20 — which at sr 20 lands on the double BK_TWO_PI
       itself. `>` is false there, so the pristine port does NOT wrap: the
       phase stays at BK_TWO_PI, and because the double BK_TWO_PI is very
       slightly BELOW the true 2*pi, sin of it is a small NEGATIVE residual,
       -2.449e-16, not zero. Every following sample repeats it: the phase
       climbs to 4*pi, which does exceed the threshold, and comes back to
       BK_TWO_PI. So the render is a tiny negative decaying ramp, and its raw
       peak of 2.4e-16 is far under the 1e-6 line, so the guarded arm leaves
       it unnormalised and the sign survives to the output.

       Move the threshold down to BK_PI and the phase wraps to exactly +0.0
       instead, sin(+0.0) is +0.0, and the buffer comes out ALL ZEROS — the
       whole render, every sample, not a rounding difference. click and drive
       are both off because either one would swamp a 1e-16 signal: the click
       burst alone contributes 0.15 at sample 0.

       C-only by buffer length, and checked by a sign invariant in
       verify-drum-synth-parity.mjs rather than against the JS. That is
       deliberate: at this magnitude the exact LAST/FIRST values ride on one
       ULP of exp() in the decay chain, so comparing them across toolchains
       would be a libm coin toss, while their SIGN is solid in any libm with
       sub-ULP accuracy. */
    {"kick-wrap-boundary",
     BK_DRUM_KICK,
     20,
     27,
     -1,
     4,
     {{BK_DS_TUNE, 20}, {BK_DS_DROP, 0}, {BK_DS_CLICK, 0}, {BK_DS_DRIVE, 0}}},
    /* A rate absurd enough that two samples of a 5 Hz sine sit just above the
       normalisation threshold, and a two-frame buffer so the fade does not
       simply zero the evidence. Despite the name this one is NORMALISED: its
       raw peak lands around 1.05e-6, a hair over the 1e-6 line. */
    {"tiny-peak",
     BK_DRUM_KICK,
     240000000.0,
     2,
     -1,
     3,
     {{BK_DS_TUNE, 5}, {BK_DS_CLICK, 0}, {BK_DS_DRIVE, 0}}},

    /* Both sides of the peak-normalisation threshold, one case each.
       With drop, click and drive all zero the kick is a bare sine through the
       DC highpass, so over a two-frame buffer the raw samples are sin(w) and
       sin(2w) for w = 2*pi*tune/sr, and the raw peak is the second one: very
       nearly 2w, and linear in tune. At 4.2e8 that puts tune 20 at a raw peak
       of ~5.98e-7 (guarded, left alone) and tune 40 at ~1.20e-6 (normalised) —
       the two sit a factor of two apart across the 1e-6 line, which is what
       makes a single rate able to exercise both branches.

       tune 40 also lands inside (1e-6, 1e-5], the only window where moving the
       threshold itself is observable. Both are C-only cases by buffer length —
       a four-second buffer at this rate is 1.7e9 samples — so what checks them
       is the branch invariant in verify-drum-synth-parity.mjs, which reads the
       C output alone and needs no JS side. */
    {"peak-guarded",
     BK_DRUM_KICK,
     420000000.0,
     2,
     -1,
     4,
     {{BK_DS_TUNE, 20}, {BK_DS_DROP, 0}, {BK_DS_CLICK, 0}, {BK_DS_DRIVE, 0}}},
    {"peak-normalised",
     BK_DRUM_KICK,
     420000000.0,
     2,
     -1,
     4,
     {{BK_DS_TUNE, 40}, {BK_DS_DROP, 0}, {BK_DS_CLICK, 0}, {BK_DS_DRIVE, 0}}}};

/* ------------------------------------------------------------- measurement */

/* FNV-1a over the render's float32 bytes. One number that stands in for byte
   identity over the whole buffer; the consumer mirrors it with Math.imul. */
static double fingerprint(const float *x, size_t n) {
  const unsigned char *b = (const unsigned char *)x;
  unsigned int h = 2166136261u;
  size_t i, bytes = n * 4;
  for (i = 0; i < bytes; i++) {
    h ^= (unsigned int)b[i];
    h *= 16777619u;
  }
  return (double)h;
}

/* Every feature the consumer compares, in the order it reads them. No libm:
   the ruler has to be reproducible bit for bit in JS, or a difference in the
   measurement would read as a difference in the audio. */
static void measure(const float *a, const float *b, size_t frames, double fade, double *f) {
  double energy = 0, diff_energy = 0, sum = 0, peak = 0, repeat = 0, cum = 0;
  double zc = 0, clips = 0, nonfinite = 0, t90 = 0;
  size_t i;

  for (i = 0; i < frames; i++) {
    double x = (double)a[i];
    double d = x - (i ? (double)a[i - 1] : 0.0);
    double r = fabs(x - (double)b[i]);
    double ax = fabs(x);
    if (!(x <= 1e300 && x >= -1e300)) nonfinite += 1;
    if (ax > peak) peak = ax;
    if (ax > 1.0) clips += 1;
    if (r > repeat) repeat = r;
    energy += x * x;
    diff_energy += d * d;
    sum += x;
    if (i && ((a[i] >= 0) != (a[i - 1] >= 0))) zc += 1;
  }
  for (i = 0; i < frames && energy > 0; i++) {
    double x = (double)a[i];
    cum += x * x;
    if (cum >= energy * 0.9) {
      t90 = (double)(i + 1) / (double)frames;
      break;
    }
  }

  f[0] = (double)frames;
  f[1] = fade;
  f[2] = peak;
  f[3] = frames ? sqrt(energy / (double)frames) : 0;
  f[4] = t90;
  f[5] = energy > 0 ? diff_energy / energy : 0;
  f[6] = zc;
  f[7] = frames ? sum / (double)frames : 0;
  f[8] = clips;
  f[9] = nonfinite;
  f[10] = frames ? (double)a[frames - 1] : 0;
  f[11] = repeat;
  f[12] = fingerprint(a, frames);
  f[13] = frames ? (double)a[0] : 0;
}

/* Decimated probe plus the last 32 samples — the tail is where the fade is. */
static unsigned int probe(const float *x, size_t frames, float *dst) {
  size_t stride = 1 + frames / 1024;
  size_t i, tail;
  unsigned int n = 0;
  for (i = 0; i < frames && n < 1024; i += stride) dst[n++] = x[i];
  tail = frames > 32 ? frames - 32 : 0;
  for (i = tail; i < frames; i++) dst[n++] = x[i];
  return n;
}

int main(int argc, char **argv) {
  FILE *f;
  size_t ci, i;

  (void)bk_fill_signal; /* this battery needs no stimulus: it IS the source */

  if (argc < 2) {
    fprintf(stderr, "usage: %s <out.bin>\n", argv[0]);
    return 2;
  }
  f = fopen(argv[1], "wb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 2;
  }
  bk_parity_open(f);

  /* The kind table: count, then each name's length and its characters. What
     this gates is that the enum order is still DRUM_KINDS' order. */
  {
    unsigned int n = 0;
    int k;
    meta[n++] = BK_DRUM_KIND_COUNT;
    for (k = 0; k < BK_DRUM_KIND_COUNT; k++) {
      const char *nm = bk_drum_kind_name(k);
      size_t len = 0;
      while (nm[len]) len++;
      meta[n++] = (double)len;
      for (i = 0; i < len; i++) meta[n++] = (double)(unsigned char)nm[i];
    }
    bk_parity_emit(f, "kinds", meta, n, NULL, 0, NULL, 0);
  }

  /* One record per kind's defaults, as the flat thirteen. Fields a kind does
     not own read as 0 on both sides, which is the convention drum-synth.h
     states, and this is where it is checked rather than assumed. */
  for (i = 0; i < BK_DRUM_KIND_COUNT; i++) {
    bk_drum_params p;
    char name[32];
    bk_drum_defaults((int)i, &p);
    flatten_params(&p, meta);
    sprintf(name, "defaults-%s", bk_drum_kind_name((int)i));
    bk_parity_emit(f, name, meta, BK_DS_PARAM_COUNT, NULL, 0, NULL, 0);
  }

  /* The factory layout, entry by entry: pad, kind, choke, the override list,
     and the pad's name. The name is in here because a mislabelled pad is a
     real bug that no amount of audio measurement would ever see. */
  for (i = 0; i < BK_DRUM_LAYOUT_COUNT; i++) {
    const bk_drum_layout_entry *e = &bk_drum_default_layout[i];
    unsigned int n = 0;
    char name[32];
    size_t len = 0;
    int j;
    meta[n++] = (double)e->pad;
    meta[n++] = (double)e->kind;
    meta[n++] = (double)e->choke;
    meta[n++] = (double)e->n_overrides;
    for (j = 0; j < e->n_overrides; j++) {
      meta[n++] = (double)e->overrides[j].key;
      meta[n++] = e->overrides[j].value;
    }
    while (e->name[len]) len++;
    meta[n++] = (double)len;
    for (j = 0; j < (int)len; j++) meta[n++] = (double)(unsigned char)e->name[j];
    sprintf(name, "layout-%02d", (int)i);
    bk_parity_emit(f, name, meta, n, NULL, 0, NULL, 0);
  }

  /* bk_drum_layout_resolve, per pad: the kind it returns and the thirteen
     params it produces.
     This record exists because the function was, until it was added, checked
     absolutely nowhere. The layout-* records above verify the static table's
     CONTENTS, not the code that reads it; and the render cases below cannot
     verify it either, because the consumer rebuilds its JS reference params
     FROM the vector the C resolved (see jsParamsFor). A resolve that dropped
     an override, or skipped the defaults entirely, therefore corrupted the C
     render and the JS reference in lockstep, the two still agreed, and the
     battery passed. Mutation testing found exactly that hole.
     Here the consumer recomputes defaults-plus-overrides independently, so
     the resolve has an oracle it cannot influence. */
  for (i = 0; i < BK_DRUM_LAYOUT_COUNT; i++) {
    bk_drum_params p;
    char name[32];
    int kind;
    /* Prefilled with a value resolve must overwrite, so a resolve that writes
       nothing at all cannot pass by inheriting a zeroed struct. */
    memset(&p, 0x5a, sizeof(p));
    kind = bk_drum_layout_resolve(i, &p);
    meta[0] = (double)kind;
    flatten_params(&p, meta + 1);
    sprintf(name, "resolve-%02d", (int)i);
    bk_parity_emit(f, name, meta, 1 + BK_DS_PARAM_COUNT, NULL, 0, NULL, 0);
  }

  for (ci = 0; ci < sizeof(CASES) / sizeof(CASES[0]); ci++) {
    const rcase *c = &CASES[ci];
    bk_drum_params p;
    size_t out_len, frames_a, frames_b;
    double fade;
    unsigned int n32;
    int j;

    /* Resolve the params the same way the host would: the layout entry when
       the case names one, otherwise the kind's defaults, then the case's own
       overrides on top. */
    if (c->layout >= 0) {
      bk_drum_layout_resolve((size_t)c->layout, &p);
    } else {
      bk_drum_defaults(c->kind, &p);
    }
    for (j = 0; j < c->n_over; j++) bk_drum_param_set(&p, c->over[j].key, c->over[j].value);
    /* The params a static initialiser cannot portably carry. */
    /* Match the case by name, not by inferring its identity from a
       conjunction of its field values. Case names are unique, and a test
       harness that guesses which case it is looking at is a harness that
       silently stops testing what it claims the moment the table is
       edited. */
    if (strcmp(c->name, "kick-level-nan") == 0) {
      p.level = bk_test_nan();
    }
    if (strcmp(c->name, "kick-click-inf") == 0) {
      p.click = (double)INFINITY;
    }

    out_len = c->out_len ? c->out_len : bk_drum_render_capacity(c->sr);
    if (out_len > BUF_CAP) out_len = BUF_CAP;

    /* Two different prefills, so an unwritten frame cannot hide as a zero. */
    for (i = 0; i < out_len; i++) buf_a[i] = 0.25f;
    for (i = 0; i < out_len; i++) buf_b[i] = -0.75f;

    frames_a = bk_drum_render(c->kind, c->sr, &p, buf_a, out_len);
    frames_b = bk_drum_render(c->kind, c->sr, &p, buf_b, out_len);

    fade = floor(c->sr * 0.002 + 0.5);
    if (!(fade > 0)) fade = 0;
    if (fade > (double)frames_a) fade = (double)frames_a;

    measure(buf_a, buf_b, frames_a, fade, pay64);
    /* A frame-count disagreement between two identical calls is nonsense, so
       it is reported as a poisoned repeat_diff rather than quietly averaged. */
    if (frames_a != frames_b) pay64[11] = -1;
    n32 = probe(buf_a, frames_a, pay32);

    params[0] = (double)c->kind;
    params[1] = c->sr;
    params[2] = (double)out_len;
    params[3] = (double)c->layout;
    flatten_params(&p, params + 4);

    bk_parity_emit(f, c->name, params, 4 + BK_DS_PARAM_COUNT, pay64, N_FEATURES, pay32, n32);
  }

  if (!bk_parity_close(f)) {
    fclose(f);
    return 1;
  }
  fclose(f);
  return 0;
}
