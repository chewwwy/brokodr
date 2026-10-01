/*
 * Bro.Kodr DSP core — BROBEATS looper. C port of dsp/core/looper.js.
 * Read looper.h first: it carries the three forced divergences and, in
 * particular, the argument that always-present buffers are observationally
 * identical to the JS's lazy ones.
 */

#include "brokodr/dsp/looper.h"

#include <math.h>

/* Math.round, which is floor(x + 0.5) and NOT C's round(). Same local helper
   as drum-rack.c and clock.c, for the same reason. */
static double js_round(double x) { return floor(x + 0.5); }

/* Shortest loop worth keeping, in frames (~50 ms) — below this it was a
   mis-click. Module-private in the JS, and stays private here. */
#define MIN_LOOP_FRAMES 2048

/* Declick ramp length in ms at any rate (~2 ms at 48k in the JS's wording). */
#define DECLICK_MS 2.0

/* --- forward declarations ---------------------------------------------- */

static void apply_action(bk_looper *lp, bk_loop_track *t, int action, bk_clock *clock,
                         double frame);
static void close_take(bk_looper *lp, bk_loop_track *t, bk_clock *clock, int then_stop);
static void declick_out(bk_looper *lp, bk_loop_track *t);
static void render_track(bk_looper *lp, bk_loop_track *t, const bk_loop_src *src, float *dst_l,
                         float *dst_r, int frames, bk_clock *clock, double clock_frame);

/* --- construction ------------------------------------------------------- */

/* `o.maxSeconds || DEFAULT_LOOP_SECONDS`: 0 and NaN are falsy, a negative
   number is not. */
static double js_or_seconds(double s) {
  return (s != 0.0 && s == s) ? s : BK_DEFAULT_LOOP_SECONDS;
}

int bk_looper_max_frames(double sample_rate, double max_seconds) {
  const double secs = js_or_seconds(max_seconds);
  return (int)bk_max((double)MIN_LOOP_FRAMES, js_round(secs * sample_rate));
}

int bk_looper_init(bk_looper *lp, double sample_rate, int max_block, int tracks,
                   double max_seconds, const bk_looper_buffers *bufs) {
  int i;

  if (!lp || !bufs || !(sample_rate > 0.0) || max_block <= 0) return -1;
  if (tracks > BK_LOOP_TRACKS) return -1;
  if (!bufs->undo_l || !bufs->undo_r) return -1;
  if (!bufs->trk_l || !bufs->trk_r || !bufs->bus_l || !bufs->bus_r) return -1;
  if (!bufs->chain_wet_l || !bufs->chain_wet_r) return -1;

  lp->sr = sample_rate;
  lp->max_block = max_block;
  /* `o.maxSeconds || DEFAULT_LOOP_SECONDS` — 0 and absent are the same thing
     in the JS, and so is NaN; a negative value is kept. */
  lp->max_seconds = js_or_seconds(max_seconds);
  lp->max_frames = bk_looper_max_frames(sample_rate, lp->max_seconds);
  lp->declick = (int)bk_max(8.0, js_round((DECLICK_MS * sample_rate) / 1000.0));
  /* `o.tracks || LOOP_TRACKS`: only 0 takes the default. A negative count
     survives the `||` and the constructor's loop then builds nothing. */
  lp->track_count = tracks == 0 ? BK_LOOP_TRACKS : (tracks < 0 ? 0 : tracks);

  for (i = 0; i < BK_LOOP_TRACKS; i++) {
    bk_loop_track *t = &lp->tracks[i];
    t->index = i;
    t->sr = sample_rate;
    t->max_block = max_block;
    t->max_frames = lp->max_frames;
    t->buf_l = bufs->track_l[i];
    t->buf_r = bufs->track_r[i];
    t->buf_armed = 0;
    t->frames = 0;
    t->state = BK_LOOP_EMPTY;
    t->pending = BK_LOOP_PEND_NONE;
    t->pending_at = 0.0;
    t->pos = 0;
    t->rec_write = 0;
    t->anchor = 0.0;
    t->layers = 0;
    t->gain_db = 0.0;
    t->gain = 1.0;
    t->pan = 0.0;
    t->pan_l = 1.0;
    t->pan_r = 1.0;
    t->muted = 0;
    t->soloed = 0;
    t->sync = 1;
    t->source = BK_LOOP_SRC_MASTER;
    bk_smoother_init(&t->play_gain, sample_rate, 3.0, 0.0);
    t->rec_ramp = 0;
    t->last_write = -1;
    /* All four chains share one wet pair. Safe for the same reason it is in
       the drum rack: a chain writes its scratch before reading it, keeps no
       state in it between calls, and tracks render one at a time. */
    if (bk_chain_init(&t->chain, sample_rate, max_block, 0, bufs->chain_wet_l,
                      bufs->chain_wet_r) != 0) {
      return -1;
    }
    t->chain_used = 0;
    t->meter = 0.0;
    t->pos_norm = 0.0;

    /* A live track must have somewhere to record. An unused slot beyond
       track_count may be NULL, and never gets reached. */
    if (i < lp->track_count && (!t->buf_l || !t->buf_r)) return -1;
  }

  lp->trk_l = bufs->trk_l;
  lp->trk_r = bufs->trk_r;
  lp->bus_l = bufs->bus_l;
  lp->bus_r = bufs->bus_r;

  lp->gain_db = 0.0;
  lp->gain = 1.0;
  lp->muted = 0;
  lp->meter_l = 0.0;
  lp->meter_r = 0.0;

  lp->undo_l = bufs->undo_l;
  lp->undo_r = bufs->undo_r;
  lp->undo_track = -1;
  lp->undo_frames = 0;
  lp->undo_mode = BK_UNDO_NONE;
  lp->undo_applied = 0;
  lp->undo_armed = 0;
  lp->undo_armed_ever = 0;
  return 0;
}

