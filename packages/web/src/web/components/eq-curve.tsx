/**
 * Bro.Kodr — EQ response display with draggable band nodes.
 *
 * The curve is not modelled in the UI: it is the real composite magnitude response
 * computed by the DSP module from its live biquad coefficients and shipped back over
 * `getVisual()`. What you see is literally what the filters are doing.
 *
 * Nodes are draggable in two axes at once (X = frequency, Y = gain) with the wheel
 * controlling Q, which is the interaction every mixing engineer already has in muscle
 * memory from a channel EQ.
 */

import { useEffect, useRef, useState } from "react";
import { useAnimationLoop, useEngine } from "../hooks/use-engine";
import { clampParam, paramDef } from "../audio/param-schema";

const F_MIN = 20;
const F_MAX = 20000;
const DB_RANGE = 18;
const CURVE_POINTS = 160;

interface BandNode {
  freqKey: string;
  gainKey: string | null;
  qKey: string | null;
  label: string;
  color: string;
}

const NODES: BandNode[] = [
  { freqKey: "hpFreq", gainKey: null, qKey: null, label: "HP", color: "#9aa2ad" },
  { freqKey: "lsFreq", gainKey: "lsGain", qKey: null, label: "LS", color: "#35d6d0" },
  { freqKey: "b1Freq", gainKey: "b1Gain", qKey: "b1Q", label: "1", color: "#ffb020" },
  { freqKey: "b2Freq", gainKey: "b2Gain", qKey: "b2Q", label: "2", color: "#ffb020" },
  { freqKey: "b3Freq", gainKey: "b3Gain", qKey: "b3Q", label: "3", color: "#ffb020" },
  { freqKey: "hsFreq", gainKey: "hsGain", qKey: null, label: "HS", color: "#35d6d0" },
  { freqKey: "lpFreq", gainKey: null, qKey: null, label: "LP", color: "#9aa2ad" },
];

const logMin = Math.log10(F_MIN);
const logMax = Math.log10(F_MAX);

const fToX = (f: number, w: number) => ((Math.log10(Math.max(F_MIN, f)) - logMin) / (logMax - logMin)) * w;
const xToF = (x: number, w: number) => Math.pow(10, logMin + (x / w) * (logMax - logMin));
const dbToY = (db: number, h: number) => h / 2 - (db / DB_RANGE) * (h / 2);
const yToDb = (y: number, h: number) => ((h / 2 - y) / (h / 2)) * DB_RANGE;

export function EqCurve({
  slotId,
  params,
  onParam,
  height = 132,
}: {
  slotId: number;
  params: Record<string, number>;
  onParam: (key: string, value: number) => void;
  height?: number;
}) {
  const client = useEngine();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const curveRef = useRef<Float32Array | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Pull the real response from the DSP module a few times a second. It only changes
  // when a param moves, so there is no reason to ask for it every frame.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const v = await client.getVisual(slotId);
      if (alive && v) curveRef.current = v;
    };
    void tick();
    const iv = setInterval(tick, 120);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [client, slotId, params]);

  useAnimationLoop(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, w, h);

    // log frequency grid
    ctx.strokeStyle = "#1c2026";
    ctx.lineWidth = 1;
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = Math.round(fToX(f, w)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.fillStyle = "#3a4048";
    ctx.font = "8px 'JetBrains Mono', monospace";
    for (const f of [100, 1000, 10000]) {
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, fToX(f, w) + 2, h - 2);
    }
    // dB grid
    for (const db of [-12, -6, 6, 12]) {
      const y = Math.round(dbToY(db, h)) + 0.5;
      ctx.strokeStyle = "#1c2026";
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "#2a2e34";
    const zero = Math.round(dbToY(0, h)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, zero);
    ctx.lineTo(w, zero);
    ctx.stroke();

    // response curve
    const curve = curveRef.current;
    if (curve && curve.length >= CURVE_POINTS) {
      ctx.beginPath();
      for (let i = 0; i < CURVE_POINTS; i++) {
        const f = Math.pow(10, logMin + ((logMax - logMin) * i) / (CURVE_POINTS - 1));
        const x = fToX(f, w);
        const y = dbToY(Math.max(-40, Math.min(40, curve[i])), h);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#ffb020";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.lineTo(w, zero);
      ctx.lineTo(0, zero);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,176,32,0.10)";
      ctx.fill();
    }

    // band nodes
    const p = paramsRef.current;
    NODES.forEach((node, i) => {
      const f = p[node.freqKey] ?? 1000;
      const gain = node.gainKey ? (p[node.gainKey] ?? 0) : 0;
      const x = fToX(f, w);
      const y = node.gainKey ? dbToY(gain, h) : zero;
      const active = drag === i || hover === i;
      ctx.beginPath();
      ctx.arc(x, y, active ? 6 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = active ? node.color : "#16181b";
      ctx.fill();
      ctx.strokeStyle = node.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = active ? "#08090a" : node.color;
      ctx.font = "bold 7px 'Inter Tight', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(node.label, x, y + 0.5);
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    });
  });

  const hitTest = (e: React.PointerEvent | React.MouseEvent): number | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best: number | null = null;
    let bestD = 14;
    NODES.forEach((node, i) => {
      const f = paramsRef.current[node.freqKey] ?? 1000;
      const gain = node.gainKey ? (paramsRef.current[node.gainKey] ?? 0) : 0;
      const x = fToX(f, rect.width);
      const y = node.gainKey ? dbToY(gain, rect.height) : rect.height / 2;
      const d = Math.hypot(mx - x, my - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const i = hitTest(e);
    if (i === null) return;
    e.preventDefault();
    const canvas = canvasRef.current!;
    canvas.setPointerCapture(e.pointerId);
    setDrag(i);
    const node = NODES[i];
    const rect = canvas.getBoundingClientRect();

    const move = (ev: PointerEvent) => {
      const mx = Math.max(0, Math.min(rect.width, ev.clientX - rect.left));
      const my = Math.max(0, Math.min(rect.height, ev.clientY - rect.top));
      const fdef = paramDef("eq", node.freqKey);
      if (fdef) onParam(node.freqKey, clampParam(fdef, xToF(mx, rect.width)));
      if (node.gainKey) {
        const gdef = paramDef("eq", node.gainKey);
        if (gdef) onParam(node.gainKey, clampParam(gdef, yToDb(my, rect.height)));
      }
    };
    const up = () => {
      setDrag(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    move(e.nativeEvent);
  };

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height, display: "block", cursor: hover !== null ? "grab" : "crosshair" }}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (drag === null) setHover(hitTest(e));
      }}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={(e) => {
        const i = hitTest(e);
        if (i === null) return;
        const node = NODES[i];
        if (node.gainKey) {
          const gdef = paramDef("eq", node.gainKey);
          if (gdef) onParam(node.gainKey, gdef.def);
        }
      }}
      onWheel={(e) => {
        const i = hitTest(e);
        if (i === null) return;
        const node = NODES[i];
        if (!node.qKey) return;
        e.stopPropagation();
        const qdef = paramDef("eq", node.qKey);
        if (!qdef) return;
        const cur = paramsRef.current[node.qKey] ?? qdef.def;
        onParam(node.qKey, clampParam(qdef, cur * (e.deltaY > 0 ? 0.92 : 1.087)));
      }}
      title="Drag nodes to set frequency and gain · wheel over a peak node sets Q · double-click resets gain"
    />
  );
}
