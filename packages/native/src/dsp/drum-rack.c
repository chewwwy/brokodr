/*
 * Bro.Kodr DSP core — BROBEATS drum rack. C port of dsp/core/drum-rack.js.
 * Read drum-rack.h first: it carries the three forced divergences and, in
 * particular, why the per-pad chains are not lazily created here.
 */

#include "brokodr/dsp/drum-rack.h"

#include <math.h>

/* Math.round, which is floor(x + 0.5) and NOT C's round() — the two disagree
   on negative halves (JS gives -0 for -0.5, round() gives -1). Same helper as
   drum-voice.c, kept local for the same reason: it is two tokens and sharing
   it would put a JS-semantics shim in the public header. */
static double js_round(double x) { return floor(x + 0.5); }

int bk_drum_rack_init(bk_drum_rack *rk, double sample_rate, int max_block, float *pad_l,
                      float *pad_r, float *bus_l, float *bus_r, float *chain_wet_l,
                      float *chain_wet_r) {
  int i;

  if (!rk || !(sample_rate > 0.0) || max_block <= 0) return -1;
  if (!pad_l || !pad_r || !bus_l || !bus_r || !chain_wet_l || !chain_wet_r) return -1;

  rk->sr = sample_rate;
  rk->max_block = max_block;
  rk->pad_l = pad_l;
  rk->pad_r = pad_r;
  rk->bus_l = bus_l;
  rk->bus_r = bus_r;

  for (i = 0; i < BK_PAD_COUNT; i++) {
    bk_drum_voice_init(&rk->pads[i], sample_rate, max_block);
    /* All sixteen share one wet pair. See bk_drum_rack_init's contract in the
       header: a chain writes its scratch before reading it and keeps no state
       in it between calls, and the render loop walks pads one at a time. */
    if (bk_chain_init(&rk->pad_chains[i], sample_rate, max_block, 0, chain_wet_l, chain_wet_r) !=
        0) {
      return -1;
    }
    rk->chain_used[i] = 0;
    rk->pad_meters[i] = 0.0f;
    rk->trigger_flags[i] = 0;
  }

  rk->gain = 1.0;
  rk->muted = 0;
  rk->solo = -1;
  rk->meter_l = 0.0;
  rk->meter_r = 0.0;

  /* ~90 ms, floored at one whole block so that even a host running at the
     allocation ceiling sees the flag set for at least one poll. */
  rk->flash_frames = (int)bk_max((double)max_block, js_round((90.0 * sample_rate) / 1000.0));
  return 0;
}

/* --- control ------------------------------------------------------------ */

bk_drum_voice *bk_drum_rack_pad(bk_drum_rack *rk, int index) {
  /* The JS's `i | 0` is a no-op on an int, and the caller has already done the
     truncation by having an int to pass. */
  return index >= 0 && index < BK_PAD_COUNT ? &rk->pads[index] : NULL;
}

void bk_drum_rack_trigger(bk_drum_rack *rk, int index, double velocity) {
  bk_drum_voice *v = bk_drum_rack_pad(rk, index);
  int grp, i;

  if (!v) return;

  grp = v->choke_group;
  if (grp > 0) {
    for (i = 0; i < BK_PAD_COUNT; i++) {
      /* Note what is NOT choked: this pad itself (a closed hat retriggering
         does not choke its own tail — trigger() restarts the envelope in
         place, which is a different and audibly softer thing), and any pad in
         the group that is not currently sounding. */
      if (i != index && rk->pads[i].choke_group == grp && rk->pads[i].active) {
        bk_drum_voice_choke(&rk->pads[i]);
      }
    }
  }
  bk_drum_voice_trigger(v, velocity);
  rk->trigger_flags[index] = rk->flash_frames;
}

void bk_drum_rack_release(bk_drum_rack *rk, int index) {
  bk_drum_voice *v = bk_drum_rack_pad(rk, index);
  if (v) bk_drum_voice_release(v);
}

