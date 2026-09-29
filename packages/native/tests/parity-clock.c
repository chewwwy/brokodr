/*
 * Parity dump for the C port of dsp/core/clock.js.
 *
 * Producer half of the oracle; scripts/verify-clock-parity.mjs is the consumer.
 * See parity-io.h for the stream format.
 *
 * The clock holds no audio, so there is no sample path to diff — every reading
 * is a single evaluation, and the whole module is arithmetic on a frame
 * counter. That changes what needs proving:
 *
 *   - THE GRID IS AN INTEGER AND ROUNDS THE JS WAY. grid_frames is
 *     max(1, round(quantize * frames_per_beat)) and frames_per_beat is
 *     fractional at almost every tempo, so half of the battery is chosen to
 *     land the product exactly on .5 — where Math.round (floor(x+0.5)) and C's
 *     round() (half away from zero) disagree. A port that used round() passes
 *     a casual test and fails here.
 *
 *   - framesToGrid NEVER RETURNS 0 ON AN ACTIVE GRID. The looper's punch
 *     scheduling depends on that, so the sweep includes frames sitting exactly
 *     on a boundary, one either side, and frames far past 2^32 (the counter is
 *     a double and the JS `%` is a truncating remainder on doubles — fmod, not
 *     an integer modulo, and an int cast would have wrapped).
 *
 *   - CLAMPS AND THE NaN PATH. clamp() in utils.js is a ternary, so it passes
 *     NaN straight through rather than pinning it to a bound; Math.round(NaN)
 *     and Math.max(1, NaN) are NaN too. The battery feeds NaN and both
 *     infinities into every setter, because that is the one input class where
 *     a "tidier" C port silently disagrees (and where an `int` field would
 *     have been undefined behaviour).
 *
 *   - QUANTIZE'S ASYMMETRY. `<= 0` is off, but a positive value under the
 *     0.0625 floor is lifted to the floor rather than treated as off. Both
 *     sides of that boundary are in the sweep.
 *
 *   - ORDER MATTERS. setParam("bpm") recomputes the grid; setParam("quantize")
 *     recomputes the grid; setParam("beatsPerBar") does not. reset() does not
 *     stop the clock, and advance() is a no-op while stopped. Those are
 *     sequence facts, not single-call facts, so the last battery is a small
 *     opcode VM driving scripted sequences with state snapshots.
 *
 * No libm in the stimulus and none in the module beyond floor/fmod, so nothing
 * here is at the mercy of libm spread: every case should be bit-identical.
 *
 * Usage: parity-clock <out.bin>
 */

#include "brokodr/dsp/clock.h"

#include "parity-io.h"

#include <math.h>
#include <stdlib.h>

#define MAX_PAY 65536

static double payload[MAX_PAY];
static unsigned int pk; /* payload write cursor */

static void push(double v) {
  if (pk < MAX_PAY) payload[pk++] = v;
}

/*
 * The state dump, and the field-order contract with the JS runner. Twelve
 * numbers: the eight struct fields, then the four derived getters. Adding a
 * field here means adding it to snapState() in verify-clock-parity.mjs, in the
 * same place — the record's payload length is checked, so a one-sided change
 * fails rather than silently shifting every comparison.
 */
#define BK_CLOCK_SNAP 12

static void push_state(const bk_clock *c) {
  push(c->sr);
  push(c->bpm);
  push(c->beats_per_bar);
  push(c->quantize);
  push(c->frame);
  push((double)c->running);
  push(c->frames_per_beat);
  push(c->grid_frames);
  push(bk_clock_bar_frames(c));
  push(bk_clock_beat(c));
  push(bk_clock_bar(c));
  push(bk_clock_bar_phase(c));
}

/* --- the opcode VM ----------------------------------------------------- */

enum {
  OP_END = 0,
  OP_INIT = 1,     /* a = sample rate */
  OP_PARAM = 2,    /* a = BK_CLOCK_P_*, b = value */
  OP_ADVANCE = 3,  /* a = frames */
  OP_RESET = 4,    /* bk_clock_reset, not the param */
  OP_SNAP = 5,     /* full state dump */
  OP_TOGRID = 6,   /* a = absolute frame; pushes framesToGrid(a) */
  OP_FORBEATS = 7, /* a = beats; pushes framesForBeats(a) */
  OP_FRAME = 8     /* a = frame; sets the counter directly, to reach big values
                      without advancing a million times */
};

