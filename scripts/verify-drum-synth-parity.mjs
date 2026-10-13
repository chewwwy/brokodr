/**
 * Parity oracle for the C port of dsp/core/drum-synth.js (Phase 5, route (c)).
 *
 * READ THIS FIRST: this file deliberately does NOT do what every other
 * verify-*-parity.mjs in this directory does.
 *
 * Every module before it — utils, biquad, delay-line, fft, chain, drum-voice,
 * drum-rack — is gated on bit-identical agreement with the original
 * JavaScript, with a pinned baseline count asserted through assertIdentity.
 * drum-synth is the first module ported without that gate, and the reason is
 * structural rather than a bug or a shortcut. Two properties of renderDrum
 * make sample-for-sample agreement with V8 unachievable in principle, not
 * merely hard:
 *
 *   1. GLOBAL PEAK NORMALISATION. renderDrum finds the peak of the whole
 *      render and then scales the entire buffer by 0.89/peak. One ULP of
 *      difference landing on whichever sample happens to BE the peak rescales
 *      every other sample in the buffer. The error is not local; it is
 *      multiplied through the output.
 *
 *   2. A COMPARATOR ON A TRANSCENDENTAL. renderHat accumulates
 *      `m += Math.sin(ph[k]) >= 0 ? 1 : -1` over six inharmonic partials. One
 *      ULP either side of a zero crossing flips that term by a full ±1 — an
 *      instantaneous step of roughly 30% — and a 900 ms ride render performs
 *      on the order of 260k comparisons. A crossing landing on a disagreeing
 *      ULP is not a risk, it is a certainty.
 *
 * So this battery is built in four layers, and only the first is a hard gate
 * against the JavaScript:
 *
 *   1. INTEGER STRUCTURE, hard-gated exactly against the JS: the kind table
 *      and its order, all six default param sets, and all sixteen factory
 *      layout entries including pad names and choke groups. No libm is
 *      involved in any of it, so there is nothing to be tolerant about and
 *      nothing here is allowed to differ by anything.
 *   2. AUDIO, held to bands: fourteen features computed by an identical
 *      no-libm ruler on both sides, compared with per-feature tolerances.
 *   3. INVARIANTS, asserted absolutely on the C output alone: no non-finite
 *      sample ever, the fade reaches exact zero, and two renders of identical
 *      input into differently-prefilled buffers agree bit for bit.
 *   4. NATIVE vs WASM, measured and reported but NOT gated — per the
 *      architecture decision in brobeats-plan.md (commit f1da024): the
 *      desktop build is the product, the web build is a demo, and JS parity
 *      is a porting aid and a free canary rather than a ship gate.
 *
 * Layer 1 is what makes layer 2 safe to loosen. Param resolution — defaults,
 * layout entries, override application — is gated to exact equality, and the
 * render cases are then driven from the params the C itself resolved and
 * emitted. A param-resolution bug therefore cannot hide inside an audio
 * tolerance: it has to show up in layer 1 as an exact mismatch.
 *
 * The battery lives in packages/native/tests/parity-drum-synth.c and only
 * there. Read its header too; it explains the case table, the fourteen
 * features, and why nine cases are C-only.
 *
 * THE NINE C-ONLY CASES. drum-synth.js always allocates its scratch at the
 * full Math.ceil(sr * MAX_SECONDS), so the renderers' own
 * `Math.min(out.length, ...)` truncation branch is unreachable from the JS
 * public API. The C port takes a caller-owned buffer and so can reach it.
 * Four trunc-* cases do exactly that. The other four each need a rate the JS
 * cannot survive on top of that: tiny-peak runs at 240 MHz and peak-guarded
 * and peak-normalised at 420 MHz to sit either side of the `peak <= 1e-6`
 * branch — rates at which the JS would try to allocate multi-gigabyte
 * scratch — and hat-phase-underflow runs at 1e51 to underflow render_hat's
 * float32 phase increments to zero and pin the sin comparator on its
 * boundary. kick-wrap-boundary is C-only for a plainer reason: it needs a
 * buffer shorter than four seconds at sr 20 to sit on render_kick's wrap
 * threshold with the signal still unnormalised. All nine are identified
 * structurally, by out_len being below
 * ceil(sr*4), and are held to layer 3 only, each with a dedicated invariant
 * further down. They are not skipped and not excused; there is simply no
 * JS-side result to compare them against.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { buildAndRun, createChecker, describe } from "./lib/parity-stream.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..");
const JS = `${ROOT}/packages/web/public/dsp/core/drum-synth.js`;

/* ------------------------------------------------------------------ tables */

/**
 * The fourteen features, in the order parity-drum-synth.c's measure() writes
 * them. Mirrored by hand because the C is the only source of truth for the
 * order and there is nothing to import.
 */
