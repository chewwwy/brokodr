/**
 * Bro.Kodr — live vocoder band ladder.
 *
 * Draws the per-band VCA gains the vocoder is actually applying, straight from the
 * DSP module's `get visual()`. It is not a re-analysis of the output: each bar IS
 * the envelope follower that is opening that band's VCA this instant.
 *
 * Transport: `getVisual()` is one postMessage + Promise per request, so this polls
 * at ~24fps with an in-flight guard rather than asking every animation frame — a
 * second request while one is outstanding would resolve the first with null and
 * make the ladder stutter. The faster alternative (writing envelopes into the
 * SharedArrayBuffer meter block) would change the SAB layout, which is a much
 * deeper change than a display warrants.
 *
 * Bars are decayed locally between polls so the ladder falls smoothly instead of
 * stepping at the poll rate. Canvas, not 50 DOM nodes: one repaint per frame.
 */

import { useEffect, useRef } from "react";
import { useAnimationLoop, useEngine } from "../hooks/use-engine";

/** Poll interval in ms. ~24fps — fast enough to read as live, cheap on the ring. */
const POLL_MS = 42;
/** Per-frame fall rate. Attack is instant, release is eased: meter convention. */
const FALL = 0.055;

export function BandLadder({
  slotId,
  bands,
  height = 74,
}: {
  slotId: number;
  /** Band count from the module's own param, so the ladder matches the DSP. */
  bands: number;
  height?: number;
}) {
  const client = useEngine();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** Latest values from the DSP. */
  const dataRef = useRef<Float32Array | null>(null);
  /** Displayed values, eased toward dataRef. */
  const shownRef = useRef<number[]>([]);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const v = await client.getVisual(slotId);
        if (alive && v) dataRef.current = v;
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const iv = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [client, slotId]);

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
    ctx.clearRect(0, 0, w, h);

    const data = dataRef.current;
    const n = Math.max(1, data ? Math.min(bands, data.length) : bands);
    const shown = shownRef.current;
    if (shown.length !== n) shown.length = n;

    // Faint horizontal rules at -40/-20dB equivalents on the 0..1 display scale.
    ctx.strokeStyle = "rgb(53 214 208 / 9%)";
    ctx.lineWidth = 1;
    for (const f of [0.33, 0.66]) {
      const y = Math.round(h * (1 - f)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const pitch = w / n;
    const bw = Math.max(2, pitch - 2);

    for (let i = 0; i < n; i++) {
      const target = data ? (data[i] ?? 0) : 0;
      const prev = shown[i] ?? 0;
      // Instant attack, eased release.
      const v = target >= prev ? target : Math.max(target, prev - FALL);
      shown[i] = v;

      const x = Math.round(i * pitch) + 1;
      const bh = Math.max(1, Math.round(v * (h - 3)));
      const y = h - 1 - bh;

      // Unlit well, so the ladder reads as 16 slots even in silence.
      ctx.fillStyle = "rgb(53 214 208 / 7%)";
      ctx.fillRect(x, 1, bw, h - 2);

      // Lit bar. Brighter at the top of its own travel, like a real LED column.
      const grad = ctx.createLinearGradient(0, y, 0, h);
      grad.addColorStop(0, "#8ffff9");
      grad.addColorStop(0.35, "#35d6d0");
      grad.addColorStop(1, "#12706e");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, bw, bh);

      // Peak cap.
      ctx.fillStyle = "#d7fffd";
      ctx.fillRect(x, y, bw, 1);
    }
  });

  return (
    <div className="mk-glass relative overflow-hidden" style={{ height }}>
      <canvas ref={canvasRef} className="block h-full w-full" />
      <span
        className="mk-etch-dim pointer-events-none absolute"
        style={{
          bottom: 2,
          left: 4,
          color: "rgb(53 214 208 / 45%)",
          fontFamily: "var(--font-mono)",
          fontSize: 7,
          letterSpacing: "0.12em",
          textShadow: "none",
        }}
      >
        {bands} BAND ANALYSIS
      </span>
    </div>
  );
}
