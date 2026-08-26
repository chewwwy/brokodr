/**
 * Bro.Kodr — hardware control primitives.
 *
 * Every control here is pointer-driven with the conventions engineers expect from a
 * plugin: vertical drag, Shift for fine, double-click to reset, wheel to nudge. Values
 * are always shown in real units next to the control — never a bare 0..1.
 *
 * Deliberately no CSS transitions: these repaint while audio is running.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  clampParam,
  formatParam,
  normToValue,
  valueToNorm,
  type ParamDef,
} from "../audio/param-schema";

/** Pixels of vertical travel for a full-range sweep. */
const DRAG_RANGE = 170;
const FINE_FACTOR = 0.2;

/* ------------------------------------------------------------------ pointer drag */

interface DragOpts {
  onDelta: (deltaNorm: number, fine: boolean) => void;
  onStart?: () => void;
  onEnd?: () => void;
}

/**
 * Shared drag behaviour. Uses pointer capture so the gesture survives the cursor
 * leaving the element, which matters for a 44px knob with a 170px throw.
 */
function useVerticalDrag({ onDelta, onStart, onEnd }: DragOpts) {
  const last = useRef(0);
  const active = useRef(false);

  return useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const el = e.currentTarget as HTMLElement;
      el.setPointerCapture(e.pointerId);
      last.current = e.clientY;
      active.current = true;
      onStart?.();

      const move = (ev: PointerEvent) => {
        if (!active.current) return;
        const dy = last.current - ev.clientY;
        last.current = ev.clientY;
        onDelta(dy / DRAG_RANGE, ev.shiftKey);
      };
      const up = () => {
        active.current = false;
        el.releasePointerCapture?.(e.pointerId);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        onEnd?.();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [onDelta, onStart, onEnd],
  );
}

/* ------------------------------------------------------------------ Knob */

export interface KnobProps {
  def: ParamDef;
  value: number;
  onChange: (v: number) => void;
  /** Draw the arc from 12 o'clock instead of from the minimum. */
  bipolar?: boolean;
  size?: number;
  /** Highlight ring — used to show a MIDI mapping is attached. */
  mapped?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
  accent?: string;
  /**
   * "flat" is the original dark-panel knob. "metal" is the machined knurled
   * knob from the product renders — a dark cylinder on a silver faceplate with
   * a white index line and a dot scale ring around the outside.
   *
   * Drawn with SVG gradients and stroked ticks only. No CSS filters: with 50+
   * knobs on screen, a blur or drop-shadow filter per knob forces an offscreen
   * compositing pass each and drops the drag framerate.
   */
  skin?: "flat" | "metal";
}

/**
 * Rotary control drawn with SVG arcs. 270 degrees of travel from -135 to +135,
 * matching physical knob convention so the pointer position reads at a glance.
 */
