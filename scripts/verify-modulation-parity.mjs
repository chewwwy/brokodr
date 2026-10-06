/** Bro.Kodr modulation C99 parity oracle. One opcode battery is replayed
 * through shipping JS, native C and emscripten. Math.random is replaced by
 * a seeded xorshift for reproducible sample-and-hold LFO draws only.
 * LFO shape snapshots canonicalise values outside 0..4 to -1 (sine default).
 * No changes to the shipping DSP. MSVC unmeasured; identity is empirical.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAndRun,
  compareToJs,
  compareToolchains,
  createChecker,
  fillSignal,
} from "./lib/parity-stream.mjs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { state, ok } = createChecker();
const { native, wasm } = buildAndRun({
  root,
  name: "parity-modulation",
  include: join(root, "packages/native/include"),
  sources: ["utils", "biquad", "delay-line", "modulation"]
    .map((n) => join(root, `packages/native/src/dsp/${n}.c`))
    .concat(join(root, "packages/native/tests/parity-modulation.c")),
  ok,
  state,
});
const shipping = await import("../packages/web/public/dsp/effects/modulation.js");
const CLASSES = ["Chorus", "Flanger", "Phaser", "Tremolo", "RingMod", "FrequencyShifter"];
const IDS = ["chorus", "flanger", "phaser", "tremolo", "ringmod", "freqshift"];
const KEYS = [
  ["rate", "depth", "delay", "voices", "spread", "feedback"],
  ["rate", "depth", "delay", "feedback", "invert", "damp", "stereo", "shape"],
  ["rate", "depth", "center", "stages", "feedback", "q", "stereo", "shape"],
  ["rate", "depth", "shape", "mode", "phase"],
  ["freq", "shape", "mode", "sweeprate", "sweepdepth"],
  ["freq", "feedback"],
];
const OP = {
  END: 0,
  INIT: 1,
  PARAM: 2,
  PROCESS: 3,
  RESET: 4,
  SNAP: 5,
  POKE: 6,
  REWIND: 7,
  GAIN: 8,
  DC: 9,
  MONO: 10,
};
const OPW = 5,
  SIG_N = 65536,
  SIG_DC = 5,
  MAX_POKES = 32;
const SIGS = [0, 1, 2, 3, 4].map((s) => Float32Array.from(fillSignal(SIG_N, s)));
const SENTINEL = new Map([
  [-3e9, NaN],
  [3e9, Infinity],
  [-4e9, -Infinity],
]);
const unsentinel = (v) => (SENTINEL.has(v) ? SENTINEL.get(v) : v);
let rng = 1;
const random = () => {
  rng ^= rng << 13;
  rng ^= rng >>> 17;
  rng ^= rng << 5;
  rng >>>= 0;
  return (rng >>> 8) / 16777216;
};
const smootherState = (s, out) => out.push(s.value, s.target, s.a);
const biquadState = (f, out) =>
  out.push(f.b0, f.b1, f.b2, f.a1, f.a2, f.z1, f.z2, f.type, f.freq, f.q, f.gainDb);
const lfoState = (l, out) =>
  out.push(
    l.phase,
    l.inc,
    l.shape >= 0 && l.shape <= 4 ? (l.shape === 0 ? 0 : l.shape) : -1,
    l.rand,
    l.lastQuad,
  );
const lineState = (l, out) => out.push(l.size, l.w);
function snapState(e, type, out, o32) {
  out.push(e.meter, rng);
  const lines = (arr) => {
    for (const d of arr) {
      lineState(d, out);
      for (const v of d.buf) o32.push(v);
    }
  };
  if (type === 0) {
    out.push(e.sr, e.voices);
    for (const l of e.lfos) lfoState(l, out);
    smootherState(e.rateSm, out);
    smootherState(e.depthSm, out);
    smootherState(e.delaySm, out);
    out.push(e.spread, e.feedback, e.fbL, e.fbR);
    biquadState(e.hpL, out);
    biquadState(e.hpR, out);
    lines(e.lines);
  } else if (type === 1) {
    out.push(e.sr);
    lfoState(e.lfoL, out);
    lfoState(e.lfoR, out);
    smootherState(e.depthSm, out);
    smootherState(e.delaySm, out);
    out.push(e.feedback, e.dampFreq, e.fbL, e.fbR, e.stereoPhase, e.invert);
    biquadState(e.damp, out);
    biquadState(e.dampR, out);
    lines([e.lineL, e.lineR]);
  } else if (type === 2) {
    out.push(e.sr, e.stages);
    for (const arr of [e.apL, e.apR]) for (const a of arr) biquadState(a, out);
    lfoState(e.lfo, out);
    lfoState(e.lfoR, out);
    smootherState(e.centerSm, out);
    smootherState(e.depthSm, out);
    out.push(e.feedback, e.q, e.fbL, e.fbR, e.stereo);
  } else if (type === 3) {
    out.push(e.sr);
    lfoState(e.lfo, out);
    lfoState(e.lfoR, out);
    smootherState(e.depthSm, out);
    out.push(e.stereoMode, e.phaseOffset, e.smoothness);
  } else if (type === 4) {
    out.push(e.sr, e.osc.phase, e.osc.inc, e.osc.pw);
    smootherState(e.freqSm, out);
    out.push(e.shape, e.sweepDepth, e.phase, e.amMode);
    lfoState(e.lfo, out);
  } else {
    out.push(e.sr, ...e.coefA, ...e.coefB);
    for (const arr of [e.stateA, e.stateB])
      for (const chain of arr) for (const a of chain) out.push(a.a, a.x1, a.x2, a.y1, a.y2);
    out.push(...e.delayA);
    smootherState(e.freqSm, out);
    out.push(e.phase, e.feedback, e.fbL, e.fbR);
  }
}
const blockState = (e, t, out, o32) => snapState(e, t, out, o32);
function replay(mod, ops) {
  const out = [];
  const o32 = [];
  let e;
  let type = 0;
  const init = (t, sr, internal = false) => {
    type = t;
    e = new mod[CLASSES[t]](sr, 128);
    rng = internal ? 0x9e3779b9 : 1;
    // vtable: no carrier bus, no latency, a meter.
    out.push(1, 1, 0);
  };
  const savedRandom = Math.random;
  Math.random = random;
  try {
    init(0, 48000);
    let cursor = 0;
    let gain = 1;
    let dc = 0;
    let pokes = [];
    const sig = (s, at) => (s === SIG_DC ? dc : SIGS[s][at]);
    const L = new Float32Array(4096);
    const R = new Float32Array(4096);
    for (let i = 0; i + OPW <= ops.length; i += OPW) {
      const op = ops[i] | 0;
      const a = unsentinel(ops[i + 1]);
      const b = unsentinel(ops[i + 2]);
      const c = unsentinel(ops[i + 3]);
      const d = unsentinel(ops[i + 4]);
      if (op === OP.END) break;
      else if (op === OP.INIT) init(a | 0, b, c === 1);
      else if (op === OP.PARAM) e.setParam(KEYS[type][a] ?? `unknown:${a}`, b);
      else if (op === OP.PROCESS) {
        const bs = b | 0;
        const sl = c | 0;
        const sr = d | 0;
        // A negative block size reaches process() as is, with no samples.
        const vL = L.subarray(0, Math.max(bs, 0));
        const vR = R.subarray(0, Math.max(bs, 0));
        for (let k = 0; k < (a | 0); k++) {
          for (let j = 0; j < bs; j++) {
            const at = (cursor + j) % SIG_N;
            vL[j] = gain * sig(sl, at);
            vR[j] = gain * (-0.5 * sig(sr, at));
          }
          cursor = (cursor + Math.max(bs, 0)) % SIG_N;
          for (const [ch, at, v] of pokes) if (at < bs) (ch ? vR : vL)[at] = v;
          pokes = [];
          e.process(vL, vR, bs);
          blockState(e, type, out, o32);
          for (let j = 0; j < bs; j++) o32.push(vL[j]);
          for (let j = 0; j < bs; j++) o32.push(vR[j]);
        }
      } else if (op === OP.MONO) {
        // One buffer as both l and r: the aliasing a mono caller produces.
        const bs = b | 0;
        const sl = c | 0;
        const vL = L.subarray(0, Math.max(bs, 0));
        for (let k = 0; k < (a | 0); k++) {
          for (let j = 0; j < bs; j++) vL[j] = gain * sig(sl, (cursor + j) % SIG_N);
          cursor = (cursor + Math.max(bs, 0)) % SIG_N;
          for (const [, at, v] of pokes) if (at < bs) vL[at] = v;
          pokes = [];
          e.process(vL, vL, bs);
          blockState(e, type, out, o32);
          for (let j = 0; j < bs; j++) o32.push(vL[j]);
        }
      } else if (op === OP.RESET) e.reset();
      else if (op === OP.SNAP) snapState(e, type, out, o32);
      else if (op === OP.POKE) {
        if (pokes.length < MAX_POKES) pokes.push([a | 0, b | 0, c]);
      } else if (op === OP.REWIND) cursor = 0;
      else if (op === OP.GAIN) gain = a;
      else if (op === OP.DC) dc = a;
    }
    snapState(e, type, out, o32);
  } finally {
    Math.random = savedRandom;
  }
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

const refs = new Map(native.map((r) => [r.name, replay(shipping, r.params)]));
const reference = (r) => refs.get(r.name);
// Empirical glibc/emscripten/V8 pins measured 2026-10-06, MSVC unmeasured.
// All out32 data (audio AND delay buffers) are exact. The out64 shortfall
// is attributed to transcendentals, not traced record by record.
const IDENTITY_NATIVE = 61,
  IDENTITY_WASM = 67,
  IDENTITY_CROSS = 62;
compareToJs({ name: "native", dump: native, reference, ok, expectIdentical: IDENTITY_NATIVE });
if (wasm) {
  compareToJs({ name: "wasm", dump: wasm, reference, ok, expectIdentical: IDENTITY_WASM });
  compareToolchains({ native, wasm, ok, expectIdentical: IDENTITY_CROSS });
}
const same = (a, b) => a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
for (const [label, dump, other, pin] of [
  ["native/JS", native, reference, IDENTITY_NATIVE],
  ...(wasm
    ? [
        ["wasm/JS", wasm, reference, IDENTITY_WASM],
        ["native/wasm", native, (_, i) => wasm[i], IDENTITY_CROSS],
      ]
    : []),
]) {
  const exact = dump.filter((r, i) => {
    const a = other(r, i);
    return same(a.out64, r.out64) && same(a.out32, r.out32);
  }).length;
  ok(`${label}: signed-zero identity pinned`, exact === pin, `${exact}/${dump.length}; pin ${pin}`);
  const audio = dump.filter((r, i) => same(other(r, i).out32, r.out32)).length;
  ok(`${label}: every out32 value bit-identical`, audio === dump.length, `${audio}/${dump.length}`);
  for (const name of ["fl_invert", "tr_mode", "rm_sweepdepth"]) {
    const i = dump.findIndex((r) => r.name === name),
      r = dump[i],
      a = other(r, i);
    ok(`${label}: ${name} bit-identical by name`, same(a.out64, r.out64) && same(a.out32, r.out32));
  }
  if (process.env.LIST_DRIFT)
    console.log(
      label +
        " drift: " +
        dump
          .filter((r, i) => {
            const a = other(r, i);
            return !same(a.out64, r.out64) || !same(a.out32, r.out32);
          })
          .map((r) => r.name)
          .join(" "),
    );
}
const cSrc = readFileSync(join(root, "packages/native/tests/parity-modulation.c"), "utf8");
for (const [key, val] of Object.entries(OP)) {
  const m = cSrc.match(new RegExp(`OP_${key}\\s*=\\s*(\\d+)`));
  ok(`opcode ${key} mirrors C`, m !== null && Number(m[1]) === val);
}
for (const [key, val] of [
  ["OPW", OPW],
  ["SIG_N", SIG_N],
  ["SIG_DC", SIG_DC],
  ["MAX_POKES", MAX_POKES],
]) {
  const m = cSrc.match(new RegExp(`#define ${key} (\\d+)`));
  ok(`${key} mirrors C`, m !== null && Number(m[1]) === val);
}
ok(
  "C payload overflow stops rather than truncating",
  /payload overflow[\s\S]{0,40}exit\(3\)/.test(cSrc),
);
ok(
  "C storage canary checked after init and every block",
  cSrc.includes("write past bk_*_storage_floats()") &&
    (cSrc.match(/check_canary\(\);/g) || []).length === 3,
);
ok(
  "C input stimulus matches JS mirror",
  cSrc.includes("g_l[j] = (float)(g_gain * sig_at(sl, at));") &&
    cSrc.includes("g_r[j] = (float)(g_gain * (-0.5 * sig_at(sr, at)));"),
);
ok(
  "negative blocks do not rewind the stimulus cursor",
  cSrc.includes("g_cursor = (g_cursor + (bs > 0 ? bs : 0)) % SIG_N;"),
);
ok(
  "all 83 scripts emitted",
  native.length === 83 && (cSrc.match(/\bS\([a-z]+_\w+\)/g) || []).length === 83,
);
// Independent hand counts of fields per snapshot; don't derive them from
// snapState(), since an omission shared with the producer would hide a gap.
const STATE64 = [73, 51, 201, 19, 18, 100];
for (const rec of native) {
  let t = 0,
    sr = 48000,
    n64 = 3,
    n32 = 0;
  const snapshot = () => {
    n64 += STATE64[t];
    if (t < 2) n32 += 2 * (Math.ceil(sr * (t === 0 ? 0.05 : 0.03)) + 4);
  };
  for (let i = 0; i + OPW <= rec.params.length; i += OPW) {
    const [op, a, b] = rec.params.slice(i, i + 3);
    if (op === OP.END) break;
    if (op === OP.INIT) {
      t = a;
      sr = b;
      n64 += 3;
    } else if (op === OP.SNAP) snapshot();
    else if (op === OP.PROCESS || op === OP.MONO) {
      for (let k = 0; k < a; k++) {
        snapshot();
        n32 += Math.max(0, b) * (op === OP.MONO ? 1 : 2);
      }
    }
  }
  snapshot();
  ok(
    `${rec.name}: independent state/audio payload lengths`,
    rec.out64.length === n64 && rec.out32.length === n32,
    `${rec.out64.length}/${n64}, ${rec.out32.length}/${n32}`,
  );
}
const schema = await import("../packages/web/src/web/audio/param-schema.ts");
const h = readFileSync(join(root, "packages/native/include/brokodr/dsp/param-keys.h"), "utf8");
for (let t = 0; t < 6; t++) {
  const id = IDS[t],
    prefix = id.toUpperCase();
  const fromH = [...h.matchAll(new RegExp(`BK_P_${prefix}_([A-Z0-9_]+) = (\\d+)`, "g"))]
    .filter((m) => m[1] !== "COUNT")
    .sort((a, b) => Number(a[2]) - Number(b[2]))
    .map((m) => m[1].toLowerCase());
  ok(`${id}: keys match C header`, fromH.join() === KEYS[t].join());
  ok(
    `${id}: keys match schema`,
    schema.EFFECTS[id].params.map((p) => p.key).join() === KEYS[t].join(),
  );
  ok(`${id}: shipping class id`, shipping[CLASSES[t]].id === id);
}
console.log(
  `\n${state.checks} checks, ${state.failures} failed\nmodulation parity: ${state.failures === 0 ? "PASS" : "FAIL"}`,
);
process.exit(state.failures === 0 ? 0 : 1);
