/**
 * Bro.Kodr — LOOPS workspace.
 *
 * Four loop lanes and the transport that keeps them together. The deck is its own
 * top-level workspace rather than a tab inside BROBEATS: looping is something you do
 * *while* playing pads or singing, so it needs a full row per lane — waveform, punch
 * buttons, lane mixer and its own effect chain — and it never has to share the column
 * with the pad editor.
 *
 * Two rules govern everything below, both inherited from the rest of the app:
 *
 *  1. Structural state (names, mixer values, chains, the *set* tempo) comes from
 *     `useEngineState()`. Anything that moves at audio rate — playhead, level, the
 *     track's own state machine, the bar counter — is read from `client.meters` inside
 *     a rAF loop and written straight to the DOM or a canvas. A 60Hz meter must never
 *     become a React render.
 *
 *  2. Recorded audio is session-only. The takes live in the engine's track buffers and
 *     nowhere else, so a restart empties them; the meter block then reports EMPTY and
 *     the lanes follow on their own. Saving loops with a kit is a later phase.
 *
 * The punch buttons show *pending* state as well as current state, because with
 * quantising on there is a gap between the click and the audible change, and a button
 * that looks inert for most of a bar reads as a button that did not work.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LOOP_PENDING,
  LOOP_SOURCE,
  LOOP_STATE,
  LOOP_TRACKS,
  MAX_BPM,
  MIN_BPM,
  QUANTIZE_CHOICES,
} from "../../audio/backend";
import type { PadSlotState } from "../../audio/kit";
import {
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  EFFECTS,
  EFFECT_LIST,
  type ParamDef,
} from "../../audio/param-schema";
import { useAnimationLoop, useCanvas, useEngine, useEngineState } from "../../hooks/use-engine";
import { Knob, MiniSlider } from "../controls";
import { CATEGORY_COLOR } from "../rack";
import { DefGrid } from "./def-grid";

/* ------------------------------------------------------------------ param defs */

const DECK_GAIN_DEF: ParamDef = {
  key: "gain",
  label: "Deck",
  kind: "knob",
  min: -60,
  max: 12,
  def: 0,
  unit: "dB",
  decimals: 1,
};

const LANE_GAIN_DEF: ParamDef = {
  key: "gain",
  label: "Level",
  kind: "knob",
  min: -60,
  max: 12,
  def: 0,
  unit: "dB",
  decimals: 1,
};

const LANE_PAN_DEF: ParamDef = {
  key: "pan",
  label: "Pan",
  kind: "knob",
  min: -1,
  max: 1,
  def: 0,
  decimals: 2,
};

/** Grid labels in beats. Bars are deliberately not named — beatsPerBar can be anything. */
const QUANTIZE_LABELS: Record<number, string> = {
  0: "OFF",
  0.25: "1/4 BEAT",
  0.5: "1/2 BEAT",
  1: "1 BEAT",
  2: "2 BEATS",
  4: "4 BEATS",
  8: "8 BEATS",
  16: "16 BEATS",
};

const STATE_LABEL: Record<number, string> = {
  [LOOP_STATE.EMPTY]: "EMPTY",
  [LOOP_STATE.REC]: "REC",
  [LOOP_STATE.PLAY]: "PLAY",
  [LOOP_STATE.OVERDUB]: "DUB",
  [LOOP_STATE.STOPPED]: "STOP",
};

const STATE_COLOR: Record<number, string> = {
  [LOOP_STATE.EMPTY]: "var(--vk-text-dim)",
  [LOOP_STATE.REC]: "var(--vk-red, #ff3b30)",
  [LOOP_STATE.PLAY]: "var(--vk-green, #36d07a)",
  [LOOP_STATE.OVERDUB]: "var(--vk-amber)",
  [LOOP_STATE.STOPPED]: "var(--vk-text-mid)",
};

const PENDING_LABEL: Record<number, string> = {
  [LOOP_PENDING.REC]: "REC",
  [LOOP_PENDING.PLAY]: "PLAY",
  [LOOP_PENDING.STOP]: "STOP",
};

const LANE_COLOR = ["#3ea6ff", "#36d07a", "#ffb020", "#ff5fa2"];

/* ------------------------------------------------------------------ transport */

/**
 * Tap tempo. Averages the gaps between taps inside one burst and throws the burst away
 * after a pause, so a stale tap from a minute ago can never drag the average down.
 */
