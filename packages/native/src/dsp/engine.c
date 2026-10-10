/*
 * Bro.Kodr DSP core — the engine. C99 port of dsp/engine.js. See engine.h.
 */

#include "brokodr/dsp/engine.h"

#include <math.h>

#include "brokodr/dsp/onset.h"

/* Math.round, as in character.c: the exact fraction decides, [-0.5, 0) gives
   -0, NaN stays NaN. */
static double js_round(double x) {
  const double r = floor(x);
  const double y = (x - r >= 0.5) ? r + 1.0 : r;
  return (y == 0.0 && x < 0.0) ? -0.0 : y;
}

/* `!!x` for a Number. */
static int js_truthy(double x) { return x != 0.0 && x == x; }

/* `x | 0`. */
static int to_i32(double x) { return bk_onset_to_int32(x); }

#define LOOPER_TRACK_BUFFERS (2 * BK_LOOP_TRACKS + 2)
#define BLOCK_BUFFERS 27

size_t bk_engine_storage_floats(double sample_rate, int max_block) {
  const size_t mb = max_block > 0 ? (size_t)max_block : 0;
  const size_t hist = (size_t)bk_smart_voice_hist_floats(sample_rate);
  const size_t lf = (size_t)bk_looper_max_frames(sample_rate, 0.0);
  return BLOCK_BUFFERS * mb + hist + LOOPER_TRACK_BUFFERS * lf;
}

int bk_engine_init(bk_engine *e, double sample_rate, int max_block, float *storage) {
  float *p = storage;
  size_t mb, lf;
  bk_looper_buffers lb;
  float *hist;
  int t;

  if (!e || !storage || max_block < 1) return -1;
  mb = (size_t)max_block;
  lf = (size_t)bk_looper_max_frames(sample_rate, 0.0);

  e->sr = sample_rate;
  e->max_block = max_block;

  e->dry_l = p, p += mb;
  e->dry_r = p, p += mb;
  e->cin_l = p, p += mb;
  e->cin_r = p, p += mb;

  /* File player + carrier bus, then the chain that receives the bus. */
  bk_file_player_init(&e->player, sample_rate, max_block);
  e->car_l = p, p += mb;
  e->car_r = p, p += mb;
  e->file_route = BK_FILE_ROUTE_INPUT;

  {
    float *wl = p, *wr;
    p += mb;
    wr = p, p += mb;
    if (bk_chain_init(&e->chain, sample_rate, max_block, BK_CHAIN_MAX_SLOTS, wl, wr) != 0) return -1;
    bk_chain_set_carrier_bus(&e->chain, e->car_l, e->car_r);
  }

  {
    float *pl = p, *pr, *bl, *br, *cl, *cr;
    p += mb;
    pr = p, p += mb;
    bl = p, p += mb;
    br = p, p += mb;
    cl = p, p += mb;
    cr = p, p += mb;
    if (bk_drum_rack_init(&e->drums, sample_rate, max_block, pl, pr, bl, br, cl, cr) != 0) return -1;
  }
  e->drum_l = p, p += mb;
  e->drum_r = p, p += mb;
  e->drum_route = BK_DRUM_ROUTE_DIRECT;

  bk_clock_init(&e->clock, sample_rate);

  lb.trk_l = p, p += mb;
  lb.trk_r = p, p += mb;
  lb.bus_l = p, p += mb;
  lb.bus_r = p, p += mb;
  lb.chain_wet_l = p, p += mb;
  lb.chain_wet_r = p, p += mb;

  e->tap_l = p, p += mb;
  e->tap_r = p, p += mb;
  e->loop_l = p, p += mb;
  e->loop_r = p, p += mb;
  e->voice_buf = p, p += mb;

  hist = p;
  p += (size_t)bk_smart_voice_hist_floats(sample_rate);

  for (t = 0; t < BK_LOOP_TRACKS; t++) {
    lb.track_l[t] = p, p += lf;
    lb.track_r[t] = p, p += lf;
  }
  lb.undo_l = p, p += lf;
  lb.undo_r = p, p += lf;
  if (bk_looper_init(&e->looper, sample_rate, max_block, 0, 0.0, &lb) != 0) return -1;

  bk_smart_voice_init(&e->voice, sample_rate, NULL, hist);

  bk_smoother_init(&e->in_gain, sample_rate, 20.0, 1.0);
  bk_smoother_init(&e->out_gain, sample_rate, 20.0, 1.0);
  bk_smoother_init(&e->master_mix, sample_rate, 25.0, 1.0);
  e->in_muted = 0;
  e->master_bypass = 0;
  e->mono_input = 0;
  e->input_swap = 0;

  e->meter_in_l = e->meter_in_r = e->meter_out_l = e->meter_out_r = 0.0;
  e->rms_in_l = e->rms_in_r = e->rms_out_l = e->rms_out_r = 0.0;
  e->clip_in = e->clip_out = e->peak_hold_in = e->peak_hold_out = 0.0;

  e->block_count = 0.0;
  e->cpu_load = 0.0;
  return 0;
}

