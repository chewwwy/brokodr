/*
 * Bro.Kodr DSP core — BROBEATS drum rack.
 * C port of dsp/core/drum-rack.js. See biquad.h for the porting rules.
 *
 * Sixteen pads summed into one stereo bus, with choke groups, solo/mute/gain
 * and an optional per-pad effect chain.
 *
 * This is the first ported module that is mostly *composition*: it owns almost
 * no arithmetic of its own and instead drives sixteen bk_drum_voice and up to
 * sixteen bk_chain, both already ported and verified. What it can get wrong is
 * therefore not numbers but wiring — which pad went through which chain, which
 * bus a pad summed into, whether solo silenced a voice or merely stopped
 * metering it, whether the rack's gain scaled what the host had already put in
 * the output buffer. The battery is built around that.
 *
 * Three things here differ from the JS, all of them forced by the no-allocation
 * rule, and all three are behaviour-preserving:
 *
 *   1. THE PER-PAD CHAINS ARE NOT LAZY, BECAUSE THERE IS NOTHING LEFT TO DEFER.
 *
 *      drum-rack.js creates a pad's Chain on first use, and says why: sixteen
 *      chains' worth of scratch buffers allocated up front would be wasted on
 *      the common case where no pad has an effect. That is an allocation
 *      argument, not a behavioural one — and under route (c) it dissolves,
 *      because a bk_chain's scratch is caller-supplied and pads render one at a
 *      time, so all sixteen chains can share ONE wet buffer pair (see
 *      bk_drum_rack_init). What was sixteen lazy allocations is one eager pair.
 *
 *      The chains are therefore all live from init, and bk_drum_rack_chain_for
 *      only hands back a pointer. This is observationally identical to the JS,
 *      and the reason is worth stating because it is not obvious: every place
 *      the JS distinguishes a null chain from a live one treats them the same.
 *      process() tests `chain && chain.length > 0`, so an empty chain and no
 *      chain take the same branch; clearPad()'s `c.clear()` and reset()'s
 *      `c.panic()` are both no-ops on a chain with no slots. A pad whose chain
 *      was never asked for and a pad whose chain was asked for and left empty
 *      must render identically — parity-drum-rack.c asserts exactly that.
 *
 *   2. PARAMS ARE NUMBERS, NOT STRINGS. setParam("gain") becomes
 *      BK_DRUM_P_GAIN from the generated param-keys.h — the index the command
 *      ring already carries (DRUM_KEY in backend.ts and worklet-processor.js).
 *      Note BK_DRUM_P_ROUTE is on that wire but is NOT a rack param: engine.js
 *      intercepts "route" for its own drumRoute field and the rack's switch has
 *      no case for it. The C keeps that exactly — the key falls through and
 *      changes nothing — because the rack is not the owner of the routing
 *      decision and a port that quietly adopted it would move the decision.
 *
 *   3. THE PADS' SAMPLE DATA IS STILL BORROWED. bk_drum_voice_set_buffer takes
 *      a pointer it does not own (drum-voice.h note 1), and passing one through
 *      the rack changes nothing about that: the caller owns every sample buffer
 *      and must outlive the rack.
 *
 * Real-time discipline, unchanged from the JS: zero allocation in process(),
 * and control calls that never touch the audio path's storage.
 */

#ifndef BROKODR_DSP_DRUM_RACK_H
#define BROKODR_DSP_DRUM_RACK_H

#include <stddef.h>

#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/drum-voice.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* PAD_COUNT in drum-rack.js. The 4x4 grid; also the width of every per-pad
   array the UI reads. */
#define BK_PAD_COUNT 16

