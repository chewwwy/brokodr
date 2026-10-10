/*
 * Bro.Kodr DSP core — the engine. C99 port of dsp/engine.js.
 *
 * The backend-agnostic processor a native host (WASAPI / ASIO / CoreAudio,
 * or the null driver) calls in place of the AudioWorklet:
 *
 *     bk_engine_init(e, sr, max_block, storage);    // storage: ZEROED floats
 *     bk_engine_io(e, BK_IO_IN_GAIN, -6.0);          // control, between blocks
 *     bk_engine_process(e, in_l, in_r, out_l, out_r, frames);
 *
 * Composition, in engine.js's order: file player -> carrier bus, Smart Voice
 * (raw input, pre-mute) -> drum triggers, BROBEATS rack, the input stage, the
 * master chain, DIRECT drums, then either the looper tap path or the fused
 * output pass, the clock last. See biquad.h for the porting rules. Every JS
 * Float32Array scratch is a float buffer carved out of `storage`; every JS
 * Number is a double, including fileRoute and drumRoute, which hold whatever
 * clamp(Math.round(v)) gives, NaN and -0 included.
 *
 * Storage. bk_engine_storage_floats(sr, max_block) floats, caller-owned,
 * ZERO-FILLED (calloc), outliving the engine: 27 max_block scratch buffers,
 * the Smart Voice lag history, and the looper's four stereo 30-second tracks
 * plus its undo pair — about 57.6 MB at 48 kHz, as in the JS once every track
 * has recorded. The looper requires its buffers zeroed (looper.h note 1);
 * requiring all of it zeroed costs nothing extra under calloc.
 *
 * Effects. engine.js's "add" verbs call createEffect inside Chain.add. Here
 * the host builds the effect through effect-registry.h (struct, storage,
 * bk_effect_create, any initial params from the spec's `params`, and a random
 * source) and hands it over in a bk_slot_spec whose `type` is the
 * bk_effect_type. The engine never frees it; the host may free it once the
 * remove/clear that dropped the slot has been applied.
 *
 * Commands. One function per engine.js verb, numeric throughout: param keys
 * are param-keys.h indices, never strings. Where engine.js coerces with `| 0`
 * before calling a module, the argument here is a double and goes through
 * ToInt32 (bk_onset_to_int32) at the same point, because the modules'
 * own coercions differ from it: setClassPad(-0.5 | 0) is pad 0, while
 * bk_smart_voice_set_class_pad(-0.5) would mute the class. Slot ids and chain
 * positions are int, as bk_chain takes them. The JS's `cmd.x === undefined`
 * defaults (a pad hit at velocity 1, a class-pad or capture of -1) are the
 * host's: pass the default.
 *
 * JS behaviour reproduced on purpose:
 *  - "param" recalculates the chain's latency when the key is the slot type's
 *    quality key (chain.js compares the name to "quality"; the C chain leaves
 *    it to the caller). On a missing slot the JS still recalculates; that is
 *    a no-op, since every change to a latency input (slot list, bypass,
 *    pitch quality) already recalculated, and here it is skipped because no
 *    type is known.
 *  - io flags are `!!value`: NaN and +-0 are false.
 *  - fileRoute is clamp(Math.round(v), 0, 3), so NaN stays NaN: the player
 *    still renders the carrier (NaN !== OFF) but never reaches the input.
 *    drumRoute likewise: a NaN route renders the rack, sums it nowhere, and
 *    still hands it to the looper's drum source; -0 is OFF and reads back -0.
 *  - Smart Voice hears sanitize((inL + inR) * 0.5) before swap, mono, gain and
 *    mute; its hits trigger the rack before the rack renders.
 *  - the input gain smoother advances every sample, muted or not.
 *  - DIRECT drums are added to both taps WITHOUT sanitize, into float storage.
 *  - the looper path blends the tap first, then fades with the master gain;
 *    the fused path takes masterMix.next() before outGain.next(). Both clamp
 *    to +-1.4 and sanitize.
 *  - the looper's drum source is NULL when the rack did not render this
 *    block, so a DRUMS track does not record a stale block.
 *  - frames == 0 gives NaN RMS meters (0 / 0); clip latches only set.
 *  - cpu_load is never written by the engine (the worklet overwrites the
 *    meter slot); it is a field for the host.
 * process() requires 0 <= frames <= max_block (the rack and looper take
 * size_t). in_* and out_* may alias.
 */

