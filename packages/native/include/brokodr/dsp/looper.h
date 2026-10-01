/*
 * Bro.Kodr DSP core — BROBEATS looper.
 * C port of dsp/core/looper.js. See biquad.h for the porting rules.
 *
 * Four loop tracks. Each records what the engine is already producing (the
 * master bus post-effects, or the drum rack alone), plays it back in a loop,
 * overdubs on top, and owns its own bk_chain.
 *
 * The three structural ideas the JS documents at length, kept exactly because
 * the behaviour is the whole point of them:
 *
 *   - LOOP PLAYBACK IS SUMMED AFTER THE RECORD TAP, so an overdub can never
 *     re-record the loop it is playing over. The runaway feedback that makes
 *     cheap loopers unusable cannot happen. The record source is handed in as
 *     bk_loop_src, which is not the output buffer.
 *
 *   - A TEMPO-LOCKED TRACK KEEPS NO PLAY POSITION. Its position is derived
 *     every sample as (clock.frame - anchor) mod frames, so nothing
 *     accumulates and four loops punched in at four different moments come
 *     back phase-locked. A free-running track (sync = 0) keeps its own counter
 *     and its length is whatever was played.
 *
 *   - QUANTISED PUNCHES ARE SAMPLE-ACCURATE. rec/play/stop on a tempo-locked
 *     track are scheduled to an absolute frame and applied INSIDE the
 *     per-sample loop. Block-boundary switching would put every punch up to
 *     2.7 ms off at 128 frames, in a random direction.
 *
 * Divergences from the JS, all forced by the no-allocation rule and all
 * behaviour-preserving:
 *
 *   1. EVERY BUFFER IS CALLER-OWNED AND LIVE FROM INIT. looper.js allocates a
 *      track's 30-second stereo buffer lazily on the first record ARM, and the
 *      undo slot on the first overdub, and explains why: an engine with an
 *      unused looper should cost nothing. Under route (c) the allocation is the
 *      host's decision, not this module's, so the laziness moves out to the
 *      host — which can still defer it, and gets the same benefit for free from
 *      demand-paged zero pages if it calloc's up front.
 *
 *      What has to be argued is that ALWAYS having the buffers is
 *      observationally identical to acquiring them late, because the JS tests
 *      `t.bufL` and `this.undoL` in seven places. It is, and the reason is that
 *      every one of those tests is reachable only in a state that already
 *      implies the buffer exists:
 *
 *        - REC is entered only through _beginTake, which ensures the buffer
 *          first, so `st === REC && bufL` is always true in the JS too.
 *        - frames > 0 is set only by _closeTake, which follows a take, so any
 *          playback or overdub path is downstream of the same allocation.
 *        - UNDO_LAYER is set only by _beginOverdub, which ensures the undo
 *          slot first.
 *        - EMPTY with frames == 0 takes the `len > 0` branch either way.
 *
 *      So the C keeps the *structure* of those guards (they are not deleted)
 *      but they can no longer fire. `buf_armed` and `undo_armed_ever` record
 *      whether the host would have allocated by now — they gate nothing, and
 *      exist so the parity battery can prove that an "unarmed" track renders
 *      identically to an armed one that was never recorded into.
 *
 *      THE CALLER MUST SUPPLY ZEROED BUFFERS. A fresh Float32Array is zeroed,
 *      and a track's buffer is read before it is fully written in exactly one
 *      case — a loop rounded UP past what was played, which _closeTake zeroes
 *      the tail of — but the undo slot and a cleared-then-replayed track both
 *      depend on the initial zeros. calloc, not malloc.
 *
 *   2. THE PER-TRACK CHAINS ARE NOT LAZY. Same argument as drum-rack.h note 1,
 *      and the same three sites: process() tests `chain && chain.length > 0` so
 *      an empty chain and no chain take the same branch; clear() and reset()
 *      call panic(), a no-op on an empty chain; readMeters reports
 *      `chain ? chain.length : 0`, and an empty live chain reports 0. All four
 *      chains share one wet scratch pair, which is safe because tracks render
 *      one at a time — the JS says the same of its own trkL/trkR.
 *
 *   3. PARAMS ARE NUMBERS, NOT STRINGS: BK_LOOP_P_* and BK_LOOPER_P_* from the
 *      generated param-keys.h, which are the indices the command ring already
 *      carries (LOOP_KEY / LOOPER_KEY in backend.ts and worklet-processor.js).
 *
 * Real-time discipline, unchanged from the JS: zero allocation in process().
 */

