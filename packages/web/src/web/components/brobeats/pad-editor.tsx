/**
 * Bro.Kodr — BROBEATS pad editor.
 *
 * Everything about one pad: what makes the sound, how the envelope shapes it, the voice
 * parameters, and the pad's own effect chain.
 *
 * The structural decision worth knowing: a pad holds a *buffer*, and `DrumVoice` cannot
 * tell whether that buffer was synthesised here or dragged in from disk. So this editor
 * has two tiers — SOURCE params (generator knobs, synth pads only, re-render on change,
 * never reach the audio thread) and VOICE params (envelope, pitch, pan, choke; identical
 * for both kinds, sent down the command ring). Keeping that split visible in the layout
 * is what stops "why does Tune do nothing on my sample?" from being a support question.
 *
 * The envelope is drawn rather than knobbed because ADSR is a shape, and the shape is the
 * thing the user is actually reaching for — a long booming bass versus a short tight hit
 * is one drag here. The knobs stay underneath for exact values.
 */

import { useEffect, useRef, useState } from "react";
import type { PadKey } from "../../audio/backend";
import { drumKinds, loadDrumSynth, type PadSlotState } from "../../audio/kit";
import { PAD_KEYBOARD, PAD_PARAM_DEFS, SYNTH_KIND_LABELS, SYNTH_PARAM_DEFS } from "../../audio/pad-params";
import { CATEGORY_LABELS, CATEGORY_ORDER, EFFECTS, EFFECT_LIST } from "../../audio/param-schema";
import { useCanvas, useEngine, useEngineState } from "../../hooks/use-engine";
import { MiniSlider } from "../controls";
import { CATEGORY_COLOR } from "../rack";
// The param grid moved out when the loop deck needed the same one for its lane chains.
import { DefGrid } from "./def-grid";

/* ------------------------------------------------------------------ envelope */

type EnvHandle = "attack" | "hold" | "decay" | "release";

const ENV_MAX = 4000;

/** Compressed time→width so a 4-second release does not squash a 2ms attack to nothing. */
const segWidth = (ms: number) => Math.sqrt(Math.max(0, ms) / ENV_MAX);

/**
 * Draggable ADSR display.
 *
 * Handles move *relatively* — horizontal drag scales the time exponentially, vertical
 * drag on the decay handle moves sustain. Dragging relatively rather than mapping the
 * pointer back through the compressed time axis is what keeps a 2ms attack reachable:
 * an absolute mapping gives that whole range about one pixel.
 */
