import { useEffect, useRef, useSyncExternalStore } from "react";
import { getEngineClient, type EngineClient } from "../audio/engine-client";
import { getMidiController, type MidiController } from "../audio/midi";

/**
 * React bindings for the audio engine.
 *
 * `useEngineState` subscribes to the client's snapshot — structural state only (chain
 * order, params, device settings). Meters and scopes deliberately do NOT go through
 * React: they update 60 times a second and would re-render the tree at that rate. Use
 * `useAnimationLoop` and draw straight to canvas instead.
 */

export function useEngine(): EngineClient {
  return getEngineClient();
}

export function useEngineState() {
  const client = getEngineClient();
  return useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
}

export function useMidi(): MidiController {
  return getMidiController(getEngineClient());
}

export function useMidiState() {
  const midi = getMidiController(getEngineClient());
  return useSyncExternalStore(midi.subscribe, midi.getSnapshot, midi.getSnapshot);
}

/**
 * A single shared requestAnimationFrame loop per component. The callback is kept in a ref
 * so the loop is never torn down and recreated when props change — restarting rAF mid-draw
 * is what makes meters stutter.
 */
export function useAnimationLoop(fn: (dtMs: number) => void, active = true) {
  const ref = useRef(fn);
  ref.current = fn;

  useEffect(() => {
    if (!active) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      ref.current(dt);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
}

/**
 * Sizes a canvas to its container at the device pixel ratio and returns the 2D context.
 * Without the DPR scaling every meter and scope is soft on a HiDPI display.
 */
export function useCanvas(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  active = true,
): React.RefObject<HTMLCanvasElement | null> {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const sizeRef = useRef({ w: 0, h: 0 });

  useAnimationLoop(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    if (sizeRef.current.w !== w || sizeRef.current.h !== h) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      sizeRef.current = { w, h };
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRef.current(ctx, w, h);
  }, active);

  return canvasRef;
}
