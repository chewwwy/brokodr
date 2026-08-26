/**
 * Bro.Kodr — main workspace.
 *
 * Fixed-height three-column layout: the page itself never scrolls, each pane scrolls
 * internally. That matters more than it sounds — a rack with twenty modules must not push
 * the meters off screen while you're setting levels.
 */

import { useEffect, useState } from "react";
import { useEngine, useEngineState } from "../hooks/use-engine";
import { FACTORY_PRESETS } from "../audio/presets";
import { Section, useHotkeys } from "../components/controls";
import { DevicePanel } from "../components/device-panel";
import { FilePanel } from "../components/file-panel";
import { IoStrip } from "../components/io-strip";
import { ScopeStrip } from "../components/meters";
import { MidiPanel } from "../components/midi-panel";
import { PresetBrowser } from "../components/preset-browser";
import { Rack } from "../components/rack";
import { RecorderPanel } from "../components/recorder-panel";
import { TopBar } from "../components/topbar";

type ScopeMode = "vu" | "spectrum";

/**
 * Left-rail colour coding. One hue per panel so the eye finds a panel by colour before it
 * reads the label. These are deliberately the same family as the rack's category colours
 * (see CATEGORY_COLOR in rack.tsx) so the whole window reads as one instrument, and the
 * header renders them as a dark wash with a bright tint of the same hue — never coloured
 * text on a coloured field.
 */
const RAIL_TONE = {
  presets: "#ffb020",
  device: "#35d6d0",
  file: "#4ade80",
  voice: "#f472b6",
  midi: "#a78bfa",
  shortcuts: "#7d8794",
  about: "#ff6b2c",
} as const;

/** Shown in ABOUT. Kept next to the rail tones so there is one place to bump it. */
const APP_VERSION = "1.0.0";

