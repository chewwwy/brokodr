/**
 * Numeric verification for the sample-edit maths. Run with `bun scripts/verify-sample-edit.ts`.
 *
 * Companion to `verify-dsp.mjs`, which covers the DSP core in plain Node. This module is
 * TypeScript and lives in the app tree, so it needs Bun to run — but the reason to test it
 * is the same: it is the shared arithmetic behind both the sample editor and file export,
 * so a regression here quietly corrupts what users save to disk.
 */
import {
  applyFades,
  applyGain,
  buildPeaks,
  cropTo,
  dbToGain,
  defaultEdit,
  findContentBounds,
  isIdentityEdit,
  normalizeTo,
  peakOf,
  renderEdit,
  reverseBuffer,
  rmsDb,
  shiftSlices,
  sliceEvenly,
  slicesFromOnsets,
  toMono,
  toMonoBuffer,
  type StereoBuffer,
} from "../packages/web/src/web/audio/sample-edit";
import { processForExport, DEFAULT_EXPORT } from "../packages/web/src/web/audio/recorder";

const SR = 48000;
let checks = 0;
let failures = 0;

function ok(name: string, cond: boolean, detail = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  } else console.log(`ok    ${name} ${detail}`);
}

function buf(n: number, fn: (i: number) => number): StereoBuffer {
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = fn(i);
    r[i] = fn(i);
  }
  return { l, r };
}
const sine = (n: number, hz: number, amp = 0.5) => buf(n, (i) => amp * Math.sin((2 * Math.PI * hz * i) / SR));
const finite = (a: Float32Array) => a.every(Number.isFinite);

console.log("== sample-edit: primitives ==");
{
  ok("dbToGain: 0 dB is unity", Math.abs(dbToGain(0) - 1) < 1e-9);
  ok("dbToGain: -6 dB is about half", Math.abs(dbToGain(-6) - 0.5012) < 1e-3);

  const b = sine(1000, 440, 0.5);
  ok("peakOf: finds the peak", Math.abs(peakOf(b.l, b.r) - 0.5) < 1e-3);
  ok("rmsDb: a 0.5 sine is about -9 dBFS", Math.abs(rmsDb(b.l, b.r) + 9.03) < 0.2, rmsDb(b.l, b.r).toFixed(2));
  ok("rmsDb: silence is -Infinity", rmsDb(new Float32Array(10), new Float32Array(10)) === -Infinity);

  // Non-destructive is the whole contract of this module: the editor re-renders on every
  // mouse move and would eat its own source if any of these wrote through.
  const src = sine(1000, 440);
  const before = src.l.slice();
  cropTo(src, 100, 200);
  renderEdit(src, SR, { ...defaultEdit(1000), gainDb: -6, normalizeDb: -1, reverse: true });
  ok("source is never modified", src.l.every((v, i) => v === before[i]));

  const c = cropTo(src, 100, 200);
  ok("cropTo: returns the requested span", c.l.length === 100);
  ok("cropTo: returns a copy, not a view", c.l.buffer !== src.l.buffer);
  ok("cropTo: clamps out-of-range bounds", cropTo(src, -50, 99999).l.length === 1000);
  ok("cropTo: an inverted range is empty, not negative", cropTo(src, 500, 100).l.length === 0);

  const g = sine(100, 440, 0.5);
  applyGain(g, 2);
  ok("applyGain: scales", Math.abs(peakOf(g.l, g.r) - 1.0) < 1e-3);

  const nz = sine(100, 440, 0.1);
  normalizeTo(nz, 0);
  ok("normalizeTo: hits the target", Math.abs(peakOf(nz.l, nz.r) - 1) < 1e-3, peakOf(nz.l, nz.r).toFixed(4));
  const nzq = sine(100, 440, 0.1);
  normalizeTo(nzq, -6);
  ok("normalizeTo: respects a negative target", Math.abs(peakOf(nzq.l, nzq.r) - dbToGain(-6)) < 1e-3);
  // Normalising silence would multiply by 1/0 and fill the buffer with NaN or noise.
  const sil: StereoBuffer = { l: new Float32Array(100), r: new Float32Array(100) };
  normalizeTo(sil, 0);
  ok("normalizeTo: leaves silence alone", peakOf(sil.l, sil.r) === 0 && finite(sil.l));

  const rev = buf(5, (i) => i / 10);
  reverseBuffer(rev);
  ok("reverseBuffer: reverses", Math.abs(rev.l[0] - 0.4) < 1e-6 && Math.abs(rev.l[4] - 0) < 1e-6);

  const mo: StereoBuffer = { l: Float32Array.from([1, 1]), r: Float32Array.from([-1, 0]) };
  toMono(mo);
  ok("toMono: averages the channels", mo.l[0] === 0 && mo.l[1] === 0.5 && mo.r[1] === 0.5);

  const mb = toMonoBuffer({ l: Float32Array.from([1, 1]), r: Float32Array.from([-1, 0]) });
  ok("toMonoBuffer: sums into a new array", mb.length === 2 && mb[0] === 0 && mb[1] === 0.5);
}