#ifndef BROKODR_DSP_ENGINE_H
#define BROKODR_DSP_ENGINE_H

#include <stddef.h>

#include "brokodr/dsp/beat-classify.h"
#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/clock.h"
#include "brokodr/dsp/drum-rack.h"
#include "brokodr/dsp/effect-registry.h"
#include "brokodr/dsp/file-player.h"
#include "brokodr/dsp/looper.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* FILE_ROUTE and DRUM_ROUTE. */
enum { BK_FILE_ROUTE_OFF = 0, BK_FILE_ROUTE_INPUT = 1, BK_FILE_ROUTE_CARRIER = 2, BK_FILE_ROUTE_BOTH = 3 };
enum { BK_DRUM_ROUTE_OFF = 0, BK_DRUM_ROUTE_DIRECT = 1, BK_DRUM_ROUTE_CHAIN = 2 };

/* The fields of the "io" verb, numbered as IO_FIELD in worklet-processor.js. */
enum {
  BK_IO_IN_GAIN = 0,
  BK_IO_OUT_GAIN = 1,
  BK_IO_MUTE = 2,
  BK_IO_BYPASS = 3,
  BK_IO_MONO = 4,
  BK_IO_SWAP = 5,
  BK_IO_MASTER_MIX = 6
};

/* Which chain an fx verb addresses: the master rack, a pad's ("padfx") or a
   loop track's ("loopfx"). */
enum { BK_TARGET_MASTER = 0, BK_TARGET_PAD = 1, BK_TARGET_LOOP = 2 };

/* The sub-ops of "loop" and "voicecal". */
enum {
  BK_LOOPOP_REC = 0,
  BK_LOOPOP_PLAY = 1,
  BK_LOOPOP_STOP = 2,
  BK_LOOPOP_CLEAR = 3,
  BK_LOOPOP_UNDO = 4,
  BK_LOOPOP_CLEARALL = 6
};
enum {
  BK_VOICECAL_CENTROID = 0,
  BK_VOICECAL_ATTACK = 1,
  BK_VOICECAL_PAD = 2,
  BK_VOICECAL_CAPTURE = 3,
  BK_VOICECAL_CLEAR = 4,
  BK_VOICECAL_RESET = 5,
  BK_VOICECAL_DETRESET = 6
};

/* readMeters layout. */
#define BK_ENGINE_SLOT_METERS 16
#define BK_ENGINE_FILE_METERS 40
#define BK_ENGINE_PAD_METERS 48
#define BK_ENGINE_LOOP_METERS 68
#define BK_ENGINE_CLOCK_METERS (BK_ENGINE_LOOP_METERS + BK_LOOP_TRACKS * BK_LOOP_METER_STRIDE)
#define BK_ENGINE_VOICE_METERS (BK_ENGINE_CLOCK_METERS + 8)
/* One past the last value readMeters writes. */
#define BK_ENGINE_METER_COUNT (BK_ENGINE_VOICE_METERS + BK_VOICE_METER_STRIDE + 3 + BK_VOICE_CLASS_COUNT)

typedef struct {
  double sr;
  int max_block;

  float *dry_l, *dry_r, *cin_l, *cin_r;
  float *car_l, *car_r, *drum_l, *drum_r;
  float *tap_l, *tap_r, *loop_l, *loop_r;
  float *voice_buf;

  bk_file_player player;
  double file_route;
  bk_chain chain;
  bk_drum_rack drums;
  double drum_route;
  bk_clock clock;
  bk_looper looper;
  bk_smart_voice voice;

  bk_smoother in_gain, out_gain, master_mix;
  int in_muted, master_bypass, mono_input, input_swap;

  double meter_in_l, meter_in_r, meter_out_l, meter_out_r;
  double rms_in_l, rms_in_r, rms_out_l, rms_out_r;
  double clip_in, clip_out, peak_hold_in, peak_hold_out;

  double block_count;
  double cpu_load;
} bk_engine;

/* Floats bk_engine_init needs in `storage`, ZEROED. */
size_t bk_engine_storage_floats(double sample_rate, int max_block);

/* `new Engine(sampleRate, maxBlock)`. Returns 0, or -1 when a module refuses
   the arguments (max_block < 1, for one). */
