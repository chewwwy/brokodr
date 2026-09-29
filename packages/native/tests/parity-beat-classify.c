/*
 * Parity battery for Smart Voice. See parity-io.h for the stream format and
 * scripts/verify-beat-classify-parity.mjs for the side that replays it through
 * the original JavaScript.
 *
 * This is the first module in the port whose behaviour depends on another
 * module's *live internal state* rather than on its return value. Smart Voice
 * reads `det.fastLow.env`, `det.level.env` and `det.strengths[h]` directly out
 * of the detector, and it reads them one block *after* the block the onset was
 * found in. So there are two clocks here, and the battery has to watch both:
 *
 *   - the detector's, which decides when an onset exists at all;
 *   - the pending table's, which decides when stage 1 reads the envelopes and
 *     when stage 2 gets the finished features.
 *
 * A port that gets the arithmetic perfect and the *timing* off by one block
 * produces the same hits with the wrong velocities and the wrong classes, and
 * nothing that only looks at the end of a pass would see it. That is why the
 * pending table is snapshotted after every block rather than at the end, and
 * why STAGE1_DELAY_BLOCKS is exposed in the header.
 *
 * Layers, as in parity-onset.c:
 *
 *   1. EXACT. Defaults, the factory profile, every parameter clamp, the four
 *      ToInt32 setters, velocityFrom and classify on known vectors, and the
 *      level-dB path that carries hazard 1. No libm on any path here except
 *      log10 inside velocityFrom's input, so these are held to exact equality
 *      and are a hard gate.
 *
 *   2. BEHAVIOURAL. Whole passes of synthetic kit audio through process(),
 *      block by block: what fired, what the meters read, and the entire
 *      pending table at every block boundary. Plus the calibration capture
 *      ring, which is the only consumer of pendBand and pendStrength.
 *
 *   3. STRUCTURAL. reset() and resetDetector() leave exactly the fields they
 *      promise and no others; the capture ring reports staleness at the right
 *      boundaries; a fired class is always in range (hazard 3); the int32
 *      pending id wrap behaves as the JS's Int32Array does (hazard 2).
 *
 * ## The stimulus
 *
 * Identical to parity-onset.c's, down to the LCG seed: integer arithmetic and
 * IEEE-754 add/sub/mul/div only, never sin() or exp(), so JavaScript
 * reproduces it bit for bit. It is duplicated here rather than shared because
 * these two files are the specification of their own batteries — a shared
 * generator that changed would silently rewrite both, and onset's pinned
 * baselines are the thing that must not move.
 *
 * ## Reaching hazard 2 without three years of beatboxing
 *
 * `pendId` is an Int32Array and `onsetCount` is not, so past 2^31 onsets every
 * stage 2 is skipped forever. Rather than process 2^31 onsets, the battery
 * pokes the three counters — onsetCount, drained and the detector's
 * commitCount — to just below the boundary and runs a handful of hits across
 * it. Both languages perform the identical poke on the identical fields, so
 * the record measures the wrap and not the poke. This is legitimate precisely
 * because these are plain fields in both languages with no invariant between
 * them that the poke breaks: they are all "how many onsets have happened", and
 * setting all three to the same number is a state the detector reaches on its
 * own given enough time.
 *
 * ## What is deliberately not tested here
 *
 * The detector's own arithmetic. Every band energy, position and feature Smart
 * Voice consumes is already pinned bit-for-bit by parity-onset.c against the
 * same JS, on a superset of these signals. Re-checking it here would measure
 * the same thing twice and make a real Smart Voice failure harder to find in
 * the diff. What this battery checks about the detector is only what Smart
 * Voice *does with it*: which fields it reads, and when.
 */

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include "brokodr/dsp/beat-classify.h"
#include "parity-io.h"

#define MAX_FRAMES 262144
#define MAX_BLOCKS 96

/* Waveform shapes. Mirrors parity-onset.c's enum exactly. */
enum {
  STIM_CLICK = 0,
  STIM_KICK = 1,
  STIM_HAT = 2,
  STIM_SNARE = 3,
  STIM_SILENCE = 4,
  STIM_DC = 5,
  STIM_NOISE = 6
};

/* Mirrored verbatim in verify-beat-classify-parity.mjs, and identical to
   parity-onset.c's. Everything that advances state advances on the same
   schedule regardless of which waveform is selected. */
static void stim(double *dst, size_t n, double sr, int kind, int hits, double gap_ms, double amp,
                 int poison) {
  unsigned int state = 0x2468ace0u;
  double prev_noise = 0.0;
  size_t i;
  int h, hp = 1;

  for (i = 0; i < n; i++) dst[i] = 0.0;

  if (kind == STIM_SILENCE) {
    /* fall through to poisoning */
  } else if (kind == STIM_DC) {
    for (i = 0; i < n; i++) dst[i] = amp;
  } else if (kind == STIM_NOISE) {
    bk_fill_signal(dst, n, BK_SIG_NOISE);
    for (i = 0; i < n; i++) dst[i] = dst[i] * amp;
  } else {
    hp = bk_onset_to_int32(sr / 120.0);
    if (hp < 1) hp = 1;

    for (h = 0; h < hits; h++) {
      int start_i = bk_onset_to_int32((double)h * gap_ms * 0.001 * sr);
      size_t start, k;
      double env = amp;
      double decay = (kind == STIM_HAT) ? 0.997 : 0.9995;

      if (start_i < 0) continue;
      start = (size_t)start_i;

      for (k = 0; start + k < n; k++) {
        double noise, diff, w;

        state = state * 1664525u + 1013904223u;
        noise = ((double)(state >> 8) / 16777216.0) * 2.0 - 1.0;
        diff = noise - prev_noise;
        prev_noise = noise;

        if (kind == STIM_CLICK) w = (k == 0) ? 1.0 : 0.0;
        else if (kind == STIM_KICK) w = ((k / (size_t)hp) & 1u) ? -1.0 : 1.0;
        else if (kind == STIM_HAT) w = diff * 0.5;
        else w = (((k / (size_t)hp) & 1u) ? -0.5 : 0.5) + diff * 0.25;

        dst[start + k] += env * w;
        env = env * decay;
        if (env < 1.0 / 1048576.0) break;
      }
    }
  }

  if (poison) {
    if (n > 16) {
      dst[n / 8] = NAN;
      dst[n / 4] = INFINITY;
      dst[n / 4 + 1] = -INFINITY;
    }
  }
}

/* --- case table --------------------------------------------------------- */

/*
 * One Smart Voice case. NaN in a parameter slot means "leave at the default",
 * which is what a non-finite opts entry already does.
 *
 * `enabled` is a parameter like any other and its default is *off*, so a case
 * that leaves it at D processes nothing at all. One case does exactly that on
 * purpose; every other sets it to 1.
 */
typedef struct {
  const char *name;
  double sr;
  int kind;
  int hits;
  double gap_ms;
  double amp;
  int n;
  int block_size;
  int poison;
  /* the ten VOICE_KEY parameters, in enum order */
  double enabled, sens, floor_db, min_gap, feature_ms, mode, margin, vel_min, vel_db, monitor;
  /* harness knobs, applied before the pass */
  int capture_cls;        /* >= 0: set_capture(cls) before processing */
  int enable_at_block;    /* >= 0: set_param(ENABLED, 1) after that block */
  double counter_seed;    /* > 0: poke onset_count, drained and det.commit_count */
  int centroid_poke;      /* 1: rewrite one centroid and one class pad first */
  int disable_at_block;   /* >= 0: set_param(ENABLED, 0) after that block */
  int drain_lag;          /* > 0, with counter_seed: seed `drained` that far back */
} voice_case;

#define D NAN

/* The near-wrap seed: three onsets short of 2^31, so ids 2147483645 through
   2147483647 store cleanly and everything from 2147483648 up stores negative
   and never matches again. Exactly representable as a double. */
#define WRAP_SEED 2147483645.0