console.log("\n== sample-edit: fades ==");
{
  const f = buf(SR, () => 1);
  applyFades(f, SR, 100, 100);
  ok("applyFades: starts at silence", Math.abs(f.l[0]) < 1e-6);
  ok("applyFades: ends at silence", Math.abs(f.l[f.l.length - 1]) < 1e-6);
  ok("applyFades: reaches full level in the middle", Math.abs(f.l[SR / 2] - 1) < 1e-6);
  // Equal-power, not linear: the halfway point of a fade sits at sin(pi/4) = 0.707, and
  // that is the whole reason for the curve — a linear ramp dips audibly here.
  const mid = f.l[Math.round(0.05 * SR)];
  ok("applyFades: is equal-power, not linear", Math.abs(mid - Math.SQRT1_2) < 0.02, mid.toFixed(4));

  // A fade longer than the sample must not run off the end or invert.
  const short = buf(100, () => 1);
  applyFades(short, SR, 5000, 5000);
  ok("applyFades: a fade longer than the sample is clamped", finite(short.l) && short.l.every((v) => v >= -1 && v <= 1));

  const none = buf(100, () => 1);
  applyFades(none, SR, 0, 0);
  ok("applyFades: zero-length fades change nothing", none.l.every((v) => v === 1));
}

console.log("\n== sample-edit: content bounds ==");
{
  // Silence, then a tone, then silence.
  const n = SR;
  const b = buf(n, (i) => (i > 10000 && i < 20000 ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) : 0));
  const bounds = findContentBounds(b, SR, -40);
  ok("findContentBounds: finds the start", Math.abs(bounds.start - 10000) < 0.01 * SR, `${bounds.start}`);
  ok("findContentBounds: finds the end", Math.abs(bounds.end - 20000) < 0.01 * SR, `${bounds.end}`);
  // The pre-roll is what stops the very transient that crossed the threshold being cut.
  ok("findContentBounds: keeps pre-roll before the transient", bounds.start < 10000);
  // Trimming a silent buffer to nothing is never what the user meant.
  const allQuiet = buf(1000, () => 0);
  const q = findContentBounds(allQuiet, SR, -40);
  ok("findContentBounds: silence yields the whole buffer, not an empty one", q.start === 0 && q.end === 1000);
}

