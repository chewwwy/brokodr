/*
 * Bro.Kodr DSP core — audio file player.
 * C port of dsp/core/file-player.js. See biquad.h for the porting rules.
 *
 * Plays a decoded file into the engine, as an input source or as the carrier
 * for the talk box / vocoder. SPEED and PITCH are independent:
 *
 *     source --[ WSOLA stretch, alpha ]--> FIFO --[ Catmull-Rom resampler, r ]--> out
 *
 *     r = (src_rate / sr) * pitch_ratio      alpha = speed / pitch_ratio
 *
 * When alpha is within 1e-3 of 1 the stretcher is a straight copy, so the
 * default 1x / 0 st case has none of WSOLA's artefacts.
 *
 * Three things the port has to hold exactly as the JS does:
 *
 *   1. THE FIFO, THE WINDOW AND THE CORRELATION REFERENCE ARE FLOAT. The JS
 *      holds them in Float32Arrays, so every overlap-add rounds to float32 on
 *      the store. All arithmetic stays in double and only the store narrows.
 *
 *   2. THE FIFO COUNTERS ARE UNBOUNDED DOUBLES, MASKED WITH ToInt32 SEMANTICS.
 *      fifo_write, ola_pos and fifo_read only ever grow, and the JS masks them
 *      with `& FIFO_MASK`, which is ToInt32 then AND. file-player.c does the
 *      same through a local helper, so `(i0 - 1) & mask` at i0 == 0 is 8191 on
 *      every toolchain rather than whatever a negative-int cast happens to do.
 *
 *   3. THE SOURCE IS BORROWED. ch_l / ch_r are caller-owned and read-only; the
 *      player never copies or frees them. ch_r may equal ch_l (mono).
 *
 * Loop points are whole frames (bug found by this port and fixed in both
 * implementations on 2026-10-01: a fractional loop point made the wrapped read
 * index fractional, and in the JS that read `undefined`, i.e. silence).
 *
 * Real-time discipline: no allocation; everything is inside the struct. libm
 * use: cos once at init (the grain window), pow on a level change, and in the
 * audio path floor, fabs, trunc, fmod (FIFO and loop-region wrapping), sqrt
 * (grain search) and ceil (once per block). floor, ceil, trunc, fabs and
 * fmod are exact and sqrt is correctly rounded by IEEE 754, so only cos and
 * pow can differ between libms; both agree for glibc and emscripten here,
 * which is empirical, and MSVC is unmeasured.
 */

#ifndef BROKODR_DSP_FILE_PLAYER_H
#define BROKODR_DSP_FILE_PLAYER_H

#include <stddef.h>

#include "brokodr/dsp/param-keys.h"
#include "brokodr/dsp/utils.h"

#ifdef __cplusplus
extern "C" {
#endif

/* The JS module constants, exported here for the parity battery. */
#define BK_FP_GRAIN 1024
#define BK_FP_HOP (BK_FP_GRAIN >> 1)
#define BK_FP_TOLERANCE 160
#define BK_FP_CORR 256
#define BK_FP_CORR_STEP 2
#define BK_FP_FIFO 8192
#define BK_FP_FIFO_MASK (BK_FP_FIFO - 1)

typedef struct {
  double sr;
  int max_block;

  const float *ch_l;
  const float *ch_r;
  int frames;
  double src_rate;

  int playing;
  int loop_enabled;
  double loop_in;
  double loop_out;
  double src_pos;
  int ended;

  double speed;
  double pitch_semis;
  bk_smoother gain_sm;
  double level_db;
  double level;

  float fifo_l[BK_FP_FIFO];
  float fifo_r[BK_FP_FIFO];
  double fifo_write;
  double fifo_read;
  double ola_pos;
  /* The JS also allocates a refR it never reads; it is not ported. */
  float ref_l[BK_FP_CORR];
  int has_ref;

  float window[BK_FP_GRAIN];

  double meter;
  double position;
} bk_file_player;

void bk_file_player_init(bk_file_player *p, double sample_rate, int max_block);

/* --- control ------------------------------------------------------------ */

/* Install decoded audio. `r` may be NULL or equal to `l` for mono. A source
   rate that is not > 0 (NaN included) falls back to the engine rate.
   `frames` must be >= 0 (a decoded buffer length, as in the JS); 0 or a NULL
   `l` leaves the player unloaded. The loop-point clamps rely on it. */
void bk_file_player_set_buffer(bk_file_player *p, const float *l, const float *r, int frames,
                               double src_rate);
void bk_file_player_clear_buffer(bk_file_player *p);

int bk_file_player_loaded(const bk_file_player *p);
int bk_file_player_active(const bk_file_player *p);

/* `key` is one of BK_FILE_P_* from param-keys.h; unknown keys are ignored. */
void bk_file_player_set_param(bk_file_player *p, int key, double value);

void bk_file_player_reset(bk_file_player *p);

/* --- audio -------------------------------------------------------------- */

/* Writes (does not add) `frames` samples into out_l / out_r. Returns 1 if
   anything was rendered, 0 on the silent early-out. */
int bk_file_player_process(bk_file_player *p, float *out_l, float *out_r, int frames);

#ifdef __cplusplus
}
#endif

#endif /* BROKODR_DSP_FILE_PLAYER_H */
