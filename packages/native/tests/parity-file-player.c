/*
 * Parity dump for the C port of dsp/core/file-player.js.
 *
 * Producer half of the oracle; scripts/verify-file-player-parity.mjs is the
 * consumer. See parity-io.h for the stream format.
 *
 * The player is a state machine wrapped around two signal paths (a straight
 * copy when alpha == 1, WSOLA grains otherwise) feeding one resampler. Almost
 * every bug it could have is a sequence bug: what play does after the file
 * ended, what a seek does to the FIFO, how a loop region wraps a grain's
 * correlation search. So the whole battery is one opcode VM, and every case is
 * a script. The script travels as the record's params and the JS runner
 * replays it op for op; there is no second copy of the case table.
 *
 * Per PROCESS op the payload carries, for every block, the return value and
 * eleven state readings (out64), and every output sample of both channels
 * (out32). SNAP adds the full struct; SNAP with a = 1 adds both FIFOs and the
 * correlation reference too, which is how a wrong overlap-add that the
 * resampler happens to read past is still caught.
 *
 * Things the battery is built to reach, because a "tidier" port gets them
 * wrong:
 *
 *   - both fill paths, and the 1e-3 boundary between them;
 *   - end of file one-shot (ended, auto-stop, fade, replay from region start);
 *   - loop wraps through copy_run and through a grain's search window, with
 *     regions down to the 128-frame minimum, where the search reaches back a
 *     whole region length (the `back == 0` fix);
 *   - fractional loop points (the bug this port found);
 *   - every setter's clamp from both sides, NaN, both infinities and -0;
 *   - NaN pitch and speed, which put NaN into fifo_read, so the FIFO index
 *     takes ToInt32(NaN) == 0 — undefined behaviour for a bare C cast;
 *   - FIFO counters pushed past 2^31, 2^32 and 2^63, fractional, and a
 *     non-finite grain position (OP_COUNTERS), the only way to reach the
 *     modulo-2^32 and non-finite paths of the index helper in a short run;
 *   - zeroed and very quiet stretches of source (OP_SCALE), where the
 *     correlation search's ties and its energy floor decide the splice;
 *   - mono by NULL and mono by aliasing, engine/source rate mismatch, and the
 *     src_rate fallback for 0, negative and NaN.
 *
 * Stimulus is bk_fill_signal, narrowed to float — exactly what the JS gets.
 *
 * Usage: parity-file-player <out.bin>
 */

#include "brokodr/dsp/file-player.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

enum {
  OP_END = 0,
  OP_INIT = 1,     /* a = sample rate, b = max block */
  OP_BUF = 2,      /* a = left signal, b = right signal (-1 NULL, -2 alias), c = frames, d = src rate */
  OP_CLEAR = 3,
  OP_PARAM = 4,    /* a = key, b = value */
  OP_PROCESS = 5,  /* a = blocks, b = block size */
  OP_RESET = 6,
  OP_SNAP = 7,     /* a = 1: include FIFOs and reference */
  OP_COUNTERS = 8, /* fifo_write = a, fifo_read = b, ola_pos = c */
  OP_SCALE = 9     /* source frames [b, c) of both channels *= (float)a */
};
#define OPW 5

#define MAX_SRC 262144
#define MAX_BLOCK 2048
#define MAX_P64 2000000
#define MAX_P32 6000000

/* Per-block readings after each PROCESS block. Field order is the contract
   with blockState() in the JS runner. */
#define BK_FP_BLOCK 12
/* Struct snapshot. Field order is the contract with snapState(). */
#define BK_FP_SNAP 26

static float g_src_l[MAX_SRC];
static float g_src_r[MAX_SRC];
static double g_tmp[MAX_SRC];
static float g_out_l[MAX_BLOCK];
static float g_out_r[MAX_BLOCK];
static double g_p64[MAX_P64];
static float g_p32[MAX_P32];
static unsigned int n64, n32;
static bk_file_player g_fp;

static void push64(double v) {
  if (n64 < MAX_P64) g_p64[n64++] = v;
}
static void push32(float v) {
  if (n32 < MAX_P32) g_p32[n32++] = v;
}

static void fill_src(float *dst, int n, int sig) {
  int i;
  bk_fill_signal(g_tmp, (size_t)n, sig);
  for (i = 0; i < n; i++) dst[i] = (float)g_tmp[i];
  /* One past the end is `undefined` (NaN) in the JS. A port that reads it
     gets this instead of whatever the previous script left there. */
  if (n < MAX_SRC) dst[n] = 7.0f;
}

static void block_state(const bk_file_player *p, int ret) {
  push64((double)ret);
  push64(p->meter);
  push64(p->position);
  push64(p->src_pos);
  push64(p->fifo_write);
  push64(p->fifo_read);
  push64(p->ola_pos);
  push64((double)p->ended);
  push64((double)p->playing);
  push64(p->gain_sm.value);
  push64(p->gain_sm.target);
  push64((double)bk_file_player_active(p));
}