/* ------------------------------------------------------------ chain verbs */

bk_chain *bk_engine_chain(bk_engine *e, int target, double index) {
  switch (target) {
    case BK_TARGET_MASTER: return &e->chain;
    case BK_TARGET_PAD: return bk_drum_rack_chain_for(&e->drums, to_i32(index));
    case BK_TARGET_LOOP: return bk_looper_chain_for(&e->looper, to_i32(index));
    default: return NULL;
  }
}

bk_slot *bk_engine_fx_add(bk_engine *e, int target, double index, const bk_slot_spec *spec) {
  bk_chain *c = bk_engine_chain(e, target, index);
  return c ? bk_chain_add(c, spec) : NULL;
}

void bk_engine_fx_remove(bk_engine *e, int target, double index, int id) {
  bk_chain *c = bk_engine_chain(e, target, index);
  if (c) bk_chain_remove(c, id);
}

void bk_engine_fx_move(bk_engine *e, int target, double index, int id, int at) {
  bk_chain *c = bk_engine_chain(e, target, index);
  if (c) bk_chain_move(c, id, at);
}

void bk_engine_fx_param(bk_engine *e, int target, double index, int id, int key, double value) {
  bk_chain *c = bk_engine_chain(e, target, index);
  const bk_slot *s;
  if (!c) return;
  s = bk_chain_find(c, id);
  bk_chain_set_param(c, id, key, value);
  /* chain.js: `if (key === "quality") this.recalcLatency()`. */
  if (s && key != BK_PARAM_NONE && key == bk_effect_quality_key(s->type)) bk_chain_recalc_latency(c);
}

void bk_engine_fx_mix(bk_engine *e, int target, double index, int id, double value) {
  bk_chain *c = bk_engine_chain(e, target, index);
  if (c) bk_chain_set_mix(c, id, value);
}

void bk_engine_fx_bypass(bk_engine *e, int target, double index, int id, double value) {
  bk_chain *c = bk_engine_chain(e, target, index);
  if (c) bk_chain_set_bypass(c, id, js_truthy(value));
}

void bk_engine_fx_reset(bk_engine *e, int target, double index, int id) {
  bk_chain *c = bk_engine_chain(e, target, index);
  if (c) bk_chain_reset_slot(c, id);
}

void bk_engine_fx_clear(bk_engine *e, int target, double index) {
  bk_chain *c = bk_engine_chain(e, target, index);
  if (c) bk_chain_clear(c);
}

/* ------------------------------------------------------------ other verbs */

void bk_engine_io(bk_engine *e, int field, double value) {
  switch (field) {
    case BK_IO_IN_GAIN: bk_smoother_set(&e->in_gain, bk_db_to_gain(value)); break;
    case BK_IO_OUT_GAIN: bk_smoother_set(&e->out_gain, bk_db_to_gain(value)); break;
    case BK_IO_MUTE: e->in_muted = js_truthy(value); break;
    case BK_IO_BYPASS: e->master_bypass = js_truthy(value); break;
    case BK_IO_MONO: e->mono_input = js_truthy(value); break;
    case BK_IO_SWAP: e->input_swap = js_truthy(value); break;
    case BK_IO_MASTER_MIX: bk_smoother_set(&e->master_mix, bk_clamp(value, 0.0, 1.0)); break;
    default: break;
  }
}