static const voice_case CASES[] = {
    /* name             sr     kind        hits gap    amp    n      blk  poi  en   sens flr  gap  feat mode marg vmin vdb  mon  cap eab  seed  poke dab lag */
    /* --- the four kit sounds, everything at default ------------------- */
    {"click-4",         48000, STIM_CLICK,   4, 120.0, 0.5,   32768, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"kick-4",          48000, STIM_KICK,    4, 200.0, 0.5,   65536, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"hat-6",           48000, STIM_HAT,     6, 90.0,  0.5,   32768, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"snare-4",         48000, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* --- the disabled path: enabled left at its default of off -------- */
    {"disabled",        48000, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   D,   D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* Enabled part-way through, which is what the UI toggle does. The
       enable calls resetDetector(), so every onset already pending is
       abandoned and the hits before the toggle must not fire late.
       STIM_SNARE, not STIM_CLICK: a row about hits that must *not* fire late
       is worthless unless the later hits fire at all. See the note on
       STIM_CLICK's reach above the case table. */
    {"enable-midway",   48000, STIM_SNARE,   6, 120.0, 0.5,   49152, 128, 0,   D,   D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, 60,  0.0,  0, -1, 0},
    /* The other direction, which is not the mirror image of it. Enabling
       resets the detector; disabling does not, and nothing in the module
       un-does a disable's absence of a reset. Both facts are invisible on a
       voice that was never running: at construction, and on "enable-midway"
       where the pass up to the toggle is all early returns, the detector the
       reset clears is already clear, so the reset is a no-op and a port that
       reset on the wrong edge of the toggle — or on both — reads identically.
       This row is the one that has state worth keeping: enabled from the
       start, a dense hat burst wide open so that almost every block fires,
       and then the toggle off part-way through. After it, `onsetCount`, the
       level and the pending table have to still be there, and the fire count
       the disabled blocks report has to be zero rather than the last enabled
       block's. */
    {"disable-midway",  48000, STIM_HAT,    60, 6.0,   0.5,   49152, 128, 0,   1.0, 1.05, -90.0, 5.0, 8.0, 0.0, 0.62, D, D, D, -1, -1,  0.0,  0, 40, 0},
    /* And one where the toggle off lands immediately after a block that fired,
       which is what makes the *order* of the two statements at the top of
       process() observable: the fire count is cleared before the disabled
       early return, not after it, so a disabled block reports no fires rather
       than repeating the last enabled block's. Big blocks and a dense burst
       so that every enabled block here fires and the row cannot quietly stop
       measuring that if the detector's timing shifts. */
    {"disable-after-fire",48000,STIM_HAT,    60, 6.0,   0.5,  131072, 4096, 0,  1.0, 1.05, -90.0, 5.0, 60.0, 0.0, 0.50, D, D, D, -1, -1,  0.0,  0, 3, 0},
    /* --- the two modes ------------------------------------------------ */
    /* FAST with a wide margin commits at stage 1 on nearly every hit;
       ACCURATE never commits at stage 1 at all. The two records differ in
       which stage every fire reports, which is the whole point of the mode. */
    {"fast-wide",       48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.99, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"fast-narrow",     48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.05, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"accurate",        48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   1.0, D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"accurate-wide",   48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   1.0, 0.99, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* --- corrections: stage 2 disagreeing with a stage-1 commit -------- */
    /* A hat burst in FAST with a wide margin fires at stage 1 off three band
       shares and is then re-judged at stage 2 on four features including zcr.
       Where the two disagree the corrections counter moves, and that counter
       is the only observable of the disagreement. */
    {"corrections-hat", 48000, STIM_HAT,    12, 70.0,  0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.99, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"corrections-mix", 48000, STIM_SNARE,  12, 70.0,  0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.99, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* --- velocity mapping through a whole pass ------------------------- */
    {"vel-min-high",    48000, STIM_KICK,    4, 200.0, 0.5,   65536, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   0.95, D,  D,   -1, -1,  0.0,  0, -1, 0},
    {"vel-db-narrow",   48000, STIM_KICK,    4, 200.0, 0.5,   65536, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   3.0, D,   -1, -1,  0.0,  0, -1, 0},
    {"vel-db-wide",     48000, STIM_KICK,    4, 200.0, 0.5,   65536, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   60.0, D,  -1, -1,  0.0,  0, -1, 0},
    /* floorDb is the one parameter with two different clamps on one value:
       Smart Voice keeps [-90, -6] for the velocity map and forwards the raw
       number to the detector's own range. At -90 and -6 both agree; outside
       them they do not, and the gate and the velocity floor move apart. */
    {"floor-low",       48000, STIM_KICK,    4, 120.0, 0.001953125, 32768, 128, 0, 1.0, D, -90.0, D, D, D, D, D, D, D,  -1, -1,  0.0,  0, -1, 0},
    {"floor-high",      48000, STIM_KICK,    4, 120.0, 0.5,   32768, 128, 0,   1.0, D,   -6.0, D,  D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"floor-beyond",    48000, STIM_KICK,    4, 120.0, 0.5,   32768, 128, 0,   1.0, D,   -200.0, D, D,  D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* --- calibration capture ------------------------------------------ */
    /* Capturing suppresses firing unless monitor is on, so these two cases
       differ only in whether anything reaches the rack while training. */
    {"cap-kick",        48000, STIM_KICK,    6, 200.0, 0.5,   98304, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,    0, -1,  0.0,  0, -1, 0},
    {"cap-kick-mon",    48000, STIM_KICK,    6, 200.0, 0.5,   98304, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   1.0,  0, -1,  0.0,  0, -1, 0},
    {"cap-hat",         48000, STIM_HAT,    12, 70.0,  0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,    2, -1,  0.0,  0, -1, 0},
    /* Capturing in FAST with a wide margin: stage 1 would have fired, and
       the capture gate has to stop it there as well as at stage 2. */
    {"cap-fast",        48000, STIM_SNARE,   8, 110.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.99, D,  D,   D,    1, -1,  0.0,  0, -1, 0},
    /* More captures than the ring holds, so the oldest are overwritten and
       readCapture's staleness boundary is somewhere in the middle. */
    {"cap-overrun",     48000, STIM_CLICK,  80, 12.0,  0.5,   65536, 128, 0,   1.0, 1.05, -90.0, 5.0, 3.0, D, D,  D,   D,   D,    3, -1,  0.0,  0, -1, 0},
    /* --- muting: a class with pad -1 counts as a hit and fires nothing -- */
    {"pad-poke",        48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  1, -1, 0},
    /* --- the fire array's ceiling ------------------------------------- */
    /* One block long enough to hold twelve hits at the shortest legal gap.
       Registration happens in that block and every stage 1 comes due in the
       next one, so a single block tries to fire more hits than FIRE_MAX has
       room for and emit's `fire_count >= FIRE_MAX` guard is the only thing
       standing between the battery and a buffer overrun. */
    {"fire-overflow",   48000, STIM_CLICK,  12, 6.0,   0.5,   32768, 16384, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* The same, capturing, so the capture ring and the fire ceiling are
       exercised together and the capture writes happen at the same instant
       the fire array is refusing new rows. */
    {"fire-overflow-cap", 48000, STIM_CLICK, 12, 6.0,  0.5,   32768, 16384, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D,  D,   D,    1, -1,  0.0,  0, -1, 0},
    /* Both rows above overshoot the ceiling so hard that they never sit *on*
       it: the guard turns emit away with fire_count far past FIRE_MAX, which
       `>=` and `>` both do. To tell the two apart a block has to attempt
       exactly a ninth fire, with fire_count == FIRE_MAX on entry, and that is
       a much narrower target than "lots of hits".
       The arithmetic: a 2000-frame block at 48 kHz holds eight hits at a 5 ms
       gap (8 * 240 = 1920) with 80 frames of slack, so the hit phase drifts
       80 frames per block and cycles through six alignments. On the
       alignments where the eighth hit lands at least feature_ms (3 ms = 144
       frames) before the block ends, all eight of this block's feature
       windows close inside it — and the previous block's straggler, whose
       window this block's first hit closes early, commits here too. Nine
       commits drain in one block, the first eight fill the fire array, and
       the ninth is the attempt that separates the two operators. Seven such
       blocks occur over the pass. */
    {"fire-ceiling-exact", 48000, STIM_CLICK, 200, 5.0, 0.6,  65536, 2000, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, 0.99, D, D, D,  -1, -1,  0.0,  0, -1, 0},
    /* --- the pending table's wrap-around ------------------------------ */
    /* Sixteen hits fills the pending table exactly; twenty-four overruns it,
       which is when the drain's `drained < commit_count - PEND_SLOTS` catch-up
       is the only thing keeping stage 2 attributing features to the right hit. */
    {"pend-exact",      48000, STIM_HAT,    16, 50.0,  0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"pend-overrun",    48000, STIM_HAT,    24, 50.0,  0.5,   65536, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* ...except that the drain empties the ring on every call it is given, so
       neither of those rows ever leaves `drained` behind to catch up: the
       clamp is reached with nothing to do. The lag has to be poked in. Twenty
       four is chosen to sit between PEND_SLOTS and CAP_SLOTS, so it separates
       the clamp that is there from a clamp written against the wrong constant:
       at that distance the first moves `drained` forward and the second does
       not, and the entry the un-clamped read asks for is one the commit ring
       has already overwritten. */
    {"drain-lag-24",    48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  4096.0, 0, -1, 24},
    {"drain-lag-24-fast",48000,STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.99, D,  D,   D,   -1, -1,  4096.0, 0, -1, 24},
    /* --- hazard 2: the int32 pending id ------------------------------- */
    /* Six hits, so ids WRAP_SEED+0..2 store cleanly and WRAP_SEED+3..5 store
       negative: the boundary is crossed *inside* the pass rather than before
       it. STIM_SNARE because the wrap is only observable on ids that a real
       onset actually allocated. */
    {"wrap-int32",      48000, STIM_SNARE,   6, 120.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  WRAP_SEED, 0, -1, 0},
    {"wrap-int32-fast", 48000, STIM_SNARE,   6, 120.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.99, D,  D,   D,   -1, -1,  WRAP_SEED, 0, -1, 0},
    /* --- block sizes: the pending table's clock is in blocks ---------- */
    /* STAGE1_DELAY_BLOCKS is one *block*, not a duration, so the block size
       changes how long stage 1 waits in real time and therefore which
       envelope values it reads. These records are not expected to agree with
       each other — they are expected to agree with the JS at each size, which
       is what pins the clock rather than the arithmetic. */
    {"blk-1",           48000, STIM_SNARE,   3, 120.0, 0.5,   16384, 1,   0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"blk-64",          48000, STIM_SNARE,   3, 120.0, 0.5,   16384, 64,  0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"blk-128",         48000, STIM_SNARE,   3, 120.0, 0.5,   16384, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"blk-1024",        48000, STIM_SNARE,   3, 120.0, 0.5,   16384, 1024, 0,  1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* --- sample rates ------------------------------------------------- */
    {"sr-8k",            8000, STIM_SNARE,   4, 150.0, 0.5,   16384, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"sr-44k1",         44100, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"sr-96k",          96000, STIM_SNARE,   4, 150.0, 0.5,   98304, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"sr-192k",        192000, STIM_SNARE,   4, 100.0, 0.5,  196608, 256, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* Falsy and NaN rates, both of which fall back to 48 kHz — and the
       detector is constructed with the *already defaulted* rate, so a port
       that passed the raw argument would build its filters at 0 Hz. */
    {"sr-falsy",            0, STIM_SNARE,   4, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"sr-nan",            NAN, STIM_CLICK,   1, 0.0,   0.5,   16384, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* --- degenerate input -------------------------------------------- */
    /* Silence and DC both leave the band total at or near zero, which is the
       `total > 1e-12` else-arm in stage 1 — the leg of hazard 3's argument
       that says a dead signal yields three exact zeros and not three NaNs. */
    {"silence",         48000, STIM_SILENCE, 0, 0.0,   0.0,   16384, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"dc-step",         48000, STIM_DC,      0, 0.0,   0.5,   16384, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"empty",           48000, STIM_CLICK,   0, 0.0,   0.0,   0,     128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"one-sample",      48000, STIM_CLICK,   1, 0.0,   0.5,   1,     128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* A quiet hat burst at a sample rate low enough that the feature window
       collapses to one frame. parity-onset measured this case's band-share
       total straddling 1e-12; here it is the *stage-1* total that gets that
       small, which is the other place the guard can fire. */
    {"qtw",               333, STIM_HAT,     8, 400.0, 0.000030517578125, 2048, 128, 0, 1.0, 1.5, -90.0, 50.0, 3.0, D, D, D, D, D, -1, -1, 0.0, 0, -1, 0},
    /* --- non-finite samples ------------------------------------------ */
    /*
     * What a non-finite sample actually does, measured rather than assumed.
     *
     * It does *not* reach bk_gain_to_db. The detector sanitizes its input one
     * statement into the sample loop — `isfinite(x) ? x : 0.0`, onset.c — so
     * no follower, no band total and no level env ever sees the NaN, and Smart
     * Voice reads nothing else from the stream: it consumes detector state
     * only. These rows therefore pin the *scrub*, which is the property worth
     * having: a poisoned block must leave a live detector still firing, with
     * every meter and every velocity finite. A port that dropped the scrub
     * would poison the followers permanently and these rows would go silent.
     *
     * Hazard 1 — Math.max propagating a NaN where fmax would invent -180 dB —
     * is consequently unreachable from the stream and is pinned directly, at
     * the composed call site, by the "level-db" records in layer 1.
     *
     * STIM_SNARE so the detector is firing while it is poisoned; the first row
     * is the same case un-poisoned, as the neighbour to diff against.
     */
    {"poison-clean",    48000, STIM_SNARE,   4, 120.0, 0.5,   32768, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"poison-silence",  48000, STIM_SILENCE, 0, 0.0,   0.0,   16384, 128, 1,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"poison-stream",   48000, STIM_SNARE,   4, 120.0, 0.5,   32768, 128, 1,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"poison-fast",     48000, STIM_SNARE,   4, 120.0, 0.5,   32768, 128, 1,   1.0, D,   D,   D,   D,   0.0, 0.99, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"poison-cap",      48000, STIM_SNARE,   4, 120.0, 0.5,   32768, 128, 1,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,    0, -1,  0.0,  0, -1, 0},
    /*
     * The rows above poison at block_size 128, where the NaN lands at sample
     * n/8 = 4096 — block 32 — and no onset is ever *detected* in block 31, so
     * no pending slot is ever read one block later with the envelopes already
     * NaN. Stage 1's `total > 1e-12` false arm is therefore only ever taken on
     * near-silence by those rows, never on a NaN, and the arm exists for the
     * NaN: it is what stops a NaN envelope becoming a NaN feature vector and
     * hence a classify that returns -1 and trips emit's assert.
     *
     * block_size 4096 with n 32768 puts the NaN at the first sample of block 1
     * and gives block 0 the whole 4096-sample head of the first snare, so the
     * hit at sample 0 is detected inside block 0 (the 8 ms detector lag is 384
     * samples), its slot is left with pend_wait 1, and stage 1 reads it in
     * block 1 — after bk_onset_process has already driven every envelope NaN.
     * That is the only row in the roster that takes the false arm on a NaN.
     */
    {"poison-stage1-nan", 48000, STIM_SNARE, 4, 120.0, 0.5, 32768, 4096, 1, 1.0, D, D, D, D, D,  D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"poison-stage1-fast",48000, STIM_SNARE, 4, 120.0, 0.5, 32768, 4096, 1, 1.0, D, D, D, D, 0.0, 0.99, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* --- noise, which a live detector must mostly ignore -------------- */
    {"noise-broadband", 48000, STIM_NOISE,   0, 0.0,   0.5,   32768, 128, 0,   1.0, D,   D,   D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"noise-quiet",     48000, STIM_NOISE,   0, 0.0,   0.001953125, 32768, 128, 0, 1.0, D, D, D,   D,   D,   D,   D,   D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* --- the margin grid --------------------------------------------- */
    /*
     * The stage-1 commit test is `scratchRatio < margin`, and one comparison
     * against one number is the whole of the difference between FAST and
     * ACCURATE. A case that sets margin wide commits everything and a case
     * that sets it narrow commits nothing; neither says anything about where
     * the boundary actually is, because in both the ratio is nowhere near it.
     *
     * These nineteen rows tile [0.05, 1.0) at the grid the ratio lives on, so
     * whatever ratio this stimulus produces at each hit, some row has a margin
     * that sits just below it and the next row's margin just above. A port
     * whose comparison is shifted by any amount up to a grid step — the wrong
     * operator, an epsilon, a margin read before its clamp — lands on the
     * wrong side of it in at least one row and the fire count moves.
     *
     * Identical to "fast-narrow" in every other field, so the grid is the only
     * variable and the rows diff cleanly against each other.
     */
    {"margin-005",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.05, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-010",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.10, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-015",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.15, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-020",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.20, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-025",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.25, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-030",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.30, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-035",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.35, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-040",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.40, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-045",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.45, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-050",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.50, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-055",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.55, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-060",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.60, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-065",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.65, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-070",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.70, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-075",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.75, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-080",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.80, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-085",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.85, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-090",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.90, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    {"margin-095",      48000, STIM_SNARE,   6, 150.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.95, D,  D,   D,   -1, -1,  0.0,  0, -1, 0},
    /* --- stage 1 reading a decayed envelope --------------------------- */
    /*
     * `total > 1e-12` in stage 1, approached from above rather than from
     * silence. The band followers are fast and stage 1 reads them one *block*
     * late, so at a big block and a low rate the hit is already tens of
     * milliseconds gone by the time its share vector is built, and the total
     * is whatever is left of a decaying envelope rather than either a live hit
     * or an exact zero.
     *
     * The block size is the only variable across the family because it is the
     * only thing that sets how far the envelope has fallen. Somewhere in this
     * sweep the total lands between 1e-15 and 1e-12, which is the one region
     * where the guard's constant matters and where the else-arm's exact zeros
     * are distinguishable from the (tiny, non-zero) envelopes themselves.
     */
    {"decay-256",        8000, STIM_SNARE,   2, 200.0, 0.5,   16384, 256, 0,   1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D,  -1, -1,  0.0,  0, -1, 0},
    {"decay-512",        8000, STIM_SNARE,   2, 200.0, 0.5,   16384, 512, 0,   1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D,  -1, -1,  0.0,  0, -1, 0},
    {"decay-1024",       8000, STIM_SNARE,   2, 200.0, 0.5,   16384, 1024, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D,  -1, -1,  0.0,  0, -1, 0},
    {"decay-2048",       8000, STIM_SNARE,   2, 200.0, 0.5,   16384, 2048, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D,  -1, -1,  0.0,  0, -1, 0},
    {"decay-4096",       8000, STIM_SNARE,   2, 200.0, 0.5,   16384, 4096, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D,  -1, -1,  0.0,  0, -1, 0},
    {"decay-8192",       8000, STIM_SNARE,   2, 200.0, 0.5,   32768, 8192, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D,  -1, -1,  0.0,  0, -1, 0},
    {"decay-hat-2048",   8000, STIM_HAT,     2, 200.0, 0.5,   16384, 2048, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D,  -1, -1,  0.0,  0, -1, 0},
    {"decay-hat-4096",   8000, STIM_HAT,     2, 200.0, 0.5,   16384, 4096, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D,  -1, -1,  0.0,  0, -1, 0},
    {"decay-qtw",         333, STIM_HAT,     8, 400.0, 0.000030517578125, 2048, 512, 0, 1.0, 1.5, -90.0, 50.0, 3.0, D, D, D, D, D, -1, -1, 0.0, 0, -1, 0},
    /* --- stage 1's `total > 1e-12` guard, from just above it -----------
       One quiet click at 8 kHz followed by two full blocks of silence: the
       fast envelopes decay for roughly two block lengths before stage 1
       reads them, so e_lo^2+e_mid^2+e_hi^2 lands in the decade or two just
       above 1e-12 rather than at a healthy magnitude or at zero. That is the
       only place the guard's constant is observable: anywhere louder and any
       plausible threshold passes, anywhere quieter and any plausible
       threshold fails. Block length is what tunes the decay time here, so
       three lengths bracket the window rather than trusting one. */
    {"eps-total-1792",   8000, STIM_CLICK,   1, 500.0, 0.001, 5376, 1792, 0, 1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D, -1, -1, 0.0, 0, -1, 0},
    {"eps-total-2304",   8000, STIM_CLICK,   1, 500.0, 0.001, 6912, 2304, 0, 1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D, -1, -1, 0.0, 0, -1, 0},
    {"eps-total-2560",   8000, STIM_CLICK,   1, 500.0, 0.001, 7680, 2560, 0, 1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D, -1, -1, 0.0, 0, -1, 0},
    /* --- captures with several onsets in flight ----------------------- */
    /*
     * The capture ring's attack columns come from `pendBand[slot]`, not from
     * `lastBand`, and the two are the same number whenever only one onset is
     * ever in flight: stage 1 writes both, and if no other stage 1 runs before
     * that slot's stage 2 the global copy still holds the slot's vector.
     *
     * Every capture row before these is that case. At a block big enough to
     * hold several hits, four stage 1s run back to back and only the last
     * one's vector survives in `lastBand`, so a capture written from the
     * global copy records the wrong hit's attack for every slot but one.
     */
    {"cap-flight",      48000, STIM_HAT,    40, 8.0,   0.5,   65536, 1024, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D,   0, -1,  0.0,  0, -1, 0},
    {"cap-flight-mon",  48000, STIM_HAT,    40, 8.0,   0.5,   65536, 1024, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, 1.0, 0, -1,  0.0,  0, -1, 0},
    {"cap-flight-snare",48000, STIM_SNARE,  40, 8.0,   0.5,   65536, 2048, 0,  1.0, 1.05, -90.0, 5.0, 3.0, D, D, D, D, D,   1, -1,  0.0,  0, -1, 0},
    /* --- monitoring while capturing, decided at stage 2 --------------- */
    /*
     * `!capturing || monitor` guards the stage-2 fire. "cap-kick-mon" turns
     * monitor on but leaves the mode at FAST with the default margin, so its
     * hits commit at stage 1 and the stage-2 gate is never the thing that lets
     * them through. These rows take stage 1 out of the picture — ACCURATE, and
     * FAST with a margin too narrow to ever commit — so every fire in them is
     * a stage-2 fire that happened *because* monitor is on.
     */
    {"cap-mon-acc",     48000, STIM_KICK,    6, 200.0, 0.5,   98304, 128, 0,   1.0, D,   D,   D,   D,   1.0, D,   D,   D,   1.0,  0, -1,  0.0,  0, -1, 0},
    {"cap-mon-narrow",  48000, STIM_SNARE,   8, 110.0, 0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   0.0, 0.0, D,   D,   1.0,  1, -1,  0.0,  0, -1, 0},
    {"cap-mon-hat-acc", 48000, STIM_HAT,    12, 70.0,  0.5,   49152, 128, 0,   1.0, D,   D,   D,   D,   1.0, D,   D,   D,   1.0,  2, -1,  0.0,  0, -1, 0},
    /* --- both stages firing in the same block ------------------------- */
    /*
     * The fire array holds FIRE_MAX rows and the detector finds at most
     * MAX_HITS onsets per call, so a block can only overrun the array if
     * stage 1 and stage 2 both fire in it, for *different* onsets. That needs
     * a margin in the middle — wide enough that some hits commit early,
     * narrow enough that others fall through to a stage 2 one or two blocks
     * later — and a feature window long enough to put the two a block apart.
     */
    {"both-stages-50",  48000, STIM_HAT,    60, 6.0,   0.5,  131072, 4096, 0,  1.0, 1.05, -90.0, 5.0, 60.0, 0.0, 0.50, D, D, D, -1, -1,  0.0,  0, -1, 0},
    {"both-stages-30",  48000, STIM_HAT,    60, 6.0,   0.5,  131072, 4096, 0,  1.0, 1.05, -90.0, 5.0, 60.0, 0.0, 0.30, D, D, D, -1, -1,  0.0,  0, -1, 0},
    {"both-stages-70",  48000, STIM_HAT,    60, 6.0,   0.5,  131072, 4096, 0,  1.0, 1.05, -90.0, 5.0, 60.0, 0.0, 0.70, D, D, D, -1, -1,  0.0,  0, -1, 0},
    {"both-stages-long",48000, STIM_SNARE,  60, 6.0,   0.5,  131072, 8192, 0,  1.0, 1.05, -90.0, 5.0, 120.0, 0.0, 0.50, D, D, D, -1, -1, 0.0,  0, -1, 0},
};

static const int CASE_COUNT = (int)(sizeof(CASES) / sizeof(CASES[0]));

/*
 * A note on STIM_CLICK's reach, because it shaped several rows above.
 *
 * STIM_CLICK is a single non-zero sample — `w = (k == 0) ? 1.0 : 0.0` — with
 * no envelope behind it. One sample of energy does not lift the fast envelope
 * followers far enough over the slow ones to pass the detector's threshold at
 * default sensitivity, so a click case fires nothing unless the row also opens
 * the gate up (sens 1.05, floor -90, min_gap 5, feature 3 — what "fire-overflow"
 * and "cap-overrun" do). That is correct detector behaviour and worth keeping a
 * row for, which "click-4" is.
 *
 * It is useless everywhere the row's purpose is what happens *after* a fire:
 * the hazard-2 wrap needs ids a real onset allocated, the block-size family
 * needs a pending entry whose clock can be off by one, and the poison family
 * needs a detector that was firing before it was poisoned. Those rows run
 * STIM_SNARE. The stimulus generator itself is untouched — it stays identical
 * to parity-onset.c's, which is a documented property of this file.
 */

static void case_params(const voice_case *c, double *p) {
  p[0] = c->sr;
  p[1] = (double)c->kind;
  p[2] = (double)c->hits;
  p[3] = c->gap_ms;
  p[4] = c->amp;
  p[5] = (double)c->n;
  p[6] = (double)c->block_size;
  p[7] = (double)c->poison;
  p[8] = c->enabled;
  p[9] = c->sens;
  p[10] = c->floor_db;
  p[11] = c->min_gap;
  p[12] = c->feature_ms;
  p[13] = c->mode;
  p[14] = c->margin;
  p[15] = c->vel_min;
  p[16] = c->vel_db;
  p[17] = c->monitor;
  p[18] = (double)c->capture_cls;
  p[19] = (double)c->enable_at_block;
  p[20] = c->counter_seed;
  p[21] = (double)c->centroid_poke;
  p[22] = (double)c->disable_at_block;
  p[23] = (double)c->drain_lag;
}
#define CASE_PARAMS 24

static void case_opts(const voice_case *c, double *o) {
  o[BK_VOICE_ENABLED] = c->enabled;
  o[BK_VOICE_SENSITIVITY] = c->sens;
  o[BK_VOICE_FLOOR_DB] = c->floor_db;
  o[BK_VOICE_MIN_GAP_MS] = c->min_gap;
  o[BK_VOICE_FEATURE_MS] = c->feature_ms;
  o[BK_VOICE_MODE] = c->mode;
  o[BK_VOICE_MARGIN] = c->margin;
  o[BK_VOICE_VEL_MIN] = c->vel_min;
  o[BK_VOICE_VEL_DB] = c->vel_db;
  o[BK_VOICE_MONITOR] = c->monitor;
}

/* The centroid and pad pokes "pad-poke" and the state records apply. Chosen so
   that every one of them is observable: the kick centroid is moved onto the
   snare's, so the two become ambiguous and the ratio rises; the snare's pad is
   muted, so a snare hit counts and fires nothing; the hat's pad is moved to a
   pad no default uses, so a pad written from the wrong table is visible. */
#define POKE_CENTROID_CLS 0
#define POKE_CENTROID_FEAT 1
#define POKE_CENTROID_VAL 0.467
#define POKE_ATTACK_CLS 2
#define POKE_ATTACK_BAND 0
#define POKE_ATTACK_VAL 0.25
#define POKE_MUTE_CLS 1
#define POKE_PAD_CLS 2
#define POKE_PAD_VAL 11

static void apply_pokes(bk_smart_voice *v) {
  bk_smart_voice_set_centroid(v, POKE_CENTROID_CLS, POKE_CENTROID_FEAT, POKE_CENTROID_VAL);
  bk_smart_voice_set_attack_centroid(v, POKE_ATTACK_CLS, POKE_ATTACK_BAND, POKE_ATTACK_VAL);
  bk_smart_voice_set_class_pad(v, POKE_MUTE_CLS, -1.0);
  bk_smart_voice_set_class_pad(v, POKE_PAD_CLS, POKE_PAD_VAL);
}

/* Working buffers. Static rather than stack: the wasm build's default stack is
   nowhere near MAX_FRAMES doubles. */
static double g_sig[MAX_FRAMES];
static float g_mono[MAX_FRAMES];
static float g_hist[3 * 2048];
static float g_hist_fresh[3 * 2048];

static void build_case_signal(const voice_case *c) {
  int i;
  stim(g_sig, (size_t)c->n, c->sr == 0.0 ? 48000.0 : c->sr, c->kind, c->hits, c->gap_ms, c->amp,
       c->poison);
  for (i = 0; i < c->n; i++) g_mono[i] = (float)g_sig[i];
}

/* "<layer>:<case>", which is what a failure line reads as. */
static const char *rec_name(const char *layer, const char *name) {
  static char buf[BK_PARITY_NAME_LEN];
  size_t i = 0, j;
  for (j = 0; layer[j] && i + 1 < sizeof(buf); j++) buf[i++] = layer[j];
  if (i + 1 < sizeof(buf)) buf[i++] = ':';
  for (j = 0; name[j] && i + 1 < sizeof(buf); j++) buf[i++] = name[j];
  buf[i] = '\0';
  return buf;
}

/* --- layer 1: exact ----------------------------------------------------- */

/*
 * Every parameter at, inside and beyond both of its stops, plus the two kinds
 * of input setParam must ignore, plus the two out-of-band forwarded keys, plus
 * keys that are in no table at all.
 *
 * The readback is the whole parameter block *and* the detector's, because the
 * failures here are not only "clamped wrongly": a key that writes the right
 * clamp to the wrong field, a key that forgets to forward to the detector, and
 * floorDb forwarding its *clamped* copy instead of the raw value are all
 * invisible to a record that only reads back the key it just set.
 */
static const double PARAM_CASES[][2] = {
    {BK_VOICE_ENABLED, 0.0},      {BK_VOICE_ENABLED, 0.49},     {BK_VOICE_ENABLED, 0.5},
    {BK_VOICE_ENABLED, 1.0},      {BK_VOICE_ENABLED, -1.0},     {BK_VOICE_ENABLED, 99.0},
    {BK_VOICE_MODE, 0.0},         {BK_VOICE_MODE, 0.49},        {BK_VOICE_MODE, 0.5},
    {BK_VOICE_MODE, 1.0},         {BK_VOICE_MODE, 7.0},         {BK_VOICE_MODE, -1.0},
    {BK_VOICE_MARGIN, 0.0},       {BK_VOICE_MARGIN, 0.05},      {BK_VOICE_MARGIN, 0.62},
    {BK_VOICE_MARGIN, 0.99},      {BK_VOICE_MARGIN, 1.0},       {BK_VOICE_MARGIN, -5.0},
    {BK_VOICE_MARGIN, 1e9},
    {BK_VOICE_VEL_MIN, -1.0},     {BK_VOICE_VEL_MIN, 0.0},      {BK_VOICE_VEL_MIN, 0.32},
    {BK_VOICE_VEL_MIN, 0.95},     {BK_VOICE_VEL_MIN, 1.0},      {BK_VOICE_VEL_MIN, 2.0},
    {BK_VOICE_VEL_DB, 0.0},       {BK_VOICE_VEL_DB, 3.0},       {BK_VOICE_VEL_DB, 26.0},
    {BK_VOICE_VEL_DB, 60.0},      {BK_VOICE_VEL_DB, 600.0},     {BK_VOICE_VEL_DB, -60.0},
    {BK_VOICE_MONITOR, 0.0},      {BK_VOICE_MONITOR, 0.5},      {BK_VOICE_MONITOR, 1.0},
    /* floorDb: the dual clamp. -200 and 0 are outside Smart Voice's range and
       inside or outside the detector's independently, which is where the two
       clamps visibly disagree. */
    {BK_VOICE_FLOOR_DB, -200.0},  {BK_VOICE_FLOOR_DB, -90.0},   {BK_VOICE_FLOOR_DB, -42.0},
    {BK_VOICE_FLOOR_DB, -6.0},    {BK_VOICE_FLOOR_DB, 0.0},     {BK_VOICE_FLOOR_DB, 120.0},
    /* Pure forwards: no Smart Voice state of their own, so the only visible
       effect is on the detector's block. */
    {BK_VOICE_SENSITIVITY, 1.0},  {BK_VOICE_SENSITIVITY, 1.05}, {BK_VOICE_SENSITIVITY, 2.1},
    {BK_VOICE_SENSITIVITY, 8.0},  {BK_VOICE_SENSITIVITY, 99.0},
    {BK_VOICE_MIN_GAP_MS, 0.0},   {BK_VOICE_MIN_GAP_MS, 5.0},   {BK_VOICE_MIN_GAP_MS, 45.0},
    {BK_VOICE_MIN_GAP_MS, 500.0}, {BK_VOICE_MIN_GAP_MS, 5000.0},
    {BK_VOICE_FEATURE_MS, 0.0},   {BK_VOICE_FEATURE_MS, 3.0},   {BK_VOICE_FEATURE_MS, 8.0},
    {BK_VOICE_FEATURE_MS, 120.0}, {BK_VOICE_FEATURE_MS, 1200.0},
    /* The two keys that exist in the JS by name but not on the wire. */
    {BK_VOICE_LOW_CROSS_HZ, 0.0}, {BK_VOICE_LOW_CROSS_HZ, 180.0},
    {BK_VOICE_LOW_CROSS_HZ, 1000.0}, {BK_VOICE_LOW_CROSS_HZ, 24000.0},
    {BK_VOICE_HIGH_CROSS_HZ, 0.0}, {BK_VOICE_HIGH_CROSS_HZ, 5000.0},
    {BK_VOICE_HIGH_CROSS_HZ, 1500.0}, {BK_VOICE_HIGH_CROSS_HZ, 96000.0},
    /* Unknown keys, including the two slots immediately past the wire enum —
       which is where an eleventh VOICE_KEY entry would land, and which must do
       nothing at all today. */
    {10.0, 7.0},                  {11.0, 7.0},                  {-1.0, 7.0},
    {255.0, 7.0},                 {258.0, 7.0},                 {999.0, 7.0},
    /* Non-finite values on keys that would otherwise change something. */
    {BK_VOICE_MARGIN, NAN},       {BK_VOICE_MARGIN, INFINITY},  {BK_VOICE_MARGIN, -INFINITY},
    {BK_VOICE_ENABLED, NAN},      {BK_VOICE_FLOOR_DB, NAN},     {BK_VOICE_VEL_DB, INFINITY},
    {BK_VOICE_SENSITIVITY, NAN},
};
static const int PARAM_COUNT = (int)(sizeof(PARAM_CASES) / sizeof(PARAM_CASES[0]));

/* Snapshots the parameter state of both objects: Smart Voice's seven fields
   and the detector's six. 13 doubles. */
#define PARAM_SNAP 13
static int snap_params(double *o, int i, const bk_smart_voice *v) {
  o[i++] = (double)v->enabled;
  o[i++] = (double)v->mode;
  o[i++] = v->margin;
  o[i++] = v->vel_min;
  o[i++] = v->vel_db;
  o[i++] = (double)v->monitor;
  o[i++] = v->floor_db;
  o[i++] = v->det.sensitivity;
  o[i++] = v->det.floor_db;
  o[i++] = v->det.min_gap_ms;
  o[i++] = v->det.feature_ms;
  o[i++] = v->det.low_cross_hz;
  o[i++] = v->det.high_cross_hz;
  return i;
}

/*
 * The three ToInt32 setters, at arguments where a C cast and `| 0` part
 * company. 2^32 is the one that matters most: it wraps to 0, so
 * setCentroid(2^32, ...) writes class 0 rather than being rejected, and a port
 * that range-checked before coercing would reject it.
 */
static const double INT32_ARGS[] = {
    0.0,  -0.0, 0.5,  -0.5, 1.0,  1.5,  2.0,  3.0,  3.5,  4.0,  -1.0, -1.5,
    2147483647.0, 2147483648.0, -2147483648.0, -2147483649.0,
    4294967296.0, 4294967297.0, 4294967298.0, 4294967299.0, 4294967300.0,
    -4294967296.0, -4294967295.0, 8589934592.0, 8589934594.0,
    1e15, -1e15, 1e30, NAN, INFINITY, -INFINITY,
};
static const int INT32_ARG_COUNT = (int)(sizeof(INT32_ARGS) / sizeof(INT32_ARGS[0]));

/* Values the setters store, including the non-finite ones they must reject and
   the float32 rounding cases that prove the store is a float32 store. */
static const double SET_VALS[] = {
    0.0, -0.0, 0.5, 1.0, -1.0, 0.1, 0.337, 1e-30, 1e30, NAN, INFINITY, -INFINITY,
};
static const int SET_VAL_COUNT = (int)(sizeof(SET_VALS) / sizeof(SET_VALS[0]));

/* Both tables, so a write that landed in the wrong one is caught. */
#define TABLES_N32 (2 * BK_VOICE_CLASS_COUNT * BK_ONSET_FEATURE_COUNT)
static void snap_tables(float *o, const bk_smart_voice *v) {
  int i, n = BK_VOICE_CLASS_COUNT * BK_ONSET_FEATURE_COUNT;
  for (i = 0; i < n; i++) o[i] = v->centroids[i];
  for (i = 0; i < n; i++) o[n + i] = v->attack[i];
}

/*
 * classify() on hand-built vectors rather than on audio.
 *
 * The vectors that matter are the ones no drum produces: an exact centroid
 * (distance zero, so the ratio divides by the *second* distance and the
 * `second_d > 1e-12` guard is the only thing between the record and a division
 * by zero), a vector equidistant from two classes (ratio exactly 1, confidence
 * exactly 0, and the tie is broken by the strict `<` and so by class order), a
 * vector equidistant from *all four*, the zero vector, and vectors far outside
 * the unit cube where the weighted squares get large.
 *
 * Table 0 is the four-axis centroid table, table 1 the three-axis attack
 * table, and the axes count is carried separately from the table so that a
 * classify that ignored either argument is caught: attack-table-with-4-axes
 * reads the zcr column that is all zeros, which is a different answer.
 */
static const double CLASSIFY_CASES[][6] = {
    /* axes, table, f0, f1, f2, f3 */
    /* The four factory centroids exactly, four axes. Distance zero. */
    {4, 0, 0.336, 0.658, 0.006, 0.104},
    {4, 0, 0.278, 0.467, 0.255, 1.0},
    {4, 0, 0.0, 0.123, 0.877, 1.0},
    {4, 0, 0.001, 0.869, 0.13, 0.797},
    /* The four attack centroids exactly, three axes. */
    {3, 1, 0.127, 0.865, 0.008, 0.0},
    {3, 1, 0.394, 0.448, 0.158, 0.0},
    {3, 1, 0.0, 0.062, 0.938, 0.0},
    {3, 1, 0.001, 0.884, 0.116, 0.0},
    /* The same attack vectors read on four axes against the attack table,
       whose fourth column is zero: a different distance and possibly a
       different class, which is what catches an ignored `axes`. */
    {4, 1, 0.127, 0.865, 0.008, 0.0},
    {4, 1, 0.127, 0.865, 0.008, 1.0},
    /* The attack vectors against the *centroid* table, and vice versa: what
       catches an ignored `table`. */
    {3, 0, 0.127, 0.865, 0.008, 0.0},
    {3, 1, 0.336, 0.658, 0.006, 0.104},
    /* Midway between kick and snare on all four axes. */
    {4, 0, 0.307, 0.5625, 0.1305, 0.552},
    /* Midway between hat and clap. */
    {4, 0, 0.0005, 0.496, 0.5035, 0.8985},
    /* The centre of all four centroids: nearly equidistant, so the ratio is
       just under 1 and the class is decided by the smallest of four almost
       identical numbers. */
    {4, 0, 0.15375, 0.52925, 0.317, 0.72525},
    /* Zero, one, and the unit diagonal. */
    {4, 0, 0.0, 0.0, 0.0, 0.0},
    {3, 1, 0.0, 0.0, 0.0, 0.0},
    {4, 0, 1.0, 1.0, 1.0, 1.0},
    {3, 1, 1.0, 1.0, 1.0, 1.0},
    {4, 0, 0.5, 0.5, 0.5, 0.5},
    /* A band vector as stage 1 actually builds one: three shares summing to 1
       and a zero fourth. */
    {3, 1, 1.0, 0.0, 0.0, 0.0},
    {3, 1, 0.0, 1.0, 0.0, 0.0},
    {3, 1, 0.0, 0.0, 1.0, 0.0},
    {3, 1, 0.333333333333333, 0.333333333333333, 0.333333333333333, 0.0},
    /* Far outside the cube, where the weighted squares are large and the ratio
       tends to 1 — and where a float32 store of the feature would round. */
    {4, 0, 100.0, 100.0, 100.0, 100.0},
    {4, 0, -100.0, -100.0, -100.0, -100.0},
    {4, 0, 1e20, 0.0, 0.0, 0.0},
    {4, 0, 1e-30, 1e-30, 1e-30, 1e-30},
    /* Zero axes: the loop never runs, every distance is 0, and the first
       comparison `0 < Infinity` takes — so class 0 with best and second both
       zero, and the `second_d > 1e-12` guard yields ratio 1. That is the one
       input where the guard's false arm is reachable with finite data. */
    {0, 0, 0.5, 0.5, 0.5, 0.5},
    {0, 1, 0.5, 0.5, 0.5, 0.5},
    /* One axis, which makes ties between classes far more likely. */
    {1, 0, 0.0, 0.0, 0.0, 0.0},
    {1, 1, 0.0, 0.0, 0.0, 0.0},
    {2, 0, 0.3, 0.6, 0.0, 0.0},
    /* Past float32's range, so the *feature* is Infinity before a distance is
       ever computed: every class is Infinity away, `d < best_d` is false four
       times over, and the class comes back -1 with bestD and secondD both
       Infinity. That is the one input where the ratio is Infinity/Infinity —
       NaN — and the confidence clamp has to carry it. Math.max/Math.min
       propagate a NaN; fmax/fmin pick the other operand and would report a
       confidence of 1.0 on a vector the classifier could not place at all. */
    {4, 0, 1e200, 0.0, 0.0, 0.0},
    {3, 1, 1e200, 1e200, 1e200, 0.0},
    /* The same NaN ratio by the other road: a NaN feature makes every distance
       NaN, so `best` stays -1 while secondD stays Infinity and the ratio is
       sqrt(NaN/Infinity). Unreachable from the stream — stage 1's guard writes
       exact zeros for a NaN envelope — and pinned here for the same reason the
       dB path's NaN is. */
    {4, 0, NAN, 0.0, 0.0, 0.0},
};
static const int CLASSIFY_COUNT = (int)(sizeof(CLASSIFY_CASES) / sizeof(CLASSIFY_CASES[0]));

/*
 * classify's `secondD > 1e-12` guard, on the only profile that can show it.
 *
 * On the factory tables the four centroids sit so far apart that the *second*
 * distance is never small: land on kick exactly and snare is still 0.05 away,
 * so the guard's true arm is taken with an enormous margin and its constant is
 * invisible. It is not a dead constant though — setCentroid takes any finite
 * value, and a user who trains two pads on the same sound collapses two rows
 * onto each other. That is the state below: snare is rewritten to kick's row
 * with one axis moved by `delta`, and the vector is placed on kick exactly. So
 * bestD is 0, secondD is delta squared on an axis of weight 1, and the ratio
 * is either 0 (guard true) or the flat 1.0 (guard false).
 *
 * The deltas bracket the constant from both sides — 1e-8 and 9e-10 above it,
 * 1e-12 and 9e-14 below, and an exact collapse at 0 — so a guard moved either
 * way changes a record, not just one moved outward.
 */
static const double DEGEN_DELTAS[] = {1e-4, 3e-5, 1e-5, 3e-6, 1e-6, 3e-7, 0.0};
static const int DEGEN_COUNT = (int)(sizeof(DEGEN_DELTAS) / sizeof(DEGEN_DELTAS[0]));
/* Kick's factory row, which both the vector and the rewritten snare row use. */
static const double DEGEN_KICK[BK_ONSET_FEATURE_COUNT] = {0.336, 0.658, 0.006, 0.104};

/*
 * velocityFrom over a dB sweep, at every combination of the three parameters
 * that shape it. The interesting inputs are the two ends of the ramp and the
 * two beyond them, where the ternary chain clamps — plus NaN, which passes
 * through both false arms and comes out NaN, and which a min/max clamp would
 * have turned into a number.
 */
static const double VEL_FLOORS[] = {-90.0, -42.0, -6.0};
static const double VEL_MINS[] = {0.0, 0.32, 0.95};
static const double VEL_DBS[] = {3.0, 26.0, 60.0};
static const double VEL_DBIN[] = {
    -200.0, -120.0, -90.0, -64.0, -42.0, -30.0, -16.0, -6.0, -3.0, 0.0, 6.0, 120.0,
    -INFINITY, INFINITY, NAN,
};

/*
 * Hazard 1, at the composed call site rather than argued about.
 *
 * Stage 1 computes `20 * Math.log10(Math.max(1e-9, det.level.env))` and feeds
 * the result straight to velocityFrom. Two things about that expression only
 * show up on inputs the stream cannot produce (the detector scrubs non-finite
 * samples before any follower sees them, so det.level.env is always finite in
 * a real pass):
 *
 *   - Math.max(NaN, 1e-9) is NaN, but fmax(NaN, 1e-9) is 1e-9. A port built on
 *     fmax reports -180 dB for a broken level and a *plausible* velocity with
 *     it, which is the worst possible failure: silent and reasonable-looking.
 *     bk_max is written to propagate, and this is where that is measured.
 *   - the clamp is on the gain side, not the dB side, so a zero or negative
 *     env floors at -180 dB exactly while -inf and +inf pass through.
 *
 * Both languages poke det.level.env directly. It is a plain float in both,
 * written by the follower every sample and read by nothing else here, so the
 * poke is the same state a follower would have reached.
 */
static const double LEVEL_ENVS[] = {
    0.0, -0.0, 1e-30, 1e-12, 1e-9, 2e-9, 0.001, 0.25, 1.0, 4.0, 1e30,
    -1.0, -INFINITY, INFINITY, NAN,
};

static void emit_layer1(FILE *f) {
  double p[6], o64[64];
  float o32[TABLES_N32];
  int i, j, k, m;

  bk_smart_voice_defaults(o64);
  bk_parity_emit(f, "defaults", NULL, 0, o64, BK_VOICE_PARAM_COUNT, NULL, 0);

  /* The factory profile, both tables and the pads. */
  {
    float tables[TABLES_N32];
    int pads[BK_VOICE_CLASS_COUNT];
    bk_smart_voice_factory_centroids(tables);
    bk_smart_voice_factory_attack(tables + BK_VOICE_CLASS_COUNT * BK_ONSET_FEATURE_COUNT);
    bk_smart_voice_default_class_pads(pads);
    for (i = 0; i < BK_VOICE_CLASS_COUNT; i++) o64[i] = (double)pads[i];
    o64[BK_VOICE_CLASS_COUNT] = (double)BK_VOICE_CLASS_COUNT;
    o64[BK_VOICE_CLASS_COUNT + 1] = (double)BK_ONSET_FEATURE_COUNT;
    o64[BK_VOICE_CLASS_COUNT + 2] = (double)BK_VOICE_CAP_STRIDE;
    o64[BK_VOICE_CLASS_COUNT + 3] = (double)BK_VOICE_CAP_ATTACK_OFFSET;
    o64[BK_VOICE_CLASS_COUNT + 4] = (double)BK_VOICE_CAP_SLOTS;
    o64[BK_VOICE_CLASS_COUNT + 5] = (double)BK_VOICE_PEND_SLOTS;
    o64[BK_VOICE_CLASS_COUNT + 6] = (double)BK_VOICE_FIRE_MAX;
    o64[BK_VOICE_CLASS_COUNT + 7] = (double)BK_VOICE_METER_STRIDE;
    o64[BK_VOICE_CLASS_COUNT + 8] = (double)BK_VOICE_STAGE1_DELAY_BLOCKS;
    bk_parity_emit(f, "factory", NULL, 0, o64, BK_VOICE_CLASS_COUNT + 9, tables, TABLES_N32);
  }

  /* hist_floats forwards to the detector's; pinned so a forward that stopped
     forwarding is caught here rather than as a corrupted lag history. */
  {
    static const double SRS[] = {8000.0, 44100.0, 48000.0, 96000.0, 192000.0, 0.0, NAN, 333.0};
    int n = (int)(sizeof(SRS) / sizeof(SRS[0]));
    for (i = 0; i < n; i++) {
      p[0] = SRS[i];
      o64[0] = (double)bk_smart_voice_hist_floats(p[0]);
      bk_parity_emit(f, "hist-floats", p, 1, o64, 1, NULL, 0);
    }
  }

  /* Every parameter, every clamp, both objects read back. */
  for (i = 0; i < PARAM_COUNT; i++) {
    bk_smart_voice v;
    bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
    bk_smart_voice_set_param(&v, (int)PARAM_CASES[i][0], PARAM_CASES[i][1]);
    snap_params(o64, 0, &v);
    p[0] = PARAM_CASES[i][0];
    p[1] = PARAM_CASES[i][1];
    bk_parity_emit(f, "param", p, 2, o64, PARAM_SNAP, NULL, 0);
  }

  /*
   * init(opts) against init(NULL) + set_param, which the header claims are the
   * same thing by construction. The C emits both snapshots and the checker
   * asserts they are equal without needing the JS — and the JS then asserts
   * its own constructor agrees with the first of them, which is the part that
   * needs a reference.
   */
  for (i = 0; i < PARAM_COUNT; i++) {
    bk_smart_voice a, b;
    double opts[BK_VOICE_PARAM_COUNT];
    int key = (int)PARAM_CASES[i][0];
    for (k = 0; k < BK_VOICE_PARAM_COUNT; k++) opts[k] = NAN;
    /* Only the in-band keys can go through opts at all; an out-of-band key is
       emitted as a no-op pair, which is itself the assertion that opts cannot
       reach the forwarded crossovers. */
    if (key >= 0 && key < BK_VOICE_PARAM_COUNT) opts[key] = PARAM_CASES[i][1];
    bk_smart_voice_init(&a, 48000.0, opts, g_hist);
    bk_smart_voice_init(&b, 48000.0, NULL, g_hist_fresh);
    bk_smart_voice_set_param(&b, key, PARAM_CASES[i][1]);
    j = snap_params(o64, 0, &a);
    j = snap_params(o64, j, &b);
    p[0] = PARAM_CASES[i][0];
    p[1] = PARAM_CASES[i][1];
    bk_parity_emit(f, "opts-equiv", p, 2, o64, 2 * PARAM_SNAP, NULL, 0);
  }

  /* setCentroid, over the ToInt32 arguments and the stored values. */
  for (i = 0; i < INT32_ARG_COUNT; i++) {
    for (j = 0; j < 2; j++) {
      bk_smart_voice v;
      /* Once with the wild value in the class slot and once in the feature
         slot, because the two range checks are different widths — feature has
         four legal values and class four, but the attack table's band check is
         `> 2`, and a shared helper would make all three agree. */
      const double cls = j == 0 ? INT32_ARGS[i] : 1.0;
      const double feat = j == 0 ? 2.0 : INT32_ARGS[i];
      bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
      bk_smart_voice_set_centroid(&v, cls, feat, 0.375);
      snap_tables(o32, &v);
      p[0] = cls;
      p[1] = feat;
      p[2] = 0.375;
      bk_parity_emit(f, "centroid", p, 3, NULL, 0, o32, TABLES_N32);
    }
  }

  /* The stored value, including the non-finite rejections and the float32
     rounding. Class and feature fixed and legal. */
  for (i = 0; i < SET_VAL_COUNT; i++) {
    bk_smart_voice v;
    bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
    bk_smart_voice_set_centroid(&v, 2.0, 1.0, SET_VALS[i]);
    bk_smart_voice_set_attack_centroid(&v, 3.0, 2.0, SET_VALS[i]);
    snap_tables(o32, &v);
    p[0] = SET_VALS[i];
    bk_parity_emit(f, "centroid-val", p, 1, NULL, 0, o32, TABLES_N32);
  }

  /* setAttackCentroid, same sweep. The band check is `> 2` and not
     `>= FEATURE_COUNT`, so band 3 must be rejected where feature 3 is not. */
  for (i = 0; i < INT32_ARG_COUNT; i++) {
    for (j = 0; j < 2; j++) {
      bk_smart_voice v;
      const double cls = j == 0 ? INT32_ARGS[i] : 1.0;
      const double band = j == 0 ? 1.0 : INT32_ARGS[i];
      bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
      bk_smart_voice_set_attack_centroid(&v, cls, band, 0.375);
      snap_tables(o32, &v);
      p[0] = cls;
      p[1] = band;
      p[2] = 0.375;
      bk_parity_emit(f, "attack", p, 3, NULL, 0, o32, TABLES_N32);
    }
  }

  /*
   * setClassPad, whose coercion is asymmetric: the sign test is on the
   * uncoerced double and the store is ToInt32. So -0.5 mutes where
   * ToInt32(-0.5) would be pad 0, and NaN fails `< 0` and stores pad 0.
   */
  for (i = 0; i < INT32_ARG_COUNT; i++) {
    for (j = 0; j < 2; j++) {
      bk_smart_voice v;
      const double cls = j == 0 ? INT32_ARGS[i] : 2.0;
      const double pad = j == 0 ? 3.0 : INT32_ARGS[i];
      bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
      bk_smart_voice_set_class_pad(&v, cls, pad);
      for (k = 0; k < BK_VOICE_CLASS_COUNT; k++) o64[k] = (double)v.class_pad[k];
      p[0] = cls;
      p[1] = pad;
      bk_parity_emit(f, "class-pad", p, 2, o64, BK_VOICE_CLASS_COUNT, NULL, 0);
    }
  }

  /* setCapture, which coerces the same way and has no upper clamp of its own
     beyond the range test. */
  for (i = 0; i < INT32_ARG_COUNT; i++) {
    bk_smart_voice v;
    bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
    bk_smart_voice_set_capture(&v, INT32_ARGS[i]);
    o64[0] = (double)v.capture_class;
    p[0] = INT32_ARGS[i];
    bk_parity_emit(f, "capture-class", p, 1, o64, 1, NULL, 0);
  }

  /*
   * resetCentroids after a poke: both tables must come back to the factory
   * profile, and the pads must *not* — they are not part of the profile
   * resetCentroids restores, and a reset that tidied them as well would look
   * harmless and lose a user's pad mapping.
   */
  {
    bk_smart_voice v;
    bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
    apply_pokes(&v);
    snap_tables(o32, &v);
    for (k = 0; k < BK_VOICE_CLASS_COUNT; k++) o64[k] = (double)v.class_pad[k];
    bk_parity_emit(f, "poked", NULL, 0, o64, BK_VOICE_CLASS_COUNT, o32, TABLES_N32);
  }
  {
    /* Emitted as its own record rather than two halves of one, so a failure
       line says which of the two states diverged. */
    bk_smart_voice v;
    bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
    apply_pokes(&v);
    bk_smart_voice_reset_centroids(&v);
    snap_tables(o32, &v);
    for (k = 0; k < BK_VOICE_CLASS_COUNT; k++) o64[k] = (double)v.class_pad[k];
    bk_parity_emit(f, "reset-centroids", NULL, 0, o64, BK_VOICE_CLASS_COUNT, o32, TABLES_N32);
  }

  /* classify on hand-built vectors. */
  for (i = 0; i < CLASSIFY_COUNT; i++) {
    bk_smart_voice v;
    float feat[BK_ONSET_FEATURE_COUNT];
    const int axes = (int)CLASSIFY_CASES[i][0];
    const int table = (int)CLASSIFY_CASES[i][1];
    int cls;
    bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
    for (k = 0; k < BK_ONSET_FEATURE_COUNT; k++) feat[k] = (float)CLASSIFY_CASES[i][2 + k];
    cls = bk_smart_voice_classify(&v, feat, axes, table == 0 ? v.centroids : v.attack);
    o64[0] = (double)cls;
    o64[1] = v.scratch_ratio;
    o64[2] = v.scratch_conf;
    for (k = 0; k < 6; k++) p[k] = CLASSIFY_CASES[i][k];
    bk_parity_emit(f, "classify", p, 6, o64, 3, NULL, 0);
  }

  /* The same vectors against a poked table, so classify is measured on a
     profile the factory never produced — which is the profile every trained
     user actually runs. */
  for (i = 0; i < CLASSIFY_COUNT; i++) {
    bk_smart_voice v;
    float feat[BK_ONSET_FEATURE_COUNT];
    const int axes = (int)CLASSIFY_CASES[i][0];
    const int table = (int)CLASSIFY_CASES[i][1];
    int cls;
    bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
    apply_pokes(&v);
    for (k = 0; k < BK_ONSET_FEATURE_COUNT; k++) feat[k] = (float)CLASSIFY_CASES[i][2 + k];
    cls = bk_smart_voice_classify(&v, feat, axes, table == 0 ? v.centroids : v.attack);
    o64[0] = (double)cls;
    o64[1] = v.scratch_ratio;
    o64[2] = v.scratch_conf;
    for (k = 0; k < 6; k++) p[k] = CLASSIFY_CASES[i][k];
    bk_parity_emit(f, "classify-poked", p, 6, o64, 3, NULL, 0);
  }

  /* The collapsed profile: see the note above DEGEN_DELTAS. */
  for (i = 0; i < DEGEN_COUNT; i++) {
    bk_smart_voice v;
    float feat[BK_ONSET_FEATURE_COUNT];
    int cls;
    bk_smart_voice_init(&v, 48000.0, NULL, g_hist);
    for (k = 0; k < BK_ONSET_FEATURE_COUNT; k++) {
      feat[k] = (float)DEGEN_KICK[k];
      bk_smart_voice_set_centroid(&v, 1.0, (double)k,
                                  k == BK_ONSET_FEATURE_COUNT - 1
                                      ? DEGEN_KICK[k] + DEGEN_DELTAS[i]
                                      : DEGEN_KICK[k]);
    }
    cls = bk_smart_voice_classify(&v, feat, BK_ONSET_FEATURE_COUNT, v.centroids);
    o64[0] = (double)cls;
    o64[1] = v.scratch_ratio;
    o64[2] = v.scratch_conf;
    p[0] = DEGEN_DELTAS[i];
    bk_parity_emit(f, "classify-degen", p, 1, o64, 3, NULL, 0);
  }

  /* velocityFrom across the whole parameter space. */
  for (i = 0; i < 3; i++) {
    for (j = 0; j < 3; j++) {
      for (k = 0; k < 3; k++) {
        bk_smart_voice v;
        const int n_db = (int)(sizeof(VEL_DBIN) / sizeof(VEL_DBIN[0]));
        double opts[BK_VOICE_PARAM_COUNT];
        int q;
        for (q = 0; q < BK_VOICE_PARAM_COUNT; q++) opts[q] = NAN;
        opts[BK_VOICE_FLOOR_DB] = VEL_FLOORS[i];
        opts[BK_VOICE_VEL_MIN] = VEL_MINS[j];
        opts[BK_VOICE_VEL_DB] = VEL_DBS[k];
        bk_smart_voice_init(&v, 48000.0, opts, g_hist);
        for (m = 0; m < n_db; m++) o64[m] = bk_smart_voice_velocity_from(&v, VEL_DBIN[m]);
        p[0] = VEL_FLOORS[i];
        p[1] = VEL_MINS[j];
        p[2] = VEL_DBS[k];
        bk_parity_emit(f, "velocity", p, 3, o64, (unsigned int)n_db, NULL, 0);
      }
    }
  }

  /* hazard 1: gain_to_db over the level env, and the velocity it produces, at
     each of the three velocity floors. See the note on LEVEL_ENVS. */
  for (i = 0; i < 3; i++) {
    bk_smart_voice v;
    const int n_env = (int)(sizeof(LEVEL_ENVS) / sizeof(LEVEL_ENVS[0]));
    double opts[BK_VOICE_PARAM_COUNT];
    int q;
    for (q = 0; q < BK_VOICE_PARAM_COUNT; q++) opts[q] = NAN;
    opts[BK_VOICE_FLOOR_DB] = VEL_FLOORS[i];
    bk_smart_voice_init(&v, 48000.0, opts, g_hist);
    for (m = 0; m < n_env; m++) {
      const double db = bk_gain_to_db(LEVEL_ENVS[m]);
      o64[m * 2] = db;
      o64[m * 2 + 1] = bk_smart_voice_velocity_from(&v, db);
    }
    p[0] = VEL_FLOORS[i];
    bk_parity_emit(f, "level-db", p, 1, o64, (unsigned int)(n_env * 2), NULL, 0);
  }
}

/* --- the case harness --------------------------------------------------- */

/*
 * Construct and apply the case's harness knobs, in the order a live session
 * would: build at the sample rate, load the profile, arm the capture, then —
 * for hazard 2 only — wind the onset counters forward.
 *
 * Mirrored exactly on the JS side. The poke is part of the *case*, not part of
 * the measurement: both languages poke the same three fields to the same
 * value, so what the record measures is the int32 truncation downstream of
 * them and not the poke itself.
 */
static void init_case(bk_smart_voice *v, const voice_case *c, float *hist) {
  double opts[BK_VOICE_PARAM_COUNT];
  case_opts(c, opts);
  bk_smart_voice_init(v, c->sr, opts, hist);
  if (c->centroid_poke) apply_pokes(v);
  if (c->capture_cls >= 0) bk_smart_voice_set_capture(v, (double)c->capture_cls);
  if (c->counter_seed > 0.0) {
    const long long seed = (long long)c->counter_seed;
    v->onset_count = seed;
    /* `drain_lag` winds `drained` back behind the detector's commit counter,
       which is the one state the module cannot reach on its own: the drain
       loop empties the ring on every call it is given, so the catch-up clamp
       in process() only ever has work to do after a caller-visible stall.
       Poking it is how that clamp gets measured at all, and it is the same
       kind of poke the wrap rows already use on the counters. */
    v->drained = c->drain_lag > 0 ? seed - (long long)c->drain_lag : seed;
    v->det.commit_count = seed;
  }
}

/*
 * The whole pending table, in one function, so layer 2 and layer 3 cannot
 * drift apart about its layout. Five int fields to the f64 side and five
 * float fields to the f32 side, slot-major.
 *
 * Every slot is emitted, not just the live ones, and that is the point:
 * resetDetector clears `pend_id` and `pend_read` and deliberately leaves the
 * class, velocity, strength, countdown and fired flag stale (see the JS note
 * quoted in beat-classify.c). A port that tidied those up would pass every
 * behavioural record in this file and fail here.
 */
#define PEND_INTS (5 * BK_VOICE_PEND_SLOTS)
#define PEND_FLOATS (5 * BK_VOICE_PEND_SLOTS)

static void snap_pend(double *o64, int i64, float *o32, int i32, const bk_smart_voice *v) {
  const int n = BK_VOICE_PEND_SLOTS;
  int s;
  for (s = 0; s < n; s++) {
    o64[i64 + 5 * s] = (double)v->pend_id[s];
    o64[i64 + 5 * s + 1] = (double)v->pend_class[s];
    o64[i64 + 5 * s + 2] = (double)v->pend_fired[s];
    o64[i64 + 5 * s + 3] = (double)v->pend_wait[s];
    o64[i64 + 5 * s + 4] = (double)v->pend_read[s];
    o32[i32 + s] = v->pend_vel[s];
    o32[i32 + n + s] = v->pend_strength[s];
    o32[i32 + 2 * n + 3 * s] = v->pend_band[3 * s];
    o32[i32 + 2 * n + 3 * s + 1] = v->pend_band[3 * s + 1];
    o32[i32 + 2 * n + 3 * s + 2] = v->pend_band[3 * s + 2];
  }
}

/* The UI toggle, applied after the numbered block. Enabling calls
   resetDetector(), so the hits already pending when it lands are abandoned
   and must not fire late. Disabling does NOT reset anything — the counters,
   the level and the pending table all survive it, and the asymmetry between
   the two directions is exactly what `disable_at_block` is here to measure. */
static void maybe_toggle(bk_smart_voice *v, const voice_case *c, int block) {
  if (c->enable_at_block >= 0 && block == c->enable_at_block) {
    bk_smart_voice_set_param(v, BK_VOICE_ENABLED, 1.0);
  }
  if (c->disable_at_block >= 0 && block == c->disable_at_block) {
    bk_smart_voice_set_param(v, BK_VOICE_ENABLED, 0.0);
  }
}

/* --- layer 2: behavioural ----------------------------------------------- */

/*
 * A whole pass, however long the case is, reduced to what left the module:
 * every fire in order with the block it happened in, the final meters, the
 * final pending table, and two accumulators.
 *
 * The block index on each fire is the timing gate that matters at this
 * resolution. A port whose stage-1 countdown is off by one produces the same
 * fires with the same classes one block early or late, and a record that only
 * counted them would be perfectly happy.
 *
 * `nonfinite` is COUNTED, NOT GATED AT ZERO, and that is deliberate — this is
 * the one module in the port where a non-finite output is correct. Hazard 1:
 * a NaN in the mic block reaches the level envelope, Math.max propagates it,
 * and the velocity that comes out of a poisoned case is genuinely NaN in both
 * languages. fmax would have invented -180 dB instead, so the number this
 * counts is exactly the divergence that hazard describes, and the gate is
 * "the same count as the JS" rather than "none".
 *
 * `min_class` / `max_class` are hazard 3's gate, and they need no reference
 * implementation: a fired class outside [0, CLASS_COUNT) means classify
 * returned -1 and the unreachability argument in beat-classify.h is wrong.
 * The assert() in the C's emit path fires first in this build, which is the
 * intent — this record is what catches the same thing under NDEBUG and on the
 * JS side, where there is no assert at all.
 */
#define PASS_FIRES 128
#define PASS_METER_BASE 5
#define PASS_PEND_BASE (PASS_METER_BASE + BK_VOICE_METER_STRIDE)
#define PASS_FIRE_BASE (PASS_PEND_BASE + PEND_INTS)
#define PASS_N64 (PASS_FIRE_BASE + 4 * PASS_FIRES)
#define PASS_BAND_BASE PEND_FLOATS
#define PASS_FIRE32_BASE (PASS_BAND_BASE + 3)
#define PASS_N32 (PASS_FIRE32_BASE + 2 * PASS_FIRES)

static bk_smart_voice g_voice_a;
static bk_smart_voice g_voice_b;
static double g_pass64[PASS_N64];
static float g_pass32[PASS_N32];

static void emit_pass(FILE *f, const voice_case *c) {
  double p[CASE_PARAMS], m[BK_VOICE_METER_STRIDE];
  double *o64 = g_pass64;
  float *o32 = g_pass32;
  bk_smart_voice *v = &g_voice_a;
  const int bs = c->block_size <= 0 ? 128 : c->block_size;
  int i, blocks = 0, fires = 0, nonfinite = 0, min_cls = 99, max_cls = -99;
  size_t off;

  case_params(c, p);
  build_case_signal(c);
  for (i = 0; i < PASS_N64; i++) o64[i] = 0.0;
  for (i = 0; i < PASS_N32; i++) o32[i] = 0.0f;

  init_case(v, c, g_hist);

  for (off = 0; off < (size_t)c->n; off += (size_t)bs) {
    const size_t bn = (size_t)bs < (size_t)c->n - off ? (size_t)bs : (size_t)c->n - off;
    const int got = bk_smart_voice_process(v, g_mono + off, bn);
    int k;
    for (k = 0; k < got; k++) {
      if (v->fire_class[k] < min_cls) min_cls = v->fire_class[k];
      if (v->fire_class[k] > max_cls) max_cls = v->fire_class[k];
      if (!isfinite((double)v->fire_vel[k])) nonfinite++;
      if (!isfinite((double)v->fire_conf[k])) nonfinite++;
      if (fires < PASS_FIRES) {
        o64[PASS_FIRE_BASE + 4 * fires] = (double)blocks;
        o64[PASS_FIRE_BASE + 4 * fires + 1] = (double)v->fire_pad[k];
        o64[PASS_FIRE_BASE + 4 * fires + 2] = (double)v->fire_class[k];
        o64[PASS_FIRE_BASE + 4 * fires + 3] = (double)v->fire_stage[k];
        o32[PASS_FIRE32_BASE + 2 * fires] = v->fire_vel[k];
        o32[PASS_FIRE32_BASE + 2 * fires + 1] = v->fire_conf[k];
      }
      fires++;
    }
    bk_smart_voice_read_meters(v, m, 0);
    for (k = 0; k < BK_VOICE_METER_STRIDE; k++) {
      if (!isfinite(m[k])) nonfinite++;
    }
    blocks++;
    maybe_toggle(v, c, blocks - 1);
  }

  o64[0] = (double)blocks;
  o64[1] = (double)fires;
  o64[2] = (double)min_cls;
  o64[3] = (double)max_cls;
  o64[4] = (double)nonfinite;
  bk_smart_voice_read_meters(v, o64, PASS_METER_BASE);
  snap_pend(o64, PASS_PEND_BASE, o32, 0, v);
  o32[PASS_BAND_BASE] = v->last_band[0];
  o32[PASS_BAND_BASE + 1] = v->last_band[1];
  o32[PASS_BAND_BASE + 2] = v->last_band[2];

  bk_parity_emit(f, rec_name("pass", c->name), p, CASE_PARAMS, o64, PASS_N64, o32, PASS_N32);
}

/*
 * The same pass at block resolution, for the first MAX_BLOCKS blocks: the
 * whole pending table, the whole fire array and all twelve meters after every
 * single block.
 *
 * This is the record that pins the two clocks against each other. Between the
 * block an onset is registered in and the block its stage 1 comes due, the
 * slot holds a countdown, an id and nothing else; one block later it holds a
 * class and a velocity; later still stage 2 either agrees or moves the
 * corrections counter and the id goes to -1. Every one of those transitions
 * has a block number here, so a port that reads the band envelopes a block
 * early — which is the single most likely way to get this module wrong, and
 * produces entirely plausible output — diverges in this record and nowhere
 * else.
 *
 * Truncated at MAX_BLOCKS rather than run to the end because it is the
 * transitions that are interesting and they all happen within a few blocks of
 * a hit; the tail of every long case is covered by "pass" above, which runs
 * the whole signal.
 */
#define STREAM_B64 (1 + BK_VOICE_METER_STRIDE + 3 * BK_VOICE_FIRE_MAX + PEND_INTS)
#define STREAM_B32 (2 * BK_VOICE_FIRE_MAX + PEND_FLOATS)
#define STREAM_N64 (1 + MAX_BLOCKS * STREAM_B64)
#define STREAM_N32 (MAX_BLOCKS * STREAM_B32)

static double g_stream64[STREAM_N64];
static float g_stream32[STREAM_N32];

static void emit_stream(FILE *f, const voice_case *c) {
  double p[CASE_PARAMS];
  double *o64 = g_stream64;
  float *o32 = g_stream32;
  bk_smart_voice *v = &g_voice_a;
  const int bs = c->block_size <= 0 ? 128 : c->block_size;
  int i, blocks = 0;
  size_t off;

  case_params(c, p);
  build_case_signal(c);
  for (i = 0; i < STREAM_N64; i++) o64[i] = 0.0;
  for (i = 0; i < STREAM_N32; i++) o32[i] = 0.0f;

  init_case(v, c, g_hist);

  for (off = 0; off < (size_t)c->n && blocks < MAX_BLOCKS; off += (size_t)bs) {
    const size_t bn = (size_t)bs < (size_t)c->n - off ? (size_t)bs : (size_t)c->n - off;
    const int b64 = 1 + blocks * STREAM_B64;
    const int b32 = blocks * STREAM_B32;
    const int got = bk_smart_voice_process(v, g_mono + off, bn);
    int k;

    o64[b64] = (double)got;
    bk_smart_voice_read_meters(v, o64, b64 + 1);
    for (k = 0; k < BK_VOICE_FIRE_MAX; k++) {
      /* Only the rows this block wrote; the rest of the array is last block's
         and the JS's is too, but reading it would make the record depend on
         which language leaves what behind in a dead row. */
      o64[b64 + 13 + 3 * k] = k < got ? (double)v->fire_pad[k] : 0.0;
      o64[b64 + 13 + 3 * k + 1] = k < got ? (double)v->fire_class[k] : 0.0;
      o64[b64 + 13 + 3 * k + 2] = k < got ? (double)v->fire_stage[k] : 0.0;
      o32[b32 + k] = k < got ? v->fire_vel[k] : 0.0f;
      o32[b32 + BK_VOICE_FIRE_MAX + k] = k < got ? v->fire_conf[k] : 0.0f;
    }
    snap_pend(o64, b64 + 13 + 3 * BK_VOICE_FIRE_MAX, o32, b32 + 2 * BK_VOICE_FIRE_MAX, v);
    blocks++;
    maybe_toggle(v, c, blocks - 1);
  }
  o64[0] = (double)blocks;

  bk_parity_emit(f, rec_name("stream", c->name), p, CASE_PARAMS, o64, STREAM_N64, o32, STREAM_N32);
}

/*
 * The calibration capture ring, after a whole pass.
 *
 * It is the only consumer of pendBand and pendStrength, so a stage-1 band
 * vector written to the wrong slot is invisible everywhere else in this file:
 * the classifier reads bandScratch, not the pending copy, and the two are
 * written from the same local. Here the pending copy is what lands in the
 * ring, one measurement per stage-2 commit.
 *
 * Also the ring's staleness boundaries, probed the way parity-onset.c probes
 * the commit ring's, because they are the same three-part condition and
 * dropping any part of it hands the trainer someone else's timbre. And the
 * clear: clearCaptures resets the count and leaves the contents, so every
 * probe must go stale at once while the floats behind them do not move.
 */
#define CAP_PROBES 8
#define CAP_STRIDE BK_VOICE_CAP_STRIDE
#define CAP_N64 (3 + BK_VOICE_CAP_SLOTS + 3 * CAP_PROBES + 3)
#define CAP_N32 ((BK_VOICE_CAP_SLOTS + CAP_PROBES + 1) * CAP_STRIDE)

static double g_cap64[CAP_N64];
static float g_cap32[CAP_N32];

static void emit_cap(FILE *f, const voice_case *c) {
  double p[CASE_PARAMS];
  double *o64 = g_cap64;
  float *o32 = g_cap32;
  bk_smart_voice *v = &g_voice_a;
  const int bs = c->block_size <= 0 ? 128 : c->block_size;
  int i, blocks = 0;
  size_t off;
  long long cc;
  long long probes[CAP_PROBES];
  const int probe_base = 3 + BK_VOICE_CAP_SLOTS;
  const int probe32 = BK_VOICE_CAP_SLOTS * CAP_STRIDE;

  case_params(c, p);
  build_case_signal(c);
  for (i = 0; i < CAP_N64; i++) o64[i] = 0.0;
  for (i = 0; i < CAP_N32; i++) o32[i] = 0.0f;

  init_case(v, c, g_hist);
  for (off = 0; off < (size_t)c->n; off += (size_t)bs) {
    const size_t bn = (size_t)bs < (size_t)c->n - off ? (size_t)bs : (size_t)c->n - off;
    bk_smart_voice_process(v, g_mono + off, bn);
    blocks++;
    maybe_toggle(v, c, blocks - 1);
  }

  cc = v->capture_count;
  o64[0] = (double)blocks;
  o64[1] = (double)cc;
  o64[2] = (double)v->capture_class;

  /* Every slot the ring can still answer for, oldest first. A negative n is
     simply not readable, which is the same answer read_capture gives. */
  for (i = 0; i < BK_VOICE_CAP_SLOTS; i++) {
    float scratch[CAP_STRIDE];
    const long long n = cc - (long long)BK_VOICE_CAP_SLOTS + (long long)i;
    int got, k;
    for (k = 0; k < CAP_STRIDE; k++) scratch[k] = 0.0f;
    got = bk_smart_voice_read_capture(v, n, scratch);
    o64[3 + i] = (double)got;
    for (k = 0; k < CAP_STRIDE; k++) o32[i * CAP_STRIDE + k] = got ? scratch[k] : 0.0f;
  }

  probes[0] = -1;
  probes[1] = 0;
  probes[2] = cc - BK_VOICE_CAP_SLOTS - 1;
  probes[3] = cc - BK_VOICE_CAP_SLOTS;
  probes[4] = cc - 2;
  probes[5] = cc - 1;
  probes[6] = cc;
  probes[7] = cc + 1;
  for (i = 0; i < CAP_PROBES; i++) {
    float scratch[CAP_STRIDE];
    int got, k;
    for (k = 0; k < CAP_STRIDE; k++) scratch[k] = 0.0f;
    got = bk_smart_voice_read_capture(v, probes[i], scratch);
    o64[probe_base + 2 * i] = (double)probes[i];
    o64[probe_base + 2 * i + 1] = (double)got;
    for (k = 0; k < CAP_STRIDE; k++) o32[probe32 + i * CAP_STRIDE + k] = got ? scratch[k] : 0.0f;
  }

  /* And after the clear: the count goes to zero, every probe goes stale, and
     the last slot's floats are still in the array — which is what makes
     "clear the count, keep the contents" checkable rather than assumed. */
  {
    float scratch[CAP_STRIDE];
    int k, got;
    for (k = 0; k < CAP_STRIDE; k++) scratch[k] = 0.0f;
    bk_smart_voice_clear_captures(v);
    got = bk_smart_voice_read_capture(v, cc - 1, scratch);
    o64[probe_base + 2 * CAP_PROBES] = (double)v->capture_count;
    o64[probe_base + 2 * CAP_PROBES + 1] = (double)got;
    o64[probe_base + 2 * CAP_PROBES + 2] = (double)v->capture_class;
    if (cc > 0) {
      const long long base = ((cc - 1) % BK_VOICE_CAP_SLOTS) * CAP_STRIDE;
      for (k = 0; k < CAP_STRIDE; k++) {
        o32[probe32 + CAP_PROBES * CAP_STRIDE + k] = v->captures[base + k];
      }
    }
  }

  bk_parity_emit(f, rec_name("cap", c->name), p, CASE_PARAMS, o64, CAP_N64, o32, CAP_N32);
}

/* --- layer 3: structural ------------------------------------------------ */

/*
 * reset() and resetDetector() are hand-written field by field in both
 * languages, and they differ from each other on purpose: resetDetector forgets
 * the performance-in-flight, reset also forgets the performance, and *neither*
 * forgets the profile. A field left out of either is exactly the kind of
 * mistake that survives every behavioural record in this file — the module
 * keeps working, just with one stale number inside it, until the one session
 * where that number matters.
 *
 * So both get the same three-snapshot treatment: a dirty instance, a fresh
 * one, and the dirty one after the call. What must be equal and what must not
 * is asserted on the JS side, where both languages' three snapshots are in
 * hand at once.
 *
 * The detector's own fields are here only where Smart Voice reads them — the
 * three fast envelopes, the level envelope, the commit counter and the frame
 * clock. Its arithmetic is pinned by parity-onset.c against the same JS on a
 * superset of these signals, and re-checking it here would bury a Smart Voice
 * failure in a diff of somebody else's numbers.
 */
#define VSTATE_SCALARS 45
#define VSTATE_D (VSTATE_SCALARS + PEND_INTS)
#define VSTATE_F (PEND_FLOATS + 2 * BK_VOICE_CLASS_COUNT * BK_ONSET_FEATURE_COUNT + 3 + \
                  2 * BK_ONSET_FEATURE_COUNT + BK_VOICE_CAP_SLOTS * CAP_STRIDE)
#define VSTATE_SNAPS 3

static void snap_voice(double *o64, int i64, float *o32, int i32, const bk_smart_voice *v) {
  const bk_onset *d = &v->det;
  const int tbl = BK_VOICE_CLASS_COUNT * BK_ONSET_FEATURE_COUNT;
  int i = i64, k;

  o64[i++] = v->sr;
  o64[i++] = (double)v->enabled;
  o64[i++] = (double)v->mode;
  o64[i++] = v->margin;
  o64[i++] = v->vel_min;
  o64[i++] = v->vel_db;
  o64[i++] = (double)v->monitor;
  o64[i++] = v->floor_db;
  o64[i++] = (double)v->fire_count;
  o64[i++] = (double)v->onset_count;
  o64[i++] = (double)v->drained;
  o64[i++] = (double)v->capture_class;
  o64[i++] = (double)v->capture_count;
  o64[i++] = (double)v->hit_count;
  o64[i++] = (double)v->last_class;
  o64[i++] = v->last_conf;
  o64[i++] = v->last_vel;
  o64[i++] = (double)v->last_stage;
  o64[i++] = v->last_strength;
  o64[i++] = (double)v->corrections;
  o64[i++] = v->level;
  o64[i++] = v->scratch_ratio;
  o64[i++] = v->scratch_conf;
  for (k = 0; k < BK_VOICE_CLASS_COUNT; k++) o64[i++] = (double)v->class_pad[k];
  /* The detector, as Smart Voice sees it. */
  o64[i++] = d->fast_low.env;
  o64[i++] = d->fast_mid.env;
  o64[i++] = d->fast_high.env;
  o64[i++] = d->level.env;
  o64[i++] = (double)d->commit_count;
  o64[i++] = (double)d->count;
  o64[i++] = (double)d->frames;
  o64[i++] = (double)d->last_hit_frame;
  o64[i++] = (double)d->window_left;
  o64[i++] = (double)d->pending_feature;
  o64[i++] = (double)d->pending_index;
  o64[i++] = (double)d->lag_pos;
  o64[i++] = d->acc_low;
  o64[i++] = d->acc_mid;
  o64[i++] = d->acc_high;
  o64[i++] = d->acc_zc;
  o64[i++] = d->acc_frames;
  o64[i++] = (double)d->last_sign;
  /* Pads the scalar block out to VSTATE_SCALARS so a field appended above
     cannot silently shift the pending table's offset. */
  while (i < i64 + VSTATE_SCALARS) o64[i++] = 0.0;

  snap_pend(o64, i64 + VSTATE_SCALARS, o32, i32, v);
  i = i32 + PEND_FLOATS;
  for (k = 0; k < tbl; k++) o32[i + k] = v->centroids[k];
  i += tbl;
  for (k = 0; k < tbl; k++) o32[i + k] = v->attack[k];
  i += tbl;
  for (k = 0; k < 3; k++) o32[i + k] = v->last_band[k];
  i += 3;
  for (k = 0; k < BK_ONSET_FEATURE_COUNT; k++) o32[i + k] = v->band_scratch[k];
  i += BK_ONSET_FEATURE_COUNT;
  for (k = 0; k < BK_ONSET_FEATURE_COUNT; k++) o32[i + k] = v->feat_scratch[k];
  i += BK_ONSET_FEATURE_COUNT;
  /* The capture ring's contents, which neither reset clears. */
  for (k = 0; k < BK_VOICE_CAP_SLOTS * CAP_STRIDE; k++) o32[i + k] = v->captures[k];
}

static double g_state64[VSTATE_SNAPS * VSTATE_D];
static float g_state32[VSTATE_SNAPS * VSTATE_F];

/* `full` picks which call is under test: reset() or resetDetector(). */
static void emit_state(FILE *f, const voice_case *c, int full) {
  double p[CASE_PARAMS];
  double *o64 = g_state64;
  float *o32 = g_state32;
  bk_smart_voice *used = &g_voice_a;
  bk_smart_voice *fresh = &g_voice_b;
  const int bs = c->block_size <= 0 ? 128 : c->block_size;
  int i, blocks = 0;
  size_t off;

  case_params(c, p);
  build_case_signal(c);
  for (i = 0; i < VSTATE_SNAPS * VSTATE_D; i++) o64[i] = 0.0;
  for (i = 0; i < VSTATE_SNAPS * VSTATE_F; i++) o32[i] = 0.0f;

  /* Never drained of anything: the pending table is left mid-flight and the
     detector's ring full, which is the dirtiest state a live caller can hand
     a reset. */
  init_case(used, c, g_hist);
  for (off = 0; off < (size_t)c->n; off += (size_t)bs) {
    const size_t bn = (size_t)bs < (size_t)c->n - off ? (size_t)bs : (size_t)c->n - off;
    bk_smart_voice_process(used, g_mono + off, bn);
    blocks++;
    maybe_toggle(used, c, blocks - 1);
  }
  snap_voice(o64, 0, o32, 0, used);

  /* A second lag history, so the fresh instance's zeroed one cannot overwrite
     the dirty instance's before it has been read. */
  init_case(fresh, c, g_hist_fresh);
  snap_voice(o64, VSTATE_D, o32, VSTATE_F, fresh);

  if (full) bk_smart_voice_reset(used);
  else bk_smart_voice_reset_detector(used);
  snap_voice(o64, 2 * VSTATE_D, o32, 2 * VSTATE_F, used);

  bk_parity_emit(f, rec_name(full ? "reset" : "reset-det", c->name), p, CASE_PARAMS, o64,
                 VSTATE_SNAPS * VSTATE_D, o32, VSTATE_SNAPS * VSTATE_F);
}

/* --- main --------------------------------------------------------------- */

int main(int argc, char **argv) {
  FILE *f;
  int i;

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
  emit_layer1(f);

  for (i = 0; i < CASE_COUNT; i++) {
    if (CASES[i].n > MAX_FRAMES) {
      fprintf(stderr, "case %s exceeds MAX_FRAMES\n", CASES[i].name);
      return 2;
    }
    if (CASES[i].block_size > MAX_FRAMES) {
      fprintf(stderr, "case %s block exceeds MAX_FRAMES\n", CASES[i].name);
      return 2;
    }
    if (bk_smart_voice_hist_floats(CASES[i].sr) > (int)(sizeof(g_hist) / sizeof(g_hist[0]))) {
      fprintf(stderr, "case %s needs more lag history than g_hist holds\n", CASES[i].name);
      return 2;
    }
    emit_pass(f, &CASES[i]);
    emit_stream(f, &CASES[i]);
    emit_cap(f, &CASES[i]);
    emit_state(f, &CASES[i], 0);
    emit_state(f, &CASES[i], 1);
  }

  if (!bk_parity_close(f)) {
    fprintf(stderr, "cannot patch record count\n");
    return 2;
  }
  fclose(f);
  return 0;
}