static void snap_state(const bk_file_player *p, int full) {
  int i;
  push64(p->sr);
  push64((double)p->max_block);
  push64((double)p->frames);
  push64(p->src_rate);
  push64((double)p->playing);
  push64((double)p->loop_enabled);
  push64(p->loop_in);
  push64(p->loop_out);
  push64(p->src_pos);
  push64((double)p->ended);
  push64(p->speed);
  push64(p->pitch_semis);
  push64(p->gain_sm.value);
  push64(p->gain_sm.target);
  push64(p->gain_sm.a);
  push64(p->level_db);
  push64(p->level);
  push64(p->fifo_write);
  push64(p->fifo_read);
  push64(p->ola_pos);
  push64((double)p->has_ref);
  push64(p->meter);
  push64(p->position);
  push64((double)bk_file_player_loaded(p));
  push64((double)bk_file_player_active(p));
  push64((double)(p->ch_r == p->ch_l));
  if (full) {
    for (i = 0; i < BK_FP_FIFO; i++) push32(p->fifo_l[i]);
    for (i = 0; i < BK_FP_FIFO; i++) push32(p->fifo_r[i]);
    for (i = 0; i < BK_FP_CORR; i++) push32(p->ref_l[i]);
  }
}

static double unsentinel(double v) {
  if (v == -3e9) return (double)NAN;
  if (v == 3e9) return (double)INFINITY;
  if (v == -4e9) return -(double)INFINITY;
  return v;
}

static void run_script(FILE *f, const char *name, const double *ops, size_t n_ops) {
  bk_file_player *p = &g_fp;
  size_t i;
  int k, j;

  n64 = 0;
  n32 = 0;
  bk_file_player_init(p, 48000.0, 128);
  /* The window is built in init, so it is dumped once per script. */
  for (k = 0; k < BK_FP_GRAIN; k++) push32(p->window[k]);

  for (i = 0; i + OPW <= n_ops; i += OPW) {
    const int op = (int)ops[i];
    const double a = unsentinel(ops[i + 1]), b = unsentinel(ops[i + 2]);
    const double c = unsentinel(ops[i + 3]), d = unsentinel(ops[i + 4]);
    switch (op) {
      case OP_END:
        i = n_ops;
        break;
      case OP_INIT:
        bk_file_player_init(p, a, (int)b);
        break;
      case OP_BUF: {
        const int n = (int)c;
        const float *r = NULL;
        fill_src(g_src_l, n, (int)a);
        if (b >= 0) {
          fill_src(g_src_r, n, (int)b);
          /* Decorrelate: a right channel that equals the left would hide a
             swapped-channel bug. Halved and negated, exact in float. */
          for (k = 0; k < n; k++) g_src_r[k] = -0.5f * g_src_r[k];
          r = g_src_r;
        } else if (b == -2) {
          r = g_src_l;
        }
        bk_file_player_set_buffer(p, g_src_l, r, n, d);
        break;
      }
      case OP_CLEAR:
        bk_file_player_clear_buffer(p);
        break;
      case OP_PARAM:
        bk_file_player_set_param(p, (int)a, b);
        break;
      case OP_PROCESS: {
        const int blocks = (int)a, bs = (int)b;
        for (k = 0; k < blocks; k++) {
          const int ret = bk_file_player_process(p, g_out_l, g_out_r, bs);
          block_state(p, ret);
          for (j = 0; j < bs; j++) push32(g_out_l[j]);
          for (j = 0; j < bs; j++) push32(g_out_r[j]);
        }
        break;
      }
      case OP_RESET:
        bk_file_player_reset(p);
        break;
      case OP_SNAP:
        snap_state(p, a == 1.0);
        break;
      case OP_COUNTERS:
        p->fifo_write = a;
        p->fifo_read = b;
        p->ola_pos = c;
        break;
      case OP_SCALE: {
        /* The source is borrowed, so this edits what the player reads. A
           float times a float is one correctly rounded float product, which
           is what the JS's double product narrowed on store gives too. */
        const int hi = (int)c < p->frames ? (int)c : p->frames;
        for (k = (int)b; k < hi; k++) {
          g_src_l[k] = g_src_l[k] * (float)a;
          if (p->ch_r == g_src_r) g_src_r[k] = g_src_r[k] * (float)a;
        }
        break;
      }
      default:
        break;
    }
  }
  snap_state(p, 1);
  if (n64 >= MAX_P64 || n32 >= MAX_P32) {
    fprintf(stderr, "%s: payload overflow\n", name);
    exit(3);
  }
  bk_parity_emit(f, name, ops, (unsigned int)n_ops, g_p64, n64, g_p32, n32);
}

/* --- the scripts -------------------------------------------------------- */

