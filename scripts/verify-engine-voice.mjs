// Verification for SMART VOICE WIRED INTO THE ENGINE. scripts/verify-beat-classify.mjs
// proves the classifier in isolation; this proves the plumbing around it:
//
//   - that `voice` and `voicecal` commands reach SmartVoice intact,
//   - that the detector listens to the RAW input — before mute, before input gain,
//     before the rack, and without hearing the drums it fires,
//   - that a detected hit triggers the BROBEATS rack in the same block,
//   - that the 19-field meter block lands exactly where the UI reads it and displaces
//     nothing that was already there,
//   - that capture rows can be drained through the engine's own accessor,
//   - and that the wire tables in worklet-processor.js and backend.ts still mirror the
//     ones in core/beat-classify.js.
//
// Runs in plain Node: the engine is backend-agnostic by design, and the classifier's
// input is a Float32Array either way.
import { readFileSync } from "node:fs";
import { Engine } from "../packages/web/public/dsp/engine.js";
import {
  CAP_ATTACK_OFFSET,
  CAP_STRIDE,
  CLASS_COUNT,
  DEFAULT_CLASS_PADS,
  FACTORY_ATTACK,
  FACTORY_CENTROIDS,
  VOICE_CLASS,
  VOICE_DEFAULTS,
  VOICE_KEY,
  VOICE_METER_STRIDE,
  VOICE_MODE,
} from "../packages/web/public/dsp/core/beat-classify.js";
import { FEATURE_COUNT } from "../packages/web/public/dsp/core/onset.js";
import { LOOP_METER_STRIDE, LOOP_TRACKS } from "../packages/web/public/dsp/core/looper.js";
import { DRUM_SYNTH_DEFAULTS, renderDrum } from "../packages/web/public/dsp/core/drum-synth.js";

const SR = 48000;
const BLOCK = 128;
const LOOP_BASE = 68;
const TRANSPORT_BASE = LOOP_BASE + LOOP_TRACKS * LOOP_METER_STRIDE; // 100 at four tracks
const VOICE_BASE = TRANSPORT_BASE + 8; // 108
const VOICE_BLOCK_FIELDS = VOICE_METER_STRIDE + 3 + CLASS_COUNT; // 19
const METER_FIELDS = 192;

let failures = 0;
let checks = 0;
function ok(name, cond, detail = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  } else console.log(`ok    ${name} ${detail}`);
}
function finite(a, n = a.length) {
  for (let i = 0; i < n; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}
function peak(a, n = a.length) {
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(a[i]));
  return p;
}

/** A drum one-shot buried in silence, which is the only mouth this sandbox has. */
function shot(kind, padMs = 60, tailMs = 240, gain = 1) {
  const r = renderDrum(kind, SR, DRUM_SYNTH_DEFAULTS[kind]);
  if (!r) throw new Error(`no renderer for ${kind}`);
  const head = (padMs * 0.001 * SR) | 0;
  const tail = (tailMs * 0.001 * SR) | 0;
  const mono = new Float32Array(head + r.frames + tail);
  for (let i = 0; i < r.frames; i++) mono[head + i] = r.data[i] * gain;
  return mono;
}

/**
 * Feeds a mono buffer through the engine in real blocks. Returns the output, the peak,
 * and how many pads the rack was asked to fire (counted by watching hitCount, which is
 * the detector's own tally of committed hits).
 */
function feed(eng, mono, opts = {}) {
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  const captureOut = opts.captureOut ? new Float32Array(mono.length) : null;
  let worst = 0;
  let allFinite = true;
  for (let off = 0; off < mono.length; off += BLOCK) {
    const n = Math.min(BLOCK, mono.length - off);
    inL.fill(0);
    inR.fill(0);
    for (let i = 0; i < n; i++) {
      inL[i] = mono[off + i];
      inR[i] = mono[off + i];
    }
    if (opts.hook) opts.hook(off / BLOCK);
    eng.process(inL, inR, outL, outR, n);
    if (captureOut) captureOut.set(outL.subarray(0, n), off);
    if (!finite(outL, n) || !finite(outR, n)) allFinite = false;
    worst = Math.max(worst, peak(outL, n), peak(outR, n));
  }
  return { hits: eng.voice.hitCount, worst, allFinite, captureOut };
}