function useTapTempo(onTempo: (bpm: number) => void) {
  const taps = useRef<number[]>([]);
  return useCallback(() => {
    const now = performance.now();
    const t = taps.current;
    if (t.length && now - t[t.length - 1] > 2500) t.length = 0;
    t.push(now);
    if (t.length > 8) t.shift();
    if (t.length < 2) return;
    let sum = 0;
    for (let i = 1; i < t.length; i++) sum += t[i] - t[i - 1];
    const avg = sum / (t.length - 1);
    if (avg <= 0) return;
    onTempo(60000 / avg);
  }, [onTempo]);
}

function TransportBar() {
  const client = useEngine();
  const { loops, status } = useEngineState();
  // The field has to be typeable, so it keeps a draft while focused and only commits on
  // Enter or blur. Without that, "1" on the way to "120" is a valid BPM and the clock
  // slams to the floor mid-keystroke.
  const [draft, setDraft] = useState<string | null>(null);
  const tap = useTapTempo((bpm) => client.setBpm(bpm));

  const barRef = useRef<HTMLSpanElement | null>(null);
  const phaseRef = useRef<HTMLDivElement | null>(null);
  const beatRef = useRef<HTMLSpanElement | null>(null);

  useAnimationLoop(() => {
    const m = client.meters;
    if (barRef.current) barRef.current.textContent = String((m.bar | 0) + 1);
    const beats = Math.max(1, m.beatsPerBar | 0);
    const beat = Math.min(beats, Math.floor(m.barPhase * beats) + 1);
    if (beatRef.current) beatRef.current.textContent = String(beat);
    if (phaseRef.current) phaseRef.current.style.width = `${(m.barPhase * 100).toFixed(1)}%`;
  }, status === "running");

  const commit = () => {
    if (draft !== null) {
      const v = Number.parseFloat(draft);
      if (Number.isFinite(v)) client.setBpm(v);
    }
    setDraft(null);
  };

  return (
    <div className="vk-panel flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 p-2">
      <div className="flex items-center gap-[6px]">
        <span className="vk-label">BPM</span>
        <input
          className="vk-input vk-mono"
          style={{ width: 62, textAlign: "center" }}
          inputMode="decimal"
          value={draft ?? loops.bpm.toFixed(loops.bpm % 1 ? 1 : 0)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commit();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setDraft(null);
              e.currentTarget.blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              const step = e.shiftKey ? 0.1 : 1;
              client.setBpm(loops.bpm + (e.key === "ArrowUp" ? step : -step));
              setDraft(null);
            }
          }}
          title={`Tempo, ${MIN_BPM}–${MAX_BPM} BPM. Arrow keys nudge, Shift for tenths.`}
        />
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "3px 8px" }}
          onClick={tap}
          title="Tap four times in time to set the tempo"
        >
          TAP
        </button>
      </div>

      <label className="flex items-center gap-[6px]" title="Beats in a bar — the bar counter and the grid follow it">
        <span className="vk-label">BEATS / BAR</span>
        <input
          className="vk-input vk-mono"
          style={{ width: 44, textAlign: "center" }}
          type="number"
          min={1}
          max={16}
          value={loops.beatsPerBar}
          onChange={(e) => client.setBeatsPerBar(Number.parseInt(e.target.value, 10) || 4)}
        />
      </label>

      <label className="flex items-center gap-[6px]" title="Punches wait for this grid line before they take effect">
        <span className="vk-label">QUANTISE</span>
        <select
          className="vk-select"
          style={{ width: 96 }}
          value={String(loops.quantize)}
          onChange={(e) => client.setQuantize(Number.parseFloat(e.target.value))}
        >
          {QUANTIZE_CHOICES.map((q) => (
            <option key={q} value={String(q)}>
              {QUANTIZE_LABELS[q] ?? `${q} BEATS`}
            </option>
          ))}
        </select>
      </label>

      {/* Bar / beat readout. Text and the phase bar are written by the rAF loop above. */}
      <div className="vk-well flex items-center gap-[8px] px-2 py-[3px]" style={{ minWidth: 132 }}>
        <span className="vk-mono text-[11px]" style={{ color: "var(--vk-amber)" }}>
          <span ref={barRef}>1</span>
          <span style={{ color: "var(--vk-text-dim)" }}>.</span>
          <span ref={beatRef}>1</span>
        </span>
        <div className="min-w-0 flex-1" style={{ height: 4, background: "var(--vk-void)", borderRadius: 2 }}>
          <div
            ref={phaseRef}
            style={{ width: "0%", height: "100%", background: "var(--vk-amber)", borderRadius: 2 }}
          />
        </div>
      </div>

      <button
        className="vk-btn vk-focus-ring"
        data-active={loops.running}
        style={{ fontSize: 9, padding: "3px 10px" }}
        onClick={() => client.setTransportRun(!loops.running)}
        title="Stop the clock and every quantised punch stops waiting"
      >
        <span className="vk-led" data-on={loops.running} data-tone="green" /> {loops.running ? "RUNNING" : "STOPPED"}
      </button>

      <button
        className="vk-btn vk-focus-ring"
        style={{ fontSize: 9, padding: "3px 8px" }}
        onClick={() => client.resetTransport()}
        title="Send the transport back to bar 1, beat 1"
      >
        RESET
      </button>

      <div className="flex items-center gap-[4px]">
        <Knob
          def={DECK_GAIN_DEF}
          value={loops.gain}
          onChange={(v) => client.setLooperGain(v)}
          size={34}
          bipolar
        />
        <button
          className="vk-btn vk-focus-ring"
          data-active={loops.mute}
          data-tone="danger"
          style={{ fontSize: 9, padding: "3px 8px" }}
          onClick={() => client.setLooperMute(!loops.mute)}
          title="Mute the whole loop deck without touching the lanes"
        >
          MUTE
        </button>
      </div>

      <button
        className="vk-btn vk-focus-ring"
        data-tone="danger"
        style={{ fontSize: 9, padding: "3px 8px" }}
        onClick={() => client.loopClearAll()}
        title="Erase every lane. Undo cannot bring these back."
      >
        CLEAR ALL
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ waveform */

