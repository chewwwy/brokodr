/**
 * Bro.Kodr — the effects rack.
 *
 * Modules render themselves entirely from `param-schema.ts`: adding a knob to a DSP
 * module is a one-line schema edit, not a new component. Reordering is a real signal
 * path change — the chain runner moves the slot, so the audible result changes.
 */

import { useMemo, useRef, useState } from "react";
import { BandLadder } from "./band-ladder";
import { Knob, MiniSlider, SelectControl, Toggle } from "./controls";
import { EqCurve } from "./eq-curve";
import { GrMeter } from "./meters";
import { useAnimationLoop, useEngine, useEngineState, useMidi, useMidiState } from "../hooks/use-engine";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  EFFECTS,
  EFFECT_LIST,
  type EffectCategory,
  type ParamDef,
} from "../audio/param-schema";
import type { SlotState } from "../audio/engine-client";

/** Shared with the BROBEATS pad editor so a pad's effect chain colour-codes identically. */
export const CATEGORY_COLOR: Record<EffectCategory, string> = {
  tone: "#35d6d0",
  dynamics: "#4ade80",
  drive: "#ff6b2c",
  voice: "#a78bfa",
  modulation: "#ffb020",
  space: "#35d6d0",
  character: "#a78bfa",
};

/* ------------------------------------------------------------------ module meter */

