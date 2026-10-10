/** Bro.Kodr TalkBox C99 parity oracle. One opcode battery is replayed through
 * shipping JS, native C and emscripten. The carrier noise is a deterministic
 * xorshift and nothing draws Math.random, so nothing is substituted. No changes
 * to the shipping DSP. MSVC unmeasured; identity is empirical.
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
  name: "parity-talkbox",
  include: join(root, "packages/native/include"),
  sources: ["utils", "biquad", "delay-line", "talkbox"]
    .map((n) => join(root, `packages/native/src/dsp/${n}.c`))
    .concat(join(root, "packages/native/tests/parity-talkbox.c")),
  ok,
  state,
});
const shipping = await import("../packages/web/public/dsp/effects/talkbox.js");
const KEYS = [
  "carrier",
  "pitch",
  "follow",
  "glide",
  "order",
  "tract",
  "tractq",
  "brightness",
  "breath",
  "squelch",
  "drive",
  "output",
  "source",
];
const TalkBox = shipping.TalkBox;
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
  BUS: 11,
};
const OPW = 5,
  SIG_N = 65536,
  SIG_DC = 5,
  SIG_VOICE = 6,
  SIG_ALT = 7,
  BUS_OFFSET = 7777,
  MAX_POKES = 32,
  MAX_ORDER = 40;
// Gated two-period buzz, one correctly rounded operation per statement as in C.
const voice = new Float32Array(SIG_N);
for (let j = 0; j < SIG_N; j++) {
  const p1 = (j % 53) / 53 - 0.5;
  const p2 = (j % 37) / 37 - 0.5;
  const v1 = p1 * 0.6;
  const v2 = p2 * 0.2;
  const v = v1 + v2;
  voice[j] = j % 6000 < 4000 ? v : 0;
}
const SIGS = [0, 1, 2, 3, 4].map((s) => Float32Array.from(fillSignal(SIG_N, s)));
SIGS[SIG_VOICE] = voice;
// Nyquist square, as fill_alt in C.
SIGS[SIG_ALT] = Float32Array.from({ length: SIG_N }, (_, j) => (j % 2 === 0 ? 0.5 : -0.5));
const SENTINEL = new Map([
  [-3e9, NaN],
  [3e9, Infinity],
  [-4e9, -Infinity],
]);
const unsentinel = (v) => (SENTINEL.has(v) ? SENTINEL.get(v) : v);
const smootherState = (s, out) => out.push(s.value, s.target, s.a);
const biquadState = (f, out) =>
  out.push(f.b0, f.b1, f.b2, f.a1, f.a2, f.z1, f.z2, f.type, f.freq, f.q, f.gainDb);
const lp2State = (f, out) => out.push(f.b0, f.b1, f.b2, f.a1, f.a2, f.z1, f.z2);
const oscState = (o, out) => out.push(o.phase, o.inc, o.pw);
function blockState(e, out) {
  const t = e.tracker;
  out.push(e.meter);
  out.push(e.sr, e.maxBlock, e.carrierType, e.pitchHz, e.glideMs, e.order, e.tractSize, e.tractQ);
  out.push(e.brightness, e.breath, e.squelchDb, e.driveAmt, e.outDb, e.follow, e.source);
  out.push(e.carRms, e.carRmsA, e.frameLen, e.hop, e.histLen, e.histW, e.hopCount, e.activeOrder);
  out.push(e.gainTarget, e.noiseState, e.trackedHz, e.deZ, e.driveGain, e.carBusL !== null ? 1 : 0);
  oscState(e.osc1, out);
  oscState(e.osc2, out);
  oscState(e.oscSub, out);
  out.push(t.decim, t.dsr, t.minLag, t.maxLag, t.size, t.w, t.decimCount, t.acc, t.freq, t.confidence);
  for (const s of [e.pitchSm, e.gateSm, e.gainSm, e.outSm, e.breathSm]) smootherState(s, out);
  out.push(e.inEnv.env, e.inEnv.ca, e.inEnv.cr, e.inEnv.rms ? 1 : 0);
  for (const f of [e.breathHp, e.tiltLow, e.tiltHigh]) biquadState(f, out);
  out.push(e.dc.r, e.dc.x1, e.dc.y1);
  out.push(e.os.factor, e.os.osr, e.os.up.length);
  for (const f of e.os.upFilters) lp2State(f, out);
  for (const f of e.os.downFilters) lp2State(f, out);
  for (const v of e.kTarget) out.push(v);
  for (const v of e.kNow) out.push(v);
  for (const v of e.b) out.push(v);
}
function snapState(e, out, o32) {
  blockState(e, out);
  for (const a of [e.frame, e.acf, e.lpc, e.lpcTmp]) for (const v of a) out.push(v);
  for (const a of [e.hist, e.window, e.mono, e.os.up, e.tracker.buf]) for (const v of a) o32.push(v);
}
function replay(ops) {
  const out = [];
  const o32 = [];
  let e;
  let bus = false;
  let busL = 0,
    busR = 0,
    busGain = 1;
  const init = (sr, mb) => {
    e = new TalkBox(sr, mb);
    bus = false;
    // vtable: a carrier bus hook, no latency, a meter.
    out.push(0, 1, 0);
  };
  init(48000, 128);
  let cursor = 0;
  let gain = 1;
  let dc = 0;
  let pokes = [];
  const sig = (s, at) => (s === SIG_DC ? dc : SIGS[s][at]);
  const L = new Float32Array(4096);
  const R = new Float32Array(4096);
  const CL = new Float32Array(4096);
  const CR = new Float32Array(4096);
  const fillBus = (bs) => {
    for (let j = 0; j < bs; j++) {
      const at = (cursor + j + BUS_OFFSET) % SIG_N;
      CL[j] = busGain * sig(busL, at);
      CR[j] = busGain * sig(busR, at);
    }
  };
  for (let i = 0; i + OPW <= ops.length; i += OPW) {
    const op = ops[i] | 0;
    const a = unsentinel(ops[i + 1]);
    const b = unsentinel(ops[i + 2]);
    const c = unsentinel(ops[i + 3]);
    const d = unsentinel(ops[i + 4]);
    if (op === OP.END) break;
    else if (op === OP.INIT) init(a, b | 0);
    else if (op === OP.PARAM) e.setParam(KEYS[a] ?? `unknown:${a}`, b);
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
        if (bus) fillBus(bs);
        cursor = (cursor + Math.max(bs, 0)) % SIG_N;
        for (const [ch, at, v] of pokes) if (at < bs) (ch ? vR : vL)[at] = v;
        pokes = [];
        e.process(vL, vR, bs);
        blockState(e, out);
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
        if (bus) fillBus(bs);
        cursor = (cursor + Math.max(bs, 0)) % SIG_N;
        for (const [, at, v] of pokes) if (at < bs) vL[at] = v;
        pokes = [];
        e.process(vL, vL, bs);
        blockState(e, out);
        for (let j = 0; j < bs; j++) o32.push(vL[j]);
      }
    } else if (op === OP.RESET) e.reset();
    else if (op === OP.SNAP) snapState(e, out, o32);
    else if (op === OP.POKE) {
      if (pokes.length < MAX_POKES) pokes.push([a | 0, b | 0, c]);
    } else if (op === OP.REWIND) cursor = 0;
    else if (op === OP.GAIN) gain = a;
    else if (op === OP.DC) dc = a;
    else if (op === OP.BUS) {
      bus = true;
      busL = a | 0;
      busR = b | 0;
      busGain = c;
      e.setCarrierBus(CL, CR);
    }
  }
  snapState(e, out, o32);
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

/** Debug aid: name the block-state field an out64 index lands on. */
function where64(rec, k) {
  let at = 3;
  let sr = 48000;
  let n = 0;
  const inBlock = (base, what) => {
    const f = k - base;
    if (f < 0 || f >= 270) return null;
    return `${what} field ${f}`;
  };
  for (let i = 0; i + OPW <= rec.params.length; i += OPW) {
    const [op, a, b] = rec.params.slice(i, i + 3);
    if (op === OP.END) break;
    if (op === OP.INIT) {
      if (k < at + 3) return "vt flags";
      at += 3;
      sr = a;
    } else if (op === OP.SNAP) {
      const hit = inBlock(at, "snap");
      if (hit) return hit;
      const len = 270 + Math.max(256, Math.min(2048, Math.round(sr * 0.025))) + 123;
      if (k < at + len) return `snap buffer +${k - at - 270}`;
      at += len;
    } else if (op === OP.PROCESS || op === OP.MONO) {
      for (let j = 0; j < a; j++, n++) {
        const hit = inBlock(at, `block ${n}`);
        if (hit) return hit;
        at += 270;
      }
    }
  }
  return inBlock(at, "final snap") ?? `final snap buffer +${k - at - 270}`;
}
const refs = new Map(native.map((r) => [r.name, replay(r.params)]));
const reference = (r) => refs.get(r.name);
// Empirical glibc/emscripten/V8 pins measured 2026-10-06, re-measured
// 2026-10-10 (talkbox), MSVC unmeasured: every record, out64 and out32, signed
// zeros included. Most scripts run with the drive off (TB in the C battery).
// Drive is on in t_default, t_drive, t_combo, t_rates, t_drive_blocks,
// mixed_inits, and in t_blocks after its INIT(16000,4096), which restores the
// 0.25 default. Attributed by elimination from the first differing field
// (LIST_DRIFT=2), not traced by re-evaluating libm:
//  - native/JS: only t_blocks and t_rates drift.
//    t_blocks first differs at in_env.env (field 64) after the 16 kHz re-INIT:
//    exp(-1/48), the 3 ms attack at 16 kHz, is one ulp apart (glibc
//    0.97938218133124011, V8 0.9793821813312402), and both C builds give the
//    glibc value. Which is why the other scripts run at 48 kHz.
//    t_rates first differs in its 4500.3 Hz leg at oversampler down-filter
//    state (field 140, block 38) while the up-filter state before it agrees.
//    The only operation between them is the shaper's tanh (the multiply and
//    divide around it are correctly rounded), so a glibc/V8 tanh split there is
//    the likely cause; not confirmed by evaluating tanh on that argument. The
//    48 kHz drive scripts are identical, which shows only that glibc and V8
//    agree on the arguments those scripts reach, not on every argument.
//  - wasm/JS and native/wasm: t_default t_drive t_blocks t_rates t_combo
//    t_drive_blocks mixed_inits, every drive-on script. Each first differs at
//    down-filter state (fields 133-140; t_blocks at 140, native/wasm, after
//    the re-INIT): emscripten's tanh differs from glibc and V8 there.
// The -O0 coverage build differs from -O2 only in the sign of NaNs.
const IDENTITY_NATIVE = 48,
  IDENTITY_WASM = 43,
  IDENTITY_CROSS = 43;
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
        console.log(
          `  ${r.name} out64[${k}] (${where64(r, k)}) of ${r.out64.length}: ${r.out64[k]} vs ${a.out64[k]}`,
        );
    });
}
const cSrc = readFileSync(join(root, "packages/native/tests/parity-talkbox.c"), "utf8");
for (const [key, val] of Object.entries(OP)) {
  const m = cSrc.match(new RegExp(`OP_${key}\\s*=\\s*(\\d+)`));
  ok(`opcode ${key} mirrors C`, m !== null && Number(m[1]) === val);
}
for (const [key, val] of [
  ["OPW", OPW],
  ["SIG_N", SIG_N],
  ["SIG_DC", SIG_DC],
  ["SIG_VOICE", SIG_VOICE],
  ["SIG_ALT", SIG_ALT],
  ["BUS_OFFSET", BUS_OFFSET],
  ["MAX_POKES", MAX_POKES],
]) {
  const m = cSrc.match(new RegExp(`#define ${key} (\\d+)`));
  ok(`${key} mirrors C`, m !== null && Number(m[1]) === val);
}
const hSrc = readFileSync(join(root, "packages/native/include/brokodr/dsp/talkbox.h"), "utf8");
ok("MAX_ORDER mirrors C", new RegExp(`#define BK_TALKBOX_MAX_ORDER ${MAX_ORDER}\\b`).test(hSrc));
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
    cSrc.includes("g_r[j] = (float)(g_gain * (-0.5 * sig_at(sr, at)));") &&
    cSrc.includes("const int at = (g_cursor + j + BUS_OFFSET) % SIG_N;") &&
    cSrc.includes("g_cl[j] = (float)(g_bus_gain * sig_at(g_bus_l, at));") &&
    cSrc.includes("g_cr[j] = (float)(g_bus_gain * sig_at(g_bus_r, at));"),
);
ok(
  "C voice stimulus matches JS mirror",
  cSrc.includes("const double p1 = (double)(j % 53) / 53.0 - 0.5;") &&
    cSrc.includes("const double p2 = (double)(j % 37) / 37.0 - 0.5;") &&
    cSrc.includes("const double v1 = p1 * 0.6;") &&
    cSrc.includes("const double v2 = p2 * 0.2;") &&
    cSrc.includes("dst[j] = (float)((j % 6000) < 4000 ? v : 0.0);") &&
    cSrc.includes("for (j = 0; j < SIG_N; j++) dst[j] = (j % 2) == 0 ? 0.5f : -0.5f;") &&
    cSrc.includes("fill_alt(g_sig[SIG_ALT]);"),
);
ok(
  "bus is filled before the cursor advances, in both block ops",
  (cSrc.match(/if \(g_bus\) fill_bus\(bs\);\n\s*g_cursor = \(g_cursor \+ \(bs > 0 \? bs : 0\)\) % SIG_N;/g) || [])
    .length === 2,
);
ok(
  "negative blocks do not rewind the stimulus cursor",
  cSrc.includes("g_cursor = (g_cursor + (bs > 0 ? bs : 0)) % SIG_N;"),
);
const N_SCRIPTS = 50;
ok(
  `all ${N_SCRIPTS} scripts emitted`,
  native.length === N_SCRIPTS &&
    (cSrc.match(/\bS\((?:t|mixed)_\w+\)/g) || []).length === N_SCRIPTS,
);
// Independent hand counts from the JS constructor formulas, not from the
// objects: 270 per-block scalars, then the snapshot buffers.
const STATE64 = 270;
const frameLen = (sr) => Math.max(256, Math.min(2048, Math.round(sr * 0.025)));
const trackerSize = (sr) => 2 * Math.floor(sr / Math.max(1, Math.floor(sr / 12000)) / 60);
const snap64 = (sr) => STATE64 + frameLen(sr) + 3 * (MAX_ORDER + 1);
const snap32 = (sr, mb) =>
  2 * frameLen(sr) + mb + 8 + frameLen(sr) + mb + 4 * mb + trackerSize(sr);
