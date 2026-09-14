// Numeric verification for the DSP core. Runs in plain Node: the DSP layer is
// deliberately backend-agnostic (no AudioContext, no DOM), so it can be tested
// headlessly without a browser. Any failure here is a real audio bug.
import { EFFECT_CLASSES, createEffect } from "../packages/web/public/dsp/effects/registry.js";
import { Engine } from "../packages/web/public/dsp/engine.js";

const SR = 48000;
const BLOCK = 128;
let failures = 0;
let checks = 0;

function ok(name, cond, detail = "") {
  checks++;
  if (!cond) { failures++; console.log(`FAIL  ${name} ${detail}`); }
  else console.log(`ok    ${name} ${detail}`);
}

function sine(freq, n, amp = 0.5, sr = SR) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return b;
}
function rms(a, from = 0) { let s = 0; for (let i = from; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / (a.length - from)); }
function peak(a, from = 0) { let p = 0; for (let i = from; i < a.length; i++) p = Math.max(p, Math.abs(a[i])); return p; }
function finite(a) { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; }

// Push a signal through one effect in BLOCK-sized chunks, returning the output.
function run(effect, input, frames = input.length) {
  const outL = new Float32Array(frames), outR = new Float32Array(frames);
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
  for (let off = 0; off < frames; off += BLOCK) {
    const n = Math.min(BLOCK, frames - off);
    for (let i = 0; i < n; i++) { L[i] = input[off + i]; R[i] = input[off + i]; }
    for (let i = n; i < BLOCK; i++) { L[i] = 0; R[i] = 0; }
    effect.process(L, R, n);
    outL.set(L.subarray(0, n), off); outR.set(R.subarray(0, n), off);
  }
  return { outL, outR };
}
function set(fx, params) { for (const [k, v] of Object.entries(params)) fx.setParam(k, v); }

console.log("== 1. every registered effect is stable and finite ==");
const ids = Object.keys(EFFECT_CLASSES);
console.log(`   ${ids.length} effects registered`);
const stim = new Float32Array(SR); // 1s: sine + a transient + silence
for (let i = 0; i < SR; i++) {
  stim[i] = i < SR / 3 ? 0.6 * Math.sin((2 * Math.PI * 220 * i) / SR)
    : i < SR / 3 + 64 ? 0.98
    : i < (2 * SR) / 3 ? 0.3 * Math.sin((2 * Math.PI * 1000 * i) / SR) + 0.2 * (Math.random() * 2 - 1)
    : 0;
}
for (const id of ids) {
  const fx = createEffect(id, SR, BLOCK);
  const { outL, outR } = run(fx, stim);
  const p = peak(outL);
  ok(`${id}: finite`, finite(outL) && finite(outR));
  ok(`${id}: bounded`, p < 100, `peak=${p.toFixed(3)}`);
  // Feed 10s of silence and check the tail has actually died. Delay/reverb legitimately
  // ring for seconds, so the assertion is about eventual decay, not immediate silence.
  const { outL: tailBuf } = run(fx, new Float32Array(SR * 10));
  const tail = peak(tailBuf, SR * 9.5);
  // `character` and `noise` deliberately emit a noise floor (tape hiss, vinyl crackle,
  // room tone), so they are held to an audible-drone threshold rather than silence.
  const tailLimit = id === "character" || id === "noise" ? 0.05 : 1e-3;
  ok(`${id}: tail decays, no self-oscillation`, tail < tailLimit, `tail=${tail.toExponential(2)}`);
  fx.reset();
  const { outL: z } = run(fx, new Float32Array(4096));
  ok(`${id}: silence in -> ~silence out`, peak(z) < 0.35, `peak=${peak(z).toFixed(4)}`);
}

console.log("\n== 2. EQ frequency response ==");
{
  const fx = createEffect("eq", SR, BLOCK);
  set(fx, { b2Freq: 1000, b2Gain: 12, b2Q: 1.2 });
  const boosted = rms(run(fx, sine(1000, SR)).outL, SR / 2);
  const ref = rms(sine(1000, SR), SR / 2);
  const dB = 20 * Math.log10(boosted / ref);
  ok("eq: +12dB bell at 1k", Math.abs(dB - 12) < 1.0, `measured ${dB.toFixed(2)}dB`);

  const fx2 = createEffect("eq", SR, BLOCK);
  set(fx2, { b2Freq: 1000, b2Gain: 12, b2Q: 1.2 });
  const off = rms(run(fx2, sine(60, SR)).outL, SR / 2) / rms(sine(60, SR), SR / 2);
  ok("eq: 60Hz unaffected by 1k bell", Math.abs(20 * Math.log10(off)) < 1.0, `${(20 * Math.log10(off)).toFixed(2)}dB`);

  const fx3 = createEffect("eq", SR, BLOCK);
  set(fx3, { hpFreq: 500, hpSlope: 1 });
  const hp = 20 * Math.log10(rms(run(fx3, sine(50, SR)).outL, SR / 2) / rms(sine(50, SR), SR / 2));
  ok("eq: 500Hz highpass kills 50Hz", hp < -30, `${hp.toFixed(1)}dB`);

  const fx4 = createEffect("eq", SR, BLOCK);
  set(fx4, { lsFreq: 150, lsGain: -12 });
  const ls = 20 * Math.log10(rms(run(fx4, sine(50, SR)).outL, SR / 2) / rms(sine(50, SR), SR / 2));
  ok("eq: -12dB low shelf cuts 50Hz", Math.abs(ls + 12) < 1.5, `${ls.toFixed(2)}dB`);
}

console.log("\n== 3. compressor gain reduction ==");
{
  const fx = createEffect("comp", SR, BLOCK);
  set(fx, { threshold: -20, ratio: 4, attack: 1, release: 50, knee: 0, makeup: 0, mix: 1 });
  // -10dBFS sine in => 10dB over threshold at 4:1 => 2.5dB over => ~7.5dB GR
  const amp = Math.pow(10, -10 / 20);
  const out = run(fx, sine(200, SR, amp)).outL;
  const gr = 20 * Math.log10(rms(out, SR / 2) / rms(sine(200, SR, amp), SR / 2));
  ok("comp: ~7.5dB GR at 4:1 / 10dB over", Math.abs(gr + 7.5) < 1.5, `${gr.toFixed(2)}dB`);

  const fx2 = createEffect("comp", SR, BLOCK);
  set(fx2, { threshold: -20, ratio: 4, attack: 1, release: 50, knee: 0, makeup: 0, mix: 100 });
  const quiet = Math.pow(10, -40 / 20);
  const g2 = 20 * Math.log10(rms(run(fx2, sine(200, SR, quiet)).outL, SR / 2) / rms(sine(200, SR, quiet), SR / 2));
  ok("comp: below threshold is transparent", Math.abs(g2) < 0.5, `${g2.toFixed(2)}dB`);
}

console.log("\n== 4. limiter ceiling is never exceeded ==");
{
  for (const ceil of [-0.3, -3, -6]) {
    const fx = createEffect("limiter", SR, BLOCK);
    set(fx, { ceiling: ceil, release: 50, gain: 12 });
    const hot = new Float32Array(SR);
    for (let i = 0; i < SR; i++) hot[i] = 0.95 * Math.sin((2 * Math.PI * 110 * i) / SR) * (1 + Math.sin((2 * Math.PI * 3 * i) / SR));
    const p = peak(run(fx, hot).outL, 2048);
    const lim = Math.pow(10, ceil / 20);
    ok(`limiter: peak <= ${ceil}dBFS`, p <= lim * 1.02, `peak=${(20 * Math.log10(p)).toFixed(2)}dB ceiling=${ceil}`);
  }
}

console.log("\n== 5. bit crusher quantises to the right number of levels ==");
{
  const fx = createEffect("crush", SR, BLOCK);
  set(fx, { bits: 4, rate: SR, dither: 0, mix: 100, drive: 0 });
  const out = run(fx, sine(100, 8192, 0.9)).outL;
  const levels = new Set();
  for (let i = 2048; i < out.length; i++) levels.add(Math.round(out[i] * 1e6));
  ok("crush: 4-bit collapses to <= 31 codes", levels.size <= 31 && levels.size > 8, `codes=${levels.size}`);
  const fx2 = createEffect("crush", SR, BLOCK);
  set(fx2, { bits: 16, rate: SR, dither: 0, mix: 100, drive: 0 });
  const levels2 = new Set();
  const o2 = run(fx2, sine(100, 8192, 0.9)).outL;
  for (let i = 2048; i < o2.length; i++) levels2.add(Math.round(o2[i] * 1e6));
  ok("crush: 16-bit is near-transparent", levels2.size > 100, `levels=${levels2.size}`);
}

console.log("\n== 6. delay time accuracy ==");
{
  for (const ms of [50, 125, 300]) {
    const fx = createEffect("delay", SR, BLOCK);
    set(fx, { sync: 0, time: ms, feedback: 0, pingpong: 0, spread: 0 });
    // Delay time is smoothed (tape-style glide), so settle it before probing the tap.
    run(fx, new Float32Array(SR));
    const imp = new Float32Array(SR); imp[0] = 1;
    const out = run(fx, imp).outL;
    let arg = 0, best = 0;
    for (let i = 8; i < out.length; i++) if (Math.abs(out[i]) > best) { best = Math.abs(out[i]); arg = i; }
    const measured = (arg / SR) * 1000;
    ok(`delay: ${ms}ms tap position`, Math.abs(measured - ms) < 3, `measured ${measured.toFixed(1)}ms`);
  }
}