const F = {
  FRAMES: 0,
  FADE: 1,
  PEAK: 2,
  RMS: 3,
  T90: 4,
  HF: 5,
  ZC: 6,
  MEAN: 7,
  CLIPS: 8,
  NONFINITE: 9,
  LAST: 10,
  REPEAT: 11,
  FINGERPRINT: 12,
  FIRST: 13,
};
const N_FEATURES = 14;

/**
 * The C param-id enum (BK_DS_*) in order, mapped to the JS key each one
 * names. drum-synth's params never travel the realtime command ring — it is
 * a control-path/kit-build module — so there is no generated param-keys.h
 * entry for any of these and this table is the whole correspondence.
 */
const PARAM_KEYS = [
  "tune", // BK_DS_TUNE
  "drop", // BK_DS_DROP
  "pitchDecay", // BK_DS_PITCH_DECAY
  "decay", // BK_DS_DECAY
  "drive", // BK_DS_DRIVE
  "click", // BK_DS_CLICK
  "level", // BK_DS_LEVEL
  "body", // BK_DS_BODY
  "noiseDecay", // BK_DS_NOISE_DECAY
  "tone", // BK_DS_TONE
  "snap", // BK_DS_SNAP
  "resonance", // BK_DS_RESONANCE
  "spread", // BK_DS_SPREAD
];

/**
 * Per-feature tolerances for layer 2. Chosen from the observed native-vs-JS
 * spread with headroom, not guessed: see the writeup in brobeats-plan.md for
 * the measured worst case behind each number.
 *
 * `rel` is relative to the JS value's magnitude, `abs` is an absolute floor
 * so a feature that is legitimately near zero is not held to a relative
 * tolerance it can never meet. A feature passes if it is inside EITHER.
 *
 * FRAMES, FADE, NONFINITE and CLIPS are integers with no libm in their
 * derivation and are held to exact equality — except CLIPS, which counts
 * samples above 1.0 and therefore sits on a comparator that the peak
 * normalisation can push a sample across. It gets a small absolute slack.
 */
const BANDS = {
  // Integers with no libm anywhere in their derivation.
  [F.FRAMES]: { exact: true },
  [F.FADE]: { exact: true },
  [F.NONFINITE]: { exact: true },
  // The fade multiplies the final sample by exactly 0 on both sides, so this
  // is exact too — and the observed spread was indeed exactly 0.
  [F.LAST]: { exact: true },

  // Amplitude features. These are float32 values or simple reductions over
  // them, so the smallest difference either side can legitimately express is
  // one float32 ULP: 2^-23 ~ 1.2e-7 relative. The relative bands sit just
  // above that, which is the tightest they can be without being a bit-
  // identity gate in disguise. Measured spread on all three: exactly 0.
  [F.PEAK]: { rel: 2e-7, abs: 1e-12 },
  [F.RMS]: { rel: 2e-7, abs: 1e-12 },
  [F.FIRST]: { rel: 2e-7, abs: 1e-12 },
  [F.HF]: { rel: 2e-7, abs: 1e-12 },

  // The DC mean is the most ULP-sensitive feature in the set, and the only
  // one that moved at all: every kind renders essentially DC-free, so mean
  // lands around 1e-7 or below and a single-ULP change to one sample deep in
  // the fade tail is a large RELATIVE change to it. Worst observed was
  // 5.25e-21 absolute / 4.60e-14 relative (rim-tone-one). The bands below
  // leave ~6 and ~8 orders of headroom respectively.
  [F.MEAN]: { rel: 1e-6, abs: 1e-15 },

  // Two features that sit on a comparator, where the quantum of legitimate
  // disagreement is a whole unit rather than an ULP. ZC counts sign changes
  // and CLIPS counts samples above 1.0; a sample sitting a ULP either side of
  // either threshold moves the count by one. Two units of slack, which is
  // nothing against the hundreds-to-thousands these features report.
  // Measured spread on both: exactly 0.
  [F.ZC]: { rel: 0, abs: 2 },
  [F.CLIPS]: { rel: 0, abs: 2 },

  // T90 is quantised to 1/frames, so its tolerance is set per case as two
  // frames' worth rather than as a constant. See the dynamic band below.
  [F.T90]: { rel: 0, abs: 0, framesRel: 2 },

  // REPEAT is an invariant (layer 3), not a JS comparison: the JS cannot be
  // asked to render into a pre-filled buffer at all.
  // FINGERPRINT is byte identity, which layer 2 explicitly does not claim.
};

const FEATURE_NAMES = Object.fromEntries(Object.entries(F).map(([k, v]) => [v, k.toLowerCase()]));

/* --------------------------------------------------------------- the ruler */

/**
 * An exact mirror of measure() in parity-drum-synth.c.
 *
 * The only floating-point functions used on either side are fabs/Math.abs and
 * sqrt/Math.sqrt, both of which IEEE-754 requires to be correctly rounded.
 * That is the whole point: the ruler is reproducible bit for bit in both
 * languages, so any difference this reports is a difference in the AUDIO and
 * never a difference in the measurement. Do not "simplify" any expression
 * here — reassociating a sum would silently turn the ruler into a second
 * source of divergence.
 *
 * `b` may be null on the JS side, where there is no second prefilled render;
 * the repeat feature is then left at 0 and simply not compared.
 */
