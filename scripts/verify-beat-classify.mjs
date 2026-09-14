// Numeric verification for Smart Voice (core/beat-classify.js).
//
// The sandbox has no microphone, so the only honest way to test the classifier is to
// feed it the kit's own one-shots: render a drum, bury it in silence, push it through
// `process()` in 128-frame blocks exactly as the worklet would, and check which pad
// came out. That tests every part of the live path except the mic itself — onset
// detection, both decision stages, velocity, gating, capture, muting, meters.
//
// What it cannot tell us is whether a *mouth* kick lands on the kick centroid. That is
// a question only a real mic answers, and it is what calibration exists for. The
// synthetic pass here is the floor, not the ceiling: if it cannot recognise the sounds
// it was measured from, nothing else is worth trying.
import {
  SmartVoice,
  VOICE_CLASS,
  VOICE_CLASS_NAMES,
  VOICE_MODE,
  CLASS_COUNT,
  FACTORY_CENTROIDS,
  FACTORY_ATTACK,
  DEFAULT_CLASS_PADS,
  VOICE_KEY,
  VOICE_DEFAULTS,
  VOICE_METER_STRIDE,
  CAP_STRIDE,
  CAP_ATTACK_OFFSET,
  STAGE1_DELAY_BLOCKS,
} from "../packages/web/public/dsp/core/beat-classify.js";
import { FEATURE_COUNT } from "../packages/web/public/dsp/core/onset.js";
import { renderDrum } from "../packages/web/public/dsp/core/drum-synth.js";

const SR = 48000;
const BLOCK = 128;
let failures = 0;
let checks = 0;

function ok(name, cond, detail = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  } else console.log(`ok    ${name} ${detail}`);
}

/**
 * One drum one-shot with `padMs` of silence in front and `tailMs` behind. `padFrames`
 * adds sub-block silence on top, which is how a hit is moved to a chosen offset inside
 * a 128-frame block — the variable the stage-1 read used to be at the mercy of.
 */
function shot(kind, params, gain = 1, padMs = 50, tailMs = 220, padFrames = 0) {
  const r = renderDrum(kind, SR, params);
  if (!r) throw new Error(`no renderer for ${kind}`);
  const head = ((padMs * 0.001 * SR) | 0) + padFrames;
  const tail = (tailMs * 0.001 * SR) | 0;
  const mono = new Float32Array(head + r.frames + tail);
  for (let i = 0; i < r.frames; i++) mono[head + i] = r.data[i] * gain;
  return mono;
}

/**
 * Pushes a buffer through in real blocks and collects every fired hit. Returns the
 * hits in order, each with the class, pad, velocity, stage and confidence it fired at,
 * plus the block index so timing can be checked.
 */
function run(sv, mono) {
  const block = new Float32Array(BLOCK);
  const hits = [];
  for (let off = 0; off < mono.length; off += BLOCK) {
    const n = Math.min(BLOCK, mono.length - off);
    block.fill(0);
    for (let i = 0; i < n; i++) block[i] = mono[off + i];
    const fired = sv.process(block, n);
    for (let h = 0; h < fired; h++) {
      hits.push({
        cls: sv.fireClass[h],
        pad: sv.firePad[h],
        vel: sv.fireVel[h],
        stage: sv.fireStage[h],
        conf: sv.fireConf[h],
        block: off / BLOCK,
      });
    }
  }
  return hits;
}

function fresh(params) {
  const sv = new SmartVoice(SR);
  sv.setParam("enabled", 1);
  if (params) for (const k in params) sv.setParam(k, params[k]);
  return sv;
}

// ------------------------------------------------------------------ exports