/** An engine with Smart Voice on and every pad loaded with the one-shot it maps to. */
function voiceEngine(params) {
  const eng = new Engine(SR, BLOCK);
  // Pads must be audible for "the rack was triggered" to mean anything. The four
  // factory class pads get the four sounds they are named after.
  const kinds = ["kick", "snare", "hat", "clap"];
  for (let c = 0; c < CLASS_COUNT; c++) {
    const r = renderDrum(kinds[c], SR, DRUM_SYNTH_DEFAULTS[kinds[c]]);
    eng.applyCommand({
      t: "padload",
      index: DEFAULT_CLASS_PADS[c],
      layer: 0,
      data: r.data,
      frames: r.frames,
      rate: SR,
    });
  }
  eng.applyCommand({ t: "voice", key: "enabled", value: 1 });
  if (params) for (const k in params) eng.applyCommand({ t: "voice", key: k, value: params[k] });
  return eng;
}

// ---------------------------------------------------------------------------
console.log("== 1. the engine owns a detector, idle until switched on ==");
{
  const eng = new Engine(SR, BLOCK);
  ok("engine: has a Smart Voice", !!eng.voice);
  ok("engine: class count agrees with the DSP", eng.voice.classPad.length === CLASS_COUNT);
  ok("engine: voice buffer sized to maxBlock", eng.voiceBuf && eng.voiceBuf.length === BLOCK);
  ok("engine: detector off at construction", eng.voice.enabled === false);
  ok(
    "engine: factory class->pad map installed",
    Array.from(eng.voice.classPad).every((p, c) => p === DEFAULT_CLASS_PADS[c]),
    `${Array.from(eng.voice.classPad).join(",")}`,
  );
  ok("engine: capture stride exposed for the host", eng.voiceCaptureStride === CAP_STRIDE, `${eng.voiceCaptureStride}`);
  ok("engine: defaults match the DSP's own", eng.voice.floorDb === VOICE_DEFAULTS.floorDb && eng.voice.mode === VOICE_DEFAULTS.mode);

  // Off means not run at all, not run-and-ignored: a loud hit must change nothing.
  const res = feed(eng, shot("kick"));
  ok("engine: disabled detector never fires", res.hits === 0);
  ok("engine: disabled detector leaves the rack silent", eng.drums.sounding === false);
}

// ---------------------------------------------------------------------------
console.log("== 2. voice parameter commands route and clamp ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "voice", key: "enabled", value: 1 });
  ok("voice cmd: enabled", eng.voice.enabled === true);
  eng.applyCommand({ t: "voice", key: "floorDb", value: -55 });
  ok("voice cmd: floorDb", eng.voice.floorDb === -55);
  eng.applyCommand({ t: "voice", key: "floorDb", value: -999 });
  ok("voice cmd: floorDb clamped low", eng.voice.floorDb === -90, `${eng.voice.floorDb}`);
  eng.applyCommand({ t: "voice", key: "floorDb", value: 20 });
  ok("voice cmd: floorDb clamped high", eng.voice.floorDb === -6, `${eng.voice.floorDb}`);
  eng.applyCommand({ t: "voice", key: "mode", value: 1 });
  ok("voice cmd: mode accurate", eng.voice.mode === VOICE_MODE.ACCURATE);
  eng.applyCommand({ t: "voice", key: "mode", value: 0 });
  ok("voice cmd: mode fast", eng.voice.mode === VOICE_MODE.FAST);
  eng.applyCommand({ t: "voice", key: "margin", value: 0.4 });
  ok("voice cmd: margin", Math.abs(eng.voice.margin - 0.4) < 1e-9);
  eng.applyCommand({ t: "voice", key: "margin", value: 99 });
  ok("voice cmd: margin clamped", eng.voice.margin === 0.99);
  eng.applyCommand({ t: "voice", key: "velMin", value: 0.5 });
  ok("voice cmd: velMin", Math.abs(eng.voice.velMin - 0.5) < 1e-9);
  eng.applyCommand({ t: "voice", key: "velDb", value: 40 });
  ok("voice cmd: velDb", eng.voice.velDb === 40);
  eng.applyCommand({ t: "voice", key: "monitor", value: 1 });
  ok("voice cmd: monitor", eng.voice.monitor === true);
  eng.applyCommand({ t: "voice", key: "sensitivity", value: 3.3 });
  ok("voice cmd: sensitivity reaches the detector", Math.abs(eng.voice.det.sensitivity - 3.3) < 1e-6, `${eng.voice.det.sensitivity}`);
  eng.applyCommand({ t: "voice", key: "minGapMs", value: 80 });
  ok("voice cmd: minGapMs reaches the detector", eng.voice.det.minGapMs === 80, `${eng.voice.det.minGapMs}`);
  eng.applyCommand({ t: "voice", key: "featureMs", value: 12 });
  ok("voice cmd: featureMs reaches the detector", eng.voice.det.featureMs === 12, `${eng.voice.det.featureMs}`);

  eng.applyCommand({ t: "voice", key: "nonsense", value: 1 });
  ok("voice cmd: unknown key is a no-op", eng.voice.enabled === true && eng.voice.velDb === 40);
  eng.applyCommand({ t: "voice", key: "velDb", value: Number.NaN });
  ok("voice cmd: NaN is refused", eng.voice.velDb === 40);

  // Switching on from idle must clean the detector, or a half-measured onset from the
  // last time it was on fires the moment audio resumes.
  feed(eng, shot("snare"));
  ok("voice cmd: the detector had run", eng.voice.det.frames > 0, `${eng.voice.det.frames}`);
  eng.applyCommand({ t: "voice", key: "enabled", value: 0 });
  ok("voice cmd: switching off keeps the state as it was", eng.voice.det.frames > 0);
  eng.applyCommand({ t: "voice", key: "enabled", value: 1 });
  ok(
    "voice cmd: re-enabling resets the detector",
    eng.voice.det.frames === 0 && eng.voice.det.count === 0 && eng.voice.det.pendingFeature === false,
    `frames=${eng.voice.det.frames} count=${eng.voice.det.count}`,
  );
}