console.log("\n== 7. reverb decays ==");
{
  const fx = createEffect("reverb", SR, BLOCK);
  set(fx, { size: 70, decay: 2.0, predelay: 0, damp: 8000, width: 100, lowcut: 20, mod: 0 });
  const imp = new Float32Array(SR * 4); imp[0] = 1;
  const out = run(fx, imp).outL;
  const early = rms(out.subarray(SR * 0.05 | 0, SR * 0.15 | 0));
  const late = rms(out.subarray(SR * 3 | 0, SR * 3.5 | 0));
  ok("reverb: builds a tail", early > 1e-5, `early rms=${early.toExponential(2)}`);
  ok("reverb: tail decays", late < early * 0.5, `late=${late.toExponential(2)} early=${early.toExponential(2)}`);
  ok("reverb: fully finite over 4s", finite(out));
}

console.log("\n== 8. pitch shifter transposes ==");
{
  // Estimate f0 by counting zero crossings on a band-limited sine.
  function f0(buf, from) {
    let cross = 0;
    for (let i = from + 1; i < buf.length; i++) if (buf[i - 1] <= 0 && buf[i] > 0) cross++;
    return (cross * SR) / (buf.length - from);
  }
  for (const [st, ratio] of [[12, 2], [-12, 0.5], [7, Math.pow(2, 7 / 12)]]) {
    const fx = createEffect("pitch", SR, BLOCK);
    set(fx, { pitch: st, fine: 0, formant: 0, preserve: 0, quality: 2, lifter: 40 });
    const out = run(fx, sine(220, SR * 2, 0.7)).outL;
    const f = f0(out, SR);
    const expect = 220 * ratio;
    ok(`pitch: ${st > 0 ? "+" : ""}${st}st`, Math.abs(f - expect) / expect < 0.06, `f0=${f.toFixed(1)}Hz expect=${expect.toFixed(1)}Hz`);
  }
}

console.log("\n== 9. gate closes on silence, opens on signal ==");
{
  const fx = createEffect("gate", SR, BLOCK);
  set(fx, { threshold: -30, attack: 1, hold: 10, release: 20, range: -80, hysteresis: 3 });
  const sig = new Float32Array(SR);
  for (let i = 0; i < SR / 2; i++) sig[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / SR);
  const out = run(fx, sig).outL;
  ok("gate: passes loud signal", rms(out.subarray(SR * 0.2 | 0, SR * 0.4 | 0)) > 0.2);
  ok("gate: closes on silence", rms(out.subarray(SR * 0.8 | 0)) < 1e-4);
}

console.log("\n== 9b. talk box: LPC vocal-tract model ==");
{
  // A talk box has no test signal of its own: it needs something that actually looks
  // like a mouthed vowel. Synthesise one — glottal pulse train through two resonators —
  // so the assertions below are about formants, not about generic "is it finite".
  function vowel(f1, f2, n, f0 = 120) {
    const pulses = new Float32Array(n);
    const per = Math.round(SR / f0);
    for (let i = 0; i < n; i++) pulses[i] = i % per === 0 ? 1 : 0;
    const y = new Float32Array(n);
    for (const [fc, bw, g] of [[f1, 90, 1], [f2, 110, 0.6]]) {
      const r = Math.exp((-Math.PI * bw) / SR), th = (2 * Math.PI * fc) / SR;
      const a1 = 2 * r * Math.cos(th), a2 = -r * r;
      let z1 = 0, z2 = 0;
      for (let i = 0; i < n; i++) { const v = pulses[i] + a1 * z1 + a2 * z2; z2 = z1; z1 = v; y[i] += g * v * (1 - r); }
    }
    let pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v));
    for (let i = 0; i < n; i++) y[i] = (0.5 * y[i]) / pk;
    return y;
  }
  // Reflection coefficients -> direct-form A(z), then the all-pole envelope 1/|A|.
  function k2a(k, p) {
    const a = new Float64Array(p + 1); a[0] = 1;
    for (let m = 1; m <= p; m++) { const t = a.slice(); for (let j = 1; j < m; j++) a[j] = t[j] + k[m - 1] * t[m - j]; a[m] = k[m - 1]; }
    return a;
  }
  function peakFormant(k, p) {
    let bestF = 0, bestDb = -1e9;
    for (let f = 150; f < 4000; f += 10) {
      const w = (2 * Math.PI * f) / SR;
      let re = 0, im = 0;
      for (let j = 0; j <= p; j++) { re += k[j] * Math.cos(-w * j); im += k[j] * Math.sin(-w * j); }
      const db = -10 * Math.log10(re * re + im * im);
      if (db > bestDb) { bestDb = db; bestF = f; }
    }
    return bestF;
  }

  const voiced = vowel(800, 1300, SR);

  // 1. The tract filter actually locks onto the formants of the input.
  {
    const fx = createEffect("talkbox", SR, BLOCK);
    set(fx, { carrier: 0, follow: 0, pitch: 90, order: 24, tractq: 1, tract: 1, drive: 0, breath: 0, squelch: -70, brightness: 0 });
    run(fx, voiced);
    const f = peakFormant(k2a(fx.kTarget, fx.activeOrder), fx.activeOrder);
    ok("talkbox: LPC fit locks onto a real formant", f > 600 && f < 1500, `peak=${f}Hz (input F1=800 F2=1300)`);
    ok("talkbox: LPC order honoured", fx.activeOrder === 24, `order=${fx.activeOrder}`);
  }

  // 2. Tract Size moves the whole envelope — a longer tract means lower formants.
  {
    const fs = [];
    for (const t of [1.4, 1.0, 0.7]) {
      const fx = createEffect("talkbox", SR, BLOCK);
      set(fx, { carrier: 0, follow: 0, pitch: 90, order: 24, tractq: 1, tract: t, drive: 0, breath: 0, squelch: -70 });
      run(fx, voiced);
      fs.push(peakFormant(k2a(fx.kTarget, fx.activeOrder), fx.activeOrder));
    }
    ok("talkbox: tract size shifts formants monotonically", fs[0] < fs[1] && fs[1] < fs[2], `long=${fs[0]}Hz mid=${fs[1]}Hz short=${fs[2]}Hz`);
    ok("talkbox: tract size shift is substantial", fs[2] / fs[0] > 1.25, `ratio=${(fs[2] / fs[0]).toFixed(2)}x`);
  }

  // 3. Every reflection coefficient stays inside the unit circle => lattice is stable.
  {
    let worst = 0;
    for (const q of [0, 0.5, 1]) for (const t of [0.5, 1, 2]) for (const o of [8, 24, 40]) {
      const fx = createEffect("talkbox", SR, BLOCK);
      set(fx, { tractq: q, tract: t, order: o, drive: 1, breath: 1, output: 18, follow: 1, squelch: -90 });
      run(fx, voiced.subarray(0, SR / 2));
      for (let i = 0; i < fx.kTarget.length; i++) worst = Math.max(worst, Math.abs(fx.kTarget[i]));
      for (let i = 0; i < fx.kNow.length; i++) worst = Math.max(worst, Math.abs(fx.kNow[i]));
    }
    ok("talkbox: all reflection coefficients |k| < 1 (lattice stable)", worst < 1, `max|k|=${worst.toFixed(4)}`);
  }

  // 4. Output tracks input loudness — the residual gain is doing its job.
  {
    const fx = createEffect("talkbox", SR, BLOCK);
    set(fx, { carrier: 0, follow: 0, pitch: 90, order: 22, drive: 0, breath: 0, squelch: -70, brightness: 0, output: 0 });
    const out = run(fx, voiced).outL;
    const ri = rms(voiced), ro = rms(out.subarray(SR / 4 | 0));
    const db = 20 * Math.log10(ro / ri);
    ok("talkbox: output loudness tracks input within 6dB", Math.abs(db) < 6, `${db.toFixed(1)}dB`);
  }

  // 5. Squelch: no carrier drone between words.
  {
    const fx = createEffect("talkbox", SR, BLOCK);
    set(fx, { carrier: 0, follow: 0, pitch: 110, squelch: -50, breath: 0 });
    const halfVoiced = new Float32Array(SR);
    halfVoiced.set(voiced.subarray(0, SR / 2));
    const out = run(fx, halfVoiced).outL;
    ok("talkbox: sounds while mouthing", rms(out.subarray(SR * 0.25 | 0, SR * 0.45 | 0)) > 1e-3);
    ok("talkbox: squelched between words (no drone)", rms(out.subarray(SR * 0.8 | 0)) < 1e-4, `rms=${rms(out.subarray(SR * 0.8 | 0)).toExponential(1)}`);
  }

  // 6. The voice itself must not pass through — a talk box you can hear over is broken.
  {
    const fx = createEffect("talkbox", SR, BLOCK);
    set(fx, { carrier: 5, follow: 0, breath: 0, drive: 0, squelch: -70 });
    const out = run(fx, voiced).outL;
    // Cross-correlate output against input: near-zero means the output is genuinely
    // resynthesised, not the dry voice leaking through.
    let num = 0, di = 0, dout = 0;
    for (let i = SR / 4 | 0; i < SR; i++) { num += voiced[i] * out[i]; di += voiced[i] * voiced[i]; dout += out[i] * out[i]; }
    const corr = Math.abs(num / Math.sqrt(di * dout + 1e-20));
    ok("talkbox: dry voice does not pass through", corr < 0.25, `|corr|=${corr.toFixed(3)}`);
  }

  // 7. Breath knob reopens the sibilance path that a real talk box loses.
  {
    const hiss = new Float32Array(SR / 2);
    for (let i = 0; i < hiss.length; i++) hiss[i] = 0.3 * (Math.random() * 2 - 1);
    const mk = (b) => { const fx = createEffect("talkbox", SR, BLOCK); set(fx, { breath: b, drive: 0, squelch: -90, carrier: 0, follow: 0 }); return rms(run(fx, hiss).outL); };
    ok("talkbox: breath adds sibilance", mk(1) > mk(0) * 1.2, `dry=${mk(0).toFixed(4)} wet=${mk(1).toFixed(4)}`);
  }

  // 8. Silence in, silence out — no self-oscillation from an unexcited tract.
  {
    const fx = createEffect("talkbox", SR, BLOCK);
    set(fx, { drive: 1, output: 18, breath: 1, squelch: -90 });
    const out = run(fx, new Float32Array(SR * 2)).outL;
    ok("talkbox: silence in -> silence out", peak(out) < 1e-6, `peak=${peak(out).toExponential(1)}`);
  }

  // 9. reset() genuinely flushes state.
  {
    const fx = createEffect("talkbox", SR, BLOCK);
    run(fx, voiced.subarray(0, SR / 2));
    fx.reset();
    const out = run(fx, new Float32Array(BLOCK * 4)).outL;
    ok("talkbox: reset flushes tract state", peak(out) === 0);
  }
}