#define NOISE BK_SIG_NOISE
#define RAMP BK_SIG_RAMP
#define STEP BK_SIG_STEP
#define IMP BK_SIG_IMPULSE
#define ZERO BK_SIG_ZERO

#define P_PLAY BK_FILE_P_PLAY
#define P_SEEK BK_FILE_P_SEEK
#define P_LOOP BK_FILE_P_LOOP
#define P_IN BK_FILE_P_LOOP_IN
#define P_OUT BK_FILE_P_LOOP_OUT
#define P_SPEED BK_FILE_P_SPEED
#define P_PITCH BK_FILE_P_PITCH
#define P_GAIN BK_FILE_P_GAIN

#define O(op, a, b, c, d) (double)(op), (double)(a), (double)(b), (double)(c), (double)(d)
#define INIT(sr, mb) O(OP_INIT, sr, mb, 0, 0)
#define BUF(l, r, n, rate) O(OP_BUF, l, r, n, rate)
#define SET(k, v) (double)OP_PARAM, (double)(k), (double)(v), 0.0, 0.0
#define PROC(n, bs) O(OP_PROCESS, n, bs, 0, 0)
#define SNAP(full) O(OP_SNAP, full, 0, 0, 0)
#define CLEAR O(OP_CLEAR, 0, 0, 0, 0)
#define RESET O(OP_RESET, 0, 0, 0, 0)
#define COUNTERS(x) O(OP_COUNTERS, x, x, x, 0)
#define COUNTERS3(w, r, q) O(OP_COUNTERS, w, r, q, 0)
#define SCALE(f, from, to) O(OP_SCALE, f, from, to, 0)
#define END O(OP_END, 0, 0, 0, 0)

/* Sentinels, mapped to NaN / +inf / -inf at run time: a NaN or an infinity
   in a static initialiser is not portable to MSVC. The JS runner applies the
   same map to the same params. No real operand is anywhere near them. */
#define NAN_ (-3e9)
#define INF_ (3e9)
#define NINF_ (-4e9)

typedef struct {
  const char *name;
  const double *ops;
  size_t n;
} script;

/* 1x, 0 st, matched rates: the identity copy path, bit-exact passthrough. */
static const double s_identity[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_PLAY, 1), PROC(120, 128),
                                    SNAP(1), END};
/* Source at 44.1k into a 48k engine: copy path, fractional resampler. */
static const double s_rate441[] = {BUF(NOISE, RAMP, 48000, 44100), SET(P_PLAY, 1), PROC(120, 128),
                                   SNAP(1), END};
/* The other way, into a 96k engine with a 512 block. */
static const double s_rate96[] = {INIT(96000, 512), BUF(RAMP, NOISE, 60000, 48000), SET(P_PLAY, 1),
                                  PROC(60, 512), END};
/* Pitch up a fifth: alpha != 1, WSOLA grains with correlation search. */
static const double s_pitch7[] = {BUF(RAMP, NOISE, 48000, 48000), SET(P_PITCH, 7), SET(P_PLAY, 1),
                                  PROC(150, 128), SNAP(1), END};
static const double s_pitch_m5[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_PITCH, -5.5), SET(P_PLAY, 1),
                                    PROC(150, 128), END};
/* Speed only: pitch stays, alpha = speed. */
static const double s_speed_half[] = {BUF(RAMP, RAMP, 48000, 48000), SET(P_SPEED, 0.5), SET(P_PLAY, 1),
                                      PROC(150, 128), END};
static const double s_speed2[] = {BUF(NOISE, STEP, 48000, 48000), SET(P_SPEED, 2), SET(P_PLAY, 1),
                                  PROC(150, 128), SNAP(1), END};
/* Extremes, and the clamps beyond them (10 -> 4, -100 -> -24). */
static const double s_extreme_a[] = {BUF(RAMP, NOISE, 120000, 48000), SET(P_SPEED, 10), SET(P_PITCH, -100),
                                     SET(P_PLAY, 1), PROC(100, 128), SNAP(0), END};
static const double s_extreme_b[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_SPEED, 0.01), SET(P_PITCH, 100),
                                     SET(P_PLAY, 1), PROC(100, 128), SNAP(0), END};
/* speed == pitch ratio lands alpha on exactly 1 at a pitch other than 0. */
static const double s_alpha_one[] = {BUF(RAMP, NOISE, 48000, 48000), SET(P_PITCH, 12), SET(P_SPEED, 2),
                                     SET(P_PLAY, 1), PROC(80, 128), END};
/* Either side of the 1e-3 identity boundary. */
static const double s_alpha_in[] = {BUF(RAMP, NOISE, 48000, 48000), SET(P_SPEED, 1.0009), SET(P_PLAY, 1),
                                    PROC(80, 128), END};
