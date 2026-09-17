/**
 * Parity oracle for the C port of dsp/core/onset.js (Phase 5, route (c)).
 *
 * The plan's standing decision from commit f1da024 applies here: the desktop
 * build is the product, the web build is a demo, and bit-identity with the
 * JavaScript is a canary rather than a gate from drum-synth onward. But onset
 * is a very different module from drum-synth, and the reason matters for how
 * this battery is built.
 *
 * drum-synth could not agree with V8 in principle: it normalises by a global
 * peak and puts a comparator on Math.sin. onset does neither. Per sample it is
 * add, multiply, divide and compare — nothing transcendental. Every libm call
 * in the module happens once, at construction, computing biquad and envelope
 * coefficients, and those exact computations are already pinned bit-identical
 * by the biquad and utils batteries. So there is no structural reason onset
 * cannot agree exactly with the JS, and this battery is written to find out
 * rather than to assume either way.
 *
 * What it measures, and what it gates on:
 *
 *   LAYER 1 — EXACT, HARD GATE. Defaults, ToInt32 across its whole range
 *   including the wrap into negative numbers, the lag-history sizing, all six
 *   parameter clamps, and the fifteen crossover coefficients. No accumulation
 *   anywhere in it. Any difference at all is a failure.
 *
 *   LAYER 2 — DETECTION, HARD GATE ON THE DISCRETE OUTPUT. How many onsets,
 *   and at which frames. These are integers, and a detector whose hit list
 *   disagrees with the reference is not a detector that drifted — it is one
 *   that found a different performance. Strengths and features are held to a
 *   band instead, because they are float32 reductions of double accumulators.
 *
 *   LAYER 3 — INVARIANTS, ON THE C OUTPUT ALONE. No non-finite number ever
 *   leaves the detector, even when fed NaN and both infinities. Features are
 *   normalised (the three band energies sum to one, or are all zero) and in
 *   range. Hits are strictly ordered and never closer together than the
 *   refractory period. A reset detector reproduces a fresh one exactly. The
 *   commit ring reports staleness at exactly the right five boundaries.
 *
 *   LAYER 4 — NATIVE vs WASM, MEASURED, NEVER GATED. Informational, as in the
 *   drum-synth battery: it is the same C, and what it can catch that the other
 *   layers cannot is a toolchain difference, which is a thing to know about
 *   rather than a reason to fail a build.
 *
 * The stimulus generator below is a mirror of `stim` in parity-onset.c, down
 * to the order in which the LCG advances. It uses only IEEE-754 add, subtract,
 * multiply and divide, which are identically rounded in C and in JS; if it
 * used sin() the stimulus itself would diverge and the measurement would be
 * worthless.
 */

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { buildAndRun, createChecker, describe, fillSignal, maxAbs, TOL } from "./lib/parity-stream.mjs";
import { OnsetDetector, detectOnsets, FEATURE_COUNT } from "../packages/web/public/dsp/core/onset.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

/* Must match parity-onset.c. */
const MAX_HITS = 32;
const MAX_BLOCKS = 96;
const COMMIT_RING = 16;
/* MAX_HITS_PER_BLOCK, and the stream record's per-block layout. */
const BLOCK_HITS = 8;
const STREAM_SLOTS = 4;
const STREAM_FEAT_BASE = COMMIT_RING * 4;
const STIM = { CLICK: 0, KICK: 1, HAT: 2, SNARE: 3, SILENCE: 4, DC: 5, NOISE: 6 };
const PARAM_KEYS = ["sensitivity", "floorDb", "minGapMs", "featureMs", "lowCrossHz", "highCrossHz"];

/** ES ToInt32, which is exactly what `| 0` is. The oracle for bk_onset_to_int32. */
const toInt32 = (x) => x | 0;

/* ------------------------------------------------------------- stimulus */

/**
 * Mirror of stim() in parity-onset.c. Every state advance happens on the same
 * schedule regardless of which waveform is selected — including the LCG steps
 * the click and kick waveforms do not use — because that is what keeps the two
 * generators in step without either holding a copy of the other's output.
 */
function stim(n, sr, kind, hits, gapMs, amp, poison) {
  const dst = new Float64Array(n);
  let stateLcg = 0x2468ace0 >>> 0;
  let prevNoise = 0;

  if (kind === STIM.SILENCE) {
    // silence, then poisoning below: a NaN in silence is a real input
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

/** The case parameters, unpacked from the record exactly as the C packed them. */
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
  };
  c.opts = {};
  for (let i = 0; i < PARAM_KEYS.length; i++) {
    if (Number.isFinite(p[8 + i])) c.opts[PARAM_KEYS[i]] = p[8 + i];
  }
  // The detector's own falsy-sample-rate rule, applied to the stimulus so both
  // languages generate from the rate the detector will actually run at.
  const stimSr = c.sr === 0 ? 48000 : c.sr;
  const sig = stim(c.n, stimSr, c.kind, c.hits, c.gapMs, c.amp, c.poison);
  c.mono = new Float32Array(c.n);
  for (let i = 0; i < c.n; i++) c.mono[i] = sig[i];
  c.bs = c.blockSize <= 0 ? 128 : c.blockSize;
  return c;
}

/* --------------------------------------------------------------- layer 1 */

const dumps = buildAndRun({
  root,
  name: "parity-onset",
  sources: [
    `${root}/packages/native/src/dsp/utils.c`,
    `${root}/packages/native/src/dsp/biquad.c`,
    `${root}/packages/native/src/dsp/onset.c`,
    `${root}/packages/native/tests/parity-onset.c`,
  ],
  include: `${root}/packages/native/include`,
  ok,
  state,
});
const native = dumps.native;

const byName = new Map();
for (const rec of native) {
  if (!byName.has(rec.name)) byName.set(rec.name, []);
  byName.get(rec.name).push(rec);
}
const layer = (prefix) => native.filter((r) => r.name.startsWith(`${prefix}:`) || r.name === prefix);

console.log("\n== layer 1: exact structure (hard gate) ==");