function measure(a, b, frames, fade) {
  const f = new Float64Array(N_FEATURES);
  let energy = 0;
  let diffEnergy = 0;
  let sum = 0;
  let peak = 0;
  let repeat = 0;
  let cum = 0;
  let zc = 0;
  let clips = 0;
  let nonfinite = 0;
  let t90 = 0;

  for (let i = 0; i < frames; i++) {
    const x = a[i];
    const d = x - (i ? a[i - 1] : 0);
    const r = b ? Math.abs(x - b[i]) : 0;
    const ax = Math.abs(x);
    if (!(x <= 1e300 && x >= -1e300)) nonfinite += 1;
    if (ax > peak) peak = ax;
    if (ax > 1.0) clips += 1;
    if (r > repeat) repeat = r;
    energy += x * x;
    diffEnergy += d * d;
    sum += x;
    if (i && a[i] >= 0 !== a[i - 1] >= 0) zc += 1;
  }
  for (let i = 0; i < frames && energy > 0; i++) {
    const x = a[i];
    cum += x * x;
    if (cum >= energy * 0.9) {
      t90 = (i + 1) / frames;
      break;
    }
  }

  f[F.FRAMES] = frames;
  f[F.FADE] = fade;
  f[F.PEAK] = peak;
  f[F.RMS] = frames ? Math.sqrt(energy / frames) : 0;
  f[F.T90] = t90;
  f[F.HF] = energy > 0 ? diffEnergy / energy : 0;
  f[F.ZC] = zc;
  f[F.MEAN] = frames ? sum / frames : 0;
  f[F.CLIPS] = clips;
  f[F.NONFINITE] = nonfinite;
  f[F.LAST] = frames ? a[frames - 1] : 0;
  f[F.REPEAT] = repeat;
  f[F.FINGERPRINT] = 0; // byte identity is not a layer-2 claim
  f[F.FIRST] = frames ? a[0] : 0;
  return f;
}

/* ------------------------------------------------------------------- setup */

const { state, ok } = createChecker();

if (!existsSync(JS)) {
  console.log(`FAIL: cannot find the JS original at ${JS}`);
  process.exit(1);
}
const js = await import(pathToFileURL(JS).href);
const { DRUM_KINDS, DRUM_SYNTH_DEFAULTS, DEFAULT_KIT_LAYOUT, renderDrum } = js;

console.log("Bro.Kodr — drum-synth.js -> C parity battery");
console.log("NOTE: audio is held to behavioural bands, not bit-identity. See this file's header.\n");

const { native, wasm, haveEmcc } = buildAndRun({
  root: ROOT,
  name: "parity-drum-synth",
  sources: [
    `${ROOT}/packages/native/src/dsp/drum-synth.c`,
    `${ROOT}/packages/native/src/dsp/utils.c`,
    `${ROOT}/packages/native/tests/parity-drum-synth.c`,
  ],
  include: `${ROOT}/packages/native/include`,
  ok,
  state,
});

const byName = new Map(native.map((r) => [r.name, r]));

/* ============================== layer 1: integer structure, hard-gated === */

console.log("\n== layer 1: the kind table (exact) ==");
{
  const rec = byName.get("kinds");
  if (!rec) {
    ok("kinds record present", false);
  } else {
    const p = Array.from(rec.params);
    let i = 0;
    const count = p[i++];
    ok("kind count", count === DRUM_KINDS.length, `${count} vs ${DRUM_KINDS.length}`);
    const names = [];
    for (let k = 0; k < count; k++) {
      const len = p[i++];
      let s = "";
      for (let j = 0; j < len; j++) s += String.fromCharCode(p[i++]);
      names.push(s);
    }
    ok(
      "kind names and their order",
      names.length === DRUM_KINDS.length && names.every((n, k) => n === DRUM_KINDS[k]),
      `[${names.join(",")}] vs [${DRUM_KINDS.join(",")}]`,
    );
  }
}

console.log("\n== layer 1: default params, all six kinds (exact) ==");
for (let k = 0; k < DRUM_KINDS.length; k++) {
  const kind = DRUM_KINDS[k];
  const rec = byName.get(`defaults-${kind}`);
  if (!rec) {
    ok(`defaults-${kind} record present`, false);
    continue;
  }
  const flat = Array.from(rec.params);
  const want = DRUM_SYNTH_DEFAULTS[kind];
  // Every one of the thirteen is checked, not just the ones this kind owns:
  // a field the kind does not own must read as exactly 0 on both sides, which
  // is the convention drum-synth.h states and this is where it is enforced.
  for (let j = 0; j < PARAM_KEYS.length; j++) {
    const key = PARAM_KEYS[j];
    const expected = Object.prototype.hasOwnProperty.call(want, key) ? want[key] : 0;
    ok(`defaults-${kind}.${key}`, flat[j] === expected, `${flat[j]} vs ${expected}`);
  }
  // And the converse: the JS must not own a key the C has no slot for.
  const unknown = Object.keys(want).filter((key) => !PARAM_KEYS.includes(key));
  ok(`defaults-${kind} has no key the C cannot carry`, unknown.length === 0, unknown.join(",") || "none");
}

