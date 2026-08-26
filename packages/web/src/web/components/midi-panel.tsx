/**
 * Bro.Kodr — MIDI panel.
 *
 * CC learn works the way hardware does: arm a target, move a knob on the controller, done.
 * Mappings are stored against the effect *type* as well as the slot id, so loading a
 * preset that recreates the slot keeps your controller wired up.
 */

import { noteName } from "../audio/midi";
import { EFFECTS, paramDef } from "../audio/param-schema";
import { useEngine, useEngineState, useMidi, useMidiState } from "../hooks/use-engine";
import { LabeledSelect, Toggle } from "./controls";

const IO_LABELS: Record<string, string> = {
  inGain: "Input trim",
  outGain: "Output gain",
  masterMix: "Master dry/wet",
  mute: "Mute",
  bypass: "Master bypass",
};

export function MidiPanel() {
  const midi = useMidi();
  const snap = useMidiState();
  const client = useEngine();
  const { slots } = useEngineState();

  if (!snap.supported) {
    return (
      <div className="vk-mono text-[10px]" style={{ color: "var(--vk-text-mid)", lineHeight: 1.5 }}>
        This runtime has no Web MIDI. In the packaged desktop build MIDI is available; in a browser
        it needs Chrome or Edge.
      </div>
    );
  }

  const describe = (m: (typeof snap.settings.mappings)[number]) => {
    if (m.kind === "io") return IO_LABELS[m.ioKey ?? ""] ?? "I/O";
    const slot = slots.find((s) => s.id === m.slotId);
    const type = slot?.type ?? m.slotType ?? "?";
    const fxName = EFFECTS[type]?.short ?? type;
    const missing = !slot ? " (slot gone)" : "";
    if (m.kind === "mix") return `${fxName} · dry/wet${missing}`;
    if (m.kind === "bypass") return `${fxName} · bypass${missing}`;
    const def = m.paramKey ? paramDef(type, m.paramKey) : null;
    return `${fxName} · ${def?.label ?? m.paramKey}${missing}`;
  };

  return (
    <div className="flex flex-col gap-2">
      <Toggle
        on={snap.enabled}
        onChange={(v) => (v ? void midi.enable() : midi.disable())}
        label={snap.enabled ? "MIDI ACTIVE" : "MIDI OFF"}
        tone="cyan"
        title="Request Web MIDI access and start listening"
      />

      {snap.error && (
        <div className="vk-well vk-mono px-2 py-1 text-[10px]" style={{ color: "var(--vk-red)" }}>
          {snap.error}
        </div>
      )}

      {snap.enabled && (
        <div className="vk-well px-2 py-[6px]">
          <div className="vk-label mb-1">Inputs</div>
          {snap.inputs.length === 0 ? (
            <div className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)" }}>
              No controllers detected.
            </div>
          ) : (
            snap.inputs.map((i) => (
              <div key={i.id} className="flex items-center gap-[6px] text-[10px]">
                <span className="vk-led" data-on={i.connected} data-tone="cyan" />
                <span className="truncate">{i.name}</span>
                <span style={{ color: "var(--vk-text-dim)" }}>{i.manufacturer}</span>
              </div>
            ))
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <LabeledSelect
          label="Note mode"
          value={snap.settings.noteMode}
          onChange={(v) => midi.setNoteMode(v as "off" | "pitch" | "vocoder" | "talkbox")}
          options={[
            { value: "off", label: "Off" },
            { value: "pitch", label: "Drive pitch shift" },
            { value: "vocoder", label: "Play vocoder carrier" },
            { value: "talkbox", label: "Play talk box driver" },
          ]}
          title="What incoming notes do. Pitch mode transposes the shifter; vocoder mode plays the carrier oscillator; talk box mode frets the talk box driver."
        />
        <LabeledSelect
          label="Root note"
          value={String(snap.settings.rootNote)}
          onChange={(v) => midi.setRootNote(Number(v))}
          options={Array.from({ length: 25 }, (_, i) => {
            const n = 48 + i;
            return { value: String(n), label: `${noteName(n)} (${n})` };
          })}
          title="The note that means no transposition"
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="vk-label flex-1">
          {snap.settings.mappings.length} CC mapping{snap.settings.mappings.length === 1 ? "" : "s"}
        </span>
        {snap.learning && (
          <button className="vk-btn vk-focus-ring" data-active onClick={() => midi.cancelLearn()}>
            LISTENING — CANCEL
          </button>
        )}
        {snap.settings.mappings.length > 0 && (
          <button
            className="vk-btn vk-focus-ring"
            data-tone="danger"
            onClick={() => window.confirm("Clear every MIDI mapping?") && midi.clearMappings()}
          >
            CLEAR
          </button>
        )}
      </div>

      {snap.settings.mappings.length > 0 && (
        <div className="flex max-h-[180px] flex-col gap-[2px] overflow-y-auto">
          {snap.settings.mappings.map((m, i) => (
            <div key={`${m.channel}-${m.cc}-${i}`} className="vk-well flex items-center gap-2 px-2 py-[4px]">
              <span className="vk-mono shrink-0 text-[10px]" style={{ color: "var(--vk-cyan)", width: 56 }}>
                {m.channel < 0 ? "omni" : `ch${m.channel + 1}`}·cc{m.cc}
              </span>
              <span className="min-w-0 flex-1 truncate text-[10px]">{describe(m)}</span>
              <button
                className="vk-btn vk-focus-ring"
                data-active={m.invert}
                style={{ fontSize: 9, padding: "1px 4px" }}
                onClick={() => midi.toggleInvert(i)}
                title="Reverse the controller direction"
              >
                INV
              </button>
              <button
                className="vk-btn vk-focus-ring"
                data-tone="danger"
                style={{ fontSize: 9, padding: "1px 4px" }}
                onClick={() => midi.removeMapping(i)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="vk-well px-2 py-[6px]">
        <div className="vk-label mb-1">Quick learn</div>
        <div className="grid grid-cols-2 gap-1">
          {(["inGain", "outGain", "masterMix", "bypass"] as const).map((k) => (
            <button
              key={k}
              className="vk-btn vk-focus-ring justify-center"
              style={{ fontSize: 9 }}
              disabled={!snap.enabled}
              onClick={() => midi.startLearn({ kind: "io", ioKey: k })}
            >
              {IO_LABELS[k].toUpperCase()}
            </button>
          ))}
        </div>
        <p className="vk-label mt-2" style={{ textTransform: "none", letterSpacing: 0, lineHeight: 1.5, color: "var(--vk-text-dim)" }}>
          Right-click any knob in the rack to learn it to a CC. Press a control here, then move the
          controller.
        </p>
      </div>

      {slots.length === 0 && (
        <div className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)" }}>
          Add modules to the rack — {client.getSnapshot().slots.length} loaded — to map their params.
        </div>
      )}
    </div>
  );
}
