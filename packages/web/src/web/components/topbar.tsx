/**
 * Bro.Kodr — top bar.
 *
 * Owns the single most important control in the app: ENGAGE. Everything to its right is
 * live telemetry read straight out of the shared meter block inside a rAF loop and written
 * to the DOM by hand — none of it goes through React state, because at 60fps that would
 * re-render the whole tree while audio is running.
 */

import { useEffect, useRef, useState } from "react";
import { useAnimationLoop, useEngine, useEngineState, useMidiState } from "../hooks/use-engine";
import { Segment } from "./controls";

function Telemetry() {
  const client = useEngine();
  const { info, status } = useEngineState();
  const cpuRef = useRef<HTMLSpanElement>(null);
  const cpuBarRef = useRef<HTMLDivElement>(null);
  const rtRef = useRef<HTMLSpanElement>(null);
  const dspRef = useRef<HTMLSpanElement>(null);
  const acc = useRef(0);

  // ~10Hz. CPU and latency do not need 60.
  useAnimationLoop((dt) => {
    acc.current += dt;
    if (acc.current < 100) return;
    acc.current = 0;
    client.pollMeters();
    const m = client.meters;

    const pct = Math.min(100, Math.round(m.cpu * 100));
    if (cpuRef.current) cpuRef.current.textContent = `${String(pct).padStart(2, "0")}%`;
    if (cpuBarRef.current) {
      cpuBarRef.current.style.width = `${pct}%`;
      cpuBarRef.current.style.background =
        pct > 85 ? "var(--vk-red)" : pct > 60 ? "var(--vk-amber)" : "var(--vk-green)";
    }

    const sr = info?.sampleRate ?? 0;
    const dspMs = sr ? (m.latencySamples / sr) * 1000 : 0;
    if (dspRef.current) dspRef.current.textContent = sr ? `${dspMs.toFixed(1)}ms` : "--";
    if (rtRef.current) {
      const ioMs = ((info?.inputLatency ?? 0) + (info?.outputLatency ?? 0)) * 1000;
      rtRef.current.textContent = sr ? `${(ioMs + dspMs).toFixed(1)}ms` : "--";
    }
  }, status === "running");

  const sr = info?.sampleRate ?? 0;

  return (
    <>
      <Segment title="Engine sample rate as the device actually granted it">
        <span className="vk-label mr-1">SR</span>
        {sr ? `${(sr / 1000).toFixed(1)}k` : "--"}
      </Segment>
      <Segment title="Frames per DSP block">
        <span className="vk-label mr-1">BLOCK</span>
        {info?.blockFrames ?? "--"}
      </Segment>
      <Segment title="Total round trip: device input + DSP + device output">
        <span className="vk-label mr-1">RT</span>
        <span ref={rtRef}>--</span>
      </Segment>
      <Segment title="Latency introduced by the chain itself (lookahead + STFT modules)">
        <span className="vk-label mr-1">DSP</span>
        <span ref={dspRef}>--</span>
      </Segment>
      <Segment className="flex items-center gap-[6px]" title="Share of the audio callback budget in use">
        <span className="vk-label">CPU</span>
        <div style={{ width: 34, height: 5, background: "#0b0d10", borderRadius: 1, overflow: "hidden" }}>
          <div ref={cpuBarRef} style={{ width: "0%", height: "100%", background: "var(--vk-green)" }} />
        </div>
        <span ref={cpuRef} style={{ display: "inline-block", width: 26, textAlign: "right" }}>
          00%
        </span>
      </Segment>
    </>
  );
}

function MidiLed() {
  const midi = useMidiState();
  const dotRef = useRef<HTMLSpanElement>(null);
  const lastRef = useRef(0);
  lastRef.current = midi.lastActivity;

  useEffect(() => {
    if (!midi.enabled) return;
    const t = window.setInterval(() => {
      if (dotRef.current) dotRef.current.dataset.on = Date.now() - lastRef.current < 180 ? "true" : "false";
    }, 60);
    return () => window.clearInterval(t);
  }, [midi.enabled]);

  if (!midi.supported) return null;
  return (
    <Segment className="flex items-center gap-[6px]" title={midi.lastMessage || "MIDI activity"}>
      <span className="vk-label">MIDI</span>
      <span ref={dotRef} className="vk-led" data-on="false" data-tone="cyan" />
    </Segment>
  );
}

const STATUS_TONE: Record<string, string> = {
  idle: "var(--vk-text-dim)",
  starting: "var(--vk-amber)",
  running: "var(--vk-green)",
  suspended: "var(--vk-amber)",
  error: "var(--vk-red)",
};

export function TopBar() {
  const client = useEngine();
  const { status, error, info, backendName, activePresetId, dirty } = useEngineState();
  const [busy, setBusy] = useState(false);

  const engage = async () => {
    setBusy(true);
    try {
      await client.toggle();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const running = status === "running";

  return (
    <header
      className="flex shrink-0 items-center gap-2 px-3"
      style={{ height: 46, background: "var(--vk-panel)", borderBottom: "1px solid var(--vk-line)" }}
    >
      <div className="flex shrink-0 items-center pr-1" title="Bro.Kodr">
        <img
          src="/brand/brokodr-logo.png"
          alt="Bro.Kodr"
          draggable={false}
          style={{ height: 26, width: "auto", display: "block" }}
        />
      </div>

      <button
        className={`vk-btn vk-focus-ring ${running ? "" : "vk-standby"}`}
        onClick={engage}
        disabled={busy || status === "starting"}
        data-active={running}
        style={{ minWidth: 108, height: 28, fontSize: 11, letterSpacing: "0.14em", fontWeight: 700, justifyContent: "center" }}
        title="Start or stop the audio engine. Opens the selected input device."
      >
        <span className="vk-led" data-on={running} data-tone={running ? "green" : undefined} />
        {status === "starting" || busy ? "…" : running ? "ENGAGED" : "STANDBY"}
      </button>

      <Segment className="flex items-center gap-[6px]">
        <span style={{ color: STATUS_TONE[status] ?? "var(--vk-text-mid)" }}>{status.toUpperCase()}</span>
        <span style={{ color: "var(--vk-text-dim)" }}>{backendName}</span>
      </Segment>

      <Telemetry />
      <MidiLed />

      <div className="min-w-0 flex-1" />

      {activePresetId && (
        <Segment className="max-w-[190px] truncate" title="Active preset">
          <span className="vk-label mr-1">PRESET</span>
          {activePresetId}
          {dirty && <span style={{ color: "var(--vk-amber)" }}> *</span>}
        </Segment>
      )}

      {info && !info.sharedMemory && (
        <Segment title="SharedArrayBuffer is unavailable so the engine fell back to postMessage transport. Parameters still apply; scope and capture are degraded.">
          <span style={{ color: "var(--vk-amber)" }}>NO SAB</span>
        </Segment>
      )}

      {error && (
        <Segment className="max-w-[300px] truncate" title={error}>
          <span style={{ color: "var(--vk-red)" }}>{error}</span>
        </Segment>
      )}

      <button
        className="vk-btn vk-focus-ring"
        data-tone="danger"
        onClick={() => client.panic()}
        title="Silence output and clear every effect's internal state (Esc)"
      >
        PANIC
      </button>
    </header>
  );
}
