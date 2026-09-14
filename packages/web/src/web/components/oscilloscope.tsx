/**
 * Bro.Kodr — oscilloscope.
 *
 * Reuses the engine's existing scope transport (`pollScope` fills a contiguous sample
 * window from the shared ring), so this needed no new DSP-side plumbing and no change to
 * the SharedArrayBuffer layout.
 *
 * The one thing that matters visually: a raw window redrawn every frame makes the
 * waveform skate sideways, because each frame starts at a different phase. So the sweep
 * is TRIGGERED — the draw starts at the first rising zero crossing, which locks a
 * periodic signal in place exactly like the trigger on a bench scope. Hold-off keeps the
 * search inside the first half of the window so there is always a full sweep left to draw.
 */

import { useRef } from "react";
import { useCanvas, useEngine } from "../hooks/use-engine";

/** Find the first rising zero crossing, or -1. Searched over the hold-off region only. */
function findTrigger(buf: Float32Array, limit: number): number {
  for (let i = 1; i < limit; i++) {
    if (buf[i - 1] <= 0 && buf[i] > 0) return i;
  }
  return -1;
}

export function Oscilloscope({ gain = 1 }: { gain?: number }) {
  const client = useEngine();
  // Last known good trigger index, reused when a frame has no crossing (e.g. silence or
  // pure DC) so the trace does not jump back to zero and flicker.
  const lastTrig = useRef(0);

  const canvasRef = useCanvas((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);

    // glass
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#0a0f11");
    bg.addColorStop(1, "#040708");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const mid = h / 2;

    // ---- graticule: 8 x 4 divisions, centre lines brighter
    ctx.strokeStyle = "rgba(53,214,208,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 8; i++) {
      const x = (i / 8) * w;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
    }
    for (let i = 1; i < 4; i++) {
      const y = (i / 4) * h;
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    ctx.strokeStyle = "rgba(53,214,208,0.26)";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();

    const got = client.pollScope(1024);
    if (!got) {
      ctx.fillStyle = "#3a4048";
      ctx.font = "10px 'JetBrains Mono', monospace";
      ctx.fillText("engine idle", 8, mid - 5);
      return;
    }

    const out = client.scope.output;
    const inp = client.scope.input;
    // The scope buffers are over-allocated; only `frames` leading samples are live. Using
    // `out.length` here drew the permanently-zero tail as a dead flat line over the right
    // half of the trace — the "right side doesn't move" bug.
    const n = client.scope.frames;
    if (n < 8) return;
    const half = Math.floor(n / 2);

    // ---- trigger off the output, and use the same offset for the input trace so the
    // two stay phase-aligned against each other.
    const t = findTrigger(out, half);
    if (t >= 0) lastTrig.current = t;
    const trig = Math.min(lastTrig.current, half);
    // Fixed sweep length, variable start: a constant time base. (A variable span made the
    // horizontal scale change every frame, so the trace stretched and wobbled to the
    // right of the trigger point even on a steady tone.)
    const span = half;

    const trace = (buf: Float32Array, color: string, alpha: number, width: number) => {
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let x = 0; x < w; x++) {
        const i = trig + Math.floor((x / w) * span);
        const v = Math.max(-1.4, Math.min(1.4, buf[i] * gain));
        const y = mid - v * (mid - 3);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    trace(inp, "#35d6d0", 0.32, 1);
    trace(out, "#35d6d0", 1, 1.5);

    // legend
    ctx.fillStyle = "rgba(125,134,139,0.9)";
    ctx.font = "600 8px 'Chakra Petch', sans-serif";
    ctx.fillText("OSCILLOSCOPE", 6, 11);
    ctx.fillText(t >= 0 ? "TRIG ⌁" : "TRIG —", w - 46, 11);
  });

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}