{
  const rec = layer("defaults")[0];
  const { ONSET_DEFAULTS } = await import("../packages/web/public/dsp/core/onset.js");
  const want = PARAM_KEYS.map((k) => ONSET_DEFAULTS[k]);
  let bad = -1;
  for (let i = 0; i < want.length; i++) if (rec.out64[i] !== want[i]) bad = i;
  ok("defaults match ONSET_DEFAULTS exactly", bad < 0, bad < 0 ? `${want.join(", ")}` : `slot ${bad}`);
  ok("FEATURE_COUNT agrees", FEATURE_COUNT === 4, String(FEATURE_COUNT));
}

{
  const recs = layer("to-int32");
  let bad = 0;
  let firstBad = "";
  for (const rec of recs) {
    const want = toInt32(rec.params[0]);
    if (rec.out64[0] !== want) {
      bad++;
      if (!firstBad) firstBad = `${rec.params[0]} -> C ${rec.out64[0]}, JS ${want}`;
    }
  }
  ok(`ToInt32 exact on all ${recs.length} inputs`, bad === 0, bad ? firstBad : "includes the wrap to negative");
  // The wrap is the reason this function exists rather than a cast, so assert
  // that the battery actually reached it instead of trusting the table.
  const negative = recs.filter((r) => r.out64[0] < 0 && r.params[0] > 0);
  ok("the table reaches a positive input that wraps negative", negative.length > 0, `${negative.length} inputs`);
  const overflowed = recs.filter((r) => Number.isFinite(r.params[0]) && Math.abs(r.params[0]) > 2147483647);
  ok("the table reaches inputs beyond int32 range", overflowed.length >= 8, `${overflowed.length} inputs`);

  /*
   * ToInt32 is the one place in this module where the C standard leaves the
   * conversions undefined: a negative or non-finite double reaching
   * `(unsigned int)t` is undefined behaviour, and x86-64 and wasm resolve it
   * differently — cvttsd2si wraps, wasm's trunc_sat saturates to zero. A
   * mutant that drops the wrap therefore leaves native output untouched and
   * only moves wasm, and layer 4 is informational, so nothing would fail.
   * ToInt32 is a spec-exact integer function, so hold the two toolchains to
   * each other here, as a hard gate, and keep the undefined conversions out
   * of reach of the arithmetic.
   */
  if (dumps.haveEmcc && dumps.wasm) {
    const wrecs = dumps.wasm.filter((r) => r.name.startsWith("to-int32:") || r.name === "to-int32");
    let bad = 0;
    let firstCross = "";
    const n = Math.min(recs.length, wrecs.length);
    for (let i = 0; i < n; i++) {
      if (recs[i].out64[0] !== wrecs[i].out64[0]) {
        bad++;
        if (!firstCross) firstCross = `${recs[i].params[0]} -> native ${recs[i].out64[0]}, wasm ${wrecs[i].out64[0]}`;
      }
    }
    ok(
      `ToInt32 identical native vs wasm on all ${n} inputs`,
      bad === 0 && recs.length === wrecs.length && n > 0,
      bad ? `${bad} differ; first ${firstCross}` : `${n} inputs, both toolchains`,
    );
  } else {
    console.log("   (no emcc — the ToInt32 cross-toolchain gate is skipped)");
  }
}

{
  const recs = layer("lag-len");
  let bad = 0;
  let firstBad = "";
  for (const rec of recs) {
    const sr = rec.params[0] || 48000;
    const want = Math.max(1, toInt32(8 * 0.001 * sr));
    if (rec.out64[0] !== want || rec.out64[1] !== 3 * want) {
      bad++;
      if (!firstBad) firstBad = `sr ${rec.params[0]}: C ${rec.out64[0]}, JS ${want}`;
    }
  }
  ok(`lag history sizing exact on all ${recs.length} sample rates`, bad === 0, firstBad);
}

{
  // The claim in onset.c that Math.ceil((ms * 0.001 * sr) | 0) is the ToInt32
  // alone. An argument in a comment, measured here so it cannot be quietly
  // wrong.
  const recs = layer("ceil-noop");
  let bad = 0;
  for (const rec of recs) {
    const sr = rec.params[0];
    const want = [22, 3, 120].map((ms) => Math.ceil(toInt32(ms * 0.001 * sr)));
    for (let i = 0; i < 3; i++) if (rec.out64[i] !== want[i]) bad++;
  }
  ok("dropping the redundant Math.ceil changes nothing", bad === 0, `${recs.length * 3} rate/window pairs`);
}

{
  const recs = layer("clamp");
  let bad = 0;
  let firstBad = "";
  for (const rec of recs) {
    const key = rec.params[0];
    const value = rec.params[1];
    const det = new OnsetDetector(48000);
    // Key -1, 6 and 999 are the unknown keys; the JS is keyed by string, so an
    // index outside the table becomes a name that no branch matches, which is
    // the same early return.
    det.setParam(PARAM_KEYS[key] ?? "__unknown__", value);
    const want = PARAM_KEYS.map((k) => det[k]);
    for (let i = 0; i < want.length; i++) {
      if (rec.out64[i] !== want[i]) {
        bad++;
        if (!firstBad) firstBad = `key ${key} value ${value}: slot ${i} C ${rec.out64[i]} JS ${want[i]}`;
      }
    }
  }
  ok(`parameter clamps exact on all ${recs.length} cases`, bad === 0, firstBad);
}

{
  const recs = layer("filters");
  let worst = 0;
  let offender = "";
  let identical = 0;
  for (const rec of recs) {
    const [sr, low, high] = rec.params;
    const det = new OnsetDetector(sr, { lowCrossHz: low, highCrossHz: high });
    const want = [];
    for (const f of [det.lowFilter, det.midFilter, det.highFilter]) want.push(f.b0, f.b1, f.b2, f.a1, f.a2);
    const d = maxAbs(want, rec.out64);
    if (d.m === 0) identical++;
    if (d.m > worst) {
      worst = d.m;
      offender = `${describe(rec)} coef ${d.at}`;
    }
  }
  ok("crossover coefficients bit-identical to the JS", worst === 0, `${identical}/${recs.length} identical, worst ${worst.toExponential(2)}${offender && worst ? ` (${offender})` : ""}`);
}