console.log("\n== 10. engine chain runner: order, bypass, dry/wet, meters ==");
function addSlot(eng, id, type, extra = {}) { eng.applyCommand({ t: "add", id, type, ...extra }); }
{
  const eng = new Engine(SR, BLOCK);
  addSlot(eng, 1, "eq");
  addSlot(eng, 2, "delay");
  ok("engine: two slots active", eng.slots.length === 2, `count=${eng.slots.length}`);
  eng.applyCommand({ t: "move", id: 1, index: 1 });
  ok("engine: reorder keeps both", eng.slots.length === 2 && eng.slots[1].id === 1, `order=${eng.slots.map((s) => s.id)}`);
  eng.applyCommand({ t: "remove", id: 2 });
  ok("engine: remove works", eng.slots.length === 1 && eng.slots[0].id === 1);

  const inL = sine(440, BLOCK, 0.4), inR = sine(440, BLOCK, 0.4);

  const eng2 = new Engine(SR, BLOCK);
  addSlot(eng2, 1, "dist");
  eng2.applyCommand({ t: "param", id: 1, key: "drive", value: 40 });
  eng2.applyCommand({ t: "bypass", id: 1, value: 1 });
  const oL = new Float32Array(BLOCK), oR = new Float32Array(BLOCK);
  eng2.process(inL, inR, oL, oR, BLOCK);
  let maxDiff = 0;
  for (let i = 0; i < BLOCK; i++) maxDiff = Math.max(maxDiff, Math.abs(oL[i] - inL[i]));
  ok("engine: bypassed slot is transparent", maxDiff < 1e-6, `maxdiff=${maxDiff.toExponential(2)}`);

  const eng3 = new Engine(SR, BLOCK);
  addSlot(eng3, 1, "dist", { mix: 0 });
  eng3.applyCommand({ t: "param", id: 1, key: "drive", value: 40 });
  const o3L = new Float32Array(BLOCK), o3R = new Float32Array(BLOCK);
  eng3.process(inL, inR, o3L, o3R, BLOCK);
  let d3 = 0;
  for (let i = 0; i < BLOCK; i++) d3 = Math.max(d3, Math.abs(o3L[i] - inL[i]));
  ok("engine: dry/wet 0% is transparent", d3 < 1e-6, `maxdiff=${d3.toExponential(2)}`);

  // 100% wet distortion must actually change the signal — proves params reach the DSP
  const eng3b = new Engine(SR, BLOCK);
  addSlot(eng3b, 1, "dist", { mix: 1 });
  eng3b.applyCommand({ t: "param", id: 1, key: "drive", value: 40 });
  let dd = 0;
  const bL = new Float32Array(BLOCK), bR = new Float32Array(BLOCK);
  for (let k = 0; k < 40; k++) {
    const a = sine(440, BLOCK, 0.4), b = sine(440, BLOCK, 0.4);
    eng3b.process(a, b, bL, bR, BLOCK);
    for (let i = 0; i < BLOCK; i++) dd = Math.max(dd, Math.abs(bL[i] - a[i]));
  }
  ok("engine: 100% wet distortion alters the signal", dd > 0.05, `maxdiff=${dd.toFixed(3)}`);

  // master bypass
  const eng3c = new Engine(SR, BLOCK);
  addSlot(eng3c, 1, "dist", { mix: 1 });
  eng3c.applyCommand({ t: "io", bypass: true });
  const cL = new Float32Array(BLOCK), cR = new Float32Array(BLOCK);
  eng3c.process(inL, inR, cL, cR, BLOCK);
  let dc = 0;
  for (let i = 0; i < BLOCK; i++) dc = Math.max(dc, Math.abs(cL[i] - inL[i]));
  ok("engine: master bypass is transparent", dc < 1e-6, `maxdiff=${dc.toExponential(2)}`);

  // input gain actually applies
  const eng3d = new Engine(SR, BLOCK);
  eng3d.applyCommand({ t: "io", inGain: -6 });
  const dL = new Float32Array(BLOCK), dR = new Float32Array(BLOCK);
  for (let k = 0; k < 40; k++) eng3d.process(sine(440, BLOCK, 0.5), sine(440, BLOCK, 0.5), dL, dR, BLOCK);
  const g = 20 * Math.log10(rms(dL) / rms(sine(440, BLOCK, 0.5)));
  ok("engine: -6dB input trim applies", Math.abs(g + 6) < 0.4, `${g.toFixed(2)}dB`);

  // latency reporting from the STFT pitch module
  const eng3e = new Engine(SR, BLOCK);
  addSlot(eng3e, 1, "pitch");
  ok("engine: reports pitch module latency", eng3e.latencySamples > 0, `${eng3e.latencySamples} samples`);
  eng3e.applyCommand({ t: "bypass", id: 1, value: 1 });
  eng3e.recalcLatency();
  ok("engine: bypassed module reports no latency", eng3e.latencySamples === 0);

  const eng4 = new Engine(SR, BLOCK);
  const m = new Float32Array(256);
  const x = new Float32Array(BLOCK), y = new Float32Array(BLOCK);
  for (let k = 0; k < 40; k++) eng4.process(sine(440, BLOCK, 0.5), sine(440, BLOCK, 0.5), x, y, BLOCK);
  eng4.readMeters(m);
  ok("engine: meters are finite", finite(m.subarray(0, 24)));
  // Layout: [0..3] peak L/R in/out (linear), [4..7] rms, [8..9] clip, [10] cpu,
  // [11] latency samples, [12] slot count.
  ok("engine: peak meter tracks a 0.5 input", Math.abs(m[0] - 0.5) < 0.02 && Math.abs(m[2] - 0.5) < 0.02, `inL=${m[0].toFixed(3)} outL=${m[2].toFixed(3)}`);
  ok("engine: rms meter ~ -9dBFS for a 0.5 sine", Math.abs(20 * Math.log10(m[4]) + 9) < 1.5, `${(20 * Math.log10(m[4])).toFixed(2)}dB`);
  ok("engine: no clip flagged at 0.5", m[8] === 0 && m[9] === 0);
  ok("engine: reports slot count", m[12] === 0, `slots=${m[12]}`);
}

