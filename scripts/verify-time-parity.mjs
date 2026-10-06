/** Bro.Kodr time effects (Delay, Reverb) C99 parity oracle. One opcode battery
 * is replayed through shipping JS, native C and emscripten. Neither effect draws
 * randomness (their LFOs stay sine), so nothing is substituted. No changes to
 * the shipping DSP. MSVC unmeasured; identity is empirical.
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
  name: "parity-time",
  include: join(root, "packages/native/include"),
  sources: ["utils", "biquad", "delay-line", "time-fx"]
    .map((n) => join(root, `packages/native/src/dsp/${n}.c`))
    .concat(join(root, "packages/native/tests/parity-time.c")),
  ok,
  state,
});
const shipping = await import("../packages/web/public/dsp/effects/time.js");
const KEYS = [
  [
    "time",
    "sync",
    "bpm",
    "feedback",
    "pingpong",
    "lowpass",
    "highpass",
    "moddepth",
    "modrate",
    "spread",
    "crossfeed",
    "saturate",
  ],
  ["decay", "size", "damping", "predelay", "width", "highpass", "modulation", "diffusion"],
];
const CLASSES = [shipping.Delay, shipping.Reverb];
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
const smootherState = (s, out) => out.push(s.value, s.target, s.a);
const biquadState = (f, out) =>
  out.push(f.b0, f.b1, f.b2, f.a1, f.a2, f.z1, f.z2, f.type, f.freq, f.q, f.gainDb);
const lfoState = (l, out) => out.push(l.phase, l.inc, l.shape, l.rand, l.lastQuad);
const lineState = (l, out) => out.push(l.size, l.w);
function blockState(e, type, out) {
  out.push(e.meter);
  if (type === 0) {
    out.push(e.sr, e.feedback, e.pingpong, e.lpFreq, e.hpFreq, e.fbL, e.fbR);
    out.push(e.modDepth, e.spread, e.bpm, e.syncDiv, e.timeMs, e.crossfeed, e.saturate);
    smootherState(e.timeL, out);
    smootherState(e.timeR, out);
    lfoState(e.lfo, out);
    for (const f of [e.lpL, e.lpR, e.hpL, e.hpR]) biquadState(f, out);
    lineState(e.lineL, out);
    lineState(e.lineR, out);
  } else {
    out.push(e.sr, e.widthAmt, e.hpFreq, e.modDepth, e.diffusion);
    for (const s of [e.sizeSm, e.decaySm, e.dampSm, e.preDelaySm]) smootherState(s, out);
    biquadState(e.hpL, out);
    biquadState(e.hpR, out);
    for (const l of e.lfos) lfoState(l, out);
    for (const v of e.dampState) out.push(v);
    for (const v of e.tmp) out.push(v);
    for (const a of [...e.diffL, ...e.diffR]) {
      out.push(a.delay, a.g);
      lineState(a.line, out);
    }
    for (const l of e.lines) lineState(l, out);
    lineState(e.preL, out);
    lineState(e.preR, out);
  }
}
function snapState(e, type, out, o32) {
  blockState(e, type, out);
  const bufs =
    type === 0
      ? [e.lineL, e.lineR]
      : [...e.lines, ...e.diffL.map((a) => a.line), ...e.diffR.map((a) => a.line), e.preL, e.preR];
  for (const l of bufs) for (const v of l.buf) o32.push(v);
}
function replay(ops) {
  const out = [];
  const o32 = [];
  let e;
  let type;
  const init = (t, sr) => {
    type = t;
    e = new CLASSES[t](sr, 128);
    // vtable: no carrier bus, no latency, a meter.
    out.push(1, 1, 0);
  };
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
    else if (op === OP.INIT) init(a | 0, b);
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
        blockState(e, type, out);
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
        blockState(e, type, out);
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
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

const refs = new Map(native.map((r) => [r.name, replay(r.params)]));
const reference = (r) => refs.get(r.name);
// Empirical glibc/emscripten/V8 pins measured 2026-10-06 (time), MSVC unmeasured:
// every record, out64 and out32, signed zeros included, on all three comparisons.
// Traced (Math.* wrapped, then each argument re-evaluated with glibc and
// emscripten libm) on every drifting script except d_combo, which was NOT traced
// (it runs the same modulated read as d_mod): sin is the only transcendental whose
// results differ from V8 (glibc 458-3454 arguments per script, emscripten 57-950);
// cos, exp and pow agree on every traced argument. The LFOs are sine, so the drift lands
// where they feed the delay read position. Every out32 buffer is identical.
const IDENTITY_NATIVE = 44,
  IDENTITY_WASM = 47,
  IDENTITY_CROSS = 46;
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
  if (process.env.LIST_DRIFT === "2")
    dump.forEach((r, i) => {
      const a = other(r, i);
      const k = r.out64.findIndex((v, j) => !Object.is(v, a.out64[j]));
      if (k >= 0)
        console.log(`  ${r.name} out64[${k}] of ${r.out64.length}: ${r.out64[k]} vs ${a.out64[k]}`);
    });
}
const cSrc = readFileSync(join(root, "packages/native/tests/parity-time.c"), "utf8");
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
  "C struct canary checked after init and every block",
  cSrc.includes("write past the effect struct or storage") &&
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
const N_SCRIPTS = 50;
ok(
  `all ${N_SCRIPTS} scripts emitted`,
  native.length === N_SCRIPTS &&
    (cSrc.match(/\bS\((?:d|r|mixed)_\w+\)/g) || []).length === N_SCRIPTS,
);
// Independent hand counts from the JS constructor formulas, not from the
// objects: per-block scalars (delay 74, reverb 148) and snapshot buffer sizes.
const STATE64 = [74, 148];
const lineSize = (max) => Math.max(4, Math.ceil(max) + 4);
const BASE = [23.7, 29.3, 37.1, 41.9, 47.3, 53.1, 59.7, 67.3];
const DIFF = [0.0047, 0.0089, 0.0131, 0.0173, 0.0051, 0.0093, 0.0137, 0.0181];
const bufFloats = (t, sr) =>
  t === 0
    ? 2 * lineSize(Math.ceil(sr * 4))
    : BASE.reduce((s, ms) => s + lineSize(Math.ceil((ms * 3.5 * sr) / 1000) + 8), 0) +
      DIFF.reduce((s, x) => s + lineSize(Math.round(sr * x)), 0) +
      2 * lineSize(Math.ceil(sr * 0.25) + 8);
for (const rec of native) {
  let t = 0,
    sr = 48000,
    n64 = 3,
    n32 = 0;
  const snapshot = () => {
    n64 += STATE64[t];
    n32 += bufFloats(t, sr);
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
        n64 += STATE64[t];
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
for (const [t, id, prefix] of [
  [0, "delay", "DELAY"],
  [1, "reverb", "REVERB"],
]) {
  const fromH = [...h.matchAll(new RegExp(`BK_P_${prefix}_([A-Z0-9_]+) = (\\d+)`, "g"))]
    .filter((m) => m[1] !== "COUNT")
    .sort((a, b) => Number(a[2]) - Number(b[2]))
    .map((m) => m[1].toLowerCase());
  ok(`${id}: keys match C header`, fromH.join() === KEYS[t].join(), fromH.join());
  ok(
    `${id}: keys match schema`,
    schema.EFFECTS[id].params.map((p) => p.key).join() === KEYS[t].join(),
  );
  ok(`${id}: shipping class id`, CLASSES[t].id === id);
  ok(
    `${id}: no quality key`,
    new RegExp(`#define BK_P_${prefix}_QUALITY_KEY BK_PARAM_NONE`).test(h),
  );
}
// Payload sanity: the battery is not vacuous (audible, nonzero output).
let nonzero = 0;
for (const r of native) for (const v of r.out32) if (v !== 0 && Number.isFinite(v)) nonzero++;
ok("battery output is substantially nonzero", nonzero > 1e6, `${nonzero} nonzero finite floats`);
console.log(
  `\n${state.checks} checks, ${state.failures} failed\ntime parity: ${state.failures === 0 ? "PASS" : "FAIL"}`,
);
process.exit(state.failures === 0 ? 0 : 1);