#ifndef BROKODR_DSP_LOOPER_H
#define BROKODR_DSP_LOOPER_H

#include <stddef.h>

#include "brokodr/dsp/chain.h"
#include "brokodr/dsp/clock.h"
#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* LOOP_TRACKS in looper.js — the track count, and the ceiling on a configured
   one. Also the width of every per-track array the UI reads. */
#define BK_LOOP_TRACKS 4

/* DEFAULT_LOOP_SECONDS — seconds of recording per track. */
#define BK_DEFAULT_LOOP_SECONDS 30.0

/* Meter values per loop track. Keep in step with bk_looper_read_meters and the
   UI decoder. */
#define BK_LOOP_METER_STRIDE 8

/* Track state. APPEND ONLY — the value goes over the meter block. */
enum {
  BK_LOOP_EMPTY = 0,   /* nothing recorded */
  BK_LOOP_REC = 1,     /* recording the first take; length not decided yet */
  BK_LOOP_PLAY = 2,    /* looping */
  BK_LOOP_OVERDUB = 3, /* looping and summing new material in */
  BK_LOOP_STOPPED = 4  /* has audio, silent */
};

/* A punch waiting for the next grid line. APPEND ONLY. */
enum { BK_LOOP_PEND_NONE = 0, BK_LOOP_PEND_REC = 1, BK_LOOP_PEND_PLAY = 2, BK_LOOP_PEND_STOP = 3 };

/* What a track records. APPEND ONLY.
    MASTER — the master bus post-effects: everything you hear except loop
             playback.
    DRUMS  — the BROBEATS bus alone, so a kit loop is unaffected by the vocal
             chain. */
enum { BK_LOOP_SRC_MASTER = 0, BK_LOOP_SRC_DRUMS = 1 };

/* Undo slot contents. Module-private in the JS; exposed here only because the
   parity battery reads the field, and a magic number in a dump is unreadable. */
enum {
  BK_UNDO_NONE = 0,
  BK_UNDO_LAYER = 1, /* an overdub delta: undo subtracts it */
  BK_UNDO_TAKE = 2   /* "the first take", which undo drops by zeroing length */
};

/*
 * What a track records, handed in per block. A NULL member reads as silence,
 * which is what the drum source is when the rack is idle — so this stands in
 * for the JS's nullSrc as well, and passing NULL for the whole struct is the
 * same as passing one with four NULL members.
 */
typedef struct {
  const float *master_l;
  const float *master_r;
  const float *drum_l;
  const float *drum_r;
} bk_loop_src;

typedef struct {
  int index;
  double sr;
  int max_block;
  int max_frames;

  /* Caller-owned, max_frames each, ZEROED. See note 1. */
  float *buf_l;
  float *buf_r;
  /* Whether the host would have allocated by now. Gates nothing; see note 1. */
  int buf_armed;

  /* Loop length in frames. 0 while empty. */
  int frames;
  int state;   /* BK_LOOP_* */
  int pending; /* BK_LOOP_PEND_* */
  /* Absolute clock frame the pending punch fires on. Double for the same
     reason bk_clock.frame is — see clock.h. */
  double pending_at;

  /* Free-running play position. Unused when `sync` is set. */
  int pos;
  /* Frames written so far during the first take. */
  int rec_write;
  /* Absolute clock frame that loop position 0 sits on (tempo-locked tracks). */
  double anchor;
  /* Overdub passes committed, including the first take. */
  int layers;

  double gain_db;
  double gain;
  double pan;
  double pan_l;
  double pan_r;
  int muted;
  int soloed;
  int sync;
  int source; /* BK_LOOP_SRC_* */

  /* Play/stop/mute fade. A one-pole over a few ms — clicks on every edge
     otherwise. */
  bk_smoother play_gain;
  /* Linear declick ramp counter for a record punch-in. */
  int rec_ramp;
  /* Last frame index written, for the punch-out declick. -1 for none. */
  int last_write;

  /* Live from init, not lazily created. See note 2. */
  bk_chain chain;
  int chain_used;

  double meter;
  /* 0..1 through the loop, for the UI playhead. */
  double pos_norm;
} bk_loop_track;

