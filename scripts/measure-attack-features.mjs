// Measurement: what do the three band envelopes look like right after an onset, and
// how many blocks after it does that reading become stable?
//
// This is where `FACTORY_ATTACK` in core/beat-classify.js comes from. It exists as a
// separate script from measure-drum-features.mjs because the two tables are measured at
// genuinely different points in a hit's life: the stage-2 table reads the detector's
// finished feature window, while stage 1 reads the raw band envelopes mid-transient,
// and nothing about the second follows from the first.
//
// The thing this script is really measuring is *phase sensitivity*. The detector works
// in 128-frame blocks, so a hit lands at an arbitrary offset inside the block that
// crosses the onset threshold — sometimes 4 frames of transient are inside it,
// sometimes 120. Reading the envelopes at the end of that block therefore reads a
// different fraction of the same attack every time, and the spread that causes is not
// something a better centroid can fix. So every sound is rendered at 16 sub-block
// phases and reported as mean plus min/max per delay, where delay is how many whole
// blocks after the onset block the envelopes are read.
//
// Usage: node scripts/measure-attack-features.mjs [maxDelayBlocks]
//
// Read the output as: pick the smallest delay whose min/max spread is tight enough that
// the classes do not overlap. A wide spread at delay 0 is the bug this script was
// written to find, not noise in the script.
import { renderDrum, DEFAULT_KIT_LAYOUT } from "../packages/web/public/dsp/core/drum-synth.js";
import { OnsetDetector, ONSET_DEFAULTS } from "../packages/web/public/dsp/core/onset.js";
import { VOICE_DEFAULTS, DEFAULT_CLASS_PADS, VOICE_CLASS_NAMES } from "../packages/web/public/dsp/core/beat-classify.js";

const SR = 48000;
const BLOCK = 128;
const PHASES = 16; // 16 x 8 frames covers every position inside a 128-frame block
const MAX_DELAY = Math.max(0, Number(process.argv[2] || 3));

/** The detector configured exactly as SmartVoice configures it — same numbers, same file. */
function detector() {
  return new OnsetDetector(SR, {
    sensitivity: VOICE_DEFAULTS.sensitivity,
    floorDb: VOICE_DEFAULTS.floorDb,
    minGapMs: VOICE_DEFAULTS.minGapMs,
    featureMs: VOICE_DEFAULTS.featureMs,
    lowCrossHz: ONSET_DEFAULTS.lowCrossHz,
    highCrossHz: ONSET_DEFAULTS.highCrossHz,
  });
}

/** Normalised band proportions from the detector's three fast envelopes, as stage 1 reads them. */
function bands(det) {
  const lo = det.fastLow.env * det.fastLow.env;
  const mid = det.fastMid.env * det.fastMid.env;
  const hi = det.fastHigh.env * det.fastHigh.env;
  const total = lo + mid + hi;
  if (!(total > 1e-12)) return [0, 0, 0];
  return [lo / total, mid / total, hi / total];
}

/**
 * One hit at one phase: returns the band vector read at each delay 0..MAX_DELAY blocks
 * after the block the onset fired in, or null if the hit was not detected at all.
 */
function measure(kind, params, phase) {
  const r = renderDrum(kind, SR, params);
  if (!r) return null;
  const pad = ((0.05 * SR) | 0) + phase * (BLOCK / PHASES);
  const mono = new Float32Array(pad + r.frames + ((SR * 0.2) | 0));
  mono.set(r.data, pad);

  const det = detector();
  const blocks = (mono.length / BLOCK) | 0;
  const scratch = new Float32Array(BLOCK);
  const out = [];
  let onsetBlock = -1;
  for (let b = 0; b < blocks; b++) {
    scratch.set(mono.subarray(b * BLOCK, b * BLOCK + BLOCK));
    const found = det.process(scratch, BLOCK);
    if (found > 0 && onsetBlock < 0) onsetBlock = b;
    if (onsetBlock >= 0 && b - onsetBlock <= MAX_DELAY) out[b - onsetBlock] = bands(det);
    if (onsetBlock >= 0 && b - onsetBlock >= MAX_DELAY) break;
  }
  if (onsetBlock < 0 || out.length < MAX_DELAY + 1) return null;
  return out;
}

// kind -> delay -> list of band vectors across phases, and the same per individual pad.
// Both, because they answer different questions: a wide spread within one pad is the
// block-phase problem this script was written for, while a wide spread across pads of
// the same kind means the kind's mean is not a good description of any of them — and
// only the first of those is fixable by choosing a better delay.
const byKind = new Map();
const byPad = [];
for (const entry of DEFAULT_KIT_LAYOUT) {
  const pad = { name: entry.name, kind: entry.kind, slots: [] };
  for (let p = 0; p < PHASES; p++) {
    const got = measure(entry.kind, entry.params, p);
    if (!got) continue;
    if (!byKind.has(entry.kind)) byKind.set(entry.kind, []);
    const slots = byKind.get(entry.kind);
    for (let d = 0; d <= MAX_DELAY; d++) {
      if (!slots[d]) slots[d] = [];
      if (!pad.slots[d]) pad.slots[d] = [];
      slots[d].push(got[d]);
      pad.slots[d].push(got[d]);
    }
  }
  if (pad.slots.length) byPad.push(pad);
}