int bk_engine_init(bk_engine *e, double sample_rate, int max_block, float *storage);

/* --- chain verbs: add, remove, move, param, mix, bypass, reset, clear ------
   `target` is BK_TARGET_*; `index` the pad or track (`cmd.index | 0`), ignored
   for the master. A bad pad or track index does nothing, as `if (!chain)
   break` does.

   padfx / loopfx add. engine.js hands the whole command to Chain.add, and
   Chain.add reads `spec.index` as the insert position, so on a pad or loop
   track chain cmd.index is BOTH the pad / track and the insert position
   (engine-client.ts sends `index: pos`, which the worklet's `...cmd` spread
   lets overwrite the pad). That is shipping behaviour; to reproduce it the
   host sets spec->index to the same value it passes as `index` (NaN -> 0,
   which is what splice() makes of clamp(NaN)). */
bk_chain *bk_engine_chain(bk_engine *e, int target, double index);
bk_slot *bk_engine_fx_add(bk_engine *e, int target, double index, const bk_slot_spec *spec);
void bk_engine_fx_remove(bk_engine *e, int target, double index, int id);
/* The master's `cmd.index`, the pad's and track's `cmd.at`. */
void bk_engine_fx_move(bk_engine *e, int target, double index, int id, int at);
void bk_engine_fx_param(bk_engine *e, int target, double index, int id, int key, double value);
void bk_engine_fx_mix(bk_engine *e, int target, double index, int id, double value);
void bk_engine_fx_bypass(bk_engine *e, int target, double index, int id, double value);
void bk_engine_fx_reset(bk_engine *e, int target, double index, int id);
void bk_engine_fx_clear(bk_engine *e, int target, double index);

/* --- io, file, pads, rack, looper, voice, clock -------------------------- */
void bk_engine_io(bk_engine *e, int field, double value);
void bk_engine_file_load(bk_engine *e, const float *l, const float *r, int frames, double rate);
void bk_engine_file_clear(bk_engine *e);
void bk_engine_file_param(bk_engine *e, int key, double value); /* BK_FILE_P_* */
void bk_engine_file_route(bk_engine *e, double value);

void bk_engine_pad(bk_engine *e, double index, double velocity);
void bk_engine_pad_off(bk_engine *e, double index);
void bk_engine_pad_param(bk_engine *e, double index, int key, double value); /* BK_PAD_P_* */
void bk_engine_pad_load(bk_engine *e, double index, double layer, const float *data, int frames,
                        double rate);
void bk_engine_pad_clear(bk_engine *e, double index);
void bk_engine_drum(bk_engine *e, int key, double value); /* BK_DRUM_P_*, ROUTE included */
void bk_engine_drum_reset(bk_engine *e);

void bk_engine_loop(bk_engine *e, int op, double index); /* BK_LOOPOP_*, numbered as LOOP_FIELD */
void bk_engine_loop_param(bk_engine *e, double index, int key, double value); /* BK_LOOP_P_* */
void bk_engine_looper_param(bk_engine *e, int key, double value);            /* BK_LOOPER_P_* */

void bk_engine_voice(bk_engine *e, int key, double value); /* bk_voice_param */
/* `cls` is cmd.cls (or, for CAPTURE, the class or -1), `arg` the feature,
   band or pad, as each op uses them. */
void bk_engine_voicecal(bk_engine *e, int op, double cls, double arg, double value);
void bk_engine_clock(bk_engine *e, int key, double value); /* BK_CLOCK_P_* */

void bk_engine_clip_reset(bk_engine *e);
void bk_engine_panic(bk_engine *e);

int bk_engine_recalc_latency(bk_engine *e);
int bk_engine_latency_samples(const bk_engine *e);

/* readMeters: writes BK_ENGINE_METER_COUNT doubles' worth of slots (13..15,
   45..47 and the unused slot meters are left alone, as in the JS). */
void bk_engine_read_meters(const bk_engine *e, double *out);
int bk_engine_read_voice_capture(const bk_engine *e, long long n, float *out);

/* --- audio -------------------------------------------------------------- */
void bk_engine_process(bk_engine *e, const float *in_l, const float *in_r, float *out_l,
                       float *out_r, int frames);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_ENGINE_H */