console.log("\n== 11. full Bro.Kodr default chain end to end ==");
{
  const eng = new Engine(SR, BLOCK);
  const chain = ["eq", "comp", "pitch", "dist", "crush", "delay", "reverb", "limiter"];
  chain.forEach((t, i) => addSlot(eng, i + 1, t, { mix: 1 }));
  ok("chain: all 8 slots loaded", eng.slots.length === 8, `count=${eng.slots.length}`);
  const seconds = 2;
  const n = SR * seconds;
  const outAll = new Float32Array(n);
  const iL = new Float32Array(BLOCK), iR = new Float32Array(BLOCK);
  const oL = new Float32Array(BLOCK), oR = new Float32Array(BLOCK);
  // Warm the JIT first — the first few hundred blocks run in the interpreter and would
  // otherwise dominate the measurement.
  for (let w = 0; w < 200; w++) {
    for (let i = 0; i < BLOCK; i++) iL[i] = iR[i] = 0.3 * Math.sin((2 * Math.PI * 150 * (w * BLOCK + i)) / SR);
    eng.process(iL, iR, oL, oR, BLOCK);
  }
  // Best of a few reps, not a single timed run. This sandbox shares a contended CPU, and
  // one run lands anywhere in a 25% band purely on who else is busy — which makes a
  // single-shot threshold a coin flip rather than a regression check. The fastest rep is
  // the one least interrupted, so it is the closest estimate of what the code costs.
  const REPS = 4;
  let ms = Infinity;
  for (let rep = 0; rep < REPS; rep++) {
    const t0 = process.hrtime.bigint();
    for (let off = 0; off < n; off += BLOCK) {
      for (let i = 0; i < BLOCK; i++) {
        const t = off + i;
        iL[i] = iR[i] = 0.4 * Math.sin((2 * Math.PI * 150 * t) / SR) + 0.15 * Math.sin((2 * Math.PI * 1800 * t) / SR);
      }
      eng.process(iL, iR, oL, oR, BLOCK);
      outAll.set(oL, off);
    }
    ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const realtime = (seconds * 1000) / ms;
  ok("chain: output finite", finite(outAll));
  ok("chain: output bounded", peak(outAll) < 2, `peak=${peak(outAll).toFixed(3)}`);
  ok("chain: produces signal", rms(outAll, SR) > 1e-3, `rms=${rms(outAll, SR).toFixed(4)}`);
  console.log(
    `      8-effect chain ran ${realtime.toFixed(1)}x realtime in Node ` +
      `(best of ${REPS}: ${ms.toFixed(0)}ms of CPU for ${seconds}s of audio)`,
  );
  // Headroom check only. This sandbox CPU is slower and more contended than any target
  // machine, and the browser's optimising JIT is faster than Node's here.
  ok("chain: runs faster than realtime with headroom", realtime > 3, `${realtime.toFixed(1)}x`);
}


console.log("== 12. file player: transport, loop, independent speed/pitch ==");
{
  const { FilePlayer } = await import("../packages/web/public/dsp/core/file-player.js");

  // A 2s 200Hz source at 48k. Period counting is the ground truth for pitch, and
  // total sample output is the ground truth for speed.
  const SRC = 96000;
  const F0 = 200;
  const src = new Float32Array(SRC);
  for (let i = 0; i < SRC; i++) src[i] = 0.5 * Math.sin((2 * Math.PI * F0 * i) / SR);

  // Zero crossings (rising) over a window -> measured fundamental.
  function measureHz(buf, from, to) {
    let last = buf[from], n = 0, first = -1, lastX = -1;
    for (let i = from + 1; i < to; i++) {
      const v = buf[i];
      if (last < 0 && v >= 0) { if (first < 0) first = i; else { lastX = i; n++; } }
      last = v;
    }
    if (n < 2 || lastX < 0) return 0;
    return (n * SR) / (lastX - first);
  }
  function render(p, blocks) {
    const out = new Float32Array(blocks * BLOCK);
    const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
    for (let b = 0; b < blocks; b++) {
      p.process(l, r, BLOCK);
      out.set(l, b * BLOCK);
    }
    return out;
  }

  const fp = new FilePlayer(SR, BLOCK);
  ok("file: starts unloaded", !fp.loaded);
  const silent = render(fp, 8);
  ok("file: silent with no buffer", peak(silent) === 0);

  fp.setBuffer(src, src, SRC, SR);
  ok("file: loaded reports frames", fp.loaded && fp.frames === SRC);
  ok("file: silent until played", peak(render(fp, 8)) < 1e-6);

  fp.setParam("gain", 0);
  fp.setParam("play", 1);
  const out1 = render(fp, 200);
  ok("file: plays finite", finite(out1));
  ok("file: plays audibly", rms(out1, 2000) > 0.2, `rms=${rms(out1, 2000).toFixed(3)}`);
  const hz1 = measureHz(out1, 4000, 20000);
  ok("file: 1x plays at source pitch", Math.abs(hz1 - F0) < 4, `${hz1.toFixed(1)}Hz`);
  ok("file: position advances", fp.position > 0.02 && fp.position < 0.5, fp.position.toFixed(3));

  // Stop fades out rather than cutting — a hard cut clicks in a live monitor.
  fp.setParam("play", 0);
  const stopped = render(fp, 60);
  ok("file: stop fades, does not cut", peak(stopped.subarray(0, 256)) > 1e-3);
  ok("file: stop reaches silence", peak(stopped.subarray(stopped.length - 2000)) < 1e-6);
  ok("file: stopped player is inactive", !fp.active);

  // ---- speed changes duration, not pitch ----
  const fs = new FilePlayer(SR, BLOCK);
  fs.setBuffer(src, src, SRC, SR);
  fs.setParam("gain", 0);
  fs.setParam("speed", 0.5);
  fs.setParam("play", 1);
  const half = render(fs, 300);
  const hzHalf = measureHz(half, 8000, 30000);
  ok("file: 0.5x speed keeps pitch", Math.abs(hzHalf - F0) < 8, `${hzHalf.toFixed(1)}Hz`);
  ok("file: 0.5x speed halves consumption", fs.position > 0.15 * 0.5 && fs.position < 0.6, fs.position.toFixed(3));
  ok("file: 0.5x output finite", finite(half) && peak(half) < 2);

  // ---- pitch changes pitch, not duration ----
  const fpp = new FilePlayer(SR, BLOCK);
  fpp.setBuffer(src, src, SRC, SR);
  fpp.setParam("gain", 0);
  fpp.setParam("pitch", 12); // one octave up
  fpp.setParam("play", 1);
  const oct = render(fpp, 200);
  const hzOct = measureHz(oct, 6000, 24000);
  ok("file: +12st doubles pitch", Math.abs(hzOct - F0 * 2) < 12, `${hzOct.toFixed(1)}Hz`);
  const fp1 = new FilePlayer(SR, BLOCK);
  fp1.setBuffer(src, src, SRC, SR);
  fp1.setParam("gain", 0);
  fp1.setParam("play", 1);
  render(fp1, 200);
  ok("file: +12st keeps duration", Math.abs(fpp.position - fp1.position) < 0.03,
    `${fpp.position.toFixed(3)} vs ${fp1.position.toFixed(3)}`);

  // ---- loop wraps without dropout ----
  const fl = new FilePlayer(SR, BLOCK);
  fl.setBuffer(src, src, SRC, SR);
  fl.setParam("gain", 0);
  fl.setParam("loop", 1);
  fl.setParam("loopin", 0.1);
  fl.setParam("loopout", 0.2);
  fl.setParam("seek", 0.9); // near the loop end
  fl.setParam("play", 1);
  const looped = render(fl, 400); // far longer than the 0.2s loop region
  ok("file: loop keeps playing past region end", rms(looped, 20000) > 0.2, `rms=${rms(looped, 20000).toFixed(3)}`);
  ok("file: loop has no silent dropout", peak(looped.subarray(30000, 40000)) > 0.2);
  ok("file: loop output finite", finite(looped) && peak(looped) < 2);
  ok("file: loop stays inside region", fl.position >= 0.09 && fl.position <= 0.22, fl.position.toFixed(3));

  // ---- one-shot stops at the end, no drift or runaway ----
  const fe = new FilePlayer(SR, BLOCK);
  fe.setBuffer(src, src, SRC, SR);
  fe.setParam("gain", 0);
  fe.setParam("play", 1);
  const all = render(fe, Math.ceil((SRC / BLOCK) * 1.3));
  ok("file: one-shot ends", !fe.playing);
  ok("file: one-shot tail is silent", peak(all.subarray(all.length - 4000)) < 1e-5);
  ok("file: one-shot total output finite", finite(all));

  // ---- eject ----
  fe.clearBuffer();
  ok("file: eject unloads", !fe.loaded && fe.position === 0);
  ok("file: silent after eject", peak(render(fe, 8)) === 0);
}

console.log("== 12b. carrier bus reaches talkbox and vocoder ==");
{
  const carL = new Float32Array(BLOCK), carR = new Float32Array(BLOCK);
  for (const id of ["talkbox", "vocoder"]) {
    const fx = createEffect(id, SR, BLOCK);
    ok(`${id}: exposes setCarrierBus`, typeof fx.setCarrierBus === "function");
    fx.setCarrierBus(carL, carR);
    set(fx, { source: 1, follow: 0, pitch: 110 });
    const voice = sine(150, SR, 0.5);
    // Drive the carrier bus with an unrelated tone and check the module tracks it:
    // silence on the bus must produce silence out when source = file.
    const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
    let outPk = 0;
    for (let off = 0; off + BLOCK <= SR; off += BLOCK) {
      for (let i = 0; i < BLOCK; i++) {
        L[i] = R[i] = voice[off + i];
        carL[i] = carR[i] = 0;
      }
      fx.process(L, R, BLOCK);
      if (off > SR / 2) outPk = Math.max(outPk, peak(L));
    }
    ok(`${id}: silent carrier bus -> silent output`, outPk < 0.01, `peak=${outPk.toFixed(4)}`);

    const fx2 = createEffect(id, SR, BLOCK);
    fx2.setCarrierBus(carL, carR);
    set(fx2, { source: 1, follow: 0, pitch: 110 });
    let pk2 = 0;
    for (let off = 0; off + BLOCK <= SR; off += BLOCK) {
      for (let i = 0; i < BLOCK; i++) {
        L[i] = R[i] = voice[off + i];
        carL[i] = carR[i] = 0.4 * Math.sin((2 * Math.PI * 90 * (off + i)) / SR);
      }
      fx2.process(L, R, BLOCK);
      if (off > SR / 2) pk2 = Math.max(pk2, peak(L));
      if (!finite(L)) { pk2 = NaN; break; }
    }
    ok(`${id}: live carrier bus produces output`, pk2 > 0.01 && pk2 < 20, `peak=${Number(pk2).toFixed(3)}`);
  }
}

console.log("\n== 12c. pitch roughness: jitter and shimmer (Voice Lab age controls) ==");
{
  // These two params are what actually sell "younger vs older" — an aged larynx loses
  // periodicity rather than simply dropping in pitch. The walk is a fixed-seed xorshift32,
  // so every number below is reproducible run to run.
  const tone = sine(220, SR, 0.5);

  // Baseline: both at zero must be bit-identical to a pitch module that never heard of them.
  const clean = createEffect("pitch", SR, BLOCK);
  set(clean, { pitch: 0, formant: 0, preserve: 1 });
  const a = run(clean, tone).outL;
  const rough0 = createEffect("pitch", SR, BLOCK);
  set(rough0, { pitch: 0, formant: 0, preserve: 1, jitter: 0, shimmer: 0 });
  const b = run(rough0, tone).outL;
  let maxDiff = 0;
  for (let i = 0; i < a.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a[i] - b[i]));
  ok("pitch: jitter/shimmer at 0 are bit-transparent", maxDiff === 0, `maxDiff=${maxDiff}`);

  // Shimmer must modulate level. Measure block-RMS spread well past the FFT latency.
  for (const [amt, lo, hi] of [[0, 0, 0.02], [60, 0.02, 0.9]]) {
    const fx = createEffect("pitch", SR, BLOCK);
    set(fx, { pitch: 0, formant: 0, preserve: 1, shimmer: amt });
    const out = run(fx, tone).outL;
    const start = 4096;
    const win = 2048;
    const levels = [];
    for (let off = start; off + win <= out.length; off += win) levels.push(rms(out.subarray(off, off + win)));
    const mean = levels.reduce((s, x) => s + x, 0) / levels.length;
    const spread = (Math.max(...levels) - Math.min(...levels)) / mean;
    ok(`pitch: shimmer ${amt}% level spread in [${lo}, ${hi}]`, spread >= lo && spread <= hi, `spread=${spread.toFixed(4)}`);
  }

  // Jitter must wander the pitch. Zero-crossing count over a window drifts when on.
  function zc(buf, from, len) {
    let n = 0;
    for (let i = from + 1; i < from + len; i++) if ((buf[i - 1] < 0) !== (buf[i] < 0)) n++;
    return n;
  }
  for (const [amt, expectDrift] of [[0, false], [80, true]]) {
    const fx = createEffect("pitch", SR, BLOCK);
    set(fx, { pitch: 0, formant: 0, preserve: 1, jitter: amt });
    const out = run(fx, tone).outL;
    const counts = [];
    for (let off = 4096; off + 4096 <= out.length; off += 4096) counts.push(zc(out, off, 4096));
    const drift = Math.max(...counts) - Math.min(...counts);
    ok(
      `pitch: jitter ${amt}% ${expectDrift ? "wanders the period" : "holds a steady period"}`,
      expectDrift ? drift > 0 : drift <= 2,
      `zc drift=${drift}`,
    );
  }

  // Extremes must stay bounded and finite — Ghost drives jitter to 100.
  const hot = createEffect("pitch", SR, BLOCK);
  set(hot, { pitch: -12, formant: 7, preserve: 1, jitter: 100, shimmer: 100 });
  const hotOut = run(hot, tone).outL;
  ok("pitch: jitter+shimmer at 100% stay finite", finite(hotOut));
  ok("pitch: jitter+shimmer at 100% stay bounded", peak(hotOut) < 4, `peak=${peak(hotOut).toFixed(3)}`);

  // The walk is leaky, so it must return toward centre rather than parking at a detune.
  const walk = createEffect("pitch", SR, BLOCK);
  set(walk, { jitter: 100 });
  run(walk, sine(220, SR * 2, 0.5));
  ok("pitch: jitter walk stays centred (leaky)", Math.abs(walk.jitWalk) < 0.6, `walk=${walk.jitWalk.toFixed(3)}`);

  // Fixed seed => reproducible. Two fresh instances must agree sample for sample.
  const r1 = createEffect("pitch", SR, BLOCK);
  const r2 = createEffect("pitch", SR, BLOCK);
  set(r1, { jitter: 50, shimmer: 50 });
  set(r2, { jitter: 50, shimmer: 50 });
  const o1 = run(r1, tone).outL;
  const o2 = run(r2, tone).outL;
  let same = true;
  for (let i = 0; i < o1.length; i++) if (o1[i] !== o2[i]) { same = false; break; }
  ok("pitch: fixed-seed walk is reproducible", same);
}

