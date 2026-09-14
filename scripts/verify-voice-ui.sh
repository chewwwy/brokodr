#!/usr/bin/env bash
# Smart Voice (BROBEATS VOICE tab) UI smoke test.
#
# Drives the running web dev server through the `mb` browser CLI and asserts the panel
# end to end: tab switch, master switch, detector controls, class routing, live
# detection, a real calibration pass, its undo, and the disarm-on-look-away guard.
#
# The sandbox has no microphone, so the test feeds the engine itself: a BufferSource of
# synthetic transients wired straight into the worklet node's input, which is the same
# place a `createMediaStreamSource` would land. That exercises the whole detector —
# onset, classification, capture ring, training — with nothing faked above the driver.
#
# Usage: bun run dev (or vite --port 4200) in another shell, then:
#   bash scripts/verify-voice-ui.sh [url]
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

# Test harness: the signal driver, plus the DOM helpers every check below shares.
# Installed once into the page so each check stays about the thing it is checking.
run "harness installs" '
(() => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const panel = () => {
    const tag = [...document.querySelectorAll("span")].find(s => s.textContent.trim() === "SMART VOICE");
    return tag ? tag.closest(".vk-panel") : null;
  };
  const btn = (text, root) =>
    [...(root || panel() || document).querySelectorAll("button")].filter(b => b.textContent.trim() === text);
  // Tab buttons all carry a title; the pad editor also has a VOICE chip, which does not.
  const tab = label => {
    const b = [...document.querySelectorAll("button")].filter(x => x.textContent.trim() === label && x.title);
    if (b.length !== 1) throw new Error("expected 1 " + label + " tab button, saw " + b.length);
    b[0].click();
  };
  // React tracks the value it last rendered, so a bare `el.value = x` is invisible to it.
  const setSelect = (el, v) => {
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
    set.call(el, String(v));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  // One synthetic hit per class shape: kick is a low body, snare broadband noise, hat a
  // short bright hiss, clap a mid splash. Not convincing beatboxing - just four
  // spectrally distinct transients the onset detector will punch on.
  const write = (d, off, sr, kind) => {
    const n = Math.floor(sr * 0.05);
    for (let i = 0; i < n; i++) {
      const t = i / sr, nz = Math.random() * 2 - 1;
      let v = 0;
      if (kind === 0) v = (Math.sin(2 * Math.PI * 62 * t) * 0.95 + nz * 0.08) * Math.exp(-t * 45);
      else if (kind === 1) v = (nz * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * Math.exp(-t * 60);
      else if (kind === 2) v = (nz - (d[off + i - 1] || 0) * 0.0) * Math.exp(-t * 320) * 0.75;
      else v = (nz * 0.7 + Math.sin(2 * Math.PI * 900 * t) * 0.3) * Math.exp(-t * 90);
      d[off + i] += v * 0.7;
    }
  };
  // kinds: array of hit shapes, one per hit, played gapMs apart. Resolves when the last
  // one has had time to be classified.
  const inject = async (kinds, gapMs = 300) => {
    const c = window.__vk, ctx = c.audioContext(), node = c.backend.node;
    if (!ctx || !node) throw new Error("engine not running");
    const sr = ctx.sampleRate;
    const len = Math.ceil(sr * ((kinds.length * gapMs) / 1000 + 0.4));
    const buf = ctx.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      kinds.forEach((k, h) => write(d, Math.floor(sr * (0.15 + (h * gapMs) / 1000)), sr, k));
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(node);
    src.start();
    await sleep(kinds.length * gapMs + 500);
    try { src.disconnect(); } catch {}
    c.pollMeters();
  };
  // Waits for the panel text to say something, so the test follows the flow the user
  // sees rather than the state behind it.
  const until = async (pred, ms = 6000) => {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (pred()) return true;
      await sleep(120);
    }
    return false;
  };
  window.__vt = { sleep, panel, btn, tab, setSelect, inject, until, text: () => (panel() || {}).textContent || "" };
  return "ok:";
})()'

# The tab switch, and no render crash on mount.
run "voice tab opens" '
(async () => {
  const t = window.__vt;
  t.tab("BROBEATS");
  await t.sleep(200);
  t.tab("VOICE");
  await t.sleep(300);
  if (window.__vkErr) return "render error: " + window.__vkErr;
  const p = t.panel();
  if (!p) return "no SMART VOICE panel in the DOM";
  if (p.closest(".hidden")) return "panel is still hidden after switching to VOICE";
  const txt = p.textContent;
  for (const want of ["SMART VOICE", "LISTENING", "TRIGGER", "DECISION", "VELOCITY", "ROUTING", "CALIBRATION"]) {
    if (!txt.includes(want)) return "panel is missing the " + want + " section";
  }
  return "ok: panel mounted, 7 sections";
})()'

