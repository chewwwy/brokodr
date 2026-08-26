/**
 * Bro.Kodr — canvas metering and analysis.
 *
 * None of this goes through React state. The engine's meter block is polled inside a
 * rAF loop and drawn straight to canvas; re-rendering the component tree 60 times a
 * second would stall the main thread and eventually cost audio callbacks.
 */

import { useCallback, useRef } from "react";
import { useAnimationLoop, useCanvas, useEngine } from "../hooks/use-engine";
import { Oscilloscope } from "./oscilloscope";
import { VuMeter } from "./vu-meter";

const MIN_DB = -60;

function dbFromLinear(x: number): number {
  return x > 1e-7 ? 20 * Math.log10(x) : -Infinity;
}

/** Map dBFS onto 0..1 of meter height, with a stretched top end like a real PPM. */
function dbToPos(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const clamped = Math.max(MIN_DB, Math.min(6, db));
  return (clamped - MIN_DB) / (6 - MIN_DB);
}

function segmentColor(db: number): string {
  if (db >= -0.1) return "#ff3b30";
  if (db >= -3) return "#ff6b2c";
  if (db >= -12) return "#ffb020";
  return "#4ade80";
}

/* ------------------------------------------------------------------ level meter */

export interface LevelMeterProps {
  /** Reads current [peakL, peakR, rmsL, rmsR] linear values. */
  read: () => [number, number, number, number];
  /** Reads the latched clip state. */
  clipped: () => boolean;
  onResetClip?: () => void;
  height?: number;
  width?: number;
  label?: string;
  horizontal?: boolean;
}

/**
 * Two-channel segmented meter with peak hold. Peak hold decays at 12dB/s (broadcast
 * convention) so you can read a transient that's already gone; clip latches until reset.
 */