console.log("\n== 13. vocoder visual channel (the UI band ladder) ==");
{
  // The ladder in the UI is not a re-analysis of the output: each bar IS the band
  // envelope that is opening that band's VCA. These checks guard the contract the
  // display depends on — right length, 0..1 range, no allocation surprises, and
  // actual correspondence between input spectrum and lit bands.
  const fx = createEffect("vocoder", SR, BLOCK);
  set(fx, { bands: 16, freqlo: 120, freqhi: 7000, q: 4, follow: 0, pitch: 110 });

  ok("vocoder: exposes a visual getter", fx.visual instanceof Float32Array);
  ok("vocoder: visual length tracks band count", fx.visual.length === 16, `len=${fx.visual.length}`);

  // Silence in, nothing lit.
  const quiet = new Float32Array(SR);
  run(fx, quiet);
  ok("vocoder: silence leaves the ladder dark", peak(fx.visual) === 0, `peak=${peak(fx.visual)}`);

  // A 2.3kHz + 400Hz pair must light the bands that own those frequencies and
  // leave the extremes lower — this is the check that catches a ladder wired to
  // the wrong envelope, which still looks "alive" but is meaningless.
  const two = new Float32Array(SR);
  for (let i = 0; i < two.length; i++) {
    two[i] = 0.5 * Math.sin((2 * Math.PI * 2300 * i) / SR) + 0.4 * Math.sin((2 * Math.PI * 400 * i) / SR);
  }
  run(fx, two);
  const v = fx.visual;
  ok("vocoder: visual is finite", finite(v));
  let inRange = true;
  for (let i = 0; i < v.length; i++) if (v[i] < 0 || v[i] > 1) inRange = false;
  ok("vocoder: visual is normalised 0..1", inRange);
  // Nearest bands to 400Hz and 2300Hz on a 16-band 120..7000 log grid.
  const nearest = (hz) => {
    let best = 0;
    for (let i = 1; i < 16; i++) {
      if (Math.abs(Math.log2(fx.bands[i].freq / hz)) < Math.abs(Math.log2(fx.bands[best].freq / hz))) best = i;
    }
    return best;
  };
  const bLo = nearest(400);
  const bHi = nearest(2300);
  ok(`vocoder: band at ~400Hz is lit (#${bLo})`, v[bLo] > 0.4, `v=${v[bLo].toFixed(3)}`);
  ok(`vocoder: band at ~2.3kHz is lit (#${bHi})`, v[bHi] > 0.4, `v=${v[bHi].toFixed(3)}`);
  ok("vocoder: lit bands beat the top of the range", v[bHi] > v[15], `${v[bHi].toFixed(3)} > ${v[15].toFixed(3)}`);

  // reset() must clear the ladder, not leave the last frame frozen on screen.
  fx.reset();
  ok("vocoder: reset clears the ladder", peak(fx.visual) === 0);

  // Band count change must resize the view, and the buffer must be the same
  // preallocated object every call — the getter runs on the audio thread.
  set(fx, { bands: 24 });
  run(fx, two);
  ok("vocoder: visual resizes with band count", fx.visual.length === 24, `len=${fx.visual.length}`);
  ok("vocoder: visual reuses one buffer (no per-call allocation)", fx.visual.buffer === fx.visual.buffer && fx.visualBuf instanceof Float32Array);
}


// ===================================================================== BROBEATS
// Drum synth / voice / rack. These run headlessly for the same reason the effects do:
// the whole DSP layer is backend-agnostic, so a broken kick is caught here, not by ear.
console.log("\n== BROBEATS: synthesised kit ==");
{
  const { DRUM_KINDS, DRUM_SYNTH_DEFAULTS, DEFAULT_KIT_LAYOUT, renderDrum } =
    await import("../packages/web/public/dsp/core/drum-synth.js");

  const rendered = {};
  for (const kind of DRUM_KINDS) {
    const r = renderDrum(kind, SR, DRUM_SYNTH_DEFAULTS[kind]);
    rendered[kind] = r;
    const p = peak(r.data);
    ok(`${kind}: renders frames`, r.frames > 64 && r.data.length === r.frames, `frames=${r.frames}`);
    ok(`${kind}: finite`, finite(r.data));
    ok(`${kind}: audible`, p > 0.2, `peak=${p.toFixed(3)}`);
    ok(`${kind}: does not clip`, p <= 1.0, `peak=${p.toFixed(3)}`);
    // A sample that ends mid-waveform clicks every time it plays.
    ok(`${kind}: ends silent`, Math.abs(r.data[r.frames - 1]) < 1e-3, `last=${r.data[r.frames - 1].toExponential(2)}`);
  }

  // The kick must actually be low and the hat must actually be high, or the classifier
  // in phase 4 is learning from a kit that is already wrong.
  const centroid = (buf) => {
    let num = 0, den = 0, prev = 0, zc = 0;
    for (let i = 0; i < buf.length; i++) {
      if ((buf[i] >= 0) !== (prev >= 0)) zc++;
      prev = buf[i];
      den += Math.abs(buf[i]);
    }
    num = zc;
    return den > 0 ? (num * SR) / (2 * buf.length) : 0;
  };
  const kickC = centroid(rendered.kick.data);
  const hatC = centroid(rendered.hat.data);
  const snareC = centroid(rendered.snare.data);
  ok("kick is low-frequency", kickC < 400, `~${kickC.toFixed(0)}Hz`);
  ok("hat is high-frequency", hatC > 3000, `~${hatC.toFixed(0)}Hz`);
  ok("snare sits between kick and hat", snareC > kickC && snareC < hatC, `~${snareC.toFixed(0)}Hz`);
  ok("kick is longer than the hat", rendered.kick.frames > rendered.hat.frames);

  // Generator params have to do something, or the pad knobs are decoration.
  const shortKick = renderDrum("kick", SR, { ...DRUM_SYNTH_DEFAULTS.kick, decay: DRUM_SYNTH_DEFAULTS.kick.decay * 0.25 });
  ok("kick decay param shortens the sound", shortKick.frames < rendered.kick.frames,
    `${shortKick.frames} < ${rendered.kick.frames}`);
  const highKick = renderDrum("kick", SR, { ...DRUM_SYNTH_DEFAULTS.kick, tune: DRUM_SYNTH_DEFAULTS.kick.tune * 2 });
  ok("kick tune param raises the pitch", centroid(highKick.data) > kickC * 1.4,
    `${centroid(highKick.data).toFixed(0)} > ${kickC.toFixed(0)}`);

  // Rendering at another rate must give the same sound, not the same sample count.
  const at44 = renderDrum("kick", 44100, DRUM_SYNTH_DEFAULTS.kick);
  const ratio = at44.frames / rendered.kick.frames;
  ok("render is sample-rate independent", Math.abs(ratio - 44100 / SR) < 0.02, `ratio=${ratio.toFixed(3)}`);

  ok("factory layout fills 16 pads", DEFAULT_KIT_LAYOUT.length === 16, `len=${DEFAULT_KIT_LAYOUT.length}`);
  ok("factory layout only names known kinds",
    DEFAULT_KIT_LAYOUT.every((p) => DRUM_KINDS.includes(p.kind)));
  // Row 1 is what Smart Voice classifies into; it has to be kick/snare/hat/hat.
  ok("row 1 is kick, snare, closed hat, open hat",
    DEFAULT_KIT_LAYOUT[0].kind === "kick" && DEFAULT_KIT_LAYOUT[1].kind === "snare" &&
    DEFAULT_KIT_LAYOUT[2].kind === "hat" && DEFAULT_KIT_LAYOUT[3].kind === "hat");
  ok("open and closed hat share a choke group",
    DEFAULT_KIT_LAYOUT[2].choke > 0 && DEFAULT_KIT_LAYOUT[2].choke === DEFAULT_KIT_LAYOUT[3].choke);
}

