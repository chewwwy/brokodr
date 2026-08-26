/**
 * Bro.Kodr — analogue VU meters.
 *
 * A real VU meter is not a fast peak meter with a needle drawn on it: it is defined by
 * its ballistics. The standard specifies that a step to 0 VU drives the needle to 99% in
 * 300ms with a slight overshoot, and it falls at the same rate. That integration is the
 * whole reason a VU reads as loudness while the segmented PPM next to it reads as
 * samples, so it is modelled here as a critically-damped spring rather than the one-pole
 * smoother used everywhere else in the UI.
 *
 * Drawn on canvas inside a rAF loop, never through React state — same rule as the rest of
 * the metering. Gradients and strokes only, no filters.
 */

import { useRef } from "react";
import { useCanvas } from "../hooks/use-engine";

/** 0 VU is aligned to -18 dBFS, the usual digital reference for this kind of meter. */
const VU_REF_DBFS = -18;

/**
 * A real VU face is not linear in dB. These are the measured positions of each printed
 * graduation as a fraction of the needle's travel, taken off the reference meter — the
 * numbers crowd toward 0 and the red overrun zone is stretched wide.
 */
const SCALE: Array<{ db: number; label: string; frac: number; major: boolean }> = [
  { db: -20, label: "20", frac: 0.0, major: true },
  { db: -10, label: "10", frac: 0.22, major: true },
  { db: -7, label: "7", frac: 0.32, major: true },
  { db: -5, label: "5", frac: 0.4, major: true },
  { db: -3, label: "3", frac: 0.5, major: true },
  { db: -2, label: "2", frac: 0.56, major: true },
  { db: -1, label: "1", frac: 0.62, major: true },
  { db: 0, label: "0", frac: 0.7, major: true },
  { db: 1, label: "+1", frac: 0.79, major: true },
  { db: 3, label: "+3", frac: 1.0, major: true },
];

/** Piecewise-linear interpolation of the printed scale. */
function dbToFrac(db: number): number {
  if (db <= SCALE[0].db) return 0;
  const last = SCALE[SCALE.length - 1];
  if (db >= last.db) return 1;
  for (let i = 0; i < SCALE.length - 1; i++) {
    const a = SCALE[i];
    const b = SCALE[i + 1];
    if (db >= a.db && db <= b.db) {
      const t = (db - a.db) / (b.db - a.db);
      return a.frac + t * (b.frac - a.frac);
    }
  }
  return 1;
}

export interface VuMeterProps {
  /** Reads the channel's linear RMS level. */
  read: () => number;
  /** Channel legend, e.g. "L". */
  channel?: string;
  /** Lights the PEAK lamp — latched clip state from the engine. */
  peak?: () => boolean;
  width?: number;
  height?: number;
}

/**
 * Rectangular cream-faced VU meter with a hairline needle, per the reference kit:
 * black-on-white graduations, a red overrun zone past 0, VU METER bottom-left and a
 * PEAK lamp bottom-right.
 */