export function LevelMeter({
  read,
  clipped,
  onResetClip,
  height = 150,
  width = 26,
  label,
  horizontal = false,
}: LevelMeterProps) {
  const hold = useRef([{ db: -Infinity, t: 0 }, { db: -Infinity, t: 0 }]);
  const smooth = useRef([0, 0]);

  const canvasRef = useCanvas((ctx, w, h) => {
    const [pl, pr, rl, rr] = read();
    ctx.clearRect(0, 0, w, h);

    const now = performance.now();
    const peaks = [pl, pr];
    const rms = [rl, rr];

    const barLen = horizontal ? w : h;
    const barThick = horizontal ? (h - 3) / 2 : (w - 3) / 2;

    for (let ch = 0; ch < 2; ch++) {
      const x0 = horizontal ? 0 : ch * (barThick + 3);
      const y0 = horizontal ? ch * (barThick + 3) : 0;

      // well
      ctx.fillStyle = "#0b0d10";
      if (horizontal) ctx.fillRect(x0, y0, barLen, barThick);
      else ctx.fillRect(x0, y0, barThick, barLen);

      // RMS bar: ballistics smoothed so it reads as loudness, not as samples.
      const rdb = dbFromLinear(rms[ch]);
      const target = dbToPos(rdb);
      smooth.current[ch] += (target - smooth.current[ch]) * (target > smooth.current[ch] ? 0.45 : 0.12);
      const rmsLen = smooth.current[ch] * barLen;

      // Segmented fill: 2px lit, 1px gap. Colour comes from the dB at each segment,
      // so the green/amber/red boundaries are absolute, not relative to the peak.
      const SEG = 3;
      for (let p = 0; p < rmsLen; p += SEG) {
        const segDb = MIN_DB + (p / barLen) * (6 - MIN_DB);
        ctx.fillStyle = segmentColor(segDb);
        if (horizontal) ctx.fillRect(x0 + p, y0 + 1, SEG - 1, barThick - 2);
        else ctx.fillRect(x0 + 1, y0 + barLen - p - SEG, barThick - 2, SEG - 1);
      }

      // instantaneous peak, thin bright line
      const pdb = dbFromLinear(peaks[ch]);
      if (Number.isFinite(pdb) && pdb > MIN_DB) {
        const pp = dbToPos(pdb) * barLen;
        ctx.fillStyle = segmentColor(pdb);
        ctx.globalAlpha = 0.5;
        if (horizontal) ctx.fillRect(x0, y0 + 1, pp, barThick - 2);
        else ctx.fillRect(x0 + 1, y0 + barLen - pp, barThick - 2, pp);
        ctx.globalAlpha = 1;
      }

      // peak hold tick, decaying 12dB/s
      const hd = hold.current[ch];
      if (pdb > hd.db || now - hd.t > 900) {
        if (pdb > hd.db) {
          hd.db = pdb;
          hd.t = now;
        } else {
          hd.db -= (12 * (now - hd.t)) / 1000;
          hd.t = now;
        }
      }
      if (Number.isFinite(hd.db) && hd.db > MIN_DB) {
        const hp = dbToPos(hd.db) * barLen;
        ctx.fillStyle = segmentColor(hd.db);
        if (horizontal) ctx.fillRect(x0 + hp - 1, y0, 2, barThick);
        else ctx.fillRect(x0, y0 + barLen - hp - 1, barThick, 2);
      }
    }

    // scale ticks at -3, -6, -12, -24, -48
    ctx.fillStyle = "#2a2e34";
    for (const db of [-3, -6, -12, -24, -48]) {
      const p = dbToPos(db) * barLen;
      if (horizontal) ctx.fillRect(p, 0, 1, h);
      else ctx.fillRect(0, barLen - p, w, 1);
    }
  });

  return (
    <div className="flex flex-col items-center gap-[3px]">
      <button
        className="vk-led"
        data-on={clipped()}
        data-tone="red"
        style={{ border: "none", padding: 0, cursor: "pointer" }}
        onClick={onResetClip}
        title="Clip indicator — click to reset"
      />
      <canvas ref={canvasRef} style={{ width: horizontal ? "100%" : width, height, display: "block" }} />
      {label && <div className="vk-label">{label}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ gain reduction */

/** Downward-reading GR meter. Feed it dB of reduction as a positive number. */
export function GrMeter({ read, width = 60, height = 8 }: { read: () => number; width?: number; height?: number }) {
  const canvasRef = useCanvas((ctx, w, h) => {
    const gr = Math.max(0, Math.min(24, read()));
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, w, h);
    const len = (gr / 24) * w;
    // reads right-to-left: reduction eats into the signal
    for (let p = 0; p < len; p += 3) {
      ctx.fillStyle = p / w > 0.6 ? "#ff3b30" : "#ffb020";
      ctx.fillRect(w - p - 2, 1, 2, h - 2);
    }
    ctx.fillStyle = "#2a2e34";
    for (let i = 1; i < 4; i++) ctx.fillRect((i / 4) * w, 0, 1, h);
  });
  return <canvas ref={canvasRef} style={{ width, height, display: "block" }} />;
}

/* ------------------------------------------------------------------ scope */

/**
 * Waveform + log-frequency spectrum, drawn over the same canvas. Input is dimmed cyan,
 * output is amber, so you can see exactly what the chain is doing to the signal.
 */
function SpectrumStrip() {
  const client = useEngine();
  const spectrum = useRef<Float32Array | null>(null);
  const peaks = useRef<Float32Array | null>(null);

  const canvasRef = useCanvas((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, w, h);

    const showWave = true;
    const showSpec = true;
    const waveH = h * 0.45;
    const specY = h * 0.45;
    const specH = h * 0.55;

    if (showWave) {
      const got = client.pollScope(1024);
      const mid = waveH / 2;

      ctx.strokeStyle = "#2a2e34";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();

      if (got) {
        const draw = (buf: Float32Array, color: string, alpha: number) => {
          ctx.strokeStyle = color;
          ctx.globalAlpha = alpha;
          ctx.lineWidth = 1;
          ctx.beginPath();
          const n = buf.length;
          for (let x = 0; x < w; x++) {
            const i = Math.floor((x / w) * n);
            const y = mid - Math.max(-1.5, Math.min(1.5, buf[i])) * (mid - 2);
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.stroke();
          ctx.globalAlpha = 1;
        };
        draw(client.scope.input, "#35d6d0", 0.45);
        draw(client.scope.output, "#ffb020", 0.95);
      } else {
        ctx.fillStyle = "#3a4048";
        ctx.font = "10px 'JetBrains Mono', monospace";
        ctx.fillText("engine idle", 8, mid - 4);
      }
    }

    if (showSpec) {
      const bins = client.spectrumBins();
      if (bins > 0) {
        if (!spectrum.current || spectrum.current.length !== bins) {
          spectrum.current = new Float32Array(bins);
          peaks.current = new Float32Array(bins).fill(-140);
        }
        const buf = spectrum.current;
        const pk = peaks.current!;
        if (client.readSpectrum(buf)) {
          const sr = client.sampleRate();
          const nyquist = sr / 2;
          const fMin = 20;
          const logMin = Math.log10(fMin);
          const logMax = Math.log10(nyquist);

          // grid
          ctx.strokeStyle = "#1c2026";
          ctx.fillStyle = "#3a4048";
          ctx.font = "8px 'JetBrains Mono', monospace";
          for (const f of [100, 1000, 10000]) {
            const x = ((Math.log10(f) - logMin) / (logMax - logMin)) * w;
            ctx.beginPath();
            ctx.moveTo(x, specY);
            ctx.lineTo(x, specY + specH);
            ctx.stroke();
            ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, specY + specH - 2);
          }

          ctx.beginPath();
          ctx.moveTo(0, specY + specH);
          for (let x = 0; x < w; x++) {
            const f = Math.pow(10, logMin + (x / w) * (logMax - logMin));
            const bin = Math.min(bins - 1, Math.round((f / nyquist) * (bins - 1)));
            const db = Math.max(-100, buf[bin]);
            if (db > pk[bin]) pk[bin] = db;
            else pk[bin] -= 0.6;
            const y = specY + specH - ((db + 100) / 100) * specH;
            ctx.lineTo(x, y);
          }
          ctx.lineTo(w, specY + specH);
          ctx.closePath();
          ctx.fillStyle = "rgba(255,176,32,0.22)";
          ctx.fill();
          ctx.strokeStyle = "#ffb020";
          ctx.lineWidth = 1;
          ctx.stroke();

          // slow-falling peak trace
          ctx.beginPath();
          for (let x = 0; x < w; x++) {
            const f = Math.pow(10, logMin + (x / w) * (logMax - logMin));
            const bin = Math.min(bins - 1, Math.round((f / nyquist) * (bins - 1)));
            const y = specY + specH - ((Math.max(-100, pk[bin]) + 100) / 100) * specH;
            if (x === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = "rgba(53,214,208,0.55)";
          ctx.stroke();
        }
      }
    }
  });

  return <canvas ref={canvasRef} className="block h-full w-full" />;
}

/**
 * The analyser pane. Two views of the same signal:
 *
 * - "vu"       — the stereo pair of analogue VU meters (loudness, ballistics) beside a
 *                triggered oscilloscope (shape, phase). This is the default: it is what
 *                the front panel of the hardware this thing imitates would actually show.
 * - "spectrum" — the original waveform + log-frequency spectrum canvas, kept because it
 *                is the view you want when you are hunting a resonance rather than
 *                setting a level.
 */
export function ScopeStrip({ mode }: { mode: "vu" | "spectrum" }) {
  const client = useEngine();

  const readL = useCallback(() => client.meters.rmsOutL, [client]);
  const readR = useCallback(() => client.meters.rmsOutR, [client]);
  const peak = useCallback(() => client.meters.clipOut, [client]);

  if (mode === "spectrum") return <SpectrumStrip />;

  return (
    <div className="flex h-full min-w-0 items-stretch gap-2">
      <VuMeter read={readL} channel="L" peak={peak} width={152} height={108} />
      <div className="min-w-0 flex-1 overflow-hidden" style={{ borderRadius: 2 }}>
        <Oscilloscope />
      </div>
      <VuMeter read={readR} channel="R" peak={peak} width={152} height={108} />
    </div>
  );
}

/* ------------------------------------------------------------------ waveform (static) */

export function StaticWaveform({ peaks, width, height }: { peaks: Float32Array; width?: number; height: number }) {
  const canvasRef = useCanvas((ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, w, h);
    const mid = h / 2;
    ctx.strokeStyle = "#2a2e34";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    if (!peaks.length) return;
    ctx.fillStyle = "#ff3b30";
    for (let x = 0; x < w; x++) {
      const v = peaks[Math.floor((x / w) * peaks.length)] || 0;
      const half = Math.max(0.5, v * (mid - 1));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  }, false);

  // Static content: draw once per peaks change rather than on rAF.
  const drawnRef = useRef<Float32Array | null>(null);
  useAnimationLoop(() => {
    if (drawnRef.current === peaks) return;
    drawnRef.current = peaks;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = rect.width;
    const h = rect.height;
    ctx.fillStyle = "#0b0d10";
    ctx.fillRect(0, 0, w, h);
    const mid = h / 2;
    ctx.strokeStyle = "#2a2e34";
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.fillStyle = "#ff3b30";
    for (let x = 0; x < w; x++) {
      const v = peaks[Math.floor((x / w) * peaks.length)] || 0;
      const half = Math.max(0.5, v * (mid - 1));
      ctx.fillRect(x, mid - half, 1, half * 2);
    }
  });

  return <canvas ref={canvasRef} style={{ width: width ?? "100%", height, display: "block" }} />;
}