/** Per-slot readout in the module header. Polls the shared meter block, never React. */
function SlotMeter({ index, kind, label }: { index: number; kind: "gr" | "level" | "activity"; label: string }) {
  const client = useEngine();
  const textRef = useRef<HTMLSpanElement>(null);

  useAnimationLoop(() => {
    const el = textRef.current;
    if (!el) return;
    const v = client.meters.slots[index] ?? 0;
    if (kind === "gr") el.textContent = v > 0.05 ? `-${v.toFixed(1)}` : "0.0";
    else if (kind === "level") el.textContent = v > 1 ? v.toFixed(0) : v.toFixed(2);
    else el.textContent = v > 0.5 ? "ON" : "--";
  });

  return (
    <div className="flex items-center gap-1">
      <span className="vk-label" style={{ fontSize: 8 }}>
        {label}
      </span>
      {kind === "gr" ? (
        <GrMeter read={() => client.meters.slots[index] ?? 0} width={38} height={7} />
      ) : null}
      <span ref={textRef} className="vk-mono text-[9px]" style={{ color: "var(--vk-cyan)", minWidth: 22 }}>
        --
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ param grid */

function ParamGrid({
  slot,
  onParam,
  skin = "flat",
  accent,
}: {
  slot: SlotState;
  onParam: (key: string, value: number) => void;
  /** "metal" renders machined dials for the brushed-aluminium faceplate skin. */
  skin?: "flat" | "metal";
  accent?: string;
}) {
  const def = EFFECTS[slot.type];
  const midi = useMidi();
  const midiState = useMidiState();

  // Group params into the labelled rows declared by the schema.
  const groups = useMemo(() => {
    const out: { name: string | null; params: ParamDef[] }[] = [];
    for (const p of def.params) {
      const name = p.group ?? null;
      const last = out[out.length - 1];
      if (last && last.name === name) last.params.push(p);
      else out.push({ name, params: [p] });
    }
    return out;
  }, [def]);

  return (
    <div className="flex flex-col gap-[6px]">
      {groups.map((g, gi) => (
        <div key={`${g.name ?? "x"}-${gi}`} className="flex flex-col gap-[2px]">
          {g.name && (
            <div
              className={skin === "metal" ? "mk-etch mk-etch-dim" : "vk-label"}
              style={
                skin === "metal"
                  ? { borderBottom: "1px solid rgb(0 0 0 / 22%)", paddingBottom: 2 }
                  : { color: "var(--vk-text-dim)", borderBottom: "1px solid var(--vk-line)", paddingBottom: 2 }
              }
            >
              {g.name}
            </div>
          )}
          <div className="flex flex-wrap items-start gap-x-[2px] gap-y-1">
            {g.params.map((p) => {
              const value = slot.params[p.key] ?? p.def;
              if (p.kind === "toggle") {
                return (
                  <div key={p.key} className="w-full">
                    <Toggle
                      label={p.label}
                      on={value >= 0.5}
                      onChange={(v) => onParam(p.key, v ? 1 : 0)}
                    />
                  </div>
                );
              }
              if (p.kind === "select") {
                return (
                  <div key={p.key} className={p.wide ? "w-full" : "min-w-[84px] flex-1"}>
                    <SelectControl def={p} value={value} onChange={(v) => onParam(p.key, v)} />
                  </div>
                );
              }
              const mapped = !!midi.mappingFor("param", slot.id, p.key);
              return (
                <Knob
                  key={p.key}
                  def={p}
                  value={value}
                  size={p.wide ? 52 : 40}
                  mapped={mapped}
                  skin={skin}
                  {...(accent ? { accent } : {})}
                  onChange={(v) => onParam(p.key, v)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (mapped) {
                      const idx = midiState.settings.mappings.findIndex(
                        (m) => m.kind === "param" && m.slotId === slot.id && m.paramKey === p.key,
                      );
                      if (idx >= 0) midi.removeMapping(idx);
                    } else {
                      midi.startLearn({ kind: "param", slotId: slot.id, slotType: slot.type, paramKey: p.key });
                    }
                  }}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ module */

function RackModule({
  slot,
  index,
  onDragStart,
  onDragOver,
  onDrop,
  dragging,
  dropTarget,
}: {
  slot: SlotState;
  index: number;
  onDragStart: (id: number) => void;
  onDragOver: (index: number) => void;
  onDrop: () => void;
  dragging: boolean;
  dropTarget: boolean;
}) {
  const client = useEngine();
  const def = EFFECTS[slot.type];
  const [menu, setMenu] = useState(false);
  if (!def) return null;

  const color = CATEGORY_COLOR[def.category];

  return (
    // Same shell as the vocoder: a dark chassis with a moulded plate inset into it,
    // rather than one flat bordered panel. The 3px of chassis showing all round is what
    // reads as a separate unit, and the plate carries the 10px radius from the render.
    // Widths gain 6px so the control area inside is unchanged.
    <div
      className={`mk mk-chassis flex h-full shrink-0 flex-col ${dragging ? "vk-dragging" : ""} ${dropTarget ? "vk-drop-target" : ""}`}
      style={{
        width: slot.collapsed ? 46 : def.hasCurve ? 274 : 214,
        borderRadius: 4,
        padding: 3,
      }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(index);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      {/* overflow-hidden is load-bearing: the category header and the mix strip are square,
          and without it their corners punch back through the plate's rounded corners. */}
      <div className="mk-face relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* header — washed with the module's category colour, see .vk-tone-head in styles.css */}
      <div
        className="vk-tone-head flex shrink-0 items-center gap-[5px] px-[6px] py-[5px]"
        style={{ "--vk-tone": color } as React.CSSProperties}
      >
        <span
          className="vk-drag-handle shrink-0"
          draggable
          onDragStart={() => onDragStart(slot.id)}
          onDragEnd={onDrop}
          style={{ color: "var(--vk-text-dim)", fontSize: 11, lineHeight: 1 }}
          title="Drag to reorder — this reorders the actual signal path"
        >
          ⠿
        </span>
        {slot.collapsed ? (
          <button
            className="vk-title flex-1 truncate"
            style={{
              background: "none",
              border: "none",
              color,
              cursor: "pointer",
              padding: 0,
              writingMode: "vertical-rl",
              height: 100,
            }}
            onClick={() => client.setCollapsed(slot.id, false)}
          >
            {def.short}
          </button>
        ) : (
          <>
            <button
              className="vk-title min-w-0 flex-1 truncate text-left"
              style={{ background: "none", border: "none", color, cursor: "pointer", padding: 0 }}
              onClick={() => client.setCollapsed(slot.id, true)}
              title={`${def.name} — ${def.blurb}`}
            >
              {def.short}
            </button>
            <button
              className="vk-led"
              data-on={!slot.bypassed}
              style={{ border: "none", padding: 0, cursor: "pointer" }}
              onClick={() => client.setBypass(slot.id, !slot.bypassed)}
              title={slot.bypassed ? "Bypassed — click to engage" : "Active — click to bypass"}
            />
            <button
              className="vk-btn"
              style={{ padding: "1px 4px", lineHeight: 1 }}
              onClick={() => setMenu((v) => !v)}
              title="Module menu"
            >
              ⋮
            </button>
          </>
        )}
      </div>

      {menu && !slot.collapsed && (
        <div className="flex shrink-0 flex-col gap-[3px] p-[6px]" style={{ background: "var(--vk-panel-lo)" }}>
          <button
            className="vk-btn"
            onClick={() => {
              client.resetSlot(slot.id);
              setMenu(false);
            }}
          >
            Reset params
          </button>
          <button
            className="vk-btn"
            onClick={() => {
              client.setCollapsed(slot.id, true);
              setMenu(false);
            }}
          >
            Collapse
          </button>
          <button
            className="vk-btn"
            data-tone="danger"
            data-active
            onClick={() => {
              client.removeEffect(slot.id);
              setMenu(false);
            }}
          >
            Remove
          </button>
        </div>
      )}

      {!slot.collapsed && (
        <>
          {/* mix + meter strip */}
          <div
            className="flex shrink-0 items-center justify-between gap-1 px-[6px] py-[4px]"
            style={{ borderBottom: "1px solid var(--vk-line)" }}
          >
            <div className="flex items-center gap-[4px]">
              <span className="vk-label" style={{ fontSize: 8 }}>
                MIX
              </span>
              <MiniSlider
                value={slot.mix}
                onChange={(v) => client.setMix(slot.id, v)}
                width={44}
                accent={color}
                title={`Dry/wet ${(slot.mix * 100).toFixed(0)}% — double-click for 100%`}
              />
              <span className="vk-mono text-[9px]" style={{ color: "var(--vk-text-dim)", minWidth: 22 }}>
                {(slot.mix * 100).toFixed(0)}%
              </span>
            </div>
            {def.meter && <SlotMeter index={index} kind={def.meter.kind} label={def.meter.label} />}
          </div>

          {def.latency && (
            <div
              className="vk-label shrink-0 px-[6px] py-[2px]"
              style={{ color: "var(--vk-amber-dim)", background: "rgba(255,176,32,.06)" }}
              title="This module introduces processing latency"
            >
              +{def.latency} latency
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto p-[6px]">
            {def.hasCurve && (
              <div className="mb-[6px]">
                <EqCurve
                  slotId={slot.id}
                  params={slot.params}
                  onParam={(k, v) => client.setParam(slot.id, k, v)}
                />
              </div>
            )}
            {/* Metal dials everywhere now (the rollout past the vocoder). The accent stays the
                module's CATEGORY colour rather than the vocoder's single teal: on a full rack the
                teal-only treatment made every module look identical, which was the one live caveat
                logged against the round-1 skin. */}
            <ParamGrid
              slot={slot}
              onParam={(k, v) => client.setParam(slot.id, k, v)}
              skin="metal"
              accent={color}
            />
          </div>
        </>
      )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ metal vocoder */

/* The four-corner-bolt `ScrewRow` that used to live here is gone: the reference this
   metal skin is drawn from is a moulded unit with no visible fixings, so nothing rendered
   it. The `.mk-screw` rules stay in styles.css for a future bolted panel — if you bring
   them back, position the bolts with an inline style rather than Tailwind's `absolute`:
   `.mk-screw` declares `position: relative` for its slot pseudo-element and, both being
   single-class selectors, the later stylesheet wins and collapses all four into the flow
   at the top-left corner. */

/**
 * The VOCODER module dressed in the metal skin from the product renders:
 * brushed-aluminium faceplate bolted into the dark chassis, engraved lettering,
 * machined dials, an LED carrier-source row and the live 16-band ladder.
 *
 * Preview module only — the rest of the rack stays on the flat skin until the
 * look is signed off. Everything below is styling plus the ladder; the params,
 * drag-to-reorder, bypass and menu behave exactly as the flat module does.
 */
function MetalVocoderModule({
  slot,
  index,
  onDragStart,
  onDragOver,
  onDrop,
  dragging,
  dropTarget,
}: {
  slot: SlotState;
  index: number;
  onDragStart: (id: number) => void;
  onDragOver: (index: number) => void;
  onDrop: () => void;
  dragging: boolean;
  dropTarget: boolean;
}) {
  const client = useEngine();
  const def = EFFECTS[slot.type];
  const [menu, setMenu] = useState(false);
  if (!def) return null;

  const color = CATEGORY_COLOR[def.category];
  const bands = Math.round(slot.params.bands ?? 20);
  const source = (slot.params.source ?? 0) >= 0.5 ? 1 : 0;
  const follow = (slot.params.follow ?? 0) >= 0.5;

  if (slot.collapsed) {
    return (
      <div
        className={`mk mk-chassis flex h-full shrink-0 flex-col ${dragging ? "vk-dragging" : ""} ${dropTarget ? "vk-drop-target" : ""}`}
        style={{ width: 46, borderRadius: 4 }}
        onDragOver={(e) => {
          e.preventDefault();
          onDragOver(index);
        }}
        onDrop={(e) => {
          e.preventDefault();
          onDrop();
        }}
      >
        <div className="mk-face relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            className="vk-tone-head flex flex-1 items-start justify-center px-[6px] py-[5px]"
            style={{ "--vk-tone": color } as React.CSSProperties}
          >
            <button
              className="vk-title"
              style={{
                background: "none",
                border: "none",
                color,
                cursor: "pointer",
                padding: 0,
                writingMode: "vertical-rl",
                height: 100,
              }}
              onClick={() => client.setCollapsed(slot.id, false)}
            >
              {def.short}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`mk mk-chassis flex h-full shrink-0 flex-col ${dragging ? "vk-dragging" : ""} ${dropTarget ? "vk-drop-target" : ""}`}
      style={{ width: 236, borderRadius: 4, padding: 3 }}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOver(index);
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
    >
      {/* No `.mk-screw` bolts here: the gradient reference is a moulded unit with no visible fixings. */}
      <div className="mk-face relative flex min-h-0 flex-1 flex-col overflow-hidden">

        {/* Same category-coloured tone bar every other module wears. The engraved nameplate
            it replaced left the vocoder as the only module with no colour box, so it was the
            one module you could not place by category at a glance. */}
        <div
          className="vk-tone-head flex shrink-0 items-center gap-[5px] px-[6px] py-[5px]"
          style={{ "--vk-tone": color } as React.CSSProperties}
        >
          <span
            className="vk-drag-handle shrink-0"
            draggable
            onDragStart={() => onDragStart(slot.id)}
            onDragEnd={onDrop}
            style={{ color: "var(--vk-text-dim)", fontSize: 11, lineHeight: 1 }}
            title="Drag to reorder — this reorders the actual signal path"
          >
            ⠿
          </span>
          <button
            className="vk-title min-w-0 flex-1 truncate text-left"
            style={{ background: "none", border: "none", color, cursor: "pointer", padding: 0 }}
            onClick={() => client.setCollapsed(slot.id, true)}
            title={`${def.name} — ${def.blurb}`}
          >
            {def.short}
          </button>
          <button
            className="vk-led"
            data-on={!slot.bypassed}
            style={{ border: "none", padding: 0, cursor: "pointer" }}
            onClick={() => client.setBypass(slot.id, !slot.bypassed)}
            title={slot.bypassed ? "Bypassed — click to engage" : "Active — click to bypass"}
          />
          <button className="vk-btn" style={{ padding: "1px 4px", lineHeight: 1 }} title="Module menu" onClick={() => setMenu((v) => !v)}>
            ⋮
          </button>
        </div>

        {menu && (
          <div className="flex shrink-0 flex-col gap-[3px] px-[10px] pb-[6px]">
            <button
              className="mk-btn"
              onClick={() => {
                client.resetSlot(slot.id);
                setMenu(false);
              }}
            >
              Reset params
            </button>
            <button
              className="mk-btn"
              onClick={() => {
                client.setCollapsed(slot.id, true);
                setMenu(false);
              }}
            >
              Collapse
            </button>
            <button
              className="mk-btn"
              onClick={() => {
                client.removeEffect(slot.id);
                setMenu(false);
              }}
            >
              Remove
            </button>
          </div>
        )}

        {/* carrier-source LED row — the render's INT / EXT / SIDECHAIN strip */}
        <div className="flex shrink-0 items-center gap-[10px] px-[10px] pb-[5px]">
          <button
            className="flex items-center gap-[4px]"
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
            onClick={() => client.setParam(slot.id, "source", 0)}
            title="Carrier = internal synth"
          >
            <span className="mk-led" data-on={source === 0} />
            <span className="mk-etch">INT</span>
          </button>
          <button
            className="flex items-center gap-[4px]"
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
            onClick={() => client.setParam(slot.id, "source", 1)}
            title="Carrier = the loaded audio file"
          >
            <span className="mk-led" data-on={source === 1} />
            <span className="mk-etch">EXT</span>
          </button>
          <button
            className="ml-auto flex items-center gap-[4px]"
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
            onClick={() => client.setParam(slot.id, "follow", follow ? 0 : 1)}
            title="Lock the carrier to the singer's own pitch"
          >
            <span className="mk-led" data-on={follow} />
            <span className="mk-etch">FOLLOW</span>
          </button>
        </div>

        {/* live band ladder */}
        <div className="shrink-0 px-[10px] pb-[6px]">
          <BandLadder slotId={slot.id} bands={bands} />
        </div>

        {/* mix strip */}
        <div
          className="flex shrink-0 items-center gap-[5px] px-[10px] pb-[5px]"
          style={{ borderBottom: "1px solid rgb(0 0 0 / 18%)" }}
        >
          <span className="mk-etch">MIX</span>
          <MiniSlider
            value={slot.mix}
            onChange={(v) => client.setMix(slot.id, v)}
            width={54}
            accent="var(--mk-teal)"
            title={`Dry/wet ${(slot.mix * 100).toFixed(0)}% — double-click for 100%`}
          />
          <span className="mk-etch mk-etch-dim" style={{ minWidth: 26 }}>
            {(slot.mix * 100).toFixed(0)}%
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-[10px] pb-[14px] pt-[6px]">
          <ParamGrid
            slot={slot}
            onParam={(k, v) => client.setParam(slot.id, k, v)}
            skin="metal"
            accent="var(--mk-teal)"
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ add module */

function AddModule() {
  const client = useEngine();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative h-full shrink-0" style={{ width: open ? 220 : 128 }}>
      <div className="vk-panel flex h-full flex-col" style={{ background: "transparent", border: "none" }}>
        <button
          className="vk-focus-ring flex shrink-0 flex-col items-center justify-center gap-[6px]"
          style={{
            // Collapsed, this fills the whole slot as an obvious empty-bay drop zone: a
            // 46px rail whose only label was a "+" glyph tested badly — a first-time user
            // did not find it at all. Dashed outline + a spelled-out label + a hint line,
            // all readable without hovering.
            height: open ? "auto" : "100%",
            padding: open ? "8px 6px" : "10px",
            background: "rgba(255,176,32,0.05)",
            border: `1px dashed ${open ? "var(--vk-line)" : "rgba(255,176,32,0.5)"}`,
            borderRadius: 3,
            color: "var(--vk-amber)",
            cursor: "pointer",
          }}
          onClick={() => setOpen((v) => !v)}
          title="Add a module to the chain"
        >
          <span
            className="flex items-center justify-center"
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              border: "1px solid rgba(255,176,32,0.6)",
              background: "rgba(255,176,32,0.10)",
              fontSize: 19,
              lineHeight: "26px",
              fontWeight: 400,
            }}
          >
            +
          </span>
          <span className="vk-title" style={{ color: "var(--vk-amber)" }}>
            {open ? "CLOSE" : "ADD MODULE"}
          </span>
          {!open && (
            <span
              className="vk-label"
              style={{ color: "var(--vk-text-dim)", maxWidth: 104, textAlign: "center", lineHeight: 1.35 }}
            >
              click to pick an effect
            </span>
          )}
        </button>
        {open && (
          <div className="min-h-0 flex-1 overflow-y-auto p-[6px]">
            {CATEGORY_ORDER.map((cat) => {
              const list = EFFECT_LIST.filter((e) => e.category === cat);
              if (!list.length) return null;
              return (
                <div key={cat} className="mb-2">
                  <div className="vk-label mb-1" style={{ color: CATEGORY_COLOR[cat] }}>
                    {CATEGORY_LABELS[cat]}
                  </div>
                  <div className="flex flex-col gap-[2px]">
                    {list.map((e) => (
                      <button
                        key={e.type}
                        className="vk-btn text-left"
                        onClick={() => {
                          client.addEffect(e.type);
                          setOpen(false);
                        }}
                        title={e.blurb}
                      >
                        {e.name}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ rack */

export function Rack() {
  const client = useEngine();
  const { slots } = useEngineState();
  const [dragId, setDragId] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const commitDrop = () => {
    if (dragId !== null && overIndex !== null) {
      const from = slots.findIndex((s) => s.id === dragId);
      if (from >= 0 && from !== overIndex) client.moveEffect(dragId, overIndex);
    }
    setDragId(null);
    setOverIndex(null);
  };

  return (
    <div className="vk-scroll-x flex h-full gap-[6px] p-[6px]">
      <div
        className="vk-panel flex h-full shrink-0 flex-col items-center justify-center px-2"
        style={{ width: 34 }}
        title="Signal enters here"
      >
        <span className="vk-label" style={{ writingMode: "vertical-rl", color: "var(--vk-cyan)" }}>
          INPUT →
        </span>
      </div>

      {slots.map((slot, i) => {
        // Metal controls are rolled out to every module. The vocoder keeps its own
        // component because it carries the live 16-band ladder and carrier-source LED row,
        // not because it is the only metal-skinned one.
        const Module = slot.type === "vocoder" ? MetalVocoderModule : RackModule;
        return (
          <Module
            key={slot.id}
            slot={slot}
            index={i}
            dragging={dragId === slot.id}
            dropTarget={overIndex === i && dragId !== null && dragId !== slot.id}
            onDragStart={setDragId}
            onDragOver={setOverIndex}
            onDrop={commitDrop}
          />
        );
      })}

      <AddModule />

      <div
        className="vk-panel flex h-full shrink-0 flex-col items-center justify-center px-2"
        style={{ width: 34 }}
        title="Processed signal leaves here"
      >
        <span className="vk-label" style={{ writingMode: "vertical-rl", color: "var(--vk-amber)" }}>
          → OUTPUT
        </span>
      </div>
    </div>
  );
}