{
  ok("exports: four classes, named in wire order", CLASS_COUNT === 4 && VOICE_CLASS_NAMES.length === 4);
  ok(
    "exports: class indices match the name order",
    VOICE_CLASS_NAMES[VOICE_CLASS.KICK] === "kick" &&
      VOICE_CLASS_NAMES[VOICE_CLASS.SNARE] === "snare" &&
      VOICE_CLASS_NAMES[VOICE_CLASS.HAT] === "hat" &&
      VOICE_CLASS_NAMES[VOICE_CLASS.CLAP] === "clap",
  );
  let shaped = FACTORY_CENTROIDS.length === CLASS_COUNT && FACTORY_ATTACK.length === CLASS_COUNT;
  let bounded = true;
  for (const row of FACTORY_CENTROIDS) {
    if (row.length !== FEATURE_COUNT) shaped = false;
    for (const v of row) if (!Number.isFinite(v) || v < 0 || v > 1) bounded = false;
  }
  for (const row of FACTORY_ATTACK) {
    if (row.length !== 3) shaped = false;
    for (const v of row) if (!Number.isFinite(v) || v < 0 || v > 1) bounded = false;
  }
  ok("exports: feature table is 4x4, attack table is 4x3", shaped);
  ok("exports: every centroid value is a finite 0..1", bounded);
  // Both tables are band proportions of the same signal, so each row should very nearly
  // sum to 1 (stage 2's rows also carry zcr, which is not part of the sum).
  let normalised = true;
  for (let c = 0; c < CLASS_COUNT; c++) {
    const s2 = FACTORY_CENTROIDS[c][0] + FACTORY_CENTROIDS[c][1] + FACTORY_CENTROIDS[c][2];
    const s1 = FACTORY_ATTACK[c][0] + FACTORY_ATTACK[c][1] + FACTORY_ATTACK[c][2];
    if (Math.abs(s2 - 1) > 0.02 || Math.abs(s1 - 1) > 0.02) normalised = false;
  }
  ok("exports: centroid bands are normalised proportions", normalised);
  ok(
    "exports: default pads are the four beatbox pads of the factory layout",
    DEFAULT_CLASS_PADS.join(",") === "0,1,2,5",
  );
  let keysOk = VOICE_KEY.length > 0;
  for (const k of VOICE_KEY) if (!(k in VOICE_DEFAULTS)) keysOk = false;
  ok("exports: every wire key has a default", keysOk, VOICE_KEY.join(","));
  ok("exports: meter stride is declared", VOICE_METER_STRIDE === 12);
}

// ------------------------------------------------------------------ off by default

{
  const sv = new SmartVoice(SR);
  ok("gate: disabled by default", sv.enabled === false);
  const hits = run(sv, shot("kick"));
  ok("gate: disabled fires nothing", hits.length === 0 && sv.onsetCount === 0, `${hits.length} hits`);
}

// ------------------------------------------------------------------ silence

{
  const sv = fresh();
  const hits = run(sv, new Float32Array(SR * 0.5));
  ok("gate: digital silence fires nothing", hits.length === 0, `${hits.length} hits`);
}

{
  const sv = fresh();
  // Room noise 12 dB under the -42 dB gate. A detector that trips on this is unusable
  // in any real room, which is the whole reason the gate is a front-panel control.
  const noise = new Float32Array(SR * 0.5);
  for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 2 - 1) * 0.002;
  const hits = run(sv, noise);
  ok("gate: noise below the floor fires nothing", hits.length === 0, `${hits.length} hits`);
}

// ------------------------------------------------------------------ one hit per hit

{
  const sv = fresh();
  const hits = run(sv, shot("kick"));
  ok("count: one kick produces exactly one hit", hits.length === 1, `${hits.length}`);
  ok("count: the hit reports a real pad and velocity", hits.length === 1 && hits[0].pad >= 0 && hits[0].vel > 0);
}

{
  // Four kicks at 150 ms apart: well clear of the 45 ms refractory period, so all four
  // must land. This is what a detector that double-triggers on a decay tail fails.
  const one = shot("kick", {}, 1, 20, 130);
  const seq = new Float32Array(one.length * 4);
  for (let k = 0; k < 4; k++) seq.set(one, k * one.length);
  const sv = fresh();
  const hits = run(sv, seq);
  ok("count: four spaced kicks produce four hits", hits.length === 4, `${hits.length}`);
}

// ------------------------------------------------------------------ classification