/*
 * Three doubles a row: op, a, b.
 *
 * ROWS_OK is the BUILD_BUG_ON_ZERO trick, lifted from parity-drum-rack.c: it
 * is 0 for a well-formed script and a compile error (a negative-sized array)
 * for one whose length is not a whole number of rows — which is the one
 * mistake a flat array of literals invites, and one that would otherwise
 * silently shift every op after it. OPS() expands to the pair every call site
 * needs, so the check cannot be forgotten at a call site that passes a length
 * by hand.
 */
#define OPW 3
#define ROWS_OK(x) ((int)sizeof(char[1 - 2 * !!(sizeof(x) % (OPW * sizeof(double)))]) - 1)
#define OPS(x) (x), (size_t)((sizeof(x) / sizeof(double)) + (size_t)ROWS_OK(x))

/*
 * Run one script and emit it. The SCRIPT ITSELF TRAVELS IN THE PARAMS, exactly
 * as parity-drum-rack.c does: the JS runner interprets the same op rows rather
 * than keeping its own copy of the battery, so the two halves cannot drift
 * apart — there is nothing to keep in sync.
 */
static void run_script(FILE *f, const char *name, const double *ops, size_t n_ops) {
  bk_clock c;
  size_t i;

  bk_clock_init(&c, 48000.0);
  pk = 0;
  for (i = 0; i + OPW <= n_ops; i += OPW) {
    const int op = (int)ops[i];
    const double a = ops[i + 1];
    const double b = ops[i + 2];
    switch (op) {
      case OP_END:
        i = n_ops;
        break;
      case OP_INIT:
        bk_clock_init(&c, a);
        break;
      case OP_PARAM:
        bk_clock_set_param(&c, (int)a, b);
        break;
      case OP_ADVANCE:
        bk_clock_advance(&c, a);
        break;
      case OP_RESET:
        bk_clock_reset(&c);
        break;
      case OP_SNAP:
        push_state(&c);
        break;
      case OP_TOGRID:
        push(bk_clock_frames_to_grid(&c, a));
        break;
      case OP_FORBEATS:
        push(bk_clock_frames_for_beats(&c, a));
        break;
      case OP_FRAME:
        c.frame = a;
        break;
      default:
        break;
    }
  }
  /* Always finish with a snapshot, so a script that forgot one still pins the
     end state. */
  push_state(&c);
  bk_parity_emit(f, name, ops, (unsigned int)n_ops, payload, pk, NULL, 0);
}