typedef struct {
  double sr;
  int max_block;
  double max_seconds;
  int max_frames;
  /* Declick ramp length in frames (~2 ms), floored at 8. */
  int declick;

  bk_loop_track tracks[BK_LOOP_TRACKS];
  int track_count;

  /* --- caller-owned scratch, all max_block long --- */
  /* One track rendered in isolation, for a track that has its own chain. One
     pair is enough because tracks render one at a time. */
  float *trk_l;
  float *trk_r;
  /* The looper's own bus: tracks sum here, then looper gain and metering, then
     the result is added to the caller's buffer. Applying gain straight to the
     output would scale whatever the host had already put there. */
  float *bus_l;
  float *bus_r;

  double gain_db;
  double gain;
  int muted;
  double meter_l;
  double meter_r;

  /* --- the single undo slot ------------------------------------------- */
  /* Caller-owned, max_frames each, ZEROED. One slot for the whole looper: an
     undo stack of 30-second stereo layers is tens of megabytes per level for a
     feature nobody uses past one step. */
  float *undo_l;
  float *undo_r;
  int undo_track;
  int undo_frames;
  int undo_mode; /* BK_UNDO_* */
  /* Set when the slot's layer is currently part of the loop (undo removes it). */
  int undo_applied;
  /* Set while an overdub is being captured into the slot. */
  int undo_armed;
  /* Whether the host would have allocated the slot by now. Gates nothing. */
  int undo_armed_ever;
} bk_looper;

/*
 * Every buffer the looper needs, supplied by the caller. All of it must
 * outlive the looper. Buffers marked ZEROED must be zero-filled before init —
 * calloc, not malloc. See note 1.
 *
 * Unused track slots (when `tracks` is below BK_LOOP_TRACKS) may be NULL.
 */
typedef struct {
  float *track_l[BK_LOOP_TRACKS]; /* max_frames each, ZEROED */
  float *track_r[BK_LOOP_TRACKS]; /* max_frames each, ZEROED */
  float *undo_l;                  /* max_frames, ZEROED */
  float *undo_r;                  /* max_frames, ZEROED */
  float *trk_l;                   /* max_block */
  float *trk_r;                   /* max_block */
  float *bus_l;                   /* max_block */
  float *bus_r;                   /* max_block */
  float *chain_wet_l;             /* max_block, shared by all track chains */
  float *chain_wet_r;             /* max_block, shared by all track chains */
} bk_looper_buffers;

/*
 * Frames per track buffer for a given rate and length, so the caller can size
 * its allocation before init. Mirrors the JS's
 * max(MIN_LOOP_FRAMES, round(maxSeconds * sampleRate)); pass 0 for the
 * default 30. `maxSeconds || 30` is falsiness, not a sign test: 0 and NaN take
 * the default, a NEGATIVE value is kept and floors at MIN_LOOP_FRAMES.
 */
int bk_looper_max_frames(double sample_rate, double max_seconds);

