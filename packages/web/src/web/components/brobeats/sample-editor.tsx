/**
 * Bro.Kodr — BROBEATS sample editor.
 *
 * Capture a sound, cut it, send it to a pad. Three jobs, one screen.
 *
 * The thing that makes this worth having rather than a generic wave editor is where the
 * audio comes from: RECORD here captures the *processed* tap — your voice after the whole
 * rack — so you can vocode yourself, sample that, and then play it chromatically across
 * the pads. Sampling your own processed voice is the loop the app is built around, and
 * until now the only way out of the recorder was a WAV file on disk.
 *
 * Two deliberate structural choices:
 *
 *  1. **No audio maths lives here.** Every operation is a call into `sample-edit.ts`,
 *     which `recorder.ts` also uses. The fade you hear when auditioning a slice is the
 *     literal same curve that lands in an exported file, because it is the same function.
 *     A wave editor that disagrees with its own export is worse than no wave editor.
 *
 *  2. **The edit is a description, not a buffer.** `SampleEdit` is eight plain numbers;
 *     the edited audio is re-derived from the untouched source on demand. So every control
 *     is non-destructive and reversible for free, dragging a trim handle costs nothing but
 *     a redraw, and "send to pad" is the only moment audio is actually rendered.
 *
 * Drawing goes straight to canvas inside the animation loop and never through React state
 * — the same rule the meters and the ADSR display follow. A 48k take is a million frames
 * and a setState per pointermove would drop the frame rate through the floor.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  buildPeaks,
  defaultEdit,
  findContentBounds,
  peakOf,
  renderEdit,
  rmsDb,
  shiftSlices,
  sliceAtTransients,
  sliceEvenly,
  toMonoBuffer,
  type SampleEdit,
  type Slice,
  type StereoBuffer,
} from "../../audio/sample-edit";
import {
  DEFAULT_EXPORT,
  downloadBlob,
  encodeWav,
  formatDuration,
  nextTakeName,
} from "../../audio/recorder";
import type { ParamDef } from "../../audio/param-schema";
import { useCanvas, useEngine, useEngineState } from "../../hooks/use-engine";
import { Knob, Toggle } from "../controls";

/* ------------------------------------------------------------------ types */

interface Source {
  name: string;
  buf: StereoBuffer;
  sampleRate: number;
  /** Where it came from, shown under the name so a take is never confused with an import. */
  origin: string;
}

type Handle = "start" | "end" | "fadeIn" | "fadeOut";

const WAVE_HEIGHT = 190;
const PAD_COUNT = 16;

/* ------------------------------------------------------------------ knob defs */

// Local defs rather than entries in `param-schema.ts`: these are UI-side edit settings
// that never reach the audio thread, and that file is an append-only contract with the
// DSP. Putting them there would imply a param id the engine does not have.
const GAIN_DEF: ParamDef = {
  key: "gainDb",
  label: "Gain",
  kind: "knob",
  min: -24,
  max: 24,
  def: 0,
  unit: "dB",
  decimals: 1,
};

const FADE_IN_DEF: ParamDef = {
  key: "fadeInMs",
  label: "Fade In",
  kind: "knob",
  min: 0,
  max: 2000,
  def: 0,
  unit: "ms",
  curve: "log",
  decimals: 0,
};

const FADE_OUT_DEF: ParamDef = { ...FADE_IN_DEF, key: "fadeOutMs", label: "Fade Out", def: 4 };

const NORMALIZE_DEF: ParamDef = {
  key: "normalizeDb",
  label: "Norm To",
  kind: "knob",
  min: -24,
  max: 0,
  def: -1,
  unit: "dB",
  decimals: 1,
};

const SENSITIVITY_DEF: ParamDef = {
  key: "sensitivity",
  label: "Sens",
  kind: "knob",
  min: 1.2,
  max: 8,
  def: 2.4,
  decimals: 2,
};

/* ------------------------------------------------------------------ waveform */

/**
 * The waveform, its trim handles, its fade ramps, slice markers and the playhead.
 *
 * Everything here reads live values out of refs. The parent owns the edit as React state
 * for the knobs to bind to, and mirrors it into a ref for this to draw from — so a drag
 * updates at screen rate while the numbers under the knobs still re-render normally.
 */