console.log("\n== sample-edit: renderEdit ==");
{
  const src = sine(SR, 440, 0.25);

  const e = defaultEdit(SR);
  ok("defaultEdit: spans the whole buffer", e.startFrame === 0 && e.endFrame === SR);
  ok("isIdentityEdit: a default edit is not identity (it has a fade-out)", !isIdentityEdit(e, SR));
  ok("isIdentityEdit: recognises a true no-op", isIdentityEdit({ ...e, fadeOutMs: 0 }, SR));

  const cropped = renderEdit(src, SR, { ...e, startFrame: 1000, endFrame: 2000, fadeOutMs: 0 });
  ok("renderEdit: crops", cropped.l.length === 1000);

  const boosted = renderEdit(src, SR, { ...e, gainDb: 6, fadeOutMs: 0 });
  ok("renderEdit: applies gain", Math.abs(peakOf(boosted.l, boosted.r) - 0.25 * dbToGain(6)) < 1e-3);

  // Normalise must run after gain, or gain silently undoes it.
  const norm = renderEdit(src, SR, { ...e, gainDb: -40, normalizeDb: 0, fadeOutMs: 0 });
  ok("renderEdit: normalise overrides gain rather than stacking with it",
    Math.abs(peakOf(norm.l, norm.r) - 1) < 1e-3, peakOf(norm.l, norm.r).toFixed(4));

  // Fades must run after normalise, or the fade-in's silent head becomes the peak the
  // normaliser divides by and the sample comes out far too loud.
  const nf = renderEdit(src, SR, { ...e, normalizeDb: 0, fadeInMs: 50, fadeOutMs: 50 });
  ok("renderEdit: fades run after normalise", Math.abs(peakOf(nf.l, nf.r) - 1) < 1e-2, peakOf(nf.l, nf.r).toFixed(4));
  ok("renderEdit: faded edges are silent", Math.abs(nf.l[0]) < 1e-6 && Math.abs(nf.l[nf.l.length - 1]) < 1e-6);

  const rev = renderEdit(buf(10, (i) => i / 10), SR, { ...defaultEdit(10), fadeOutMs: 0 });
  const revd = renderEdit(buf(10, (i) => i / 10), SR, { ...defaultEdit(10), fadeOutMs: 0, reverse: true });
  ok("renderEdit: reverses", Math.abs(revd.l[0] - rev.l[9]) < 1e-6);

  // Reverse happens after crop, so it reverses what you kept — not the whole take.
  const cr = renderEdit(buf(100, (i) => i), SR, { ...defaultEdit(100), startFrame: 10, endFrame: 20, fadeOutMs: 0, reverse: true });
  ok("renderEdit: reverse applies to the cropped region", cr.l[0] === 19 && cr.l[9] === 10);

  const mono = renderEdit({ l: Float32Array.from([1, 1]), r: Float32Array.from([-1, -1]) }, SR,
    { ...defaultEdit(2), fadeOutMs: 0, mono: true });
  ok("renderEdit: sums to mono", mono.l[0] === 0 && mono.r[0] === 0);

  ok("renderEdit: an empty crop does not throw",
    renderEdit(src, SR, { ...e, startFrame: 500, endFrame: 500 }).l.length === 0);
  ok("renderEdit: output stays finite", finite(renderEdit(src, SR, { ...e, gainDb: 24, normalizeDb: -1 }).l));
}

console.log("\n== sample-edit: waveform peaks ==");
{
  const b = sine(SR, 440, 0.8);
  const p = buildPeaks(b, 200);
  ok("buildPeaks: returns min and max per point", p.length === 400);
  ok("buildPeaks: max is positive, min is negative", p[1] > 0 && p[0] < 0);
  ok("buildPeaks: tracks the peak", Math.abs(p[1] - 0.8) < 0.05, p[1].toFixed(3));

  // Asymmetry is the reason for min/max rather than one absolute peak — a signal that only
  // swings positive must not be drawn as if it swings both ways.
  const asym = buf(SR, (i) => Math.max(0, Math.sin((2 * Math.PI * 440 * i) / SR)));
  const ap = buildPeaks(asym, 100);
  ok("buildPeaks: shows asymmetry", ap[1] > 0.5 && Math.abs(ap[0]) < 1e-6, `min=${ap[0]} max=${ap[1].toFixed(3)}`);

  // Zoomed in past one frame per pixel there must be no gaps in the drawing.
  const z = buildPeaks(b, 500, 1000, 1010);
  let gaps = 0;
  for (let i = 0; i < 500; i++) if (z[i * 2] === 0 && z[i * 2 + 1] === 0) gaps++;
  ok("buildPeaks: no gaps when zoomed past one frame per point", gaps < 250, `${gaps}/500 empty`);

  ok("buildPeaks: a window reads from the window", buildPeaks(b, 10, 0, 10).length === 20);
  ok("buildPeaks: an empty source is all zeros",
    buildPeaks({ l: new Float32Array(0), r: new Float32Array(0) }, 50).every((v) => v === 0));
  ok("buildPeaks: zero points does not throw", buildPeaks(b, 0).length === 0);
}

console.log("\n== sample-edit: even slicing ==");
{
  const s = sliceEvenly(1000, 16);
  ok("sliceEvenly: produces the requested count", s.length === 16);
  ok("sliceEvenly: starts at zero", s[0].startFrame === 0);
  ok("sliceEvenly: the last slice reaches the end", s[15].endFrame === 1000);
  // Tiling with no gaps is what makes playing the pads in order reproduce the recording.
  let contiguous = true;
  for (let i = 1; i < s.length; i++) if (s[i].startFrame !== s[i - 1].endFrame) contiguous = false;
  ok("sliceEvenly: slices tile without gaps or overlap", contiguous);
  ok("sliceEvenly: nothing from an empty buffer", sliceEvenly(0, 16).length === 0);
  // Fewer frames than slices must not produce zero-length pads.
  ok("sliceEvenly: never emits an empty slice", sliceEvenly(5, 16).every((x) => x.endFrame > x.startFrame));
}