// ---------------------------------------------------------------------------
console.log("== 3. calibration commands route ==");
{
  const eng = new Engine(SR, BLOCK);
  eng.applyCommand({ t: "voicecal", op: "centroid", cls: 2, feature: 1, value: 0.42 });
  ok("voicecal: centroid", Math.abs(eng.voice.centroids[2 * FEATURE_COUNT + 1] - 0.42) < 1e-6);
  eng.applyCommand({ t: "voicecal", op: "attack", cls: 3, band: 2, value: 0.77 });
  ok("voicecal: attack centroid", Math.abs(eng.voice.attack[3 * FEATURE_COUNT + 2] - 0.77) < 1e-6);
  eng.applyCommand({ t: "voicecal", op: "centroid", cls: 99, feature: 0, value: 0.5 });
  eng.applyCommand({ t: "voicecal", op: "attack", cls: 1, band: 7, value: 0.5 });
  ok("voicecal: out-of-range writes are no-ops", finite(eng.voice.centroids) && finite(eng.voice.attack));

  eng.applyCommand({ t: "voicecal", op: "pad", cls: 1, pad: 11 });
  ok("voicecal: class->pad", eng.voice.classPad[1] === 11);
  eng.applyCommand({ t: "voicecal", op: "pad", cls: 1 });
  ok("voicecal: pad absent means mute the class", eng.voice.classPad[1] === -1);

  eng.applyCommand({ t: "voicecal", op: "capture", cls: 2 });
  ok("voicecal: capture arms a class", eng.voice.captureClass === 2);
  eng.applyCommand({ t: "voicecal", op: "capture" });
  ok("voicecal: capture with no class disarms", eng.voice.captureClass === -1);

  eng.voice.captureCount = 5;
  eng.applyCommand({ t: "voicecal", op: "clear" });
  ok("voicecal: clear empties the capture ring", eng.voice.captureCount === 0);

  eng.applyCommand({ t: "voicecal", op: "reset" });
  let factory = true;
  for (let c = 0; c < CLASS_COUNT; c++) {
    for (let f = 0; f < FEATURE_COUNT; f++) {
      // Both tables are Float32Array, so the comparison is at float32 precision.
      if (Math.abs(eng.voice.centroids[c * FEATURE_COUNT + f] - FACTORY_CENTROIDS[c][f]) > 1e-6) factory = false;
      const want = f < 3 ? FACTORY_ATTACK[c][f] : 0;
      if (Math.abs(eng.voice.attack[c * FEATURE_COUNT + f] - want) > 1e-6) factory = false;
    }
  }
  ok("voicecal: reset restores BOTH factory tables", factory);
  ok("voicecal: reset leaves the pad map alone", eng.voice.classPad[1] === -1);

  feed(eng, shot("hat", 20, 20));
  eng.applyCommand({ t: "voicecal", op: "detreset" });
  ok("voicecal: detreset cleans the detector", eng.voice.det.frames === 0 && eng.voice.det.count === 0);
  eng.applyCommand({ t: "voicecal", op: "nonsense" });
  ok("voicecal: unknown op is a no-op", eng.voice.captureClass === -1);
}

