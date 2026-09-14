/**
 * Parity oracle for the C port of dsp/core/utils.js (Phase 5, route (c)).
 *
 * Same shape as verify-biquad-parity.mjs, now on the shared plumbing in
 * scripts/lib/parity-stream.mjs:
 *
 *   1. build packages/native/src/dsp/utils.c natively and run the battery;
 *   2. build the same source to wasm with emscripten and run it under Node;
 *   3. replay the identical battery through the original utils.js and diff;
 *   4. diff native against wasm — the check that actually matters for
 *      shipping, because the desktop and the web build have to agree with each
 *      other, not merely each agree with the JS to within some slack.
 *
 * The battery lives in packages/native/tests/parity-utils.c and only there.
 * Every case parameter travels in the dump, so this file reads the sweep back
 * out rather than keeping a copy of it — there is no case table to keep in sync.
 *
 * Randomness: utils.js reaches for Math.random() in LFO (sample-and-hold) and
 * PinkNoise. The C port takes the random sample as an argument instead, and
 * this script feeds the JS the same values by standing in for Math.random with
 * the stimulus. The substitution is exact, not approximate — the stimulus is
 * k/2**23 - 1 for integer k, so (x + 1) / 2 round-trips through
 * `Math.random() * 2 - 1` without losing a bit.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  TOL,
  buildAndRun,
  compareToJs,
  compareToolchains,
  createChecker,
  describe,
  fillSignal,
  firstDiff,
  maxRel,
} from "./lib/parity-stream.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();

const { native, wasm, haveEmcc } = buildAndRun({
  root,
  name: "parity-utils",
  include: join(root, "packages/native/include"),
  sources: [join(root, "packages/native/src/dsp/utils.c"), join(root, "packages/native/tests/parity-utils.c")],
  ok,
  state,
});

console.log(`\n   ${native.length} records in the battery`);

const js = await import("../packages/web/public/dsp/core/utils.js");

// ---------------------------------------------------------------------------
// scalar records: params[0] is the arity, payload is (inputs..., output) groups
// ---------------------------------------------------------------------------

const SCALARS = {
  sanitize: (x) => js.sanitize(x),
  dbToGain: (x) => js.dbToGain(x),
  gainToDb: (x) => js.gainToDb(x),
  semitonesToRatio: (x) => js.semitonesToRatio(x),
  clamp: (x, lo, hi) => js.clamp(x, lo, hi),
  lerp: (a, b, t) => js.lerp(a, b, t),
  polyBlep: (t, dt) => js.polyBlep(t, dt),
};

function scalarReference(rec) {
  const arity = rec.params[0];
  const stride = arity + 1;
  const fn = SCALARS[rec.name];
  const out = new Float64Array(rec.out64.length);
  const args = new Array(arity);
  for (let i = 0; i + stride <= rec.out64.length; i += stride) {
    for (let a = 0; a < arity; a++) {
      out[i + a] = rec.out64[i + a]; // inputs travel in the stream
      args[a] = rec.out64[i + a];
    }
    out[i + arity] = fn(...args);
  }
  return { out64: out, out32: new Float32Array(0) };
}

// ---------------------------------------------------------------------------
// stateful records
// ---------------------------------------------------------------------------

/** Run `fn` with Math.random() replaced by a replay of `values`. */
function withRandom(values, fn) {
  const real = Math.random;
  let i = 0;
  // Math.random() * 2 - 1 must come back as values[i] exactly; see the header.
  Math.random = () => {
    const v = values[Math.min(i++, values.length - 1)];
    return (v + 1) / 2;
  };
  try {
    return fn();
  } finally {
    Math.random = real;
  }
}

