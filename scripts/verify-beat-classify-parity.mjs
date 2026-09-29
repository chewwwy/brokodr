/**
 * Parity oracle for the C port of dsp/core/beat-classify.js (Phase 5, route (c)).
 *
 * ## The two clocks
 *
 * Smart Voice is the first module in the port whose behaviour depends on another
 * module's *live internal state* rather than on its return value. It reaches into
 * the detector for `det.fastLow.env`, `det.fastMid.env`, `det.fastHigh.env`,
 * `det.level.env` and `det.strengths[h]` — and it reads the envelopes one whole
 * block *after* the block the onset was found in (STAGE1_DELAY_BLOCKS). So there
 * are two clocks to keep aligned:
 *
 *   - the detector's, which decides whether an onset exists at all;
 *   - the pending table's, which decides when stage 1 reads those envelopes and
 *     when stage 2 gets the finished features.
 *
 * A port with perfect arithmetic and the timing off by one block produces the
 * same hits with the wrong velocities and the wrong classes, and nothing that
 * only looks at the end of a pass would ever see it. That is why the whole
 * pending table is compared after *every* block (layer 2's `stream` records)
 * rather than once at the end, and why the reset records compare the deliberately
 * stale fields as carefully as the cleared ones.
 *
 * ## What this gates on
 *
 *   LAYER 1 — EXACT, HARD GATE. Defaults, the factory profile, every parameter
 *   clamp on both objects, the four ToInt32 setters over the whole int32 range
 *   including the wrap through zero, resetCentroids, classify() on hand-built
 *   vectors and velocityFrom over its whole parameter space. Nothing on any of
 *   these paths accumulates and nothing calls libm except sqrt, so any
 *   difference at all is a failure. No tolerance slack anywhere in this layer.
 *
 *   LAYER 2 — BEHAVIOURAL. Whole passes of synthetic kit audio, block by block:
 *   what fired, in which block, at which stage, with which pad and class; all
 *   twelve meters; the entire pending table at every block boundary; and the
 *   calibration capture ring with its staleness boundaries. The discrete output
 *   — counts, classes, stages, pads, pending ids, countdowns, read flags — is a
 *   hard gate at exact equality. The floats are held to a band, because
 *   velocity descends from 20*log10() and that is the one libm call on the hot
 *   path; bit-identity is counted and reported as a canary, per the standing
 *   decision in commit f1da024.
 *
 *   LAYER 3 — STRUCTURAL. reset() and resetDetector() clear exactly the fields
 *   they promise and no others — including the five pending-slot fields both
 *   calls deliberately leave stale, which is the kind of thing a tidier-minded
 *   port "fixes" and thereby breaks. Plus the fired-class range (hazard 3) and
 *   the int32 pending-id wrap (hazard 2).
 *
 *   CROSS-TOOLCHAIN — HARD GATE on the four ToInt32 setters, informational
 *   everywhere else, exactly as the onset battery does it.
 *
 * The stimulus generator is mirrored verbatim from parity-beat-classify.c, which
 * is in turn identical to parity-onset.c's: integer arithmetic and IEEE-754
 * add/sub/mul/div only, so JavaScript reproduces it bit for bit.
 *
 * What is deliberately *not* checked here: the detector's own arithmetic. Every
 * band energy, position and feature Smart Voice consumes is already pinned
 * bit-for-bit by verify-onset-parity.mjs against the same JS on a superset of
 * these signals. What this battery checks about the detector is only what Smart
 * Voice does with it: which fields it reads, and when.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildAndRun, createChecker, describe, fillSignal, TOL } from "./lib/parity-stream.mjs";
import {
  SmartVoice,
  VOICE_KEY,
  VOICE_DEFAULTS,
  VOICE_MODE,
  CLASS_COUNT,
  DEFAULT_CLASS_PADS,
  FACTORY_CENTROIDS,
  FACTORY_ATTACK,
  CAP_STRIDE,
  CAP_ATTACK_OFFSET,
  VOICE_METER_STRIDE,
  STAGE1_DELAY_BLOCKS,
} from "../packages/web/public/dsp/core/beat-classify.js";
import { OnsetDetector, FEATURE_COUNT } from "../packages/web/public/dsp/core/onset.js";
import { gainToDb } from "../packages/web/public/dsp/core/utils.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

/* ------------------------------------------------------------- constants */

/*
 * CAP_SLOTS, PEND_SLOTS and FIRE_MAX are module-private in the JS — deliberately,
 * they are not wire constants — so they are written out here and the `factory`
 * record checks the C against these literals. That record is what pins them; if
 * the JS ever changes one, that check is the thing that fails.
 */
const CAP_SLOTS = 64;
const PEND_SLOTS = 16;
const FIRE_MAX = 8;
const MAX_BLOCKS = 96;

const CASE_PARAMS = 24;
const PARAM_SNAP = 13;
const TABLES_N32 = 2 * CLASS_COUNT * FEATURE_COUNT;

const PEND_INTS = 5 * PEND_SLOTS;
const PEND_FLOATS = 5 * PEND_SLOTS;

const PASS_FIRES = 128;
const PASS_METER_BASE = 5;
const PASS_PEND_BASE = PASS_METER_BASE + VOICE_METER_STRIDE;
const PASS_FIRE_BASE = PASS_PEND_BASE + PEND_INTS;
const PASS_N64 = PASS_FIRE_BASE + 4 * PASS_FIRES;
const PASS_BAND_BASE = PEND_FLOATS;
const PASS_FIRE32_BASE = PASS_BAND_BASE + 3;
const PASS_N32 = PASS_FIRE32_BASE + 2 * PASS_FIRES;

const STREAM_B64 = 1 + VOICE_METER_STRIDE + 3 * FIRE_MAX + PEND_INTS;
const STREAM_B32 = 2 * FIRE_MAX + PEND_FLOATS;
const STREAM_N64 = 1 + MAX_BLOCKS * STREAM_B64;
const STREAM_N32 = MAX_BLOCKS * STREAM_B32;

const CAP_PROBES = 8;
const CAP_N64 = 3 + CAP_SLOTS + 3 * CAP_PROBES + 3;
const CAP_N32 = (CAP_SLOTS + CAP_PROBES + 1) * CAP_STRIDE;

const VSTATE_SCALARS = 45;
const VSTATE_D = VSTATE_SCALARS + PEND_INTS;
const VSTATE_F = PEND_FLOATS + 2 * CLASS_COUNT * FEATURE_COUNT + 3 + 2 * FEATURE_COUNT +
  CAP_SLOTS * CAP_STRIDE;
const VSTATE_SNAPS = 3;

const STIM = { CLICK: 0, KICK: 1, HAT: 2, SNARE: 3, SILENCE: 4, DC: 5, NOISE: 6 };

/** The out-of-band keys the wire cannot reach but setParam still forwards. */
const LOW_CROSS_KEY = 256;
const HIGH_CROSS_KEY = 257;

/** Mirrors the C's pokes exactly — see apply_pokes in parity-beat-classify.c. */
const POKE = {
  centroidCls: 0,
  centroidFeat: 1,
  centroidVal: 0.467,
  attackCls: 2,
  attackBand: 0,
  attackVal: 0.25,
  muteCls: 1,
  padCls: 2,
  padVal: 11,
};

const VEL_DBIN = [
  -200, -120, -90, -64, -42, -30, -16, -6, -3, 0, 6, 120,
  -Infinity, Infinity, NaN,
];

/** Mirrors LEVEL_ENVS in parity-beat-classify.c — see the note above it. */
const LEVEL_ENVS = [
  0, -0, 1e-30, 1e-12, 1e-9, 2e-9, 0.001, 0.25, 1, 4, 1e30,
  -1, -Infinity, Infinity, NaN,
];
const VEL_FLOORS = [-90, -42, -6];

/* --------------------------------------------------------------- helpers */

const toInt32 = (x) => x | 0;

/** Exact equality, NaN-aware. Layer 1 uses nothing looser than this. */
const same = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b));

/** Relative error that treats two NaNs, two identical infinities, as agreement. */
function relErr(a, b) {
  if (same(a, b)) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
}

/** setParam takes names; the wire takes indices. This is that mapping. */
function keyName(k) {
  if (k >= 0 && k < VOICE_KEY.length) return VOICE_KEY[k];
  if (k === LOW_CROSS_KEY) return "lowCrossHz";
  if (k === HIGH_CROSS_KEY) return "highCrossHz";
  return `__no_such_key_${k}`;
}

/**
 * The JS equivalent of bk_smart_voice_init(v, sr, opts, hist): the constructor,
 * then every opts entry applied through setParam in wire-index order. Order
 * matters — `enabled` is index 0 and switching it on calls resetDetector().
 */