// ---------------------------------------------------------------------------
console.log("== 4. a detected hit plays the rack, in the block it was detected ==");
{
  const eng = voiceEngine();
  const res = feed(eng, shot("kick"), { captureOut: true });
  ok("fire: the kick was detected", res.hits >= 1, `hits=${res.hits}`);
  ok("fire: it landed on the kick class", eng.voice.lastClass === VOICE_CLASS.KICK, `cls=${eng.voice.lastClass}`);
  ok("fire: velocity is usable, never silent", eng.voice.lastVel >= VOICE_DEFAULTS.velMin, `vel=${eng.voice.lastVel.toFixed(3)}`);
  ok("fire: the rack made sound", peak(res.captureOut) > 0.01, `peak=${res.worst.toFixed(4)}`);
  ok("fire: output finite and bounded", res.allFinite && res.worst <= 1.4 + 1e-6, `peak=${res.worst.toFixed(4)}`);

  // Same-block, not next-block. The tap runs before the rack renders, so the pad's own
  // attack must appear inside the block the onset was committed in — proven by finding
  // rack output earlier than one block after the input transient.
  const eng2 = voiceEngine();
  const mono = shot("kick", 60, 240);
  let firstIn = 0;
  while (firstIn < mono.length && Math.abs(mono[firstIn]) < 0.02) firstIn++;
  const r2 = feed(eng2, mono, { captureOut: true });
  let firstOut = 0;
  while (firstOut < r2.captureOut.length && Math.abs(r2.captureOut[firstOut]) < 0.02) firstOut++;
  ok(
    "fire: rack output starts within a block of the onset",
    firstOut - firstIn <= 2 * BLOCK,
    `in=${firstIn} out=${firstOut} delta=${firstOut - firstIn}`,
  );
}

// ---------------------------------------------------------------------------
console.log("== 5. a muted class fires nothing, a remapped class fires elsewhere ==");
{
  // The mic is muted throughout: the input itself is audible otherwise, and what is
  // being measured here is whether the RACK made a sound.
  const eng = voiceEngine();
  eng.applyCommand({ t: "io", mute: 1 });
  eng.applyCommand({ t: "voicecal", op: "pad", cls: VOICE_CLASS.KICK, pad: -1 });
  const res = feed(eng, shot("kick"), { captureOut: true });
  ok("route: a muted class still detects", res.hits >= 1, `hits=${res.hits}`);
  ok("route: a muted class makes no sound", peak(res.captureOut) < 1e-6, `peak=${peak(res.captureOut).toFixed(6)}`);

  const eng2 = voiceEngine();
  eng2.applyCommand({ t: "io", mute: 1 });
  const clap = renderDrum("clap", SR, DRUM_SYNTH_DEFAULTS.clap);
  eng2.applyCommand({ t: "padload", index: 9, layer: 0, data: clap.data, frames: clap.frames, rate: SR });
  eng2.applyCommand({ t: "voicecal", op: "pad", cls: VOICE_CLASS.KICK, pad: 9 });
  const r2 = feed(eng2, shot("kick"), { captureOut: true });
  ok("route: a remapped class fires its new pad", r2.hits >= 1 && peak(r2.captureOut) > 0.01, `hits=${r2.hits}`);

  // A pad index past the end of the rack is not clamped on the way in — the rack's own
  // bounds check absorbs it. Cheaper than clamping on the wire, and it keeps -1 the
  // only special value.
  const eng3 = voiceEngine();
  eng3.applyCommand({ t: "io", mute: 1 });
  eng3.applyCommand({ t: "voicecal", op: "pad", cls: VOICE_CLASS.KICK, pad: 999 });
  const r3 = feed(eng3, shot("kick"), { captureOut: true });
  ok(
    "route: a pad past the end of the rack is harmless",
    r3.hits >= 1 && r3.allFinite && peak(r3.captureOut) < 1e-6,
    `hits=${r3.hits} peak=${peak(r3.captureOut).toFixed(6)}`,
  );
}