function Waveform({
  source,
  editRef,
  slices,
  selectedSlice,
  onEdit,
  onPickSlice,
  playheadRef,
  active,
}: {
  source: Source;
  editRef: React.RefObject<SampleEdit>;
  slices: Slice[];
  selectedSlice: number | null;
  onEdit: (patch: Partial<SampleEdit>) => void;
  onPickSlice: (i: number) => void;
  playheadRef: React.RefObject<number>;
  // False while the editor is mounted but hidden behind the PAD tab. The canvas keeps its
  // state (and so does the whole editor) but stops repainting a surface nobody can see.
  active: boolean;
}) {
  const frames = source.buf.l.length;
  const dragRef = useRef<{ handle: Handle; startX: number; value: number } | null>(null);
  const hoverRef = useRef<Handle | null>(null);
  const [cursor, setCursor] = useState<string>("default");

  // Peaks are the expensive part — one pass over the whole buffer — so they are computed
  // once per source and per width, never per frame. Trimming only moves the overlay.
  const peaksRef = useRef<{ data: Float32Array; points: number }>({ data: new Float32Array(0), points: 0 });
  const slicesRef = useRef(slices);
  slicesRef.current = slices;
  const selRef = useRef(selectedSlice);
  selRef.current = selectedSlice;

  useEffect(() => {
    peaksRef.current = { data: new Float32Array(0), points: 0 };
  }, [source]);

  const xOf = (frame: number, w: number) => (frames > 0 ? (frame / frames) * w : 0);
  const frameOf = (x: number, w: number) => (w > 0 ? Math.round((x / w) * frames) : 0);

  const canvasRef = useCanvas((ctx, w, h) => {
    const e = editRef.current;
    const points = Math.max(1, Math.round(w));
    if (peaksRef.current.points !== points) {
      peaksRef.current = { data: buildPeaks(source.buf, points), points };
    }
    const peaks = peaksRef.current.data;
    const mid = h / 2;
    const half = h / 2 - 6;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(0,0,0,0.30)";
    ctx.fillRect(0, 0, w, h);

    // centre line + thirds, same well treatment as the ADSR display
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      const y = h * f;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const x0 = xOf(e.startFrame, w);
    const x1 = xOf(e.endFrame, w);

    // --- waveform. Trimmed-away audio still draws, dimmed: you cannot judge where to cut
    // if the part you are cutting off disappears the moment you start cutting.
    for (let p = 0; p < points; p++) {
      const lo = peaks[p * 2];
      const hi = peaks[p * 2 + 1];
      const inside = p >= x0 && p <= x1;
      ctx.strokeStyle = inside ? "#ffb020" : "rgba(154,162,173,0.22)";
      ctx.beginPath();
      ctx.moveTo(p + 0.5, mid - hi * half);
      ctx.lineTo(p + 0.5, mid - lo * half);
      ctx.stroke();
    }

    // --- excluded regions
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.fillRect(0, 0, x0, h);
    ctx.fillRect(x1, 0, w - x1, h);

    // --- slice markers
    const sl = slicesRef.current;
    if (sl.length) {
      for (let i = 0; i < sl.length; i++) {
        const sx = xOf(sl[i].startFrame, w);
        const ex = xOf(sl[i].endFrame, w);
        const on = selRef.current === i;
        ctx.fillStyle = on ? "rgba(53,214,208,0.16)" : "rgba(53,214,208,0.05)";
        ctx.fillRect(sx, 0, Math.max(1, ex - sx), h);
        ctx.strokeStyle = on ? "#35d6d0" : "rgba(53,214,208,0.55)";
        ctx.lineWidth = on ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(sx + 0.5, 0);
        ctx.lineTo(sx + 0.5, h);
        ctx.stroke();
        // Pad number, so the mapping from slice to pad is visible before you commit it.
        if (ex - sx > 14) {
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillStyle = on ? "#35d6d0" : "rgba(53,214,208,0.7)";
          ctx.fillText(String(i + 1), sx + 3, 11);
        }
      }
    }

    // --- fade ramps, drawn as the gain envelope over the kept region
    const srMs = source.sampleRate / 1000;
    const fi = Math.min(e.fadeInMs * srMs, e.endFrame - e.startFrame);
    const fo = Math.min(e.fadeOutMs * srMs, e.endFrame - e.startFrame);
    const fiX = xOf(e.startFrame + fi, w);
    const foX = xOf(e.endFrame - fo, w);
    if (fi > 0 || fo > 0) {
      ctx.strokeStyle = "rgba(53,214,208,0.85)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x0, fi > 0 ? h - 2 : 2);
      ctx.lineTo(fiX, 2);
      ctx.lineTo(foX, 2);
      ctx.lineTo(x1, fo > 0 ? h - 2 : 2);
      ctx.stroke();
    }

    // --- trim handles
    for (const [name, x] of [
      ["start", x0],
      ["end", x1],
    ] as const) {
      const on = (dragRef.current?.handle ?? hoverRef.current) === name;
      ctx.strokeStyle = "#ffb020";
      ctx.lineWidth = on ? 2 : 1.2;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      ctx.fillStyle = on ? "#ffb020" : "rgba(20,22,26,0.9)";
      const gw = 7;
      const gy = mid - 14;
      ctx.beginPath();
      ctx.rect(name === "start" ? x : x - gw, gy, gw, 28);
      ctx.fill();
      ctx.stroke();
    }

    // --- fade handles, sitting on the ramp so they read as part of it
    for (const [name, x] of [
      ["fadeIn", fiX],
      ["fadeOut", foX],
    ] as const) {
      const on = (dragRef.current?.handle ?? hoverRef.current) === name;
      ctx.beginPath();
      ctx.arc(x, 2, on ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = on ? "#35d6d0" : "rgba(20,22,26,0.9)";
      ctx.fill();
      ctx.strokeStyle = "#35d6d0";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // --- playhead
    const ph = playheadRef.current;
    if (ph >= 0) {
      const px = xOf(ph, w);
      ctx.strokeStyle = "#7de07a";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(px + 0.5, 0);
      ctx.lineTo(px + 0.5, h);
      ctx.stroke();
    }

    // --- readout
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillStyle = "rgba(154,162,173,0.85)";
    const kept = (e.endFrame - e.startFrame) / source.sampleRate;
    ctx.fillText(
      `${formatDuration(e.startFrame / source.sampleRate)} → ${formatDuration(e.endFrame / source.sampleRate)}   (${kept.toFixed(3)}s of ${(frames / source.sampleRate).toFixed(3)}s)`,
      4,
      h - 4,
    );
  }, active);

  const handleAt = (e: React.PointerEvent<HTMLCanvasElement>): Handle | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const w = rect.width;
    const ed = editRef.current;
    const srMs = source.sampleRate / 1000;
    const fiX = xOf(ed.startFrame + Math.min(ed.fadeInMs * srMs, ed.endFrame - ed.startFrame), w);
    const foX = xOf(ed.endFrame - Math.min(ed.fadeOutMs * srMs, ed.endFrame - ed.startFrame), w);

    // Fades win near the top of the well, trims anywhere — otherwise a fade handle sitting
    // on top of its trim handle at 0ms is unreachable.
    if (y < 26) {
      if (Math.abs(fiX - x) < 8) return "fadeIn";
      if (Math.abs(foX - x) < 8) return "fadeOut";
    }
    if (Math.abs(xOf(ed.startFrame, w) - x) < 7) return "start";
    if (Math.abs(xOf(ed.endFrame, w) - x) < 7) return "end";
    return null;
  };

  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const h = handleAt(ev);
    const rect = ev.currentTarget.getBoundingClientRect();
    if (!h) {
      // A click in open space picks the slice under it, when sliced.
      const sl = slicesRef.current;
      if (sl.length) {
        const f = frameOf(ev.clientX - rect.left, rect.width);
        const i = sl.findIndex((s) => f >= s.startFrame && f < s.endFrame);
        if (i >= 0) onPickSlice(i);
      }
      return;
    }
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const ed = editRef.current;
    dragRef.current = {
      handle: h,
      startX: ev.clientX,
      value: h === "start" ? ed.startFrame : h === "end" ? ed.endFrame : h === "fadeIn" ? ed.fadeInMs : ed.fadeOutMs,
    };
    setCursor("grabbing");
  };

  const onPointerMove = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    const rect = ev.currentTarget.getBoundingClientRect();
    if (!d) {
      hoverRef.current = handleAt(ev);
      setCursor(hoverRef.current ? "ew-resize" : slicesRef.current.length ? "pointer" : "default");
      return;
    }
    const dxFrames = ((ev.clientX - d.startX) / Math.max(1, rect.width)) * frames;
    const ed = editRef.current;

    if (d.handle === "start") {
      // Leave at least one frame — a zero-length edit renders an empty buffer that every
      // downstream consumer then has to special-case.
      const v = Math.max(0, Math.min(ed.endFrame - 1, Math.round(d.value + dxFrames)));
      onEdit({ startFrame: v });
    } else if (d.handle === "end") {
      const v = Math.max(ed.startFrame + 1, Math.min(frames, Math.round(d.value + dxFrames)));
      onEdit({ endFrame: v });
    } else {
      const span = (ed.endFrame - ed.startFrame) / (source.sampleRate / 1000);
      const dMs = (dxFrames / source.sampleRate) * 1000;
      const sign = d.handle === "fadeIn" ? 1 : -1;
      const v = Math.max(0, Math.min(span, d.value + dMs * sign));
      onEdit(d.handle === "fadeIn" ? { fadeInMs: v } : { fadeOutMs: v });
    }
  };

  const endDrag = () => {
    dragRef.current = null;
    setCursor("default");
  };

  return (
    <canvas
      ref={canvasRef}
      className="w-full"
      style={{
        height: WAVE_HEIGHT,
        display: "block",
        borderRadius: 3,
        border: "1px solid var(--vk-line)",
        cursor,
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => {
        hoverRef.current = null;
      }}
      title="Drag the bars to trim · drag the dots along the top for fades · click a slice to select it"
    />
  );
}