/* --- control ------------------------------------------------------------ */

bk_loop_track *bk_looper_track(bk_looper *lp, int index) {
  /* The JS's `i | 0` is a no-op on an int, and the caller has already done the
     truncation by having an int to pass. */
  return index >= 0 && index < lp->track_count ? &lp->tracks[index] : NULL;
}

int bk_looper_track_count(const bk_looper *lp) { return lp->track_count; }

int bk_loop_track_recording(const bk_loop_track *t) {
  return t->state == BK_LOOP_REC || t->state == BK_LOOP_OVERDUB;
}

int bk_loop_track_playing(const bk_loop_track *t) {
  return t->state == BK_LOOP_PLAY || t->state == BK_LOOP_OVERDUB;
}

int bk_loop_track_audible(const bk_loop_track *t) {
  return bk_loop_track_playing(t) || !bk_smoother_settled(&t->play_gain) ||
         t->play_gain.value > 1e-4;
}

int bk_looper_active(const bk_looper *lp) {
  int i;
  for (i = 0; i < lp->track_count; i++) {
    const bk_loop_track *t = &lp->tracks[i];
    if (t->state == BK_LOOP_REC || t->state == BK_LOOP_OVERDUB) return 1;
    if (t->pending != BK_LOOP_PEND_NONE) return 1;
    if (bk_loop_track_audible(t)) return 1;
  }
  return 0;
}

bk_chain *bk_looper_chain_for(bk_looper *lp, int index) {
  bk_loop_track *t = bk_looper_track(lp, index);
  if (!t) return NULL;
  t->chain_used = 1;
  return &t->chain;
}

/*
 * The JS's _ensureBuffer / _ensureUndo. Under route (c) the storage is already
 * there, so all these do is record that the host would have allocated by now —
 * see looper.h note 1. They are kept as functions, at the same call sites, so
 * the control flow stays line-for-line comparable with the reference.
 */
static void ensure_buffer(bk_loop_track *t) { t->buf_armed = 1; }
static void ensure_undo(bk_looper *lp) { lp->undo_armed_ever = 1; }

static void drop_undo(bk_looper *lp) {
  lp->undo_track = -1;
  lp->undo_frames = 0;
  lp->undo_mode = BK_UNDO_NONE;
  lp->undo_applied = 0;
  lp->undo_armed = 0;
}

/*
 * Schedule an action, or run it now. A tempo-locked track with a live grid
 * waits for the next grid line; everything else punches immediately. Asking for
 * the action that is already pending cancels it, which is what every looper's
 * second press does.
 */
static void schedule(bk_looper *lp, bk_loop_track *t, int action, bk_clock *clock) {
  int quantised;

  if (t->pending == action) {
    t->pending = BK_LOOP_PEND_NONE;
    return;
  }
  quantised = t->sync && clock && clock->running && clock->grid_frames > 0.0;
  if (!quantised) {
    t->pending = BK_LOOP_PEND_NONE;
    apply_action(lp, t, action, clock, clock ? clock->frame : 0.0);
    return;
  }
  t->pending = action;
  t->pending_at = clock->frame + bk_clock_frames_to_grid(clock, clock->frame);
}