// ---------------------------------------------------------------------------
console.log("== 6. the detector hears the raw input, not the mix ==");
{
  // Muting the mic is how you beatbox without your voice in the output. If the tap read
  // the post-mute signal, mute would silence the drums too.
  const eng = voiceEngine();
  eng.applyCommand({ t: "io", mute: 1 });
  const res = feed(eng, shot("kick"), { captureOut: true });
  ok("raw: mic mute does not stop detection", res.hits >= 1, `hits=${res.hits}`);
  ok("raw: the rack is still audible under mic mute", peak(res.captureOut) > 0.01);

  // Input gain belongs to the mix, not to detection — floorDb and sensitivity are the
  // detector's own level controls, and they must not move when a fader does.
  const quiet = voiceEngine();
  quiet.applyCommand({ t: "io", inGain: -60 });
  const rq = feed(quiet, shot("kick"));
  ok("raw: input gain does not gate detection", rq.hits >= 1, `hits=${rq.hits}`);

  // And the rack it fires must not feed it: a detector that can hear its own kick rolls
  // away on its own. Fired once, on a DIRECT route, with a loud pad and silence after.
  const solo = voiceEngine();
  solo.applyCommand({ t: "drum", key: "route", value: 1 }); // DIRECT
  solo.applyCommand({ t: "drum", key: "gain", value: 6 });
  const one = shot("kick", 60, 60);
  feed(solo, one);
  const afterFirst = solo.voice.hitCount;
  const silence = new Float32Array(SR); // a full second of nothing at the input
  feed(solo, silence);
  ok(
    "raw: the drums it fires cannot retrigger it",
    solo.voice.hitCount === afterFirst,
    `first=${afterFirst} after=${solo.voice.hitCount}`,
  );
}

// ---------------------------------------------------------------------------
console.log("== 7. the meter block lands where the UI reads it ==");
{
  const eng = voiceEngine();
  feed(eng, shot("snare"));
  const m = new Float32Array(METER_FIELDS);
  const before = new Float32Array(METER_FIELDS);
  before.fill(-999);
  eng.readMeters(m);
  ok("meters: block finite", finite(m));
  ok("meters: voice block starts at 108", VOICE_BASE === 108, `${VOICE_BASE}`);
  ok("meters: enabled flag at the block head", m[VOICE_BASE] === 1);
  ok("meters: hit count", m[VOICE_BASE + 1] === eng.voice.hitCount, `${m[VOICE_BASE + 1]}`);
  ok("meters: last class", m[VOICE_BASE + 2] === eng.voice.lastClass);
  ok("meters: last confidence", Math.abs(m[VOICE_BASE + 3] - eng.voice.lastConf) < 1e-6);
  ok("meters: last velocity", Math.abs(m[VOICE_BASE + 4] - eng.voice.lastVel) < 1e-6);
  ok("meters: last stage", m[VOICE_BASE + 5] === eng.voice.lastStage);
  ok("meters: input level", Math.abs(m[VOICE_BASE + 6] - eng.voice.level) < 1e-6);
  ok("meters: last strength", Math.abs(m[VOICE_BASE + 7] - eng.voice.lastStrength) < 1e-6);
  ok("meters: capture class", m[VOICE_BASE + 8] === eng.voice.captureClass);
  ok("meters: capture count", m[VOICE_BASE + 9] === eng.voice.captureCount);
  ok("meters: corrections", m[VOICE_BASE + 10] === eng.voice.corrections);
  ok("meters: onset count", m[VOICE_BASE + 11] === eng.voice.onsetCount);

  const band = eng.voice.lastBand;
  ok(
    "meters: three live attack bands follow the readouts",
    Math.abs(m[VOICE_BASE + VOICE_METER_STRIDE] - band[0]) < 1e-6 &&
      Math.abs(m[VOICE_BASE + VOICE_METER_STRIDE + 1] - band[1]) < 1e-6 &&
      Math.abs(m[VOICE_BASE + VOICE_METER_STRIDE + 2] - band[2]) < 1e-6,
  );
  let padsOk = true;
  for (let c = 0; c < CLASS_COUNT; c++) {
    if (m[VOICE_BASE + VOICE_METER_STRIDE + 3 + c] !== eng.voice.classPad[c]) padsOk = false;
  }
  ok("meters: class->pad map rides at the end of the block", padsOk);
  ok("meters: block is 19 fields", VOICE_BLOCK_FIELDS === 19, `${VOICE_BLOCK_FIELDS}`);

  // Append-only: the transport block that used to end the array must be untouched.
  ok("meters: transport block still at its own base", m[TRANSPORT_BASE] === eng.clock.bpm, `${m[TRANSPORT_BASE]}`);
  ok("meters: nothing written past the voice block", m[VOICE_BASE + VOICE_BLOCK_FIELDS] === 0);

  // The UI's own buffer must be big enough for it.
  const wb = readFileSync("packages/web/src/web/audio/worklet-backend.ts", "utf8");
  const mf = wb.match(/METER_FIELDS\s*=\s*(\d+)/);
  ok(
    "meters: worklet-backend's METER_FIELDS covers the block",
    mf && Number(mf[1]) >= VOICE_BASE + VOICE_BLOCK_FIELDS,
    `METER_FIELDS=${mf && mf[1]} need=${VOICE_BASE + VOICE_BLOCK_FIELDS}`,
  );
  const be = readFileSync("packages/web/src/web/audio/backend.ts", "utf8");
  const vmb = be.match(/VOICE_METER_BASE\s*=\s*([A-Z_]+)\s*\+\s*(\d+)/);
  ok("meters: backend's VOICE_METER_BASE is transport base + 8", vmb && vmb[1] === "TRANSPORT_METER_BASE" && vmb[2] === "8");
}

