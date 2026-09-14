/**
 * Bro.Kodr — BROBEATS pad grid.
 *
 * Sixteen pads, laid out 4x4 with pad 1 at the bottom left the way a real MPC-style grid
 * is, so the kick sits under your thumb.
 *
 * Three things this file is careful about:
 *
 * 1. **Pad lighting never goes through React.** Each pad's level ring and flash come from
 *    the meter block, polled in one rAF loop and written straight to the DOM as style
 *    properties. Sixteen pads re-rendering at 60fps while you play is exactly the kind of
 *    thing that makes a drum grid feel laggy.
 *
 * 2. **Velocity comes from where you hit the pad.** Top of the pad is soft, bottom is
 *    hard, same as striking a real pad harder near the edge. It costs nothing and makes
 *    finger-drumming with a mouse far less flat.
 *
 * 3. **Triggering is on pointer-DOWN.** Waiting for click would add the full press-release
 *    time to every hit, which is audible.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DRUM_ROUTE, PAD_COUNT } from "../../audio/backend";
import { PAD_KEYBOARD } from "../../audio/pad-params";
import { useAnimationLoop, useEngine, useEngineState } from "../../hooks/use-engine";
import { Knob } from "../controls";
import type { ParamDef } from "../../audio/param-schema";

const KIT_GAIN: ParamDef = {
  key: "gain",
  label: "Kit",
  kind: "knob",
  min: -60,
  max: 12,
  def: 0,
  unit: "dB",
  decimals: 1,
};

/** Visual order: row 0 on screen is the TOP row, which is pads 12-15. */
const ROW_ORDER = [12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3];

const ROUTE_LABELS = [
  { value: DRUM_ROUTE.OFF, label: "OFF", hint: "Kit muted out of the signal path entirely" },
  { value: DRUM_ROUTE.DIRECT, label: "DIRECT", hint: "Kit goes straight to the output, untouched by the rack" },
  { value: DRUM_ROUTE.CHAIN, label: "THRU RACK", hint: "Kit runs through the master effect chain with the voice" },
];