/**
 * One lane's waveform, playhead and record growth.
 *
 * Peaks are *pulled* from the worklet rather than pushed: the audio thread should never
 * be shipping a waveform down on a timer. This refetches when the take changes shape —
 * a new length, a committed overdub, a clear — and while recording it paints the
 * captured fraction instead, because the buffer is still moving and any peaks we pulled
 * would be a frame out of date by the time they arrived.
 */
function LoopWave({ index, color }: { index: number; color: string }) {
  const client = useEngine();
  const peaksRef = useRef<Float32Array | null>(null);
  // What the peaks in hand describe. A mismatch against the meters is the refetch trigger.
  const keyRef = useRef("");
  const pendingRef = useRef(false);

  useAnimationLoop(() => {
    const m = client.meters.loops[index];
    if (!m) return;
    if (m.state === LOOP_STATE.EMPTY) {
      peaksRef.current = null;
      keyRef.current = "";
      return;
    }
    // Mid-record the length changes every block; wait for the punch to close.
    if (m.state === LOOP_STATE.REC || m.state === LOOP_STATE.OVERDUB) return;
    const key = `${m.frames}:${m.layers}`;
    if (key === keyRef.current || pendingRef.current) return;
    pendingRef.current = true;
    keyRef.current = key;
    client
      .getLoopPeaks(index, 480)
      .then((p) => {
        peaksRef.current = p;
        if (!p) keyRef.current = "";
      })
      .finally(() => {
        pendingRef.current = false;
      });
  });

  const canvasRef = useCanvas((ctx, w, h) => {
    const m = client.meters.loops[index];
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, w, h);
    const mid = h / 2;

    // Bar lines, so a loop's length is readable as musical time and not just a blob.
    const frames = m?.frames ?? 0;
    if (frames > 0 && m && m.state !== LOOP_STATE.REC) {
      const beats = Math.max(1, client.meters.beatsPerBar | 0);
      const secs = frames / (client.sampleRate() || 48000);
      const bars = (secs * (client.meters.bpm || 120)) / 60 / beats;
      if (bars >= 1 && bars <= 64) {
        ctx.strokeStyle = "rgba(255,255,255,0.07)";
        ctx.beginPath();
        for (let b = 1; b < Math.round(bars); b++) {
          const x = Math.round((b / bars) * w) + 0.5;
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
        }
        ctx.stroke();
      }
    }

    ctx.strokeStyle = "#2a2e34";
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(w, mid + 0.5);
    ctx.stroke();

    const recording = m?.state === LOOP_STATE.REC;
    if (recording) {
      // No waveform yet — show the take filling up, and its live level as the height.
      const lit = Math.min(1, (m.frames || 0) / (client.sampleRate() * 8 || 1));
      ctx.fillStyle = "rgba(255,59,48,0.18)";
      ctx.fillRect(0, 0, w * lit, h);
      const half = Math.max(1, (m.level || 0) * (mid - 2));
      ctx.fillStyle = "#ff3b30";
      ctx.fillRect(0, mid - half, Math.max(1, w * lit), half * 2);
      return;
    }

    const peaks = peaksRef.current;
    if (peaks && peaks.length >= 2) {
      // Interleaved [lo, hi] per bucket, straight off the track buffer. Overdubs sum,
      // so a bucket can sit past ±1 — clamped here so a hot take reads as a full-height
      // block instead of vanishing off the top of the canvas.
      const buckets = peaks.length >> 1;
      ctx.fillStyle = color;
      for (let x = 0; x < w; x++) {
        const b = Math.min(buckets - 1, Math.floor((x / w) * buckets));
        const lo = Math.max(-1, Math.min(1, peaks[b * 2]));
        const hi = Math.max(-1, Math.min(1, peaks[b * 2 + 1]));
        const top = mid - hi * (mid - 1);
        const bottom = mid - lo * (mid - 1);
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
    } else if (!m || m.state === LOOP_STATE.EMPTY) {
      ctx.fillStyle = "#5a636e";
      ctx.font = "9px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText("HIT REC TO LAY THE FIRST PASS", w / 2, mid - 6);
      ctx.textAlign = "left";
    }

    if (m && m.frames > 0 && (m.state === LOOP_STATE.PLAY || m.state === LOOP_STATE.OVERDUB)) {
      const x = Math.round(Math.min(1, Math.max(0, m.position)) * w) + 0.5;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  });

  return <canvas ref={canvasRef} style={{ width: "100%", height: 56, display: "block", borderRadius: 2 }} />;
}

/* ------------------------------------------------------------------ lane chain */

function LoopSlot({
  index,
  slot,
  position,
  count,
}: {
  index: number;
  slot: PadSlotState;
  position: number;
  count: number;
}) {
  const client = useEngine();
  const def = EFFECTS[slot.type];
  if (!def) return null;
  const color = CATEGORY_COLOR[def.category];

  return (
    <div className="vk-panel flex shrink-0 flex-col" style={{ width: 186 }}>
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
          onClick={() => client.moveLoopEffect(index, slot.id, position - 1)}
          title="Move earlier in this lane's chain"
        >
          ◄
        </button>
        <button
          className="vk-btn"
          style={{ padding: "0 3px", lineHeight: 1.4 }}
          disabled={position >= count - 1}
          onClick={() => client.moveLoopEffect(index, slot.id, position + 1)}
          title="Move later in this lane's chain"
        >
          ►
        </button>
        <button
          className="vk-led"
          data-on={!slot.bypassed}
          style={{ border: "none", padding: 0, cursor: "pointer" }}
          onClick={() => client.setLoopEffectBypass(index, slot.id, !slot.bypassed)}
          title={slot.bypassed ? "Bypassed — click to engage" : "Active — click to bypass"}
        />
        <button
          className="vk-btn"
          data-tone="danger"
          style={{ padding: "0 4px", lineHeight: 1.4 }}
          onClick={() => client.removeLoopEffect(index, slot.id)}
          title="Remove from this lane"
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
          onChange={(v) => client.setLoopEffectMix(index, slot.id, v)}
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
          size={32}
          accent={color}
          onChange={(k, v) => client.setLoopEffectParam(index, slot.id, k, v)}
        />
      </div>
    </div>
  );
}

/**
 * The lane's module drop target. Same floating picker as the pad chain, fixed-position
 * for the same reason: the chain row is a horizontal scroller and anything in its flow
 * gets clipped on both axes.
 *
 * A picker rather than a drag target from the rack, because rack modules are dragged
 * with a bare `draggable` handle and no `dataTransfer` payload — the rack tracks the
 * dragged id in its own state, so a drop out here could not tell which module it caught.
 */
function AddLoopEffect({ index }: { index: number }) {
  const client = useEngine();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
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
    <div className="shrink-0" style={{ width: 88 }}>
      <button
        ref={btnRef}
        className="vk-focus-ring flex h-full w-full flex-col items-center justify-center gap-[4px]"
        style={{
          minHeight: 60,
          padding: "8px 6px",
          background: "rgba(255,176,32,0.05)",
          border: `1px dashed ${open ? "var(--vk-line)" : "rgba(255,176,32,0.5)"}`,
          borderRadius: 3,
          color: "var(--vk-amber)",
          cursor: "pointer",
        }}
        onClick={() => setOpen((v) => !v)}
        title="Add an effect that runs on this lane only"
      >
        <span className="vk-title" style={{ color: "var(--vk-amber)" }}>
          {open ? "CLOSE" : "+ LOOP FX"}
        </span>
      </button>
      {open && anchor && (
        <>
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
                          client.addLoopEffect(index, e.type);
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

/* ------------------------------------------------------------------ one lane */

function LoopLane({ index }: { index: number }) {
  const client = useEngine();
  const { loops, status } = useEngineState();
  const track = loops.tracks[index];
  const color = LANE_COLOR[index % LANE_COLOR.length];
  const [chainOpen, setChainOpen] = useState(false);

  const stateRef = useRef<HTMLSpanElement | null>(null);
  const pendRef = useRef<HTMLSpanElement | null>(null);
  const lenRef = useRef<HTMLSpanElement | null>(null);
  const levelRef = useRef<HTMLDivElement | null>(null);
  const recRef = useRef<HTMLButtonElement | null>(null);
  const undoRef = useRef<HTMLButtonElement | null>(null);

  useAnimationLoop(() => {
    const m = client.meters.loops[index];
    if (!m) return;
    const st = m.state | 0;
    if (stateRef.current) {
      const label = STATE_LABEL[st] ?? "—";
      if (stateRef.current.textContent !== label) {
        stateRef.current.textContent = label;
        stateRef.current.style.color = STATE_COLOR[st] ?? "var(--vk-text-dim)";
      }
    }
    if (pendRef.current) {
      const p = m.pending | 0;
      const label = p === LOOP_PENDING.NONE ? "" : `→ ${PENDING_LABEL[p] ?? ""}`;
      if (pendRef.current.textContent !== label) pendRef.current.textContent = label;
    }
    if (lenRef.current) {
      const secs = (m.frames || 0) / (client.sampleRate() || 48000);
      // `layers` counts passes, base take included — only an overdub is worth printing.
      const label = secs > 0 ? `${secs.toFixed(2)}s${m.layers > 1 ? ` · ${m.layers}×` : ""}` : "—";
      if (lenRef.current.textContent !== label) lenRef.current.textContent = label;
    }
    if (levelRef.current) {
      levelRef.current.style.width = `${Math.min(100, (m.level || 0) * 100).toFixed(1)}%`;
    }
    // REC lights while armed *or* rolling — a pending punch is the button's own feedback.
    if (recRef.current) {
      const hot = st === LOOP_STATE.REC || st === LOOP_STATE.OVERDUB;
      const arm = (m.pending | 0) === LOOP_PENDING.REC;
      const want = hot ? "true" : "false";
      if (recRef.current.dataset.active !== want) recRef.current.dataset.active = want;
      recRef.current.style.outline = arm ? "1px dashed var(--vk-amber)" : "none";
    }
    if (undoRef.current) {
      const can = !!m.canUndo;
      if (undoRef.current.disabled === can) undoRef.current.disabled = !can;
    }
  }, status === "running");

  if (!track) return null;

  return (
    <div
      className="vk-panel flex shrink-0 flex-col"
      style={{ borderLeft: `2px solid ${color}` }}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-[5px]">
        <input
          className="vk-input"
          style={{ width: 88, fontSize: 10, color }}
          value={track.name}
          onChange={(e) => client.setLoopName(index, e.target.value)}
          title="Name this lane — bass, chords, the beat you hummed"
        />
        <span className="vk-mono text-[10px]" style={{ minWidth: 44 }}>
          <span ref={stateRef} style={{ color: "var(--vk-text-dim)" }}>
            EMPTY
          </span>
        </span>
        <span ref={pendRef} className="vk-mono text-[10px]" style={{ color: "var(--vk-amber)", minWidth: 44 }} />
        <span ref={lenRef} className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)", minWidth: 62 }}>
          —
        </span>

        <div className="min-w-0 flex-1" />

        <button
          ref={recRef}
          className="vk-btn vk-focus-ring"
          data-tone="danger"
          style={{ fontSize: 9, padding: "3px 9px" }}
          onClick={() => client.loopRecord(index)}
          title="Punch: empty lane records, a rolling record closes the loop, a playing loop overdubs"
        >
          ● REC
        </button>
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "3px 9px" }}
          onClick={() => client.loopPlay(index)}
          title="Play this lane from the top of the loop"
        >
          ▶ PLAY
        </button>
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "3px 9px" }}
          onClick={() => client.loopStop(index)}
          title="Stop this lane — the take is kept"
        >
          ■ STOP
        </button>
        <button
          ref={undoRef}
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "3px 9px" }}
          disabled
          onClick={() => client.loopUndo(index)}
          title="Drop the last overdub pass — press again to bring it back"
        >
          UNDO
        </button>
        <button
          className="vk-btn vk-focus-ring"
          data-tone="danger"
          style={{ fontSize: 9, padding: "3px 9px" }}
          onClick={() => client.loopClear(index)}
          title="Erase this lane"
        >
          CLR
        </button>
      </div>

      <div className="flex items-stretch gap-2 px-2 pb-2">
        <div className="min-w-0 flex-1">
          <LoopWave index={index} color={color} />
          <div style={{ height: 3, marginTop: 2, background: "var(--vk-void)", borderRadius: 2 }}>
            <div ref={levelRef} style={{ width: "0%", height: "100%", background: color, borderRadius: 2 }} />
          </div>
        </div>

        <div className="flex shrink-0 items-start gap-[2px]">
          <Knob def={LANE_GAIN_DEF} value={track.gain} onChange={(v) => client.setLoopGain(index, v)} size={34} accent={color} bipolar />
          <Knob def={LANE_PAN_DEF} value={track.pan} onChange={(v) => client.setLoopPan(index, v)} size={34} accent={color} />
        </div>

        <div className="flex shrink-0 flex-col gap-[2px]" style={{ width: 64 }}>
          <button
            className="vk-btn vk-focus-ring"
            data-active={track.mute}
            data-tone="danger"
            style={{ fontSize: 9, padding: "2px 6px" }}
            onClick={() => client.setLoopMute(index, !track.mute)}
            title="Silence this lane"
          >
            MUTE
          </button>
          <button
            className="vk-btn vk-focus-ring"
            data-active={track.solo}
            data-tone="cyan"
            style={{ fontSize: 9, padding: "2px 6px" }}
            onClick={() => client.setLoopSolo(index, !track.solo)}
            title="Solo this lane. Soloing two lanes plays both."
          >
            SOLO
          </button>
          <button
            className="vk-btn vk-focus-ring"
            data-active={track.sync}
            style={{ fontSize: 9, padding: "2px 6px" }}
            onClick={() => client.setLoopSync(index, !track.sync)}
            title="Sync: punches wait for the quantise grid. Off: they land the instant you click."
          >
            SYNC
          </button>
        </div>

        <div className="flex shrink-0 flex-col gap-[2px]" style={{ width: 78 }}>
          <span className="vk-label" style={{ fontSize: 8 }}>
            SOURCE
          </span>
          <select
            className="vk-select"
            style={{ fontSize: 9 }}
            value={String(track.source)}
            onChange={(e) => client.setLoopSource(index, Number.parseInt(e.target.value, 10))}
            title="What this lane records: the master output (voice and everything on it) or the drum bus alone"
          >
            <option value={String(LOOP_SOURCE.MASTER)}>MASTER</option>
            <option value={String(LOOP_SOURCE.DRUMS)}>DRUMS</option>
          </select>
          <button
            className="vk-btn vk-focus-ring"
            data-active={chainOpen}
            style={{ fontSize: 9, padding: "2px 6px" }}
            onClick={() => setChainOpen((v) => !v)}
            title="Show this lane's effect chain"
          >
            FX {track.chain.length ? `(${track.chain.length})` : ""}
          </button>
        </div>
      </div>

      {chainOpen && (
        <div className="flex shrink-0 items-stretch gap-2 overflow-x-auto px-2 pb-2" style={{ maxHeight: 260 }}>
          {track.chain.map((slot, i) => (
            <LoopSlot key={slot.id} index={index} slot={slot} position={i} count={track.chain.length} />
          ))}
          <AddLoopEffect index={index} />
          {track.chain.length > 1 && (
            <button
              className="vk-btn vk-focus-ring shrink-0"
              data-tone="danger"
              style={{ fontSize: 9, padding: "2px 8px", alignSelf: "flex-start" }}
              onClick={() => client.clearLoopChain(index)}
              title="Remove every effect from this lane"
            >
              CLEAR FX
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ deck */

export function LoopDeck() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-2 overflow-y-auto">
      <TransportBar />
      {Array.from({ length: LOOP_TRACKS }, (_, i) => (
        <LoopLane key={i} index={i} />
      ))}
      <div className="vk-mono shrink-0 px-1 pb-1 text-[10px]" style={{ color: "var(--vk-text-dim)" }}>
        Loops live for this session only — closing the app or restarting the engine clears
        every lane. Saving loops alongside a kit is coming.
      </div>
    </div>
  );
}

export default LoopDeck;