void bk_engine_file_load(bk_engine *e, const float *l, const float *r, int frames, double rate) {
  bk_file_player_set_buffer(&e->player, l, r, frames, rate);
}

void bk_engine_file_clear(bk_engine *e) { bk_file_player_clear_buffer(&e->player); }

void bk_engine_file_param(bk_engine *e, int key, double value) {
  bk_file_player_set_param(&e->player, key, value);
}

void bk_engine_file_route(bk_engine *e, double value) {
  e->file_route = bk_clamp(js_round(value), 0.0, 3.0);
}

void bk_engine_pad(bk_engine *e, double index, double velocity) {
  bk_drum_rack_trigger(&e->drums, to_i32(index), velocity);
}

void bk_engine_pad_off(bk_engine *e, double index) { bk_drum_rack_release(&e->drums, to_i32(index)); }

void bk_engine_pad_param(bk_engine *e, double index, int key, double value) {
  bk_drum_rack_set_pad_param(&e->drums, to_i32(index), key, value);
}

void bk_engine_pad_load(bk_engine *e, double index, double layer, const float *data, int frames,
                        double rate) {
  bk_drum_rack_set_pad_buffer(&e->drums, to_i32(index), to_i32(layer), data, frames, rate);
}

void bk_engine_pad_clear(bk_engine *e, double index) { bk_drum_rack_clear_pad(&e->drums, to_i32(index)); }

void bk_engine_drum(bk_engine *e, int key, double value) {
  if (key == BK_DRUM_P_ROUTE)
    e->drum_route = bk_clamp(js_round(value), 0.0, 2.0);
  else
    bk_drum_rack_set_param(&e->drums, key, value);
}

void bk_engine_drum_reset(bk_engine *e) { bk_drum_rack_reset(&e->drums); }

void bk_engine_loop(bk_engine *e, int op, double index) {
  const int i = to_i32(index);
  switch (op) {
    case BK_LOOPOP_REC: bk_looper_record_toggle(&e->looper, i, &e->clock); break;
    case BK_LOOPOP_PLAY: bk_looper_play_toggle(&e->looper, i, &e->clock); break;
    case BK_LOOPOP_STOP: bk_looper_stop(&e->looper, i, &e->clock); break;
    case BK_LOOPOP_CLEAR: bk_looper_clear(&e->looper, i); break;
    case BK_LOOPOP_CLEARALL: bk_looper_clear_all(&e->looper); break;
    case BK_LOOPOP_UNDO: bk_looper_undo(&e->looper, i); break;
    default: break;
  }
}

void bk_engine_loop_param(bk_engine *e, double index, int key, double value) {
  bk_looper_set_track_param(&e->looper, to_i32(index), key, value);
}

void bk_engine_looper_param(bk_engine *e, int key, double value) {
  bk_looper_set_param(&e->looper, key, value);
}

void bk_engine_voice(bk_engine *e, int key, double value) {
  bk_smart_voice_set_param(&e->voice, key, value);
}

void bk_engine_voicecal(bk_engine *e, int op, double cls, double arg, double value) {
  bk_smart_voice *v = &e->voice;
  switch (op) {
    case BK_VOICECAL_CENTROID:
      bk_smart_voice_set_centroid(v, (double)to_i32(cls), (double)to_i32(arg), value);
      break;
    case BK_VOICECAL_ATTACK:
      bk_smart_voice_set_attack_centroid(v, (double)to_i32(cls), (double)to_i32(arg), value);
      break;
    case BK_VOICECAL_PAD: bk_smart_voice_set_class_pad(v, (double)to_i32(cls), (double)to_i32(arg)); break;
    case BK_VOICECAL_CAPTURE: bk_smart_voice_set_capture(v, (double)to_i32(cls)); break;
    case BK_VOICECAL_CLEAR: bk_smart_voice_clear_captures(v); break;
    case BK_VOICECAL_RESET: bk_smart_voice_reset_centroids(v); break;
    case BK_VOICECAL_DETRESET: bk_smart_voice_reset_detector(v); break;
    default: break;
  }
}