console.log("\n== BROBEATS: drum voice ==");
{
  const { DRUM_SYNTH_DEFAULTS, renderDrum } = await import("../packages/web/public/dsp/core/drum-synth.js");
  const { DrumVoice } = await import("../packages/web/public/dsp/core/drum-voice.js");
  const kick = renderDrum("kick", SR, DRUM_SYNTH_DEFAULTS.kick);
  const hat = renderDrum("hat", SR, DRUM_SYNTH_DEFAULTS.hat);

  // Render a voice for `frames` samples in BLOCK chunks, starting from silence.
  const play = (voice, frames, atStart) => {
    const L = new Float32Array(frames), R = new Float32Array(frames);
    const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
    for (let off = 0; off < frames; off += BLOCK) {
      const n = Math.min(BLOCK, frames - off);
      bl.fill(0); br.fill(0);
      if (off === 0 && atStart) atStart();
      voice.process(bl, br, n);
      L.set(bl.subarray(0, n), off); R.set(br.subarray(0, n), off);
    }
    return { L, R };
  };
  const mk = () => {
    const v = new DrumVoice(SR, BLOCK);
    v.setBuffer(0, kick.data, kick.frames, SR);
    return v;
  };

  const v = mk();
  ok("voice: silent before it is triggered", peak(play(v, SR).L) === 0);

  const hit = play(mk(), SR, null) && (() => { const x = mk(); x.trigger(1); return play(x, SR); })();
  ok("voice: finite", finite(hit.L) && finite(hit.R));
  ok("voice: audible when triggered", peak(hit.L) > 0.2, `peak=${peak(hit.L).toFixed(3)}`);
  ok("voice: stereo-centred by default", Math.abs(peak(hit.L) - peak(hit.R)) < 1e-6);

  // The voice must release itself, or the rack fills up with pads that never free.
  const vEnd = mk(); vEnd.trigger(1); play(vEnd, SR * 2);
  ok("voice: goes inactive after the sample ends", vEnd.active === false);
  ok("voice: meter falls back to zero", vEnd.meter === 0);

  // ADSR is the "long bass / short bass" requirement: one sample, two lengths.
  const energyAfter = (v, ms) => {
    v.trigger(1);
    const { L } = play(v, SR);
    const from = Math.round((ms * SR) / 1000);
    return rms(L.subarray(from));
  };
  const shortV = mk(); shortV.setParam("sustain", 0); shortV.setParam("decay", 40);
  const longV = mk(); longV.setParam("sustain", 0); longV.setParam("decay", 900);
  const eShort = energyAfter(shortV, 120);
  const eLong = energyAfter(longV, 120);
  ok("voice: short decay truncates the tail", eShort < eLong * 0.1, `${eShort.toExponential(2)} vs ${eLong.toExponential(2)}`);
  ok("voice: sustain 0 + short decay ends the voice early", shortV.active === false);

  // hold auto-releases a ONESHOT, which is what a beatbox hit needs (no note-off).
  const held = mk(); held.setParam("hold", 60); held.setParam("release", 5);
  held.trigger(1); const heldOut = play(held, SR);
  ok("voice: hold auto-releases a one-shot", rms(heldOut.L.subarray(Math.round(SR * 0.2))) < 1e-4);

  // Velocity has to reach the output, or Smart Voice's dynamics are lost.
  const soft = mk(); soft.trigger(0.25); const softOut = play(soft, SR);
  const hard = mk(); hard.trigger(1.0); const hardOut = play(hard, SR);
  ok("voice: velocity scales level", peak(softOut.L) < peak(hardOut.L) * 0.5,
    `${peak(softOut.L).toFixed(3)} vs ${peak(hardOut.L).toFixed(3)}`);
  const flat = mk(); flat.setParam("velAmount", 0); flat.trigger(0.25);
  ok("voice: velAmount 0 ignores velocity", Math.abs(peak(play(flat, SR).L) - peak(hardOut.L)) < 1e-6);

  // Pan law: hard left must not just be "R off", it must hold its perceived level.
  const panned = mk(); panned.setParam("pan", -1); panned.trigger(1);
  const pOut = play(panned, SR);
  ok("voice: hard left kills the right channel", peak(pOut.R) < peak(pOut.L) * 0.05);
  ok("voice: constant-power pan keeps the level up", peak(pOut.L) > peak(hardOut.L) * 1.2,
    `${peak(pOut.L).toFixed(3)} vs ${peak(hardOut.L).toFixed(3)}`);

  // Pitch: down an octave plays twice as long.
  const low = mk(); low.setParam("pitch", -12); low.trigger(1);
  const lowOut = play(low, SR * 2);
  const lenOf = (a) => { for (let i = a.length - 1; i >= 0; i--) if (Math.abs(a[i]) > 1e-4) return i; return 0; };
  const octRatio = lenOf(lowOut.L) / lenOf(hardOut.L);
  ok("voice: -12 semitones doubles the length", octRatio > 1.8 && octRatio < 2.2, `ratio=${octRatio.toFixed(2)}`);

  const rev = mk(); rev.setParam("reverse", 1); rev.trigger(1);
  const revOut = play(rev, SR);
  ok("voice: reverse plays and is finite", finite(revOut.L) && peak(revOut.L) > 0.1);

  // Choke must be fast AND clickless — the two pull against each other, so check both.
  const ch = new DrumVoice(SR, BLOCK);
  ch.setBuffer(0, hat.data, hat.frames, SR);
  ch.setParam("decay", 4000); ch.setParam("sustain", 1);
  ch.trigger(1);
  const preChoke = new Float32Array(BLOCK), preChokeR = new Float32Array(BLOCK);
  ch.process(preChoke, preChokeR, BLOCK);
  ch.choke();
  const chokeTail = play(ch, SR).L;
  const chokeEnd = lenOf(chokeTail);
  ok("voice: choke silences within 8ms", chokeEnd < (8 * SR) / 1000, `${((chokeEnd / SR) * 1000).toFixed(2)}ms`);
  let maxJump = 0;
  for (let i = 1; i < Math.min(chokeTail.length, 2000); i++) {
    maxJump = Math.max(maxJump, Math.abs(chokeTail[i] - chokeTail[i - 1]));
  }
  ok("voice: choke does not click", maxJump < 0.5, `max step=${maxJump.toFixed(3)}`);

  // Retriggering mid-decay is the single most common thing a drummer does.
  const rt = mk(); rt.setParam("decay", 2000); rt.setParam("sustain", 1);
  rt.trigger(1);
  const a1 = play(rt, 4800);
  rt.trigger(1);
  const a2 = play(rt, 4800);
  let step = Math.abs(a2.L[0] - a1.L[a1.L.length - 1]);
  for (let i = 1; i < a2.L.length; i++) step = Math.max(step, Math.abs(a2.L[i] - a2.L[i - 1]));
  ok("voice: retrigger mid-decay does not click", step < 0.6, `max step=${step.toFixed(3)}`);

  // An empty pad must be silent, not undefined-noise.
  const empty = new DrumVoice(SR, BLOCK);
  empty.trigger(1);
  ok("voice: empty pad is silent and inactive", peak(play(empty, BLOCK * 4).L) === 0 && empty.active === false);
}