console.log("\n== layer 1: the factory 16-pad layout (exact) ==");
ok("layout length", DEFAULT_KIT_LAYOUT.length === 16, `${DEFAULT_KIT_LAYOUT.length}`);
for (let i = 0; i < 16; i++) {
  const rec = byName.get(`layout-${String(i).padStart(2, "0")}`);
  const want = DEFAULT_KIT_LAYOUT[i];
  if (!rec || !want) {
    ok(`layout-${i} record present`, false);
    continue;
  }
  const p = Array.from(rec.params);
  let n = 0;
  const pad = p[n++];
  const kind = p[n++];
  const choke = p[n++];
  const nOver = p[n++];
  const overrides = {};
  for (let j = 0; j < nOver; j++) {
    const key = p[n++];
    overrides[PARAM_KEYS[key]] = p[n++];
  }
  const nameLen = p[n++];
  let name = "";
  for (let j = 0; j < nameLen; j++) name += String.fromCharCode(p[n++]);

  ok(`layout-${i}.pad`, pad === want.pad, `${pad} vs ${want.pad}`);
  ok(`layout-${i}.kind`, DRUM_KINDS[kind] === want.kind, `${DRUM_KINDS[kind]} vs ${want.kind}`);
  // The JS writes no `choke` key at all on a pad that has none; the C carries
  // 0 for that. Treat absent and 0 as the same thing, in one place, here.
  const wantChoke = want.choke === undefined ? 0 : want.choke;
  ok(`layout-${i}.choke`, choke === wantChoke, `${choke} vs ${wantChoke}`);
  ok(`layout-${i}.name`, name === want.name, `"${name}" vs "${want.name}"`);

  const wantOver = want.params || {};
  const wantKeys = Object.keys(wantOver).sort();
  const gotKeys = Object.keys(overrides).sort();
  ok(
    `layout-${i} override keys`,
    wantKeys.length === gotKeys.length && wantKeys.every((key, j) => key === gotKeys[j]),
    `[${gotKeys.join(",")}] vs [${wantKeys.join(",")}]`,
  );
  for (const key of wantKeys) {
    ok(`layout-${i}.${key}`, overrides[key] === wantOver[key], `${overrides[key]} vs ${wantOver[key]}`);
  }
}

/* ---------------------------------------------------------------------------
 * layer 1: bk_drum_layout_resolve, against an oracle it cannot influence.
 *
 * The section above checks what the static layout table CONTAINS. This one
 * checks what the function that reads it PRODUCES, which is a different claim
 * and was previously made nowhere in the battery.
 *
 * It has to be a separate section because layer 2 structurally cannot make it:
 * jsParamsFor builds the JS reference params out of the vector the C resolved,
 * so a broken resolve feeds the C render and the JS reference the same wrong
 * numbers, they agree sample for sample, and the comparison passes. Mutation
 * testing confirmed it — dropping the first override, and replacing the
 * defaults call with a memset, both escaped the entire battery.
 *
 * So the expected vector here is recomputed from the JS side alone: the kind's
 * own defaults, the layout entry's overrides on top, and exactly 0 for every
 * key the kind does not own.
 * ------------------------------------------------------------------------- */

console.log("\n== layer 1: bk_drum_layout_resolve (exact, independent oracle) ==");
for (let i = 0; i < 16; i++) {
  const rec = byName.get(`resolve-${String(i).padStart(2, "0")}`);
  const want = DEFAULT_KIT_LAYOUT[i];
  if (!rec || !want) {
    ok(`resolve-${i} record present`, false);
    continue;
  }
  const p = Array.from(rec.params);
  const gotKind = p[0];
  const flat = p.slice(1);

  ok(`resolve-${i} returns the pad's kind`, DRUM_KINDS[gotKind] === want.kind, `${DRUM_KINDS[gotKind]} vs ${want.kind}`);

  const owned = DRUM_SYNTH_DEFAULTS[want.kind] || {};
  const over = want.params || {};
  for (let j = 0; j < PARAM_KEYS.length; j++) {
    const key = PARAM_KEYS[j];
    // Override wins over the default; a key this kind does not own is 0.
    const expected = Object.prototype.hasOwnProperty.call(over, key)
      ? over[key]
      : Object.prototype.hasOwnProperty.call(owned, key)
        ? owned[key]
        : 0;
    ok(`resolve-${i}.${key}`, flat[j] === expected, `${flat[j]} vs ${expected}`);
  }
}

/* ========================= layers 2 and 3: the render cases ============== */