{
  // The four factory sounds the four classes are named after. Each must land on its own
  // class with the factory profile — anything less and the shipped defaults are wrong.
  const cases = [
    ["kick", {}, VOICE_CLASS.KICK],
    ["snare", {}, VOICE_CLASS.SNARE],
    ["hat", { decay: 45 }, VOICE_CLASS.HAT],
    ["clap", {}, VOICE_CLASS.CLAP],
  ];
  for (const [kind, params, want] of cases) {
    const sv = fresh({ mode: VOICE_MODE.ACCURATE });
    const hits = run(sv, shot(kind, params));
    const got = hits.length === 1 ? hits[0].cls : -1;
    ok(
      `classify accurate: ${kind} -> ${VOICE_CLASS_NAMES[want]}`,
      got === want,
      `got ${got < 0 ? `${hits.length} hits` : VOICE_CLASS_NAMES[got]}`,
    );
  }
  // Fast mode is allowed to defer a hit to stage 2 — that is the design — but it is
  // never allowed to fire the *wrong* class, because an early commit cannot be taken
  // back. This is the check that caught stage 1 comparing attack-time bands against
  // window-time centroids and confidently calling every kick a clap.
  for (const [kind, params, want] of cases) {
    const sv = fresh({ mode: VOICE_MODE.FAST });
    const hits = run(sv, shot(kind, params));
    const got = hits.length === 1 ? hits[0].cls : -1;
    ok(
      `classify fast: ${kind} -> ${VOICE_CLASS_NAMES[want]}`,
      got === want,
      `got ${got < 0 ? `${hits.length} hits` : VOICE_CLASS_NAMES[got]} at stage ${hits[0]?.stage}`,
    );
  }
}

{
  // What stage 1 can and cannot settle on its own, stated as a test so a regression in
  // either direction is visible: a kick and a hat are obvious from the attack and must
  // commit early, and nothing may commit early to the wrong class.
  const early = {};
  for (const [kind, params, want] of [
    ["kick", {}, VOICE_CLASS.KICK],
    ["snare", {}, VOICE_CLASS.SNARE],
    ["hat", { decay: 45 }, VOICE_CLASS.HAT],
    ["clap", {}, VOICE_CLASS.CLAP],
  ]) {
    const sv = fresh({ mode: VOICE_MODE.FAST });
    const hits = run(sv, shot(kind, params));
    early[kind] = hits.length === 1 && hits[0].stage === 1 ? hits[0].cls : -1;
  }
  ok("stage 1: a kick commits early and correctly", early.kick === VOICE_CLASS.KICK, `${early.kick}`);
  ok("stage 1: a hat commits early and correctly", early.hat === VOICE_CLASS.HAT, `${early.hat}`);
  ok(
    "stage 1: no early commit is ever to the wrong class",
    Object.entries(early).every(([kind, cls]) => cls === -1 || VOICE_CLASS_NAMES[cls] === kind),
    JSON.stringify(early),
  );
}

{
  // The regression test for the bug that made STAGE1_DELAY_BLOCKS exist. A hit lands at
  // an arbitrary offset inside the block the onset fires in, so reading the band
  // envelopes at the end of that block reads an arbitrary fraction of the attack: the
  // factory kick's bands swung over a 0.43-wide range across sub-block phases, wider
  // than the 0.17 gap between the kick and clap rows, and kicks were confidently fired
  // as claps at whichever phases happened to land badly.
  //
  // So the same sound is pushed through at every 8-frame offset inside a block. A
  // correct stage 1 is phase-independent: one hit each time, never the wrong class, and
  // for kick and hat an early commit every time rather than at some phases only.
  const phases = 16;
  const step = BLOCK / phases;
  let wrong = 0;
  let miscounted = 0;
  const earlyRate = {};
  for (const [kind, params, want] of [
    ["kick", {}, VOICE_CLASS.KICK],
    ["snare", {}, VOICE_CLASS.SNARE],
    ["hat", { decay: 45 }, VOICE_CLASS.HAT],
    ["clap", {}, VOICE_CLASS.CLAP],
  ]) {
    let committed = 0;
    for (let p = 0; p < phases; p++) {
      const sv = fresh({ mode: VOICE_MODE.FAST });
      const hits = run(sv, shot(kind, params, 1, 50, 220, p * step));
      if (hits.length !== 1) {
        miscounted++;
        continue;
      }
      if (hits[0].cls !== want) wrong++;
      if (hits[0].stage === 1) committed++;
    }
    earlyRate[kind] = `${committed}/${phases}`;
  }
  ok("phase: one hit per sound at every sub-block offset", miscounted === 0, `${miscounted} bad counts`);
  ok("phase: never the wrong class, at any offset", wrong === 0, `${wrong} wrong of ${phases * 4}`);
  ok(
    "phase: kick and hat commit early at every offset",
    earlyRate.kick === `${phases}/${phases}` && earlyRate.hat === `${phases}/${phases}`,
    JSON.stringify(earlyRate),
  );
}