const STATEFUL = {
  Smoother(rec) {
    const [sr, ms, initial, target, n] = rec.params;
    const s = new js.Smoother(sr, ms, initial);
    s.set(target);
    const out = new Float64Array(n + 1);
    for (let t = 0; t < n; t++) {
      if (t === Math.floor(n / 2)) s.set(-target);
      out[t] = s.next();
    }
    out[n] = s.settled ? 1 : 0;
    return out;
  },

  EnvelopeFollower(rec) {
    const [sr, attack, release, rms, signal, n] = rec.params;
    const sig = fillSignal(n, signal);
    const e = new js.EnvelopeFollower(sr, attack, release, rms !== 0);
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) out[t] = e.process(sig[t]);
    return out;
  },

  LFO(rec) {
    const [sr, hz, shape, phase0, n] = rec.params;
    const sig = fillSignal(n, 2 /* BK_SIG_NOISE */);
    const l = new js.LFO(sr);
    l.shape = shape;
    l.setRate(hz);
    l.setPhase(phase0);
    const out = new Float64Array(n);
    // The C is handed sig[t] on every call; the JS only pulls a random number
    // on a wrap, so the replay has to be indexed the same way the C indexes it.
    // Feeding the stream in order would desynchronise, so each call gets its own
    // one-shot source.
    for (let t = 0; t < n; t++) out[t] = withRandom([sig[t]], () => l.next());
    return out;
  },

  DCBlocker(rec) {
    const [sr, hz, signal, n] = rec.params;
    const sig = fillSignal(n, signal);
    const d = new js.DCBlocker(sr, hz);
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) out[t] = d.process(sig[t] * 0.5 + 0.25);
    return out;
  },

  PitchTracker(rec) {
    const [sr, minHz, maxHz, signal, n, block] = rec.params;
    const sig = fillSignal(n, signal);
    const p = new js.PitchTracker(sr, minHz, maxHz);
    const out = [];
    for (let t = 0; t < n; t++) {
      p.push(sig[t]);
      if ((t + 1) % block === 0) out.push(p.analyze(), p.confidence);
    }
    return Float64Array.from(out);
  },

  "Oscillator.saw"(rec) {
    const [sr, freq, pw, , n] = rec.params;
    const o = new js.Oscillator(sr);
    o.setFreq(freq);
    o.pw = pw;
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) out[t] = o.saw();
    return out;
  },

  "Oscillator.pulse"(rec) {
    const [sr, freq, pw, , n] = rec.params;
    const o = new js.Oscillator(sr);
    o.setFreq(freq);
    o.pw = pw;
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) out[t] = o.pulse();
    return out;
  },

  PinkNoise(rec) {
    const [signal, n] = rec.params;
    const sig = fillSignal(n, signal);
    const p = new js.PinkNoise();
    const out = new Float64Array(n);
    for (let t = 0; t < n; t++) out[t] = withRandom([sig[t]], () => p.next());
    return out;
  },
};

const isScalar = (rec) => rec.name in SCALARS;

function reference(rec) {
  if (isScalar(rec)) return scalarReference(rec);
  const fn = STATEFUL[rec.name];
  if (!fn) throw new Error(`no JS reference for record "${rec.name}"`);
  return { out64: fn(rec), out32: new Float32Array(0) };
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

ok(
  "every record has a JS reference",
  native.every((r) => isScalar(r) || r.name in STATEFUL),
  [...new Set(native.map((r) => r.name))].join(", "),
);

// Scalars get a relative bar, not the -120 dBFS sample bar: they are single
// evaluations with no accumulation, and their range runs out to 1e30 where an
// absolute tolerance would mean nothing.
console.log("\n== scalar functions vs utils.js ==");
{
  let worst = 0;
  let offender = "";
  let bad = 0;
  for (const rec of native.filter(isScalar)) {
    const d = maxRel(scalarReference(rec).out64, rec.out64);
    if (d > worst) (worst = d), (offender = describe(rec));
    if (d > TOL.scalar) {
      bad++;
      const at = firstDiff(scalarReference(rec).out64, rec.out64);
      console.log(`  FAIL ${rec.name} rel=${d.toExponential(2)} first diff at index ${at}`);
    }
  }
  ok("scalar helpers agree", bad === 0, `worst rel ${worst.toExponential(2)}${offender ? ` (${offender})` : ""}`);
}

// Bit-identity baselines, pinned. The tolerance checks pass at -120 dBFS,
// which a sub-ulp perturbation can slip under while still being a different
// function; mutation testing on fft.js found exactly that hole. A drop here is
// either a real change in the port or a change in libm (see the caveat in
// brobeats-plan.md) — investigate, then re-baseline deliberately.
const IDENTITY_NATIVE = 84;
const IDENTITY_WASM = 85;
const IDENTITY_CROSS = 96;

compareToJs({
  name: "native",
  dump: native.filter((r) => !isScalar(r)),
  reference,
  ok,
  expectIdentical: IDENTITY_NATIVE,
});
if (wasm) {
  console.log("\n== scalar functions: wasm vs utils.js ==");
  let worst = 0;
  let bad = 0;
  for (const rec of wasm.filter(isScalar)) {
    const d = maxRel(scalarReference(rec).out64, rec.out64);
    if (d > worst) worst = d;
    if (d > TOL.scalar) bad++;
  }
  ok("wasm scalar helpers agree", bad === 0, `worst rel ${worst.toExponential(2)}`);
  compareToJs({
    name: "wasm",
    dump: wasm.filter((r) => !isScalar(r)),
    reference,
    ok,
    expectIdentical: IDENTITY_WASM,
  });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY_CROSS });
}