typedef struct {
  double sr;
  int max_block;

  bk_drum_voice pads[BK_PAD_COUNT];

  /* See note 1: live from init, not lazily created. `chain_used` is not a
     gate on anything — it records whether the host ever asked for a pad's
     chain, purely so the parity battery can prove that asking for one and
     leaving it empty changes nothing. */
  bk_chain pad_chains[BK_PAD_COUNT];
  int chain_used[BK_PAD_COUNT];

  /* --- caller-owned scratch, all max_block long --- */
  /* One pad rendered in isolation, for a pad that has its own chain. One pair
     is enough because pads are rendered one at a time — the JS says the same
     of its own padL/padR. */
  float *pad_l;
  float *pad_r;
  /* The rack's own bus. Pads sum here, THEN rack gain and metering are
     applied, THEN the result is added to the caller's buffer. Applying gain
     straight to the output would scale whatever the host had already put
     there and meter it as ours. */
  float *bus_l;
  float *bus_r;

  double gain; /* linear, already through dbToGain */
  int muted;
  /* Pad index soloed, or -1. Soloing is a performance control, not a mix
     state: it cuts the others outright rather than ducking them. */
  int solo;

  double meter_l;
  double meter_r;
  /* Per-pad peak, for the UI's pad lighting. FLOAT, not double, because the JS
     holds it in a Float32Array: a pad's meter is a voice's double meter rounded
     once on the way in, and the UI reads the rounded value. meter_l/meter_r are
     plain JS numbers by contrast, hence double. */
  float pad_meters[BK_PAD_COUNT];

  /*
   * Per-pad "just fired" flash, in FRAMES remaining, counting down.
   *
   * A countdown rather than a flag the UI clears, because the UI polls at
   * ~30fps while this runs at ~375: a one-block flag set by a 20 ms hat would
   * simply be missed between two polls. Held ~90 ms so any poll inside the
   * window sees the hit.
   *
   * Frames, not blocks: max_block is only the allocation ceiling and the host
   * usually hands over far smaller blocks (128 against a 512 ceiling), so a
   * block-denominated countdown expired ~4x too early and the grid never lit.
   * It is allowed to go negative, exactly as the JS's does.
   */
  int trigger_flags[BK_PAD_COUNT];
  int flash_frames;
} bk_drum_rack;

/*
 * Initialise.
 *
 * Every buffer must be at least max_block floats and must outlive the rack.
 * `chain_wet_l`/`chain_wet_r` are the scratch pair shared by all sixteen
 * per-pad chains — safe because a chain's wet scratch is written before it is
 * read inside bk_chain_process and never carries state between calls, and
 * because the render loop walks the pads one at a time. That sharing is what
 * replaces the JS's lazy chain allocation (see note 1).
 *
 * Returns 0, or -1 when the arguments cannot be honoured.
 */
int bk_drum_rack_init(bk_drum_rack *rk, double sample_rate, int max_block, float *pad_l,
                      float *pad_r, float *bus_l, float *bus_r, float *chain_wet_l,
                      float *chain_wet_r);

/* --- control: off the audio thread ------------------------------------- */

/* The pad at `index`, or NULL when the index is out of range. The JS's pad(i),
   including its `i | 0` truncation of a fractional index. */
bk_drum_voice *bk_drum_rack_pad(bk_drum_rack *rk, int index);

/*
 * Fire a pad, handling choke groups: any OTHER sounding pad in the same
 * non-zero group is cut first, which is how a closed hat kills an open hat on
 * a real kit. A bad index does nothing at all — not even a flash.
 */
void bk_drum_rack_trigger(bk_drum_rack *rk, int index, double velocity);
void bk_drum_rack_release(bk_drum_rack *rk, int index);

void bk_drum_rack_set_pad_param(bk_drum_rack *rk, int index, int key, double value);
void bk_drum_rack_set_pad_buffer(bk_drum_rack *rk, int index, int layer, const float *data,
                                 int frames, double src_rate);
/* Empties the pad's layers AND clears its chain — both halves, as in the JS. */
void bk_drum_rack_clear_pad(bk_drum_rack *rk, int index);

/* The pad's own effect chain, or NULL for a bad index. Never allocates; see
   note 1 on why this is not the JS's lazy constructor. */
bk_chain *bk_drum_rack_chain_for(bk_drum_rack *rk, int index);

/* `key` is one of BK_DRUM_P_* from param-keys.h. An unknown key is ignored,
   which is what the JS switch does by having no default — and which is also
   what happens to BK_DRUM_P_ROUTE (see note 2). */
void bk_drum_rack_set_param(bk_drum_rack *rk, int key, double value);

/* Silence everything immediately — panic, preset load, device change. Resets
   every pad, panics every pad chain, and clears the meters and the flashes. */
void bk_drum_rack_reset(bk_drum_rack *rk);

/* Non-zero while any pad is still sounding — lets the host skip the whole
   rack. The JS's `sounding` getter. */
int bk_drum_rack_sounding(const bk_drum_rack *rk);

/* --- audio -------------------------------------------------------------- */

/*
 * Render the rack ADDITIVELY into L/R. Never allocates.
 *
 * Pads without a chain (or with an empty one) render straight into the rack
 * bus. A pad with a live chain renders into pad_l/pad_r, runs through its
 * chain, and is then summed in — so a per-pad effect never touches the other
 * fifteen.
 */
void bk_drum_rack_process(bk_drum_rack *rk, float *l, float *r, size_t frames);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_DRUM_RACK_H */