# Engine up. A synthetic click is not user activation, so the context needs a manual
# resume in automation - a real user click resumes it for free.
run "engine starts" '
(async () => {
  const c = window.__vk;
  await c.start();
  const ctx = c.audioContext();
  if (ctx.state !== "running") await ctx.resume();
  await new Promise(r => setTimeout(r, 400));
  c.pollMeters();
  if (c.getSnapshot().status !== "running") return "status " + c.getSnapshot().status;
  if (!c.backend.node) return "no worklet node to drive";
  return "ok: sr " + c.sampleRate() + ", input " + (c.getSnapshot().info.inputActive ? "live" : "none (synthetic)");
})()'

# The master switch, from the DOM, both ways - and it must reach the engine, not just
# the snapshot.
run "master switch" '
(async () => {
  const c = window.__vk, t = window.__vt;
  c.setVoiceEnabled(false);
  await t.sleep(200);
  const off = t.btn("OFF");
  if (off.length !== 1) return "expected 1 OFF toggle, saw " + off.length;
  off[0].click();
  await t.sleep(250); c.pollMeters();
  if (!(c.getSnapshot().kit.voice.params.enabled >= 0.5)) return "click did not set params.enabled";
  if (!c.meters.voice.enabled) return "engine still reports the detector off";
  const on = t.btn("DETECTING");
  if (on.length !== 1) return "expected 1 DETECTING toggle, saw " + on.length;
  on[0].click();
  await t.sleep(250); c.pollMeters();
  if (c.getSnapshot().kit.voice.params.enabled >= 0.5) return "second click did not switch it back off";
  if (c.meters.voice.enabled) return "engine still reports the detector on";
  return "ok: off -> on -> off, snapshot and engine agree";
})()'

# The detector controls: the select goes through the DOM, the knobs through the client
# (a knob is a pointer drag, which tells us nothing extra here), then RESET CONTROLS.
run "detector controls" '
(async () => {
  const c = window.__vk, t = window.__vt;
  const p = t.panel();
  const sels = [...p.querySelectorAll("select")];
  const mode = sels.find(s => [...s.options].some(o => o.textContent.trim() === "ACCURATE"));
  if (!mode) return "no mode select in the grid";
  if ([...mode.options].map(o => o.textContent.trim()).join(",") !== "FAST,ACCURATE") {
    return "mode options are " + [...mode.options].map(o => o.textContent.trim()).join(",");
  }
  if (mode.value !== "0") return "mode should default to FAST (0), select reads " + mode.value;
  t.setSelect(mode, 1);
  await t.sleep(200);
  if (c.getSnapshot().kit.voice.params.mode !== 1) return "ACCURATE did not reach the profile";
  const knobs = p.querySelectorAll(".vk-knob, canvas");
  c.setVoiceParam("sensitivity", 2.5);
  c.setVoiceParam("floorDb", -30);
  c.setVoiceParam("minGapMs", 55);
  await t.sleep(200);
  const v = c.getSnapshot().kit.voice.params;
  if (v.sensitivity !== 2.5 || v.floorDb !== -30 || v.minGapMs !== 55) return "params did not take: " + JSON.stringify(v);
  const reset = t.btn("RESET CONTROLS");
  if (reset.length !== 1) return "no RESET CONTROLS button";
  reset[0].click();
  await t.sleep(250);
  const d = c.getSnapshot().kit.voice.params;
  if (d.mode !== 0 || d.sensitivity === 2.5 || d.floorDb === -30) return "reset left " + JSON.stringify(d);
  if (t.panel().querySelectorAll("select")[0].value !== "0") return "select did not follow the reset";
  return "ok: mode via DOM, 3 params, reset (" + knobs.length + " knob widgets)";
})()'