void bk_looper_record_toggle(bk_looper *lp, int index, bk_clock *clock) {
  bk_loop_track *t = bk_looper_track(lp, index);
  if (!t) return;
  ensure_buffer(t);
  if (t->frames > 0) ensure_undo(lp);
  schedule(lp, t, BK_LOOP_PEND_REC, clock);
}

void bk_looper_play_toggle(bk_looper *lp, int index, bk_clock *clock) {
  bk_loop_track *t = bk_looper_track(lp, index);
  if (!t || t->state == BK_LOOP_EMPTY) return;
  schedule(lp, t, bk_loop_track_playing(t) ? BK_LOOP_PEND_STOP : BK_LOOP_PEND_PLAY, clock);
}

void bk_looper_stop(bk_looper *lp, int index, bk_clock *clock) {
  bk_loop_track *t = bk_looper_track(lp, index);
  if (!t || t->state == BK_LOOP_EMPTY) return;
  schedule(lp, t, BK_LOOP_PEND_STOP, clock);
}

void bk_looper_clear(bk_looper *lp, int index) {
  bk_loop_track *t = bk_looper_track(lp, index);
  if (!t) return;
  t->state = BK_LOOP_EMPTY;
  t->pending = BK_LOOP_PEND_NONE;
  t->frames = 0;
  t->rec_write = 0;
  t->pos = 0;
  t->pos_norm = 0.0;
  t->layers = 0;
  t->last_write = -1;
  t->rec_ramp = 0;
  t->meter = 0.0;
  bk_smoother_reset(&t->play_gain, 0.0);
  /* Note what clear does NOT do: it does not zero the audio. The buffer is
     reused from index 0 by the next take, and _closeTake zeroes any tail it
     rounds up past — which is the only way stale audio could be read back. */
  bk_chain_panic(&t->chain);
  if (lp->undo_track == t->index) drop_undo(lp);
}

void bk_looper_clear_all(bk_looper *lp) {
  int i;
  for (i = 0; i < lp->track_count; i++) bk_looper_clear(lp, i);
}

void bk_looper_undo(bk_looper *lp, int index) {
  bk_loop_track *t = bk_looper_track(lp, index);
  int n, i;
  float *u_l, *u_r, *b_l, *b_r;

  if (!t || lp->undo_track != t->index || lp->undo_mode == BK_UNDO_NONE) return;
  if (lp->undo_armed) return; /* mid-overdub: nothing committed to undo yet */

  if (lp->undo_mode == BK_UNDO_TAKE) {
    /* The first take. Undo drops the length; the audio is untouched, so redo
       is free. Note that neither branch touches pos or rec_write — the JS
       does not either, and a redone take picks its position back up from the
       clock anchor. */
    if (lp->undo_applied) {
      t->frames = 0;
      t->state = BK_LOOP_EMPTY;
      t->layers = 0;
      bk_smoother_set(&t->play_gain, 0.0);
      lp->undo_applied = 0;
    } else {
      t->frames = lp->undo_frames;
      t->state = BK_LOOP_STOPPED;
      t->layers = 1;
      lp->undo_applied = 1;
    }
    return;
  }

  n = (int)bk_min((double)lp->undo_frames, (double)t->frames);
  if (!lp->undo_l || !t->buf_l || n <= 0) return;
  u_l = lp->undo_l;
  u_r = lp->undo_r;
  b_l = t->buf_l;
  b_r = t->buf_r;
  if (lp->undo_applied) {
    for (i = 0; i < n; i++) {
      /* One rounding, not two: the JS is `bL[i] -= uL[i]` on two
         Float32Arrays, so both widen, the difference is exact in double, and
         the result is rounded once on the way back in. */
      b_l[i] = (float)((double)b_l[i] - (double)u_l[i]);
      b_r[i] = (float)((double)b_r[i] - (double)u_r[i]);
    }
    t->layers = (int)bk_max(1.0, (double)(t->layers - 1));
    lp->undo_applied = 0;
  } else {
    for (i = 0; i < n; i++) {
      b_l[i] = (float)((double)b_l[i] + (double)u_l[i]);
      b_r[i] = (float)((double)b_r[i] + (double)u_r[i]);
    }
    t->layers = t->layers + 1;
    lp->undo_applied = 1;
  }
}

int bk_looper_can_undo(const bk_looper *lp, int index) {
  /* Deliberately NOT gated on the index being in range, exactly like the JS:
     it compares against undoTrack, which is only ever a valid index or -1, so
     an out-of-range index can only fail to match. */
  return lp->undo_track == index && lp->undo_mode != BK_UNDO_NONE && !lp->undo_armed;
}