/*
 * Initialise. Both defaults mirror the JS's `||`, which is falsiness and not a
 * sign test: `tracks` 0 means BK_LOOP_TRACKS but a NEGATIVE count is kept and
 * builds no tracks at all (the constructor's `for (i < n)` never runs), and
 * `max_seconds` follows bk_looper_max_frames. Measured by the init-negtracks
 * and maxframes parity cases. Returns 0, or -1 when the arguments cannot be
 * honoured.
 */
int bk_looper_init(bk_looper *lp, double sample_rate, int max_block, int tracks,
                   double max_seconds, const bk_looper_buffers *bufs);

/* --- control: off the audio thread ------------------------------------- */

/* The track at `index`, or NULL when the index is out of range. */
bk_loop_track *bk_looper_track(bk_looper *lp, int index);
int bk_looper_track_count(const bk_looper *lp);

/* Non-zero while the track still needs rendering — includes a stop fade in
   progress. The JS's `audible` getter. */
int bk_loop_track_audible(const bk_loop_track *t);
int bk_loop_track_recording(const bk_loop_track *t);
int bk_loop_track_playing(const bk_loop_track *t);

/* Non-zero when anything needs rendering — lets the host skip the looper
   entirely. The JS's `active` getter. */
int bk_looper_active(const bk_looper *lp);

/* The track's own effect chain, or NULL for a bad index. Never allocates; see
   note 2 on why this is not the JS's lazy constructor. */
bk_chain *bk_looper_chain_for(bk_looper *lp, int index);

/*
 * The one-button record: empty -> record, recording -> close the loop and play,
 * playing -> overdub, overdubbing -> back to play, stopped -> play and overdub.
 * `clock` may be NULL, in which case the punch is immediate.
 */
void bk_looper_record_toggle(bk_looper *lp, int index, bk_clock *clock);
/* Play <-> stop. Does nothing to an empty track. */
void bk_looper_play_toggle(bk_looper *lp, int index, bk_clock *clock);
void bk_looper_stop(bk_looper *lp, int index, bk_clock *clock);

/* Drop the track's audio. Immediate and unquantised: clear is a decision, not a
   musical event, and waiting a bar to obey it feels broken. */
void bk_looper_clear(bk_looper *lp, int index);
void bk_looper_clear_all(bk_looper *lp);

/* Undo/redo the most recent record or overdub. One slot for the whole looper,
   so this only ever applies to the last thing recorded, on whichever track that
   was. Calling it twice redoes. */
void bk_looper_undo(bk_looper *lp, int index);
/* Non-zero when bk_looper_undo on this track would do something. */
int bk_looper_can_undo(const bk_looper *lp, int index);

/* `key` is one of BK_LOOP_P_* / BK_LOOPER_P_*. An unknown key is ignored,
   which is what the JS switch does by having no default. */
void bk_looper_set_track_param(bk_looper *lp, int index, int key, double value);
void bk_looper_set_param(bk_looper *lp, int key, double value);

/* Stop everything and silence the chains, keeping the recorded audio. Panic.
   A take interrupted by this is dropped, not kept as a fragment. */
void bk_looper_reset(bk_looper *lp);

/* --- meters ------------------------------------------------------------- */

/*
 * Write the looper's meter block into `out` at `offset`, stride
 * BK_LOOP_METER_STRIDE per track: state, pending, meter, position 0..1, length
 * frames, chain length, layers, undo-available. Returns the count written.
 */
int bk_looper_read_meters(const bk_looper *lp, double *out, int offset);

/* --- audio -------------------------------------------------------------- */

/*
 * Render every track ADDITIVELY into l/r. Never allocates.
 *
 * `src` may be NULL, and any member of it may be NULL — both read as silence.
 * `clock` may be NULL, in which case frame 0 is assumed for the whole block,
 * exactly as the JS's `clock ? clock.frame : 0` does.
 *
 * The caller advances the clock (bk_clock_advance) AFTER this returns.
 */
void bk_looper_process(bk_looper *lp, const bk_loop_src *src, float *l, float *r, size_t frames,
                       bk_clock *clock);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_LOOPER_H */
