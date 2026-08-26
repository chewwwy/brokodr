/**
 * Bro.Kodr — audio file player panel.
 *
 * Loads a WAV or MP3 and feeds it to the engine in one of two ways:
 *
 *   INPUT   — the file plays through the whole effect chain in place of (or alongside)
 *             the mic. Mute the input on the I/O strip to hear the file alone. The
 *             recorder taps the same point, so EXPORT WAV captures the processed file.
 *   CARRIER — the file becomes the DRIVER for the talk box and vocoder: load a guitar
 *             riff, mouth the words into the mic, and you have the actual talk box rig
 *             instead of the internal synth carrier.
 *   BOTH    — carrier, and audible through the chain as well.
 *
 * The waveform is a peak envelope built once at load time. Click to scrub; shift-click
 * sets the loop start and alt-click the loop end, which is faster in practice than
 * dragging two handles when you are trying to lock onto a bar line.
 *
 * SPEED and PITCH are genuinely independent (WSOLA time-stretch plus resampling in
 * dsp/core/file-player.js), so you can slow a riff down to learn it without dropping it
 * into a different key, or transpose it to match your vocal range at full tempo.
 */

import { useRef, useState } from "react";
import { FILE_ROUTE } from "../audio/backend";
import type { ParamDef } from "../audio/param-schema";
import { useAnimationLoop, useEngine, useEngineState } from "../hooks/use-engine";
import { Knob, Toggle } from "./controls";

const ROUTES = [
  { v: FILE_ROUTE.OFF, label: "OFF", hint: "Player silent" },
  { v: FILE_ROUTE.INPUT, label: "INPUT", hint: "File plays through the effect chain" },
  { v: FILE_ROUTE.CARRIER, label: "CARRIER", hint: "File drives the talk box / vocoder" },
  { v: FILE_ROUTE.BOTH, label: "BOTH", hint: "Drives the carrier and is heard through the chain" },
];

/** Local param defs so the transport knobs read and behave like every other knob. */
const SPEED_DEF: ParamDef = { key: "speed", label: "Speed", kind: "knob", min: 0.25, max: 2, def: 1, unit: "x", decimals: 2, curve: "log" };
const PITCH_DEF: ParamDef = { key: "pitch", label: "Pitch", kind: "knob", min: -12, max: 12, def: 0, unit: "st", decimals: 1, step: 0.5 };
const GAIN_DEF: ParamDef = { key: "gain", label: "Level", kind: "knob", min: -40, max: 12, def: 0, unit: "dB", decimals: 1 };

function fmt(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

/** Waveform + playhead. Drawn on canvas and driven by rAF — never by React state. */
function Waveform({
  peaks,
  loopIn,
  loopOut,
  onScrub,
  onLoopIn,
  onLoopOut,
}: {
  peaks: Float32Array;
  loopIn: number;
  loopOut: number;
  onScrub: (frac: number) => void;
  onLoopIn: (frac: number) => void;
  onLoopOut: (frac: number) => void;
}) {
  const client = useEngine();
  const ref = useRef<HTMLCanvasElement>(null);

  useAnimationLoop(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, w, h);

    if (peaks.length) {
      // Loop region first, so the waveform sits on top of it.
      const x0 = loopIn * w;
      const x1 = loopOut * w;
      ctx.fillStyle = "rgba(56,189,248,0.10)";
      ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
      ctx.strokeStyle = "rgba(56,189,248,0.7)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0 + 0.5, 0);
      ctx.lineTo(x0 + 0.5, h);
      ctx.moveTo(x1 - 0.5, 0);
      ctx.lineTo(x1 - 0.5, h);
      ctx.stroke();

      ctx.strokeStyle = "#8b949e";
      ctx.beginPath();
      const mid = h / 2;
      for (let x = 0; x < w; x++) {
        const p = peaks[Math.min(peaks.length - 1, Math.floor((x / w) * peaks.length))];
        const a = Math.max(0.5, p * mid);
        ctx.moveTo(x + 0.5, mid - a);
        ctx.lineTo(x + 0.5, mid + a);
      }
      ctx.stroke();
    }

    const pos = client.meters.filePosition;
    ctx.strokeStyle = "#f5a524";
    ctx.beginPath();
    ctx.moveTo(pos * w, 0);
    ctx.lineTo(pos * w, h);
    ctx.stroke();
  }, true);

  const pick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    if (e.shiftKey) onLoopIn(frac);
    else if (e.altKey) onLoopOut(frac);
    else onScrub(frac);
  };

  return (
    <canvas
      ref={ref}
      onMouseDown={pick}
      className="w-full cursor-crosshair"
      style={{ height: 56, border: "1px solid var(--vk-line)", borderRadius: 2 }}
      title="Click to scrub · Shift-click sets loop start · Alt-click sets loop end"
    />
  );
}