export function Knob({
  def,
  value,
  onChange,
  bipolar,
  size = 42,
  mapped,
  onContextMenu,
  accent = "var(--vk-amber)",
  skin = "flat",
}: KnobProps) {
  const norm = valueToNorm(def, value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const normRef = useRef(norm);
  normRef.current = norm;

  const isBipolar = bipolar ?? (def.min < 0 && def.max > 0);

  const apply = useCallback(
    (n: number) => {
      const clamped = Math.min(1, Math.max(0, n));
      let v = normToValue(def, clamped);
      if (def.step) v = Math.round(v / def.step) * def.step;
      onChange(clampParam(def, v));
    },
    [def, onChange],
  );

  const onDown = useVerticalDrag({
    onDelta: (d, fine) => apply(normRef.current + d * (fine ? FINE_FACTOR : 1)),
  });

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.stopPropagation();
      const step = (e.shiftKey ? 0.002 : 0.02) * (e.deltaY > 0 ? -1 : 1);
      apply(normRef.current + step);
    },
    [apply],
  );

  // Geometry: 270-degree sweep, gap at the bottom.
  const r = size / 2 - 4;
  const cx = size / 2;
  const cy = size / 2;
  const START = -225; // degrees, SVG space (0 = 3 o'clock)
  const SWEEP = 270;

  const pt = (deg: number, radius: number) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + Math.cos(rad) * radius, cy + Math.sin(rad) * radius] as const;
  };
  const arc = (fromN: number, toN: number, radius: number) => {
    const a0 = START + SWEEP * fromN;
    const a1 = START + SWEEP * toN;
    if (Math.abs(a1 - a0) < 0.01) return "";
    const [x0, y0] = pt(a0, radius);
    const [x1, y1] = pt(a1, radius);
    const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
    const sweepFlag = a1 > a0 ? 1 : 0;
    return `M ${x0} ${y0} A ${radius} ${radius} 0 ${large} ${sweepFlag} ${x1} ${y1}`;
  };

  const indicatorDeg = START + SWEEP * norm;
  const [nx, ny] = pt(indicatorDeg, r - 1);
  const [nix, niy] = pt(indicatorDeg, r * 0.42);
  const fillFrom = isBipolar ? 0.5 : 0;

  /* ---- Metal-skin dial geometry (unused by the flat skin).
     CAP is the turned cap inside the bezel; the bezel occupies everything from
     CAP out to r, which is what makes it read as broad rather than a hairline
     ring. The index notch is a short stub cut near the cap's edge, so it runs
     from NOTCH_OUT down to NOTCH_IN only — never to the centre. */
  const TICKS = 61;
  const CAP = Math.max(4, r * 0.62);
  const [nx2, ny2] = pt(indicatorDeg, CAP - 1);
  const [nx3, ny3] = pt(indicatorDeg, CAP * 0.52);

  return (
    <div className="flex flex-col items-center gap-[2px]" style={{ width: size + 12 }}>
      <div
        className="vk-knob relative"
        style={{ width: size, height: size }}
        onPointerDown={onDown}
        onWheel={onWheel}
        onDoubleClick={() => onChange(def.def)}
        onContextMenu={onContextMenu}
        title={`${def.label} — drag to adjust, Shift = fine, double-click = ${formatParam(def, def.def)}`}
      >
        {skin === "metal" ? (
          <svg width={size} height={size} style={{ display: "block", overflow: "visible" }}>
            <defs>
              {/* One gradient id per knob size is enough — ids are scoped by the
                  document, so reusing a size-keyed id across knobs is intentional
                  and keeps the def count flat instead of one per instance. */}
              {/* Cap: light converging toward the centre of the spin, which is what
                  sells a radially-brushed machined cap rather than a plastic dome. */}
              <radialGradient id={`mkKnob${size}`} cx="42%" cy="34%" r="82%">
                <stop offset="0%" stopColor="#3c4247" />
                <stop offset="42%" stopColor="#22272b" />
                <stop offset="78%" stopColor="#161a1d" />
                <stop offset="100%" stopColor="#0a0c0e" />
              </radialGradient>
              {/* Broad outer bezel ring. */}
              <linearGradient id={`mkKnobRim${size}`} x1="0" y1="0" x2="0.25" y2="1">
                <stop offset="0%" stopColor="#7a8085" />
                <stop offset="38%" stopColor="#43484c" />
                <stop offset="72%" stopColor="#22262a" />
                <stop offset="100%" stopColor="#4c5256" />
              </linearGradient>
            </defs>

            {/* ---- Fine tick arc, OUTSIDE the knob. The reference dial's defining
                feature: ~61 hairline radial ticks over the 270 degrees of travel,
                coloured along the arc up to the current value. Every fifth tick is
                longer, as a major graduation. */}
            {Array.from({ length: TICKS }, (_, i) => {
              const n = i / (TICKS - 1);
              const major = i % 5 === 0;
              const deg = START + SWEEP * n;
              const inner = r + 1.4;
              const outer = inner + (major ? 3.4 : 2.1);
              const [x0, y0] = pt(deg, inner);
              const [x1, y1] = pt(deg, outer);
              // Lit region runs from centre outward when bipolar, else from zero.
              const lit = isBipolar
                ? n >= Math.min(0.5, norm) - 1e-6 && n <= Math.max(0.5, norm) + 1e-6
                : n <= norm + 1e-6;
              return (
                <line
                  key={i}
                  x1={x0}
                  y1={y0}
                  x2={x1}
                  y2={y1}
                  stroke={lit ? accent : "#5c6367"}
                  strokeWidth={major ? 1.1 : 0.7}
                  opacity={lit ? 1 : 0.55}
                  strokeLinecap="butt"
                />
              );
            })}

            {/* ---- Broad bezel ring with a hard inner shadow line, then the cap. */}
            <circle cx={cx} cy={cy} r={r - 0.6} fill={`url(#mkKnobRim${size})`} />
            <circle cx={cx} cy={cy} r={r - 0.6} fill="none" stroke="rgb(0 0 0 / 55%)" strokeWidth="0.7" />
            {/* The inner shadow line separating bezel from cap. */}
            <circle cx={cx} cy={cy} r={CAP + 0.9} fill="none" stroke="rgb(0 0 0 / 85%)" strokeWidth="1.6" />
            <circle cx={cx} cy={cy} r={CAP} fill={`url(#mkKnob${size})`} />

            {/* ---- Radial spin texture on the cap: alternating hairline spokes from
                the centre out, converging as real turned metal does. 28 spokes is
                enough to read as brushing and stays cheap on a drag. */}
            {Array.from({ length: 28 }, (_, i) => {
              const deg = (i * 360) / 28;
              const [x0, y0] = pt(deg, CAP * 0.16);
              const [x1, y1] = pt(deg, CAP - 0.6);
              return (
                <line
                  key={`s${i}`}
                  x1={x0}
                  y1={y0}
                  x2={x1}
                  y2={y1}
                  stroke={i % 2 ? "rgb(255 255 255 / 6%)" : "rgb(0 0 0 / 22%)"}
                  strokeWidth="0.6"
                />
              );
            })}
            {/* Specular band across the upper-left of the cap. */}
            <path
              d={arc(0.08, 0.4, CAP * 0.66)}
              fill="none"
              stroke="rgb(255 255 255 / 20%)"
              strokeWidth={Math.max(1, CAP * 0.16)}
              strokeLinecap="round"
            />

            {/* ---- Short index notch cut near the top edge of the cap — not a
                full-radius line. This is how the reference dial marks position. */}
            <line
              x1={nx2}
              y1={ny2}
              x2={nx3}
              y2={ny3}
              stroke="#eef2f3"
              strokeWidth="2"
              strokeLinecap="round"
            />
            {mapped && (
              <circle cx={cx} cy={cy} r={r + 4.5} fill="none" stroke={accent} strokeWidth="1" opacity="0.7" />
            )}
          </svg>
        ) : (
          <svg width={size} height={size} style={{ display: "block", overflow: "visible" }}>
            {/* machined body */}
            <circle cx={cx} cy={cy} r={r - 3} fill="#1a1d21" stroke="#000" strokeWidth="1" />
            <circle cx={cx} cy={cy - 0.5} r={r - 4} fill="none" stroke="#2e3339" strokeWidth="1" />
            {/* track */}
            <path d={arc(0, 1, r)} fill="none" stroke="#242830" strokeWidth="3" strokeLinecap="round" />
            {/* value arc */}
            <path
              d={arc(Math.min(fillFrom, norm), Math.max(fillFrom, norm), r)}
              fill="none"
              stroke={accent}
              strokeWidth="3"
              strokeLinecap="round"
            />
            {/* pointer notch */}
            <line x1={nix} y1={niy} x2={nx} y2={ny} stroke={accent} strokeWidth="2" strokeLinecap="round" />
            {mapped && (
              <circle cx={cx} cy={cy} r={r + 2.5} fill="none" stroke="var(--vk-violet)" strokeWidth="1" opacity="0.8" />
            )}
          </svg>
        )}
      </div>
      <div className="vk-label w-full truncate text-center" title={def.label}>
        {def.label}
      </div>
      {editing ? (
        <input
          autoFocus
          className="vk-input h-[16px] px-1 py-0 text-center text-[10px]"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              const n = parseFloat(draft);
              if (Number.isFinite(n)) onChange(clampParam(def, n));
              setEditing(false);
            } else if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button
          className="vk-value w-full truncate text-center text-[10px] leading-[13px]"
          style={{
            // On a silver faceplate the dark-panel mid-grey is unreadable, so the
            // metal skin inks the value as engraving instead.
            color: skin === "metal" ? "var(--mk-etch)" : "var(--vk-text-mid)",
            background: "none",
            border: "none",
            cursor: "text",
            padding: 0,
          }}
          onClick={() => {
            setDraft(String(Number(value.toFixed(def.decimals ?? 2))));
            setEditing(true);
          }}
          title="Click to type a value"
        >
          {formatParam(def, value)}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ Fader */

export function Fader({
  value,
  min,
  max,
  onChange,
  height = 110,
  label,
  format,
  accent = "var(--vk-amber)",
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  height?: number;
  label?: string;
  format?: (v: number) => string;
  accent?: string;
}) {
  const norm = (value - min) / (max - min);
  const normRef = useRef(norm);
  normRef.current = norm;

  const onDown = useVerticalDrag({
    onDelta: (d, fine) => {
      const n = Math.min(1, Math.max(0, normRef.current + d * (fine ? FINE_FACTOR : 1)));
      onChange(min + n * (max - min));
    },
  });

  const capY = (1 - norm) * (height - 18);

  return (
    <div className="flex flex-col items-center gap-1">
      {label && <div className="vk-label">{label}</div>}
      <div
        className="vk-knob relative"
        style={{ width: 24, height }}
        onPointerDown={onDown}
        onDoubleClick={() => onChange(0)}
        onWheel={(e) => {
          e.stopPropagation();
          const n = Math.min(1, Math.max(0, normRef.current + (e.deltaY > 0 ? -0.02 : 0.02)));
          onChange(min + n * (max - min));
        }}
      >
        {/* track well */}
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            width: 5,
            top: 6,
            bottom: 6,
            background: "#0b0d10",
            border: "1px solid #000",
            borderRadius: 3,
            boxShadow: "inset 0 1px 3px rgba(0,0,0,.8)",
          }}
        />
        {/* filled portion */}
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            width: 3,
            bottom: 7,
            height: Math.max(0, norm * (height - 14)),
            background: accent,
            opacity: 0.5,
          }}
        />
        {/* machined cap */}
        <div
          className="absolute left-1/2 -translate-x-1/2"
          style={{
            top: capY,
            width: 22,
            height: 18,
            borderRadius: 2,
            background: "linear-gradient(180deg,#3a4048 0%,#22262b 45%,#171a1e 100%)",
            border: "1px solid #000",
            boxShadow: "0 1px 2px rgba(0,0,0,.6)",
          }}
        >
          <div className="absolute left-0 right-0 top-1/2" style={{ height: 1, background: accent }} />
        </div>
      </div>
      <div className="vk-value text-[10px]" style={{ color: "var(--vk-text-mid)" }}>
        {format ? format(value) : value.toFixed(1)}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Toggle / Select */