static const double s_alpha_out[] = {BUF(RAMP, NOISE, 48000, 48000), SET(P_SPEED, 1.0011), SET(P_PLAY, 1),
                                     PROC(80, 128), END};
static const double s_alpha_lo[] = {BUF(RAMP, NOISE, 48000, 48000), SET(P_SPEED, 0.9989), SET(P_PLAY, 1),
                                    PROC(80, 128), END};
/* Inside the gap between the 1e-3 band edge and 1.0011e-3, both sides. */
static const double s_alpha_edge[] = {BUF(RAMP, NOISE, 48000, 48000), SET(P_SPEED, 1.0010005), SET(P_PLAY, 1),
                                      PROC(40, 128), SET(P_SPEED, 0.9989995), PROC(40, 128), END};
/* An underrun whose first overshoot is under one frame: a one-shot RAMP runs
   off the end inside a big block at a non-integer r > 1, while the gain is
   still up and the FIFO past the write head holds stale, non-zero frames. */
static const double s_underrun_frac[] = {INIT(48000, 512), BUF(RAMP, NOISE, 20000, 50000), SET(P_PLAY, 1),
                                         PROC(45, 512), BUF(NOISE, RAMP, 20000, 48000), SET(P_PITCH, 3),
                                         SET(P_PLAY, 1), PROC(45, 512), END};
/* PLAY while already playing is a no-op (no flush, no replay), and so is a
   stop while stopped, even one that follows the auto-stop at the end: the
   next PLAY must still replay from the region start. gcov showed the battery
   never sent either. */
static const double s_play_twice[] = {BUF(RAMP, NOISE, 6000, 48000), SET(P_PITCH, 2), SET(P_PLAY, 1),
                                      PROC(20, 128), SET(P_PLAY, 1), PROC(5, 128), SNAP(1), PROC(40, 128),
                                      SNAP(1), SET(P_PLAY, 0), SET(P_PLAY, 1), PROC(10, 128), SNAP(1), END};
/* The other order for NaN loop points: a NaN loop-in then a loop-out (NaN
   reaches js_max as its second operand), and a NaN loop-out then a loop-in. */
static const double s_loop_nan_cross[] = {BUF(RAMP, NOISE, 8000, 48000), SET(P_LOOP, 1), SET(P_IN, NAN_),
                                          SET(P_OUT, 0.5), SNAP(0), SET(P_PLAY, 1), PROC(10, 128), SNAP(1),
                                          BUF(NOISE, RAMP, 8000, 48000), SET(P_LOOP, 1), SET(P_OUT, NAN_),
                                          SET(P_IN, 0.25), SNAP(0), SET(P_PLAY, 1), PROC(10, 128), SNAP(1),
                                          END};
/* A short one-shot file runs off the end: ended, auto-stop, fade, then a
   replay that must restart from the region start. */
static const double s_oneshot[] = {BUF(NOISE, RAMP, 5000, 48000), SET(P_PLAY, 1), PROC(60, 128), SNAP(0),
                                   SET(P_PLAY, 1), PROC(20, 128), SET(P_PLAY, 0), SET(P_PLAY, 1),
                                   PROC(60, 128), END};
static const double s_oneshot_grain[] = {BUF(RAMP, NOISE, 5000, 48000), SET(P_PITCH, 3), SET(P_PLAY, 1),
                                         PROC(60, 128), SNAP(1), SET(P_PLAY, 1), PROC(60, 128), END};
/* The whole file looped, both fill paths. */
static const double s_loop_copy[] = {BUF(NOISE, RAMP, 3000, 48000), SET(P_LOOP, 1), SET(P_PLAY, 1),
                                     PROC(120, 128), SNAP(1), END};
static const double s_loop_grain[] = {BUF(RAMP, NOISE, 3000, 48000), SET(P_LOOP, 1), SET(P_SPEED, 1.37),
                                      SET(P_PLAY, 1), PROC(120, 128), SNAP(1), END};
/* Fractional loop points: the bug this port found. */
static const double s_loop_frac[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_LOOP, 1), SET(P_IN, 0.1003),
                                     SET(P_OUT, 0.2007), SET(P_SEEK, 0), SET(P_PLAY, 1), PROC(200, 128),
                                     SNAP(0), END};
static const double s_loop_frac_grain[] = {BUF(RAMP, NOISE, 48000, 48000), SET(P_LOOP, 1), SET(P_IN, 0.3001),
                                           SET(P_OUT, 0.3417), SET(P_SEEK, 0.5), SET(P_PITCH, -7),
                                           SET(P_PLAY, 1), PROC(200, 128), SNAP(1), END};
/* Minimum-size regions: 128 frames, and a few just above. The grain search
   then reaches back a whole region length from the loop start. */