void bk_looper_set_track_param(bk_looper *lp, int index, int key, double value) {
  bk_loop_track *t = bk_looper_track(lp, index);
  if (!t) return;
  switch (key) {
    case BK_LOOP_P_GAIN:
      t->gain_db = bk_clamp(value, -60.0, 12.0);
      /* The explicit zero at the bottom of the range is the JS's, and it is
         not the same as dbToGain(-60) (which is 0.001): -60 means off. */
      t->gain = t->gain_db <= -60.0 ? 0.0 : bk_db_to_gain(t->gain_db);
      break;
    case BK_LOOP_P_MUTE:
      t->muted = value >= 0.5;
      break;
    case BK_LOOP_P_SOLO:
      t->soloed = value >= 0.5;
      break;
    case BK_LOOP_P_PAN:
      /* A BALANCE law, not the constant-power pan the drum pads use, and
         deliberately so. A pad is a mono voice, where constant power (0.707 a
         side at centre) is right. A loop track is a STEREO recording of the
         bus, and two things follow: a centred loop has to play back at exactly
         the level it was recorded, or an overdub would not match the live
         signal it is layered against; and there is no single position to place
         — L and R already hold their own material, so the control can only
         trim the opposite side. Unity at centre, linear taper out. */
      t->pan = bk_clamp(value, -1.0, 1.0);
      t->pan_l = t->pan <= 0.0 ? 1.0 : 1.0 - t->pan;
      t->pan_r = t->pan >= 0.0 ? 1.0 : 1.0 + t->pan;
      break;
    case BK_LOOP_P_SYNC: {
      const int on = value >= 0.5;
      if (on != t->sync) {
        t->sync = on;
        /* Switching a playing track between modes: hand the position over
           rather than jumping. Free mode adopts where the clock-derived
           position currently is, and tempo-locked mode re-anchors so position
           0 stays where the counter is. */
        t->pos = t->frames > 0 ? t->pos % t->frames : 0;
      }
      break;
    }
    case BK_LOOP_P_SOURCE:
    {
      /* clamp(Math.round(NaN), 0, 1) is NaN in the JS, and (int)NaN is UB in
         C (INT_MIN on x86, 0 on wasm). NaN compares unequal to DRUMS in the
         render's only test of this field, so the JS treats it as MASTER, and
         that is what it is stored as here. */
      const double s = bk_clamp(js_round(value), 0.0, 1.0);
      t->source = s == s ? (int)s : BK_LOOP_SRC_MASTER;
    }
      break;
    default:
      /* No default in the JS switch, so an unknown key changes nothing. */
      break;
  }
}

void bk_looper_set_param(bk_looper *lp, int key, double value) {
  switch (key) {
    case BK_LOOPER_P_GAIN:
      lp->gain_db = bk_clamp(value, -60.0, 12.0);
      lp->gain = lp->gain_db <= -60.0 ? 0.0 : bk_db_to_gain(lp->gain_db);
      break;
    case BK_LOOPER_P_MUTE:
      lp->muted = value >= 0.5;
      break;
    default:
      break;
  }
}

void bk_looper_reset(bk_looper *lp) {
  int i;
  for (i = 0; i < lp->track_count; i++) {
    bk_loop_track *t = &lp->tracks[i];
    t->pending = BK_LOOP_PEND_NONE;
    if (t->state == BK_LOOP_REC) {
      /* A take interrupted by a panic is not a loop; drop it rather than
         keeping a half-recorded fragment nobody asked for. */
      bk_looper_clear(lp, i);
      continue;
    }
    if (t->state != BK_LOOP_EMPTY) t->state = BK_LOOP_STOPPED;
    bk_smoother_reset(&t->play_gain, 0.0);
    t->rec_ramp = 0;
    t->meter = 0.0;
    bk_chain_panic(&t->chain);
  }
  lp->undo_armed = 0;
  lp->meter_l = 0.0;
  lp->meter_r = 0.0;
}

/* --- state transitions -------------------------------------------------- */

/* Start the first take. Loop position 0 is here. */
static void begin_take(bk_loop_track *t, double frame) {
  ensure_buffer(t);
  t->state = BK_LOOP_REC;
  t->rec_write = 0;
  t->pos = 0;
  t->anchor = frame;
  t->layers = 0;
  t->rec_ramp = 0;
  t->last_write = -1;
  bk_smoother_reset(&t->play_gain, 0.0);
}

/*
 * Close the first take: decide the loop length, then play (or stop, if that is
 * what was asked for). A tempo-locked take is rounded to the nearest whole grid
 * unit, which is what lets a human punch out roughly on the beat and still get
 * a loop that locks.
 */