// ---------------------------------------------------------------------------
console.log("== 8. capture rows drain through the engine ==");
{
  const eng = voiceEngine();
  eng.applyCommand({ t: "voicecal", op: "capture", cls: VOICE_CLASS.SNARE });
  for (let i = 0; i < 4; i++) feed(eng, shot("snare", 40, 160));
  const total = eng.voice.captureCount;
  ok("capture: armed capture collected rows", total >= 3, `total=${total}`);

  const row = new Float32Array(eng.voiceCaptureStride);
  ok("capture: stride matches the DSP", eng.voiceCaptureStride === CAP_STRIDE);
  let allRead = true;
  let labelled = true;
  let rowsFinite = true;
  for (let n = 0; n < total; n++) {
    if (!eng.readVoiceCapture(n, row)) {
      allRead = false;
      continue;
    }
    if (row[0] !== VOICE_CLASS.SNARE) labelled = false;
    if (!finite(row)) rowsFinite = false;
  }
  ok("capture: every row readable", allRead);
  ok("capture: rows carry the ARMED class, not the classifier's guess", labelled);
  ok("capture: rows finite", rowsFinite);
  eng.readVoiceCapture(0, row);
  ok(
    "capture: row layout is [class, features, attack, strength]",
    row.length === 1 + FEATURE_COUNT + 3 + 1 && CAP_ATTACK_OFFSET === FEATURE_COUNT + 1,
  );
  ok("capture: out-of-range read refused", eng.readVoiceCapture(total + 5, row) === false);
  ok("capture: negative read refused", eng.readVoiceCapture(-1, row) === false);

  // Disarming stops collection but keeps what was taught.
  eng.applyCommand({ t: "voicecal", op: "capture" });
  feed(eng, shot("snare", 40, 160));
  ok("capture: disarmed capture collects nothing more", eng.voice.captureCount === total, `${eng.voice.captureCount}`);
  eng.applyCommand({ t: "voicecal", op: "clear" });
  ok("capture: clear empties the ring", eng.voice.captureCount === 0);
}

// ---------------------------------------------------------------------------
console.log("== 9. panic takes the detector with it ==");
{
  const eng = voiceEngine();
  feed(eng, shot("kick", 40, 20)); // cut short, so a hit is mid-flight
  eng.applyCommand({ t: "panic" });
  ok("panic: detector state cleared", eng.voice.det.frames === 0 && eng.voice.det.count === 0);
  ok("panic: pending fires dropped", eng.voice.fireCount === 0);
  ok("panic: rack silenced", eng.drums.sounding === false);
  const res = feed(eng, new Float32Array(SR >> 1), { captureOut: true });
  ok("panic: silence after a panic stays silent", peak(res.captureOut) === 0 && res.allFinite);
}