/**
 * Rebuild the JS params object for a render record from the params the C
 * resolved and emitted. Only the keys this kind actually owns are passed, so
 * the object handed to renderDrum is shaped exactly like one the app would
 * build — a kind never sees a sibling kind's key.
 */
function jsParamsFor(kindName, flat) {
  const owned = DRUM_SYNTH_DEFAULTS[kindName];
  const out = {};
  for (let j = 0; j < PARAM_KEYS.length; j++) {
    const key = PARAM_KEYS[j];
    if (Object.prototype.hasOwnProperty.call(owned, key)) out[key] = flat[j];
  }
  return out;
}

const renderRecs = native.filter((r) => r.out64.length === N_FEATURES);
console.log(`\n== layers 2 and 3: ${renderRecs.length} render cases ==`);

// Worst observed deviation per feature, for the writeup and for choosing the
// bands. Reported whether or not anything failed.
const worst = {};
for (const k of Object.keys(BANDS)) worst[k] = { d: 0, rel: 0, case: "" };
let jsCompared = 0;
let cOnly = 0;
let bandFailures = 0;

for (const rec of renderRecs) {
  const [kindIdx, sr, outLen] = rec.params;
  const flat = Array.from(rec.params).slice(4);
  const cf = rec.out64;
  const label = rec.name;

  /* ---- layer 3: invariants, on the C output alone, unconditionally ---- */

  ok(`${label}: no non-finite sample`, cf[F.NONFINITE] === 0, `${cf[F.NONFINITE]}`);
  // A -1 here is the producer's poison value for two identical calls
  // disagreeing on frame count, so this one assertion catches both that and a
  // genuinely non-deterministic render.
  ok(
    `${label}: deterministic across two prefills`,
    cf[F.REPEAT] === 0,
    cf[F.REPEAT] === -1 ? "frame counts disagreed between identical calls" : `${cf[F.REPEAT]}`,
  );
  // With more than one frame and a fade longer than one frame, the last
  // sample is multiplied by exactly 0 and must be exactly 0.
  if (cf[F.FRAMES] > 1 && cf[F.FADE] > 1) {
    ok(`${label}: fade reaches exact zero`, cf[F.LAST] === 0, `${cf[F.LAST]}`);
  }
  // READ THIS BEFORE TRUSTING THE FADE FEATURE. F.FADE is not an observation
  // of bk_drum_render. The renderer does not report its fade length, so the
  // producer recomputes it from the same formula in parity-drum-synth.c, and
  // that line is part of the harness rather than part of the port — mutating
  // the C's fade arithmetic cannot move it. Comparing it to the formula below
  // therefore checks that the producer's mirror and this consumer's mirror
  // still agree with each other, which is worth having (they are what layer
  // 2's ruler uses to interpret the tail) but is NOT coverage of the
  // implementation. The implementation's own fade is caught by the audio it
  // produces: layer 2's bands on every JS-compared case, and the exact
  // single-frame claim below for the clamp, which only truncated C-only cases
  // can reach.
  ok(
    `${label}: fade length agrees between producer and consumer`,
    cf[F.FADE] === Math.min(Math.round(sr * 0.002), cf[F.FRAMES]),
    `${cf[F.FADE]} vs ${Math.min(Math.round(sr * 0.002), cf[F.FRAMES])} (sr ${sr}, frames ${cf[F.FRAMES]})`,
  );
  // The fade clamp, observed rather than recomputed. With exactly one frame
  // and a rate whose 2 ms rounds to at least one sample, the clamp pins the
  // fade at one, and the loop's first and only step multiplies that single
  // sample by 0/1 — exactly zero, whatever the kind rendered and whatever the
  // normalisation did. That makes the whole render exactly zero, and it is
  // the one statement about the clamp that needs no knowledge of the raw
  // sample. A clamp that yields frames - 1 instead leaves the sample at its
  // full normalised level (0.89 of full scale, measured), so this is what
  // stands between the port and an off-by-one there: the JS side never
  // reaches the clamp, since every kind's duration formula has an additive
  // floor of at least 10 ms against the fade's 2 ms, so only a buffer short
  // enough to truncate the render gets there, and those cases have no JS
  // counterpart at all.
  if (cf[F.FRAMES] === 1 && Math.round(sr * 0.002) >= 1) {
    ok(
      `${label}: a one-frame render is faded to exactly zero`,
      cf[F.PEAK] === 0 && cf[F.FIRST] === 0 && cf[F.LAST] === 0,
      `peak ${cf[F.PEAK]}, first ${cf[F.FIRST]}, last ${cf[F.LAST]}`,
    );
  }

  /* ---- layer 2: bands against the JS, where a JS result exists ---- */

  const capacity = Math.ceil(sr * 4);
  const isCOnly = outLen < capacity;
  if (isCOnly) {
    cOnly++;
    continue;
  }

  const kindName = kindIdx >= 0 && kindIdx < DRUM_KINDS.length ? DRUM_KINDS[kindIdx] : "__unknown__";
  if (kindName === "__unknown__") {
    // renderDrum returns null for a kind it does not know; the C reports that
    // as zero frames. This is an exact claim, not a band.
    const got = renderDrum(kindName, sr, {});
    ok(`${label}: unknown kind renders nothing`, got === null && cf[F.FRAMES] === 0, `js=${got}, c frames=${cf[F.FRAMES]}`);
    jsCompared++;
    continue;
  }

  const p = jsParamsFor(kindName, flat);
  const got = renderDrum(kindName, sr, p);
  if (!got) {
    ok(`${label}: JS produced a render`, false, "renderDrum returned null");
    continue;
  }
  const jsFade = Math.min(Math.round(sr * 0.002), got.frames);
  const jf = measure(got.data, null, got.frames, jsFade);
  jsCompared++;

  for (const key of Object.keys(BANDS)) {
    const idx = Number(key);
    const band = BANDS[idx];
    const a = cf[idx];
    const e = jf[idx];
    const d = Math.abs(a - e);
    const rel = Math.abs(e) > 0 ? d / Math.abs(e) : d > 0 ? Infinity : 0;
    if (d > worst[key].d) worst[key] = { d, rel, case: label };

    let pass;
    let how;
    if (band.exact) {
      pass = a === e;
      how = `${a} vs ${e}`;
    } else {
      // A feature quantised to the frame grid gets its slack in frames, so a
      // long render is not held to a tolerance a short one sets.
      const abs = band.framesRel ? band.framesRel / Math.max(cf[F.FRAMES], 1) : (band.abs ?? 0);
      pass = d <= abs || rel <= (band.rel ?? 0);
      how = `|${a.toPrecision(8)} - ${e.toPrecision(8)}| = ${d.toExponential(2)} (rel ${rel.toExponential(2)}, allow abs ${abs.toExponential(2)})`;
    }
    if (!pass) bandFailures++;
    // One line per failing feature only; 78 cases x 12 features of passing
    // output would bury everything else.
    if (!pass) ok(`${label}: ${FEATURE_NAMES[idx]}`, false, how);
    else state.checks++;
  }
}