static void close_take(bk_looper *lp, bk_loop_track *t, bk_clock *clock, int then_stop) {
  double len;
  double g;
  int i, ilen;

  declick_out(lp, t);
  len = (double)t->rec_write;
  g = (t->sync && clock && clock->grid_frames > 0.0) ? clock->grid_frames : 0.0;
  if (g > 0.0) {
    len = bk_max(g, js_round(len / g) * g);
    if (len > (double)t->max_frames) len = bk_max(g, floor((double)t->max_frames / g) * g);
  }
  if (len < (double)MIN_LOOP_FRAMES || t->rec_write < MIN_LOOP_FRAMES) {
    /* Too short to be a loop — a stray double-click, not a performance. */
    bk_looper_clear(lp, t->index);
    return;
  }
  if (len > (double)t->max_frames) len = (double)t->max_frames;
  ilen = (int)len;
  /* Rounding UP past what was actually played leaves a tail that was never
     written. Zero it, or the previous take's audio reappears in the gap. */
  if (ilen > t->rec_write && t->buf_l) {
    for (i = t->rec_write; i < ilen; i++) {
      t->buf_l[i] = 0.0f;
      t->buf_r[i] = 0.0f;
    }
  }
  t->frames = ilen;
  t->layers = 1;
  t->rec_ramp = 0;
  /* The take is the undo slot's contents now: undoing it drops the length. */
  lp->undo_track = t->index;
  lp->undo_frames = ilen;
  lp->undo_mode = BK_UNDO_TAKE;
  lp->undo_applied = 1;
  lp->undo_armed = 0;
  if (then_stop) {
    t->state = BK_LOOP_STOPPED;
    bk_smoother_set(&t->play_gain, 0.0);
    return;
  }
  t->state = BK_LOOP_PLAY;
  bk_smoother_set(&t->play_gain, 1.0);
}

/* Start overdubbing onto an existing loop, capturing the new layer for undo. */
static void begin_overdub(bk_looper *lp, bk_loop_track *t) {
  int n, i;

  if (!t->buf_l || t->frames <= 0) return;
  ensure_undo(lp);
  /* Only the loop's own length is cleared, not the whole 30-second slot: at a
     typical 2-8 second loop that is a fraction of a millisecond of memset. */
  n = (int)bk_min((double)t->frames, (double)lp->max_frames);
  if (lp->undo_l) {
    for (i = 0; i < n; i++) {
      lp->undo_l[i] = 0.0f;
      lp->undo_r[i] = 0.0f;
    }
  }
  lp->undo_track = t->index;
  lp->undo_frames = n;
  lp->undo_mode = BK_UNDO_LAYER;
  lp->undo_applied = 1;
  lp->undo_armed = 1;
  t->state = BK_LOOP_OVERDUB;
  t->rec_ramp = 0;
  t->last_write = -1;
  if (!t->sync) t->pos = t->pos % t->frames;
  bk_smoother_set(&t->play_gain, 1.0);
}

static void end_overdub(bk_looper *lp, bk_loop_track *t) {
  declick_out(lp, t);
  t->state = BK_LOOP_PLAY;
  t->layers = t->layers + 1;
  t->rec_ramp = 0;
  lp->undo_armed = 0;
  bk_smoother_set(&t->play_gain, 1.0);
}

static void begin_play(bk_loop_track *t) {
  if (t->frames <= 0) return;
  t->state = BK_LOOP_PLAY;
  /* A free-running track has no grid to align to, so it restarts from the top;
     a tempo-locked one keeps its anchor and comes back in phase with
     everything else. */
  if (!t->sync) t->pos = 0;
  bk_smoother_set(&t->play_gain, 1.0);
}

/*
 * Apply one action at an exact frame. Called either from a control command
 * (immediate) or from inside the render loop at the scheduled sample.
 */
static void apply_action(bk_looper *lp, bk_loop_track *t, int action, bk_clock *clock,
                         double frame) {
  if (action == BK_LOOP_PEND_REC) {
    if (t->state == BK_LOOP_REC) {
      close_take(lp, t, clock, 0);
    } else if (t->state == BK_LOOP_OVERDUB) {
      end_overdub(lp, t);
    } else if (t->frames > 0) {
      begin_overdub(lp, t);
    } else {
      begin_take(t, frame);
    }
    return;
  }
  if (action == BK_LOOP_PEND_PLAY) {
    if (t->state == BK_LOOP_REC) {
      close_take(lp, t, clock, 0);
    } else if (t->frames > 0) {
      begin_play(t);
    }
    return;
  }
  if (action == BK_LOOP_PEND_STOP) {
    if (t->state == BK_LOOP_REC) {
      close_take(lp, t, clock, 1);
    } else if (t->state == BK_LOOP_OVERDUB) {
      end_overdub(lp, t);
      t->state = BK_LOOP_STOPPED;
      bk_smoother_set(&t->play_gain, 0.0);
    } else if (t->state == BK_LOOP_PLAY) {
      t->state = BK_LOOP_STOPPED;
      bk_smoother_set(&t->play_gain, 0.0);
    }
  }
}