export function FilePanel() {
  const client = useEngine();
  const { fileState, status } = useEngineState();
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);

  const f = fileState;
  const running = status === "running";

  const choose = () => {
    if (!running) {
      setNote("Press ENGAGE first — decoding needs the audio engine running.");
      return;
    }
    setNote(null);
    input.current?.click();
  };

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    await client.loadFile(file);
  };

  return (
    <div className="flex flex-col gap-[6px]">
      <input
        ref={input}
        type="file"
        accept=".wav,.mp3,audio/wav,audio/x-wav,audio/mpeg"
        className="hidden"
        onChange={onPick}
      />

      <div className="flex items-center gap-[6px]">
        <button className="vk-btn vk-focus-ring" style={{ fontSize: 10 }} onClick={choose} disabled={f.loading}>
          {f.loading ? "DECODING…" : "LOAD WAV / MP3"}
        </button>
        {f.file && (
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 10 }}
            onClick={() => client.unloadFile()}
            title="Unload the file and free its memory"
          >
            EJECT
          </button>
        )}
      </div>

      {(note || f.error) && (
        <div className="vk-mono text-[10px]" style={{ color: "var(--vk-red, #f87171)" }}>
          {f.error ?? note}
        </div>
      )}

      {f.file && (
        <>
          <div className="vk-mono flex items-baseline gap-2 text-[10px]" style={{ color: "var(--vk-text-mid)" }}>
            <span className="truncate" style={{ color: "var(--vk-text)" }} title={f.file.name}>
              {f.file.name}
            </span>
            <span>{fmt(f.file.duration)}</span>
            <span>{(f.file.sampleRate / 1000).toFixed(1)}k</span>
          </div>

          <Waveform
            peaks={f.file.peaks}
            loopIn={f.loopIn}
            loopOut={f.loopOut}
            onScrub={(v) => client.fileSeek(v)}
            onLoopIn={(v) => client.fileLoopPoints(Math.min(v, f.loopOut - 0.01), f.loopOut)}
            onLoopOut={(v) => client.fileLoopPoints(f.loopIn, Math.max(v, f.loopIn + 0.01))}
          />

          <div className="flex items-center gap-[6px]">
            <button
              className="vk-btn vk-focus-ring flex-1"
              data-active={f.playing}
              style={{ fontSize: 10 }}
              onClick={() => client.filePlay(!f.playing)}
            >
              {f.playing ? "STOP" : "PLAY"}
            </button>
            <button
              className="vk-btn vk-focus-ring"
              style={{ fontSize: 10 }}
              onClick={() => client.fileSeek(0)}
              title="Return to the loop start"
            >
              ⟲
            </button>
            <div style={{ width: 78 }}>
              <Toggle on={f.loop} onChange={(v) => client.fileLoop(v)} label="LOOP" tone="cyan" />
            </div>
          </div>

          <div className="flex items-end gap-2">
            <div className="flex flex-col items-center gap-[2px]" title="Playback rate. Pitch is unaffected — the player time-stretches.">
              <Knob def={SPEED_DEF} value={f.speed} onChange={(v) => client.fileSpeed(v)} size={44} />
              <span className="vk-label">SPEED</span>
            </div>
            <div className="flex flex-col items-center gap-[2px]" title="Transpose in semitones. Length is unaffected.">
              <Knob def={PITCH_DEF} value={f.pitch} onChange={(v) => client.filePitch(v)} size={44} bipolar />
              <span className="vk-label">PITCH</span>
            </div>
            <div className="flex flex-col items-center gap-[2px]" title="File player level.">
              <Knob def={GAIN_DEF} value={f.gain} onChange={(v) => client.fileGain(v)} size={44} />
              <span className="vk-label">LEVEL</span>
            </div>
            <button
              className="vk-btn vk-focus-ring"
              style={{ fontSize: 9, padding: "2px 6px" }}
              onClick={() => {
                client.fileSpeed(1);
                client.filePitch(0);
              }}
              title="Reset speed and pitch"
            >
              1:1
            </button>
          </div>
        </>
      )}

      <div className="flex flex-col gap-[3px]">
        <span className="vk-label">ROUTING</span>
        <div className="flex gap-[3px]">
          {ROUTES.map((r) => (
            <button
              key={r.v}
              className="vk-btn vk-focus-ring flex-1"
              data-active={f.route === r.v}
              style={{ fontSize: 9, padding: "2px 4px" }}
              onClick={() => client.fileRoute(r.v)}
              title={r.hint}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="vk-mono text-[9px]" style={{ color: "var(--vk-text-dim)" }}>
          {ROUTES.find((r) => r.v === f.route)?.hint}
          {f.route >= FILE_ROUTE.CARRIER ? " — set the module's SOURCE to FILE." : ""}
        </span>
      </div>
    </div>
  );
}