function Pad({
  index,
  selected,
  onSelect,
}: {
  index: number;
  selected: boolean;
  onSelect: (i: number) => void;
}) {
  const client = useEngine();
  const { kit, status } = useEngineState();
  const pad = kit.pads[index];
  const ref = useRef<HTMLButtonElement | null>(null);
  const ringRef = useRef<HTMLSpanElement | null>(null);
  const [dropping, setDropping] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const key = PAD_KEYBOARD[index];
  const loaded = pad.source.kind !== "empty";

  // Meter-driven lighting. Written to the DOM directly — see the file header.
  useAnimationLoop(() => {
    const el = ref.current;
    const ring = ringRef.current;
    if (!el || !ring) return;
    const peak = client.meters.pads[index] ?? 0;
    const fired = (client.meters.padsFired & (1 << index)) !== 0;
    const lit = Math.min(1, peak * 1.6);
    ring.style.opacity = String(Math.max(fired ? 0.55 : 0, lit));
    el.style.borderColor = fired ? "var(--vk-amber)" : lit > 0.02 ? "var(--vk-amber-dim)" : "var(--vk-line)";
  }, status === "running");

  const hit = useCallback(
    (velocity: number) => {
      client.triggerPad(index, velocity);
    },
    [client, index],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    onSelect(index);
    const rect = e.currentTarget.getBoundingClientRect();
    // Top edge = 0.35, bottom edge = 1.0. Never zero: a hit you cannot hear reads as a bug.
    const y = (e.clientY - rect.top) / Math.max(1, rect.height);
    hit(0.35 + 0.65 * Math.min(1, Math.max(0, y)));
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerUp = () => {
    if (pad.params.mode < 0.5) client.releasePad(index);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropping(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    const msg = await client.loadPadFile(index, file);
    setErr(msg);
    if (msg) setTimeout(() => setErr(null), 4000);
  };

  const muted = pad.params.mute >= 0.5;
  const soloedElsewhere = kit.solo >= 0 && kit.solo !== index;

  return (
    <button
      ref={ref}
      className="vk-focus-ring relative flex flex-col justify-between overflow-hidden rounded-[3px] p-[6px] text-left"
      style={{
        aspectRatio: "1 / 1",
        background: selected ? "var(--vk-panel-hi)" : "var(--vk-panel)",
        border: "1px solid var(--vk-line)",
        outline: selected ? "1px solid var(--vk-amber)" : "none",
        opacity: muted || soloedElsewhere ? 0.45 : 1,
        boxShadow: dropping ? "inset 0 0 0 2px var(--vk-cyan)" : "inset 0 1px 0 rgb(255 255 255 / 4%)",
        cursor: "pointer",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragOver={(e) => {
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      title={
        loaded
          ? `${pad.name} — click to play, drop an audio file to replace${key ? `, key "${key.toUpperCase()}"` : ""}`
          : "Empty pad — drop an audio file here, or pick a generator in the editor"
      }
    >
      {/* level ring */}
      <span
        ref={ringRef}
        className="pointer-events-none absolute inset-0"
        style={{
          background: "radial-gradient(circle at 50% 55%, rgb(255 176 32 / 28%), transparent 70%)",
          opacity: 0,
        }}
      />

      <span className="relative flex w-full items-start justify-between gap-1">
        <span
          className="vk-mono truncate text-[10px] leading-tight"
          style={{ color: loaded ? "var(--vk-text)" : "var(--vk-text-dim)" }}
        >
          {pad.name}
        </span>
        {key && (
          <span className="vk-mono shrink-0 text-[9px]" style={{ color: "var(--vk-text-dim)" }}>
            {key.toUpperCase()}
          </span>
        )}
      </span>

      <span className="relative flex w-full items-end justify-between gap-1">
        <span
          className="vk-mono truncate text-[9px]"
          style={{ color: pad.source.kind === "sample" ? "var(--vk-cyan)" : "var(--vk-text-dim)" }}
        >
          {err ? err : pad.source.kind === "synth" ? pad.source.synth : pad.source.kind === "sample" ? "SMP" : "—"}
        </span>
        {pad.params.choke >= 1 && (
          <span className="vk-mono shrink-0 text-[9px]" style={{ color: "var(--vk-violet)" }}>
            C{Math.round(pad.params.choke)}
          </span>
        )}
      </span>
    </button>
  );
}

export function PadGrid({
  selected,
  onSelect,
}: {
  selected: number;
  onSelect: (i: number) => void;
}) {
  const client = useEngine();
  const { kit, status } = useEngineState();

  // Computer-keyboard playing. Held keys are ignored on repeat so a held key does not
  // machine-gun the pad, and typing in an input never steals a hit.
  const down = useRef(new Set<string>());
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const i = PAD_KEYBOARD.indexOf(e.key.toLowerCase());
      if (i < 0 || i >= PAD_COUNT) return;
      if (down.current.has(e.key)) return;
      down.current.add(e.key);
      e.preventDefault();
      client.triggerPad(i, 0.9);
      onSelect(i);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const i = PAD_KEYBOARD.indexOf(e.key.toLowerCase());
      down.current.delete(e.key);
      if (i >= 0 && client.getSnapshot().kit.pads[i]?.params.mode < 0.5) client.releasePad(i);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [client, onSelect]);

  const pads = useMemo(() => ROW_ORDER, []);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {/* ---------------------------------------------------------- kit bar */}
      <div className="flex items-center gap-2">
        <Knob def={KIT_GAIN} value={kit.gain} size={38} onChange={(v) => client.setKitGain(v)} />
        <div className="flex flex-col gap-[3px]">
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "2px 6px" }}
            data-active={kit.mute}
            data-tone="danger"
            onClick={() => client.setKitMute(!kit.mute)}
            title="Mute the whole kit"
          >
            MUTE KIT
          </button>
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "2px 6px" }}
            onClick={() => void client.resetKit()}
            title="Reload the stock sixteen-pad kit. Replaces everything on the pads."
          >
            RESET KIT
          </button>
        </div>

        <div className="flex flex-col gap-[3px]">
          <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
            ROUTE
          </span>
          <div className="flex gap-[3px]">
            {ROUTE_LABELS.map((r) => (
              <button
                key={r.value}
                className="vk-btn vk-focus-ring"
                style={{ fontSize: 9, padding: "2px 6px" }}
                data-active={kit.route === r.value}
                onClick={() => client.setKitRoute(r.value)}
                title={r.hint}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1" />

        {kit.solo >= 0 && (
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "2px 6px" }}
            data-active
            onClick={() => client.setKitSolo(kit.solo)}
            title="Clear solo"
          >
            SOLO {kit.solo + 1}
          </button>
        )}
        {status !== "running" && (
          <span className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)" }}>
            engine in standby — press ENGAGE to hear the kit
          </span>
        )}
      </div>

      {/* ------------------------------------------------------------ grid */}
      <div className="grid grid-cols-4 gap-[6px]">
        {pads.map((i) => (
          <Pad key={i} index={i} selected={selected === i} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