/*
 * Fade the tail of what was just recorded, so the punch-out does not leave a
 * step in the buffer. During an overdub the ramp is applied to the new layer
 * only — the undo slot holds exactly that layer, which is what makes it
 * possible to fade it without touching the material underneath.
 */
static void declick_out(bk_looper *lp, bk_loop_track *t) {
  const int d = lp->declick;
  int n, k;

  if (!t->buf_l) return;
  if (t->state == BK_LOOP_REC) {
    const int last = t->rec_write - 1;
    n = (int)bk_min((double)d, (double)t->rec_write);
    for (k = 0; k < n; k++) {
      const int idx = last - k;
      double f;
      if (idx < 0) break;
      f = (double)k / (double)n;
      t->buf_l[idx] = (float)((double)t->buf_l[idx] * f);
      t->buf_r[idx] = (float)((double)t->buf_r[idx] * f);
    }
    return;
  }
  if (t->state == BK_LOOP_OVERDUB && t->last_write >= 0 && t->frames > 0 && lp->undo_l) {
    const int len = t->frames;
    n = (int)bk_min((double)d, (double)len);
    for (k = 0; k < n; k++) {
      int idx = t->last_write - k;
      double f, dl, dr;
      while (idx < 0) idx += len;
      f = (double)k / (double)n;
      /* Scale the layer down to `f` by removing the part we no longer want.
         Both deltas are read from the undo slot BEFORE either store, which is
         the order the JS has and matters because the slot is written too. */
      dl = (double)lp->undo_l[idx] * (1.0 - f);
      dr = (double)lp->undo_r[idx] * (1.0 - f);
      t->buf_l[idx] = (float)((double)t->buf_l[idx] - dl);
      t->buf_r[idx] = (float)((double)t->buf_r[idx] - dr);
      lp->undo_l[idx] = (float)((double)lp->undo_l[idx] - dl);
      lp->undo_r[idx] = (float)((double)lp->undo_r[idx] - dr);
    }
  }
}

/* --- meters ------------------------------------------------------------- */

int bk_looper_read_meters(const bk_looper *lp, double *out, int offset) {
  int i;
  for (i = 0; i < lp->track_count; i++) {
    const bk_loop_track *t = &lp->tracks[i];
    const int o = offset + i * BK_LOOP_METER_STRIDE;
    out[o] = (double)t->state;
    out[o + 1] = (double)t->pending;
    out[o + 2] = t->meter;
    out[o + 3] = t->pos_norm;
    out[o + 4] = (double)(t->state == BK_LOOP_REC ? t->rec_write : t->frames);
    /* `t.chain ? t.chain.length : 0` in the JS. A live-but-empty chain reports
       0, which is the same answer a null one gave — see looper.h note 2. */
    out[o + 5] = (double)bk_chain_length(&t->chain);
    out[o + 6] = (double)t->layers;
    out[o + 7] = bk_looper_can_undo(lp, i) ? 1.0 : 0.0;
  }
  return lp->track_count * BK_LOOP_METER_STRIDE;
}

/* --- audio -------------------------------------------------------------- */