{
  // The same crossovers reached by moving the sliders on a running detector
  // rather than by constructing it with them. setParam owns that path, and the
  // guard that stops it refreshing before the filters exist is one edit away
  // from never refreshing at all — which no other record here would notice,
  // because they all construct with the options already in place.
  const recs = layer("filters-late");
  const LATE_SLOTS = 27;
  const byCross = new Map();
  for (const rec of layer("filters")) byCross.set(rec.params.slice(0, 3).join("/"), rec);

  let ctorWorst = 0;
  let ctorOffender = "";
  let jsWorst = 0;
  let jsOffender = "";
  let matched = 0;
  for (const rec of recs) {
    const [sr, low, high, fromLow, fromHigh] = rec.params;
    const ctor = byCross.get([sr, low, high].join("/"));
    for (let v = 0; v < 2; v++) {
      const late = rec.out64.slice(v * LATE_SLOTS, v * LATE_SLOTS + LATE_SLOTS);
      // Against the constructor's own coefficients: same inputs, same code,
      // so anything but bit-identical is a real divergence. No reference
      // implementation needed for this half.
      if (ctor) {
        matched++;
        const d = maxAbs(late.slice(0, 15), ctor.out64.slice(0, 15));
        if (d.m > ctorWorst) {
          ctorWorst = d.m;
          ctorOffender = `${describe(rec)} variant ${v} coef ${d.at}`;
        }
      }
      // And against the JS doing the same thing, cache included.
      const det = v === 0
        ? new OnsetDetector(sr, {})
        : new OnsetDetector(sr, { lowCrossHz: fromLow, highCrossHz: fromHigh });
      det.setParam("lowCrossHz", low);
      det.setParam("highCrossHz", high);
      const want = [];
      const fs = [det.lowFilter, det.midFilter, det.highFilter];
      for (const f of fs) want.push(f.b0, f.b1, f.b2, f.a1, f.a2);
      for (const f of fs) want.push(f.type, f.freq, f.q, f.gainDb);
      const d = maxAbs(want, late);
      if (d.m > jsWorst) {
        jsWorst = d.m;
        jsOffender = `${describe(rec)} variant ${v} slot ${d.at}`;
      }
    }
  }
  ok(
    "a late setParam lands on the constructor's exact coefficients",
    ctorWorst === 0 && matched === recs.length * 2,
    `${matched} comparisons, worst ${ctorWorst.toExponential(2)}${ctorOffender && ctorWorst ? ` (${ctorOffender})` : ""}`
  );
  ok(
    "late-set filters bit-identical to the JS, cache included",
    jsWorst === 0 && recs.length > 0,
    `${recs.length} rates, worst ${jsWorst.toExponential(2)}${jsOffender && jsWorst ? ` (${jsOffender})` : ""}`
  );
}

/* --------------------------------------------------------------- layer 2 */

console.log("\n== layer 2: detection against the JavaScript ==");

const detectRecs = layer("detect");
let countMismatch = 0;
let posMismatch = 0;
let worstStrength = 0;
let worstFeature = 0;
let strengthOffender = "";
let featureOffender = "";
let identicalCases = 0;
const mismatches = [];

for (const rec of detectRecs) {
  const c = unpackCase(rec);
  const ref = detectOnsets(c.mono, c.sr, c.opts, c.blockSize <= 0 ? undefined : c.blockSize);

  const cCount = rec.out64[0];
  if (cCount !== ref.positions.length) {
    countMismatch++;
    if (mismatches.length < 8) mismatches.push(`${rec.name}: C found ${cCount}, JS found ${ref.positions.length}`);
    continue;
  }

  let casePos = true;
  const shown = Math.min(cCount, MAX_HITS);
  for (let i = 0; i < shown; i++) {
    if (rec.out64[1 + i] !== ref.positions[i]) {
      casePos = false;
      if (mismatches.length < 8) {
        mismatches.push(`${rec.name}: hit ${i} at C ${rec.out64[1 + i]}, JS ${ref.positions[i]}`);
      }
      break;
    }
  }
  if (!casePos) {
    posMismatch++;
    continue;
  }

  let caseIdentical = true;
  for (let i = 0; i < shown; i++) {
    const d = Math.abs(rec.out32[i] - ref.strengths[i]);
    if (d !== 0) caseIdentical = false;
    if (d > worstStrength) {
      worstStrength = d;
      strengthOffender = `${rec.name} hit ${i}`;
    }
  }
  // Full width, not just the hits that were found. The C emits all MAX_HITS
  // feature rows and detect() clears the whole block before filling it, so the
  // rows past the hit count are part of the contract: a caller that reads
  // features[i] for an i it did not get a hit for must see zeros, not the
  // previous pass's measurements. Looping to `shown` here left the memset
  // unobserved — every row past the count was emitted and never read.
  for (let i = 0; i < MAX_HITS; i++) {
    const want = ref.features[i] ?? [0, 0, 0, 0];
    for (let k = 0; k < FEATURE_COUNT; k++) {
      // The JS keeps features as doubles in a plain array; the C reads them
      // back out of a Float32Array. Round the reference the same way before
      // comparing, or this measures float32 rounding rather than the port.
      const w = Math.fround(want[k]);
      const d = Math.abs(rec.out32[MAX_HITS + i * FEATURE_COUNT + k] - w);
      if (d !== 0) caseIdentical = false;
      if (d > worstFeature) {
        worstFeature = d;
        featureOffender = `${rec.name} hit ${i} feature ${k}`;
      }
    }
  }
  if (caseIdentical) identicalCases++;
}

ok("every case found the same number of onsets", countMismatch === 0, `${detectRecs.length - countMismatch}/${detectRecs.length} agree`);
ok("every onset landed on the same frame", posMismatch === 0, `${detectRecs.length - posMismatch}/${detectRecs.length} agree`);
ok("strengths within float32 tolerance", worstStrength <= TOL.sampleFloat, `worst ${worstStrength.toExponential(2)}${strengthOffender ? ` (${strengthOffender})` : ""}`);
ok("features within float32 tolerance", worstFeature <= TOL.sampleFloat, `worst ${worstFeature.toExponential(2)}${featureOffender ? ` (${featureOffender})` : ""}`);
console.log(`   ${identicalCases}/${detectRecs.length} detection cases are bit-identical to the JS`);
if (mismatches.length) {
  console.log("   first disagreements:");
  for (const m of mismatches) console.log(`     ${m}`);
}

