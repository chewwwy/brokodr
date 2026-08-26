/**
 * Bro.Kodr — recorder.
 *
 * Capture happens on the audio thread into a shared ring; this panel only starts, stops
 * and drains it. Two streams are captured in parallel — the processed signal you were
 * monitoring and the raw pre-effects input — so you can re-process a take later through a
 * different chain instead of re-performing it.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import {
  buildWaveform,
  DEFAULT_EXPORT,
  downloadBlob,
  exportTake,
  formatDuration,
  nextTakeName,
  takeDuration,
  takeToAudioBuffer,
  type BitDepth,
  type ExportOptions,
  type Take,
} from "../audio/recorder";
import { useDesktop } from "../hooks/use-desktop";
import { useAnimationLoop, useEngine, useEngineState } from "../hooks/use-engine";
import { LabeledSelect, Toggle, useHotkeys } from "./controls";
import { StaticWaveform } from "./meters";

function ElapsedReadout({ active }: { active: boolean }) {
  const client = useEngine();
  const ref = useRef<HTMLSpanElement>(null);
  const acc = useRef(0);

  useAnimationLoop((dt) => {
    acc.current += dt;
    if (acc.current < 100) return;
    acc.current = 0;
    if (!ref.current) return;
    const sr = client.sampleRate() || 48000;
    ref.current.textContent = formatDuration(client.recordedFrames() / sr);
  }, active);

  return (
    <span ref={ref} className="vk-display" style={{ fontSize: 20, color: "var(--vk-amber)" }}>
      00:00.0
    </span>
  );
}

export function RecorderPanel() {
  const client = useEngine();
  const { status, activePresetId } = useEngineState();
  const [takes, setTakes] = useState<Take[]>([]);
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_EXPORT);
  const [note, setNote] = useState<string | null>(null);
  // Export options and the take list stay folded away by default — the rack needs the
  // vertical space far more than the fade-time fields do.
  const [expanded, setExpanded] = useState(false);
  const playing = useRef<AudioBufferSourceNode | null>(null);
  const desktop = useDesktop();

  const running = status === "running";
  const active = takes.find((t) => t.id === selected) ?? null;

  const start = () => {
    if (!running) {
      setNote("Press ENGAGE first — there is no signal to record.");
      return;
    }
    client.setRecording(true, false, true);
    setRecording(true);
    setPaused(false);
    setNote(null);
  };

  const togglePause = () => {
    const next = !paused;
    client.setRecording(true, next, false);
    setPaused(next);
  };

  const stop = useCallback(() => {
    client.setRecording(false, false, false);
    setRecording(false);
    setPaused(false);
    const cap = client.takeRecording();
    if (!cap || !cap.wet.l.length) {
      setNote("Nothing was captured. Shared memory may be unavailable in this context.");
      return;
    }
    const take: Take = {
      id: `take-${Date.now().toString(36)}`,
      name: nextTakeName(),
      createdAt: Date.now(),
      sampleRate: client.sampleRate() || 48000,
      frames: cap.wet.l.length,
      wet: cap.wet,
      dry: cap.dry,
      chainLabel: activePresetId ?? "custom chain",
    };
    setTakes((t) => [take, ...t]);
    setSelected(take.id);
    setNote(null);
  }, [client, activePresetId]);

  const toggleRecord = () => (recording ? stop() : start());

  useHotkeys({
    " ": (e) => {
      e.preventDefault();
      toggleRecord();
    },
  });

  const peaks = useMemo(() => (active ? buildWaveform(active, 480) : new Float32Array(0)), [active]);

  const play = () => {
    if (!active) return;
    const ctx = client.audioContext();
    if (!ctx) {
      setNote("Engine is not running, so there is no audio context to play through.");
      return;
    }
    playing.current?.stop();
    const src = ctx.createBufferSource();
    src.buffer = takeToAudioBuffer(ctx, active, opts.source);
    src.connect(ctx.destination);
    src.onended = () => {
      playing.current = null;
    };
    src.start();
    playing.current = src;
  };

  const stopPlay = () => {
    playing.current?.stop();
    playing.current = null;
  };

  /**
   * On the desktop this writes straight to disk through a native save dialog. In a browser
   * there is no filesystem, so it falls back to a download.
   */
  const doExport = async () => {
    if (!active) return;
    const { blob, filename } = exportTake(active, opts);
    const size = `${(blob.size / 1048576).toFixed(2)} MB`;

    if (desktop) {
      try {
        const dir = await desktop.recordingsDir();
        const target = await desktop.showSaveDialog({
          title: "Export take",
          defaultPath: `${dir}/${filename}`,
          filters: [{ name: "WAV audio", extensions: ["wav"] }],
        });
        if (!target) return;
        await desktop.writeBinaryFile(target, await blob.arrayBuffer());
        setNote(`Wrote ${target} (${size}).`);
        void desktop.showItemInFolder(target);
        return;
      } catch (e) {
        setNote(`Native save failed (${(e as Error).message}); falling back to download.`);
      }
    }

    downloadBlob(blob, filename);
    setNote(`Exported ${filename} (${size}).`);
  };

  const removeTake = (id: string) => {
    setTakes((t) => t.filter((x) => x.id !== id));
    if (selected === id) setSelected(null);
  };

  return (
    <div className="vk-panel flex shrink-0 flex-col overflow-hidden">
      {/* Striped red header — the recorder is the only destructive control here, so it
          is the only red field in the app. */}
      <div className="rec-header flex items-center gap-2 px-2 py-[5px]">
        <button
          className="vk-title flex items-center gap-[6px]"
          style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", padding: 0 }}
          onClick={() => setExpanded((v) => !v)}
          title="Show or hide export options and the take list"
        >
          <span style={{ fontSize: 8, opacity: 0.75 }}>{expanded ? "▼" : "▶"}</span>
          RECORDER
        </button>
        {!expanded && takes.length > 0 && (
          <span className="vk-label" style={{ opacity: 0.85 }}>
            {takes.length} take{takes.length === 1 ? "" : "s"}
          </span>
        )}
        <div className="flex-1" />
        <ElapsedReadout active={recording && !paused} />
      </div>

      <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-2">
        <button
          className="rec-btn vk-focus-ring"
          data-armed={recording}
          data-paused={paused}
          onClick={toggleRecord}
          title="Start or stop recording (Space)"
          aria-label={recording ? "Stop recording" : "Start recording"}
        />
        <div className="flex flex-col" style={{ lineHeight: 1.15 }}>
          <span
            className="vk-title"
            style={{ color: recording ? "var(--vk-red)" : "var(--vk-text-mid)", fontSize: 10 }}
          >
            {recording ? (paused ? "PAUSED" : "RECORDING") : "READY"}
          </span>
          <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
            {recording ? "click to stop" : "space bar"}
          </span>
        </div>
        <button
          className="vk-btn vk-focus-ring"
          data-active={paused}
          onClick={togglePause}
          disabled={!recording}
          title="Pause capture without ending the take"
        >
          {paused ? "RESUME" : "PAUSE"}
        </button>

        <div className="flex-1" />

        <button className="vk-btn vk-focus-ring" onClick={play} disabled={!active} title="Audition the selected take">
          PLAY
        </button>
        <button className="vk-btn vk-focus-ring" onClick={stopPlay} disabled={!active}>
          ■
        </button>
        <button
          className="vk-btn vk-focus-ring"
          data-tone="cyan"
          onClick={() => void doExport()}
          disabled={!active}
          title="Write the selected take to a WAV file"
        >
          EXPORT WAV
        </button>
      </div>

      {expanded && active && (
        <div className="vk-well" style={{ padding: 2 }}>
          <StaticWaveform peaks={peaks} height={54} />
        </div>
      )}

      {expanded && (
      <>
      <div className="grid grid-cols-4 gap-2">
        <LabeledSelect
          label="Source"
          value={opts.source}
          onChange={(v) => setOpts((o) => ({ ...o, source: v as "wet" | "dry" }))}
          options={[
            { value: "wet", label: "Processed" },
            { value: "dry", label: "Clean input" },
          ]}
          disabled={opts.source === "dry" && !active?.dry}
          title="Clean input is the pre-effects capture, for re-processing later"
        />
        <LabeledSelect
          label="Bit depth"
          value={String(opts.bitDepth)}
          onChange={(v) => setOpts((o) => ({ ...o, bitDepth: Number(v) as BitDepth }))}
          options={[
            { value: "16", label: "16-bit" },
            { value: "24", label: "24-bit" },
            { value: "32", label: "32-bit float" },
          ]}
        />
        <LabeledSelect
          label="Normalize"
          value={opts.normalizeDb === null ? "off" : String(opts.normalizeDb)}
          onChange={(v) => setOpts((o) => ({ ...o, normalizeDb: v === "off" ? null : Number(v) }))}
          options={[
            { value: "off", label: "Off" },
            { value: "-0.3", label: "-0.3 dBFS" },
            { value: "-1", label: "-1 dBFS" },
            { value: "-3", label: "-3 dBFS" },
            { value: "-6", label: "-6 dBFS" },
          ]}
          title="Peak-normalise the export to this level"
        />
        <LabeledSelect
          label="Trim silence"
          value={opts.trimSilenceDb === null ? "off" : String(opts.trimSilenceDb)}
          onChange={(v) => setOpts((o) => ({ ...o, trimSilenceDb: v === "off" ? null : Number(v) }))}
          options={[
            { value: "off", label: "Off" },
            { value: "-60", label: "Below -60 dB" },
            { value: "-48", label: "Below -48 dB" },
            { value: "-36", label: "Below -36 dB" },
          ]}
          title="Strip leading and trailing silence"
        />
      </div>

      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-[3px]">
          <span className="vk-label">Fade in ms</span>
          <input
            className="vk-input"
            type="number"
            min={0}
            max={2000}
            value={opts.fadeInMs}
            onChange={(e) => setOpts((o) => ({ ...o, fadeInMs: Math.max(0, Number(e.target.value) || 0) }))}
            style={{ width: 72 }}
          />
        </label>
        <label className="flex flex-col gap-[3px]">
          <span className="vk-label">Fade out ms</span>
          <input
            className="vk-input"
            type="number"
            min={0}
            max={2000}
            value={opts.fadeOutMs}
            onChange={(e) => setOpts((o) => ({ ...o, fadeOutMs: Math.max(0, Number(e.target.value) || 0) }))}
            style={{ width: 72 }}
          />
        </label>
        <div style={{ width: 92 }}>
          <Toggle on={opts.mono} onChange={(v) => setOpts((o) => ({ ...o, mono: v }))} label="MONO FILE" />
        </div>
        <div className="flex-1" />
        <span className="vk-label">{takes.length ? `${takes.length} take${takes.length === 1 ? "" : "s"}` : "No takes"}</span>
      </div>

      {takes.length > 0 && (
        <div className="flex max-h-[104px] flex-col gap-[2px] overflow-y-auto">
          {takes.map((t) => (
            <div
              key={t.id}
              className="vk-well group flex items-center gap-2 px-2 py-[4px]"
              style={{ borderColor: selected === t.id ? "var(--vk-amber)" : undefined, cursor: "pointer" }}
              onClick={() => setSelected(t.id)}
              onKeyDown={(e) => e.key === "Enter" && setSelected(t.id)}
              role="button"
              tabIndex={0}
            >
              <span className="vk-led" data-on={selected === t.id} />
              <span className="min-w-0 flex-1 truncate text-[11px]">{t.name}</span>
              <span className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)" }}>
                {t.chainLabel}
              </span>
              <span className="vk-mono text-[10px]" style={{ color: "var(--vk-text-mid)" }}>
                {formatDuration(takeDuration(t))}
              </span>
              {!t.dry && (
                <span className="vk-label" style={{ color: "var(--vk-text-dim)" }} title="No clean capture for this take">
                  wet only
                </span>
              )}
              <button
                className="vk-btn vk-focus-ring opacity-0 group-hover:opacity-100"
                data-tone="danger"
                style={{ fontSize: 9, padding: "1px 4px" }}
                onClick={(e) => {
                  e.stopPropagation();
                  removeTake(t.id);
                }}
                title="Discard this take"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      </>
      )}

      {note && (
        <div className="vk-well vk-mono px-2 py-1 text-[10px]" style={{ color: "var(--vk-amber)" }}>
          {note}
        </div>
      )}
      </div>
    </div>
  );
}