// ---------------------------------------------------------------------------
// sanity: the battery has to actually exercise the code
// ---------------------------------------------------------------------------

console.log("\n== sanity: the battery actually exercises utils ==");
{
  const names = new Set(native.map((r) => r.name));
  const expected = [...Object.keys(SCALARS), ...Object.keys(STATEFUL)];
  const missing = expected.filter((n) => !names.has(n));
  ok("every ported object appears in the battery", missing.length === 0, missing.length ? `missing: ${missing}` : `${names.size} distinct`);

  // The scalar records are fed a deliberate +/-1e30 edge-value battery, so
  // 1e31-scale outputs there are correct, not a blowup. Only the stateful
  // objects — the ones with feedback paths that *can* run away — get a bound.
  const UNBOUNDED = new Set(["sanitize", "dbToGain", "gainToDb", "semitonesToRatio", "clamp", "lerp", "polyBlep"]);
  let nonTrivial = 0;
  let widest = 0;
  let widestName = "";
  for (const rec of native) {
    let p = 0;
    for (let i = 0; i < rec.out64.length; i++) {
      const v = Math.abs(rec.out64[i]);
      if (Number.isFinite(v) && v > p) p = v;
    }
    if (p > 1e-6) nonTrivial++;
    if (!UNBOUNDED.has(rec.name) && p > widest) {
      widest = p;
      widestName = rec.name;
    }
  }
  ok("most records produce real signal", nonTrivial > native.length * 0.8, `${nonTrivial}/${native.length} above -120 dBFS`);
  // 1e4 clears the widest legitimate value (PitchTracker reports Hz, not a
  // sample) by orders of magnitude while still catching a runaway filter.
  ok("no stateful object ran away", widest < 1e4, `widest ${widest.toExponential(2)} (${widestName})`);

  // The pitch tracker is the one case where "it ran" is not the same as "it
  // worked": a broken port can return 0 for everything and still match nothing.
  // The stimulus is a sawtooth of period 256 *samples*, so the expected pitch
  // is sr/256 — 187.5 Hz at 48 kHz, 172.266 Hz at 44.1 kHz.
  //
  // Octave ambiguity is allowed here on purpose. At 44.1 kHz the original
  // JS tracker itself alternates between sr/256 and half that (see
  // PITCH-OCTAVE note in brobeats-plan.md); the C port reproduces that
  // bit for bit, which is what the parity checks above measure. This check
  // only asserts the tracker found the period at all.
  const ramp = native.filter((r) => r.name === "PitchTracker" && r.params[3] === 3);
  const locked = ramp.filter((r) => {
    const expect = r.params[0] / 256;
    const hz = r.out64[r.out64.length - 2];
    if (!(hz > 0)) return false;
    const ratio = hz / expect;
    return [0.5, 1, 2].some((k) => Math.abs(ratio - k) < 0.05 * k);
  });
  ok("pitch tracker locks onto the sawtooth period", locked.length === ramp.length, `${locked.length}/${ramp.length} cases`);
  const noisy = native.filter((r) => r.name === "PitchTracker" && r.params[3] === 4);
  ok("pitch tracker reports unvoiced on silence", noisy.every((r) => [...r.out64].every((v) => v === 0)), `${noisy.length} cases`);
}

console.log(`\n${state.checks} checks, ${state.failures} failed`);
console.log(`\nutils parity: ${state.failures === 0 ? "PASS" : "FAIL"}`);
if (!haveEmcc) console.log("note: wasm half skipped — emscripten unavailable");
process.exit(state.failures === 0 ? 0 : 1);