console.log(`  ${jsCompared} cases compared against the JS, ${cOnly} C-only (layer 3 alone)`);
console.log(`  ${bandFailures} feature band failures`);
console.log("\n  worst observed native-vs-JS deviation per feature:");
for (const key of Object.keys(BANDS)) {
  const w = worst[key];
  const band = BANDS[Number(key)];
  const limit = band.exact
    ? "exact"
    : band.framesRel
      ? `${band.framesRel} frames, rel ${band.rel ?? 0}`
      : `abs ${band.abs ?? 0}, rel ${band.rel ?? 0}`;
  console.log(
    `    ${FEATURE_NAMES[Number(key)].padEnd(10)} ${w.d.toExponential(3)} (rel ${w.rel.toExponential(3)})` +
      `  worst: ${w.case || "-"}   [band: ${limit}]`,
  );
}

/* ------------- the normalisation branch, on the C output alone ----------- */

/**
 * `g = (peak > 1e-6 ? 0.89 / peak : 1.0) * dbToGain(level)` has two arms, and
 * which one ran is legible from the rendered peak alone: normalising pins it
 * at the working level, guarding leaves it wherever the raw render put it.
 * The two cases below sit either side of the threshold at one rate, so this
 * reads them as order-of-magnitude assertions rather than as ULP comparisons —
 * nothing here is sensitive to libm, and neither case needs a JS counterpart,
 * which matters because both are C-only by buffer length.
 */
console.log("\n== normalisation branch (C output alone, both arms) ==");
for (const [name, arm, why] of [
  ["peak-guarded", "guarded", "a raw peak under 1e-6 is left unnormalised"],
  ["peak-normalised", "normalised", "a raw peak over 1e-6 is scaled to the working level"],
  ["tiny-peak", "normalised", "a raw peak of ~1.05e-6 clears the threshold"],
]) {
  const rec = byName.get(name);
  if (!rec) {
    ok(`${name}: ${arm}`, false, "the record is missing");
    continue;
  }
  const peak = rec.out64[F.PEAK];
  // The guarded arm's output cannot exceed its raw peak, which is under the
  // threshold; the normalised arm's is 0.89 before the level trim and the
  // fade, and 0.1 is far below anything either can cut it to here.
  const held = arm === "guarded" ? peak > 0 && peak <= 1e-6 : peak >= 0.1;
  ok(`${name}: ${arm} — ${why}`, held, `peak ${peak.toExponential(4)}`);
}

/* ---------------- the hat comparator, on the C output alone -------------- */