/*
 * Bit-identity baseline. Unlike the modules before drum-synth this is not the
 * gate the port lives or dies by — the desktop build is the product, and the
 * gates above are the ones that matter. It is pinned anyway because onset has
 * no structural reason to drift, so a drop here means something changed that
 * nobody intended, and that is worth being told about.
 */
const EXPECT_IDENTICAL_DETECT = Number(process.env.BK_ONSET_IDENTICAL ?? detectRecs.length);
ok(
  "detection bit-identity baseline",
  identicalCases >= EXPECT_IDENTICAL_DETECT,
  `${identicalCases}/${detectRecs.length}, baseline ${EXPECT_IDENTICAL_DETECT}`,
);

/*
 * The capacity bound, which the JavaScript does not have.
 *
 * detectOnsets() in JS pushes onto growing arrays; bk_onset_detect() fills a
 * caller's fixed buffer and therefore carries a capacity, a written count and
 * a found count. The C battery runs every case a second time with capacity 4 —
 * well under most cases' hit counts — into sentinel-filled buffers twice as
 * wide as any case needs, and reports what it wrote.
 *
 * Two different kinds of claim are checked here, and they are kept apart on
 * purpose. "The callee stayed inside the buffer I gave it" is not a parity
 * question at all: it is checked on the C's own numbers, and no reference
 * implementation could answer it. "The first four hits, and the found count,
 * are the ones the JS would have produced" is the parity question, and the
 * capped run has to answer it identically to the uncapped one — a bound that
 * bites must lose the overflow and change nothing else.
 */
console.log("\n== layer 2e: the capacity bound the JavaScript does not have ==");

const CAP_TEST = 4;
const CAP_POS_SENTINEL = -987654321;
const CAP_F32_SENTINEL = Math.fround(-8.5e30);

const capRecs = layer("cap");
let capGuardBad = 0;
let capFoundBad = 0;
let capCountBad = 0;
let capValueBad = 0;
let capWorst = 0;
let capBites = 0;
let capDeepest = 0;
const capNotes = [];

for (const rec of capRecs) {
  const c = unpackCase(rec);
  const ref = detectOnsets(c.mono, c.sr, c.opts, c.blockSize <= 0 ? undefined : c.blockSize);
  const found = rec.out64[0];
  const count = rec.out64[1];
  const capacity = rec.out64[2];
  const dirty = rec.out64[3] + rec.out64[4] + rec.out64[5];

  if (capacity !== CAP_TEST) {
    capGuardBad++;
    if (capNotes.length < 8) capNotes.push(`${rec.name}: capacity ${capacity}, expected ${CAP_TEST}`);
    continue;
  }
  if (dirty !== 0) {
    capGuardBad++;
    if (capNotes.length < 8) {
      capNotes.push(
        `${rec.name}: wrote past capacity — ${rec.out64[3]} positions, ${rec.out64[4]} strengths, ${rec.out64[5]} features`,
      );
    }
    continue;
  }

  if (found !== ref.positions.length) {
    capFoundBad++;
    if (capNotes.length < 8) capNotes.push(`${rec.name}: capped run found ${found}, JS found ${ref.positions.length}`);
    continue;
  }
  // The found count and res->count are two stores of the same number, and a
  // caller that trusts the wrong one walks off its own buffer. Only one of
  // them is checked above, so the other is checked here.
  if (count !== ref.positions.length) {
    capCountBad++;
    if (capNotes.length < 8) capNotes.push(`${rec.name}: res->count ${count}, JS found ${ref.positions.length}`);
    continue;
  }

  const pushed = Math.min(found, CAP_TEST);
  let bad = false;
  for (let i = 0; i < CAP_TEST; i++) {
    const wantPos = i < pushed ? ref.positions[i] : CAP_POS_SENTINEL;
    if (rec.out64[6 + i] !== wantPos) {
      bad = true;
      if (capNotes.length < 8) capNotes.push(`${rec.name}: slot ${i} position ${rec.out64[6 + i]}, expected ${wantPos}`);
      break;
    }
    const wantStr = i < pushed ? Math.fround(ref.strengths[i]) : CAP_F32_SENTINEL;
    const ds = Math.abs(rec.out32[i] - wantStr);
    if (ds > capWorst) capWorst = ds;
    // A sentinel slot is an equality claim, not a tolerance one: anything at
    // all landed there is a write that should not have happened.
    if (i >= pushed && rec.out32[i] !== CAP_F32_SENTINEL) {
      bad = true;
      if (capNotes.length < 8) capNotes.push(`${rec.name}: slot ${i} strength written, expected the sentinel`);
      break;
    }
    // Feature rows inside the capacity that no commit reached must hold the
    // zero bk_onset_detect memsets in, which is also what the JS's placeholder
    // row holds — so one expectation covers both.
    const wantFeat = ref.features[i] ?? [0, 0, 0, 0];
    for (let k = 0; k < FEATURE_COUNT; k++) {
      const d = Math.abs(rec.out32[CAP_TEST + i * FEATURE_COUNT + k] - Math.fround(wantFeat[k]));
      if (d > capWorst) capWorst = d;
    }
  }
  if (bad) {
    capValueBad++;
    continue;
  }

  if (found > CAP_TEST) {
    capBites++;
    // How many rows the *uncapped* JS drained real measurements into. Past the
    // capacity that is exactly the pressure the drain's `drained < pushed`
    // guard is holding back, so it is what makes the guard's absence visible.
    const commits = ref.features.filter((row) => row.some((v) => v !== 0)).length;
    if (commits > capDeepest) capDeepest = commits;
  }
}

ok("the capped run stayed inside its buffer", capGuardBad === 0, `${capRecs.length - capGuardBad}/${capRecs.length} cases clean`);
ok("a capped run finds what an uncapped one finds", capFoundBad === 0, `${capRecs.length - capFoundBad}/${capRecs.length} agree`);
ok("res->count carries the found count, not the written one", capCountBad === 0, `${capRecs.length - capCountBad}/${capRecs.length} agree`);
ok(
  "the hits that fit are the JavaScript's, and the rest of the buffer is untouched",
  capValueBad === 0 && capWorst <= TOL.sampleFloat,
  `${capRecs.length - capValueBad}/${capRecs.length} cases, worst ${capWorst.toExponential(2)}`,
);
ok("the bound actually bit on some case", capBites > 0, `${capBites} cases found more hits than the capacity`);
ok(
  "and a capped case had more committed measurements than slots",
  capDeepest > CAP_TEST,
  `deepest ${capDeepest} commits against capacity ${CAP_TEST}`,
);
if (capNotes.length) {
  console.log("   first disagreements:");
  for (const m of capNotes) console.log(`     ${m}`);
}