# Class -> pad routing, read and written through the selects.
run "class routing" '
(async () => {
  const c = window.__vk, t = window.__vt;
  const p = t.panel();
  const rows = [...p.querySelectorAll("select")].filter(s => [...s.options].some(o => o.textContent.includes("MUTE")));
  if (rows.length !== 4) return "expected 4 routing selects, saw " + rows.length;
  const pads = c.getSnapshot().kit.voice.classPads;
  for (let i = 0; i < 4; i++) {
    if (rows[i].value !== String(pads[i])) return "class " + i + " select reads " + rows[i].value + ", profile says " + pads[i];
  }
  if (rows[0].options.length !== 17) return "pad list is " + rows[0].options.length + " long, want 17 (mute + 16)";
  const name = c.getSnapshot().kit.pads[6].name;
  if (!rows[0].options[7].textContent.includes(name)) return "option 7 does not name pad 7 (" + name + ")";
  t.setSelect(rows[0], 6);
  await t.sleep(200);
  if (c.getSnapshot().kit.voice.classPads[0] !== 6) return "kick did not move to pad 7";
  t.setSelect(rows[3], -1);
  await t.sleep(200);
  if (c.getSnapshot().kit.voice.classPads[3] !== -1) return "clap did not mute";
  c.pollMeters();
  if (c.meters.voice.classPads[0] !== 6) return "engine routing table says " + c.meters.voice.classPads[0];
  t.setSelect(rows[0], pads[0]);
  t.setSelect(rows[3], pads[3]);
  await t.sleep(200);
  return "ok: 4 rows read + written, engine table agrees";
})()'

# Live detection, all the way through: synthetic transients in, hits and a decision out,
# and the scope readout following it.
run "live detection" '
(async () => {
  const c = window.__vk, t = window.__vt;
  c.setVoiceEnabled(true);
  c.resetVoiceDetector();
  await t.sleep(250); c.pollMeters();
  if (c.meters.voice.hits !== 0) return "detector did not zero, hits " + c.meters.voice.hits;
  await t.inject([0, 1, 2, 3, 0, 1], 300);
  const m = c.meters.voice;
  if (m.onsets < 6) return "6 transients gave " + m.onsets + " onsets";
  if (m.hits < 6) return "6 onsets gave " + m.hits + " hits (gate or velocity floor eating them)";
  if (m.lastClass < 0 || m.lastClass > 3) return "lastClass " + m.lastClass;
  if (!(m.lastConf > 0)) return "confidence " + m.lastConf;
  if (!(m.lastVel > 0)) return "velocity " + m.lastVel;
  if (m.lastStage !== 1 && m.lastStage !== 2) return "stage " + m.lastStage;
  const conf = [...t.panel().querySelectorAll("span")].find(s => s.textContent.trim().startsWith("CONF"));
  if (!conf) return "no CONF readout";
  const shown = conf.lastElementChild.textContent.trim();
  if (!shown.endsWith("%")) return "CONF readout reads " + JSON.stringify(shown);
  return "ok: " + m.onsets + " onsets, " + m.hits + " hits, last " + m.lastClass + " at " + shown;
})()'

# A real calibration pass on one class, clicked through the panel.
run "calibration pass trains a class" '
(async () => {
  const c = window.__vk, t = window.__vt;
  c.setVoiceEnabled(true);
  c.resetVoiceCalibration(-1);
  await t.sleep(250);
  if (c.getSnapshot().kit.voice.trained.some(x => x > 0)) return "profile did not go back to factory";
  const train = t.btn("TRAIN");
  if (train.length !== 4) return "expected 4 per-class TRAIN buttons, saw " + train.length;
  train[0].click();
  if (!(await t.until(() => t.text().includes("GET READY")))) return "no GET READY prompt";
  if (!(await t.until(() => t.text().includes("GIVE ME 8 KICKS"), 3000))) return "never armed: " + t.text().slice(0, 120);
  c.pollMeters();
  if (c.meters.voice.captureClass !== 0) return "engine capture class is " + c.meters.voice.captureClass + ", want 0";
  await t.inject([0, 0, 0, 0, 0, 0, 0, 0], 280);
  if (!(await t.until(() => t.text().includes("CALIBRATION RESULT")))) {
    c.pollMeters();
    return "never reached review, captureCount " + c.meters.voice.captureCount + ", text " + t.text().slice(0, 160);
  }
  const v = c.getSnapshot().kit.voice;
  if (!(v.trained[0] >= 3)) return "kick trained on " + v.trained[0] + " hits, want 3+";
  if (v.trained.slice(1).some(x => x > 0)) return "a class nobody recorded got trained: " + JSON.stringify(v.trained);
  if (!/used \d+ of \d+/.test(t.text())) return "review does not report the hits it used: " + t.text().slice(0, 200);
  c.pollMeters();
  if (c.meters.voice.captureClass !== -1) return "capture still armed after the pass";
  return "ok: 8 hits in, kick trained on " + v.trained[0];
})()'