void bk_looper_process(bk_looper *lp, const bk_loop_src *src, float *l, float *r, size_t frames,
                       bk_clock *clock) {
  static const bk_loop_src null_src = {NULL, NULL, NULL, NULL};
  const double clock_frame = clock ? clock->frame : 0.0;
  const bk_loop_src *sources = src ? src : &null_src;
  const int n = (int)frames;
  float *bus_l = lp->bus_l;
  float *bus_r = lp->bus_r;
  int any_solo = 0;
  int sounded = 0;
  double pk_l, pk_r, g;
  int ti, i;

  for (i = 0; i < lp->track_count; i++) {
    if (lp->tracks[i].soloed && lp->tracks[i].state != BK_LOOP_EMPTY) any_solo = 1;
  }

  for (i = 0; i < n; i++) {
    bus_l[i] = 0.0f;
    bus_r[i] = 0.0f;
  }

  for (ti = 0; ti < lp->track_count; ti++) {
    bk_loop_track *t = &lp->tracks[ti];
    int want_gain;
    int idle;

    /* Skip a track that has nothing to do: empty, or stopped with its fade
       finished. A track that is merely muted is still rendered — it costs
       little, and its position has to keep moving or the UI playhead freezes
       on a loop that is still very much in time and one click from being
       heard again. */
    idle = t->pending == BK_LOOP_PEND_NONE && !bk_loop_track_recording(t) &&
           !bk_loop_track_playing(t) && bk_smoother_settled(&t->play_gain) &&
           t->play_gain.value <= 1e-4;
    if (idle) {
      t->meter = 0.0;
      t->pos_norm = 0.0;
      continue;
    }

    /* Target level for this block: silence unless it is playing, unmuted, and
       either soloed or nothing else is. */
    want_gain = bk_loop_track_playing(t) && !t->muted && (!any_solo || t->soloed) ? 1 : 0;
    bk_smoother_set(&t->play_gain, (double)want_gain);

    if (bk_chain_length(&t->chain) > 0) {
      float *trk_l = lp->trk_l;
      float *trk_r = lp->trk_r;
      /* render_track is additive, so its scratch has to be cleared first. An
         empty chain takes the other branch instead, which is what makes a
         never-asked-for chain and an asked-for-but-empty one identical. */
      for (i = 0; i < n; i++) {
        trk_l[i] = 0.0f;
        trk_r[i] = 0.0f;
      }
      render_track(lp, t, sources, trk_l, trk_r, n, clock, clock_frame);
      bk_chain_process(&t->chain, trk_l, trk_r, n);
      for (i = 0; i < n; i++) {
        /* Spelled out in double and rounded once, as everywhere else in the
           port: the JS is `busL[i] += trkL[i]` on two Float32Arrays, which is
           one rounding of the exact sum. */
        bus_l[i] = (float)((double)bus_l[i] + (double)trk_l[i]);
        bus_r[i] = (float)((double)bus_r[i] + (double)trk_r[i]);
      }
    } else {
      render_track(lp, t, sources, bus_l, bus_r, n, clock, clock_frame);
    }
    sounded = 1;
  }

  if (!sounded || lp->muted) {
    /* Note the ordering the JS has and this keeps: a MUTED looper still runs
       every track above — positions advance, smoothers move, a take keeps
       recording — and only the sum into the output is skipped. That is the
       opposite of the drum rack, which returns before running its pads, and
       it is correct here: muting the looper must not stop a recording. */
    lp->meter_l = 0.0;
    lp->meter_r = 0.0;
    return;
  }

  pk_l = 0.0;
  pk_r = 0.0;
  g = lp->gain;
  for (i = 0; i < n; i++) {
    const double sl = bk_sanitize((double)bus_l[i] * g);
    const double sr = bk_sanitize((double)bus_r[i] * g);
    const double al = sl < 0.0 ? -sl : sl;
    const double ar = sr < 0.0 ? -sr : sr;
    if (al > pk_l) pk_l = al;
    if (ar > pk_r) pk_r = ar;
    /* One rounding, not two — same rule as the bus sum above. */
    l[i] = (float)((double)l[i] + sl);
    r[i] = (float)((double)r[i] + sr);
  }
  lp->meter_l = pk_l;
  lp->meter_r = pk_r;
}

/*
 * One track, rendered additively into dst. Playback, recording, overdubbing and
 * sample-accurate punches all happen in this single pass — they have to,
 * because a punch can change the state half way through a block and everything
 * downstream of it (whether to read, where to write) depends on the new state.
 */
