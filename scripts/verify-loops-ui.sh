#!/usr/bin/env bash
# Loops workspace UI smoke test.
#
# Drives the running web dev server through the `mb` browser CLI and asserts the
# whole looper round trip: workspace switch, transport, record/close/overdub/undo,
# per-lane mixer, effect chain, waveform peaks, tap tempo, and restart replay.
#
# Usage: bun run dev (or vite --port 4200) in another shell, then:
#   bash scripts/verify-loops-ui.sh [url]
#
# Prints one line per check and exits non-zero on the first failure.
set -uo pipefail

URL="${1:-http://localhost:4200/}"
FAILED=0

code="$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)"
if [ "$code" != "200" ]; then
  echo "FAIL  dev server not reachable at $URL (got '$code')"
  exit 1
fi
echo "ok    dev server reachable"

run() { # run <label> <js>
  local label="$1" js="$2" out
  out="$(mb js "$js" 2>&1)"
  if [ "${out:0:3}" = "ok:" ]; then
    echo "ok    $label ${out:3}"
  else
    echo "FAIL  $label -> $out"
    FAILED=1
  fi
}

mb go "$URL" >/dev/null
mb wait 2500 >/dev/null

# The workspace switch, and no render crash.
run "loops workspace opens" '
(async () => {
  const b = [...document.querySelectorAll("button")].filter(x => x.textContent.trim() === "LOOPS");
  if (b.length !== 1) return "expected 1 LOOPS button, saw " + b.length;
  b[0].click();
  await new Promise(r => setTimeout(r, 300));   // let React paint the workspace
  if (window.__vkErr) return "render error: " + window.__vkErr;
  const names = [...document.querySelectorAll("input")].filter(i => /^LOOP \d$/.test(i.value));
  if (names.length !== 4) return "expected 4 lane name inputs, saw " + names.length;
  const canvases = document.querySelectorAll("canvas").length;
  if (canvases < 4) return "expected at least 4 canvases, saw " + canvases;
  return "ok: 4 lanes, " + canvases + " canvases";
})()'

# Engine up. A synthetic click is not user activation, so the context needs a
# manual resume in automation - a real user click resumes it for free.
run "engine starts" '
(async () => {
  const c = window.__vk;
  await c.start();
  const ctx = c.audioContext();
  if (ctx.state !== "running") await ctx.resume();
  await new Promise(r => setTimeout(r, 300));
  c.pollMeters();
  if (c.getSnapshot().status !== "running") return "status " + c.getSnapshot().status;
  if (!c.meters.clockRunning) return "clock not running";
  return "ok: sr " + c.sampleRate() + ", bpm " + c.meters.bpm.toFixed(1);
})()'

# Record, close, overdub, undo - the state machine, end to end, on lane 0.
run "record / close / overdub / undo" '
(async () => {
  const c = window.__vk;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  c.setQuantize(0);          // punch immediately, no grid wait
  c.setLoopSource(0, 1);     // DRUMS bus - the sandbox has no mic
  c.loopRecord(0);
  for (let i = 0; i < 8; i++) { c.triggerPad(i % 4, 1); await sleep(120); }
  c.loopRecord(0);
  await sleep(300); c.pollMeters();
  let m = c.meters.loops[0];
  if (m.state !== 2) return "after close, state " + m.state + " (want 2 PLAY)";
  if (m.frames <= 0) return "after close, frames " + m.frames;
  if (m.layers !== 1) return "after close, layers " + m.layers;
  const frames = m.frames;
  c.loopRecord(0);
  for (let i = 0; i < 4; i++) { c.triggerPad(4 + (i % 4), 1); await sleep(120); }
  c.loopRecord(0);
  await sleep(300); c.pollMeters();
  m = c.meters.loops[0];
  if (m.layers !== 2) return "after overdub, layers " + m.layers;
  c.loopUndo(0);
  await sleep(250); c.pollMeters();
  m = c.meters.loops[0];
  if (m.layers !== 1) return "after undo, layers " + m.layers;
  if (!m.canUndo) return "undo is a toggle, canUndo should stay true";
  if (m.frames !== frames) return "undo changed loop length";
  return "ok: " + frames + " frames, 2 layers -> undo -> 1";
})()'