for (const rec of native) {
  let sr = 48000,
    mb = 128,
    n64 = 3,
    n32 = 0;
  const snapshot = () => {
    n64 += snap64(sr);
    n32 += snap32(sr, mb);
  };
  for (let i = 0; i + OPW <= rec.params.length; i += OPW) {
    const [op, a, b] = rec.params.slice(i, i + 3);
    if (op === OP.END) break;
    if (op === OP.INIT) {
      sr = a;
      mb = b;
      n64 += 3;
    } else if (op === OP.SNAP) snapshot();
    else if (op === OP.PROCESS || op === OP.MONO) {
      for (let k = 0; k < a; k++) {
        n64 += STATE64;
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
const fromH = [...h.matchAll(/BK_P_TALKBOX_([A-Z0-9_]+) = (\d+)/g)]
  .filter((m) => m[1] !== "COUNT")
  .sort((a, b) => Number(a[2]) - Number(b[2]))
  .map((m) => m[1].toLowerCase());
ok("talkbox: keys match C header", fromH.join() === KEYS.join(), fromH.join());
ok("talkbox: keys match schema", schema.EFFECTS.talkbox.params.map((p) => p.key).join() === KEYS.join());
ok("talkbox: shipping class id", TalkBox.id === "talkbox");
ok("talkbox: no quality key", /#define BK_P_TALKBOX_QUALITY_KEY BK_PARAM_NONE/.test(h));
// Payload sanity: the battery is not vacuous (audible, nonzero output).
let nonzero = 0;
for (const r of native) for (const v of r.out32) if (v !== 0 && Number.isFinite(v)) nonzero++;
ok("battery output is substantially nonzero", nonzero > 1e6, `${nonzero} nonzero finite floats`);
console.log(
  `\n${state.checks} checks, ${state.failures} failed\ntalkbox parity: ${state.failures === 0 ? "PASS" : "FAIL"}`,
);
process.exit(state.failures === 0 ? 0 : 1);