function ScopeHeader({
  mode,
  setMode,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: {
  mode: ScopeMode;
  setMode: (m: ScopeMode) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 px-2 py-[5px]" style={{ borderBottom: "1px solid var(--vk-line)" }}>
      <span className="vk-title">ANALYSER</span>
      <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
{mode === "vu" ? "output level · 0 VU = -18 dBFS" : "cyan = input · amber = output"}
      </span>
      <div className="flex-1" />
      <button
        className="vk-btn vk-focus-ring"
        style={{ fontSize: 9, padding: "2px 6px" }}
        onClick={onUndo}
        disabled={!canUndo}
        title="Undo the last chain change (Ctrl+Z)"
      >
        UNDO
      </button>
      <button
        className="vk-btn vk-focus-ring"
        style={{ fontSize: 9, padding: "2px 6px" }}
        onClick={onRedo}
        disabled={!canRedo}
        title="Redo (Ctrl+Y)"
      >
        REDO
      </button>
      {(
        [
          { id: "vu", label: "VU / SCOPE", hint: "Analogue VU meters and a triggered oscilloscope" },
          { id: "spectrum", label: "SPECTRUM", hint: "Waveform and log-frequency spectrum" },
        ] as const
      ).map((v) => (
        <button
          key={v.id}
          className="vk-btn vk-focus-ring"
          data-active={mode === v.id}
          style={{ fontSize: 9, padding: "2px 6px" }}
          onClick={() => setMode(v.id)}
          title={v.hint}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

function Index() {
  const client = useEngine();
  const { slots, io, status } = useEngineState();
  const [scopeMode, setScopeMode] = useState<ScopeMode>("vu");
  const [history, setHistory] = useState<{ past: string[]; future: string[] }>({ past: [], future: [] });

  // Load a starting chain the first time the app is opened so the rack is never empty.
  useEffect(() => {
    if (client.getSnapshot().slots.length === 0) {
      const init = FACTORY_PRESETS.find((p) => p.id === "init");
      if (init) client.loadChain(init.chain, init.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Undo is a plain snapshot stack of serialised chains. Cheap, and it survives reorders,
  // preset loads and parameter sweeps identically.
  useEffect(() => {
    const snapshot = JSON.stringify(client.exportChain());
    setHistory((h) => {
      if (h.past[h.past.length - 1] === snapshot) return h;
      return { past: [...h.past, snapshot].slice(-60), future: [] };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, io]);

  const undo = () => {
    setHistory((h) => {
      if (h.past.length < 2) return h;
      const past = h.past.slice(0, -1);
      const current = h.past[h.past.length - 1];
      client.loadChain(JSON.parse(past[past.length - 1]));
      return { past, future: [current, ...h.future].slice(0, 60) };
    });
  };

  const redo = () => {
    setHistory((h) => {
      if (!h.future.length) return h;
      const [next, ...future] = h.future;
      client.loadChain(JSON.parse(next));
      return { past: [...h.past, next], future };
    });
  };

  useHotkeys({
    b: () => client.setIo("bypass", !client.getSnapshot().io.bypass),
    m: () => client.setIo("mute", !client.getSnapshot().io.mute),
    escape: () => client.panic(),
    "mod+z": undo,
    "mod+y": redo,
    "mod+shift+z": redo,
    ...Object.fromEntries(
      FACTORY_PRESETS.slice(0, 9).map((p, i) => [
        String(i + 1),
        () => client.loadChain(p.chain, p.id),
      ]),
    ),
  });

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden" style={{ background: "var(--vk-void)" }}>
      <TopBar />

      <div className="flex min-h-0 flex-1">
        {/* ------------------------------------------------------ left rail */}
        <div
          className="flex shrink-0 flex-col gap-2 overflow-y-auto p-2"
          style={{ width: 268, background: "var(--vk-panel-lo)", borderRight: "1px solid var(--vk-line)" }}
        >
          <Section title="PRESETS" tone={RAIL_TONE.presets}>
            <PresetBrowser />
          </Section>
          <Section title="AUDIO DEVICE" tone={RAIL_TONE.device}>
            <DevicePanel />
          </Section>
          <Section title="AUDIO FILE" tone={RAIL_TONE.file}>
            <FilePanel />
          </Section>
          <Section title="MIDI CONTROL" tone={RAIL_TONE.midi} defaultOpen={false}>
            <MidiPanel />
          </Section>
          <Section title="SHORTCUTS" tone={RAIL_TONE.shortcuts} defaultOpen={false}>
            <dl className="vk-mono grid grid-cols-[auto_1fr] gap-x-2 gap-y-[3px] text-[10px]" style={{ color: "var(--vk-text-mid)" }}>
              {[
                ["Space", "Record / stop"],
                ["B", "Master bypass"],
                ["M", "Mute output"],
                ["Esc", "Panic"],
                ["1–9", "Load factory preset"],
                ["Ctrl+Z", "Undo"],
                ["Ctrl+Y", "Redo"],
                ["Shift+drag", "Fine knob adjust"],
                ["Double-click", "Type a value"],
                ["Right-click knob", "MIDI learn"],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt style={{ color: "var(--vk-amber)" }}>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Section>
          <Section title="ABOUT" tone={RAIL_TONE.about} defaultOpen={false}>
            <div className="flex flex-col gap-[6px] text-[11px]" style={{ color: "var(--vk-text-mid)" }}>
              <img
                src="/brand/brokodr-logo.png"
                alt="Bro.Kodr"
                draggable={false}
                style={{ width: "100%", maxWidth: 200, height: "auto" }}
              />
              <div className="vk-mono grid grid-cols-[auto_1fr] gap-x-2 gap-y-[3px] text-[10px]">
                <span style={{ color: "var(--vk-text-dim)" }}>VERSION</span>
                <span>{APP_VERSION}</span>
                <span style={{ color: "var(--vk-text-dim)" }}>CREATOR</span>
                <span style={{ color: "var(--vk-text)" }}>Kane Bateman</span>
                <span style={{ color: "var(--vk-text-dim)" }}>COUNTRY</span>
                <span>Australia</span>
              </div>
              <div style={{ color: "var(--vk-text-dim)", fontSize: 10, lineHeight: 1.45 }}>
                Real-time voice and audio processor. All DSP hand-written — no stock Web Audio
                effect nodes anywhere in the chain.
              </div>
            </div>
          </Section>
        </div>

        {/* -------------------------------------------------------- centre */}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 p-2">
          <div className="vk-panel flex shrink-0 flex-col" style={{ height: 148 }}>
            <ScopeHeader
              mode={scopeMode}
              setMode={setScopeMode}
              onUndo={undo}
              onRedo={redo}
              canUndo={history.past.length > 1}
              canRedo={history.future.length > 0}
            />
            <div className="min-h-0 flex-1 p-1">
              <ScopeStrip mode={scopeMode} />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            <Rack />
          </div>

          <RecorderPanel />
        </main>

        {/* --------------------------------------------------------- right */}
        <IoStrip voiceTone={RAIL_TONE.voice} />
      </div>

      {status === "idle" && (
        <div
          className="vk-mono flex shrink-0 items-center gap-2 px-3 py-[5px] text-[10px]"
          style={{ background: "var(--vk-panel)", borderTop: "1px solid var(--vk-line)", color: "var(--vk-text-mid)" }}
        >
          <span className="vk-led" data-on={false} />
          Engine is in standby. Press ENGAGE to open your input device and start processing. Use
          headphones — monitoring a microphone through speakers will feed back.
        </div>
      )}
    </div>
  );
}

export default Index;