{
  // The stage-1 table is measured in *blocks*, so the moment it describes moves with
  // the sample rate: one 128-frame block is 2.67 ms at 48 kHz and 2.90 ms at 44.1 kHz.
  // That is a small enough shift that one table should serve both, but "should" is what
  // a test is for — a device running at 44.1 kHz must not get a different classifier.
  const alt = 44100;
  const results = {};
  for (const [kind, params, want] of [
    ["kick", {}, VOICE_CLASS.KICK],
    ["snare", {}, VOICE_CLASS.SNARE],
    ["hat", { decay: 45 }, VOICE_CLASS.HAT],
    ["clap", {}, VOICE_CLASS.CLAP],
  ]) {
    const r = renderDrum(kind, alt, params);
    const head = (0.05 * alt) | 0;
    const mono = new Float32Array(head + r.frames + ((0.22 * alt) | 0));
    for (let i = 0; i < r.frames; i++) mono[head + i] = r.data[i];
    const sv = new SmartVoice(alt);
    sv.setParam("enabled", 1);
    const hits = run(sv, mono);
    results[kind] = hits.length === 1 && hits[0].cls === want && hits[0].stage === 1;
  }
  ok(
    "rate: 44.1 kHz classifies all four at stage 1 too",
    Object.values(results).every(Boolean),
    JSON.stringify(results),
  );
}

{
  // Level invariance is the property the normalised band features exist to give: the
  // same sound 20 dB quieter is the same sound. If this fails, the classifier is really
  // a loudness meter.
  const sv = fresh({ mode: VOICE_MODE.ACCURATE });
  const loud = run(sv, shot("kick", {}, 1.0));
  sv.reset();
  const quiet = run(sv, shot("kick", {}, 0.1));
  ok(
    "classify: level does not change the class",
    loud.length === 1 && quiet.length === 1 && loud[0].cls === quiet[0].cls,
    `${loud[0]?.cls} vs ${quiet[0]?.cls}`,
  );
  ok(
    "velocity: quieter hit fires softer",
    loud.length === 1 && quiet.length === 1 && quiet[0].vel < loud[0].vel,
    `${loud[0]?.vel.toFixed(3)} vs ${quiet[0]?.vel.toFixed(3)}`,
  );
  ok(
    "velocity: never below the floor, never above 1",
    loud.every((h) => h.vel >= VOICE_DEFAULTS.velMin - 1e-6 && h.vel <= 1) &&
      quiet.every((h) => h.vel >= VOICE_DEFAULTS.velMin - 1e-6 && h.vel <= 1),
  );
}

// ------------------------------------------------------------------ two-stage timing