# Undo is a restore, not a reset - the whole profile as it was before the pass.
run "undo restores the profile" '
(async () => {
  const c = window.__vk, t = window.__vt;
  const before = c.getSnapshot().kit.voice.centroids.slice();
  const undo = t.btn("UNDO");
  if (undo.length !== 1) return "expected 1 UNDO button on the review screen, saw " + undo.length;
  undo[0].click();
  await t.sleep(300);
  const v = c.getSnapshot().kit.voice;
  if (v.trained[0] !== 0) return "kick is still trained after undo (" + v.trained[0] + ")";
  let moved = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== v.centroids[i]) moved++;
  if (moved === 0) return "undo changed nothing, so the pass had not actually moved the centroids";
  if (!t.text().includes("FACTORY")) return "idle screen does not read FACTORY again";
  return "ok: back to factory, " + moved + " centroid values restored";
})()'

# The guard that matters: looking away mid-pass has to disarm, because capture
# suppresses pad firing and a forgotten arm reads as a broken feature.
run "looking away mid-pass disarms" '
(async () => {
  const c = window.__vk, t = window.__vt;
  c.setVoiceEnabled(false);          // so the pass has to borrow the detector
  await t.sleep(200);
  const all = t.btn("CALIBRATE ALL");
  if (all.length !== 1) return "no CALIBRATE ALL button";
  all[0].click();
  if (!(await t.until(() => t.text().includes("GIVE ME 8 KICKS"), 4000))) return "pass never armed";
  c.pollMeters();
  if (!c.meters.voice.enabled) return "the pass did not borrow the detector";
  if (c.meters.voice.captureClass !== 0) return "captureClass " + c.meters.voice.captureClass;
  t.tab("PAD");
  await t.sleep(400); c.pollMeters();
  if (c.meters.voice.captureClass !== -1) return "still armed after switching tab: " + c.meters.voice.captureClass;
  if (c.meters.voice.enabled) return "borrowed detector was not given back";
  if (c.getSnapshot().kit.voice.params.enabled >= 0.5) return "profile still says enabled";
  t.tab("VOICE");
  await t.sleep(300);
  if (!t.text().includes("CALIBRATION")) return "panel did not come back to idle: " + t.text().slice(0, 120);
  if (t.text().includes("GIVE ME")) return "panel came back still mid-pass";
  return "ok: disarmed, detector handed back, panel idle";
})()'

# A restart rebuilds the worklet from scratch: the calibration has to be replayed onto it,
# because it lives in the kit document and not in the engine.
run "restart replays the calibration" '
(async () => {
  const c = window.__vk, t = window.__vt;
  c.setVoiceEnabled(true);
  c.resetVoiceCalibration(-1);
  await t.sleep(200);
  // Train through the client rather than the panel - the pass itself is covered above.
  c.captureVoiceClass(2);
  await t.inject([2, 2, 2, 2, 2, 2], 260);
  c.stopVoiceCapture();
  await t.sleep(300);
  const pull = await c.pullVoiceCaptures(0, 64);
  if (pull.rows.length < 6) return "capture ring holds " + pull.rows.length + " rows, want 6+";
  const res = c.applyVoiceCalibration(pull.rows);
  await t.sleep(200);
  const trained = c.getSnapshot().kit.voice.trained.slice();
  if (!(trained[2] >= 3)) return "hat trained on " + trained[2];
  const cents = c.getSnapshot().kit.voice.centroids.slice();
  await c.applySettings({ bufferSize: 512 });
  await t.sleep(900);
  const ctx = c.audioContext();
  if (ctx.state !== "running") await ctx.resume();
  await t.sleep(400); c.pollMeters();
  const v = c.getSnapshot().kit.voice;
  if (JSON.stringify(v.trained) !== JSON.stringify(trained)) return "trained counts changed over a restart";
  if (JSON.stringify(v.centroids) !== JSON.stringify(cents)) return "centroids changed over a restart";
  if (!c.meters.voice.enabled) return "detector did not come back enabled";
  c.resetVoiceDetector();
  await t.inject([2, 2, 2], 280);
  if (c.meters.voice.hits < 3) return "detector deaf after restart, hits " + c.meters.voice.hits;
  c.resetVoiceCalibration(-1);
  return "ok: " + res.classes.filter(x => x.trained).length + " class trained, survived a restart, still hearing";
})()'

run "no console errors" '(() => window.__vkErr ? "render error: " + window.__vkErr : "ok:")()'

if [ "$FAILED" -ne 0 ]; then
  echo "voice ui: FAILED"
  exit 1
fi
echo "voice ui: all checks passed"