/* ------------------------------------------------------------------ editor */

export function SampleEditor({
  onSelectPad,
  active = true,
}: {
  // `focus` asks the host to bring the pad editor forward as well as select the pad. One
  // deliberate send does that — you sent it, you want to go tune it. Laying slices across
  // all the pads does not: you are still working in here, and being thrown out to the PAD
  // tab after every chop would be maddening.
  onSelectPad?: (index: number, focus: boolean) => void;
  // False while the host keeps this mounted but hidden. Everything loaded — the capture,
  // the edit, the slices — has to survive a trip to the PAD tab and back, so the host hides
  // this rather than unmounting it, and this flag is what stops it burning frames meanwhile.
  active?: boolean;
}) {
  const client = useEngine();
  const { status } = useEngineState();
  const running = status === "running";

  const [source, setSource] = useState<Source | null>(null);
  const [edit, setEdit] = useState<SampleEdit>(() => defaultEdit(0));
  const [recording, setRecording] = useState(false);
  const [slices, setSlices] = useState<Slice[]>([]);
  const [selectedSlice, setSelectedSlice] = useState<number | null>(null);
  const [sensitivity, setSensitivity] = useState(SENSITIVITY_DEF.def);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fileRef = useRef<HTMLInputElement | null>(null);
  const playing = useRef<AudioBufferSourceNode | null>(null);
  const playheadRef = useRef(-1);
  const editRef = useRef(edit);
  editRef.current = edit;

  const say = useCallback((msg: string | null, ms = 4000) => {
    setNote(msg);
    if (msg) setTimeout(() => setNote((n) => (n === msg ? null : n)), ms);
  }, []);

  const patch = useCallback((p: Partial<SampleEdit>) => {
    // Written through the ref as well as state so the canvas, which draws from the ref
    // inside the animation loop, sees the new value on the very next frame rather than
    // after React has committed.
    editRef.current = { ...editRef.current, ...p };
    setEdit(editRef.current);
  }, []);

  const load = useCallback((s: Source) => {
    setSource(s);
    const e = defaultEdit(s.buf.l.length);
    editRef.current = e;
    setEdit(e);
    setSlices([]);
    setSelectedSlice(null);
  }, []);

  /* ------------------------------------------------------------ capture */

  const startRecord = () => {
    if (!running) {
      say("Press ENGAGE first — there is no signal to sample.");
      return;
    }
    client.setRecording(true, false, true);
    setRecording(true);
    say(null);
  };

  const stopRecord = useCallback(() => {
    client.setRecording(false, false, false);
    setRecording(false);
    const cap = client.takeRecording();
    if (!cap || !cap.wet.l.length) {
      say("Nothing was captured. Shared memory may be unavailable in this context.");
      return;
    }
    load({
      name: nextTakeName(),
      buf: cap.wet,
      sampleRate: client.sampleRate() || 48000,
      origin: "recorded through the rack",
    });
  }, [client, load, say]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    // Importing deliberately does NOT require the engine. Decoding only needs *an* audio
    // context, not a running one, and sending to a pad stages fine in standby — so you can
    // load and cut a file before you have granted mic access. Only auditioning needs
    // ENGAGE, and that says so on its own.
    const ctx = client.audioContext() ?? new OfflineAudioContext(1, 1, client.sampleRate() || 48000);
    setBusy(true);
    try {
      const buf = await ctx.decodeAudioData(await file.arrayBuffer());
      const l = buf.getChannelData(0).slice();
      const r = buf.numberOfChannels > 1 ? buf.getChannelData(1).slice() : l.slice();
      load({
        name: file.name.replace(/\.[^.]+$/, ""),
        buf: { l, r },
        sampleRate: buf.sampleRate,
        origin: `imported · ${file.name}`,
      });
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------------------------------------- render */

  // The edited audio, derived from the untouched source. Memoised on the edit so the knob
  // readouts below (peak, RMS, length) do not re-run this on unrelated renders.
  const rendered = useMemo(
    () => (source ? renderEdit(source.buf, source.sampleRate, edit) : null),
    [source, edit],
  );

  const stats = useMemo(() => {
    if (!rendered || !rendered.l.length) return null;
    return {
      peak: peakOf(rendered.l, rendered.r),
      rms: rmsDb(rendered.l, rendered.r),
      seconds: rendered.l.length / (source?.sampleRate ?? 48000),
    };
  }, [rendered, source]);

  /* ------------------------------------------------------------ preview */

  const stopPlay = useCallback(() => {
    playing.current?.stop();
    playing.current = null;
    playheadRef.current = -1;
  }, []);

  const play = useCallback(
    (region?: { startFrame: number; endFrame: number }) => {
      if (!source) return;
      const ctx = client.audioContext();
      if (!ctx) {
        say("Engine is not running, so there is nothing to play through.");
        return;
      }
      stopPlay();

      // A slice auditions raw from the source; the main transport plays what the edit
      // renders. Same path, different buffer.
      const src = region
        ? renderEdit(source.buf, source.sampleRate, {
            ...defaultEdit(source.buf.l.length),
            startFrame: region.startFrame,
            endFrame: region.endFrame,
          })
        : rendered;
      if (!src || !src.l.length) return;

      const ab = ctx.createBuffer(2, src.l.length, source.sampleRate);
      ab.copyToChannel(src.l as Float32Array<ArrayBuffer>, 0);
      ab.copyToChannel(src.r as Float32Array<ArrayBuffer>, 1);
      const node = ctx.createBufferSource();
      node.buffer = ab;
      node.connect(ctx.destination);

      // Playhead is tracked against the context clock rather than a timer: it is the same
      // clock the buffer is playing on, so it cannot drift away from the audio.
      const t0 = ctx.currentTime;
      const base = region ? region.startFrame : edit.startFrame;
      const follow = () => {
        if (playing.current !== node) return;
        playheadRef.current = base + (ctx.currentTime - t0) * source.sampleRate;
        requestAnimationFrame(follow);
      };
      node.onended = () => {
        if (playing.current === node) {
          playing.current = null;
          playheadRef.current = -1;
        }
      };
      node.start();
      playing.current = node;
      requestAnimationFrame(follow);
    },
    [client, edit.startFrame, rendered, say, source, stopPlay],
  );

  useEffect(() => stopPlay, [stopPlay]);

  // Hidden behind the PAD tab, an audition that is still running is a sound with no visible
  // source. Cut it the moment the editor goes away; the sample itself stays loaded.
  useEffect(() => {
    if (!active) stopPlay();
  }, [active, stopPlay]);

  /* -------------------------------------------------------------- tools */

  const autoTrim = () => {
    if (!source) return;
    const b = findContentBounds(source.buf, source.sampleRate, -48);
    patch({ startFrame: b.start, endFrame: b.end });
    say(`Trimmed to content: ${((b.end - b.start) / source.sampleRate).toFixed(3)}s`);
  };

  const doSlice = async (mode: "transient" | "even") => {
    if (!source) return;
    setBusy(true);
    try {
      // Chop the kept region, not the whole capture. Trim is the user saying which part of
      // the take matters, and EQUAL 16 over the raw buffer would hand the first and last
      // pads the silence they just trimmed off. The region is the trim and nothing else —
      // no gain, no reverse, no fades — because a slice is a range of source frames, and
      // the send applies those settings per slice afterwards.
      const e = editRef.current;
      const offset = e.startFrame;
      const region = renderEdit(source.buf, source.sampleRate, {
        ...defaultEdit(source.buf.l.length),
        startFrame: e.startFrame,
        endFrame: e.endFrame,
      });
      const frames = region.l.length;
      if (frames <= 0) {
        say("Nothing is left after the trim — widen it before slicing.");
        return;
      }

      if (mode === "even") {
        setSlices(shiftSlices(sliceEvenly(frames, PAD_COUNT), offset));
        setSelectedSlice(0);
        say(`Divided into ${PAD_COUNT} equal slices.`);
        return;
      }
      const found = await sliceAtTransients(region, source.sampleRate, {
        sensitivity,
        maxSlices: PAD_COUNT,
      });
      if (!found.length) {
        // Documented fallback: no transients, or the detector could not be loaded. Even
        // division is always available and always does something, which beats a dead button.
        setSlices(shiftSlices(sliceEvenly(frames, PAD_COUNT), offset));
        setSelectedSlice(0);
        say("No transients found — fell back to equal division.");
        return;
      }
      setSlices(shiftSlices(found, offset));
      setSelectedSlice(0);
      say(`Found ${found.length} transient${found.length === 1 ? "" : "s"}.`);
    } finally {
      setBusy(false);
    }
  };

  const sendToPad = (padIndex: number) => {
    if (!source || !rendered || !rendered.l.length) return;
    const mono = toMonoBuffer(rendered);
    client.loadPadBuffer(padIndex, mono, source.sampleRate, source.name || "sample");
    onSelectPad?.(padIndex, true);
    say(`Sent to pad ${padIndex + 1}.`);
  };

  const sendSlicesToPads = () => {
    if (!source || !slices.length) return;
    const n = Math.min(slices.length, PAD_COUNT);
    for (let i = 0; i < n; i++) {
      // Each slice carries the current gain/normalise/reverse settings but its own bounds
      // and no fades — a fade per slice would chop the attack off every one of them.
      const cut = renderEdit(source.buf, source.sampleRate, {
        ...editRef.current,
        startFrame: slices[i].startFrame,
        endFrame: slices[i].endFrame,
        fadeInMs: 0,
        fadeOutMs: Math.min(editRef.current.fadeOutMs, 4),
      });
      if (!cut.l.length) continue;
      client.loadPadBuffer(i, toMonoBuffer(cut), source.sampleRate, `${source.name.slice(0, 12)} ${i + 1}`);
    }
    onSelectPad?.(0, false);
    say(`Laid ${n} slices across the pads.`);
  };

  const exportWav = () => {
    if (!source || !rendered || !rendered.l.length) return;
    const blob = encodeWav(
      rendered.l,
      rendered.r,
      source.sampleRate,
      DEFAULT_EXPORT.bitDepth,
      edit.mono,
    );
    const safe = source.name.replace(/[^a-z0-9-_ ]/gi, "").trim() || "sample";
    downloadBlob(blob, `${safe}-edit.wav`);
    say(`Exported ${safe}-edit.wav`);
  };

  /* --------------------------------------------------------------- view */

  const hasAudio = !!source && source.buf.l.length > 0;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {/* --------------------------------------------------------- header */}
      <div className="vk-panel flex flex-wrap items-center gap-2 p-2">
        <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
          SAMPLE
        </span>

        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "2px 8px" }}
          data-active={recording}
          data-tone="danger"
          onClick={() => (recording ? stopRecord() : startRecord())}
          title="Record the processed output of the rack — sample your own voice with the chain on it"
        >
          {recording ? "■ STOP" : "● RECORD"}
        </button>

        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "2px 6px" }}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
          title="Import an audio file to edit"
        >
          IMPORT…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          style={{ display: "none" }}
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />

        <span style={{ width: 1, height: 16, background: "var(--vk-line)" }} />

        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "2px 6px" }}
          disabled={!hasAudio}
          onClick={() => (playing.current ? stopPlay() : play())}
          title="Audition the edited sample"
        >
          {playing.current ? "■ STOP" : "▶ PLAY"}
        </button>
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "2px 6px" }}
          disabled={!hasAudio}
          onClick={exportWav}
          title="Download the edited sample as a 24-bit WAV"
        >
          EXPORT WAV
        </button>

        <div className="flex-1" />

        <span className="vk-mono text-[10px]" style={{ color: note ? "var(--vk-amber)" : "var(--vk-text-dim)" }}>
          {note
            ? note
            : recording
              ? "recording…"
              : source
                ? `${source.name} · ${source.origin}`
                : running
                  ? "record the rack, or import a file"
                  : "engine in standby — import works, recording needs ENGAGE"}
        </span>
      </div>

      {/* ------------------------------------------------------- waveform */}
      <div className="vk-panel flex flex-col gap-2 p-2">
        {hasAudio && source ? (
          <Waveform
            source={source}
            editRef={editRef}
            slices={slices}
            selectedSlice={selectedSlice}
            onEdit={patch}
            onPickSlice={(i) => {
              setSelectedSlice(i);
              play(slices[i]);
            }}
            playheadRef={playheadRef}
            active={active}
          />
        ) : (
          <div
            className="vk-mono flex items-center justify-center text-[10px]"
            style={{
              height: WAVE_HEIGHT,
              borderRadius: 3,
              border: "1px dashed var(--vk-line)",
              background: "rgba(0,0,0,0.22)",
              color: "var(--vk-text-dim)",
            }}
          >
            {recording ? "recording — press STOP to edit the take" : "no sample loaded"}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "2px 6px" }}
            disabled={!hasAudio}
            onClick={autoTrim}
            title="Snap the trim handles to where the sound actually starts and stops"
          >
            AUTO TRIM
          </button>
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "2px 6px" }}
            disabled={!hasAudio}
            onClick={() => source && patch({ startFrame: 0, endFrame: source.buf.l.length })}
            title="Undo the trim — the audio was never cut, only masked"
          >
            FULL LENGTH
          </button>
          <span style={{ width: 1, height: 16, background: "var(--vk-line)" }} />
          <span className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)" }}>
            {stats
              ? `${stats.seconds.toFixed(3)}s · peak ${(20 * Math.log10(Math.max(stats.peak, 1e-9))).toFixed(1)} dB · rms ${Number.isFinite(stats.rms) ? stats.rms.toFixed(1) : "−∞"} dB`
              : "—"}
          </span>
        </div>
      </div>

      {/* --------------------------------------------------------- shape */}
      <div className="vk-panel flex flex-col gap-2 p-2">
        <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
          SHAPE — non-destructive, the capture is never overwritten
        </span>
        <div className="flex flex-wrap items-start gap-x-[2px] gap-y-1">
          <Knob
            def={GAIN_DEF}
            value={edit.gainDb}
            size={40}
            skin="metal"
            bipolar
            onChange={(v) => patch({ gainDb: v })}
          />
          <Knob
            def={FADE_IN_DEF}
            value={edit.fadeInMs}
            size={40}
            skin="metal"
            accent="var(--vk-cyan)"
            onChange={(v) => patch({ fadeInMs: v })}
          />
          <Knob
            def={FADE_OUT_DEF}
            value={edit.fadeOutMs}
            size={40}
            skin="metal"
            accent="var(--vk-cyan)"
            onChange={(v) => patch({ fadeOutMs: v })}
          />
          <Knob
            def={NORMALIZE_DEF}
            value={edit.normalizeDb ?? NORMALIZE_DEF.def}
            size={40}
            skin="metal"
            onChange={(v) => patch({ normalizeDb: v })}
          />
          <div className="flex flex-col gap-[3px] pl-2" style={{ width: 100 }}>
            <Toggle
              label="Normalise"
              on={edit.normalizeDb !== null}
              tone="cyan"
              title="Peak-normalise to the Norm To level, after gain"
              onChange={(v) => patch({ normalizeDb: v ? NORMALIZE_DEF.def : null })}
            />
            <Toggle label="Reverse" on={edit.reverse} onChange={(v) => patch({ reverse: v })} />
            <Toggle
              label="Mono"
              on={edit.mono}
              title="Pads play mono anyway — this only changes the exported file"
              onChange={(v) => patch({ mono: v })}
            />
          </div>
        </div>
      </div>

      {/* --------------------------------------------------------- slices */}
      <div className="vk-panel flex flex-col gap-2 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
            SLICE — chop one recording across the pads
          </span>
          <div className="flex-1" />
          <Knob
            def={SENSITIVITY_DEF}
            value={sensitivity}
            size={34}
            skin="metal"
            accent="var(--vk-cyan)"
            onChange={setSensitivity}
          />
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "2px 6px" }}
            disabled={!hasAudio || busy}
            onClick={() => void doSlice("transient")}
            title="Find the hits and cut at each one"
          >
            AT TRANSIENTS
          </button>
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "2px 6px" }}
            disabled={!hasAudio || busy}
            onClick={() => void doSlice("even")}
            title="Cut into 16 equal pieces regardless of content"
          >
            EQUAL 16
          </button>
          {slices.length > 0 && (
            <>
              <button
                className="vk-btn vk-focus-ring"
                style={{ fontSize: 9, padding: "2px 6px" }}
                data-tone="cyan"
                data-active
                onClick={sendSlicesToPads}
                title="Load every slice onto its matching pad, in order"
              >
                → ALL PADS
              </button>
              <button
                className="vk-btn vk-focus-ring"
                style={{ fontSize: 9, padding: "2px 6px" }}
                data-tone="danger"
                onClick={() => {
                  setSlices([]);
                  setSelectedSlice(null);
                }}
                title="Clear the slice markers"
              >
                CLEAR
              </button>
            </>
          )}
        </div>

        {slices.length > 0 && (
          <span className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)" }}>
            {slices.length} slice{slices.length === 1 ? "" : "s"} · click one in the waveform to audition ·
            {selectedSlice !== null
              ? ` slice ${selectedSlice + 1} selected (${((slices[selectedSlice].endFrame - slices[selectedSlice].startFrame) / (source?.sampleRate ?? 48000)).toFixed(3)}s)`
              : " none selected"}
          </span>
        )}
      </div>

      {/* ---------------------------------------------------- send to pad */}
      <div className="vk-panel flex flex-col gap-2 p-2">
        <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
          SEND TO PAD — loads the edited sample, replacing whatever is there
        </span>
        <div className="grid grid-cols-8 gap-[3px]">
          {Array.from({ length: PAD_COUNT }, (_, i) => (
            <button
              key={i}
              className="vk-btn vk-focus-ring"
              style={{ fontSize: 9, padding: "3px 0" }}
              disabled={!hasAudio}
              onClick={() => sendToPad(i)}
              title={`Send the edited sample to pad ${i + 1}`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