{
  const sv = fresh({ mode: VOICE_MODE.FAST });
  run(sv, shot("kick"));
  const fastStage = sv.lastStage;
  ok("stages: fast mode commits a kick at stage 1", fastStage === 1, `stage ${fastStage}`);

  const sv2 = fresh({ mode: VOICE_MODE.ACCURATE });
  const hits2 = run(sv2, shot("kick"));
  ok(
    "stages: accurate mode always waits for stage 2",
    hits2.length === 1 && hits2[0].stage === 2,
    `stage ${hits2[0]?.stage}`,
  );

  // What fast mode actually buys, measured. Stage 2 fires featureMs after the onset and
  // stage 1 fires STAGE1_DELAY_BLOCKS after it, so the gap between them is the
  // difference — and the block index a hit fired in is the only latency measurement
  // available without audio hardware. Asserted as a window of one block rather than an
  // upper bound, because the failure worth catching is the delay growing quietly: an
  // upper bound of "featureMs or less" is satisfied by a stage 1 that has drifted all
  // the way out to stage 2 and saves nothing.
  const svF = fresh({ mode: VOICE_MODE.FAST });
  const hF = run(svF, shot("kick"));
  const svA = fresh({ mode: VOICE_MODE.ACCURATE });
  const hA = run(svA, shot("kick"));
  const lag = (hA[0]?.block ?? 0) - (hF[0]?.block ?? 0);
  const lagMs = (lag * BLOCK * 1000) / SR;
  const blockMs = (BLOCK * 1000) / SR;
  const wantMs = VOICE_DEFAULTS.featureMs - STAGE1_DELAY_BLOCKS * blockMs;
  ok(
    "stages: fast mode beats accurate by featureMs minus the stage-1 delay",
    lag > 0 && Math.abs(lagMs - wantMs) <= blockMs,
    `${lagMs.toFixed(2)} ms earlier, expected about ${wantMs.toFixed(2)}`,
  );
}

{
  // Only one decision per hit, ever. A stage-1 fire followed by a stage-2 "correction"
  // would be an audible flam, so it must be counted and not played.
  const sv = fresh({ mode: VOICE_MODE.FAST });
  const hits = run(sv, shot("kick"));
  ok("stages: an early commit is never re-fired", hits.length === 1 && sv.hitCount === 1, `${sv.hitCount}`);
  ok("stages: corrections are counted, not played", sv.corrections >= 0 && sv.corrections <= 1);
}

// ------------------------------------------------------------------ pad routing

{
  const sv = fresh({ mode: VOICE_MODE.ACCURATE });
  sv.setClassPad(VOICE_CLASS.KICK, 12);
  const hits = run(sv, shot("kick"));
  ok("routing: a reassigned class fires its new pad", hits.length === 1 && hits[0].pad === 12, `${hits[0]?.pad}`);
}

{
  const sv = fresh({ mode: VOICE_MODE.ACCURATE });
  sv.setClassPad(VOICE_CLASS.KICK, -1);
  const hits = run(sv, shot("kick"));
  ok("routing: pad -1 mutes the class", hits.length === 0, `${hits.length} hits`);
  ok("routing: a muted class still registers as heard", sv.hitCount === 1 && sv.lastClass === VOICE_CLASS.KICK);
}

{
  const sv = fresh();
  sv.setClassPad(99, 3);
  sv.setClassPad(-4, 3);
  sv.setCentroid(99, 0, 0.5);
  sv.setCentroid(0, 99, 0.5);
  sv.setCentroid(0, 0, NaN);
  sv.setAttackCentroid(0, 7, 0.5);
  sv.setAttackCentroid(0, 0, NaN);
  sv.setParam("margin", NaN);
  ok(
    "guards: out-of-range and non-finite control values are ignored",
    Math.abs(sv.centroids[0] - FACTORY_CENTROIDS[0][0]) < 1e-6 &&
      Math.abs(sv.attack[0] - FACTORY_ATTACK[0][0]) < 1e-6 &&
      sv.margin === VOICE_DEFAULTS.margin,
  );
  ok(
    "guards: the attack table's zcr slot stays zero",
    sv.attack[3] === 0 && sv.attack[FEATURE_COUNT + 3] === 0,
  );
}

// ------------------------------------------------------------------ calibration