void bk_drum_rack_set_pad_param(bk_drum_rack *rk, int index, int key, double value) {
  bk_drum_voice *v = bk_drum_rack_pad(rk, index);
  if (v) bk_drum_voice_set_param(v, key, value);
}

void bk_drum_rack_set_pad_buffer(bk_drum_rack *rk, int index, int layer, const float *data,
                                 int frames, double src_rate) {
  bk_drum_voice *v = bk_drum_rack_pad(rk, index);
  if (v) bk_drum_voice_set_buffer(v, layer, data, frames, src_rate);
}

void bk_drum_rack_clear_pad(bk_drum_rack *rk, int index) {
  bk_drum_voice *v = bk_drum_rack_pad(rk, index);
  if (v) bk_drum_voice_clear_buffers(v);
  /* The JS reaches for `this.padChains[index | 0]` WITHOUT re-checking the
     index, and gets away with it because an out-of-range read is `undefined`
     and the `if (c)` swallows it. C has to bound-check to get the same
     outcome, so the same two-sided behaviour is spelled out: a bad index
     clears neither the layers nor the chain. */
  if (index >= 0 && index < BK_PAD_COUNT) bk_chain_clear(&rk->pad_chains[index]);
}

bk_chain *bk_drum_rack_chain_for(bk_drum_rack *rk, int index) {
  if (index < 0 || index >= BK_PAD_COUNT) return NULL;
  rk->chain_used[index] = 1;
  return &rk->pad_chains[index];
}

void bk_drum_rack_set_param(bk_drum_rack *rk, int key, double value) {
  switch (key) {
    case BK_DRUM_P_GAIN:
      rk->gain = bk_db_to_gain(bk_clamp(value, -60.0, 12.0));
      break;
    case BK_DRUM_P_MUTE:
      rk->muted = value >= 0.5;
      break;
    case BK_DRUM_P_SOLO:
      /* Any negative value means "no solo", not "clamp to pad -1": the host
         sends -1, and the clamp's own lower bound is therefore unreachable. */
      rk->solo = value < 0.0 ? -1 : (int)bk_clamp(js_round(value), -1.0, BK_PAD_COUNT - 1.0);
      break;
    default:
      /* No default in the JS switch, so an unknown key changes nothing. This
         is also the path BK_DRUM_P_ROUTE takes: engine.js owns "route" and the
         rack must not adopt it. See note 2 in the header. */
      break;
  }
}

void bk_drum_rack_reset(bk_drum_rack *rk) {
  int i;
  for (i = 0; i < BK_PAD_COUNT; i++) {
    bk_drum_voice_reset(&rk->pads[i]);
    bk_chain_panic(&rk->pad_chains[i]);
    rk->pad_meters[i] = 0.0f;
    rk->trigger_flags[i] = 0;
  }
  rk->meter_l = 0.0;
  rk->meter_r = 0.0;
}

int bk_drum_rack_sounding(const bk_drum_rack *rk) {
  int i;
  for (i = 0; i < BK_PAD_COUNT; i++) {
    if (rk->pads[i].active) return 1;
  }
  return 0;
}

/* --- audio -------------------------------------------------------------- */