/**
 * render_hat mixes six square partials as `m += (sin(ph[k]) >= 0) ? 1 : -1`,
 * and that comparator's boundary is normally unreachable: ph[k] would have to
 * land exactly on a zero of sin, which no ordinary rate and tune in this
 * table arranges, so `>= 0` and `> 0` are indistinguishable everywhere else.
 *
 * hat-phase-underflow reaches it deliberately. Its rate is large enough that
 * all six phase increments round to exactly +0.0 in float32, so ph[] is
 * parked on +0.0 for the entire render and sin(+0.0) = +0.0 is compared at
 * every sample of every partial. `>= 0` therefore takes the +1 arm six times
 * and m is exactly +1; tone = 1 deletes the noise term, leaving a bare
 * positive decaying envelope into a linear, zero-state filter chain whose
 * normalisation gain depends only on |peak|. Flip the comparator to `> 0` and
 * m is exactly -1, which negates every rendered sample.
 *
 * So the claim is a sign and not a value: nothing here is sensitive to libm,
 * to the float32 rounding of the samples, or to which normalisation arm ran,
 * and the case needs no JS counterpart — it is C-only by buffer length. It
 * asserts the samples are POSITIVE, which is what `>= 0` at the boundary
 * means, plus that there is signal at all to carry a sign.
 *
 * Read the case's own comment in parity-drum-synth.c for the arithmetic.
 */
console.log("\n== hat comparator boundary (C output alone) ==");
{
  const rec = byName.get("hat-phase-underflow");
  if (!rec) {
    ok("hat-phase-underflow: sin(+0.0) >= 0 takes the +1 arm", false, "the record is missing");
  } else {
    const first = rec.out64[F.FIRST];
    const mean = rec.out64[F.MEAN];
    const peak = rec.out64[F.PEAK];
    const frames = rec.out64[F.FRAMES];
    // The buffer is eight frames, the last of which the fade zeroes; the
    // remaining seven are the positive envelope. A mutant that negates the
    // mix breaks first and mean together, and both are asserted so neither
    // alone has to carry the case.
    ok(
      "hat-phase-underflow: eight frames of signal on the comparator boundary",
      frames === 8 && peak > 0,
      `frames ${frames}, peak ${peak.toExponential(4)}`,
    );
    ok(
      "hat-phase-underflow: sin(+0.0) >= 0 takes the +1 arm, so every sample is positive",
      first > 0 && mean > 0,
      `first ${first.toExponential(4)}, mean ${mean.toExponential(4)}`,
    );
  }
}

/* ---------------- the kick wrap boundary, on the C output alone ---------- */

/**
 * render_kick guards its phase wrap with `phase > BK_TWO_PI`, and moving that
 * threshold is almost unobservable by construction, because
 * sin(phase - 2*pi) == sin(phase): a wrap at the wrong moment changes the
 * rounding of one subtraction and nothing else, which lands a few times 1e-9
 * relative — inside every band here that has to absorb libm spread.
 *
 * kick-wrap-boundary does not go looking for that rounding. At sr 20 with
 * tune 20 and drop 0 the per-sample phase increment is exactly the double
 * BK_TWO_PI, so the accumulator sits precisely ON the threshold, where `>`
 * and `>=`-style variants disagree about the phase itself rather than about
 * its last bit. The pristine `>` does not wrap, leaving the phase at
 * BK_TWO_PI — a hair below the true 2*pi, so sin is a small NEGATIVE residual
 * and the render is a tiny negative decaying ramp, left unnormalised because
 * its peak is far under the 1e-6 line. A threshold moved down to BK_PI wraps
 * to exactly +0.0 instead, sin(+0.0) is +0.0, and the entire buffer is zeros.
 *
 * So the claim is a sign and the presence of signal at all, which is why this
 * is checked against the C output alone and not against the JS: the exact
 * magnitudes here ride on one ULP of exp() in the decay chain, but their sign
 * is solid in any libm. Read the case's comment in parity-drum-synth.c.
 */
console.log("\n== kick phase-wrap boundary (C output alone) ==");
{
  const rec = byName.get("kick-wrap-boundary");
  if (!rec) {
    ok("kick-wrap-boundary: the wrap guard leaves the phase at 2*pi", false, "the record is missing");
  } else {
    const first = rec.out64[F.FIRST];
    const peak = rec.out64[F.PEAK];
    const frames = rec.out64[F.FRAMES];
    ok(
      "kick-wrap-boundary: 27 frames, and the render is not silence",
      frames === 27 && peak > 0,
      `frames ${frames}, peak ${peak.toExponential(4)}`,
    );
    // sin(BK_TWO_PI) < 0 because the double is below the true 2*pi. A wrap
    // that fired here would have zeroed the phase and the whole buffer.
    ok(
      "kick-wrap-boundary: the phase is NOT wrapped at 2*pi, so sin lands on the negative residual",
      first < 0 && peak < 1e-6,
      `first ${first.toExponential(4)}, peak ${peak.toExponential(4)}`,
    );
  }
}

/* ---------------- the equivalence claims, exact on the C side ------------ */