static void render_track(bk_looper *lp, bk_loop_track *t, const bk_loop_src *src, float *dst_l,
                         float *dst_r, int frames, bk_clock *clock, double clock_frame) {
  const float *rec_l = t->source == BK_LOOP_SRC_DRUMS ? src->drum_l : src->master_l;
  const float *rec_r = t->source == BK_LOOP_SRC_DRUMS ? src->drum_r : src->master_r;
  const int d = lp->declick;
  /* These four are re-read after a punch fires: an action applied mid-block
     can arm the undo slot (and in the JS could allocate the track buffer), and
     a stale copy would lose the first partial block of an overdub's undo
     residue. */
  float *buf_l = t->buf_l;
  float *buf_r = t->buf_r;
  int undo_on = lp->undo_armed && lp->undo_track == t->index && lp->undo_mode == BK_UNDO_LAYER;
  float *u_l = lp->undo_l;
  float *u_r = lp->undo_r;
  double pk = 0.0;
  int last_pos = -1;
  int i;

  for (i = 0; i < frames; i++) {
    const double frame = clock_frame + (double)i;
    int len, st, playing, pos;
    double pg;

    if (t->pending != BK_LOOP_PEND_NONE && frame >= t->pending_at) {
      const int action = t->pending;
      t->pending = BK_LOOP_PEND_NONE;
      apply_action(lp, t, action, clock, frame);
      buf_l = t->buf_l;
      buf_r = t->buf_r;
      u_l = lp->undo_l;
      u_r = lp->undo_r;
      undo_on = lp->undo_armed && lp->undo_track == t->index && lp->undo_mode == BK_UNDO_LAYER;
    }

    len = t->frames;
    st = t->state;
    playing = st == BK_LOOP_PLAY || st == BK_LOOP_OVERDUB;

    /* ---- position ---------------------------------------------------- */
    pos = -1;
    if (len > 0 && buf_l) {
      if (t->sync) {
        /* fmod, not %: `frame` and `anchor` are absolute and can exceed any
           int range. Exact for integral doubles under 2^53, and the JS's `%`
           is the same truncating remainder. */
        double rel = fmod(frame - t->anchor, (double)len);
        if (rel < 0.0) rel += (double)len;
        pos = (int)rel;
      } else {
        pos = t->pos;
        if (pos >= len) pos = 0;
      }
    }

    /* ---- playback ---------------------------------------------------- */
    pg = bk_smoother_next(&t->play_gain);
    if (pos >= 0 && pg > 1e-5) {
      const double sl = (double)buf_l[pos] * pg * t->gain;
      const double sr = (double)buf_r[pos] * pg * t->gain;
      const double a = sl < 0.0 ? -sl : sl;
      dst_l[i] = (float)((double)dst_l[i] + sl * t->pan_l);
      dst_r[i] = (float)((double)dst_r[i] + sr * t->pan_r);
      /* Left only, as in the JS. The track meter is a presence indicator for
         the UI, not a stereo bus meter. */
      if (a > pk) pk = a;
    }

    /* ---- recording --------------------------------------------------- */
    if (st == BK_LOOP_REC && buf_l) {
      const int w = t->rec_write;
      if (w < t->max_frames) {
        const double rg = t->rec_ramp < d ? (double)t->rec_ramp / (double)d : 1.0;
        double a;
        t->rec_ramp++;
        buf_l[w] = (float)((rec_l ? (double)rec_l[i] : 0.0) * rg);
        buf_r[w] = (float)((rec_r ? (double)rec_r[i] : 0.0) * rg);
        t->rec_write = w + 1;
        t->last_write = w;
        /* The peak reads the value BACK out of the buffer, so it is the
           float-rounded one. The JS does the same, and it is not the same
           number as the double that was stored. */
        a = buf_l[w] < 0.0f ? -(double)buf_l[w] : (double)buf_l[w];
        if (a > pk) pk = a;
      } else {
        /* The buffer is full. Closing the loop is the only honest option:
           silently dropping the rest of a take, or stopping without a loop,
           both look broken. */
        close_take(lp, t, clock, 0);
      }
    } else if (st == BK_LOOP_OVERDUB && pos >= 0 && buf_l) {
      const double rg = t->rec_ramp < d ? (double)t->rec_ramp / (double)d : 1.0;
      const double x = (rec_l ? (double)rec_l[i] : 0.0) * rg;
      const double y = (rec_r ? (double)rec_r[i] : 0.0) * rg;
      const double a = x < 0.0 ? -x : x;
      t->rec_ramp++;
      buf_l[pos] = (float)((double)buf_l[pos] + x);
      buf_r[pos] = (float)((double)buf_r[pos] + y);
      if (undo_on && u_l) {
        u_l[pos] = (float)((double)u_l[pos] + x);
        u_r[pos] = (float)((double)u_r[pos] + y);
      }
      t->last_write = pos;
      /* The overdub peak is the INPUT, not the buffer read back — the JS
         meters `x`. A loud overdub onto a loud loop meters the overdub. */
      if (a > pk) pk = a;
    }

    /* ---- free-running position advance ------------------------------- */
    if (!t->sync && len > 0 && pos >= 0 && (playing || pg > 1e-5)) {
      int p = pos + 1;
      if (p >= len) p = 0;
      t->pos = p;
    }
    if (pos >= 0) last_pos = pos;
  }

  t->meter = pk;
  if (t->state == BK_LOOP_REC) {
    t->pos_norm = t->max_frames > 0 ? (double)t->rec_write / (double)t->max_frames : 0.0;
  } else if (t->frames > 0 && last_pos >= 0) {
    t->pos_norm = (double)last_pos / (double)t->frames;
  } else {
    t->pos_norm = 0.0;
  }
}