void bk_engine_clock(bk_engine *e, int key, double value) { bk_clock_set_param(&e->clock, key, value); }

void bk_engine_clip_reset(bk_engine *e) {
  e->clip_in = 0.0;
  e->clip_out = 0.0;
  e->peak_hold_in = 0.0;
  e->peak_hold_out = 0.0;
}

void bk_engine_panic(bk_engine *e) {
  bk_chain_panic(&e->chain);
  bk_drum_rack_reset(&e->drums);
  bk_smart_voice_reset_detector(&e->voice);
  bk_looper_reset(&e->looper);
}

int bk_engine_recalc_latency(bk_engine *e) { return bk_chain_recalc_latency(&e->chain); }

int bk_engine_latency_samples(const bk_engine *e) { return e->chain.latency_samples; }

/* ----------------------------------------------------------------- meters */

void bk_engine_read_meters(const bk_engine *e, double *out) {
  const bk_file_player *pl = &e->player;
  int i, c, fired = 0;
  const int base = BK_ENGINE_CLOCK_METERS;
  const int vb = BK_ENGINE_VOICE_METERS;

  out[0] = e->meter_in_l;
  out[1] = e->meter_in_r;
  out[2] = e->meter_out_l;
  out[3] = e->meter_out_r;
  out[4] = e->rms_in_l;
  out[5] = e->rms_in_r;
  out[6] = e->rms_out_l;
  out[7] = e->rms_out_r;
  out[8] = e->clip_in;
  out[9] = e->clip_out;
  out[10] = e->cpu_load;
  out[11] = (double)e->chain.latency_samples;
  out[12] = (double)bk_chain_length(&e->chain);
  out[40] = pl->position;
  out[41] = pl->playing ? 1.0 : 0.0;
  out[42] = (double)pl->frames;
  out[43] = bk_file_player_loaded(pl) ? pl->src_rate : 0.0;
  out[44] = pl->meter;
  bk_chain_read_slot_meters(&e->chain, out, BK_ENGINE_SLOT_METERS);

  for (i = 0; i < BK_PAD_COUNT; i++) {
    out[BK_ENGINE_PAD_METERS + i] = (double)e->drums.pad_meters[i];
    if (e->drums.trigger_flags[i] > 0) fired |= 1 << i;
  }
  out[64] = e->drums.meter_l;
  out[65] = e->drums.meter_r;
  out[66] = (double)fired;
  out[67] = e->drum_route;

  bk_looper_read_meters(&e->looper, out, BK_ENGINE_LOOP_METERS);
  out[base] = e->clock.bpm;
  out[base + 1] = e->clock.beats_per_bar;
  out[base + 2] = e->clock.quantize;
  out[base + 3] = e->clock.running ? 1.0 : 0.0;
  out[base + 4] = bk_clock_bar_phase(&e->clock);
  out[base + 5] = floor(bk_clock_bar(&e->clock));
  out[base + 6] = e->looper.meter_l;
  out[base + 7] = e->looper.meter_r;

  bk_smart_voice_read_meters(&e->voice, out, vb);
  out[vb + BK_VOICE_METER_STRIDE] = (double)e->voice.last_band[0];
  out[vb + BK_VOICE_METER_STRIDE + 1] = (double)e->voice.last_band[1];
  out[vb + BK_VOICE_METER_STRIDE + 2] = (double)e->voice.last_band[2];
  for (c = 0; c < BK_VOICE_CLASS_COUNT; c++) {
    out[vb + BK_VOICE_METER_STRIDE + 3 + c] = (double)e->voice.class_pad[c];
  }
}