{
  // Eight kicks, supervised. Capture must record all eight, and with monitoring off
  // nothing may fire — a calibration pass that plays the kit through the performer's
  // speakers feeds the mic it is calibrating.
  const one = shot("kick", {}, 1, 20, 130);
  const seq = new Float32Array(one.length * 8);
  for (let k = 0; k < 8; k++) seq.set(one, k * one.length);

  const sv = fresh();
  sv.setCapture(VOICE_CLASS.KICK);
  const hits = run(sv, seq);
  ok("calibrate: capture records every hit", sv.captureCount === 8, `${sv.captureCount}`);
  ok("calibrate: nothing fires while capturing with monitor off", hits.length === 0, `${hits.length} hits`);

  const out = new Float32Array(CAP_STRIDE);
  let readable = true;
  let labelled = true;
  let sane = true;
  let bothVectors = true;
  for (let n = 0; n < sv.captureCount; n++) {
    if (!sv.readCapture(n, out)) {
      readable = false;
      break;
    }
    if (out[0] !== VOICE_CLASS.KICK) labelled = false;
    for (let i = 1; i < CAP_STRIDE; i++) {
      if (!Number.isFinite(out[i]) || out[i] < 0) sane = false;
    }
    for (let i = 0; i < FEATURE_COUNT; i++) if (out[1 + i] > 1.001) sane = false;
    // Both vectors present and both normalised: a capture with an all-zero attack
    // section would train stage 1 onto the origin and break early commits entirely.
    const bands = out[CAP_ATTACK_OFFSET] + out[CAP_ATTACK_OFFSET + 1] + out[CAP_ATTACK_OFFSET + 2];
    if (Math.abs(bands - 1) > 0.02) bothVectors = false;
  }
  ok("calibrate: every capture reads back", readable);
  ok("calibrate: captures carry the supervised label", labelled);
  ok("calibrate: captured features are finite and in range", sane);
  ok("calibrate: each capture carries its attack vector too", bothVectors);
  ok("calibrate: strength is recorded", out[CAP_STRIDE - 1] > 0, `${out[CAP_STRIDE - 1].toFixed(3)}`);
  ok("calibrate: readCapture rejects a hit that never happened", sv.readCapture(99, out) === false);

  sv.setParam("monitor", 1);
  sv.clearCaptures();
  const monitored = run(sv, one);
  ok("calibrate: monitor on fires pads while capturing", monitored.length === 1, `${monitored.length} hits`);

  sv.setCapture(-1);
  ok("calibrate: capture stops on -1", sv.captureClass === -1);
}

{
  // The end-to-end calibration loop: capture examples of all four classes, average each
  // class into its centroid, then classify the same sounds again. A trained profile must
  // be at least as good as the factory one on the material it was trained from —
  // otherwise `setCentroid` is not actually wired to the classifier.
  const cases = [
    ["kick", {}, VOICE_CLASS.KICK],
    ["snare", {}, VOICE_CLASS.SNARE],
    ["hat", { decay: 45 }, VOICE_CLASS.HAT],
    ["clap", {}, VOICE_CLASS.CLAP],
  ];
  const sv = fresh({ mode: VOICE_MODE.ACCURATE });
  const out = new Float32Array(CAP_STRIDE);
  const sums = [];
  for (let c = 0; c < CLASS_COUNT; c++) {
    sums.push({ n: 0, f: new Float64Array(FEATURE_COUNT), b: new Float64Array(3) });
  }

  for (const [kind, params, cls] of cases) {
    sv.setCapture(cls);
    const one = shot(kind, params, 1, 20, 130);
    for (let k = 0; k < 4; k++) run(sv, one);
  }
  ok("train: captured 16 examples across four classes", sv.captureCount === 16, `${sv.captureCount}`);
  for (let n = 0; n < sv.captureCount; n++) {
    if (!sv.readCapture(n, out)) continue;
    const c = out[0] | 0;
    sums[c].n++;
    for (let i = 0; i < FEATURE_COUNT; i++) sums[c].f[i] += out[1 + i];
    for (let i = 0; i < 3; i++) sums[c].b[i] += out[CAP_ATTACK_OFFSET + i];
  }
  let trained = true;
  for (let c = 0; c < CLASS_COUNT; c++) {
    if (sums[c].n === 0) {
      trained = false;
      continue;
    }
    for (let i = 0; i < FEATURE_COUNT; i++) sv.setCentroid(c, i, sums[c].f[i] / sums[c].n);
    for (let i = 0; i < 3; i++) sv.setAttackCentroid(c, i, sums[c].b[i] / sums[c].n);
  }
  ok("train: every class got examples", trained);

  sv.setCapture(-1);
  let right = 0;
  for (const [kind, params, want] of cases) {
    sv.reset();
    const hits = run(sv, shot(kind, params));
    if (hits.length === 1 && hits[0].cls === want) right++;
  }
  ok("train: a trained profile classifies all four at stage 2", right === 4, `${right}/4`);

  // And with the trained attack table, in fast mode, where a wrong early commit is
  // unrecoverable. This is the path a calibrated performer actually plays on.
  sv.setParam("mode", VOICE_MODE.FAST);
  let fastRight = 0;
  for (const [kind, params, want] of cases) {
    sv.reset();
    const hits = run(sv, shot(kind, params));
    if (hits.length === 1 && hits[0].cls === want) fastRight++;
  }
  ok("train: a trained profile classifies all four in fast mode", fastRight === 4, `${fastRight}/4`);

  sv.resetCentroids();
  let restored = true;
  for (let c = 0; c < CLASS_COUNT; c++) {
    for (let i = 0; i < FEATURE_COUNT; i++) {
      if (Math.abs(sv.centroids[c * FEATURE_COUNT + i] - FACTORY_CENTROIDS[c][i]) > 1e-6) restored = false;
      const want = i < 3 ? FACTORY_ATTACK[c][i] : 0;
      if (Math.abs(sv.attack[c * FEATURE_COUNT + i] - want) > 1e-6) restored = false;
    }
  }
  ok("train: resetCentroids restores both factory tables", restored);
}