console.log("\n== layer 2b: the streaming API, block by block ==");

{
  const recs = layer("stream");
  let bad = 0;
  let worstFeat = 0;
  let worstLive = 0;
  let liveOffender = "";
  let nonZeroLiveRows = 0;
  let staleLiveRows = 0;
  const firstBad = [];
  for (const rec of recs) {
    const c = unpackCase(rec);
    const det = new OnsetDetector(c.sr, c.opts);
    const scratch = new Float32Array(FEATURE_COUNT);
    const drainedFeat = new Float32Array(COMMIT_RING * FEATURE_COUNT);
    const liveFeat = new Float32Array(MAX_BLOCKS * BLOCK_HITS * FEATURE_COUNT);
    let blocks = 0;
    let drained = 0;
    const seen = [];
    for (let off = 0; off < c.n && blocks < MAX_BLOCKS; off += c.bs) {
      const bn = Math.min(c.bs, c.n - off);
      const found = det.process(c.mono.subarray(off, off + bn), bn);
      seen.push(found, det.pendingFeature ? 1 : 0, det.commitCount, det.count);
      for (let k = 0; k < BLOCK_HITS * FEATURE_COUNT; k++) {
        liveFeat[blocks * BLOCK_HITS * FEATURE_COUNT + k] = det.features[k];
      }
      blocks++;
      while (drained < COMMIT_RING && det.readCommitted(drained, scratch)) {
        for (let k = 0; k < FEATURE_COUNT; k++) drainedFeat[drained * FEATURE_COUNT + k] = scratch[k];
        drained++;
      }
    }
    if (rec.out64[0] !== blocks) {
      bad++;
      if (firstBad.length < 6) firstBad.push(`${rec.name}: ${rec.out64[0]} blocks vs ${blocks}`);
      continue;
    }
    let caseBad = false;
    for (let i = 0; i < blocks * STREAM_SLOTS; i++) {
      if (rec.out64[1 + i] !== seen[i]) {
        caseBad = true;
        if (firstBad.length < 6) {
          const what = ["count (returned)", "pendingFeature", "commitCount", "count (stored)"][i % STREAM_SLOTS];
          firstBad.push(
            `${rec.name}: block ${Math.floor(i / STREAM_SLOTS)} ${what} C ${rec.out64[1 + i]} JS ${seen[i]}`,
          );
        }
        break;
      }
    }
    if (caseBad) bad++;
    for (let i = 0; i < COMMIT_RING * FEATURE_COUNT; i++) {
      const d = Math.abs(rec.out32[i] - Math.fround(drainedFeat[i]));
      if (d > worstFeat) worstFeat = d;
    }
    // The live, block-local features array, full width, after every block.
    // Both languages leave the rows past `count` holding the previous block's
    // measurements rather than clearing them, so this pins the staleness too.
    for (let b = 0; b < blocks; b++) {
      for (let h = 0; h < BLOCK_HITS; h++) {
        const at = b * BLOCK_HITS * FEATURE_COUNT + h * FEATURE_COUNT;
        let rowNonZero = false;
        for (let k = 0; k < FEATURE_COUNT; k++) {
          const got = rec.out32[STREAM_FEAT_BASE + at + k];
          const want = Math.fround(liveFeat[at + k]);
          if (want !== 0) rowNonZero = true;
          const d = Math.abs(got - want);
          if (d > worstLive) {
            worstLive = d;
            liveOffender = `${rec.name} block ${b} hit ${h} feature ${k}`;
          }
        }
        if (rowNonZero) {
          nonZeroLiveRows++;
          if (h >= seen[b * STREAM_SLOTS]) staleLiveRows++;
        }
      }
    }
  }
  ok("per-block counts, pendingFeature and commitCount all agree", bad === 0, firstBad.length ? firstBad.join("; ") : `${recs.length} cases`);
  ok("drained features within float32 tolerance", worstFeat <= TOL.sampleFloat, `worst ${worstFeat.toExponential(2)}`);
  ok(
    "the live block-local features array agrees, full width",
    worstLive <= TOL.sampleFloat,
    `worst ${worstLive.toExponential(2)}${liveOffender && worstLive ? ` (${liveOffender})` : ""}`,
  );
  // Without these two the check above would pass on an array of zeros, and a
  // live path that never wrote a feature at all would look perfect.
  ok("the live features array was actually populated", nonZeroLiveRows > 0, `${nonZeroLiveRows} non-zero rows`);
  ok("and its stale rows past `count` were reached", staleLiveRows > 0, `${staleLiveRows} rows`);
}

console.log("\n== layer 2c: the commit ring's staleness boundaries ==");

{
  const recs = layer("stale");
  let bad = 0;
  const firstBad = [];
  let probed = 0;
  for (const rec of recs) {
    const c = unpackCase(rec);
    const det = new OnsetDetector(c.sr, c.opts);
    for (let off = 0; off < c.n; off += c.bs) {
      const bn = Math.min(c.bs, c.n - off);
      det.process(c.mono.subarray(off, off + bn), bn);
    }
    const cc = det.commitCount;
    if (rec.out64[0] !== cc) {
      bad++;
      if (firstBad.length < 6) firstBad.push(`${rec.name}: commitCount C ${rec.out64[0]} JS ${cc}`);
      continue;
    }
    const scratch = new Float32Array(FEATURE_COUNT);
    const probes = [-1, 0, cc - COMMIT_RING - 1, cc - COMMIT_RING, cc - 2, cc - 1, cc, cc + 1];
    for (let i = 0; i < probes.length; i++) {
      const got = det.readCommitted(probes[i], scratch) ? 1 : 0;
      probed++;
      if (rec.out64[1 + i] !== got || rec.out64[9 + i] !== probes[i]) {
        bad++;
        if (firstBad.length < 6) {
          firstBad.push(`${rec.name}: probe ${probes[i]} readable C ${rec.out64[1 + i]} JS ${got}`);
        }
        break;
      }
    }
  }
  ok(`readCommitted agrees on all ${probed} boundary probes`, bad === 0, firstBad.join("; "));
  // A battery that never saw the ring overflow would pass this section while
  // proving nothing, so check that at least one case actually overflowed it.
  const overflowed = recs.filter((r) => r.out64[0] > COMMIT_RING);
  ok("at least one case overflowed the commit ring", overflowed.length > 0, `${overflowed.length} cases`);
}