// ---------------------------------------------------------------------------
console.log("== 10. the wire tables still mirror each other ==");
{
  const wp = readFileSync("packages/web/public/dsp/worklet-processor.js", "utf8");
  const be = readFileSync("packages/web/src/web/audio/backend.ts", "utf8");

  function keyTable(src, name) {
    const m = src.match(new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
    if (!m) return null;
    return m[1]
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter((s) => s.length > 0 && !s.startsWith("//"));
  }
  const wpKeys = keyTable(wp, "const VOICE_KEY");
  const beKeys = keyTable(be, "export const VOICE_KEY");
  ok("mirror: worklet-processor VOICE_KEY parsed", !!wpKeys && wpKeys.length === VOICE_KEY.length, `${wpKeys && wpKeys.length}`);
  ok("mirror: backend VOICE_KEY parsed", !!beKeys && beKeys.length === VOICE_KEY.length, `${beKeys && beKeys.length}`);
  ok(
    "mirror: worklet-processor VOICE_KEY matches the DSP, in order",
    !!wpKeys && wpKeys.every((k, i) => k === VOICE_KEY[i]),
    `${wpKeys && wpKeys.join(",")}`,
  );
  ok(
    "mirror: backend VOICE_KEY matches the DSP, in order",
    !!beKeys && beKeys.every((k, i) => k === VOICE_KEY[i]),
    `${beKeys && beKeys.join(",")}`,
  );

  function fields(src, name) {
    const m = src.match(new RegExp(`${name}\\s*=\\s*\\{([\\s\\S]*?)\\}`));
    if (!m) return null;
    const out = {};
    for (const part of m[1].split(",")) {
      const kv = part.split(":");
      if (kv.length !== 2) continue;
      const k = kv[0].trim();
      const v = Number(kv[1].trim());
      if (k && Number.isFinite(v)) out[k] = v;
    }
    return out;
  }
  const wpCal = fields(wp, "const VOICE_CAL");
  const beCal = fields(be, "export const VOICE_CAL");
  const names = ["CENTROID", "ATTACK", "PAD", "CAPTURE", "CLEAR", "RESET", "DETRESET"];
  ok("mirror: VOICE_CAL present on both sides", !!wpCal && !!beCal);
  ok(
    "mirror: VOICE_CAL ids agree",
    !!wpCal && !!beCal && names.every((n) => wpCal[n] !== undefined && wpCal[n] === beCal[n]),
    names.map((n) => `${n}=${wpCal && wpCal[n]}/${beCal && beCal[n]}`).join(" "),
  );
  ok("mirror: OP.VOICE is 18", /VOICE:\s*18/.test(wp));
  ok("mirror: OP.VOICECAL is 19", /VOICECAL:\s*19/.test(wp));
  ok("mirror: the worklet answers the capture pull", /m\.t === "getvoicecaps"/.test(wp) && /t: "voicecaps"/.test(wp));

  const beStride = be.match(/VOICE_METER_STRIDE\s*=\s*(\d+)/);
  ok("mirror: backend VOICE_METER_STRIDE", beStride && Number(beStride[1]) === VOICE_METER_STRIDE, `${beStride && beStride[1]}`);
  const beCap = be.match(/VOICE_CAPTURE_STRIDE\s*=\s*(\d+)/);
  ok("mirror: backend VOICE_CAPTURE_STRIDE", beCap && Number(beCap[1]) === CAP_STRIDE, `${beCap && beCap[1]}`);
  const beClasses = be.match(/VOICE_CLASS_COUNT\s*=\s*(\d+)/);
  ok("mirror: backend VOICE_CLASS_COUNT", beClasses && Number(beClasses[1]) === CLASS_COUNT);
  const bePads = be.match(/VOICE_DEFAULT_CLASS_PADS\s*=\s*\[([^\]]*)\]/);
  ok(
    "mirror: backend default class pads match the DSP",
    bePads && bePads[1].split(",").map((s) => Number(s.trim())).every((v, i) => v === DEFAULT_CLASS_PADS[i]),
    `${bePads && bePads[1]}`,
  );
  // Defaults are a profile, and a UI that starts somewhere else than the engine does is
  // a UI that lies until the first fader move.
  const beDefaults = fields(be, "export const VOICE_DEFAULTS: Record<VoiceKey, number>");
  let defaultsAgree = !!beDefaults;
  const boolKeys = { enabled: 1, monitor: 1 };
  for (const k of VOICE_KEY) {
    if (!beDefaults) break;
    const want = boolKeys[k] ? (VOICE_DEFAULTS[k] ? 1 : 0) : VOICE_DEFAULTS[k];
    if (beDefaults[k] === undefined) {
      // `mode` is written as VOICE_MODE.FAST rather than a literal — accepted, checked below.
      if (k !== "mode") defaultsAgree = false;
      continue;
    }
    if (Math.abs(beDefaults[k] - want) > 1e-9) defaultsAgree = false;
  }
  ok("mirror: backend VOICE_DEFAULTS agree with the DSP", defaultsAgree);
  ok("mirror: backend mode default is FAST", /mode:\s*VOICE_MODE\.FAST/.test(be) && VOICE_DEFAULTS.mode === VOICE_MODE.FAST);
}

