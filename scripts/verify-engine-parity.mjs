/** Bro.Kodr engine C99 parity oracle. One opcode battery (parity-engine.c) is
 * replayed through the shipping engine.js, native C and emscripten. No changes
 * to the shipping DSP.
 *
 * Every verb goes through Engine.applyCommand() with the command object the
 * app's own hosts build; numeric keys are mapped back to names through
 * param-schema.ts (effects) and backend.ts / the worklet tables (everything
 * else), an unknown key becoming `unknown:<k>`, which every module ignores.
 * Math.random: replaced for the whole replay by a counted mirror of the
 * battery's xorshift, the single source the C hands every effect.
 * MSVC unmeasured; identity is empirical.
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
const DSP = [
  "utils", "biquad", "fft", "delay-line", "onset", "beat-classify", "clock", "chain",
  "drum-synth", "drum-voice", "drum-rack", "file-player", "looper", "effect-registry",
  "eq", "dynamics", "drive", "spectral", "vocoder", "talkbox", "modulation", "time-fx",
  "character", "engine",
];
const { native, wasm } = buildAndRun({
  root,
  name: "parity-engine",
  include: join(root, "packages/native/include"),
  sources: DSP.map((n) => join(root, `packages/native/src/dsp/${n}.c`)).concat(
    join(root, "packages/native/tests/parity-engine.c"),
  ),
  ok,
  state,
  // The engine's storage is ~58 MB at 48 kHz (four 30 s stereo loop tracks).
  emccFlags: ["-sALLOW_MEMORY_GROWTH=1"],
});

const { Engine } = await import("../packages/web/public/dsp/engine.js");
const { EFFECT_CLASSES } = await import("../packages/web/public/dsp/effects/registry.js");
const { LOOP_TRACKS, LOOP_METER_STRIDE } = await import("../packages/web/public/dsp/core/looper.js");
const { VOICE_METER_STRIDE, CLASS_COUNT, CAP_STRIDE } = await import(
  "../packages/web/public/dsp/core/beat-classify.js"
);
const { EFFECTS } = await import("../packages/web/src/web/audio/param-schema.ts");
const backend = await import("../packages/web/src/web/audio/backend.ts");
const { PAD_KEY, DRUM_KEY, LOOP_KEY, LOOPER_KEY, CLOCK_KEY, VOICE_KEY } = backend;
const TYPES = Object.keys(EFFECT_CLASSES);
// The worklet's FILE_KEY (index = FILE_FIELD, ROUTE excluded) and IO_FIELD names.
const FILE_KEY = ["play", "seek", "loop", "loopin", "loopout", "speed", "pitch", "gain"];
const IO_NAME = ["inGain", "outGain", "mute", "bypass", "mono", "swap", "masterMix"];
const LOOP_OP = { 0: "rec", 1: "play", 2: "stop", 3: "clear", 4: "undo", 6: "clearall" };
const CAL_OP = ["centroid", "attack", "pad", "capture", "clear", "reset", "detreset"];

const OP = {
  END: 0, INIT: 1, PROCESS: 2, INPLACE: 3, SNAP: 4, POKE: 5, REWIND: 6, GAIN: 7, DC: 8,
  SEED: 9, ADD: 10, ADDOPT: 11, REMOVE: 12, MOVE: 13, FXPARAM: 14, MIX: 15, BYPASS: 16,
  FXRESET: 17, FXCLEAR: 18, IO: 19, FILELOAD: 20, FILECLEAR: 21, FILE: 22, FILEROUTE: 23,
  PAD: 24, PADOFF: 25, PADPARAM: 26, PADLOAD: 27, PADCLEAR: 28, DRUM: 29, DRUMRESET: 30,
  LOOP: 31, LOOPPARAM: 32, LOOPER: 33, VOICE: 34, VOICECAL: 35, CLOCK: 36, CLIPRESET: 37,
  PANIC: 38, RECALC: 39, CAPS: 40,
};
const OPW = 6,
  SIG_N = 65536,
  SIG_DC = 5,
  SIG_VOICE = 6,
  SIG_BEAT = 7,
  MAX_BLOCK = 4096,
  MAX_POKES = 32,
  METER_FILL = -7,
  TEST_SEED = 0x2545f491,
  UNDEF = -5e9;
const T_MASTER = 0,
  T_PAD = 1,
  T_LOOP = 2;
const VB = 68 + LOOP_TRACKS * LOOP_METER_STRIDE + 8;
const METER_COUNT = VB + VOICE_METER_STRIDE + 3 + CLASS_COUNT;
const BLOCK64 = METER_COUNT + 21;

// Stimulus, one correctly rounded operation per statement as in the C.
const SIGS = [0, 1, 2, 3, 4].map((s) => Float32Array.from(fillSignal(SIG_N, s)));
SIGS[SIG_DC] = null;
{
  const voice = new Float32Array(SIG_N);
  for (let j = 0; j < SIG_N; j++) {
    const p1 = (j % 53) / 53 - 0.5;
    const p2 = (j % 37) / 37 - 0.5;
    const v1 = p1 * 0.6;
    const v2 = p2 * 0.2;
    const v = v1 + v2;
    voice[j] = j % 6000 < 4000 ? v : 0;
  }
  SIGS[SIG_VOICE] = voice;
  const beat = new Float32Array(SIG_N);
  const noise = SIGS[2];
  for (let j = 0; j < SIG_N; j++) {
    const k = j % 4800;
    const kind = Math.floor(j / 4800) % 3;
    const env = k < 1200 ? (1200 - k) / 1200 : 0;
    const ph = (j % 80) / 40;
    const tri = Math.abs(ph - 1) * 2 - 1;
    const nz = noise[j];
    let v;
    if (kind === 0) v = tri * 0.8;
    else if (kind === 1) v = nz * 0.5;
    else {
      const a = nz * 0.3;
      const b = tri * 0.3;
      v = a + b;
    }
    beat[j] = v * env;
  }
  SIGS[SIG_BEAT] = beat;
}

const SENTINEL = new Map([
  [-3e9, NaN],
  [3e9, Infinity],
  [-4e9, -Infinity],
]);
const unsentinel = (v) => (SENTINEL.has(v) ? SENTINEL.get(v) : v);
const xorshift = (x) => {
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  return (x ^ (x << 5)) >>> 0;
};
const smootherState = (s, out) => out.push(s.value, s.target, s.a);

function replay(ops) {
  const out = [];
  const o32 = [];
  const rng = { seed: TEST_SEED, draws: 0 };
  const random = () => {
    rng.draws++;
    rng.seed = xorshift(rng.seed);
    return rng.seed / 4294967296;
  };
  let e;
  let meters;
  let addMix = UNDEF,
    addByp = UNDEF;
  const init = (sr, mb) => {
    e = new Engine(sr, mb);
    meters = new Array(METER_COUNT).fill(METER_FILL);
    rng.seed = TEST_SEED;
    addMix = UNDEF;
    addByp = UNDEF;
  };
  const blockState = () => {
    e.readMeters(meters);
    for (let k = 0; k < METER_COUNT; k++) out.push(meters[k]);
    smootherState(e.inGain, out);
    smootherState(e.outGain, out);
    smootherState(e.masterMix, out);
    out.push(+e.inMuted, +e.masterBypass, +e.monoInput, +e.inputSwap);
    out.push(e.fileRoute, e.drumRoute, e.blockCount, e.latencySamples);
    out.push(e.peakHoldIn, e.peakHoldOut, e.voice.captureCount, rng.draws);
  };
  const snapState = () => {
    blockState();
    for (const b of [e.dryL, e.dryR, e.chainInL, e.chainInR, e.carrierL, e.carrierR, e.drumL, e.drumR,
      e.tapL, e.tapR, e.loopL, e.loopR, e.voiceBuf])
      for (let k = 0; k < e.maxBlock; k++) o32.push(b[k]);
  };
  const chainOf = (target, index) =>
    target === T_MASTER ? e.chain : target === T_PAD ? e.drums.chainFor(index | 0) : target === T_LOOP ? e.looper.chainFor(index | 0) : null;
  const fxName = (target, index, id, k) => {
    const ch = chainOf(target, index);
    const slot = ch ? ch.find(id) : null;
    const p = slot ? EFFECTS[slot.type]?.params[k] : undefined;
    return p ? p.key : `unknown:${k}`;
  };
  // A chain verb as the app sends it: the master's own verb, or padfx / loopfx.
  const fx = (target, index, op, fields) => {
    if (target === T_MASTER) e.applyCommand({ t: op, ...fields });
    else if (target === T_PAD || target === T_LOOP)
      e.applyCommand({ t: target === T_PAD ? "padfx" : "loopfx", op, index, ...fields });
  };

  const saved = Math.random;
  Math.random = random;
  try {
    init(48000, 128);
    let cursor = 0;
    let gain = 1;
    let dc = 0;
    let pokes = [];
    const sig = (s, at) => (s === SIG_DC ? dc : SIGS[s][at]);
    const L = new Float32Array(MAX_BLOCK);
    const R = new Float32Array(MAX_BLOCK);
    const OL = new Float32Array(MAX_BLOCK);
    const OR = new Float32Array(MAX_BLOCK);
    for (let i = 0; i + OPW <= ops.length; i += OPW) {
      const op = ops[i] | 0;
      const raw = ops.slice(i + 1, i + 6);
      const [a, b, c, d, e5] = [...raw].map(unsentinel);
      if (op === OP.END) break;
      else if (op === OP.INIT) init(a, b | 0);
      else if (op === OP.PROCESS || op === OP.INPLACE) {
        const bs = b | 0;
        const sl = c | 0;
        const sr = d | 0;
        const n = Math.max(bs, 0);
        const vL = L.subarray(0, n);
        const vR = R.subarray(0, n);
        const oL = op === OP.INPLACE ? vL : OL.subarray(0, n);
        const oR = op === OP.INPLACE ? vR : OR.subarray(0, n);
        for (let k = 0; k < (a | 0); k++) {
          for (let j = 0; j < bs; j++) {
            const at = (cursor + j) % SIG_N;
            vL[j] = gain * sig(sl, at);
            vR[j] = gain * (-0.5 * sig(sr, at));
          }
          cursor = (cursor + n) % SIG_N;
          for (const [ch, at, v] of pokes) if (at < bs) (ch ? vR : vL)[at] = v;
          pokes = [];
          e.process(vL, vR, oL, oR, bs);
          blockState();
          for (let j = 0; j < bs; j++) o32.push(oL[j]);
          for (let j = 0; j < bs; j++) o32.push(oR[j]);
        }
      } else if (op === OP.SNAP) snapState();
      else if (op === OP.POKE) {
        if (pokes.length < MAX_POKES) pokes.push([a | 0, b | 0, c]);
      } else if (op === OP.REWIND) cursor = 0;
      else if (op === OP.GAIN) gain = a;
      else if (op === OP.DC) dc = a;
      else if (op === OP.SEED) rng.seed = a >>> 0;
      else if (op === OP.ADDOPT) {
        addMix = raw[0] === UNDEF ? UNDEF : a;
        addByp = raw[1] === UNDEF ? UNDEF : b;
      } else if (op === OP.ADD) {
        const cmd = { id: d | 0, type: TYPES[c | 0] };
        if (addMix !== UNDEF) cmd.mix = addMix;
        if (addByp !== UNDEF) cmd.bypassed = addByp;
        if (a === T_MASTER) {
          if (raw[4] !== UNDEF) cmd.index = e5;
          e.applyCommand({ t: "add", ...cmd });
        } else fx(a, b, "add", cmd);
        addMix = UNDEF;
        addByp = UNDEF;
      } else if (op === OP.REMOVE) fx(a, b, "remove", { id: c | 0 });
      else if (op === OP.MOVE) fx(a, b, "move", a === T_MASTER ? { id: c | 0, index: d | 0 } : { id: c | 0, at: d | 0 });
      else if (op === OP.FXPARAM) fx(a, b, "param", { id: c | 0, key: fxName(a, b, c | 0, d | 0), value: e5 });
      else if (op === OP.MIX) fx(a, b, "mix", { id: c | 0, value: d });
      else if (op === OP.BYPASS) fx(a, b, "bypass", { id: c | 0, value: d });
      else if (op === OP.FXRESET) fx(a, b, "reset", { id: c | 0 });
      else if (op === OP.FXCLEAR) fx(a, b, "clear", {});
      else if (op === OP.IO) {
        const cmd = { t: "io" };
        if (IO_NAME[a] !== undefined) cmd[IO_NAME[a]] = b;
        e.applyCommand(cmd);
      } else if (op === OP.FILELOAD)
        e.applyCommand({ t: "fileload", chL: SIGS[a | 0], chR: SIGS[b | 0], frames: c | 0, rate: d });
      else if (op === OP.FILECLEAR) e.applyCommand({ t: "fileclear" });
      else if (op === OP.FILE) e.applyCommand({ t: "file", key: FILE_KEY[a] ?? `unknown:${a}`, value: b });
      else if (op === OP.FILEROUTE) e.applyCommand({ t: "fileroute", value: a });
      else if (op === OP.PAD) e.applyCommand({ t: "pad", index: a, vel: raw[1] === UNDEF ? undefined : b });
      else if (op === OP.PADOFF) e.applyCommand({ t: "padoff", index: a });
      else if (op === OP.PADPARAM) e.applyCommand({ t: "padparam", index: a, key: PAD_KEY[b] ?? `unknown:${b}`, value: c });
      else if (op === OP.PADLOAD)
        e.applyCommand({ t: "padload", index: a, layer: b, data: SIGS[c | 0], frames: d | 0, rate: e5 });
      else if (op === OP.PADCLEAR) e.applyCommand({ t: "padclear", index: a });
      else if (op === OP.DRUM) e.applyCommand({ t: "drum", key: DRUM_KEY[a] ?? `unknown:${a}`, value: b });
      else if (op === OP.DRUMRESET) e.applyCommand({ t: "drumreset" });
      else if (op === OP.LOOP) e.applyCommand({ t: "loop", op: LOOP_OP[a] ?? `unknown:${a}`, index: b });
      else if (op === OP.LOOPPARAM)
        e.applyCommand({ t: "loopparam", index: a, key: LOOP_KEY[b] ?? `unknown:${b}`, value: c });
      else if (op === OP.LOOPER) e.applyCommand({ t: "looperparam", key: LOOPER_KEY[a] ?? `unknown:${a}`, value: b });
      else if (op === OP.VOICE) e.applyCommand({ t: "voice", key: VOICE_KEY[a] ?? `unknown:${a}`, value: b });
      else if (op === OP.VOICECAL) {
        const name = CAL_OP[a] ?? `unknown:${a}`;
        const cmd = { t: "voicecal", op: name };
        if (name === "centroid") Object.assign(cmd, { cls: b, feature: c, value: d });
        else if (name === "attack") Object.assign(cmd, { cls: b, band: c, value: d });
        else if (name === "pad") Object.assign(cmd, { cls: b, pad: raw[2] === UNDEF ? undefined : c });
        else if (name === "capture") cmd.cls = raw[1] === UNDEF ? undefined : b;
        e.applyCommand(cmd);
      } else if (op === OP.CLOCK) e.applyCommand({ t: "clock", key: CLOCK_KEY[a] ?? `unknown:${a}`, value: b });
      else if (op === OP.CLIPRESET) e.applyCommand({ t: "clipreset" });
      else if (op === OP.PANIC) e.applyCommand({ t: "panic" });
      else if (op === OP.RECALC) out.push(e.recalcLatency());
      else if (op === OP.CAPS) {
        const row = new Float32Array(CAP_STRIDE);
        for (let n = a; n <= b; n++) {
          row.fill(-7);
          out.push(+e.readVoiceCapture(n, row));
          for (let q = 0; q < CAP_STRIDE; q++) o32.push(row[q]);
        }
      }
    }
    snapState();
  } finally {
    Math.random = saved;
  }
  return { out64: Float64Array.from(out), out32: Float32Array.from(o32) };
}

/** Payload lengths predicted from the script alone, independent of either side. */
function expectedLengths(ops) {
  let n64 = 0,
    n32 = 0,
    mb = 128;
  for (let i = 0; i + OPW <= ops.length; i += OPW) {
    const op = ops[i] | 0;
    const a = ops[i + 1],
      b = ops[i + 2];
    if (op === OP.END) break;
    if (op === OP.INIT) mb = b | 0;
    else if (op === OP.PROCESS || op === OP.INPLACE) {
      n64 += (a | 0) * BLOCK64;
      n32 += (a | 0) * 2 * Math.max(b | 0, 0);
    } else if (op === OP.SNAP) {
      n64 += BLOCK64;
      n32 += 13 * mb;
    } else if (op === OP.RECALC) n64 += 1;
    else if (op === OP.CAPS) {
      const n = Math.max(b - a + 1, 0);
      n64 += n;
      n32 += n * CAP_STRIDE;
    }
  }
  return [n64 + BLOCK64, n32 + 13 * mb];
}