console.log("\n== layer 2d: every field, raw, either side of reset ==");

{
  // The reset checks further down compare reset() by its output: a second pass
  // over the same audio finds the same hits. That is the property that matters,
  // but it is coarse — several of the fields reset() clears cannot swing a
  // threshold eight milliseconds later on these signals, so leaving one behind
  // changes nothing observable and the check stays green while the detector
  // carries a stale number forever. Here the fields themselves are the
  // observable, at three moments: after a whole signal, freshly constructed,
  // and after reset() on the used one.
  //
  // The mutable set below is precisely what reset() is responsible for, either
  // directly or by delegating to a Biquad's or a follower's own reset. Every
  // one of them gets two assertions: fresh == post-reset (reset did its job)
  // and, across the case table, at least one case where pre != fresh (the
  // equality is not vacuous — on silence every field is already zero and a
  // reset() that did nothing would sail through).
  const FILTERS = ["lowFilter", "midFilter", "highFilter"];
  const FOLLOWERS = ["fastLow", "fastMid", "fastHigh", "level"];
  const BIQUAD_FIELDS = ["b0", "b1", "b2", "a1", "a2", "z1", "z2", "type", "freq", "q", "gainDb"];
  const FOLLOWER_FIELDS = ["env", "ca", "cr", "rms"];
  const SCALAR_FIELDS = [
    "lagPos", "accLow", "accMid", "accHigh", "accZc", "accFrames", "lastSign",
    "frames", "lastHitFrame", "windowLeft", "pendingFeature", "pendingIndex",
    "count", "commitCount",
  ];
  const FIELD_NAMES = [];
  for (const f of FILTERS) for (const k of BIQUAD_FIELDS) FIELD_NAMES.push(`${f}.${k}`);
  for (const e of FOLLOWERS) for (const k of FOLLOWER_FIELDS) FIELD_NAMES.push(`${e}.${k}`);
  for (const k of SCALAR_FIELDS) FIELD_NAMES.push(k);

  // What reset() owns. Everything else — coefficients, the idempotence cache,
  // a follower's time constants — survives a reset by design.
  const MUTABLE = new Set([
    ...FILTERS.flatMap((f) => [`${f}.z1`, `${f}.z2`]),
    ...FOLLOWERS.map((e) => `${e}.env`),
    ...SCALAR_FIELDS,
  ]);

  const snapshot = (det) => {
    const fields = [];
    for (const f of FILTERS) for (const k of BIQUAD_FIELDS) fields.push(det[f][k]);
    for (const e of FOLLOWERS) {
      for (const k of FOLLOWER_FIELDS) {
        const v = det[e][k];
        fields.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
      }
    }
    for (const k of SCALAR_FIELDS) {
      const v = det[k];
      fields.push(typeof v === "boolean" ? (v ? 1 : 0) : v);
    }
    const hist = new Float32Array(3 * det.lagLen);
    hist.set(det.histLow, 0);
    hist.set(det.histMid, det.lagLen);
    hist.set(det.histHigh, 2 * det.lagLen);
    return { fields, hist, ring: Float32Array.from(det.commitRing) };
  };

  const STATE_FIELDS = FIELD_NAMES.length;
  const RING_FLOATS = COMMIT_RING * FEATURE_COUNT;
  let widthBad = 0;
  let fieldBad = 0;
  let fieldIdentical = 0;
  let fieldCompared = 0;
  let worstField = 0;
  let fieldOffender = "";
  let worstHist = 0;
  let histOffender = "";
  let worstRing = 0;
  let resetBad = 0;
  let resetCompared = 0;
  let jsResetBad = 0;
  const dirty = new Set();
  let histDirty = 0;
  const firstBad = [];
  const recs = layer("state");

  for (const rec of recs) {
    const c = unpackCase(rec);
    const lag = rec.out64[0];

    const used = new OnsetDetector(c.sr, c.opts);
    for (let off = 0; off < c.n; off += c.bs) {
      const bn = Math.min(c.bs, c.n - off);
      used.process(c.mono.subarray(off, off + bn), bn);
    }
    const pre = snapshot(used);
    const fresh = snapshot(new OnsetDetector(c.sr, c.opts));
    used.reset();
    const post = snapshot(used);

    if (used.lagLen !== lag || pre.hist.length !== 3 * lag) {
      widthBad++;
      if (firstBad.length < 6) firstBad.push(`${rec.name}: lagLen C ${lag} JS ${used.lagLen}`);
      continue;
    }

    const snaps = [pre, fresh, post];
    for (let s = 0; s < snaps.length; s++) {
      for (let k = 0; k < STATE_FIELDS; k++) {
        const cv = rec.out64[1 + s * STATE_FIELDS + k];
        const jv = snaps[s].fields[k];
        fieldCompared++;
        if (cv === jv) fieldIdentical++;
        const scale = Math.max(1, Math.abs(cv), Math.abs(jv));
        const err = Math.abs(cv - jv) / scale;
        if (err > worstField) {
          worstField = err;
          fieldOffender = `${rec.name} snap ${s} ${FIELD_NAMES[k]}: C ${cv} JS ${jv}`;
        }
        if (err > TOL.sampleFloat) fieldBad++;
      }
      for (let j = 0; j < 3 * lag; j++) {
        const err = Math.abs(rec.out32[s * 3 * lag + j] - Math.fround(snaps[s].hist[j]));
        if (err > worstHist) {
          worstHist = err;
          histOffender = `${rec.name} snap ${s} hist ${j}`;
        }
      }
      for (let j = 0; j < RING_FLOATS; j++) {
        const err = Math.abs(rec.out32[3 * 3 * lag + s * RING_FLOATS + j] - Math.fround(snaps[s].ring[j]));
        if (err > worstRing) worstRing = err;
      }
    }

    // fresh == post-reset, on the C's own numbers, for the fields reset owns
    // and for the whole lag history. No reference implementation needed: this
    // is reset()'s contract, not a porting question.
    resetCompared++;
    for (let k = 0; k < STATE_FIELDS; k++) {
      if (!MUTABLE.has(FIELD_NAMES[k])) continue;
      const a = rec.out64[1 + 1 * STATE_FIELDS + k];
      const b = rec.out64[1 + 2 * STATE_FIELDS + k];
      if (a !== b) {
        resetBad++;
        if (firstBad.length < 6) firstBad.push(`${rec.name}: ${FIELD_NAMES[k]} fresh ${a} post-reset ${b}`);
      }
      if (rec.out64[1 + 0 * STATE_FIELDS + k] !== a) dirty.add(FIELD_NAMES[k]);
    }
    for (let j = 0; j < 3 * lag; j++) {
      if (rec.out32[1 * 3 * lag + j] !== rec.out32[2 * 3 * lag + j]) {
        resetBad++;
        if (firstBad.length < 6) firstBad.push(`${rec.name}: hist ${j} survived the reset`);
        break;
      }
      if (rec.out32[j] !== rec.out32[1 * 3 * lag + j]) histDirty++;
    }
    // And the same property in the JS, so a reset() that is wrong in both
    // languages identically is still a failure rather than a match.
    for (let k = 0; k < STATE_FIELDS; k++) {
      if (MUTABLE.has(FIELD_NAMES[k]) && fresh.fields[k] !== post.fields[k]) jsResetBad++;
    }
  }

  ok("the lag history width agrees with the JavaScript", widthBad === 0 && recs.length > 0, firstBad.length ? firstBad[0] : `${recs.length} cases`);
  ok(`all ${fieldCompared} raw fields agree with the JavaScript`, fieldBad === 0, fieldBad ? `${fieldBad} out of tolerance; worst ${worstField.toExponential(2)} (${fieldOffender})` : `worst relative ${worstField.toExponential(2)}, ${fieldIdentical}/${fieldCompared} bit-identical`);
  ok("the lag history agrees with the JavaScript", worstHist <= TOL.sampleFloat, `worst ${worstHist.toExponential(2)}${worstHist ? ` (${histOffender})` : ""}`);
  ok("the commit ring's contents agree with the JavaScript", worstRing <= TOL.sampleFloat, `worst ${worstRing.toExponential(2)}`);
  ok("reset() leaves every field it owns exactly as a fresh detector's", resetBad === 0 && resetCompared > 0, firstBad.length ? firstBad.join("; ") : `${resetCompared} cases`);
  ok("and the JavaScript's reset() does too", jsResetBad === 0, `${jsResetBad} fields differed`);

  // The non-vacuity half: a field that was already at its fresh value before
  // the reset proves nothing about reset() clearing it.
  const clean = [...MUTABLE].filter((f) => !dirty.has(f));
  ok("every field reset() owns was dirty in at least one case", clean.length === 0, clean.length ? `never dirty: ${clean.join(", ")}` : `${dirty.size} fields`);
  ok("and the lag history was dirty too", histDirty > 0, `${histDirty} slots`);
}