static const double s_loop_min128[] = {BUF(RAMP, NOISE, 10000, 48000), SET(P_LOOP, 1), SET(P_OUT, 0.5),
                                       SET(P_IN, 0.5), SET(P_SEEK, 0), SET(P_SPEED, 1.25), SET(P_PLAY, 1),
                                       PROC(150, 128), SNAP(1), END};
static const double s_loop_min140[] = {BUF(NOISE, RAMP, 10000, 48000), SET(P_LOOP, 1), SET(P_IN, 0.2),
                                       SET(P_OUT, 0.214), SET(P_SPEED, 0.8), SET(P_PLAY, 1), PROC(150, 128),
                                       SNAP(1), END};
static const double s_loop_min160[] = {BUF(RAMP, RAMP, 10000, 48000), SET(P_LOOP, 1), SET(P_IN, 0.0),
                                       SET(P_OUT, 0.016), SET(P_PITCH, 4), SET(P_PLAY, 1), PROC(150, 128),
                                       END};
/* A region ending at the end of the file, minimum size, grain path: the old
   wrap returned `b` == frames, one past the buffer. */
static const double s_loop_tail[] = {BUF(RAMP, NOISE, 9000, 48000), SET(P_LOOP, 1), SET(P_IN, 1),
                                     SET(P_SEEK, 0.5), SET(P_SPEED, 1.5), SET(P_PLAY, 1), PROC(150, 128),
                                     SNAP(1), END};
/* Loop-point clamps from both sides, NaN, infinities, -0, and the order
   dependence (in is limited by out, out by in). */
static const double s_loop_clamps[] = {BUF(NOISE, RAMP, 20000, 48000), SET(P_IN, 0.9), SNAP(0), SET(P_OUT, 0.1),
                                       SNAP(0), SET(P_OUT, 2), SNAP(0), SET(P_IN, -1), SNAP(0), SET(P_IN, -0.0),
                                       SNAP(0), SET(P_OUT, -0.0), SNAP(0), SET(P_IN, 0.99999), SNAP(0),
                                       SET(P_OUT, INF_), SNAP(0), SET(P_IN, NINF_), SNAP(0),
                                       SET(P_IN, 0.000025), SNAP(0), SET(P_OUT, 0.5000249), SNAP(0),
                                       SET(P_IN, 0.4999751), SNAP(0), END};
static const double s_loop_nan_in[] = {BUF(NOISE, RAMP, 20000, 48000), SET(P_LOOP, 1), SET(P_IN, NAN_),
                                       SNAP(0), SET(P_PLAY, 1), PROC(30, 128), SNAP(0), END};
static const double s_loop_nan_out[] = {BUF(RAMP, NOISE, 20000, 48000), SET(P_LOOP, 1), SET(P_OUT, NAN_),
                                        SNAP(0), SET(P_SPEED, 1.5), SET(P_PLAY, 1), PROC(30, 128), SNAP(0), END};
/* -0 loop start, reached through the replay-after-end path into src_pos. */
static const double s_negzero[] = {BUF(NOISE, RAMP, 2000, 48000), SET(P_IN, -0.0), SET(P_LOOP, 1),
                                   SET(P_SEEK, -0.0), SNAP(0), SET(P_LOOP, 0), SET(P_PLAY, 1), PROC(30, 128),
                                   SET(P_LOOP, 1), SET(P_PLAY, 1), SNAP(0), PROC(5, 128), END};
/* Seeks: inside and outside the region, past the ends, NaN, while playing. */
static const double s_seek[] = {BUF(NOISE, RAMP, 30000, 48000), SET(P_SEEK, 0.5), SNAP(0), SET(P_SEEK, 2),
                                SNAP(0), SET(P_SEEK, -1), SNAP(0), SET(P_PLAY, 1), PROC(20, 128),
                                SET(P_SEEK, 0.25), PROC(20, 128), SET(P_LOOP, 1), SET(P_IN, 0.6),
                                SET(P_OUT, 0.8), SET(P_SEEK, 0.5), SNAP(0), PROC(40, 128), SET(P_SEEK, -0.5),
                                SNAP(0), PROC(20, 128), END};
static const double s_seek_nan[] = {BUF(RAMP, NOISE, 30000, 48000), SET(P_PLAY, 1), PROC(5, 128),
                                    SET(P_SEEK, NAN_), SNAP(0), PROC(10, 128), SET(P_SEEK, 0.1), PROC(10, 128),
                                    SET(P_SPEED, 1.5), SET(P_SEEK, NAN_), PROC(10, 128), END};
/* Gain: unity, the -60 floor (exactly 0), below it, the +12 ceiling, NaN. */
static const double s_gain[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_PLAY, 1), SET(P_GAIN, -6), PROC(10, 128),
                                SET(P_GAIN, -60), SNAP(0), PROC(5, 128), SET(P_GAIN, -70), SNAP(0),
                                SET(P_GAIN, -59.99), SNAP(0), SET(P_GAIN, 12), PROC(5, 128), SET(P_GAIN, 30),
                                SNAP(0), SET(P_GAIN, NAN_), SNAP(0), PROC(5, 128), SET(P_GAIN, 0), PROC(5, 128),
                                END};
