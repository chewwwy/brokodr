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
import { PadGrid } from "../components/brobeats/pad-grid";
import { PadEditor } from "../components/brobeats/pad-editor";
import { SampleEditor } from "../components/brobeats/sample-editor";
import { KitBrowser } from "../components/brobeats/kit-browser";
import { LoopDeck } from "../components/brobeats/loop-deck";
import { SmartVoicePanel } from "../components/brobeats/smart-voice-panel";
import { RecorderPanel } from "../components/recorder-panel";
import { TopBar } from "../components/topbar";

type ScopeMode = "vu" | "spectrum";

/** Centre-pane workspaces. The rest of the window (analyser, rails, I/O) is shared. */
type Workspace = "rack" | "brobeats" | "loops";

/**
 * The BROBEATS right-hand column carries four views against the same pad grid: the pad's
 * own voice, the sample bench that feeds it, the library of saved kits, and Smart Voice —
 * the beatbox detector that plays the same pads with your mouth. They are tabbed rather
 * than stacked because each is tall, and you are only ever doing one of them at a time —
 * cut a sound, send it to a pad, shape the pad, calibrate, save the kit.
 */
type BeatsTab = "pad" | "sample" | "kits" | "voice";

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
  const [workspace, setWorkspace] = useState<Workspace>("rack");
  const [selectedPad, setSelectedPad] = useState(0);
  const [beatsTab, setBeatsTab] = useState<BeatsTab>("pad");
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
    // Number keys are preset recall in the rack — but they are the top pad row in
    // BROBEATS, and a keystroke cannot mean both. The visible workspace wins.
    ...(workspace === "rack"
      ? Object.fromEntries(
          FACTORY_PRESETS.slice(0, 9).map((p, i) => [
            String(i + 1),
            () => client.loadChain(p.chain, p.id),
          ]),
        )
      : {}),
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
                ["1–9", "Load factory preset (RACK)"],
                ["Z X C V …", "Play pads (BROBEATS)"],
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

          {/* workspace switch */}
          <div className="flex shrink-0 items-center gap-2">
            {(
              [
                { id: "rack", label: "RACK", hint: "The effect chain your voice runs through" },
                { id: "brobeats", label: "BROBEATS", hint: "Sixteen-pad drum rack — play it, sculpt it, drop samples on it" },
                { id: "loops", label: "LOOPS", hint: "Four loop lanes and the transport — record over yourself in time" },
              ] as const
            ).map((v) => (
              <button
                key={v.id}
                className="vk-btn vk-focus-ring"
                data-active={workspace === v.id}
                style={{ fontSize: 10, padding: "3px 10px" }}
                onClick={() => setWorkspace(v.id)}
                title={v.hint}
              >
                {v.label}
              </button>
            ))}
            <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
              {workspace === "rack"
                ? "signal flows left to right — drag modules to reorder"
                : workspace === "loops"
                  ? "REC punches on the quantise grid · a second punch closes the loop · a third overdubs"
                  : "hit a pad to select and play it · drop an audio file on a pad to load it"}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {workspace === "rack" ? (
              <Rack />
            ) : workspace === "loops" ? (
              <LoopDeck />
            ) : (
              // Side by side once the centre column can carry both (the editor needs
              // ~420px before its knob rows start wrapping into unreadable slivers);
              // stacked below that, grid first, with the whole thing scrolling as one.
              <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto xl:flex-row xl:overflow-hidden">
                <div className="vk-panel shrink-0 p-2 xl:overflow-y-auto" style={{ width: "100%", maxWidth: 372 }}>
                  <PadGrid selected={selectedPad} onSelect={setSelectedPad} />
                </div>
                <div className="flex min-w-0 shrink-0 flex-col gap-2 xl:shrink xl:flex-1 xl:overflow-y-auto">
                  <div className="flex shrink-0 items-center gap-2">
                    {(
                      [
                        { id: "pad", label: "PAD", hint: "The selected pad's source, envelope, voice and effects" },
                        { id: "sample", label: "SAMPLE", hint: "Record or import audio, cut it, and send it to a pad" },
                        { id: "kits", label: "KITS", hint: "Save the whole sixteen-pad kit under a name, and load it back" },
                        { id: "voice", label: "VOICE", hint: "Smart Voice — beatbox into the mic and it plays the pads" },
                      ] as const
                    ).map((t) => (
                      <button
                        key={t.id}
                        className="vk-btn vk-focus-ring"
                        data-active={beatsTab === t.id}
                        style={{ fontSize: 9, padding: "2px 10px" }}
                        onClick={() => setBeatsTab(t.id)}
                        title={t.hint}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                  {/*
                    Both panels stay mounted and the inactive one is hidden, rather than
                    swapping one for the other. The sample editor holds the only copy of a
                    capture you have not sent anywhere yet — unmounting it on a tab change
                    would throw away the take, the trim and the slices the moment you looked
                    at the pad you just filled. `active` is what tells it to stop painting
                    and stop auditioning while it is out of sight.
                  */}
                  <div className={beatsTab === "pad" ? "contents" : "hidden"}>
                    <PadEditor index={selectedPad} />
                  </div>
                  <div className={beatsTab === "sample" ? "contents" : "hidden"}>
                    <SampleEditor
                      active={beatsTab === "sample"}
                      onSelectPad={(i, focus) => {
                        // Sending a sample to a pad selects it, so the grid is already
                        // pointing at the thing you just made. Only a single deliberate
                        // send pulls the pad editor forward with it.
                        setSelectedPad(i);
                        if (focus) setBeatsTab("pad");
                      }}
                    />
                  </div>
                  {/*
                    Mounted alongside the other two for the same reason, and because the
                    kit list is a query — keeping it mounted means switching to this tab
                    shows the library immediately instead of a loading flash every time.
                  */}
                  <div className={beatsTab === "kits" ? "contents" : "hidden"}>
                    <KitBrowser />
                  </div>
                  {/*
                    Mounted with the rest, and `active` matters more here than anywhere:
                    a calibration pass leaves the detector's capture armed, which
                    suppresses pad firing. Looking away mid-pass has to disarm it, or
                    Smart Voice reads as broken for the rest of the session.
                  */}
                  <div className={beatsTab === "voice" ? "contents" : "hidden"}>
                    <SmartVoicePanel active={beatsTab === "voice"} />
                  </div>
                </div>
              </div>
            )}
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