/* --------------------------------------------------------------- layer 3 */

console.log("\n== layer 3: invariants, on the C output alone ==");

{
  let nonFinite = 0;
  for (const rec of native) {
    for (const v of rec.out64) if (!Number.isFinite(v)) nonFinite++;
    for (const v of rec.out32) if (!Number.isFinite(v)) nonFinite++;
  }
  ok("no non-finite number anywhere in the dump", nonFinite === 0, `${native.length} records`);
}

{
  // Features: the three band energies are normalised to sum to one, or are all
  // zero when the window caught no energy at all. Both are correct; anything
  // else means the normalisation divided by the wrong total.
  let bad = 0;
  let worstSum = 0;
  let rangeBad = 0;
  for (const rec of detectRecs) {
    const count = Math.min(rec.out64[0], MAX_HITS);
    for (let i = 0; i < count; i++) {
      const base = MAX_HITS + i * FEATURE_COUNT;
      const [lo, mid, hi, zn] = [rec.out32[base], rec.out32[base + 1], rec.out32[base + 2], rec.out32[base + 3]];
      for (const v of [lo, mid, hi, zn]) if (v < 0 || v > 1) rangeBad++;
      const sum = lo + mid + hi;
      if (sum !== 0) {
        const err = Math.abs(sum - 1);
        if (err > worstSum) worstSum = err;
        if (err > 1e-6) bad++;
      }
    }
  }
  ok("band features are normalised or zero", bad === 0, `worst |sum-1| ${worstSum.toExponential(2)}`);
  ok("every feature is in [0, 1]", rangeBad === 0, `${rangeBad} out of range`);
}

{
  let strengthBad = 0;
  let orderBad = 0;
  let gapBad = 0;
  const firstBad = [];
  for (const rec of detectRecs) {
    const c = unpackCase(rec);
    const count = Math.min(rec.out64[0], MAX_HITS);
    const sr = c.sr === 0 ? 48000 : c.sr;
    const minGap = Number.isFinite(c.opts.minGapMs) ? Math.max(5, Math.min(500, c.opts.minGapMs)) : 45;
    const gapFrames = toInt32(minGap * 0.001 * sr);
    for (let i = 0; i < count; i++) {
      const s = rec.out32[i];
      if (!(s >= 0 && s <= 1)) strengthBad++;
      if (i > 0) {
        const prev = rec.out64[i];
        const here = rec.out64[1 + i];
        if (!(here > prev)) {
          orderBad++;
          if (firstBad.length < 6) firstBad.push(`${rec.name}: hit ${i} at ${here} after ${prev}`);
        } else if (here - prev <= gapFrames) {
          gapBad++;
          if (firstBad.length < 6) {
            firstBad.push(`${rec.name}: hits ${i - 1},${i} only ${here - prev} frames apart, gap is ${gapFrames}`);
          }
        }
      }
    }
  }
  ok("every strength is in [0, 1]", strengthBad === 0, `${strengthBad} out of range`);
  ok("hits are strictly ordered", orderBad === 0, firstBad.join("; "));
  ok("no two hits closer than the refractory period", gapBad === 0, firstBad.join("; "));
}