run "stop / play" '
(async () => {
  const c = window.__vk;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  c.loopStop(0); await sleep(250); c.pollMeters();
  if (c.meters.loops[0].state !== 4) return "after stop, state " + c.meters.loops[0].state;
  c.loopPlay(0); await sleep(250); c.pollMeters();
  const a = c.meters.loops[0].position;
  await sleep(200); c.pollMeters();
  const b = c.meters.loops[0].position;
  if (c.meters.loops[0].state !== 2) return "after play, state " + c.meters.loops[0].state;
  if (a === b) return "playhead not advancing";
  return "ok: stopped then resumed";
})()'

run "waveform peaks" '
(async () => {
  const c = window.__vk;
  const pk = await c.getLoopPeaks(0, 64);
  if (!pk || pk.length !== 128) return "lane 0 peaks " + (pk ? pk.length : pk) + " (want 128)";
  let nz = 0; for (const v of pk) if (v !== 0) nz++;
  if (nz < 64) return "only " + nz + "/128 peak values are nonzero";
  const empty = await c.getLoopPeaks(3, 64);
  if (empty !== null) return "empty lane 3 should give null, gave " + empty;
  return "ok: 128 buckets, empty lane null";
})()'

run "loop effect chain" '
(async () => {
  const c = window.__vk;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const id = await c.addLoopEffect(0, "delay");
  await sleep(200); c.pollMeters();
  if (c.meters.loops[0].chainLength !== 1) return "chainLength " + c.meters.loops[0].chainLength;
  c.setLoopEffectMix(0, id, 0.5);
  c.setLoopEffectBypass(0, id, true);
  await sleep(150);
  const slot = c.getSnapshot().loops.tracks[0].chain[0];
  if (slot.mix !== 0.5 || slot.bypassed !== true) return "mix " + slot.mix + ", bypassed " + slot.bypassed;
  c.removeLoopEffect(0, id);
  await sleep(250); c.pollMeters();
  if (c.meters.loops[0].chainLength !== 0) return "after remove, chainLength " + c.meters.loops[0].chainLength;
  return "ok: add / mix / bypass / remove";
})()'

# Real clicks on the TAP button, 400 ms apart -> 150 bpm.
run "tap tempo" '
(async () => {
  const c = window.__vk;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tap = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "TAP");
  if (!tap) return "no TAP button";
  for (let i = 0; i < 5; i++) { tap.click(); await sleep(400); }
  await sleep(300); c.pollMeters();
  const bpm = c.getSnapshot().loops.bpm;
  if (Math.abs(bpm - 150) > 8) return "5 taps at 400 ms gave " + bpm.toFixed(1) + " bpm";
  if (Math.abs(c.meters.bpm - bpm) > 0.5) return "engine bpm " + c.meters.bpm + " vs ui " + bpm;
  return "ok: " + bpm.toFixed(1) + " bpm";
})()'

# A restart rebuilds the worklet: mixer, chain and transport replay, takes do not.
run "restart replays the deck, drops the takes" '
(async () => {
  const c = window.__vk;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  c.setLoopGain(0, -4.5); c.setLoopPan(0, 0.3); c.setLoopMute(0, true); c.setLoopName(0, "TAKE A");
  await c.addLoopEffect(0, "delay");
  await sleep(200);
  await c.applySettings({ bufferSize: 512 });
  await sleep(800);
  const ctx = c.audioContext();
  if (ctx.state !== "running") await ctx.resume();
  await sleep(400); c.pollMeters();
  const t = c.getSnapshot().loops.tracks[0];
  if (t.name !== "TAKE A" || t.gain !== -4.5 || t.pan !== 0.3 || t.mute !== true) return "mixer did not replay: " + JSON.stringify(t);
  if (c.meters.loops[0].chainLength !== 1) return "chain did not replay, chainLength " + c.meters.loops[0].chainLength;
  if (!c.meters.clockRunning) return "transport did not replay";
  if (c.meters.loops[0].frames !== 0 || c.meters.loops[0].layers !== 0) return "take survived a restart, it should not";
  return "ok: mixer + chain + transport replayed, take dropped";
})()'

run "no console errors" '(() => window.__vkErr ? "render error: " + window.__vkErr : "ok:")()'

if [ "$FAILED" -ne 0 ]; then
  echo "loops ui: FAILED"
  exit 1
fi
echo "loops ui: all checks passed"