int main(int argc, char **argv) {
  FILE *f;
  int i, j, k;

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
  /* The clock carries no audio, so the shared stimulus generator is unused
     here. Referenced so the shared header does not warn, and so the absence is
     deliberate rather than an oversight. */
  (void)bk_fill_signal;

  /* --- the constructor, across every sample rate the app can meet ------- */

  {
    /* 44.1k and 48k are the common ones; 88.2/96/176.4/192 are what the
       UMC1820 will do; 8000 is the low end a conferencing device reports; the
       fractional and zero rates are there because a device that lies about its
       rate should still produce the same numbers on both sides (0 gives
       frames_per_beat 0 and a grid floored at 1, which is a real branch). */
    /* 44100.25 and 47999.75 are not typos and not device rates: the constructor
       computes its grid as round(4 * sr/2) = round(2 * sr), so the ONLY way a
       fractional rate makes that round land exactly on .5 — the one input where
       Math.round and every other C rounding function disagree — is a rate whose
       own fraction is .25 or .75. 44100.5 does not do it (2 * it is integral).
       Without these two the constructor's rounding is untested, which a mutation
       sweep found the hard way. */
    static const double rates[] = {8000.0,  11025.0,  22050.0,  32000.0, 44100.0,
                                   48000.0, 88200.0,  96000.0,  176400.0, 192000.0,
                                   384000.0, 44100.5, 44100.25, 47999.75, 1.0, 0.0};
    const int n = (int)(sizeof(rates) / sizeof(rates[0]));
    for (i = 0; i < n; i++) {
      bk_clock c;
      double p[1];
      bk_clock_init(&c, rates[i]);
      pk = 0;
      push_state(&c);
      p[0] = rates[i];
      bk_parity_emit(f, "init", p, 1, payload, pk, NULL, 0);
    }
  }

  /* --- setParam: every key, every interesting value -------------------- */

  {
    /* bpm: below MIN, exactly MIN, the defaults, exactly MAX, above MAX, and
       the three non-finite inputs the ternary clamp passes through.
       120.0000001 is there because it moves frames_per_beat in the 9th
       decimal and must move it identically. */
    static const double bpms[] = {-1e9,   -1.0,  0.0,    1.0,    19.9999, 20.0,
                                  20.0001, 60.0, 90.0,   100.0,  120.0,   120.0000001,
                                  128.0,  140.0, 174.0,  180.0,  200.0,   299.9999,
                                  300.0,  300.1, 1e9,    INFINITY, -INFINITY, NAN};
    /* beatsPerBar: the clamp ends, the half-way values where Math.round and
       C round() disagree on .5 (2.5 -> 3, -2.5 -> -2 in JS), and non-finite. */
    static const double bpbs[] = {-1e9, -2.5, -1.0, 0.0,  0.4,  0.5,  0.6,  1.0,
                                  1.5,  2.5,  3.0,  3.5,  4.0,  7.5,  8.0,  15.5,
                                  16.0, 16.4, 16.5, 17.0, 1e9,  INFINITY, -INFINITY, NAN};
    /* quantize: both sides of the `<= 0` test, both sides of the 0.0625 floor
       (the asymmetry), the QUANTIZE_CHOICES entries, an odd grid, the 64
       ceiling, and non-finite. */
    static const double quants[] = {-1.0,  -0.0,   0.0,    1e-12,  0.03125, 0.0625,
                                    0.0626, 0.25,  0.5,    0.75,   1.0,     2.0,
                                    3.0,   4.0,    8.0,    16.0,   32.0,    63.9,
                                    64.0,  64.1,   1e9,    INFINITY, -INFINITY, NAN};
    /* run: the >= 0.5 threshold from both sides, and non-finite. */
    static const double runs[] = {-1.0, 0.0, 0.25, 0.49999, 0.5, 0.50001, 1.0, 2.0, NAN, INFINITY};
    static const struct {
      int key;
      const double *vals;
      int n;
      const char *name;
    } sets[4] = {
        {BK_CLOCK_P_BPM, bpms, (int)(sizeof(bpms) / sizeof(bpms[0])), "setParam.bpm"},
        {BK_CLOCK_P_BEATS_PER_BAR, bpbs, (int)(sizeof(bpbs) / sizeof(bpbs[0])),
         "setParam.beatsPerBar"},
        {BK_CLOCK_P_QUANTIZE, quants, (int)(sizeof(quants) / sizeof(quants[0])),
         "setParam.quantize"},
        {BK_CLOCK_P_RUN, runs, (int)(sizeof(runs) / sizeof(runs[0])), "setParam.run"},
    };
    /* Two rates, because the grid rounding depends on both the rate and the
       tempo and 44.1k lands on different halves than 48k. */
    static const double rates[] = {48000.0, 44100.0};

    for (k = 0; k < 2; k++)
      for (i = 0; i < 4; i++)
        for (j = 0; j < sets[i].n; j++) {
          bk_clock c;
          double p[3];
          bk_clock_init(&c, rates[k]);
          /* Advance first, so a setter that wrongly touched the counter (or
             wrongly reset it) is visible rather than hidden behind frame 0. */
          bk_clock_advance(&c, 12345.0);
          bk_clock_set_param(&c, sets[i].key, sets[i].vals[j]);
          pk = 0;
          push_state(&c);
          /* The grid readings the looper actually asks for, at the state the
             setter left behind. */
          push(bk_clock_frames_to_grid(&c, c.frame));
          push(bk_clock_frames_to_grid(&c, 0.0));
          push(bk_clock_frames_to_grid(&c, 1.0));
          p[0] = rates[k];
          p[1] = (double)sets[i].key;
          p[2] = sets[i].vals[j];
          bk_parity_emit(f, sets[i].name, p, 3, payload, pk, NULL, 0);
        }

    /* An unknown key must be a no-op — the JS switch has no default, so a C
       `default:` that did anything at all would diverge. Keys either side of
       the valid range, and the count itself. */
    {
      static const double bad[] = {-1.0, -1000.0, 5.0, 6.0, 99.0};
      const int n = (int)(sizeof(bad) / sizeof(bad[0]));
      for (j = 0; j < n; j++) {
        bk_clock c;
        double p[2];
        bk_clock_init(&c, 48000.0);
        bk_clock_advance(&c, 999.0);
        bk_clock_set_param(&c, (int)bad[j], 7.0);
        pk = 0;
        push_state(&c);
        p[0] = bad[j];
        p[1] = 7.0;
        bk_parity_emit(f, "setParam.unknown", p, 2, payload, pk, NULL, 0);
      }
    }
  }

  /* --- the grid, tempo by tempo ---------------------------------------- */

  {
    /* The point of this battery is Math.round on the boundary. At 48k,
       frames_per_beat = 2880000/bpm, so bpm values that make
       quantize * frames_per_beat land on exactly .5 are the ones that matter:
       e.g. 2880000/bpm * q = n + 0.5. 3200 frames/beat (bpm 900, out of
       range) is unreachable, but q = 0.0625 at bpm 250 gives 720.0, and
       q = 0.0625 at bpm 211 gives 852.60..., so the sweep is dense rather
       than clever: every integer bpm from 20 to 300 against every quantize
       choice, which covers the .5 landings by exhaustion.  */
    static const double quants[] = {0.0, 0.0625, 0.25, 0.5, 1.0, 2.0, 3.0, 4.0, 8.0, 16.0, 64.0};
    const int n_q = (int)(sizeof(quants) / sizeof(quants[0]));
    /* 1.0 is not a sample rate any device reports — it is here because it is
       the only way to reach the `max(1, ...)` floor on grid_frames from inside
       the legal bpm/quantize ranges: at any real rate the smallest possible
       grid is 0.0625 * 48000 * 60 / 300 = 600 frames, so the floor would never
       be tested. At sr 1 the grid rounds to 0 and the floor lifts it. */
    static const double rates[] = {48000.0, 44100.0, 96000.0, 1.0};
    const int n_r = (int)(sizeof(rates) / sizeof(rates[0]));
    static const double beats[] = {0.0,  0.0625, 0.25, 0.5,  1.0,   1.5,  2.0,
                                   3.0,  4.0,    8.0,  16.0, 32.0,  -1.0, -4.0};
    const int n_b = (int)(sizeof(beats) / sizeof(beats[0]));
    int bpm;

    for (k = 0; k < n_r; k++)
      for (i = 0; i < n_q; i++) {
        bk_clock c;
        double p[3];
        bk_clock_init(&c, rates[k]);
        bk_clock_set_param(&c, BK_CLOCK_P_QUANTIZE, quants[i]);
        pk = 0;
        for (bpm = 20; bpm <= 300; bpm++) {
          bk_clock_set_param(&c, BK_CLOCK_P_BPM, (double)bpm);
          /* Self-describing rows: the bpm and every beats value travel in the
             payload next to their result, so the JS runner reads the sweep
             back out instead of keeping a copy of these arrays. Row width is
             3 + 2 * n_b, and n_b is in the params. */
          push((double)bpm);
          push(c.frames_per_beat);
          push(c.grid_frames);
          for (j = 0; j < n_b; j++) {
            push(beats[j]);
            push(bk_clock_frames_for_beats(&c, beats[j]));
          }
        }
        p[0] = rates[k];
        p[1] = quants[i];
        p[2] = (double)n_b;
        bk_parity_emit(f, "grid", p, 3, payload, pk, NULL, 0);
      }
  }

  /* --- framesToGrid ----------------------------------------------------- */

  {
    /* Boundary behaviour is the contract, so the frames are built relative to
       the grid rather than pulled out of a hat: exactly on a boundary, one
       either side, mid-grid, and the same again far past 2^32 and 2^53/2 —
       where an int cast or a float counter would have lost the remainder. */
    static const double quants[] = {0.0, 0.0625, 0.25, 1.0, 3.0, 4.0, 16.0};
    const int n_q = (int)(sizeof(quants) / sizeof(quants[0]));
    static const double bpms[] = {20.0, 120.0, 137.0, 300.0};
    static const double bases[] = {0.0, 1.0, 7.0, 1000.0, 4294967296.0, 4503599627370496.0};
    const int n_base = (int)(sizeof(bases) / sizeof(bases[0]));
    int b, q, m;

    for (q = 0; q < n_q; q++)
      for (m = 0; m < 4; m++) {
        bk_clock c;
        double p[2];
        bk_clock_init(&c, 48000.0);
        bk_clock_set_param(&c, BK_CLOCK_P_QUANTIZE, quants[q]);
        bk_clock_set_param(&c, BK_CLOCK_P_BPM, bpms[m]);
        pk = 0;
        for (b = 0; b < n_base; b++) {
          const double g = c.grid_frames > 0.0 ? c.grid_frames : 1.0;
          /* Anchor each probe to a multiple of the grid at or below the base,
             so "exactly on a boundary" really is exact even for a huge base. */
          const double anchor = floor(bases[b] / g) * g;
          static const double offs[9] = {-1.0, 0.0, 1.0, 2.0, -2.0, 0.5, 0.25, 0.0, 1.0};
          for (i = 0; i < 9; i++) {
            /* The last two probes sit at half a grid and at the top of it. */
            const double frame = i == 7 ? anchor + floor(g / 2.0) : (i == 8 ? anchor + g - 1.0 : anchor + offs[i]);
            push(frame);
            push(bk_clock_frames_to_grid(&c, frame));
          }
          /* Non-finite and negative frames: the looper never asks for these,
             but fmod's sign rules are exactly where a port that reached for an
             integer modulo goes wrong, and the cost of pinning them is zero. */
          push(-1.5);
          push(bk_clock_frames_to_grid(&c, -1.5));
          push(-(bases[b] + 3.0));
          push(bk_clock_frames_to_grid(&c, -(bases[b] + 3.0)));
          push(NAN);
          push(bk_clock_frames_to_grid(&c, NAN));
          push(INFINITY);
          push(bk_clock_frames_to_grid(&c, INFINITY));
        }
        p[0] = quants[q];
        p[1] = bpms[m];
        bk_parity_emit(f, "framesToGrid", p, 2, payload, pk, NULL, 0);
      }
  }

  /* --- advance and the getters over a long run -------------------------- */

  {
    /* Block sizes: the two the app actually uses (128 on the web, 64/256 on
       the native device), a prime so nothing aligns with the grid, and a
       fractional one because `frame` is a double and a host that reports a
       half-frame block should not be silently truncated on one side only. */
    static const double blocks[] = {64.0, 128.0, 256.0, 113.0, 0.5};
    static const double bpms[] = {90.0, 120.0, 137.0};
    static const double bpbs[] = {3.0, 4.0, 7.0};
    int bi, mi, pi, t;

    for (bi = 0; bi < 5; bi++)
      for (mi = 0; mi < 3; mi++)
        for (pi = 0; pi < 3; pi++) {
          bk_clock c;
          double p[4];
          const int n_block = 600;
          bk_clock_init(&c, 48000.0);
          bk_clock_set_param(&c, BK_CLOCK_P_BPM, bpms[mi]);
          bk_clock_set_param(&c, BK_CLOCK_P_BEATS_PER_BAR, bpbs[pi]);
          pk = 0;
          for (t = 0; t < n_block; t++) {
            /* Stop and restart mid-run: advance() must be a no-op while
               stopped and must not lose the counter. */
            if (t == 200) bk_clock_set_param(&c, BK_CLOCK_P_RUN, 0.0);
            if (t == 250) bk_clock_set_param(&c, BK_CLOCK_P_RUN, 1.0);
            /* And a reset mid-run, which must not stop it. */
            if (t == 400) bk_clock_set_param(&c, BK_CLOCK_P_RESET, 0.0);
            bk_clock_advance(&c, blocks[bi]);
            push(c.frame);
            push(bk_clock_beat(&c));
            push(bk_clock_bar(&c));
            push(bk_clock_bar_phase(&c));
            push(bk_clock_frames_to_grid(&c, c.frame));
          }
          p[0] = blocks[bi];
          p[1] = bpms[mi];
          p[2] = bpbs[pi];
          p[3] = (double)n_block;
          bk_parity_emit(f, "advance", p, 4, payload, pk, NULL, 0);
        }
  }

  /* --- barPhase at the wrap, and a huge counter ------------------------- */

  {
    /* bar_phase is b - floor(b), which is where a counter held as a float
       would visibly quantise. Walk the frame straight to values around a bar
       boundary and far up the double's range. */
    static const double frames[] = {0.0,
                                    1.0,
                                    95999.0,
                                    96000.0, /* exactly 2 bars at 120bpm/4 */
                                    96001.0,
                                    1e6,
                                    1e9,
                                    4294967295.0,
                                    4294967296.0,
                                    1e12,
                                    9007199254740992.0, /* 2^53 */
                                    -1.0,
                                    -96000.5};
    const int n = (int)(sizeof(frames) / sizeof(frames[0]));
    static const double bpms[] = {120.0, 137.0};
    int m;
    for (m = 0; m < 2; m++) {
      bk_clock c;
      double p[1];
      bk_clock_init(&c, 48000.0);
      bk_clock_set_param(&c, BK_CLOCK_P_BPM, bpms[m]);
      pk = 0;
      for (i = 0; i < n; i++) {
        c.frame = frames[i];
        push(frames[i]);
        push(bk_clock_beat(&c));
        push(bk_clock_bar(&c));
        push(bk_clock_bar_phase(&c));
      }
      p[0] = bpms[m];
      bk_parity_emit(f, "barPhase", p, 1, payload, pk, NULL, 0);
    }
  }

  /* --- scripted sequences ---------------------------------------------- */

  {
    /* Order-dependent facts, one script each. The comment on each row says
       what it is pinning; if a row's expectation is unclear, the script is
       wrong rather than the port. */

    /* bpm recomputes the grid; beatsPerBar does not. */
    static const double s_order[] = {
        OP_PARAM,   BK_CLOCK_P_QUANTIZE,     4.0,  /* grid = 4 * 24000 = 96000 */
        OP_SNAP,    0,                       0,
        OP_PARAM,   BK_CLOCK_P_BEATS_PER_BAR, 7.0, /* grid unchanged */
        OP_SNAP,    0,                       0,
        OP_PARAM,   BK_CLOCK_P_BPM,          137.0, /* grid recomputed */
        OP_SNAP,    0,                       0,
        OP_PARAM,   BK_CLOCK_P_QUANTIZE,     0.0,   /* grid off */
        OP_SNAP,    0,                       0,
        OP_TOGRID,  0.0,                     0,     /* 0 while off */
        OP_TOGRID,  12345.0,                 0,
        OP_PARAM,   BK_CLOCK_P_QUANTIZE,     1.0,   /* back on, from off */
        OP_SNAP,    0,                       0,
        OP_TOGRID,  0.0,                     0,     /* a whole grid, not 0 */
        OP_END,     0,                       0};

    /* reset does not stop, and run=0 does not reset. */
    static const double s_transport[] = {
        OP_ADVANCE, 1000.0, 0,
        OP_SNAP,    0,      0,
        OP_RESET,   0,      0,
        OP_SNAP,    0,      0,     /* frame 0, still running */
        OP_ADVANCE, 128.0,  0,
        OP_SNAP,    0,      0,     /* so this advanced */
        OP_PARAM,   BK_CLOCK_P_RUN, 0.0,
        OP_ADVANCE, 128.0,  0,
        OP_ADVANCE, 128.0,  0,
        OP_SNAP,    0,      0,     /* frame did not move */
        OP_PARAM,   BK_CLOCK_P_RESET, 0.0,
        OP_SNAP,    0,      0,     /* reset while stopped: frame 0, still stopped */
        OP_PARAM,   BK_CLOCK_P_RUN, 1.0,
        OP_ADVANCE, 128.0,  0,
        OP_SNAP,    0,      0,
        OP_END,     0,      0};

    /* A rate change mid-flight (the device switched), then the grid readings
       the looper would take. init() is a full re-construct, so the counter and
       every param go back to the defaults — pinned here because a port that
       "helpfully" preserved the tempo would pass everything else. */
    static const double s_reinit[] = {
        OP_PARAM,   BK_CLOCK_P_BPM,      174.0,
        OP_PARAM,   BK_CLOCK_P_QUANTIZE, 0.25,
        OP_ADVANCE, 4096.0,              0,
        OP_SNAP,    0,                   0,
        OP_INIT,    44100.0,             0,
        OP_SNAP,    0,                   0,
        OP_FORBEATS, 4.0,                0,
        OP_FORBEATS, 0.25,               0,
        OP_INIT,    96000.0,             0,
        OP_FORBEATS, 4.0,                0,
        OP_SNAP,    0,                   0,
        OP_END,     0,                   0};

    /* The counter walked to where doubles stop being able to hold every
       integer, with the grid still expected to be exact underneath 2^53. */
    static const double s_far[] = {
        OP_PARAM,  BK_CLOCK_P_QUANTIZE, 1.0,
        OP_FRAME,  4503599627370496.0,  0, /* 2^52 */
        OP_SNAP,   0,                   0,
        OP_TOGRID, 4503599627370496.0,  0,
        OP_ADVANCE, 1.0,                0,
        OP_TOGRID, 4503599627370497.0,  0,
        OP_FRAME,  9007199254740992.0,  0, /* 2^53: +1 no longer representable */
        OP_ADVANCE, 1.0,                0,
        OP_SNAP,   0,                   0,
        OP_END,    0,                   0};

    /* Every setter fed a NaN in sequence, so NaN contamination of one field
       cannot be mistaken for contamination of another. */
    static const double s_nan[] = {
        OP_ADVANCE, 500.0,                    0,
        OP_PARAM,   BK_CLOCK_P_BEATS_PER_BAR, NAN,
        OP_SNAP,    0,                        0,
        OP_PARAM,   BK_CLOCK_P_BEATS_PER_BAR, 4.0,
        OP_PARAM,   BK_CLOCK_P_QUANTIZE,      NAN,
        OP_SNAP,    0,                        0,
        OP_TOGRID,  100.0,                    0,
        OP_PARAM,   BK_CLOCK_P_QUANTIZE,      4.0,
        OP_PARAM,   BK_CLOCK_P_BPM,           NAN,
        OP_SNAP,    0,                        0,
        OP_FORBEATS, 4.0,                     0,
        OP_PARAM,   BK_CLOCK_P_BPM,           120.0,
        OP_SNAP,    0,                        0, /* recovered: finite again */
        OP_END,     0,                        0};

    /* A plausible live-set sequence: arm a grid, play, change tempo on the
       fly, reset on the downbeat. Nothing exotic — it is the integration case,
       and it is the one that would catch an interaction the single-call
       batteries each miss. */
    static const double s_live[] = {
        OP_PARAM,   BK_CLOCK_P_BPM,           128.0,
        OP_PARAM,   BK_CLOCK_P_BEATS_PER_BAR, 4.0,
        OP_PARAM,   BK_CLOCK_P_QUANTIZE,      4.0,
        OP_SNAP,    0,                        0,
        OP_TOGRID,  0.0,                      0,
        OP_ADVANCE, 128.0,                    0,
        OP_TOGRID,  128.0,                    0,
        OP_ADVANCE, 128.0,                    0,
        OP_SNAP,    0,                        0,
        OP_PARAM,   BK_CLOCK_P_BPM,           132.0,
        OP_SNAP,    0,                        0,
        OP_TOGRID,  256.0,                    0,
        OP_PARAM,   BK_CLOCK_P_QUANTIZE,      1.0,
        OP_TOGRID,  256.0,                    0,
        OP_RESET,   0,                        0,
        OP_ADVANCE, 128.0,                    0,
        OP_SNAP,    0,                        0,
        OP_FORBEATS, 4.0,                     0,
        OP_FORBEATS, 16.0,                    0,
        OP_END,     0,                        0};

    static const struct {
      const double *ops;
      size_t n;
    } scripts[] = {{OPS(s_order)}, {OPS(s_transport)}, {OPS(s_reinit)},
                   {OPS(s_far)},   {OPS(s_nan)},       {OPS(s_live)}};
    const int n_s = (int)(sizeof(scripts) / sizeof(scripts[0]));
    for (i = 0; i < n_s; i++) run_script(f, "script", scripts[i].ops, scripts[i].n);
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