// ------------------------------------------------------------------ robustness

{
  const sv = fresh();
  const bad = new Float32Array(BLOCK * 8);
  for (let i = 0; i < bad.length; i++) bad[i] = i % 3 === 0 ? NaN : i % 3 === 1 ? Infinity : 0.4;
  const hits = run(sv, bad);
  let clean = Number.isFinite(sv.level) && Number.isFinite(sv.lastVel) && Number.isFinite(sv.lastConf);
  for (const h of hits) if (!Number.isFinite(h.vel) || !Number.isFinite(h.conf)) clean = false;
  ok("robust: NaN and Infinity in the mic do not poison the state", clean);
}

{
  // The caller can stop draining (a UI thread that stalls, a paused engine). The ring
  // must skip to what is still readable rather than reading stale slots as fresh hits.
  const one = shot("kick", {}, 1, 20, 60);
  const seq = new Float32Array(one.length * 40);
  for (let k = 0; k < 40; k++) seq.set(one, k * one.length);
  const sv = fresh({ mode: VOICE_MODE.ACCURATE });
  const hits = run(sv, seq);
  ok(
    "robust: 40 hits in a row all classify, none duplicated",
    hits.length === 40 && sv.onsetCount === 40,
    `${hits.length} fired, ${sv.onsetCount} onsets`,
  );
  ok(
    "robust: drain index tracks the detector",
    sv.drained === 40,
    `drained ${sv.drained}`,
  );
}

{
  const sv = fresh();
  run(sv, shot("kick"));
  const before = sv.hitCount;
  sv.reset();
  ok(
    "reset: clears counters and readouts",
    before === 1 && sv.hitCount === 0 && sv.onsetCount === 0 && sv.lastClass === -1 && sv.corrections === 0,
  );
  const hits = run(sv, shot("kick"));
  ok("reset: still works after a reset", hits.length === 1, `${hits.length}`);
}

{
  // Switching on must not inherit a stale envelope: an old one invents a first hit or
  // swallows it, and either is the worst possible first impression of the feature.
  const sv = fresh();
  run(sv, shot("kick"));
  sv.setParam("enabled", 0);
  const off = run(sv, shot("kick"));
  sv.setParam("enabled", 1);
  const on = run(sv, shot("kick"));
  ok("enable: nothing fires while off", off.length === 0, `${off.length}`);
  ok("enable: re-enabling starts clean and hears the next hit", on.length === 1, `${on.length}`);
}