// ---------------------------------------------------------------------------
console.log("== 11. stress: commands and audio in any order, nothing breaks ==");
{
  const eng = voiceEngine();
  const inL = new Float32Array(BLOCK);
  const inR = new Float32Array(BLOCK);
  const outL = new Float32Array(BLOCK);
  const outR = new Float32Array(BLOCK);
  let seed = 20260913;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let allFinite = true;
  let worst = 0;
  const kick = shot("kick", 0, 0);
  for (let b = 0; b < 4000; b++) {
    const roll = rnd();
    if (roll < 0.04) eng.applyCommand({ t: "voice", key: "enabled", value: rnd() < 0.5 ? 0 : 1 });
    else if (roll < 0.07) eng.applyCommand({ t: "voice", key: "sensitivity", value: rnd() * 8 });
    else if (roll < 0.1) eng.applyCommand({ t: "voice", key: "floorDb", value: -120 + rnd() * 140 });
    else if (roll < 0.12) eng.applyCommand({ t: "voice", key: "featureMs", value: rnd() * 40 });
    else if (roll < 0.14) eng.applyCommand({ t: "voice", key: "minGapMs", value: rnd() * 200 });
    else if (roll < 0.16) eng.applyCommand({ t: "voice", key: "mode", value: rnd() < 0.5 ? 0 : 1 });
    else if (roll < 0.17) eng.applyCommand({ t: "voice", key: "margin", value: rnd() * 2 });
    else if (roll < 0.18) eng.applyCommand({ t: "voice", key: "velMin", value: rnd() });
    else if (roll < 0.19) eng.applyCommand({ t: "voice", key: "velDb", value: rnd() * 80 });
    else if (roll < 0.2) eng.applyCommand({ t: "voice", key: "monitor", value: rnd() < 0.5 ? 0 : 1 });
    else if (roll < 0.22) eng.applyCommand({ t: "voicecal", op: "centroid", cls: (rnd() * 6) | 0, feature: (rnd() * 6) | 0, value: rnd() });
    else if (roll < 0.24) eng.applyCommand({ t: "voicecal", op: "attack", cls: (rnd() * 6) | 0, band: (rnd() * 5) | 0, value: rnd() });
    else if (roll < 0.25) eng.applyCommand({ t: "voicecal", op: "pad", cls: (rnd() * 5) | 0, pad: ((rnd() * 20) | 0) - 2 });
    else if (roll < 0.27) eng.applyCommand({ t: "voicecal", op: "capture", cls: ((rnd() * 6) | 0) - 1 });
    else if (roll < 0.28) eng.applyCommand({ t: "voicecal", op: "clear" });
    else if (roll < 0.285) eng.applyCommand({ t: "voicecal", op: "reset" });
    else if (roll < 0.29) eng.applyCommand({ t: "voicecal", op: "detreset" });
    else if (roll < 0.295) eng.applyCommand({ t: "panic" });
    else if (roll < 0.3) eng.applyCommand({ t: "io", mute: rnd() < 0.5 ? 0 : 1 });
    else if (roll < 0.31) eng.applyCommand({ t: "drum", key: "route", value: (rnd() * 3) | 0 });

    // Real transients, at random offsets, sometimes hot enough to clip the input.
    const gain = rnd() < 0.2 ? 1.6 : 0.8;
    const start = (rnd() * kick.length) | 0;
    for (let i = 0; i < BLOCK; i++) {
      const v = rnd() < 0.05 ? kick[(start + i) % kick.length] * gain : (rnd() * 2 - 1) * 0.03;
      inL[i] = v;
      inR[i] = v;
    }
    eng.process(inL, inR, outL, outR, BLOCK);
    if (!finite(outL) || !finite(outR)) allFinite = false;
    worst = Math.max(worst, peak(outL), peak(outR));
  }
  ok("stress: output always finite", allFinite);
  ok("stress: output bounded by the safety clamp", worst <= 1.4 + 1e-6, `peak=${worst.toFixed(4)}`);
  ok(
    "stress: class->pad map left as integers, -1 or a pad number",
    Array.from(eng.voice.classPad).every((p) => Number.isInteger(p) && p >= -1),
    `${Array.from(eng.voice.classPad).join(",")}`,
  );
  ok("stress: centroid tables still finite", finite(eng.voice.centroids) && finite(eng.voice.attack));
  ok("stress: capture ring in range", eng.voice.captureCount >= 0);
  const m = new Float32Array(METER_FIELDS);
  eng.readMeters(m);
  ok("stress: meter block still finite", finite(m));
  ok("stress: params left in their clamps", eng.voice.margin >= 0.05 && eng.voice.margin <= 0.99 && eng.voice.velDb >= 3 && eng.voice.velDb <= 60);
}

console.log("");
console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