console.log("\n== recorder: export still agrees with the shared maths ==");
{
  // processForExport() was rewritten to call this module. Its observable behaviour must
  // not have changed — these assert the contract the export dialog depends on.
  const src = sine(SR, 440, 0.25);
  const plain = processForExport(src, SR, { ...DEFAULT_EXPORT, fadeOutMs: 0 });
  ok("export: untouched options return the same length", plain.l.length === SR);
  ok("export: returns a copy", plain.l.buffer !== src.l.buffer);

  const normed = processForExport(src, SR, { ...DEFAULT_EXPORT, fadeOutMs: 0, normalizeDb: 0 });
  ok("export: normalise reaches the target", Math.abs(peakOf(normed.l, normed.r) - 1) < 1e-3);

  const faded = processForExport(src, SR, { ...DEFAULT_EXPORT, fadeOutMs: 10 });
  ok("export: fade-out ends in silence", Math.abs(faded.l[faded.l.length - 1]) < 1e-6);

  const padded = buf(SR, (i) => (i > 10000 && i < 20000 ? 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) : 0));
  const trimmed = processForExport(padded, SR, { ...DEFAULT_EXPORT, fadeOutMs: 0, trimSilenceDb: -40 });
  ok("export: silence trimming shortens the file", trimmed.l.length < SR && trimmed.l.length > 9000,
    `${trimmed.l.length} frames`);

  const monoed = processForExport(
    { l: Float32Array.from([1, 1]), r: Float32Array.from([-1, -1]) }, SR,
    { ...DEFAULT_EXPORT, fadeOutMs: 0, mono: true });
  ok("export: mono sums the channels", monoed.l[0] === 0);

  ok("export: output stays finite", finite(faded.l) && finite(normed.l) && finite(trimmed.l));
}

console.log("\n== sample-edit: onsets to slices ==");
{
  const feats = [
    [1, 0, 0, 0.1],
    [0, 1, 0, 0.3],
    [0, 0, 1, 0.7],
  ];

  const s = slicesFromOnsets([100, 500, 900], [1, 0.8, 0.6], feats, 2000);
  ok("slices: one per onset", s.length === 3);
  ok("slices: start on the onsets", s[0].startFrame === 100 && s[1].startFrame === 500 && s[2].startFrame === 900);
  // The whole point of onset→next-onset: the pieces must tile with no gaps, or playing the
  // pads in order does not reproduce the recording.
  ok("slices: tile with no gaps", s[0].endFrame === s[1].startFrame && s[1].endFrame === s[2].startFrame);
  ok("slices: the last one runs to the end", s[2].endFrame === 2000);
  ok("slices: carry strength", s[1].strength === 0.8);
  ok("slices: carry features", s[2].features[2] === 1);

  // maxSlices truncates, and the last KEPT slice must still reach the end of the audio —
  // the regression here would be a slice that stops at the next, discarded onset.
  const capped = slicesFromOnsets([100, 500, 900, 1400], [1, 1, 1, 1], feats, 2000, 2);
  ok("slices: maxSlices caps the count", capped.length === 2);
  ok("slices: the last kept slice still reaches the end", capped[1].endFrame === 2000, `${capped[1].endFrame}`);

  ok("slices: no onsets gives no slices", slicesFromOnsets([], [], [], 2000).length === 0);
  ok("slices: maxSlices of zero gives none", slicesFromOnsets([10], [1], feats, 100, 0).length === 0);

  // A detector that reported a hit past the end of the buffer must not produce a slice
  // that reads out of bounds.
  const over = slicesFromOnsets([100, 5000], [1, 1], feats, 2000);
  ok("slices: never run past the buffer", over.every((x) => x.endFrame <= 2000 && x.endFrame > x.startFrame));

  // Degenerate: two onsets on the same frame would be a zero-length slice, which every
  // downstream consumer would then have to special-case. It is dropped instead.
  const dupe = slicesFromOnsets([100, 100, 400], [1, 1, 1], feats, 2000);
  ok("slices: zero-length slices are dropped", dupe.every((x) => x.endFrame > x.startFrame));

  // Missing feature/strength rows must not throw — the detector and this can disagree in
  // length if one is ever changed without the other.
  const ragged = slicesFromOnsets([100, 400], [1], [], 2000);
  ok("slices: tolerate short strength/feature arrays",
    ragged.length === 2 && ragged[1].strength === 1 && ragged[1].features.length === 4);
}