const refs = new Map(native.map((r) => [r.name, replay(r.params)]));
const reference = (r) => refs.get(r.name);
const lenBad = native.filter((r) => {
  const [n64, n32] = expectedLengths(r.params);
  return r.out64.length !== n64 || r.out32.length !== n32 || refs.get(r.name).out64.length !== n64 || refs.get(r.name).out32.length !== n32;
});
ok("payload lengths match the script, both sides", lenBad.length === 0, lenBad.map((r) => r.name).join(" "));
ok("56 records", native.length === 56, `${native.length}`);

// Empirical glibc/emscripten/V8 pins measured 2026-10-10 (engine), MSVC
// unmeasured: every record, out64 and out32, signed zeros included. Every
// float32 sample (outputs and all 13 scratch buffers) is identical on all
// three sides; the only drift is in double meter readouts, a few ulp, first at:
//  - native/JS: e_chain, e_all_types, at slot meter 1 (the compressor's
//    gain-reduction dB, which runs log10 / pow per sample: the dynamics
//    battery's known glibc-vs-V8 split).
//  - wasm also: e_chain_at (gate's slot meter), e_voice_mixed (compressor in
//    slot 0) and e_combo (Smart Voice meter 4, lastVel, a dB -> velocity map):
//    emscripten's libm, as in the dynamics and beat-classify batteries.
//    Attributed by the first differing field, not re-evaluated.
const IDENTITY_NATIVE = 54,
  IDENTITY_WASM = 51,
  IDENTITY_CROSS = 51;
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
  const drift = dump.filter((r, i) => {
    const a = other(r, i);
    return !same(a.out64, r.out64) || !same(a.out32, r.out32);
  });
  ok(`${label}: signed-zero identity pinned`, dump.length - drift.length === pin, `${dump.length - drift.length}/${dump.length}; pin ${pin}`);
  if (process.env.LIST_DRIFT) console.log(`${label} drift: ${drift.map((r) => r.name).join(" ")}`);
  if (process.env.LIST_DRIFT === "2")
    dump.forEach((r, i) => {
      const a = other(r, i);
      const k = r.out64.findIndex((v, j) => !Object.is(v, a.out64[j]));
      if (k >= 0) {
        const blk = Math.floor(k / BLOCK64);
        console.log(`  ${r.name} out64[${k}] (block-state ${blk}, field ${k % BLOCK64}) of ${r.out64.length}: ${r.out64[k]} vs ${a.out64[k]}`);
      }
      const k32 = r.out32.findIndex((v, j) => !Object.is(v, a.out32[j]));
      if (k32 >= 0) console.log(`  ${r.name} out32[${k32}] of ${r.out32.length}: ${r.out32[k32]} vs ${a.out32[k32]}`);
    });
}