export function VuMeter({ read, channel, peak, width = 150, height = 92 }: VuMeterProps) {
  // Needle state: position in 0..1 of travel plus velocity, integrated as a spring.
  const pos = useRef(0);
  const vel = useRef(0);
  const last = useRef(0);

  const canvasRef = useCanvas((ctx, w, h) => {
    const now = performance.now();
    const dt = Math.min(0.05, last.current ? (now - last.current) / 1000 : 0.016);
    last.current = now;

    // ---- ballistics
    const lin = read();
    const db = lin > 1e-7 ? 20 * Math.log10(lin) - VU_REF_DBFS : -60;
    const target = dbToFrac(db);
    // Critically damped at ~300ms to 99%: omega chosen so the needle settles in that
    // window, with just enough underdamping to overshoot slightly like the real thing.
    const omega = 22;
    const zeta = 0.72;
    const accel = omega * omega * (target - pos.current) - 2 * zeta * omega * vel.current;
    vel.current += accel * dt;
    pos.current += vel.current * dt;
    if (pos.current < 0) {
      pos.current = 0;
      vel.current = 0;
    }
    if (pos.current > 1.08) {
      pos.current = 1.08;
      vel.current = 0;
    }

    ctx.clearRect(0, 0, w, h);

    // ---- dark bezel surround
    const bez = ctx.createLinearGradient(0, 0, 0, h);
    bez.addColorStop(0, "#3a4043");
    bez.addColorStop(0.5, "#1b1f21");
    bez.addColorStop(1, "#2a2f32");
    ctx.fillStyle = bez;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(0,0,0,0.9)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    // ---- cream face
    const pad = 5;
    // A footer band is reserved below the face for the VU METER / PEAK legends. Without it
    // the face ran to within 5px of the bottom edge and the legends were drawn over the
    // bezel sliver, where they read as clipped.
    const foot = 11;
    const fw = w - pad * 2;
    const fh = h - pad * 2 - foot;
    const face = ctx.createLinearGradient(0, pad, 0, pad + fh);
    face.addColorStop(0, "#fdfaf1");
    face.addColorStop(0.62, "#f2ecdc");
    face.addColorStop(1, "#ded6c2");
    ctx.fillStyle = face;
    ctx.fillRect(pad, pad, fw, fh);
    // Vignette: the card is lit from the top of the window, so the lower corners fall away.
    // A flat cream rectangle is what made the meter read as a drawing rather than a part.
    const vig = ctx.createRadialGradient(pad + fw / 2, pad + fh * 0.18, fh * 0.15, pad + fw / 2, pad + fh * 0.2, fh * 1.5);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(60,48,26,0.20)");
    ctx.fillStyle = vig;
    ctx.fillRect(pad, pad, fw, fh);
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.strokeRect(pad + 0.5, pad + 0.5, fw - 1, fh - 1);

    // ---- needle pivot sits below the face; the scale is an arc about it
    const px = pad + fw / 2;
    const py = pad + fh * 1.06;
    const radius = fh * 0.86;
    // Travel is a touch wider than the classic 60 degrees so the remaining numerals have
    // room to breathe at panel size.
    const A0 = -Math.PI / 2 - 0.68; // left end of travel
    const A1 = -Math.PI / 2 + 0.68; // right end
    const angleAt = (frac: number) => A0 + (A1 - A0) * frac;

    const zeroFrac = dbToFrac(0);

    // ---- graduation arc: black up to 0, red beyond
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = "#23201c";
    ctx.beginPath();
    ctx.arc(px, py, radius, angleAt(0), angleAt(zeroFrac));
    ctx.stroke();
    ctx.strokeStyle = "#c0261f";
    ctx.beginPath();
    ctx.arc(px, py, radius, angleAt(zeroFrac), angleAt(1));
    ctx.stroke();

    // Wide red overrun band inboard of the graduation arc - the printed danger zone. This
    // is the single biggest thing the plain version was missing: on a real face the red is
    // an area, not just a differently coloured line.
    ctx.strokeStyle = "rgba(192,38,31,0.16)";
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(px, py, radius - 5.5, angleAt(zeroFrac), angleAt(1));
    ctx.stroke();
    ctx.lineWidth = 1.4;

    // ---- ticks + numerals
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    for (const m of SCALE) {
      const a = angleAt(m.frac);
      const red = m.db > 0;
      const inner = radius - (m.major ? 6 : 4);
      ctx.strokeStyle = red ? "#c0261f" : "#23201c";
      ctx.lineWidth = m.major ? 1.3 : 0.9;
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(a) * inner, py + Math.sin(a) * inner);
      ctx.lineTo(px + Math.cos(a) * radius, py + Math.sin(a) * radius);
      ctx.stroke();

      // Numerals sit inboard of the arc. Font is deliberately small: the printed scale
      // crowds hard between 3 and 0, and at panel size a larger face made 2/1/0 touch.
      const lr = radius - 12;
      // On a narrow face the printed scale cannot carry every numeral: 10/7/5 and 3/2/1/0
      // collide. Real small-format meters thin the numbering rather than shrink the type,
      // so the intermediate graduations keep their ticks and lose their digits.
      const crowded = fw < 170 && (m.db === -7 || m.db === -2 || m.db === -1 || m.db === 1);
      if (!crowded) {
        ctx.fillStyle = red ? "#c0261f" : "#23201c";
        ctx.font = `600 ${Math.max(6, Math.round(fh * 0.115))}px 'Chakra Petch', sans-serif`;
        ctx.fillText(m.label, px + Math.cos(a) * lr, py + Math.sin(a) * lr + 3);
      }
    }

    // minor ticks between the printed numbers, as on the real face
    ctx.strokeStyle = "rgba(35,32,28,0.55)";
    ctx.lineWidth = 0.6;
    for (let i = 0; i < SCALE.length - 1; i++) {
      const a0 = SCALE[i];
      const a1 = SCALE[i + 1];
      const mid = (a0.frac + a1.frac) / 2;
      const a = angleAt(mid);
      ctx.strokeStyle = a1.db > 0 ? "rgba(192,38,31,0.6)" : "rgba(35,32,28,0.55)";
      ctx.beginPath();
      ctx.moveTo(px + Math.cos(a) * (radius - 3), py + Math.sin(a) * (radius - 3));
      ctx.lineTo(px + Math.cos(a) * radius, py + Math.sin(a) * radius);
      ctx.stroke();
    }

    // ---- "VU" nameplate, boxed, low on the face.
    // It used to sit at 46% of the face height dead centre, which is exactly where the
    // graduation numerals arc through - the two collided. The clear space on a VU face is
    // the wedge below the scale and above the pivot cowl, so it goes there, boxed like the
    // printed nameplate on the reference meter, with a maker mark beside it.
    const nameY = pad + fh * 0.87;
    ctx.font = `700 ${Math.max(7, Math.round(fh * 0.13))}px 'Chakra Petch', sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const nameW = Math.max(18, fh * 0.28);
    const nameH = Math.max(10, fh * 0.16);
    const nameX = pad + fw * 0.19;
    ctx.strokeStyle = "rgba(35,32,28,0.55)";
    ctx.lineWidth = 0.8;
    ctx.strokeRect(nameX - nameW / 2, nameY - nameH / 2, nameW, nameH);
    ctx.fillStyle = "#23201c";
    ctx.fillText("VU", nameX, nameY + 0.5);
    // Maker mark in the opposite corner, balancing the nameplate.
    ctx.font = `600 ${Math.max(5, Math.round(fh * 0.085))}px 'Chakra Petch', sans-serif`;
    ctx.fillStyle = "rgba(35,32,28,0.5)";
    ctx.fillText("BRO.KODR", pad + fw * 0.79, nameY + 0.5);
    ctx.textBaseline = "alphabetic";

    // ---- needle
    const na = angleAt(Math.min(1.06, pos.current));
    const tipR = radius - 2;
    // Cast shadow first, offset down-right, so the needle floats above the card. Drawn as a
    // second stroke rather than a filter - filters force an offscreen pass every frame.
    ctx.strokeStyle = "rgba(70,58,36,0.30)";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(px + Math.cos(na) * (fh * 0.1) + 1.5, py + Math.sin(na) * (fh * 0.1) + 1.5);
    ctx.lineTo(px + Math.cos(na) * tipR + 1.5, py + Math.sin(na) * tipR + 1.5);
    ctx.stroke();
    // The needle itself tapers: heavier at the root, hairline at the tip.
    ctx.strokeStyle = "#16130f";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px + Math.cos(na) * (fh * 0.1), py + Math.sin(na) * (fh * 0.1));
    ctx.lineTo(px + Math.cos(na) * (tipR * 0.62), py + Math.sin(na) * (tipR * 0.62));
    ctx.stroke();
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.moveTo(px + Math.cos(na) * (tipR * 0.62), py + Math.sin(na) * (tipR * 0.62));
    ctx.lineTo(px + Math.cos(na) * tipR, py + Math.sin(na) * tipR);
    ctx.stroke();

    // pivot shroud — the little black cowl the needle disappears into
    ctx.fillStyle = "#1a1714";
    ctx.beginPath();
    ctx.arc(px, py, Math.max(5, fh * 0.11), Math.PI, 0);
    ctx.fill();

    // ---- glass. A single soft diagonal reflection across the upper-left of the window,
    // clipped to the face so it does not wash the bezel. This is what sells the meter as
    // being behind something rather than printed on the panel.
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad, pad, fw, fh);
    ctx.clip();
    const gl = ctx.createLinearGradient(pad, pad, pad + fw * 0.75, pad + fh);
    gl.addColorStop(0, "rgba(255,255,255,0.42)");
    gl.addColorStop(0.42, "rgba(255,255,255,0.07)");
    gl.addColorStop(0.55, "rgba(255,255,255,0)");
    ctx.fillStyle = gl;
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad + fw, pad);
    ctx.lineTo(pad, pad + fh);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // Inner lip: the face sits recessed behind the bezel opening.
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + 0.5, pad + 0.5, fw - 1, fh - 1);
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.strokeRect(pad - 0.5, pad - 0.5, fw + 1, fh + 1);

    // ---- legends below the face
    const ly = h - 3;
    ctx.textAlign = "left";
    ctx.fillStyle = "#aab1b5";
    ctx.font = `600 ${Math.max(6, Math.round(fh * 0.1))}px 'Chakra Petch', sans-serif`;
    ctx.fillText(channel ? `VU METER ${channel}` : "VU METER", pad + 2, ly);

    const lit = peak ? peak() : false;
    ctx.textAlign = "right";
    ctx.fillStyle = lit ? "#ff5a4f" : "#7b8286";
    ctx.fillText("PEAK", w - pad - 10, ly);
    // peak lamp
    ctx.beginPath();
    ctx.arc(w - pad - 4, ly - 3, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = lit ? "#ff3b30" : "#3a2422";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 0.8;
    ctx.stroke();
  });

  return <canvas ref={canvasRef} style={{ width, height, display: "block" }} />;
}

/**
 * The L/R pair, wired to the engine's output RMS. Kept next to the meter itself so the
 * channel pairing and the shared clip lamp live in one place.
 */
export function VuPair({
  readL,
  readR,
  peak,
  width = 150,
  height = 92,
}: {
  readL: () => number;
  readR: () => number;
  peak?: () => boolean;
  width?: number;
  height?: number;
}) {
  return (
    <div className="flex items-stretch gap-[6px]">
      <VuMeter read={readL} channel="L" peak={peak} width={width} height={height} />
      <VuMeter read={readR} channel="R" peak={peak} width={width} height={height} />
    </div>
  );
}