int bk_engine_read_voice_capture(const bk_engine *e, long long n, float *out) {
  return bk_smart_voice_read_capture(&e->voice, n, out);
}

/* ------------------------------------------------------------------ audio */

void bk_engine_process(bk_engine *e, const float *in_l, const float *in_r, float *out_l,
                       float *out_r, int frames) {
  float *dry_l = e->dry_l, *dry_r = e->dry_r;
  float *cin_l = e->cin_l, *cin_r = e->cin_r;
  float *car_l = e->car_l, *car_r = e->car_r;
  float *drum_l = e->drum_l, *drum_r = e->drum_r;
  double pk_in_l = 0.0, pk_in_r = 0.0, sq_in_l = 0.0, sq_in_r = 0.0;
  double pk_out_l = 0.0, pk_out_r = 0.0, sq_out_l = 0.0, sq_out_r = 0.0;
  const int muted = e->in_muted;
  const double route = e->file_route;
  const double drum_route = e->drum_route;
  int file_on = 0, file_to_input, drums_on, drums_to_input, drums_direct;
  int i;

  /* ---- file player -> carrier bus */
  if (route != BK_FILE_ROUTE_OFF && bk_file_player_loaded(&e->player)) {
    file_on = bk_file_player_process(&e->player, car_l, car_r, frames);
  } else {
    for (i = 0; i < frames; i++) {
      car_l[i] = 0.0f;
      car_r[i] = 0.0f;
    }
  }
  file_to_input = file_on && (route == BK_FILE_ROUTE_INPUT || route == BK_FILE_ROUTE_BOTH);

  /* ---- Smart Voice: raw input, pre-swap/mono/gain/mute */
  if (e->voice.enabled) {
    float *vb = e->voice_buf;
    int hits;
    for (i = 0; i < frames; i++) vb[i] = (float)bk_sanitize(((double)in_l[i] + (double)in_r[i]) * 0.5);
    hits = bk_smart_voice_process(&e->voice, vb, (size_t)frames);
    for (i = 0; i < hits; i++) {
      bk_drum_rack_trigger(&e->drums, e->voice.fire_pad[i], (double)e->voice.fire_vel[i]);
    }
  }

  /* ---- BROBEATS */
  drums_on = drum_route != BK_DRUM_ROUTE_OFF && bk_drum_rack_sounding(&e->drums);
  if (drums_on) {
    for (i = 0; i < frames; i++) {
      drum_l[i] = 0.0f;
      drum_r[i] = 0.0f;
    }
    bk_drum_rack_process(&e->drums, drum_l, drum_r, (size_t)frames);
  }
  drums_to_input = drums_on && drum_route == BK_DRUM_ROUTE_CHAIN;
  drums_direct = drums_on && drum_route == BK_DRUM_ROUTE_DIRECT;

  /* ---- input stage */
  for (i = 0; i < frames; i++) {
    const double g = bk_smoother_next(&e->in_gain);
    double l = (double)in_l[i];
    double r = (double)in_r[i];
    double al, ar;
    if (e->input_swap) {
      const double t = l;
      l = r;
      r = t;
    }
    if (e->mono_input) {
      const double m = (l + r) * 0.5;
      l = m;
      r = m;
    }
    l = muted ? 0.0 : bk_sanitize(l * g);
    r = muted ? 0.0 : bk_sanitize(r * g);
    if (file_to_input) {
      l = bk_sanitize(l + (double)car_l[i]);
      r = bk_sanitize(r + (double)car_r[i]);
    }
    if (drums_to_input) {
      l = bk_sanitize(l + (double)drum_l[i]);
      r = bk_sanitize(r + (double)drum_r[i]);
    }

    al = fabs(l);
    ar = fabs(r);
    if (al > pk_in_l) pk_in_l = al;
    if (ar > pk_in_r) pk_in_r = ar;
    sq_in_l += l * l;
    sq_in_r += r * r;

    cin_l[i] = (float)l;
    cin_r[i] = (float)r;
    dry_l[i] = (float)l;
    dry_r[i] = (float)r;
  }

  if (pk_in_l >= 0.999 || pk_in_r >= 0.999) e->clip_in = 1.0;
  e->meter_in_l = pk_in_l;
  e->meter_in_r = pk_in_r;
  e->rms_in_l = sqrt(sq_in_l / (double)frames);
  e->rms_in_r = sqrt(sq_in_r / (double)frames);

  /* ---- effect chain */
  if (!e->master_bypass) bk_chain_process(&e->chain, cin_l, cin_r, frames);

  /* ---- DIRECT drums, into both taps, unsanitised */
  if (drums_direct) {
    for (i = 0; i < frames; i++) {
      const double l = (double)drum_l[i];
      const double r = (double)drum_r[i];
      dry_l[i] = (float)((double)dry_l[i] + l);
      dry_r[i] = (float)((double)dry_r[i] + r);
      cin_l[i] = (float)((double)cin_l[i] + l);
      cin_r[i] = (float)((double)cin_r[i] + r);
    }
  }

  /* ---- master tap, looper, output stage */
  if (bk_looper_active(&e->looper)) {
    float *tap_l = e->tap_l, *tap_r = e->tap_r;
    float *loop_l = e->loop_l, *loop_r = e->loop_r;
    bk_loop_src src;
    for (i = 0; i < frames; i++) {
      const double mm = bk_smoother_next(&e->master_mix);
      tap_l[i] = (float)((double)dry_l[i] * (1.0 - mm) + (double)cin_l[i] * mm);
      tap_r[i] = (float)((double)dry_r[i] * (1.0 - mm) + (double)cin_r[i] * mm);
      loop_l[i] = 0.0f;
      loop_r[i] = 0.0f;
    }
    src.master_l = tap_l;
    src.master_r = tap_r;
    src.drum_l = drums_on ? drum_l : NULL;
    src.drum_r = drums_on ? drum_r : NULL;
    bk_looper_process(&e->looper, &src, loop_l, loop_r, (size_t)frames, &e->clock);

    for (i = 0; i < frames; i++) {
      const double g = bk_smoother_next(&e->out_gain);
      const double l = ((double)tap_l[i] + (double)loop_l[i]) * g;
      const double r = ((double)tap_r[i] + (double)loop_r[i]) * g;
      const double al = fabs(l), ar = fabs(r);
      if (al > pk_out_l) pk_out_l = al;
      if (ar > pk_out_r) pk_out_r = ar;
      sq_out_l += l * l;
      sq_out_r += r * r;
      out_l[i] = (float)bk_sanitize(bk_clamp(l, -1.4, 1.4));
      out_r[i] = (float)bk_sanitize(bk_clamp(r, -1.4, 1.4));
    }
  } else {
    for (i = 0; i < frames; i++) {
      const double mm = bk_smoother_next(&e->master_mix);
      const double g = bk_smoother_next(&e->out_gain);
      const double l = ((double)dry_l[i] * (1.0 - mm) + (double)cin_l[i] * mm) * g;
      const double r = ((double)dry_r[i] * (1.0 - mm) + (double)cin_r[i] * mm) * g;
      const double al = fabs(l), ar = fabs(r);
      if (al > pk_out_l) pk_out_l = al;
      if (ar > pk_out_r) pk_out_r = ar;
      sq_out_l += l * l;
      sq_out_r += r * r;
      out_l[i] = (float)bk_sanitize(bk_clamp(l, -1.4, 1.4));
      out_r[i] = (float)bk_sanitize(bk_clamp(r, -1.4, 1.4));
    }
  }

  if (pk_out_l >= 0.999 || pk_out_r >= 0.999) e->clip_out = 1.0;
  e->meter_out_l = pk_out_l;
  e->meter_out_r = pk_out_r;
  e->rms_out_l = sqrt(sq_out_l / (double)frames);
  e->rms_out_r = sqrt(sq_out_r / (double)frames);

  bk_clock_advance(&e->clock, (double)frames);
  e->block_count += 1.0;
}