function initWithOpts(sr, opts) {
  const v = new SmartVoice(sr);
  if (opts) for (let k = 0; k < VOICE_KEY.length; k++) v.setParam(VOICE_KEY[k], opts[k]);
  return v;
}

function applyPokes(v) {
  v.setCentroid(POKE.centroidCls, POKE.centroidFeat, POKE.centroidVal);
  v.setAttackCentroid(POKE.attackCls, POKE.attackBand, POKE.attackVal);
  v.setClassPad(POKE.muteCls, -1);
  v.setClassPad(POKE.padCls, POKE.padVal);
}

/** Smart Voice's seven parameter fields and the detector's six. 13 doubles. */
const snapParams = (v) => [
  v.enabled ? 1 : 0,
  v.mode,
  v.margin,
  v.velMin,
  v.velDb,
  v.monitor ? 1 : 0,
  v.floorDb,
  v.det.sensitivity,
  v.det.floorDb,
  v.det.minGapMs,
  v.det.featureMs,
  v.det.lowCrossHz,
  v.det.highCrossHz,
];

/** Both centroid tables, so a write that landed in the wrong one is caught. */
function snapTables(v) {
  const o = new Float32Array(TABLES_N32);
  o.set(v.centroids, 0);
  o.set(v.attack, CLASS_COUNT * FEATURE_COUNT);
  return o;
}

/**
 * The whole pending table, in the C's layout: five int fields to the f64 side
 * slot-major, then vel, strength and the three band shares to the f32 side.
 */
function snapPend(v, o64, i64, o32, i32) {
  const n = PEND_SLOTS;
  for (let s = 0; s < n; s++) {
    o64[i64 + 5 * s] = v.pendId[s];
    o64[i64 + 5 * s + 1] = v.pendClass[s];
    o64[i64 + 5 * s + 2] = v.pendFired[s];
    o64[i64 + 5 * s + 3] = v.pendWait[s];
    o64[i64 + 5 * s + 4] = v.pendRead[s];
    o32[i32 + s] = v.pendVel[s];
    o32[i32 + n + s] = v.pendStrength[s];
    o32[i32 + 2 * n + 3 * s] = v.pendBand[3 * s];
    o32[i32 + 2 * n + 3 * s + 1] = v.pendBand[3 * s + 1];
    o32[i32 + 2 * n + 3 * s + 2] = v.pendBand[3 * s + 2];
  }
}

/** Mirrored verbatim from parity-beat-classify.c, which mirrors parity-onset.c. */
function stim(n, sr, kind, hits, gapMs, amp, poison) {
  const dst = new Float64Array(n);
  let stateLcg = 0x2468ace0 >>> 0;
  let prevNoise = 0;

  if (kind === STIM.SILENCE) {
    // silence, then the poisoning below: a NaN in silence is a real input
  } else if (kind === STIM.DC) {
    for (let i = 0; i < n; i++) dst[i] = amp;
  } else if (kind === STIM.NOISE) {
    const shared = fillSignal(n, 2);
    for (let i = 0; i < n; i++) dst[i] = shared[i] * amp;
  } else {
    let hp = toInt32(sr / 120);
    if (hp < 1) hp = 1;
    for (let h = 0; h < hits; h++) {
      const start = toInt32(h * gapMs * 0.001 * sr);
      if (start < 0) continue;
      let env = amp;
      for (let k = 0; start + k < n; k++) {
        stateLcg = (Math.imul(stateLcg, 1664525) + 1013904223) >>> 0;
        const noise = ((stateLcg >>> 8) / 16777216) * 2 - 1;
        const diff = noise - prevNoise;
        prevNoise = noise;

        let w;
        if (kind === STIM.CLICK) w = k === 0 ? 1 : 0;
        else if (kind === STIM.KICK) w = Math.floor(k / hp) % 2 === 1 ? -1 : 1;
        else if (kind === STIM.HAT) w = diff * 0.5;
        else w = (Math.floor(k / hp) % 2 === 1 ? -0.5 : 0.5) + diff * 0.25;

        dst[start + k] += env * w;
        env = env * (kind === STIM.HAT ? 0.997 : 0.9995);
        if (env < 1 / 1048576) break;
      }
    }
  }

  if (poison && n > 16) {
    dst[Math.floor(n / 8)] = NaN;
    dst[Math.floor(n / 4)] = Infinity;
    dst[Math.floor(n / 4) + 1] = -Infinity;
  }
  return dst;
}

/** One case record's 24 parameters, unpacked exactly as case_params packed them. */
function unpackCase(rec) {
  const p = rec.params;
  const c = {
    sr: p[0],
    kind: p[1],
    hits: p[2],
    gapMs: p[3],
    amp: p[4],
    n: p[5],
    blockSize: p[6],
    poison: p[7],
    captureCls: p[18],
    enableAtBlock: p[19],
    counterSeed: p[20],
    disableAtBlock: p[22],
    drainLag: p[23],
    centroidPoke: p[21],
  };
  c.opts = new Float64Array(VOICE_KEY.length);
  for (let i = 0; i < VOICE_KEY.length; i++) c.opts[i] = p[8 + i];

  // build_case_signal defaults a *zero* rate and passes NaN straight through,
  // which is what the C does — so a NaN-rate case generates from NaN on both
  // sides and every offset in it collapses to zero.
  const stimSr = c.sr === 0 ? 48000 : c.sr;
  const sig = stim(c.n, stimSr, c.kind, c.hits, c.gapMs, c.amp, c.poison);
  c.mono = new Float32Array(c.n);
  for (let i = 0; i < c.n; i++) c.mono[i] = sig[i];
  c.bs = c.blockSize <= 0 ? 128 : c.blockSize;
  return c;
}

/** The JS side of init_case: construct, load the profile, arm, wind the counters. */
function initCase(c) {
  const v = initWithOpts(c.sr, c.opts);
  if (c.centroidPoke) applyPokes(v);
  if (c.captureCls >= 0) v.setCapture(c.captureCls);
  if (c.counterSeed > 0) {
    v.onsetCount = c.counterSeed;
    // drainLag: wind `drained` back behind the commit counter, the one state
    // the module cannot reach by itself — see the C note on the same poke.
    v.drained = c.drainLag > 0 ? c.counterSeed - c.drainLag : c.counterSeed;
    v.det.commitCount = c.counterSeed;
  }
  return v;
}

/** maybe_toggle: the UI toggle, applied after the numbered block, both ways. */
function maybeToggle(v, c, block) {
  if (c.enableAtBlock >= 0 && block === c.enableAtBlock) v.setParam("enabled", 1);
  if (c.disableAtBlock >= 0 && block === c.disableAtBlock) v.setParam("enabled", 0);
}

/**
 * Compare one record's whole payload against a mirror, at exact equality.
 * Layer 1's only comparator: no tolerance, no slack, first offender reported.
 */
function exactBlock(label, recs, mirror) {
  let bad = 0;
  let first = "";
  let lenBad = 0;
  for (const rec of recs) {
    const { out64 = [], out32 = [] } = mirror(rec);
    if (rec.out64.length !== out64.length || rec.out32.length !== out32.length) {
      lenBad++;
      if (!first) {
        first = `${rec.name}: widths C ${rec.out64.length}/${rec.out32.length} ` +
          `JS ${out64.length}/${out32.length}`;
      }
      continue;
    }
    for (let i = 0; i < out64.length; i++) {
      if (!same(rec.out64[i], out64[i])) {
        bad++;
        if (!first) first = `${rec.name} f64[${i}]: C ${rec.out64[i]} JS ${out64[i]}`;
      }
    }
    for (let i = 0; i < out32.length; i++) {
      const want = Math.fround(out32[i]);
      if (!same(rec.out32[i], want)) {
        bad++;
        if (!first) first = `${rec.name} f32[${i}]: C ${rec.out32[i]} JS ${want}`;
      }
    }
  }
  ok(
    label,
    bad === 0 && lenBad === 0,
    bad || lenBad ? `${bad} value / ${lenBad} width mismatches, first: ${first}` :
      `${recs.length} record${recs.length === 1 ? "" : "s"}, bit-identical`,
  );
}

/* --------------------------------------------------------------- the dump */

const dumps = buildAndRun({
  root,
  name: "parity-beat-classify",
  sources: [
    `${root}/packages/native/src/dsp/utils.c`,
    `${root}/packages/native/src/dsp/biquad.c`,
    `${root}/packages/native/src/dsp/onset.c`,
    `${root}/packages/native/src/dsp/beat-classify.c`,
    `${root}/packages/native/tests/parity-beat-classify.c`,
  ],
  include: `${root}/packages/native/include`,
  ok,
  state,
});
const native = dumps.native;
const layer = (prefix) => native.filter((r) => r.name.startsWith(`${prefix}:`) || r.name === prefix);