console.log("\n== BROBEATS: drum rack ==");
{
  const { DRUM_SYNTH_DEFAULTS, DEFAULT_KIT_LAYOUT, renderDrum } = await import("../packages/web/public/dsp/core/drum-synth.js");
  const { DrumRack, PAD_COUNT } = await import("../packages/web/public/dsp/core/drum-rack.js");

  const build = () => {
    const rack = new DrumRack(SR, BLOCK);
    for (let i = 0; i < PAD_COUNT; i++) {
      const spec = DEFAULT_KIT_LAYOUT[i];
      const r = renderDrum(spec.kind, SR, { ...DRUM_SYNTH_DEFAULTS[spec.kind], ...(spec.params || {}) });
      rack.setPadBuffer(i, 0, r.data, r.frames, SR);
      if (spec.choke) rack.setPadParam(i, "choke", spec.choke);
    }
    return rack;
  };
  const runRack = (rack, frames, seed) => {
    const L = new Float32Array(frames), R = new Float32Array(frames);
    const bl = new Float32Array(BLOCK), br = new Float32Array(BLOCK);
    for (let off = 0; off < frames; off += BLOCK) {
      const n = Math.min(BLOCK, frames - off);
      bl.fill(0); br.fill(0);
      if (seed) for (let i = 0; i < n; i++) { bl[i] = seed; br[i] = seed; }
      rack.process(bl, br, n);
      L.set(bl.subarray(0, n), off); R.set(br.subarray(0, n), off);
    }
    return { L, R };
  };

  ok("rack: builds 16 pads", build().pads.length === 16);

  const idle = build();
  ok("rack: silent when nothing is triggered", peak(runRack(idle, SR).L) === 0);
  ok("rack: reports not sounding when idle", idle.sounding === false);

  const r1 = build();
  r1.trigger(0, 1);
  const o1 = runRack(r1, SR);
  ok("rack: a triggered pad is audible", peak(o1.L) > 0.2, `peak=${peak(o1.L).toFixed(3)}`);
  ok("rack: finite", finite(o1.L) && finite(o1.R));

  // Additive contract: the rack adds to the caller's buffer, it does not overwrite it,
  // and it does not apply its own gain to what was already there.
  const add = build();
  add.setParam("gain", -60);
  const seeded = runRack(add, BLOCK * 4, 0.5);
  let preserved = true;
  for (let i = 0; i < seeded.L.length; i++) if (Math.abs(seeded.L[i] - 0.5) > 1e-6) preserved = false;
  ok("rack: idle rack leaves the host bus untouched", preserved);

  // All sixteen at once is the worst case: check it stays finite and sane.
  const all = build();
  for (let i = 0; i < PAD_COUNT; i++) all.trigger(i, 1);
  const oAll = runRack(all, SR);
  ok("rack: all 16 pads at once stay finite", finite(oAll.L) && finite(oAll.R));
  ok("rack: all 16 pads at once stay bounded", peak(oAll.L) < 16, `peak=${peak(oAll.L).toFixed(3)}`);
  ok("rack: sounding is true while pads ring", peak(oAll.L) > peak(o1.L));

  // Choke groups: closed hat must cut the open hat, which is the whole reason groups exist.
  const ck = build();
  ck.trigger(3, 1); // open hat
  const openAlone = runRack(ck, SR);
  const ck2 = build();
  ck2.trigger(3, 1);
  runRack(ck2, 1024);
  ck2.trigger(2, 1); // closed hat, same group
  const cut = runRack(ck2, SR);
  const lenOf = (a) => { for (let i = a.length - 1; i >= 0; i--) if (Math.abs(a[i]) > 1e-4) return i; return 0; };
  ok("rack: closed hat chokes the open hat", lenOf(cut.L) < lenOf(openAlone.L) * 0.8,
    `${lenOf(cut.L)} < ${lenOf(openAlone.L)}`);
  const kk = build();
  kk.trigger(3, 1);
  runRack(kk, 1024);
  kk.trigger(0, 1); // kick, different group — must NOT choke the hat
  ok("rack: a different group does not choke", kk.pads[3].active === true);

  // Mix controls.
  const g = build(); g.trigger(0, 1); g.setParam("gain", -12);
  const quiet = runRack(g, SR);
  ok("rack: gain attenuates", peak(quiet.L) < peak(o1.L) * 0.3, `${peak(quiet.L).toFixed(3)} vs ${peak(o1.L).toFixed(3)}`);
  const m = build(); m.trigger(0, 1); m.setParam("mute", 1);
  ok("rack: mute silences", peak(runRack(m, SR).L) === 0);
  const s = build(); s.trigger(0, 1); s.trigger(3, 1); s.setParam("solo", 0);
  runRack(s, SR);
  ok("rack: solo cuts the other pads", s.pads[3].active === false);

  // Per-pad chain — the reason Chain was extracted. An effect on one pad must not
  // touch the other fifteen.
  const fxRack = build();
  const chain = fxRack.chainFor(1);
  ok("rack: chainFor creates a chain lazily", chain !== null && fxRack.padChains[0] === null);
  chain.add({ id: "p1", type: "crush", params: { bits: 3, rate: 3000, drive: 6 }, mix: 1 });
  ok("rack: per-pad chain accepts an effect", chain.length === 1);
  fxRack.trigger(1, 1);
  const chained = runRack(fxRack, SR);
  ok("rack: chained pad renders finite audio", finite(chained.L) && peak(chained.L) > 0.05,
    `peak=${peak(chained.L).toFixed(3)}`);
  const dry = build(); dry.trigger(1, 1);
  const dryOut = runRack(dry, SR);
  ok("rack: the pad effect actually changes the sound",
    Math.abs(rms(chained.L) - rms(dryOut.L)) > 1e-5);
  const other = build();
  const c2 = other.chainFor(1);
  c2.add({ id: "p1", type: "crush", params: { bits: 3, rate: 3000, drive: 6 }, mix: 1 });
  other.trigger(0, 1); // fire the pad WITHOUT the effect
  const unaffected = runRack(other, SR);
  let identical = true;
  for (let i = 0; i < unaffected.L.length; i++) if (Math.abs(unaffected.L[i] - o1.L[i]) > 1e-6) identical = false;
  ok("rack: a pad effect leaves the other pads bit-identical", identical);

  // reset() is panic / preset load: everything must stop dead.
  const rs = build();
  for (let i = 0; i < PAD_COUNT; i++) rs.trigger(i, 1);
  runRack(rs, 512);
  rs.reset();
  ok("rack: reset stops every pad", rs.sounding === false);
  ok("rack: reset clears the meters", peak(rs.padMeters) === 0 && rs.meterL === 0);
  ok("rack: silent after reset", peak(runRack(rs, SR).L) === 0);

  // Out-of-range indices arrive from the wire; they must be ignored, not throw.
  const bad = build();
  bad.trigger(-1, 1); bad.trigger(99, 1); bad.setPadParam(99, "gain", 0);
  bad.release(99); bad.clearPad(-3);
  ok("rack: out-of-range pad indices are ignored", bad.sounding === false && bad.chainFor(99) === null);

  // Partial blocks: the host does not always hand over a full 128 frames.
  const pb = build();
  pb.trigger(0, 1);
  const sl = new Float32Array(BLOCK), sr2 = new Float32Array(BLOCK);
  let partialOk = true;
  for (let k = 0; k < 200; k++) {
    sl.fill(0); sr2.fill(0);
    const n = 1 + (k % BLOCK);
    pb.process(sl, sr2, n);
    for (let i = n; i < BLOCK; i++) if (sl[i] !== 0) partialOk = false;
    if (!finite(sl)) partialOk = false;
  }
  ok("rack: short blocks stay inside their frame count", partialOk);
}