/**
 * These pairs must be bit-identical to each other, and unlike everything
 * else in layer 2 that IS a hard gate — both sides are the same C code, so
 * there is no libm spread to excuse a difference. They encode behavioural
 * claims the port makes:
 *
 *   - renderTom forces click to 0, so a click override on a tom must change
 *     nothing at all;
 *   - `p.level || 0` turns a NaN level into 0, so a NaN level must render
 *     exactly as an unset one;
 *   - every tune-derived quantity in renderHat saturates at or below
 *     tune = 20000 when the rate is 44100, so two wildly different tunes
 *     above that line must render the same samples. That one is also the
 *     only thing in this battery that can see where the highpass clamp
 *     ceiling sits: a ceiling change is a sub-ULP move in every feature the
 *     JS comparison bands look at, but it breaks this equality outright,
 *     because 0.6 * 20000 lands exactly on the ceiling and 0.6 * 30000 does
 *     not. Pinning it C-against-itself keeps it out of the JS bands, which
 *     deliberately do not resolve below one float32 ULP.
 */
console.log("\n== equivalence claims (exact, C against itself) ==");
for (const [a, b, why] of [
  ["tom-48k", "tom-click-ignored", "renderTom ignores click"],
  ["kick-48k", "kick-level-nan", "a NaN level coerces to 0 dB"],
  ["hat-hp-sat-lo", "hat-hp-sat-hi", "every tune-derived hat quantity saturates by 20000 at 44100"],
]) {
  const ra = byName.get(a);
  const rb = byName.get(b);
  if (!ra || !rb) {
    ok(`${a} == ${b}`, false, "a record is missing");
    continue;
  }
  let same = ra.out64.length === rb.out64.length && ra.out32.length === rb.out32.length;
  for (let i = 0; same && i < ra.out64.length; i++) same = ra.out64[i] === rb.out64[i];
  for (let i = 0; same && i < ra.out32.length; i++) same = ra.out32[i] === rb.out32[i];
  ok(`${a} == ${b} (${why})`, same, same ? `fingerprint ${ra.out64[F.FINGERPRINT]}` : "differ");
}

/* ===================== layer 4: native vs wasm, measured, NOT gated ===== */

/**
 * This deliberately does not use compareToolchains() from the shared lib, for
 * two reasons.
 *
 * First and most importantly, a regression here MUST NOT fail this battery.
 * Per brobeats-plan.md (commit f1da024) the desktop build is the product; the
 * wasm build serves the web demo. Cross-toolchain agreement is worth knowing
 * and worth pinning, so it is measured and printed, but it does not gate.
 *
 * Second, compareToolchains() reduces a record to maxAbs over its payloads,
 * and one of this module's fourteen features is a 32-bit FNV-1a hash. A
 * one-ULP audio difference moves that column by an arbitrary integer up to
 * ~4.3e9, which would make the reported "worst double" a meaningless number
 * dominated by the hash rather than by the audio. So the hash is compared for
 * equality and excluded from the magnitude reading.
 */
console.log("\n== layer 4: native vs wasm (same C, two toolchains) — MEASURED, NOT GATED ==");
if (!haveEmcc || !wasm) {
  console.log("  skipped: no emscripten SDK, or the wasm producer wrote no dump");
} else {
  const n = Math.min(native.length, wasm.length);
  console.log(`  record counts: native ${native.length}, wasm ${wasm.length}`);
  let identical = 0;
  let fpAgree = 0;
  let fpTotal = 0;
  let worstAudio = 0;
  let worstProbe = 0;
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

    if (a.out64.length === N_FEATURES && b.out64.length === N_FEATURES) {
      fpTotal++;
      if (a.out64[F.FINGERPRINT] === b.out64[F.FINGERPRINT]) fpAgree++;
      for (let j = 0; j < N_FEATURES; j++) {
        if (j === F.FINGERPRINT) continue; // a hash, not a magnitude
        const d = Math.abs(a.out64[j] - b.out64[j]);
        if (d > worstAudio) {
          worstAudio = d;
          offender = `${a.name}.${FEATURE_NAMES[j]}`;
        }
      }
    }
    const m = Math.min(a.out32.length, b.out32.length);
    for (let j = 0; j < m; j++) {
      const d = Math.abs(a.out32[j] - b.out32[j]);
      if (d > worstProbe) worstProbe = d;
    }
  }
  console.log(`  ${identical}/${n} records bit-identical across toolchains`);
  console.log(`  ${fpAgree}/${fpTotal} render cases byte-identical (fingerprint match)`);
  console.log(`  worst feature deviation (excluding the fingerprint): ${worstAudio.toExponential(3)} at ${offender || "-"}`);
  console.log(`  worst probe-sample deviation: ${worstProbe.toExponential(3)}`);
  if (drifted.length) {
    console.log("  first few records that differ at all:");
    for (const d of drifted) console.log(`    ${d}`);
  }
  console.log("  (informational — this section cannot fail the battery)");
}

/* ------------------------------------------------------------------ result */

console.log(`\n${state.checks} checks, ${state.failures} failed — ${state.failures ? "FAIL" : "PASS"}`);
process.exit(state.failures ? 1 : 0);