/* =========================================================== layer 1 ==== */

console.log("\n== layer 1: exact (hard gate) ==");

{
  const rec = layer("defaults")[0];
  const want = VOICE_KEY.map((k) => {
    const v = VOICE_DEFAULTS[k];
    return typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
  exactBlock("defaults match VOICE_DEFAULTS exactly", [rec], () => ({ out64: want }));
  ok("VOICE_MODE.FAST is the default mode", VOICE_DEFAULTS.mode === VOICE_MODE.FAST, String(VOICE_DEFAULTS.mode));
}

{
  // The factory profile and every structural constant in one record. This is
  // what pins CAP_SLOTS, PEND_SLOTS and FIRE_MAX, which the JS keeps private.
  const rec = layer("factory")[0];
  const out64 = [
    ...DEFAULT_CLASS_PADS,
    CLASS_COUNT,
    FEATURE_COUNT,
    CAP_STRIDE,
    CAP_ATTACK_OFFSET,
    CAP_SLOTS,
    PEND_SLOTS,
    FIRE_MAX,
    VOICE_METER_STRIDE,
    STAGE1_DELAY_BLOCKS,
  ];
  const out32 = new Float32Array(TABLES_N32);
  for (let c = 0; c < CLASS_COUNT; c++) {
    for (let f = 0; f < FEATURE_COUNT; f++) {
      out32[c * FEATURE_COUNT + f] = FACTORY_CENTROIDS[c][f];
      out32[CLASS_COUNT * FEATURE_COUNT + c * FEATURE_COUNT + f] = f < 3 ? FACTORY_ATTACK[c][f] : 0;
    }
  }
  exactBlock("factory profile, pads and every structural constant", [rec], () => ({ out64, out32 }));
  ok("STAGE1_DELAY_BLOCKS is at least 1", STAGE1_DELAY_BLOCKS >= 1, String(STAGE1_DELAY_BLOCKS));
  ok(
    "a fresh instance carries the factory profile",
    (() => {
      const v = new SmartVoice(48000);
      const t = snapTables(v);
      for (let i = 0; i < TABLES_N32; i++) if (t[i] !== Math.fround(out32[i])) return false;
      for (let c = 0; c < CLASS_COUNT; c++) if (v.classPad[c] !== DEFAULT_CLASS_PADS[c]) return false;
      return true;
    })(),
    "resetCentroids() in the constructor",
  );
}

{
  // hist_floats forwards to the detector's lag sizing. Mirrored by constructing
  // the detector rather than by copying LAG_MS, so a change to either is caught
  // here instead of quietly diverging.
  const recs = layer("hist-floats");
  exactBlock("lag-history sizing forwards to the detector", recs, (rec) => {
    const det = new OnsetDetector(rec.params[0]);
    return { out64: [3 * det.lagLen] };
  });
}

{
  // Every parameter at, inside and beyond both stops, with both objects read
  // back — so a key that writes the right clamp to the wrong field, or forgets
  // to forward, or forwards its clamped copy instead of the raw value, fails.
  const recs = layer("param");
  exactBlock("every parameter clamp, both objects read back", recs, (rec) => {
    const v = new SmartVoice(48000);
    v.setParam(keyName(rec.params[0]), rec.params[1]);
    return { out64: snapParams(v) };
  });
  ok("all 76 parameter cases present", recs.length === 76, `${recs.length} records`);
}

{
  /*
   * init(opts) against init(NULL) + setParam.
   *
   * For an in-band key the two are the same thing by construction and the C's
   * own two halves must agree without any reference. For an out-of-band key —
   * the two forwarded crossovers — they must *not*: opts cannot carry them, so
   * the first half stays at its defaults while the second half forwards. That
   * asymmetry is the assertion that the wire cannot reach lowCrossHz.
   */
  const recs = layer("opts-equiv");
  let halvesBad = 0;
  let asymmetryFound = 0;
  let firstHalves = "";
  for (const rec of recs) {
    const key = rec.params[0];
    const inBand = key >= 0 && key < VOICE_KEY.length;
    let equal = true;
    for (let i = 0; i < PARAM_SNAP; i++) {
      if (!same(rec.out64[i], rec.out64[PARAM_SNAP + i])) equal = false;
    }
    if (inBand && !equal) {
      halvesBad++;
      if (!firstHalves) firstHalves = `${rec.name} key ${key} value ${rec.params[1]}`;
    }
    if (!inBand && !equal) asymmetryFound++;
  }
  ok(
    "init(opts) == init(NULL) + setParam for every in-band key",
    halvesBad === 0,
    halvesBad ? `${halvesBad} disagree, first ${firstHalves}` : `${recs.length} records`,
  );
  ok(
    "opts cannot reach the forwarded crossovers",
    asymmetryFound > 0,
    `${asymmetryFound} out-of-band cases where the two halves differ`,
  );

  exactBlock("both construction paths match the JS exactly", recs, (rec) => {
    const key = rec.params[0];
    const opts = new Float64Array(VOICE_KEY.length).fill(NaN);
    if (key >= 0 && key < VOICE_KEY.length) opts[key] = rec.params[1];
    const a = initWithOpts(48000, opts);
    const b = new SmartVoice(48000);
    b.setParam(keyName(key), rec.params[1]);
    return { out64: [...snapParams(a), ...snapParams(b)] };
  });
}

{
  // setCentroid over the ToInt32 arguments. 2^32 is the one that matters: it
  // wraps to 0, so setCentroid(2^32, ...) writes class 0 rather than being
  // rejected, and a port that range-checked before coercing rejects it.
  const recs = layer("centroid");
  exactBlock("setCentroid: ToInt32 coercion and both range checks", recs, (rec) => {
    const v = new SmartVoice(48000);
    v.setCentroid(rec.params[0], rec.params[1], rec.params[2]);
    return { out32: snapTables(v) };
  });

  exactBlock("setCentroid / setAttackCentroid: the stored value", layer("centroid-val"), (rec) => {
    const v = new SmartVoice(48000);
    v.setCentroid(2, 1, rec.params[0]);
    v.setAttackCentroid(3, 2, rec.params[0]);
    return { out32: snapTables(v) };
  });

  // The band check is `> 2`, not `>= FEATURE_COUNT`, so band 3 is rejected
  // where feature 3 is not. A shared helper would make the two agree.
  exactBlock("setAttackCentroid: the narrower band check", layer("attack"), (rec) => {
    const v = new SmartVoice(48000);
    v.setAttackCentroid(rec.params[0], rec.params[1], rec.params[2]);
    return { out32: snapTables(v) };
  });

  // Asymmetric on purpose: the sign test is on the uncoerced double and the
  // store is ToInt32, so -0.5 mutes where ToInt32(-0.5) would be pad 0, and
  // NaN fails `< 0` and stores pad 0.
  exactBlock("setClassPad: the asymmetric coercion", layer("class-pad"), (rec) => {
    const v = new SmartVoice(48000);
    v.setClassPad(rec.params[0], rec.params[1]);
    return { out64: Array.from(v.classPad) };
  });

  exactBlock("setCapture: coercion and range", layer("capture-class"), (rec) => {
    const v = new SmartVoice(48000);
    v.setCapture(rec.params[0]);
    return { out64: [v.captureClass] };
  });

  ok("setter sweeps all present", recs.length === 62, `${recs.length} centroid records`);
}

{
  /*
   * resetCentroids after a poke. Both tables must come back to the factory
   * profile and the pads must *not* — they are not part of the profile
   * resetCentroids restores, and a reset that tidied them as well would look
   * harmless and lose a trained user's pad mapping.
   */
  const poked = layer("poked")[0];
  const reset = layer("reset-centroids")[0];

  exactBlock("a poked profile matches the JS", [poked], () => {
    const v = new SmartVoice(48000);
    applyPokes(v);
    return { out64: Array.from(v.classPad), out32: snapTables(v) };
  });
  exactBlock("resetCentroids matches the JS", [reset], () => {
    const v = new SmartVoice(48000);
    applyPokes(v);
    v.resetCentroids();
    return { out64: Array.from(v.classPad), out32: snapTables(v) };
  });

  let tablesMoved = 0;
  for (let i = 0; i < TABLES_N32; i++) if (poked.out32[i] !== reset.out32[i]) tablesMoved++;
  ok("the poke is observable in the tables", tablesMoved >= 2, `${tablesMoved} of ${TABLES_N32} floats differ`);

  let padsSame = true;
  for (let i = 0; i < CLASS_COUNT; i++) if (poked.out64[i] !== reset.out64[i]) padsSame = false;
  ok(
    "resetCentroids restores the tables and leaves the pads",
    padsSame,
    `pads ${Array.from(reset.out64.slice(0, CLASS_COUNT)).join(", ")}`,
  );

  const fresh = snapTables(new SmartVoice(48000));
  let backToFactory = true;
  for (let i = 0; i < TABLES_N32; i++) if (reset.out32[i] !== fresh[i]) backToFactory = false;
  ok("and the restored tables are the factory profile", backToFactory, "");
}

{
  /*
   * classify() on hand-built vectors: an exact centroid (distance zero, so the
   * ratio divides by the *second* distance and the `secondD > 1e-12` guard is
   * all that stands between the record and a division by zero), vectors
   * equidistant from two and from all four classes, the zero vector, vectors
   * far outside the unit cube, and zero axes — the one input where the guard's
   * false arm is reachable with finite data.
   */
  const build = (rec, poke) => {
    const v = new SmartVoice(48000);
    if (poke) applyPokes(v);
    const feat = new Float32Array(FEATURE_COUNT);
    for (let k = 0; k < FEATURE_COUNT; k++) feat[k] = rec.params[2 + k];
    const table = rec.params[1] === 0 ? v.centroids : v.attack;
    const cls = v.classify(feat, 0, rec.params[0], table);
    return { out64: [cls, v.scratchRatio, v.scratchConf] };
  };
  const recs = layer("classify");
  exactBlock("classify on the factory profile", recs, (rec) => build(rec, false));
  exactBlock("classify on a poked profile", layer("classify-poked"), (rec) => build(rec, true));

  /*
   * The collapsed profile — two classes trained onto the same sound, one axis
   * apart by `delta`. The vector sits on kick exactly, so bestD is 0 and
   * secondD is delta squared: the only arrangement in which the `secondD >
   * 1e-12` guard's constant is observable. See DEGEN_DELTAS in
   * parity-beat-classify.c.
   */
  const KICK = [0.336, 0.658, 0.006, 0.104];
  exactBlock("classify on a collapsed profile", layer("classify-degen"), (rec) => {
    const v = new SmartVoice(48000);
    const delta = rec.params[0];
    const feat = new Float32Array(FEATURE_COUNT);
    for (let k = 0; k < FEATURE_COUNT; k++) {
      feat[k] = KICK[k];
      v.setCentroid(1, k, k === FEATURE_COUNT - 1 ? KICK[k] + delta : KICK[k]);
    }
    const cls = v.classify(feat, 0, FEATURE_COUNT, v.centroids);
    return { out64: [cls, v.scratchRatio, v.scratchConf] };
  });
  {
    const degen = layer("classify-degen");
    let inWindow = 0;
    for (const rec of degen) if (rec.out64[1] === 0) inWindow++;
    ok(
      "the collapsed profile drives the ratio to 0, so the guard is live there",
      degen.length >= 7 && inWindow >= 4,
      `${inWindow}/${degen.length} records with ratio exactly 0`,
    );
  }
  ok("all 36 classify vectors present", recs.length === 36, `${recs.length} records`);

  // The ties are the point: without one the sweep is only measuring nearest-
  // centroid on unambiguous data, and the strict `<` that breaks a tie by class
  // order would never be exercised.
  let ties = 0;
  for (const rec of recs) if (rec.out64[1] === 1) ties++;
  ok("the sweep contains ratio-1 ties", ties >= 3, `${ties} vectors with ratio exactly 1`);
}

{
  /*
   * velocityFrom over its whole parameter space. The interesting inputs are the
   * two ends of the ramp and the two beyond them, where the ternary chain
   * clamps — plus NaN, which passes through both false arms and comes out NaN,
   * and which a min/max clamp would have turned into a number.
   */
  const recs = layer("velocity");
  exactBlock("velocityFrom across floorDb x velMin x velDb", recs, (rec) => {
    const opts = new Float64Array(VOICE_KEY.length).fill(NaN);
    opts[2] = rec.params[0];
    opts[7] = rec.params[1];
    opts[8] = rec.params[2];
    const v = initWithOpts(48000, opts);
    return { out64: VEL_DBIN.map((db) => v.velocityFrom(db)) };
  });
  ok("all 27 velocity parameter combinations present", recs.length === 27, `${recs.length} records`);

  let nanOut = 0;
  for (const rec of recs) if (Number.isNaN(rec.out64[VEL_DBIN.length - 1])) nanOut++;
  ok(
    "a NaN dB comes out NaN rather than clamped",
    nanOut === recs.length,
    `${nanOut}/${recs.length} records — hazard 1's ternary chain, not a min/max`,
  );
}

{
  /*
   * Hazard 1 at its real call site.
   *
   * The original framing had a stream NaN reach gainToDb through the envelope
   * followers. It cannot: the detector scrubs non-finite samples to 0 one
   * statement into its sample loop (onset.js, `Number.isFinite(x) ? x : 0`),
   * and Smart Voice reads no raw samples at all — only det.level.env. So the
   * poisoned cases in layer 2 pin the *scrub*, and the Math.max-vs-fmax
   * distinction is pinned here instead, by poking the level env directly.
   *
   * An fmax-based port reports -180 dB for a broken level and a plausible
   * velocity with it, which is a failure that looks like working software.
   */
  const recs = layer("level-db");
  exactBlock("gainToDb over the level env, and the velocity it feeds", recs, (rec) => {
    const opts = new Float64Array(VOICE_KEY.length).fill(NaN);
    opts[2] = rec.params[0];
    const v = initWithOpts(48000, opts);
    const out64 = [];
    for (const env of LEVEL_ENVS) {
      const db = gainToDb(env);
      out64.push(db, v.velocityFrom(db));
    }
    return { out64 };
  });
  ok("all 3 level-db floors present", recs.length === 3, `${recs.length} records`);

  // Both the dB and the velocity it feeds must stay NaN. This is the whole
  // point of the layer. findIndex, not indexOf: indexOf compares with === and
  // so never finds a NaN, which silently made this check vacuous the first
  // time it ran.
  const nanEnv = LEVEL_ENVS.findIndex((x) => Number.isNaN(x));
  let nanPairs = 0;
  for (const rec of recs) {
    if (Number.isNaN(rec.out64[nanEnv * 2]) && Number.isNaN(rec.out64[nanEnv * 2 + 1])) nanPairs++;
  }
  ok(
    "hazard 1: a NaN level env reports NaN dB and NaN velocity, not -180 dB",
    nanEnv >= 0 && nanPairs === recs.length,
    `${nanPairs}/${recs.length} floors propagate — bk_max, not fmax`,
  );

  // And the floor is on the gain side: a zero or negative env pins at exactly
  // -180 dB, which is 20*log10(1e-9) and nothing else.
  let flooredAll = true;
  for (const rec of recs) {
    for (let i = 0; i < LEVEL_ENVS.length; i++) {
      const env = LEVEL_ENVS[i];
      if (!(env <= 0) || !Number.isFinite(env)) continue;
      if (rec.out64[i * 2] !== 20 * Math.log10(1e-9)) flooredAll = false;
    }
  }
  ok("a zero or negative level env floors at exactly -180 dB", flooredAll,
    "the clamp is on the gain, not on the dB");
}

/* =========================================================== layer 2 ==== */

/*
 * The meter array is mostly counters and enum values — those are a hard gate at
 * exact equality. Four of the twelve are floats descended from 20*log10() and a
 * float32 IIR, and those get the band.
 */
const METER_DISCRETE = new Set([0, 1, 2, 5, 8, 9, 10, 11]);

/**
 * Layer 2's comparator: the discrete half of a record is a hard gate at exact
 * equality, the float half is held to TOL.sampleFloat, and bit-identity is
 * counted and printed as a canary rather than required (commit f1da024).
 */
function behavioural(label, recs, mirror, discrete64) {
  let discBad = 0;
  let firstDisc = "";
  let lenBad = 0;
  let worst = 0;
  let offender = "";
  let identical = 0;
  let floatBad = 0;

  for (const rec of recs) {
    const { out64, out32 } = mirror(unpackCase(rec));
    if (rec.out64.length !== out64.length || rec.out32.length !== out32.length) {
      lenBad++;
      if (!firstDisc) {
        firstDisc = `${rec.name}: widths C ${rec.out64.length}/${rec.out32.length} ` +
          `JS ${out64.length}/${out32.length}`;
      }
      continue;
    }
    let bitSame = true;
    for (let i = 0; i < out64.length; i++) {
      const a = rec.out64[i];
      const b = out64[i];
      if (!same(a, b)) bitSame = false;
      if (discrete64(i)) {
        if (!same(a, b)) {
          discBad++;
          if (!firstDisc) firstDisc = `${rec.name} f64[${i}]: C ${a} JS ${b}`;
        }
      } else {
        const err = relErr(a, b);
        if (err > worst) {
          worst = err;
          offender = `${rec.name} f64[${i}] (C ${a} JS ${b})`;
        }
        if (err > TOL.sampleFloat) floatBad++;
      }
    }
    for (let i = 0; i < out32.length; i++) {
      const a = rec.out32[i];
      const b = Math.fround(out32[i]);
      if (!same(a, b)) bitSame = false;
      const err = relErr(a, b);
      if (err > worst) {
        worst = err;
        offender = `${rec.name} f32[${i}] (C ${a} JS ${b})`;
      }
      if (err > TOL.sampleFloat) floatBad++;
    }
    if (bitSame) identical++;
  }

  ok(
    `${label}: every discrete value exact`,
    discBad === 0 && lenBad === 0,
    discBad || lenBad ? `${discBad} value / ${lenBad} width mismatches, first: ${firstDisc}` :
      `${recs.length} records`,
  );
  ok(
    `${label}: floats within float32 tolerance`,
    worst <= TOL.sampleFloat,
    `worst ${worst.toExponential(2)}${offender && worst ? ` at ${offender}` : ""}` +
      (floatBad ? `, ${floatBad} values out of band` : ""),
  );
  console.log(`       canary: ${identical}/${recs.length} records bit-identical to the JS`);
  return identical;
}

console.log("\n== layer 2: behavioural ==");

/*
 * The case roster, as the pass layer saw it. The three case-level layers below
 * each replay the same table independently, so pinning the roster once and
 * comparing the other two against it catches a layer that silently drops or
 * duplicates a case — which would otherwise read as a smaller, still-green
 * battery. Deliberately not a hardcoded count: the table grows as mutation
 * testing finds gaps, and a number here would only ever be stale.
 */
let CASE_ROSTER = null;

{
  /*
   * A whole pass per case: what fired, in which block, at which stage, with
   * which pad and class, plus the final meters and the final pending table.
   */
  const passRecs = layer("pass");

  const runPass = (c) => {
    const v = initCase(c);
    const o64 = new Float64Array(PASS_N64);
    const o32 = new Float32Array(PASS_N32);
    const m = new Float64Array(VOICE_METER_STRIDE);
    let blocks = 0;
    let fires = 0;
    let nonfinite = 0;
    let minCls = 99;
    let maxCls = -99;

    for (let off = 0; off < c.n; off += c.bs) {
      const bn = Math.min(c.bs, c.n - off);
      const got = v.process(c.mono.subarray(off, off + bn), bn);
      for (let k = 0; k < got; k++) {
        if (v.fireClass[k] < minCls) minCls = v.fireClass[k];
        if (v.fireClass[k] > maxCls) maxCls = v.fireClass[k];
        if (!Number.isFinite(v.fireVel[k])) nonfinite++;
        if (!Number.isFinite(v.fireConf[k])) nonfinite++;
        if (fires < PASS_FIRES) {
          o64[PASS_FIRE_BASE + 4 * fires] = blocks;
          o64[PASS_FIRE_BASE + 4 * fires + 1] = v.firePad[k];
          o64[PASS_FIRE_BASE + 4 * fires + 2] = v.fireClass[k];
          o64[PASS_FIRE_BASE + 4 * fires + 3] = v.fireStage[k];
          o32[PASS_FIRE32_BASE + 2 * fires] = v.fireVel[k];
          o32[PASS_FIRE32_BASE + 2 * fires + 1] = v.fireConf[k];
        }
        fires++;
      }
      v.readMeters(m, 0);
      for (let k = 0; k < VOICE_METER_STRIDE; k++) if (!Number.isFinite(m[k])) nonfinite++;
      blocks++;
      maybeToggle(v, c, blocks - 1);
    }

    o64[0] = blocks;
    o64[1] = fires;
    o64[2] = minCls;
    o64[3] = maxCls;
    o64[4] = nonfinite;
    v.readMeters(o64, PASS_METER_BASE);
    snapPend(v, o64, PASS_PEND_BASE, o32, 0);
    o32[PASS_BAND_BASE] = v.lastBand[0];
    o32[PASS_BAND_BASE + 1] = v.lastBand[1];
    o32[PASS_BAND_BASE + 2] = v.lastBand[2];
    return { out64: Array.from(o64), out32: Array.from(o32) };
  };

  behavioural("whole passes", passRecs, runPass, (i) => {
    if (i < PASS_METER_BASE) return true;
    if (i < PASS_PEND_BASE) return METER_DISCRETE.has(i - PASS_METER_BASE);
    return true; // the pending ints and every fire's block / pad / class / stage
  });

  CASE_ROSTER = passRecs.map((r) => r.name.slice(r.name.indexOf(":") + 1));
  const distinct = new Set(CASE_ROSTER);
  ok(
    "every case produced exactly one pass record, under its own name",
    passRecs.length >= 52 && distinct.size === passRecs.length,
    `${passRecs.length} records, ${distinct.size} distinct names`,
  );

  /*
   * Hazard 3, gated without a reference implementation: a fired class outside
   * [0, CLASS_COUNT) means classify() returned -1 on live audio and the
   * unreachability argument in beat-classify.h is wrong. The C's assert() in
   * emit() catches this first in a debug build; this is what catches it under
   * NDEBUG, and on the JS side where there is no assert at all.
   */
  let clsBad = 0;
  let firing = 0;
  let totalFires = 0;
  let nonfiniteCases = 0;
  for (const rec of passRecs) {
    if (rec.out64[1] > 0) {
      firing++;
      totalFires += rec.out64[1];
      if (rec.out64[2] < 0 || rec.out64[3] >= CLASS_COUNT) clsBad++;
    }
    if (rec.out64[4] > 0) nonfiniteCases++;
  }
  ok(
    "hazard 3: every fired class inside [0, CLASS_COUNT)",
    clsBad === 0,
    `${totalFires} fires across ${firing} cases`,
  );
  ok(
    "the battery actually fires on most of its cases",
    firing >= 34,
    `${firing}/${passRecs.length} cases fired at least once`,
  );

  /*
   * The scrub, which is what a poisoned stream actually exercises.
   *
   * A NaN or an infinity in the block is scrubbed to 0 by the detector before
   * any follower sees it, so nothing non-finite can reach Smart Voice at all —
   * every meter, every velocity and every confidence stays finite no matter
   * what is in the audio. Drop the scrub and the followers are poisoned
   * permanently: the detector goes silent and "poison-stream" stops firing.
   *
   * So the gate is two-sided. Nothing non-finite comes out, *and* the poisoned
   * case still fires exactly what its un-poisoned twin fires.
   */
  ok(
    "the scrub holds: no case produces a non-finite meter, velocity or confidence",
    nonfiniteCases === 0,
    `${nonfiniteCases} cases carry a non-finite value — the JS agrees on the count`,
  );
  const byName = new Map(passRecs.map((r) => [r.name, r]));
  const clean = byName.get("pass:poison-clean");
  const dirtied = byName.get("pass:poison-stream");
  ok(
    "a poisoned block leaves the detector still firing, identically to its clean twin",
    clean && dirtied && clean.out64[1] > 0 && clean.out64[1] === dirtied.out64[1],
    clean && dirtied
      ? `clean fired ${clean.out64[1]}, poisoned fired ${dirtied.out64[1]} — the scrub, not luck`
      : "the poison-clean / poison-stream pair is missing",
  );

  /*
   * Hazard 2, made non-vacuous: the two wrap cases seed the counter past
   * INT32_MAX, so at least one pending id must come back negative. Without
   * that the cases are just two more kick patterns.
   */
  let wrapSeen = 0;
  for (const rec of passRecs) {
    if (!rec.name.startsWith("pass:wrap-int32")) continue;
    for (let s = 0; s < PEND_SLOTS; s++) {
      if (rec.out64[PASS_PEND_BASE + 5 * s] < -1) wrapSeen++;
    }
  }
  ok(
    "hazard 2: the wrap cases really do wrap the pending id through zero",
    wrapSeen > 0,
    `${wrapSeen} pending slots holding a wrapped (negative, non-empty) id`,
  );
}

{
  /*
   * The same passes at block resolution. This is the record that pins the two
   * clocks against each other: every stage-1 countdown tick, every stage-2
   * commit and every id retirement carries a block number here.
   */
  const recs = layer("stream");

  const runStream = (c) => {
    const o64 = new Float64Array(STREAM_N64);
    const o32 = new Float32Array(STREAM_N32);
    const v = initCase(c);
    let blocks = 0;

    for (let off = 0; off < c.n && blocks < MAX_BLOCKS; off += c.bs) {
      const bn = Math.min(c.bs, c.n - off);
      const b64 = 1 + blocks * STREAM_B64;
      const b32 = blocks * STREAM_B32;
      const got = v.process(c.mono.subarray(off, off + bn), bn);

      o64[b64] = got;
      v.readMeters(o64, b64 + 1);
      for (let k = 0; k < FIRE_MAX; k++) {
        o64[b64 + 13 + 3 * k] = k < got ? v.firePad[k] : 0;
        o64[b64 + 13 + 3 * k + 1] = k < got ? v.fireClass[k] : 0;
        o64[b64 + 13 + 3 * k + 2] = k < got ? v.fireStage[k] : 0;
        o32[b32 + k] = k < got ? v.fireVel[k] : 0;
        o32[b32 + FIRE_MAX + k] = k < got ? v.fireConf[k] : 0;
      }
      snapPend(v, o64, b64 + 13 + 3 * FIRE_MAX, o32, b32 + 2 * FIRE_MAX);
      blocks++;
      maybeToggle(v, c, blocks - 1);
    }
    o64[0] = blocks;
    return { out64: Array.from(o64), out32: Array.from(o32) };
  };

  behavioural("block-by-block, pending table and all", recs, runStream, (i) => {
    if (i === 0) return true;
    const r = (i - 1) % STREAM_B64;
    if (r === 0) return true; // how many fired this block
    if (r <= VOICE_METER_STRIDE) return METER_DISCRETE.has(r - 1);
    return true; // the fire rows and the whole pending table
  });

  /*
   * And the transitions are there to be pinned: a slot that only ever held -1
   * would make the whole record a row of empties. Count the blocks where some
   * slot's countdown is mid-flight — id set, not yet read.
   */
  let inflight = 0;
  let casesWithFlight = 0;
  for (const rec of recs) {
    let n = 0;
    const blocks = rec.out64[0];
    for (let b = 0; b < blocks; b++) {
      const base = 1 + b * STREAM_B64 + 1 + VOICE_METER_STRIDE + 3 * FIRE_MAX;
      for (let s = 0; s < PEND_SLOTS; s++) {
        if (rec.out64[base + 5 * s] >= 0 && rec.out64[base + 5 * s + 4] === 0) n++;
      }
    }
    inflight += n;
    if (n > 0) casesWithFlight++;
  }
  ok(
    "the stream records catch stage 1 mid-countdown",
    casesWithFlight >= 20,
    `${inflight} mid-flight slot observations across ${casesWithFlight} cases — ` +
      "a port reading the band envelopes one block early diverges here",
  );
  ok(
    "the stream layer replayed the same roster as the pass layer",
    recs.length === CASE_ROSTER.length &&
      recs.every((r, i) => r.name.slice(r.name.indexOf(":") + 1) === CASE_ROSTER[i]),
    `${recs.length} of ${CASE_ROSTER.length} cases, in order`,
  );
}

{
  /*
   * The calibration capture ring: every slot it can still answer for, the
   * staleness boundaries either side of both ends, and the clear — which resets
   * the count and keeps the contents, so every probe must go stale at once
   * while the floats behind them do not move.
   */
  const recs = layer("cap");
  const probeBase = 3 + CAP_SLOTS;

  const runCap = (c) => {
    const o64 = new Float64Array(CAP_N64);
    const o32 = new Float32Array(CAP_N32);
    const v = initCase(c);
    const scratch = new Float32Array(CAP_STRIDE);
    let blocks = 0;

    for (let off = 0; off < c.n; off += c.bs) {
      const bn = Math.min(c.bs, c.n - off);
      v.process(c.mono.subarray(off, off + bn), bn);
      blocks++;
      maybeToggle(v, c, blocks - 1);
    }

    const cc = v.captureCount;
    o64[0] = blocks;
    o64[1] = cc;
    o64[2] = v.captureClass;

    for (let i = 0; i < CAP_SLOTS; i++) {
      scratch.fill(0);
      const got = v.readCapture(cc - CAP_SLOTS + i, scratch) ? 1 : 0;
      o64[3 + i] = got;
      for (let k = 0; k < CAP_STRIDE; k++) o32[i * CAP_STRIDE + k] = got ? scratch[k] : 0;
    }

    const probes = [-1, 0, cc - CAP_SLOTS - 1, cc - CAP_SLOTS, cc - 2, cc - 1, cc, cc + 1];
    const probe32 = CAP_SLOTS * CAP_STRIDE;
    for (let i = 0; i < CAP_PROBES; i++) {
      scratch.fill(0);
      const got = v.readCapture(probes[i], scratch) ? 1 : 0;
      o64[probeBase + 2 * i] = probes[i];
      o64[probeBase + 2 * i + 1] = got;
      for (let k = 0; k < CAP_STRIDE; k++) {
        o32[probe32 + i * CAP_STRIDE + k] = got ? scratch[k] : 0;
      }
    }

    scratch.fill(0);
    v.clearCaptures();
    const got = v.readCapture(cc - 1, scratch) ? 1 : 0;
    o64[probeBase + 2 * CAP_PROBES] = v.captureCount;
    o64[probeBase + 2 * CAP_PROBES + 1] = got;
    o64[probeBase + 2 * CAP_PROBES + 2] = v.captureClass;
    if (cc > 0) {
      const base = ((cc - 1) % CAP_SLOTS) * CAP_STRIDE;
      for (let k = 0; k < CAP_STRIDE; k++) {
        o32[probe32 + CAP_PROBES * CAP_STRIDE + k] = v.captures[base + k];
      }
    }
    return { out64: Array.from(o64), out32: Array.from(o32) };
  };

  // Every f64 in this record is a count, a class or a readable flag.
  behavioural("the capture ring and its staleness boundaries", recs, runCap, () => true);

  let captured = 0;
  let overrun = 0;
  let clearedStale = 0;
  let contentsKept = 0;
  for (const rec of recs) {
    const cc = rec.out64[1];
    if (cc > 0) captured++;
    if (cc > CAP_SLOTS) overrun++;
    if (rec.out64[probeBase + 2 * CAP_PROBES] === 0 &&
      rec.out64[probeBase + 2 * CAP_PROBES + 1] === 0) clearedStale++;
    if (cc > 0) {
      let nonzero = 0;
      const base = CAP_SLOTS * CAP_STRIDE + CAP_PROBES * CAP_STRIDE;
      for (let k = 0; k < CAP_STRIDE; k++) if (rec.out32[base + k] !== 0) nonzero++;
      if (nonzero > 0) contentsKept++;
    }
  }
  ok("some cases actually fill the ring", captured >= 4, `${captured} cases captured at least one hit`);
  ok(
    "at least one case overruns the ring",
    overrun > 0,
    `${overrun} cases captured more than ${CAP_SLOTS} — the wrap and the staleness floor`,
  );
  ok(
    "clearCaptures makes every probe stale at once",
    clearedStale === recs.length,
    `${clearedStale}/${recs.length} cases`,
  );
  ok(
    "and leaves the contents in the array",
    contentsKept === captured,
    `${contentsKept}/${captured} cases still hold their last measurement`,
  );
  ok(
    "the capture layer replayed the same roster as the pass layer",
    recs.length === CASE_ROSTER.length &&
      recs.every((r, i) => r.name.slice(r.name.indexOf(":") + 1) === CASE_ROSTER[i]),
    `${recs.length} of ${CASE_ROSTER.length} cases, in order`,
  );
}

/* =========================================================== layer 3 ==== */

console.log("\n== layer 3: structural ==");

/** snap_voice's 45 scalars, in its order. The count is asserted below. */
const VSTATE_NAMES = [
  "sr", "enabled", "mode", "margin", "velMin", "velDb", "monitor", "floorDb",
  "fireCount", "onsetCount", "drained", "captureClass", "captureCount", "hitCount",
  "lastClass", "lastConf", "lastVel", "lastStage", "lastStrength", "corrections",
  "level", "scratchRatio", "scratchConf",
  "classPad0", "classPad1", "classPad2", "classPad3",
  "det.fastLow", "det.fastMid", "det.fastHigh", "det.level",
  "det.commitCount", "det.count", "det.frames", "det.lastHitFrame", "det.windowLeft",
  "det.pendingFeature", "det.pendingIndex", "det.lagPos",
  "det.accLow", "det.accMid", "det.accHigh", "det.accZc", "det.accFrames", "det.lastSign",
];

/** The scalars that are counters, flags or clamped parameters: exact, no band. */
const VSTATE_EXACT = new Set([
  "sr", "enabled", "mode", "margin", "velMin", "velDb", "monitor", "floorDb",
  "fireCount", "onsetCount", "drained", "captureClass", "captureCount", "hitCount",
  "lastClass", "lastStage", "corrections",
  "classPad0", "classPad1", "classPad2", "classPad3",
  "det.commitCount", "det.count", "det.frames", "det.lastHitFrame", "det.windowLeft",
  "det.pendingFeature", "det.pendingIndex", "det.lagPos", "det.accFrames", "det.lastSign",
]);

const TBL = CLASS_COUNT * FEATURE_COUNT;
const F_CENTROIDS = PEND_FLOATS;
const F_ATTACK = F_CENTROIDS + TBL;
const F_LASTBAND = F_ATTACK + TBL;
const F_BANDSCRATCH = F_LASTBAND + 3;
const F_FEATSCRATCH = F_BANDSCRATCH + FEATURE_COUNT;
const F_CAPTURES = F_FEATSCRATCH + FEATURE_COUNT;

const VI = {};
VSTATE_NAMES.forEach((n, i) => { VI[n] = i; });

/** The JS side of snap_voice. */
function snapVoice(v) {
  const d = new Float64Array(VSTATE_D);
  const f = new Float32Array(VSTATE_F);
  const det = v.det;
  const vals = [
    v.sr, v.enabled ? 1 : 0, v.mode, v.margin, v.velMin, v.velDb, v.monitor ? 1 : 0, v.floorDb,
    v.fireCount, v.onsetCount, v.drained, v.captureClass, v.captureCount, v.hitCount,
    v.lastClass, v.lastConf, v.lastVel, v.lastStage, v.lastStrength, v.corrections,
    v.level, v.scratchRatio, v.scratchConf,
    v.classPad[0], v.classPad[1], v.classPad[2], v.classPad[3],
    det.fastLow.env, det.fastMid.env, det.fastHigh.env, det.level.env,
    det.commitCount, det.count, det.frames, det.lastHitFrame, det.windowLeft,
    det.pendingFeature ? 1 : 0, det.pendingIndex, det.lagPos,
    det.accLow, det.accMid, det.accHigh, det.accZc, det.accFrames, det.lastSign,
  ];
  for (let i = 0; i < vals.length; i++) d[i] = vals[i];
  snapPend(v, d, VSTATE_SCALARS, f, 0);
  f.set(v.centroids, F_CENTROIDS);
  f.set(v.attack, F_ATTACK);
  f.set(v.lastBand, F_LASTBAND);
  f.set(v.bandScratch, F_BANDSCRATCH);
  f.set(v.featScratch, F_FEATSCRATCH);
  f.set(v.captures, F_CAPTURES);
  return { d, f };
}

ok(
  "snap_voice's scalar block is fully named here",
  VSTATE_NAMES.length === VSTATE_SCALARS,
  `${VSTATE_NAMES.length} names for ${VSTATE_SCALARS} slots`,
);

/** Pull snapshot `i` of a three-snapshot record out as plain arrays. */
const snapOf = (rec, i) => ({
  d: rec.out64.slice(i * VSTATE_D, (i + 1) * VSTATE_D),
  f: rec.out32.slice(i * VSTATE_F, (i + 1) * VSTATE_F),
});

/*
 * What each call must clear (post == fresh) and what it must leave alone
 * (post == pre). resetDetector forgets the performance-in-flight; reset also
 * forgets the performance; neither forgets the profile. The five pending-slot
 * fields both calls deliberately leave stale are in KEPT on purpose — that is
 * the thing a tidier-minded port "fixes" and thereby breaks.
 */
const CLEARED_DET = [
  "fireCount", "onsetCount", "drained", "level",
  "det.fastLow", "det.fastMid", "det.fastHigh", "det.level",
  "det.commitCount", "det.count", "det.frames", "det.lastHitFrame", "det.windowLeft",
  "det.pendingFeature", "det.pendingIndex", "det.lagPos",
  "det.accLow", "det.accMid", "det.accHigh", "det.accZc", "det.accFrames", "det.lastSign",
];
const PERF = [
  "captureClass", "captureCount", "hitCount", "lastClass", "lastConf", "lastVel",
  "lastStage", "lastStrength", "corrections",
];
const PROFILE = ["classPad0", "classPad1", "classPad2", "classPad3",
  "sr", "enabled", "mode", "margin", "velMin", "velDb", "monitor", "floorDb"];

/*
 * "Cleared" means back to the field's true default — and for four fields that
 * is *not* the same as back to the comparison instance.
 *
 * init_case pokes the fresh instance exactly as it pokes the dirty one: the
 * hazard-2 cases wind all three onset counters forward, and the capture cases
 * arm a class. So a reset that correctly zeroes onsetCount is compared against
 * a "fresh" snapshot still holding 2147483645, and a reset that correctly
 * returns captureClass to -1 is compared against one holding 0. Both read as
 * failures against `fresh` and as successes against the real default, which is
 * what this table carries. Comparing against the poked instance was the bug;
 * the port was right both times.
 */
const TRUE_DEFAULT = {
  onsetCount: 0,
  drained: 0,
  "det.commitCount": 0,
  captureClass: -1,
};
const POKED_BY_CASE = {
  onsetCount: (c) => c.counterSeed > 0,
  drained: (c) => c.counterSeed > 0,
  "det.commitCount": (c) => c.counterSeed > 0,
  captureClass: (c) => c.captureCls >= 0,
};

for (const full of [false, true]) {
  const recs = layer(full ? "reset" : "reset-det").filter((r) => r.name.startsWith(full ? "reset:" : "reset-det:"));
  const call = full ? "reset()" : "resetDetector()";

  // --- the three snapshots, C against the JS -------------------------------
  let exactBad = 0;
  let firstExact = "";
  let worst = 0;
  let offender = "";
  let identical = 0;
  for (const rec of recs) {
    const c = unpackCase(rec);
    const used = initCase(c);
    let blocks = 0;
    for (let off = 0; off < c.n; off += c.bs) {
      const bn = Math.min(c.bs, c.n - off);
      used.process(c.mono.subarray(off, off + bn), bn);
      blocks++;
      maybeToggle(used, c, blocks - 1);
    }
    const snaps = [snapVoice(used), snapVoice(initCase(c))];
    if (full) used.reset(); else used.resetDetector();
    snaps.push(snapVoice(used));

    let bitSame = true;
    for (let s = 0; s < VSTATE_SNAPS; s++) {
      const got = snaps[s === 1 ? 1 : s === 0 ? 0 : 2];
      for (let i = 0; i < VSTATE_D; i++) {
        const a = rec.out64[s * VSTATE_D + i];
        const b = got.d[i];
        if (!same(a, b)) bitSame = false;
        const name = i < VSTATE_SCALARS ? VSTATE_NAMES[i] : "pend";
        if (i >= VSTATE_SCALARS || VSTATE_EXACT.has(name)) {
          if (!same(a, b)) {
            exactBad++;
            if (!firstExact) firstExact = `${rec.name} snap ${s} ${name}[${i}]: C ${a} JS ${b}`;
          }
        } else {
          const err = relErr(a, b);
          if (err > worst) { worst = err; offender = `${rec.name} snap ${s} ${name}`; }
        }
      }
      for (let i = 0; i < VSTATE_F; i++) {
        const a = rec.out32[s * VSTATE_F + i];
        const b = Math.fround(got.f[i]);
        if (!same(a, b)) bitSame = false;
        const err = relErr(a, b);
        if (err > worst) { worst = err; offender = `${rec.name} snap ${s} f32[${i}]`; }
      }
    }
    if (bitSame) identical++;
  }
  ok(
    `${call}: every counter and flag in all three snapshots exact`,
    exactBad === 0,
    exactBad ? `${exactBad} mismatches, first: ${firstExact}` : `${recs.length} records x 3 snapshots`,
  );
  ok(
    `${call}: the float state in all three snapshots within tolerance`,
    worst <= TOL.sampleFloat,
    `worst ${worst.toExponential(2)}${worst ? ` at ${offender}` : ""}`,
  );
  console.log(`       canary: ${identical}/${recs.length} records bit-identical to the JS`);

  // --- and what the call actually did, on the C's own snapshots -----------
  let clearedBad = 0;
  let firstCleared = "";
  let keptBad = 0;
  let firstKept = "";
  const dirty = new Set();

  const KEPT = [...PROFILE, ...(full ? [] : PERF)];

  for (const rec of recs) {
    const pre = snapOf(rec, 0);
    const fresh = snapOf(rec, 1);
    const post = snapOf(rec, 2);
    const knobs = { counterSeed: rec.params[20], captureCls: rec.params[18] };

    for (const name of [...CLEARED_DET, ...(full ? PERF : [])]) {
      const i = VI[name];
      // The four fields init_case pokes on *both* instances are held to their
      // true default; everything else to the comparison instance. See
      // TRUE_DEFAULT.
      const poked = POKED_BY_CASE[name] && POKED_BY_CASE[name](knobs);
      const want = poked ? TRUE_DEFAULT[name] : fresh.d[i];
      const wantLabel = poked ? `default ${want}` : `fresh ${want}`;
      if (!same(post.d[i], want)) {
        clearedBad++;
        if (!firstCleared) firstCleared = `${rec.name} ${name}: post ${post.d[i]} ${wantLabel}`;
      }
      if (!same(pre.d[i], want)) dirty.add(name);
    }
    for (const name of KEPT) {
      const i = VI[name];
      if (!same(post.d[i], pre.d[i])) {
        keptBad++;
        if (!firstKept) firstKept = `${rec.name} ${name}: post ${post.d[i]} pre ${pre.d[i]}`;
      }
    }

    // The pending table: ids and read flags cleared, the other five left stale.
    for (let s = 0; s < PEND_SLOTS; s++) {
      const id = VSTATE_SCALARS + 5 * s;
      if (post.d[id] !== -1) {
        clearedBad++;
        if (!firstCleared) firstCleared = `${rec.name} pendId[${s}] survived ${call}`;
      }
      if (post.d[id + 4] !== 0) {
        clearedBad++;
        if (!firstCleared) firstCleared = `${rec.name} pendRead[${s}] survived ${call}`;
      }
      for (const off of [1, 2, 3]) { // pendClass, pendFired, pendWait
        if (!same(post.d[id + off], pre.d[id + off])) {
          keptBad++;
          if (!firstKept) firstKept = `${rec.name} pend f64[${5 * s + off}] was cleared by ${call}`;
        }
        if (!same(pre.d[id + off], fresh.d[id + off])) dirty.add("pend-stale");
      }
      if (!same(post.f[s], pre.f[s]) || !same(post.f[PEND_SLOTS + s], pre.f[PEND_SLOTS + s])) {
        keptBad++;
        if (!firstKept) firstKept = `${rec.name} pendVel/pendStrength[${s}] was cleared by ${call}`;
      }
    }

    // The profile and the capture ring survive both calls intact.
    for (let i = F_CENTROIDS; i < F_LASTBAND; i++) {
      if (!same(post.f[i], pre.f[i])) {
        keptBad++;
        if (!firstKept) firstKept = `${rec.name} centroid table f32[${i}] moved`;
      }
    }
    for (let i = F_CAPTURES; i < VSTATE_F; i++) {
      if (!same(post.f[i], pre.f[i])) {
        keptBad++;
        if (!firstKept) firstKept = `${rec.name} capture ring f32[${i}] moved`;
      }
    }
    // lastBand: reset clears it, resetDetector does not.
    for (let i = F_LASTBAND; i < F_LASTBAND + 3; i++) {
      const want = full ? fresh.f[i] : pre.f[i];
      if (!same(post.f[i], want)) {
        if (full) {
          clearedBad++;
          if (!firstCleared) firstCleared = `${rec.name} lastBand[${i - F_LASTBAND}] survived reset()`;
        } else {
          keptBad++;
          if (!firstKept) firstKept = `${rec.name} lastBand[${i - F_LASTBAND}] was cleared by resetDetector()`;
        }
      }
    }
  }

  ok(
    `${call} clears everything it promises`,
    clearedBad === 0,
    clearedBad ? `${clearedBad} fields left dirty, first: ${firstCleared}` :
      `${recs.length} cases, ${CLEARED_DET.length + (full ? PERF.length : 0)} named fields plus the ids`,
  );
  ok(
    `${call} leaves the profile and the deliberately stale fields alone`,
    keptBad === 0,
    keptBad ? `${keptBad} fields wrongly cleared, first: ${firstKept}` :
      `${recs.length} cases — profile, capture ring and five stale pending fields`,
  );
  ok(
    `the ${call} cases are dirty enough for that to mean something`,
    dirty.size >= 12,
    `${dirty.size} of the tracked fields differ from fresh before the call`,
  );
  ok(
    `and the stale pending fields carry real dirt`,
    dirty.has("pend-stale"),
    dirty.has("pend-stale") ? "at least one case leaves a used slot mid-flight" : "no case dirties them",
  );
}

/* ---------------------------------------------- cross-toolchain hard gate */

console.log("\n== cross-toolchain: the ToInt32 setters (hard gate) ==");

if (dumps.haveEmcc && dumps.wasm) {
  /*
   * The four setters coerce with `| 0`, which is ToInt32 — and in C that is a
   * double-to-int conversion whose out-of-range behaviour is undefined.
   * x86-64's cvttsd2si wraps; wasm's trunc_sat saturates to zero. So this is
   * the one part of the battery where native and wasm agreeing is a gate and
   * not a note: a port that reaches for a bare cast passes on one toolchain
   * and silently mangles the other.
   */
  const names = ["centroid", "attack", "class-pad", "capture-class"];
  let n = 0;
  let bad = 0;
  let first = "";
  for (const prefix of names) {
    const a = layer(prefix);
    const b = dumps.wasm.filter((r) => r.name.startsWith(`${prefix}:`) || r.name === prefix);
    if (a.length !== b.length) {
      bad++;
      if (!first) first = `${prefix}: ${a.length} native records vs ${b.length} wasm`;
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      n++;
      let eq = a[i].out64.length === b[i].out64.length && a[i].out32.length === b[i].out32.length;
      for (let j = 0; eq && j < a[i].out64.length; j++) eq = same(a[i].out64[j], b[i].out64[j]);
      for (let j = 0; eq && j < a[i].out32.length; j++) eq = same(a[i].out32[j], b[i].out32[j]);
      if (!eq) {
        bad++;
        if (!first) first = `${a[i].name}: native ${a[i].out64.join(",")} wasm ${b[i].out64.join(",")}`;
      }
    }
  }
  ok(
    `the ToInt32 setters are identical native vs wasm on all ${n} records`,
    bad === 0,
    bad ? `${bad} records differ, first: ${first}` : "bk_to_int32, not a bare cast",
  );
} else {
  ok("wasm toolchain available for the ToInt32 gate", false, "emcc missing — the gate could not run");
}

/* ----------------------------------- cross-toolchain, everything else ---- */

if (dumps.haveEmcc && dumps.wasm) {
  console.log("\n== cross-toolchain: everything else (informational, cannot fail) ==");
  const wasm = dumps.wasm;
  const n = Math.min(native.length, wasm.length);
  let identical = 0;
  let firesAgree = 0;
  let firesTotal = 0;
  let worst = 0;
  let offender = "";
  const drifted = [];

  for (let i = 0; i < n; i++) {
    const a = native[i];
    const b = wasm[i];
    let eq = a.out64.length === b.out64.length && a.out32.length === b.out32.length;
    for (let j = 0; eq && j < a.out64.length; j++) eq = same(a.out64[j], b.out64[j]);
    for (let j = 0; eq && j < a.out32.length; j++) eq = same(a.out32[j], b.out32[j]);
    if (eq) identical++;
    else if (drifted.length < 8) drifted.push(describe(a));

    if (a.name.startsWith("pass:")) {
      firesTotal++;
      let fireSame = a.out64[1] === b.out64[1];
      const count = Math.min(a.out64[1], PASS_FIRES);
      for (let j = 0; fireSame && j < 4 * count; j++) {
        fireSame = a.out64[PASS_FIRE_BASE + j] === b.out64[PASS_FIRE_BASE + j];
      }
      if (fireSame) firesAgree++;
    }

    const m = Math.min(a.out32.length, b.out32.length);
    for (let j = 0; j < m; j++) {
      const d = Math.abs(a.out32[j] - b.out32[j]);
      if (d > worst) { worst = d; offender = `${a.name} f32[${j}]`; }
    }
  }
  console.log(`  ${identical}/${n} records bit-identical across toolchains`);
  console.log(`  ${firesAgree}/${firesTotal} passes agree on every fire's block, pad, class and stage`);
  console.log(`  worst float deviation: ${worst.toExponential(3)}${offender ? ` at ${offender}` : ""}`);
  if (drifted.length) {
    console.log("  first few records that differ at all:");
    for (const d of drifted) console.log(`    ${d}`);
  }
  console.log("  (informational — this section cannot fail the battery)");
}

/* ------------------------------------------------------------------ result */

console.log(`\n${state.checks} checks, ${state.failures} failed — ${state.failures ? "FAIL" : "PASS"}`);
process.exit(state.failures ? 1 : 0);