console.log("\n== BROBEATS: onset detection ==");
{
  const { OnsetDetector, detectOnsets, ONSET_DEFAULTS, FEATURE_COUNT } =
    await import("../packages/web/public/dsp/core/onset.js");

  // Deterministic noise. Math.random() would make failures unreproducible, and an onset
  // detector is exactly the kind of thing that fails on one seed in twenty.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };

  // Synthetic kit pieces, chosen to sit in three clearly different parts of the spectrum.
  function kick(buf, at, amp = 0.9) {
    const len = (0.18 * SR) | 0;
    for (let i = 0; i < len && at + i < buf.length; i++) {
      const t = i / SR;
      buf[at + i] += amp * Math.exp(-t * 22) * Math.sin(2 * Math.PI * (120 * Math.exp(-t * 28) + 45) * t);
    }
  }
  function hat(buf, at, amp = 0.5) {
    const len = (0.045 * SR) | 0;
    let prev = 0;
    for (let i = 0; i < len && at + i < buf.length; i++) {
      const n = rnd();
      buf[at + i] += amp * Math.exp(-(i / SR) * 90) * (n - prev * 0.92);
      prev = n;
    }
  }
  function snare(buf, at, amp = 0.7) {
    const len = (0.12 * SR) | 0;
    for (let i = 0; i < len && at + i < buf.length; i++) {
      const t = i / SR;
      buf[at + i] += amp * Math.exp(-t * 30) * (Math.sin(2 * Math.PI * 190 * t) * 0.5 + rnd() * 0.7);
    }
  }

  const near = (got, want, tolMs) => Math.abs(got - want) <= (tolMs * 0.001 * SR);

  // --- positions -----------------------------------------------------------------
  {
    const buf = new Float32Array(SR * 2);
    const at = [4800, 28800, 52800, 76800];
    at.forEach((a) => kick(buf, a));
    const r = detectOnsets(buf, SR);
    ok("onset: finds every kick in an even pattern", r.positions.length === 4, `got ${r.positions.length}`);
    const tight = r.positions.every((p, i) => near(p, at[i], 5));
    ok("onset: places each kick within 5 ms of the transient", tight, JSON.stringify(r.positions));
  }

  // The case that drove the design: a quiet bright hit while a loud low one still rings.
  // Full-band detection misses the hat here; per-band detection is why it does not.
  {
    const buf = new Float32Array(SR * 2);
    const at = [4800, 16800, 28800, 40800];
    kick(buf, at[0]); hat(buf, at[1]); snare(buf, at[2]); hat(buf, at[3]);
    const r = detectOnsets(buf, SR);
    ok("onset: a hat under a ringing kick is not masked", r.positions.length === 4, `got ${r.positions.length}`);
    ok("onset: mixed-kit hits land within 5 ms", r.positions.every((p, i) => near(p, at[i], 5)),
      JSON.stringify(r.positions));
  }

  // --- timbre features -----------------------------------------------------------
  {
    const buf = new Float32Array(SR * 2);
    kick(buf, 4800); hat(buf, 16800); snare(buf, 28800);
    const r = detectOnsets(buf, SR);
    const [k, h, s] = r.features;
    ok("onset: features are present for every hit", r.features.length === r.positions.length);
    ok("onset: band energies sum to 1", r.features.every((f) => Math.abs(f[0] + f[1] + f[2] - 1) < 1e-4));
    ok("onset: a kick reads as low band", k && k[0] > 0.6, k && `low=${k[0].toFixed(3)}`);
    ok("onset: a kick has a low zero-crossing rate", k && k[3] < 0.2, k && `zcr=${k[3].toFixed(3)}`);
    ok("onset: a hat reads as high band", h && h[2] > 0.6, h && `high=${h[2].toFixed(3)}`);
    ok("onset: a hat has a high zero-crossing rate", h && h[3] > 0.6, h && `zcr=${h[3].toFixed(3)}`);
    // A snare is the hard one: bright like a hat but with a body a hat does not have.
    // That low-band difference is the axis a classifier separates them on.
    ok("onset: a snare carries body a hat does not", s && h && s[0] > h[0] + 0.05,
      s && h && `snare low=${s[0].toFixed(3)} hat low=${h[0].toFixed(3)}`);
    ok("onset: features stay finite", r.features.every((f) => f.every(Number.isFinite)));
    ok("onset: strengths stay in 0..1", r.strengths.every((v) => v >= 0 && v <= 1 && Number.isFinite(v)));
  }

  // Level invariance: the same hit 20 dB quieter must classify the same way, or the
  // detector is really just a loudness meter.
  {
    const loud = new Float32Array(SR); kick(loud, 4800, 0.9);
    const soft = new Float32Array(SR); kick(soft, 4800, 0.09);
    const a = detectOnsets(loud, SR).features[0];
    const b = detectOnsets(soft, SR).features[0];
    ok("onset: a quiet hit classifies like a loud one", a && b && Math.abs(a[0] - b[0]) < 0.1,
      a && b && `${a[0].toFixed(3)} vs ${b[0].toFixed(3)}`);
  }

  // --- refractory and false positives ---------------------------------------------
  {
    const buf = new Float32Array(SR);
    kick(buf, 4800); kick(buf, 4800 + ((0.015 * SR) | 0));
    ok("onset: hits inside the refractory gap collapse to one",
      detectOnsets(buf, SR).positions.length === 1);

    const spaced = new Float32Array(SR);
    kick(spaced, 4800); kick(spaced, 4800 + ((0.06 * SR) | 0));
    ok("onset: hits outside the refractory gap stay separate",
      detectOnsets(spaced, SR).positions.length === 2);

    ok("onset: silence produces nothing", detectOnsets(new Float32Array(SR), SR).positions.length === 0);

    const quiet = new Float32Array(SR);
    for (let i = 0; i < quiet.length; i++) quiet[i] = rnd() * 0.0005; // ~-66 dBFS
    ok("onset: noise below the floor produces nothing", detectOnsets(quiet, SR).positions.length === 0);

    // A sustained tone is one onset — its start — not a stream of them.
    const held = new Float32Array(SR);
    for (let i = 0; i < held.length; i++) held[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
    ok("onset: a sustained tone is one onset, not many", detectOnsets(held, SR).positions.length === 1,
      `got ${detectOnsets(held, SR).positions.length}`);
  }

  // --- robustness ------------------------------------------------------------------
  {
    // Slice points must not depend on the host's buffer size, or a recording would chop
    // differently on different hardware.
    const buf = new Float32Array(SR * 2);
    [4800, 28800, 52800].forEach((a) => kick(buf, a));
    const ref = JSON.stringify(Array.from(detectOnsets(buf, SR, undefined, 128).positions));
    const same = [64, 256, 512].every(
      (bs) => JSON.stringify(Array.from(detectOnsets(buf, SR, undefined, bs).positions)) === ref);
    ok("onset: slice points do not depend on block size", same, ref);

    // NaN reaching an envelope follower poisons it permanently and silently.
    const dirty = new Float32Array(SR);
    kick(dirty, 4800); dirty[2000] = NaN; dirty[2001] = Infinity; kick(dirty, 28800);
    const d = detectOnsets(dirty, SR);
    ok("onset: survives NaN and Infinity in the input", d.positions.length === 2 &&
      d.strengths.every(Number.isFinite) && d.features.every((f) => f.every(Number.isFinite)),
      `hits=${d.positions.length}`);

    // The offline slicer and the live detector must agree, or the slice points drawn on
    // the waveform are not the moments the pads would actually have fired.
    const det = new OnsetDetector(SR);
    const block = new Float32Array(BLOCK);
    const live = [];
    for (let off = 0; off < buf.length; off += BLOCK) {
      for (let i = 0; i < BLOCK; i++) block[i] = off + i < buf.length ? buf[off + i] : 0;
      const n = det.process(block, BLOCK);
      for (let h = 0; h < n; h++) live.push(det.positions[h]);
    }
    ok("onset: streaming and offline find the same hits", JSON.stringify(live) === ref, JSON.stringify(live));
  }

  // --- API surface ------------------------------------------------------------------
  {
    const det = new OnsetDetector(SR);
    det.setParam("sensitivity", 999);
    ok("onset: out-of-range params clamp instead of breaking", det.sensitivity <= 8 && det.sensitivity >= 1.05,
      `${det.sensitivity}`);
    det.setParam("sensitivity", NaN);
    ok("onset: a NaN param is ignored", Number.isFinite(det.sensitivity));
    det.setParam("nonsense", 1);
    ok("onset: an unknown param is ignored", true);

    const buf = new Float32Array(SR);
    kick(buf, 4800);
    const d2 = new OnsetDetector(SR);
    const b2 = new Float32Array(BLOCK);
    for (let off = 0; off < buf.length; off += BLOCK) {
      for (let i = 0; i < BLOCK; i++) b2[i] = off + i < buf.length ? buf[off + i] : 0;
      d2.process(b2, BLOCK);
    }
    const before = d2.frames;
    d2.reset();
    ok("onset: reset clears the detector", d2.frames === 0 && d2.commitCount === 0 && before > 0);

    ok("onset: exports defaults and feature count", FEATURE_COUNT === 4 &&
      Number.isFinite(ONSET_DEFAULTS.sensitivity) && Number.isFinite(ONSET_DEFAULTS.minGapMs));

    // The detector runs on the audio thread, so process() must not allocate. A sharp
    // proxy for that: the output arrays are the same objects block after block.
    const d3 = new OnsetDetector(SR);
    const p0 = d3.positions, s0 = d3.strengths, f0 = d3.features;
    const b3 = new Float32Array(BLOCK);
    for (let k = 0; k < 50; k++) { for (let i = 0; i < BLOCK; i++) b3[i] = rnd() * 0.5; d3.process(b3, BLOCK); }
    ok("onset: process() reuses its buffers rather than allocating",
      d3.positions === p0 && d3.strengths === s0 && d3.features === f0);

    // The host does not always hand over a full block.
    const d4 = new OnsetDetector(SR);
    let shortOk = true;
    for (let k = 0; k < 200; k++) {
      const n = 1 + (k % BLOCK);
      for (let i = 0; i < BLOCK; i++) b3[i] = rnd() * 0.5;
      const c = d4.process(b3, n);
      if (!Number.isFinite(c) || c < 0) shortOk = false;
      for (let h = 0; h < c; h++) if (!Number.isFinite(d4.strengths[h])) shortOk = false;
    }
    ok("onset: short blocks are handled", shortOk);
  }

  // Sample rate is passed in, never assumed — the same audio at 44.1k must slice at the
  // same musical moment, not the same sample index.
  {
    const SR2 = 44100;
    const buf = new Float32Array(SR2 * 2);
    const at = [(0.1 * SR2) | 0, (0.6 * SR2) | 0, (1.1 * SR2) | 0];
    for (const a of at) {
      const len = (0.18 * SR2) | 0;
      for (let i = 0; i < len && a + i < buf.length; i++) {
        const t = i / SR2;
        buf[a + i] += 0.9 * Math.exp(-t * 22) * Math.sin(2 * Math.PI * (120 * Math.exp(-t * 28) + 45) * t);
      }
    }
    const r = detectOnsets(buf, SR2);
    ok("onset: works at 44.1 kHz", r.positions.length === 3 &&
      r.positions.every((p, i) => Math.abs(p - at[i]) <= 0.005 * SR2), JSON.stringify(r.positions));
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