const fmt = (n) => n.toFixed(3);
const stats = (list, i) => {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of list) {
    sum += v[i];
    if (v[i] < min) min = v[i];
    if (v[i] > max) max = v[i];
  }
  return { mean: sum / list.length, min, max, spread: max - min };
};

console.log(`sampleRate=${SR} block=${BLOCK} phases=${PHASES} sensitivity=${VOICE_DEFAULTS.sensitivity}`);
for (const [kind, slots] of byKind) {
  console.log(`\n${kind}  n=${slots[0].length} per delay`);
  console.log("  delay   low                    mid                    high                  worst spread");
  for (let d = 0; d <= MAX_DELAY; d++) {
    const s = [stats(slots[d], 0), stats(slots[d], 1), stats(slots[d], 2)];
    const worst = Math.max(s[0].spread, s[1].spread, s[2].spread);
    const cell = (x) => `${fmt(x.mean)} (${fmt(x.min)}-${fmt(x.max)})`;
    console.log(
      `  +${d}      ${cell(s[0]).padEnd(22)} ${cell(s[1]).padEnd(22)} ${cell(s[2]).padEnd(22)} ${fmt(worst)}`,
    );
  }
}

// Per pad, so a kind whose mean looks unstable can be read as either "the block phase
// moves it" (spread inside a pad) or "these two pads are different sounds" (tight pads,
// far apart from each other).
for (let d = 0; d <= MAX_DELAY; d++) {
  console.log(`\nper pad at delay +${d}:`);
  console.log("  pad        kind   low                    mid                    high                  worst spread");
  for (const pad of byPad) {
    const s = [stats(pad.slots[d], 0), stats(pad.slots[d], 1), stats(pad.slots[d], 2)];
    const worst = Math.max(s[0].spread, s[1].spread, s[2].spread);
    const cell = (x) => `${fmt(x.mean)} (${fmt(x.min)}-${fmt(x.max)})`;
    console.log(
      `  ${pad.name.padEnd(10)} ${pad.kind.padEnd(6)} ${cell(s[0]).padEnd(22)} ${cell(s[1]).padEnd(22)} ${cell(s[2]).padEnd(22)} ${fmt(worst)}`,
    );
  }
}

// The table as beat-classify.js wants it, one row per class in VOICE_CLASS order, at
// each delay — so adopting a different delay is a copy-paste rather than a re-derivation.
const ORDER = ["kick", "snare", "hat", "clap"];
for (let d = 0; d <= MAX_DELAY; d++) {
  console.log(`\nFACTORY_ATTACK at delay +${d}:`);
  for (const kind of ORDER) {
    const slots = byKind.get(kind);
    if (!slots) {
      console.log(`  // ${kind} NOT DETECTED`);
      continue;
    }
    const m = [0, 1, 2].map((i) => stats(slots[d], i).mean);
    console.log(`  [${m.map(fmt).join(", ")}], // ${kind}`);
  }
}

// The same table taken from one prototype pad per class — the pad that class actually
// fires, per DEFAULT_CLASS_PADS — instead of the mean over every pad of that kind.
// Averaging is wrong here whenever a kind holds two different sounds: the kick pads are
// a mid-dominated thump and a near-pure sine sub, and their mean describes neither, so
// a plain kick lands closer to the clap row than to its own. One prototype has no such
// failure mode and is the sound the class is named after.
for (let d = 0; d <= MAX_DELAY; d++) {
  console.log(`\nFACTORY_ATTACK from prototype pads at delay +${d}:`);
  for (let c = 0; c < DEFAULT_CLASS_PADS.length; c++) {
    const entry = DEFAULT_KIT_LAYOUT[DEFAULT_CLASS_PADS[c]];
    const pad = byPad.find((p) => p.name === entry.name);
    if (!pad) {
      console.log(`  // ${VOICE_CLASS_NAMES[c]} NOT DETECTED`);
      continue;
    }
    const m = [0, 1, 2].map((i) => stats(pad.slots[d], i).mean);
    console.log(`  [${m.map(fmt).join(", ")}], // ${VOICE_CLASS_NAMES[c]} — ${entry.name}`);
  }
}

// Separability at each delay: the nearest pair of class means, unweighted. A delay whose
// classes are further apart than its own phase spread is one stage 1 can commit on.
console.log("\nnearest pair of class means per delay (bigger is better):");
for (let d = 0; d <= MAX_DELAY; d++) {
  let worstPair = "";
  let worstD = Infinity;
  for (let a = 0; a < ORDER.length; a++) {
    for (let b = a + 1; b < ORDER.length; b++) {
      const sa = byKind.get(ORDER[a]);
      const sb = byKind.get(ORDER[b]);
      if (!sa || !sb) continue;
      let sum = 0;
      for (let i = 0; i < 3; i++) {
        const diff = stats(sa[d], i).mean - stats(sb[d], i).mean;
        sum += diff * diff;
      }
      const dist = Math.sqrt(sum);
      if (dist < worstD) {
        worstD = dist;
        worstPair = `${ORDER[a]}/${ORDER[b]}`;
      }
    }
  }
  console.log(`  +${d}  ${fmt(worstD)}  (${worstPair})`);
}