// The battery's own tables, checked against the C rather than trusted.
const cSrc = readFileSync(join(root, "packages/native/tests/parity-engine.c"), "utf8");
const hSrc = readFileSync(join(root, "packages/native/include/brokodr/dsp/engine.h"), "utf8");
for (const [key, val] of Object.entries(OP)) {
  const m = cSrc.match(new RegExp(`OP_${key}\\s*=\\s*(\\d+)`));
  ok(`opcode ${key} mirrors C`, m !== null && Number(m[1]) === val);
}
for (const [key, val] of [
  ["OPW", OPW],
  ["SIG_N", SIG_N],
  ["SIG_DC", SIG_DC],
  ["SIG_VOICE", SIG_VOICE],
  ["SIG_BEAT", SIG_BEAT],
  ["MAX_BLOCK", MAX_BLOCK],
  ["MAX_POKES", MAX_POKES],
]) {
  const m = cSrc.match(new RegExp(`#define ${key} (\\d+)`));
  ok(`${key} mirrors C`, m !== null && Number(m[1]) === val);
}
for (const [n, v] of [
  ["NAN_", -3e9],
  ["INF_", 3e9],
  ["NINF_", -4e9],
  ["UNDEF_", -5e9],
  ["METER_FILL", -7],
]) {
  const m = cSrc.match(new RegExp(`#define ${n} \\((-?[\\d.e]+)\\)`));
  ok(`constant ${n} mirrors C`, m !== null && Number(m[1]) === v);
}
ok("TEST_SEED mirrors C", cSrc.includes(`g_seed = 0x${TEST_SEED.toString(16)}u;`));
for (const [n, v] of [
  ["BK_TARGET_MASTER", T_MASTER],
  ["BK_TARGET_PAD", T_PAD],
  ["BK_TARGET_LOOP", T_LOOP],
  ["BK_ENGINE_SLOT_METERS", 16],
  ["BK_ENGINE_FILE_METERS", 40],
  ["BK_ENGINE_PAD_METERS", 48],
  ["BK_ENGINE_LOOP_METERS", 68],
  ...IO_NAME.map((_, k) => [["BK_IO_IN_GAIN", "BK_IO_OUT_GAIN", "BK_IO_MUTE", "BK_IO_BYPASS", "BK_IO_MONO", "BK_IO_SWAP", "BK_IO_MASTER_MIX"][k], k]),
  ...Object.entries(LOOP_OP).map(([k, v]) => [`BK_LOOPOP_${v.toUpperCase()}`, Number(k)]),
  ...CAL_OP.map((v, k) => [`BK_VOICECAL_${v.toUpperCase()}`, k]),
]) {
  const m = hSrc.match(new RegExp(`#define ${n} (\\d+)|${n} = (\\d+)`));
  ok(`${n} mirrors C`, m !== null && Number(m[1] ?? m[2]) === v);
}
// IO and LOOP numbering against the worklet's own tables.
const wSrc = readFileSync(join(root, "packages/web/public/dsp/worklet-processor.js"), "utf8");
ok(
  "IO names follow the worklet's IO_FIELD",
  ["IN_GAIN", "OUT_GAIN", "MUTE", "BYPASS", "MONO", "SWAP", "MASTER_MIX"].every((f, k) =>
    new RegExp(`f === IO_FIELD\\.${f}\\) e\\.applyCommand\\(\\{ t: "io", ${IO_NAME[k]}:`).test(wSrc) &&
    backend.IO_FIELD[f] === k,
  ),
);
ok(
  "FILE_KEY mirrors the worklet",
  wSrc.includes(`const FILE_KEY = [${FILE_KEY.map((k) => `"${k}"`).join(", ")}];`),
);
ok(
  "loop ops follow LOOP_FIELD",
  Object.entries(LOOP_OP).every(([k, v]) => new RegExp(`${v.toUpperCase()}: ${k}\\b`).test(wSrc)),
);
ok("meter count mirrors C", (() => {
  const m = hSrc.match(/#define BK_ENGINE_METER_COUNT \(BK_ENGINE_VOICE_METERS \+ BK_VOICE_METER_STRIDE \+ 3 \+ BK_VOICE_CLASS_COUNT\)/);
  return m !== null && /#define BK_ENGINE_VOICE_METERS \(BK_ENGINE_CLOCK_METERS \+ 8\)/.test(hSrc);
})());
ok("C payload overflow stops rather than truncating", /payload overflow[\s\S]{0,40}exit\(3\)/.test(cSrc));
ok(
  "C canaries checked after init and every block",
  cSrc.includes("write past the engine struct") &&
    cSrc.includes("write past the engine storage") &&
    (cSrc.match(/check_canary\(\);/g) || []).length === 2,
);
ok(
  "C input stimulus matches JS mirror",
  cSrc.includes("g_l[j] = (float)(g_gain * sig_at(sl, at));") &&
    cSrc.includes("g_r[j] = (float)(g_gain * (-0.5 * sig_at(sr, at)));") &&
    cSrc.includes("g_cursor = (g_cursor + (bs > 0 ? bs : 0)) % SIG_N;"),
);
ok(
  "C beat stimulus matches JS mirror",
  cSrc.includes("const double env = k < 1200 ? (double)(1200 - k) / 1200.0 : 0.0;") &&
    cSrc.includes("const double ph = (double)(j % 80) / 40.0;") &&
    cSrc.includes("const double tri = fabs(ph - 1.0) * 2.0 - 1.0;") &&
    cSrc.includes("dst[j] = (float)(v * env);") &&
    cSrc.includes("fill_beat(g_sig[SIG_BEAT], g_sig[BK_SIG_NOISE]);"),
);
ok(
  "C xorshift matches JS mirror",
  cSrc.includes("x ^= x << 13;") && cSrc.includes("x ^= x >> 17;") && cSrc.includes("x ^= x << 5;") &&
    cSrc.includes("return (double)x / 4294967296.0;"),
);
ok("every effect gets the battery random source", cSrc.includes("bk_effect_set_random(type, mem, test_random, &g_seed);"));
ok("registry type order is EFFECT_CLASSES order", (() => {
  const reg = readFileSync(join(root, "packages/native/include/brokodr/dsp/effect-registry.h"), "utf8");
  return TYPES.every((t, k) => new RegExp(`BK_FX_${t.toUpperCase()} = ${k}\\b`).test(reg));
})());
// The randomness wiring is live: e_random draws, and both sides count the same.
ok("e_random draws", (() => {
  const r = native.find((x) => x.name === "e_random");
  const d = r ? r.out64[r.out64.length - 1] : 0;
  return d > 0 && refs.get("e_random").out64.at(-1) === d;
})(), `${native.find((x) => x.name === "e_random")?.out64.at(-1)} draws`);
// Every float32 sample is pinned bit-exact on all sides (outputs and scratch).
for (const [label, dump] of [["native", native], ...(wasm ? [["wasm", wasm]] : [])]) {
  const bad = dump.filter((r) => !same(refs.get(r.name).out32, r.out32)).map((r) => r.name);
  ok(`${label}: every float32 sample identical to the JS`, bad.length === 0, bad.join(" "));
}

console.log(`\n${state.checks} checks, ${state.failures} failed — ${state.failures ? "FAIL" : "PASS"}`);
process.exit(state.failures ? 1 : 0);