// ------------------------------------------------------------------ meters

{
  const sv = fresh({ mode: VOICE_MODE.ACCURATE });
  run(sv, shot("snare"));
  const out = new Float32Array(64);
  out.fill(-999);
  const written = sv.readMeters(out, 8);
  ok("meters: reports its stride", written === VOICE_METER_STRIDE, `${written}`);
  let filled = true;
  for (let i = 8; i < 8 + VOICE_METER_STRIDE; i++) if (out[i] === -999 || !Number.isFinite(out[i])) filled = false;
  ok("meters: every field is written and finite", filled);
  ok("meters: nothing is written outside the block", out[7] === -999 && out[8 + VOICE_METER_STRIDE] === -999);
  ok(
    "meters: the fields carry the hit that just happened",
    out[8] === 1 && out[9] === 1 && out[10] === VOICE_CLASS.SNARE && out[12] > 0,
    `enabled ${out[8]} hits ${out[9]} class ${out[10]} vel ${out[12].toFixed(3)}`,
  );
}

// ------------------------------------------------------------------ house rules

{
  // These are compile constraints for the React Native worklet path, not style: Hermes
  // rejects private *fields* and class `extends` outright, so a violation here is a file
  // that cannot be ported to mobile at all. Private methods are fine and used throughout.
  const raw = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../packages/web/public/dsp/core/beat-classify.js", import.meta.url), "utf8"),
  );
  // Comments talk about feature *windows* and mouths and speakers; only code counts.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  ok("house: no class extends", !/class\s+\w+\s+extends/.test(src));
  ok("house: no private instance fields", !/^\s*#\w+\s*[=;]/m.test(src));
  // A name banned as a *global* is still fine as this file's own method name or as a
  // declared parameter: `process(block, frames)` is the hot loop every backend calls,
  // and `constructor(sampleRate)` takes the rate as an argument precisely so it never
  // reads the worklet global. Collect both shapes and exclude them from the scan, or
  // the check fails on the very design it is meant to enforce.
  const locals = new Set();
  const decls = src.match(/^\s*(?:static\s+|async\s+|get\s+|set\s+)*[\w#]+\s*\([^)]*\)\s*\{/gm) || [];
  for (const d of decls) {
    locals.add(d.trim().split("(")[0].replace(/^(?:static|async|get|set)\s+/, ""));
    for (const p of d.slice(d.indexOf("(") + 1, d.lastIndexOf(")")).split(",")) {
      const name = p.trim().split("=")[0].trim();
      if (name) locals.add(name);
    }
  }
  const usedAsGlobal = (g) => !locals.has(g) && new RegExp(`(^|[^.\\w])${g}\\b`).test(src);
  const globals = ["AudioWorkletProcessor", "AudioContext", "currentFrame", "window", "document", "globalThis", "process"];
  const found = globals.filter(usedAsGlobal);
  ok("house: no environment globals", found.length === 0, found.join(","));
  ok("house: no bare sampleRate global", !usedAsGlobal("sampleRate"));
  ok(
    "house: imports only from the dsp core",
    (src.match(/from\s+"([^"]+)"/g) || []).every((m) => m.includes('"./')),
  );
}

{
  // Zero allocation in process() cannot be proven from inside JS, but a growing heap
  // over a long run is the symptom that matters. 10 seconds of audio through the
  // detector must not add megabytes.
  const sv = fresh();
  const block = new Float32Array(BLOCK);
  for (let i = 0; i < BLOCK; i++) block[i] = Math.sin(i * 0.1) * 0.3;
  sv.process(block, BLOCK); // warm up
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  const blocks = ((SR * 10) / BLOCK) | 0;
  for (let b = 0; b < blocks; b++) sv.process(block, BLOCK);
  if (global.gc) global.gc();
  const grew = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  ok("alloc: 10 s of audio does not grow the heap", grew < 4, `${grew.toFixed(2)} MB over ${blocks} blocks`);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