{
  // A detector fed NaN and both infinities must still be a detector
  // afterwards. The failure this guards against is silent by construction: a
  // poisoned envelope follower holds NaN forever, every comparison against it
  // is false, and the detector simply never fires again.
  const poisoned = detectRecs.filter((r) => r.params[7] === 1);
  const clean = new Map(detectRecs.map((r) => [r.name, r]));
  let checked = 0;
  let stillAlive = 0;
  for (const rec of poisoned) {
    checked++;
    const counterpart = clean.get(rec.name.replace("poison-", ""));
    // poison-silence has nothing to detect either way; poison-click does.
    if (rec.params[1] === STIM.CLICK && rec.out64[0] > 0) stillAlive++;
    else if (rec.params[1] === STIM.SILENCE && rec.out64[0] === 0) stillAlive++;
    void counterpart;
  }
  ok("non-finite input does not silence the detector", checked > 0 && stillAlive === checked, `${stillAlive}/${checked} poisoned cases behaved`);
}

{
  // reset() is hand-written field by field in both languages, so a field left
  // out is exactly the kind of mistake nothing else here would catch: the
  // detector keeps working, just with one stale number inside it.
  let bad = 0;
  const firstBad = [];
  let compared = 0;
  for (const rec of layer("reset")) {
    const fresh = byName.get(rec.name.replace("reset:", "detect:"))?.[0];
    if (!fresh) continue;
    compared++;
    if (rec.out64[0] !== fresh.out64[0]) {
      bad++;
      if (firstBad.length < 6) firstBad.push(`${rec.name}: ${rec.out64[0]} hits after reset vs ${fresh.out64[0]} fresh`);
      continue;
    }
    const count = Math.min(rec.out64[0], MAX_HITS);
    for (let i = 0; i < count; i++) {
      if (rec.out64[1 + i] !== fresh.out64[1 + i] || rec.out32[i] !== fresh.out32[i]) {
        bad++;
        if (firstBad.length < 6) firstBad.push(`${rec.name}: hit ${i} differs after reset`);
        break;
      }
    }
  }
  ok("a reset detector reproduces a fresh one exactly", bad === 0 && compared > 0, firstBad.length ? firstBad.join("; ") : `${compared} cases`);
}

{
  // The JS reference has a reset() too, so the post-reset pass is compared
  // across languages as well as against the fresh C pass.
  let bad = 0;
  const firstBad = [];
  for (const rec of layer("reset")) {
    const c = unpackCase(rec);
    const det = new OnsetDetector(c.sr, c.opts);
    let total = 0;
    const pos = [];
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) {
        det.reset();
        total = 0;
        pos.length = 0;
      }
      for (let off = 0; off < c.n; off += c.bs) {
        const bn = Math.min(c.bs, c.n - off);
        const found = det.process(c.mono.subarray(off, off + bn), bn);
        for (let h = 0; h < found; h++) {
          if (total < MAX_HITS) pos.push(det.positions[h]);
          total++;
        }
      }
    }
    if (rec.out64[0] !== total) {
      bad++;
      if (firstBad.length < 6) firstBad.push(`${rec.name}: C ${rec.out64[0]} vs JS ${total}`);
      continue;
    }
    for (let i = 0; i < pos.length; i++) {
      if (rec.out64[1 + i] !== pos[i]) {
        bad++;
        if (firstBad.length < 6) firstBad.push(`${rec.name}: hit ${i} C ${rec.out64[1 + i]} JS ${pos[i]}`);
        break;
      }
    }
  }
  ok("the post-reset pass agrees with the JavaScript", bad === 0, firstBad.join("; "));
}

{
  // Two things the case table has to actually have done, or whole sections
  // above are vacuous.
  const withHits = detectRecs.filter((r) => r.out64[0] > 0);
  ok("most cases detected something", withHits.length >= detectRecs.length - 8, `${withHits.length}/${detectRecs.length} cases found at least one hit`);
  const overflow = detectRecs.find((r) => r.name.endsWith("overflow-hits"));
  ok("the block-overflow case saturated a block", overflow && overflow.out64[0] >= 8, overflow ? `${overflow.out64[0]} hits` : "missing");
  const silence = detectRecs.find((r) => r.name.endsWith(":silence"));
  ok("silence produced no hits", silence && silence.out64[0] === 0, silence ? `${silence.out64[0]} hits` : "missing");
}

/* --------------------------------------------------------------- layer 4 */

if (dumps.haveEmcc && dumps.wasm) {
  console.log("\n== layer 4: native vs wasm (informational, cannot fail) ==");
  const wasm = dumps.wasm;
  const n = Math.min(native.length, wasm.length);
  let identical = 0;
  let discreteAgree = 0;
  let discreteTotal = 0;
  let worst = 0;
  let offender = "";
  const drifted = [];
  for (let i = 0; i < n; i++) {
    const a = native[i];
    const b = wasm[i];
    let same = a.out64.length === b.out64.length && a.out32.length === b.out32.length;
    for (let j = 0; same && j < a.out64.length; j++) same = a.out64[j] === b.out64[j];
    for (let j = 0; same && j < a.out32.length; j++) same = a.out32[j] === b.out32[j];
    if (same) identical++;
    else if (drifted.length < 8) drifted.push(describe(a));

    if (a.name.startsWith("detect:")) {
      discreteTotal++;
      let posSame = a.out64[0] === b.out64[0];
      const count = Math.min(a.out64[0], MAX_HITS);
      for (let j = 0; posSame && j < count; j++) posSame = a.out64[1 + j] === b.out64[1 + j];
      if (posSame) discreteAgree++;
    }
    const m = Math.min(a.out32.length, b.out32.length);
    for (let j = 0; j < m; j++) {
      const d = Math.abs(a.out32[j] - b.out32[j]);
      if (d > worst) {
        worst = d;
        offender = `${a.name} f32[${j}]`;
      }
    }
  }
  console.log(`  ${identical}/${n} records bit-identical across toolchains`);
  console.log(`  ${discreteAgree}/${discreteTotal} detection cases agree on count and every position`);
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