/* Stop mid-play: the 6 ms fade, active while fading, then the early-out. */
static const double s_stop_fade[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_PLAY, 1), PROC(10, 64), SET(P_PLAY, 0),
                                     PROC(60, 64), SNAP(0), SET(P_PLAY, 0.49), SET(P_PLAY, 0.5), PROC(10, 64),
                                     END};
/* Unloaded: process is silent, play is ignored; clear while playing. */
static const double s_unloaded[] = {PROC(3, 128), SET(P_PLAY, 1), SNAP(0), SET(P_SEEK, 0.5), SET(P_LOOP, 1),
                                    SET(P_IN, 0.2), SET(P_OUT, 0.8), SNAP(0), PROC(2, 128),
                                    BUF(NOISE, RAMP, 48000, 48000), SET(P_PLAY, 1), PROC(10, 128), CLEAR,
                                    SNAP(1), PROC(3, 128), BUF(NOISE, -1, 0, 48000), SNAP(0), PROC(2, 128),
                                    END};
static const double s_reset[] = {BUF(RAMP, NOISE, 48000, 48000), SET(P_PITCH, 2), SET(P_PLAY, 1), PROC(20, 128),
                                 RESET, SNAP(1), PROC(5, 128), SET(P_PLAY, 1), PROC(20, 128), END};
static const double s_unknown[] = {BUF(NOISE, RAMP, 4000, 48000), SET(-1, 1), SET(8, 1), SET(99, 0.5), SNAP(0),
                                   END};
/* Mono, by NULL and by aliasing. */
static const double s_mono_null[] = {BUF(NOISE, -1, 48000, 48000), SET(P_PITCH, -3), SET(P_PLAY, 1),
                                     PROC(60, 128), SNAP(0), END};
static const double s_mono_alias[] = {BUF(RAMP, -2, 48000, 44100), SET(P_PLAY, 1), PROC(60, 128), END};
/* src_rate fallback: 0, negative and NaN all mean "the engine rate". */
static const double s_rate_bad[] = {BUF(NOISE, RAMP, 4000, 0), SNAP(0), BUF(NOISE, RAMP, 4000, -44100), SNAP(0),
                                    BUF(NOISE, RAMP, 4000, NAN_), SNAP(0), SET(P_PLAY, 1), PROC(5, 128),
                                    END};
/* NaN and infinite pitch/speed: NaN reaches fifo_read and the FIFO index. */
static const double s_nan_pitch[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_PLAY, 1), PROC(5, 128),
                                     SET(P_PITCH, NAN_), PROC(10, 128), SNAP(0), SET(P_PITCH, 0), PROC(5, 128),
                                     END};
static const double s_nan_speed[] = {BUF(RAMP, NOISE, 48000, 48000), SET(P_PLAY, 1), PROC(5, 128),
                                     SET(P_SPEED, NAN_), PROC(10, 128), SNAP(1), SET(P_SPEED, INF_),
                                     SET(P_PITCH, NINF_), PROC(10, 128), SNAP(0), END};
/* Block sizes: 1, odd, large, and a block size that changes mid-run. */
static const double s_blocks[] = {BUF(NOISE, RAMP, 48000, 44100), SET(P_PITCH, 1.5), SET(P_PLAY, 1), PROC(300, 1),
                                  PROC(40, 7), PROC(10, 1000), PROC(5, 2048), SNAP(0), END};
/* FIFO counters past 2^31 and 2^32: the index helper's modulo path. */
static const double s_counters31[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_PLAY, 1), PROC(4, 128),
                                      COUNTERS(2147483648.0 - 2000.0), PROC(40, 128), SNAP(1), END};
static const double s_counters32[] = {BUF(RAMP, NOISE, 48000, 44100), SET(P_PITCH, 5), SET(P_PLAY, 1),
                                      PROC(4, 128), COUNTERS(4294967296.0 - 3000.0), PROC(50, 128), SNAP(1),
                                      END};
static const double s_counters_neg[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_PLAY, 1), PROC(2, 128),
                                        COUNTERS(-2147483648.0 - 1500.0), PROC(30, 128), SNAP(0), END};
/* Low engine rates and an impulse source, so every resampler tap is visible. */
static const double s_impulse[] = {INIT(22050, 256), BUF(IMP, STEP, 2000, 48000), SET(P_PLAY, 1),
                                   PROC(30, 256), END};
static const double s_zero_src[] = {BUF(ZERO, ZERO, 8000, 48000), SET(P_PITCH, 9), SET(P_PLAY, 1),
                                    PROC(30, 128), SNAP(1), END};

/* --- added by the mutation sweep: each closes a hole it found ------------ */