void bk_drum_rack_process(bk_drum_rack *rk, float *l, float *r, size_t frames) {
  const int solo = rk->solo;
  const int n = (int)frames;
  float *pad_l = rk->pad_l;
  float *pad_r = rk->pad_r;
  float *bus_l = rk->bus_l;
  float *bus_r = rk->bus_r;
  int sounded = 0;
  double pk_l, pk_r, g;
  int p, i;

  if (rk->muted) {
    rk->meter_l = 0.0;
    rk->meter_r = 0.0;
    for (p = 0; p < BK_PAD_COUNT; p++) {
      rk->pad_meters[p] = 0.0f;
      /* The flash keeps counting down under a mute. It is a "this pad fired"
         light, not a "this pad is audible" one, and freezing it here would
         leave the grid lit from before the mute. */
      if (rk->trigger_flags[p] > 0) rk->trigger_flags[p] -= n;
    }
    /* Note what a muted rack does NOT do: it does not run the pads, so no
       envelope advances and no pan smoother moves. A note held through a mute
       comes back exactly where it was. That is the JS's behaviour, and it is
       the opposite of a muted *voice*, which keeps its smoothers moving. */
    return;
  }

  for (p = 0; p < BK_PAD_COUNT; p++) {
    if (rk->trigger_flags[p] > 0) rk->trigger_flags[p] -= n;
  }

  for (i = 0; i < n; i++) {
    bus_l[i] = 0.0f;
    bus_r[i] = 0.0f;
  }

  for (p = 0; p < BK_PAD_COUNT; p++) {
    bk_drum_voice *voice = &rk->pads[p];
    bk_chain *chain;

    if (solo >= 0 && p != solo) {
      /* Soloing cuts the others outright rather than ducking them: a soloed
         pad is a performance move, and a tail bleeding back in on un-solo
         sounds like a bug. reset() — not choke() — so there is no fade and
         nothing to hear on the next block either. */
      if (voice->active) bk_drum_voice_reset(voice);
      rk->pad_meters[p] = 0.0f;
      continue;
    }
    if (!voice->active) {
      rk->pad_meters[p] = 0.0f;
      continue;
    }

    chain = &rk->pad_chains[p];
    if (bk_chain_length(chain) > 0) {
      /* The voice renders additively, so its scratch has to be cleared first.
         An empty chain takes the other branch instead, which is what makes a
         never-asked-for chain and an asked-for-but-empty one identical. */
      for (i = 0; i < n; i++) {
        pad_l[i] = 0.0f;
        pad_r[i] = 0.0f;
      }
      bk_drum_voice_process(voice, pad_l, pad_r, frames);
      bk_chain_process(chain, pad_l, pad_r, n);
      for (i = 0; i < n; i++) {
        /* Spelled out in double and rounded once, as everywhere else in the
           port: the JS is `busL[i] += padL[i]` on two Float32Arrays, which is
           one rounding of the exact sum. Letting C add float to float would
           give the same answer on SSE but is at the mercy of
           FLT_EVAL_METHOD, and this is not the place to depend on that. */
        bus_l[i] = (float)((double)bus_l[i] + (double)pad_l[i]);
        bus_r[i] = (float)((double)bus_r[i] + (double)pad_r[i]);
      }
    } else {
      bk_drum_voice_process(voice, bus_l, bus_r, frames);
    }
    rk->pad_meters[p] = (float)voice->meter;
    sounded = 1;
  }

  if (!sounded) {
    /* Nothing rendered, so the bus holds silence and there is nothing to add.
       The early return matters: it skips the gain pass over a zeroed block,
       which is the common case on a rack sitting idle. */
    rk->meter_l = 0.0;
    rk->meter_r = 0.0;
    return;
  }

  /* Rack gain, sanitising and metering in one pass over the bus, then sum into
     the caller's buffer. */
  pk_l = 0.0;
  pk_r = 0.0;
  g = rk->gain;
  for (i = 0; i < n; i++) {
    const double sl = bk_sanitize((double)bus_l[i] * g);
    const double sr = bk_sanitize((double)bus_r[i] * g);
    const double al = sl < 0.0 ? -sl : sl;
    const double ar = sr < 0.0 ? -sr : sr;
    if (al > pk_l) pk_l = al;
    if (ar > pk_r) pk_r = ar;
    /* One rounding, not two. The JS is `L[i] += l` on a Float32Array with a
       double `l`: the stored float widens, the sum is exact in double, and the
       result is rounded once. Writing `l[i] += (float)sl` in C would round sl
       to float first and then round the sum again, and the two answers differ
       on values that sit near a float boundary. Same rule as the bus sum
       above and as drum-voice.c's own additive write. */
    l[i] = (float)((double)l[i] + sl);
    r[i] = (float)((double)r[i] + sr);
  }
  rk->meter_l = pk_l;
  rk->meter_r = pk_r;
}