export function Toggle({
  on,
  onChange,
  label,
  tone,
  title,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  label: string;
  tone?: "amber" | "green" | "red" | "cyan";
  title?: string;
}) {
  return (
    <button
      className="vk-btn vk-focus-ring flex w-full items-center gap-[6px]"
      onClick={() => onChange(!on)}
      data-active={on}
      data-tone={tone === "red" ? "danger" : tone === "cyan" ? "cyan" : undefined}
      title={title ?? label}
    >
      <span className="vk-led" data-on={on} data-tone={tone && tone !== "amber" ? tone : undefined} />
      <span className="truncate">{label}</span>
    </button>
  );
}

export function SelectControl({
  def,
  value,
  onChange,
}: {
  def: ParamDef;
  value: number;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span className="vk-label truncate">{def.label}</span>
      <select
        id={id}
        className="vk-select"
        value={Math.round(value)}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {(def.options ?? []).map((opt, i) => (
          <option key={opt} value={i}>
            {opt}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ------------------------------------------------------------------ misc */

export function Segment({
  children,
  className = "",
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <div className={`vk-well vk-mono px-2 py-1 text-[10px] ${className}`} title={title}>
      {children}
    </div>
  );
}

export function LabeledSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  title,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  title?: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="flex flex-col gap-[3px]" title={title}>
      <span className="vk-label">{label}</span>
      <select
        id={id}
        className="vk-select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Dry/wet slider. This is the ONLY dry/wet control in the app - the master blend
 * in the I/O panel and every per-module MIX strip render through it, so restyling
 * here is global by construction.
 *
 * Styled off the slider.jpg reference: a sunken hatched track, a lit accent bar
 * that glows through the left-hand run, and a chunky milled handle straddling it.
 * The glow is a box-shadow, never a `filter: drop-shadow` - a filter repaints the
 * element offscreen, and there can be 20+ of these on screen at once.
 */
export function MiniSlider({
  value,
  onChange,
  width = 54,
  title,
  accent = "var(--vk-amber)",
}: {
  value: number;
  onChange: (v: number) => void;
  width?: number;
  title?: string;
  accent?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const set = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    onChange(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };

  return (
    <div
      ref={ref}
      className="relative shrink-0"
      style={{ width, height: 16, cursor: "ew-resize" }}
      title={title}
      onPointerDown={(e) => {
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        set(e.clientX);
        const move = (ev: PointerEvent) => set(ev.clientX);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onChange(1);
      }}
    >
      {/* sunken track, hatched like a milled channel */}
      <div
        className="absolute left-0 right-0"
        style={{
          top: 5,
          height: 6,
          borderRadius: 3,
          background:
            "repeating-linear-gradient(72deg, rgb(255 255 255 / 0%) 0px, rgb(255 255 255 / 7%) 1px, rgb(255 255 255 / 0%) 3px), linear-gradient(180deg, #05070a 0%, #10151a 100%)",
          boxShadow: "inset 0 1px 2px rgb(0 0 0 / 90%), 0 1px 0 rgb(255 255 255 / 7%)",
        }}
      />
      {/* lit run up to the value */}
      <div
        className="absolute"
        style={{
          left: 0,
          top: 5,
          height: 6,
          width: `${value * 100}%`,
          borderRadius: 3,
          background: `linear-gradient(180deg, ${accent} 0%, ${accent} 55%, rgb(0 0 0 / 22%) 100%)`,
          boxShadow: `0 0 5px ${accent}, inset 0 1px 0 rgb(255 255 255 / 45%)`,
        }}
      />
      {/* milled handle straddling the channel */}
      <div
        className="absolute"
        style={{
          left: `calc(${value * 100}% - 5px)`,
          top: 0,
          width: 10,
          height: 16,
          borderRadius: 3,
          background: "linear-gradient(180deg, #4a5055 0%, #2d3237 48%, #1b1f22 100%)",
          boxShadow:
            "inset 0 1px 0 rgb(255 255 255 / 28%), inset 0 -1px 0 rgb(0 0 0 / 70%), 0 1px 3px rgb(0 0 0 / 80%)",
        }}
      />
    </div>
  );
}

/**
 * Collapsible section used by the side panels.
 *
 * `tone` colour-codes the section: the header gets a wash of that hue and the title a
 * bright tint of it, both derived from one `--vk-tone` variable by .vk-tone-head /
 * .vk-tone-text in styles.css. The body stays neutral so the colour identifies the panel
 * without tinting the controls inside it.
 */
export function Section({
  title,
  children,
  right,
  defaultOpen = true,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  defaultOpen?: boolean;
  tone?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="vk-panel flex min-h-0 flex-col">
      <div
        className={`flex shrink-0 items-center justify-between px-2 py-[6px] ${tone ? "vk-tone-head" : ""}`}
        style={
          tone
            ? ({ "--vk-tone": tone } as React.CSSProperties)
            : { borderBottom: open ? "1px solid var(--vk-line)" : "none" }
        }
      >
        <button
          className={`vk-title flex items-center gap-[6px] ${tone ? "vk-tone-text" : ""}`}
          style={{
            background: "none",
            border: "none",
            color: tone ? undefined : "var(--vk-text-mid)",
            cursor: "pointer",
            padding: 0,
            ...(tone ? ({ "--vk-tone": tone } as React.CSSProperties) : {}),
          }}
          onClick={() => setOpen((v) => !v)}
        >
          <span
            className={tone ? "vk-tone-dim" : ""}
            style={{ fontSize: 8, color: tone ? undefined : "var(--vk-text-dim)", ...(tone ? ({ "--vk-tone": tone } as React.CSSProperties) : {}) }}
          >
            {open ? "▼" : "▶"}
          </span>
          {title}
        </button>
        {right}
      </div>
      {open && <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>}
    </div>
  );
}

/** Keyboard shortcut registration that ignores keystrokes aimed at text fields. */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const combo = `${e.ctrlKey || e.metaKey ? "mod+" : ""}${e.shiftKey ? "shift+" : ""}${e.key.toLowerCase()}`;
      const fn = ref.current[combo];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