/* Setter edges: v * 200 is exactly 0.49999999999999994, which Math.round
   takes to 0 and floor(x + 0.5) to 1; loop exactly 0.5; a loop end of
   frames - 1 that must not be pushed to frames. */
static const double s_edges[] = {BUF(NOISE, RAMP, 200, 48000), SET(P_IN, 0.0024999999999999996), SNAP(0),
                                 SET(P_LOOP, 0.5), SNAP(0), BUF(NOISE, RAMP, 20000, 48000), SET(P_OUT, 0.99995),
                                 SNAP(0), SET(P_LOOP, 0.4999), SNAP(0), END};
/* A file shorter than the 128-frame gap: loop_in = Math.min(-0, +0), which
   is -0, and the -0 then reaches src_pos and the playhead on replay. */
static const double s_negzero_short[] = {BUF(NOISE, RAMP, 100, 48000), SET(P_IN, -0.0), SNAP(0), SET(P_LOOP, 1),
                                         SET(P_SEEK, 0), SNAP(0), SET(P_LOOP, 0), SET(P_PLAY, 1), PROC(3, 128),
                                         SET(P_LOOP, 1), SET(P_PLAY, 1), SNAP(0), PROC(2, 128), SNAP(0), END};
/* A new buffer over a dirty player: looping, mid-region, playing at full
   gain with a full FIFO; and over an ended one. */
static const double s_rebuf[] = {BUF(NOISE, RAMP, 20000, 48000), SET(P_LOOP, 1), SET(P_IN, 0.3), SET(P_OUT, 0.6),
                                 SET(P_SEEK, 0.5), SET(P_PITCH, 3), SET(P_PLAY, 1), PROC(60, 128),
                                 BUF(RAMP, NOISE, 15000, 44100), SNAP(1), PROC(5, 128), SNAP(0), END};
static const double s_rebuf_ended[] = {BUF(NOISE, RAMP, 3000, 48000), SET(P_PLAY, 1), PROC(40, 128), SNAP(0),
                                       BUF(RAMP, NOISE, 4000, 48000), SNAP(0), END};
/* Loop points set while looping is off: the region must be the whole file
   for seek, for reads, and past the loop end. */
static const double s_region_noloop[] = {BUF(NOISE, RAMP, 20000, 48000), SET(P_IN, 0.3), SET(P_OUT, 0.6),
                                         SET(P_SEEK, 0.5), SNAP(0), SET(P_PLAY, 1), PROC(30, 128), SNAP(0),
                                         SET(P_SEEK, 0.59), PROC(30, 128), SNAP(0), END};
/* Seek after the end clears ended; then a replay after an end with looping
   switched on starts from loop-in, not from 0. */
static const double s_replay_region[] = {BUF(NOISE, RAMP, 4000, 48000), SET(P_PLAY, 1), PROC(50, 128), SNAP(0),
                                         SET(P_SEEK, 0.25), SNAP(0), SET(P_PLAY, 1), PROC(50, 128), SNAP(0),
                                         SET(P_LOOP, 1), SET(P_IN, 0.3), SET(P_OUT, 0.7), SET(P_PLAY, 1), SNAP(0),
                                         PROC(20, 128), END};
/* Stopped but not yet rendered: target and value still 1 and settled, so
   only the value test keeps it active. */
static const double s_stop_settled[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_PLAY, 1), PROC(60, 128), SNAP(0),
                                        SET(P_PLAY, 0), SNAP(0), PROC(60, 128), SNAP(0), END};
/* A loop of exactly 6 hops: copy_run lands src_pos on loop-out itself. */
static const double s_loop_hops[] = {BUF(NOISE, RAMP, 3072, 48000), SET(P_LOOP, 1), SET(P_PLAY, 1),
                                     PROC(60, 128), END};
/* A fractional src_pos into the copy path, from a seek and from a grain. */
static const double s_seek_frac[] = {BUF(NOISE, RAMP, 30000, 48000), SET(P_SEEK, 0.33333), SNAP(0), SET(P_PLAY, 1),
                                     PROC(20, 128), SNAP(1), SET(P_SPEED, 1.37), PROC(10, 128), SET(P_SPEED, 1),
                                     PROC(10, 128), SNAP(1), END};
/* A one-shot long enough for the FIFO to have wrapped before the end, so
   the zeros past the end overwrite real data. */
static const double s_oneshot_long[] = {BUF(NOISE, RAMP, 10000, 48000), SET(P_PLAY, 1), PROC(100, 128), SNAP(1),
                                        END};
/* Zeroed stretches of source: at quarter speed the second grain's reference
   is all zero, so every candidate scores exactly 0 and the first one that
   is not before the file start must win. */
static const double s_zero_patch[] = {BUF(NOISE, RAMP, 20000, 48000), SCALE(0, 0, 900), SCALE(0, 6000, 6600),
                                      SET(P_SPEED, 0.25), SET(P_PLAY, 1), PROC(200, 128), SNAP(1), END};