function EnvelopeEditor({ index, params }: { index: number; params: Record<string, number> }) {
  const client = useEngine();
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [drag, setDrag] = useState<EnvHandle | null>(null);
  const dragRef = useRef<{ handle: EnvHandle; x: number; y: number; value: number; sustain: number } | null>(null);
  const hoverRef = useRef<EnvHandle | null>(null);

  // Layout in normalised units, recomputed each frame from live params.
  const layout = (w: number, h: number) => {
    const p = paramsRef.current;
    const a = segWidth(p.attack ?? 0);
    const hold = segWidth(p.hold ?? 0);
    const d = segWidth(p.decay ?? 400);
    const r = segWidth(p.release ?? 60);
    const sus = 0.28; // fixed display width for the sustain plateau
    const total = Math.max(0.35, a + hold + d + sus + r);
    const pad = 10;
    const iw = w - pad * 2;
    const ih = h - pad * 2;
    const sx = (v: number) => pad + (v / total) * iw;
    const top = pad;
    const bottom = pad + ih;
    const sLevel = Math.min(1, Math.max(0, p.sustain ?? 1));
    const sy = bottom - sLevel * ih;
    return {
      pad,
      top,
      bottom,
      zero: { x: sx(0), y: bottom },
      peak: { x: sx(a), y: top },
      holdEnd: { x: sx(a + hold), y: top },
      decayEnd: { x: sx(a + hold + d), y: sy },
      susEnd: { x: sx(a + hold + d + sus), y: sy },
      end: { x: sx(a + hold + d + sus + r), y: bottom },
    };
  };

  const canvasRef = useCanvas((ctx, w, h) => {
    const L = layout(w, h);
    ctx.clearRect(0, 0, w, h);

    // well
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = L.top + ((L.bottom - L.top) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(L.pad, y);
      ctx.lineTo(w - L.pad, y);
      ctx.stroke();
    }

    // filled envelope
    ctx.beginPath();
    ctx.moveTo(L.zero.x, L.zero.y);
    ctx.lineTo(L.peak.x, L.peak.y);
    ctx.lineTo(L.holdEnd.x, L.holdEnd.y);
    ctx.lineTo(L.decayEnd.x, L.decayEnd.y);
    ctx.lineTo(L.susEnd.x, L.susEnd.y);
    ctx.lineTo(L.end.x, L.end.y);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, L.top, 0, L.bottom);
    grad.addColorStop(0, "rgba(255,176,32,0.30)");
    grad.addColorStop(1, "rgba(255,176,32,0.04)");
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(L.zero.x, L.zero.y);
    ctx.lineTo(L.peak.x, L.peak.y);
    ctx.lineTo(L.holdEnd.x, L.holdEnd.y);
    ctx.lineTo(L.decayEnd.x, L.decayEnd.y);
    ctx.lineTo(L.susEnd.x, L.susEnd.y);
    ctx.lineTo(L.end.x, L.end.y);
    ctx.strokeStyle = "#ffb020";
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // sustain plateau marker
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = "rgba(53,214,208,0.5)";
    ctx.beginPath();
    ctx.moveTo(L.pad, L.decayEnd.y);
    ctx.lineTo(w - L.pad, L.decayEnd.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // handles
    const active = dragRef.current?.handle ?? hoverRef.current;
    const pts: Array<[EnvHandle, { x: number; y: number }]> = [
      ["attack", L.peak],
      ["hold", L.holdEnd],
      ["decay", L.decayEnd],
      ["release", L.end],
    ];
    for (const [name, pt] of pts) {
      const on = active === name;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, on ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = on ? "#ffb020" : "rgba(20,22,26,0.9)";
      ctx.fill();
      ctx.strokeStyle = "#ffb020";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // readout
    const p = paramsRef.current;
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillStyle = "rgba(154,162,173,0.85)";
    ctx.fillText(
      `A ${(p.attack ?? 0).toFixed(1)}  H ${Math.round(p.hold ?? 0)}  D ${Math.round(p.decay ?? 0)}  S ${(p.sustain ?? 1).toFixed(2)}  R ${Math.round(p.release ?? 0)}`,
      L.pad,
      h - 2,
    );
  });

  const handleAt = (e: React.PointerEvent<HTMLCanvasElement>): EnvHandle | null => {
    const c = e.currentTarget;
    const rect = c.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const L = layout(rect.width, rect.height);
    const pts: Array<[EnvHandle, { x: number; y: number }]> = [
      ["attack", L.peak],
      ["hold", L.holdEnd],
      ["decay", L.decayEnd],
      ["release", L.end],
    ];
    let best: EnvHandle | null = null;
    let bestD = 16;
    for (const [name, pt] of pts) {
      const d = Math.hypot(pt.x - x, pt.y - y);
      if (d < bestD) {
        bestD = d;
        best = name;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const h = handleAt(e);
    if (!h) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = paramsRef.current;
    dragRef.current = {
      handle: h,
      x: e.clientX,
      y: e.clientY,
      value: p[h] ?? 0,
      sustain: p.sustain ?? 1,
    };
    setDrag(h);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current;
    if (!d) {
      hoverRef.current = handleAt(e);
      return;
    }
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    const def = PAD_PARAM_DEFS.find((p) => p.key === d.handle);
    if (!def) return;
    // Exponential horizontal travel: ~7% per pixel, so the full useful range is a
    // comfortable drag at either end of the scale.
    const base = Math.max(d.value, d.handle === "attack" || d.handle === "hold" ? 0.05 : 1);
    const next = Math.min(def.max, Math.max(def.min, base * Math.exp(dx * 0.012)));
    client.setPadParam(index, d.handle as PadKey, Number(next.toFixed(2)));
    if (d.handle === "decay") {
      const s = Math.min(1, Math.max(0, d.sustain - dy / 120));
      client.setPadParam(index, "sustain" as PadKey, Number(s.toFixed(3)));
    }
  };

  const endDrag = () => {
    dragRef.current = null;
    setDrag(null);
  };

  return (
    <canvas
      ref={canvasRef}
      className="w-full"
      style={{
        height: 118,
        display: "block",
        borderRadius: 3,
        border: "1px solid var(--vk-line)",
        cursor: drag ? "grabbing" : "crosshair",
        touchAction: "none",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={() => {
        hoverRef.current = null;
      }}
      title="Drag the dots: attack, hold, decay (up/down for sustain), release"
    />
  );
}

/* ------------------------------------------------------------------ pad chain */

function PadSlot({
  padIndex,
  slot,
  position,
  count,
}: {
  padIndex: number;
  slot: PadSlotState;
  position: number;
  count: number;
}) {
  const client = useEngine();
  const def = EFFECTS[slot.type];
  if (!def) return null;
  const color = CATEGORY_COLOR[def.category];

  return (
    <div className="vk-panel flex shrink-0 flex-col" style={{ width: 196 }}>
      <div
        className="vk-tone-head flex shrink-0 items-center gap-[4px] px-[6px] py-[4px]"
        style={{ "--vk-tone": color } as React.CSSProperties}
      >
        <span className="vk-title min-w-0 flex-1 truncate" style={{ color }} title={def.blurb}>
          {def.short}
        </span>
        <button
          className="vk-btn"
          style={{ padding: "0 3px", lineHeight: 1.4 }}
          disabled={position === 0}
          onClick={() => client.movePadEffect(padIndex, slot.id, position - 1)}
          title="Move earlier in this pad's chain"
        >
          ◄
        </button>
        <button
          className="vk-btn"
          style={{ padding: "0 3px", lineHeight: 1.4 }}
          disabled={position >= count - 1}
          onClick={() => client.movePadEffect(padIndex, slot.id, position + 1)}
          title="Move later in this pad's chain"
        >
          ►
        </button>
        <button
          className="vk-led"
          data-on={!slot.bypassed}
          style={{ border: "none", padding: 0, cursor: "pointer" }}
          onClick={() => client.setPadEffectBypass(padIndex, slot.id, !slot.bypassed)}
          title={slot.bypassed ? "Bypassed — click to engage" : "Active — click to bypass"}
        />
        <button
          className="vk-btn"
          data-tone="danger"
          style={{ padding: "0 4px", lineHeight: 1.4 }}
          onClick={() => client.removePadEffect(padIndex, slot.id)}
          title="Remove from this pad"
        >
          ✕
        </button>
      </div>

      <div
        className="flex shrink-0 items-center gap-[4px] px-[6px] py-[3px]"
        style={{ borderBottom: "1px solid var(--vk-line)" }}
      >
        <span className="vk-label" style={{ fontSize: 8 }}>
          MIX
        </span>
        <MiniSlider
          value={slot.mix}
          onChange={(v) => client.setPadEffectMix(padIndex, slot.id, v)}
          width={44}
          accent={color}
          title={`Dry/wet ${(slot.mix * 100).toFixed(0)}%`}
        />
        <span className="vk-mono text-[9px]" style={{ color: "var(--vk-text-dim)" }}>
          {(slot.mix * 100).toFixed(0)}%
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-[6px]">
        <DefGrid
          defs={def.params}
          values={slot.params}
          size={34}
          accent={color}
          onChange={(k, v) => client.setPadEffectParam(padIndex, slot.id, k, v)}
        />
      </div>
    </div>
  );
}

function AddPadEffect({ padIndex }: { padIndex: number }) {
  const client = useEngine();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  // The picker floats in fixed position rather than sitting under the button: the pad
  // chain is a horizontal scroller, and anything in its flow gets clipped on both axes
  // the moment it is taller than one slot.
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = 200;
      setAnchor({
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
        top: Math.min(r.bottom + 4, window.innerHeight - 280),
      });
    };
    place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="shrink-0" style={{ width: 92 }}>
      <button
        ref={btnRef}
        className="vk-focus-ring flex h-full w-full flex-col items-center justify-center gap-[4px]"
        style={{
          minHeight: 64,
          padding: "8px 6px",
          background: "rgba(255,176,32,0.05)",
          border: `1px dashed ${open ? "var(--vk-line)" : "rgba(255,176,32,0.5)"}`,
          borderRadius: 3,
          color: "var(--vk-amber)",
          cursor: "pointer",
        }}
        onClick={() => setOpen((v) => !v)}
        title="Add an effect that runs on this pad only"
      >
        <span className="vk-title" style={{ color: "var(--vk-amber)" }}>
          {open ? "CLOSE" : "+ PAD FX"}
        </span>
      </button>
      {open && anchor && (
        <>
          {/* Click-away catcher, so the picker behaves like every other menu here. */}
          <div className="fixed inset-0" style={{ zIndex: 59 }} onMouseDown={() => setOpen(false)} />
          <div
            className="vk-panel overflow-y-auto p-[6px]"
            style={{ position: "fixed", left: anchor.left, top: anchor.top, width: 200, maxHeight: 272, zIndex: 60 }}
          >
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
                          client.addPadEffect(padIndex, e.type);
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
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ editor */

export function PadEditor({ index }: { index: number }) {
  const client = useEngine();
  const { kit, status } = useEngineState();
  const pad = kit.pads[index];
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [kinds, setKinds] = useState<string[]>(() => drumKinds());
  const [err, setErr] = useState<string | null>(null);

  // The generator is fetched as a plain module at runtime, so its kind list may not be
  // there on first paint. One await, then the source picker fills in.
  useEffect(() => {
    if (kinds.length) return;
    let alive = true;
    void loadDrumSynth().then(() => {
      if (alive) setKinds(drumKinds());
    });
    return () => {
      alive = false;
    };
  }, [kinds.length]);

  if (!pad) return null;

  const synthDefs = pad.source.kind === "synth" ? (SYNTH_PARAM_DEFS[pad.source.synth] ?? []) : [];
  const synthValues = pad.source.kind === "synth" ? client.padSynthParams(index) : {};
  const key = PAD_KEYBOARD[index];
  const muted = pad.params.mute >= 0.5;
  const soloed = kit.solo === index;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const msg = await client.loadPadFile(index, file);
    setErr(msg);
    if (msg) setTimeout(() => setErr(null), 4000);
  };

  return (
    <div className="flex min-h-0 flex-col gap-2">
      {/* ------------------------------------------------------------ header */}
      <div className="vk-panel flex flex-wrap items-center gap-2 p-2">
        <span
          className="vk-display flex items-center justify-center"
          style={{ width: 30, height: 26, color: "var(--vk-amber)" }}
          title="Pad number"
        >
          {index + 1}
        </span>
        <input
          className="vk-input"
          style={{ width: 150 }}
          value={pad.name}
          onChange={(e) => client.setPadName(index, e.target.value.slice(0, 18))}
          title="Pad name"
        />
        {key && (
          <span className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)" }}>
            KEY {key.toUpperCase()}
          </span>
        )}

        <div className="flex-1" />

        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "2px 6px" }}
          data-active={muted}
          data-tone="danger"
          onClick={() => client.setPadParam(index, "mute" as PadKey, muted ? 0 : 1)}
          title="Mute this pad"
        >
          MUTE
        </button>
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "2px 6px" }}
          data-active={soloed}
          data-tone="cyan"
          onClick={() => client.setKitSolo(index)}
          title="Solo this pad — not saved with the kit"
        >
          SOLO
        </button>
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "2px 6px" }}
          onClick={() => client.triggerPad(index, 1)}
          title="Audition at full velocity"
        >
          ▶ PLAY
        </button>
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "2px 6px" }}
          onClick={() => client.resetPadParams(index)}
          title="Voice params back to defaults — the sound on the pad is left alone"
        >
          RESET VOICE
        </button>
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "2px 6px" }}
          data-tone="danger"
          onClick={() => client.clearPad(index)}
          title="Empty this pad: sound and pad effects both"
        >
          CLEAR PAD
        </button>
      </div>

      {/* ------------------------------------------------------------ source */}
      <div className="vk-panel flex flex-col gap-2 p-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
            SOURCE
          </span>
          {kinds.map((k) => (
            <button
              key={k}
              className="vk-btn vk-focus-ring"
              style={{ fontSize: 9, padding: "2px 6px" }}
              data-active={pad.source.kind === "synth" && pad.source.synth === k}
              onClick={() => client.setPadSynth(index, k)}
              title={`Put the ${SYNTH_KIND_LABELS[k] ?? k} generator on this pad`}
            >
              {(SYNTH_KIND_LABELS[k] ?? k).toUpperCase()}
            </button>
          ))}

          <span style={{ width: 1, height: 16, background: "var(--vk-line)" }} />

          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "2px 6px" }}
            data-active={pad.source.kind === "sample"}
            data-tone="cyan"
            onClick={() => fileRef.current?.click()}
            title="Load an audio file onto this pad — or drop one straight on the pad in the grid"
          >
            LOAD SAMPLE…
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

          <span className="vk-mono text-[10px]" style={{ color: err ? "var(--vk-red)" : "var(--vk-text-dim)" }}>
            {err
              ? err
              : pad.source.kind === "sample"
                ? `${pad.source.sampleName ?? "sample"}${pad.source.frames ? ` · ${(pad.source.frames / Math.max(1, pad.source.sampleRate)).toFixed(2)}s` : " · reload needed"}`
                : pad.source.kind === "synth"
                  ? "synthesised — the knobs below re-render the one-shot"
                  : "empty pad"}
          </span>
        </div>

        {synthDefs.length > 0 && (
          <DefGrid
            defs={synthDefs}
            values={synthValues}
            accent="var(--vk-violet)"
            onChange={(k, v) => client.setPadSynthParam(index, k, v)}
          />
        )}
      </div>

      {/* ---------------------------------------------------------- envelope */}
      <div className="vk-panel flex flex-col gap-2 p-2">
        <div className="flex items-center justify-between">
          <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
            ENVELOPE
          </span>
          <span className="vk-mono text-[9px]" style={{ color: "var(--vk-text-dim)" }}>
            {pad.params.mode < 0.5 ? "gate — sustains while held" : "one-shot — plays through"}
          </span>
        </div>
        <EnvelopeEditor index={index} params={pad.params} />
      </div>

      {/* ------------------------------------------------------------- voice */}
      <div className="vk-panel flex flex-col gap-2 p-2">
        <DefGrid
          defs={PAD_PARAM_DEFS}
          values={pad.params}
          onChange={(k, v) => client.setPadParam(index, k as PadKey, v)}
        />
      </div>

      {/* -------------------------------------------------------- pad chain */}
      <div className="vk-panel flex flex-col gap-2 p-2">
        <div className="flex items-center gap-2">
          <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
            PAD FX — runs on this pad alone, before the kit bus
          </span>
          <div className="flex-1" />
          {pad.chain.length > 0 && (
            <button
              className="vk-btn vk-focus-ring"
              style={{ fontSize: 9, padding: "2px 6px" }}
              data-tone="danger"
              onClick={() => client.clearPadChain(index)}
              title="Remove every effect on this pad"
            >
              CLEAR FX
            </button>
          )}
        </div>
        <div className="vk-scroll-x flex items-stretch gap-[6px]">
          {pad.chain.map((slot, i) => (
            <PadSlot key={slot.id} padIndex={index} slot={slot} position={i} count={pad.chain.length} />
          ))}
          <AddPadEffect padIndex={index} />
        </div>
        {status !== "running" && pad.chain.length > 0 && (
          <span className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)" }}>
            engine in standby — pad effects are staged and go live on ENGAGE
          </span>
        )}
      </div>
    </div>
  );
}