console.log("\n== sample-edit: the editor's send-to-pad path ==");
{
  // What the sample editor actually does when you hit a pad button: render the edit, then
  // sum to mono for the voice. These assert the two halves line up.
  const src = sine(SR, 440, 0.8);
  const edit = { ...defaultEdit(SR), startFrame: 1000, endFrame: 5000, normalizeDb: -1, fadeOutMs: 2 };
  const rendered = renderEdit(src, SR, edit);
  ok("send: renders the trimmed length", rendered.l.length === 4000, `${rendered.l.length}`);
  ok("send: source is untouched", src.l.length === SR && Math.abs(peakOf(src.l, src.r) - 0.8) < 1e-3);

  const mono = toMonoBuffer(rendered);
  ok("send: mono buffer matches the rendered length", mono.length === rendered.l.length);
  ok("send: mono buffer is finite", finite(mono));
  // Normalise ran before the fade, so the peak is at the target and only the tail is down.
  ok("send: normalised to the target", Math.abs(20 * Math.log10(Math.max(...Array.from(mono, Math.abs))) + 1) < 0.2);

  // Slices go to pads with their own bounds and no fade-in — asserted here because a
  // fade-in per slice would shave the attack off every single pad.
  const sliceEdit = { ...defaultEdit(SR), startFrame: 2000, endFrame: 2400, fadeInMs: 0, fadeOutMs: 4 };
  const cut = renderEdit(src, SR, sliceEdit);
  ok("send: a slice keeps its first sample intact", Math.abs(cut.l[0] - src.l[2000]) < 1e-6);
}

console.log("\n== sample-edit: slicing a trimmed region ==");
{
  // The editor slices the kept region, then shifts the result back into source frames. If
  // that shift is wrong, every pad plays the wrong part of the take — and it is wrong in a
  // way that still looks plausible on screen, so it is pinned down numerically here.
  const evenly = sliceEvenly(1000, 4);
  const shifted = shiftSlices(evenly, 500);
  ok("shift: slice count is unchanged", shifted.length === evenly.length);
  ok("shift: the first slice starts at the offset", shifted[0].startFrame === 500);
  ok(
    "shift: every slice moved by exactly the offset",
    shifted.every((s, i) => s.startFrame === evenly[i].startFrame + 500 && s.endFrame === evenly[i].endFrame + 500),
  );
  ok("shift: durations survive the move", shifted.every((s, i) => s.endFrame - s.startFrame === evenly[i].endFrame - evenly[i].startFrame));
  ok("shift: the last slice ends at offset + region length", shifted[shifted.length - 1].endFrame === 1500);
  ok("shift: strength and features are carried through", shifted.every((s, i) => s.strength === evenly[i].strength && s.features.length === evenly[i].features.length));
  ok("shift: a zero offset is a no-op", shiftSlices(evenly, 0) === evenly);
  ok("shift: an empty list stays empty", shiftSlices([], 500).length === 0);

  // End to end, the way the editor actually composes it: trim to a region, slice that
  // region evenly, shift back, and the slices must tile exactly the trimmed part of the
  // source — never the silence outside it.
  const src = sine(SR, 220);
  const e = { ...defaultEdit(src.l.length), startFrame: 12000, endFrame: 36000 };
  const region = renderEdit(src, SR, { ...defaultEdit(src.l.length), startFrame: e.startFrame, endFrame: e.endFrame });
  ok("trimmed slice: the region is the kept length", region.l.length === 24000);
  const cuts = shiftSlices(sliceEvenly(region.l.length, 16), e.startFrame);
  ok("trimmed slice: 16 slices come back", cuts.length === 16);
  ok("trimmed slice: the first starts at the trim start", cuts[0].startFrame === e.startFrame);
  ok("trimmed slice: the last ends at the trim end", cuts[cuts.length - 1].endFrame === e.endFrame);
  ok(
    "trimmed slice: they tile the region with no gaps or overlap",
    cuts.every((s, i) => (i === 0 ? true : s.startFrame === cuts[i - 1].endFrame)),
  );
  ok("trimmed slice: none reaches outside the trim", cuts.every((s) => s.startFrame >= e.startFrame && s.endFrame <= e.endFrame));
  // And the audio a slice renders is the audio at that spot in the source, not offset from it.
  const first = renderEdit(src, SR, { ...defaultEdit(src.l.length), startFrame: cuts[0].startFrame, endFrame: cuts[0].endFrame });
  ok("trimmed slice: slice audio lines up with the source", Math.abs(first.l[0] - src.l[e.startFrame]) < 1e-6);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