/* A very quiet source (2^-14, exact), where the 1e-9 energy floor decides
   the correlation ranking. */
static const double s_quiet[] = {BUF(NOISE, RAMP, 20000, 48000), SCALE(0.00006103515625, 0, 20000), SET(P_PITCH, 5),
                                 SET(P_PLAY, 1), PROC(100, 128), SNAP(1), END};
/* A NaN loop end makes the region unbounded, so the reads run off the end
   of the file: those must be NaN, not the frame after the buffer. */
static const double s_nan_out_end[] = {BUF(NOISE, RAMP, 3000, 48000), SET(P_LOOP, 1), SET(P_OUT, NAN_), SET(P_PLAY, 1),
                                       PROC(40, 128), SNAP(1), END};
/* FIFO counters beyond 2^63 (2^64 + 4096, where a 64-bit cast is undefined
   and ToInt32 still gives 4096), and fractional past 2^31 (truncation). */
static const double s_counters64[] = {BUF(NOISE, RAMP, 48000, 48000), SET(P_PLAY, 1), PROC(2, 128),
                                      COUNTERS(18446744073709555712.0), PROC(5, 128), SNAP(1), END};
static const double s_counters_frac[] = {BUF(RAMP, NOISE, 48000, 44100), SET(P_PLAY, 1), PROC(2, 128),
                                         COUNTERS(2147483648.5), PROC(20, 128), SNAP(1), END};
/* A non-finite grain position with a finite read head: the grain lands on
   ToInt32(inf) == ToInt32(NaN) == 0, and the read head sees it there. */
static const double s_ola_nonfinite[] = {BUF(RAMP, NOISE, 48000, 48000), SET(P_PITCH, 3), SET(P_PLAY, 1), PROC(5, 128),
                                         COUNTERS3(0, 0, INF_), PROC(3, 128), SNAP(1), SET(P_SEEK, 0.2),
                                         PROC(3, 128), COUNTERS3(0, 0, NAN_), PROC(3, 128), SNAP(1), END};

#define S(n) {#n, n, sizeof(n) / sizeof(n[0])}

static const script scripts[] = {
    S(s_identity),     S(s_rate441),     S(s_rate96),        S(s_pitch7),       S(s_pitch_m5),
    S(s_speed_half),   S(s_speed2),      S(s_extreme_a),     S(s_extreme_b),    S(s_alpha_one),
    S(s_alpha_in),     S(s_alpha_out),   S(s_alpha_lo),      S(s_oneshot),      S(s_oneshot_grain),
    S(s_loop_copy),    S(s_loop_grain),  S(s_loop_frac),     S(s_loop_frac_grain), S(s_loop_min128),
    S(s_loop_min140),  S(s_loop_min160), S(s_loop_tail),     S(s_loop_clamps),  S(s_loop_nan_in),
    S(s_loop_nan_out), S(s_negzero),     S(s_seek),          S(s_seek_nan),     S(s_gain),
    S(s_stop_fade),    S(s_unloaded),    S(s_reset),         S(s_unknown),      S(s_mono_null),
    S(s_mono_alias),   S(s_rate_bad),    S(s_nan_pitch),     S(s_nan_speed),    S(s_blocks),
    S(s_counters31),   S(s_counters32),  S(s_counters_neg),  S(s_impulse),      S(s_zero_src),
    S(s_edges),        S(s_negzero_short), S(s_rebuf),       S(s_rebuf_ended),  S(s_region_noloop),
    S(s_replay_region), S(s_stop_settled), S(s_loop_hops),   S(s_seek_frac),    S(s_oneshot_long),
    S(s_zero_patch),   S(s_quiet),       S(s_nan_out_end),   S(s_counters64),   S(s_counters_frac),
    S(s_ola_nonfinite), S(s_alpha_edge), S(s_underrun_frac), S(s_play_twice),
    S(s_loop_nan_cross),
};

int main(int argc, char **argv) {
  FILE *f;
  size_t i;

  if (argc < 2) {
    fprintf(stderr, "usage: %s <out.bin>\n", argv[0]);
    return 2;
  }
  f = fopen(argv[1], "wb");
  if (!f) {
    fprintf(stderr, "cannot open %s\n", argv[1]);
    return 1;
  }
  bk_parity_open(f);
  for (i = 0; i < sizeof(scripts) / sizeof(scripts[0]); i++) {
    run_script(f, scripts[i].name, scripts[i].ops, scripts[i].n);
  }
  if (!bk_parity_close(f)) {
    fprintf(stderr, "cannot patch record count\n");
    fclose(f);
    return 1;
  }
  fprintf(stderr, "wrote %u records to %s\n", bk_parity_records, argv[1]);
  fclose(f);
  return 0;
}
