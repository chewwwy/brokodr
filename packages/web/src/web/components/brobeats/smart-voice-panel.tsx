/**
 * Bro.Kodr — Smart Voice panel.
 *
 * The BROBEATS VOICE tab: the master switch, the detector's controls, where each class
 * fires, and a live readout of what it is hearing. Calibration is its own component
 * below the controls.
 *
 * Same division of labour as every other panel in the app:
 *
 *  - **Settings come from `useEngineState()`.** The whole profile lives in the kit
 *    document, so a calibration and the sensitivity it was tuned at follow the kit
 *    rather than sitting in a global preference.
 *  - **Measurements come from `client.meters.voice` inside a rAF loop**, written straight
 *    to the DOM. The level, the band bars and the last-hit readout move at audio rate;
 *    none of them may become a React render.
 *
 * The readouts are not decoration. The three numbers at the bottom — onsets, hits and
 * corrections — are how a user diagnoses the two failures this thing actually has:
 * onsets climbing with no hits means the gate is letting noise through below the velocity
 * floor, and corrections climbing means FAST is committing early and being wrong, which
 * is the entire argument for ACCURATE.
 */

import { useRef } from "react";
import {
  PAD_COUNT,
  VOICE_CLASS_COUNT,
  VOICE_CLASS_NAMES,
  VOICE_DEFAULTS,
  VOICE_RANGE,
} from "../../audio/backend";
import type { VoiceKey } from "../../audio/backend";
import type { ParamDef } from "../../audio/param-schema";
import { useAnimationLoop, useEngine, useEngineState } from "../../hooks/use-engine";
import { Toggle } from "../controls";
import { Calibrate } from "./calibrate";
import { DefGrid } from "./def-grid";

/**
 * The detector's controls as param defs, so they render through the same `DefGrid` as a
 * pad's voice and a lane's effects. Ranges and defaults are read from `backend.ts` rather
 * than restated — that table is the one the client clamps against.
 *
 * `enabled` is deliberately absent: it is the panel's master switch, not a knob in a
 * grid. `mode` and `monitor` are here because they belong next to what they affect.
 */
const VOICE_DEFS: ParamDef[] = [
  {
    key: "sensitivity",
    label: "Sens",
    kind: "knob",
    ...range("sensitivity"),
    decimals: 2,
    group: "TRIGGER",
  },
  { key: "floorDb", label: "Gate", kind: "knob", ...range("floorDb"), unit: "dB", decimals: 0, group: "TRIGGER" },
  { key: "minGapMs", label: "Hold", kind: "knob", ...range("minGapMs"), unit: "ms", decimals: 0, group: "TRIGGER" },
  {
    key: "mode",
    label: "Decide",
    kind: "select",
    ...range("mode"),
    options: ["FAST", "ACCURATE"],
    group: "DECISION",
  },
  { key: "featureMs", label: "Window", kind: "knob", ...range("featureMs"), unit: "ms", decimals: 1, group: "DECISION" },
  { key: "margin", label: "Margin", kind: "knob", ...range("margin"), decimals: 2, group: "DECISION" },
  { key: "velMin", label: "Vel Min", kind: "knob", ...range("velMin"), decimals: 2, group: "VELOCITY" },
  { key: "velDb", label: "Vel Range", kind: "knob", ...range("velDb"), unit: "dB", decimals: 0, group: "VELOCITY" },
];

function range(key: VoiceKey): { min: number; max: number; def: number; step?: number } {
  const r = VOICE_RANGE[key];
  const out: { min: number; max: number; def: number; step?: number } = {
    min: r.min,
    max: r.max,
    def: VOICE_DEFAULTS[key],
  };
  if (r.step >= 1) out.step = r.step;
  return out;
}

const PARAM_HINT: Record<string, string> = {
  sensitivity: "How far above the running average an envelope spike has to jump to count as a hit. Lower catches more and false-triggers more.",
  floorDb: "Anything quieter than this is not a hit. The single most useful control against a noisy room or singing over the top.",
  minGapMs: "Minimum gap between hits. Raise it if one hit reads as two; lower it for fast rolls.",
  mode: "FAST commits on the band decision at ~3ms when it is confident. ACCURATE always waits for the full feature window — later, but it never corrects itself.",
  featureMs: "How long after the onset the full decision is made. Longer is more reliable and more audibly late.",
  margin: "How much better the best class has to be than the runner-up before FAST commits early.",
  velMin: "Velocity a hit at the gate fires at. Never zero — a hit you cannot hear reads as a missed hit.",
  velDb: "Loudness range mapped across the velocity curve. Narrow feels compressed, wide feels dynamic.",
};

/* --------------------------------------------------------------- live readout */

/**
 * What the detector is hearing, right now. Everything in here is a meter read written to
 * the DOM by one rAF loop.
 */
function VoiceScope() {
  const client = useEngine();
  const { status } = useEngineState();

  const levelRef = useRef<HTMLDivElement | null>(null);
  const classRef = useRef<HTMLSpanElement | null>(null);
  const confRef = useRef<HTMLSpanElement | null>(null);
  const velRef = useRef<HTMLSpanElement | null>(null);
  const stageRef = useRef<HTMLSpanElement | null>(null);
  const bandRefs = useRef<(HTMLDivElement | null)[]>([]);
  const hitsRef = useRef<HTMLSpanElement | null>(null);
  const onsetRef = useRef<HTMLSpanElement | null>(null);
  const corrRef = useRef<HTMLSpanElement | null>(null);
  const capRef = useRef<HTMLSpanElement | null>(null);

  useAnimationLoop(() => {
    const m = client.meters.voice;
    if (levelRef.current) levelRef.current.style.width = `${(Math.min(1, m.level * 3) * 100).toFixed(1)}%`;
    if (classRef.current) {
      classRef.current.textContent = m.lastClass >= 0 ? (VOICE_CLASS_NAMES[m.lastClass] ?? "?").toUpperCase() : "—";
    }
    if (confRef.current) confRef.current.textContent = m.lastClass >= 0 ? `${(m.lastConf * 100).toFixed(0)}%` : "—";
    if (velRef.current) velRef.current.textContent = m.lastClass >= 0 ? m.lastVel.toFixed(2) : "—";
    if (stageRef.current) stageRef.current.textContent = m.lastStage === 1 ? "FAST" : m.lastStage === 2 ? "FULL" : "—";
    for (let b = 0; b < 3; b++) {
      const el = bandRefs.current[b];
      if (el) el.style.height = `${(Math.min(1, (m.band[b] ?? 0) * 2.2) * 100).toFixed(1)}%`;
    }
    if (hitsRef.current) hitsRef.current.textContent = String(m.hits);
    if (onsetRef.current) onsetRef.current.textContent = String(m.onsets);
    if (corrRef.current) corrRef.current.textContent = String(m.corrections);
    if (capRef.current) {
      capRef.current.textContent =
        m.captureClass >= 0
          ? `CAPTURING ${(VOICE_CLASS_NAMES[m.captureClass] ?? "?").toUpperCase()} · ${m.captureCount}`
          : "";
    }
  }, status === "running");

  return (
    <div className="vk-well flex flex-col gap-2 p-2">
      <div className="flex items-baseline justify-between">
        <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
          LISTENING
        </span>
        <span className="vk-label vk-mono" ref={capRef} style={{ color: "var(--vk-amber)" }} />
      </div>

      <div className="flex items-stretch gap-2">
        {/* attack bands of the last onset */}
        <div
          className="flex items-end gap-[3px]"
          style={{ height: 44 }}
          title="Low, mid and high energy in the attack of the last hit — the three numbers the early decision is made from"
        >
          {["L", "M", "H"].map((n, b) => (
            <div key={n} className="flex flex-col items-center gap-[2px]">
              <div
                style={{
                  width: 12,
                  height: 34,
                  background: "var(--vk-void)",
                  borderRadius: 2,
                  display: "flex",
                  alignItems: "flex-end",
                  overflow: "hidden",
                }}
              >
                <div
                  ref={(el) => {
                    bandRefs.current[b] = el;
                  }}
                  style={{ width: "100%", height: "0%", background: "var(--vk-amber)" }}
                />
              </div>
              <span className="vk-label" style={{ color: "var(--vk-text-dim)", fontSize: 8 }}>
                {n}
              </span>
            </div>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center gap-[6px]">
          <div className="flex items-baseline gap-2">
            <span className="vk-mono text-[15px]" style={{ color: "var(--vk-amber)", minWidth: 52 }} ref={classRef}>
              —
            </span>
            <span className="vk-label vk-mono" style={{ color: "var(--vk-text-mid)" }}>
              CONF <span ref={confRef}>—</span>
            </span>
            <span className="vk-label vk-mono" style={{ color: "var(--vk-text-mid)" }}>
              VEL <span ref={velRef}>—</span>
            </span>
            <span
              className="vk-label vk-mono"
              style={{ color: "var(--vk-text-dim)" }}
              title="FAST = committed on the bands at ~3ms. FULL = waited for the whole feature window."
            >
              <span ref={stageRef}>—</span>
            </span>
          </div>
          <div style={{ height: 6, background: "var(--vk-void)", borderRadius: 2 }}>
            <div
              ref={levelRef}
              style={{ width: "0%", height: "100%", background: "var(--vk-green, #36d07a)", borderRadius: 2 }}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <span className="vk-label vk-mono" style={{ color: "var(--vk-text-mid)" }} title="Hits fired since the last detector reset">
          HITS <span ref={hitsRef}>0</span>
        </span>
        <span
          className="vk-label vk-mono"
          style={{ color: "var(--vk-text-mid)" }}
          title="Onsets the detector found. Climbing with HITS flat means the gate or velocity floor is eating them."
        >
          ONSETS <span ref={onsetRef}>0</span>
        </span>
        <span
          className="vk-label vk-mono"
          style={{ color: "var(--vk-text-mid)" }}
          title="Early FAST decisions the full decision later disagreed with. If this climbs, try ACCURATE."
        >
          CORRECTIONS <span ref={corrRef}>0</span>
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- routing */

/** Class -> pad, with the pad's own name so the choice is readable. */
function ClassRouting() {
  const client = useEngine();
  const { kit, status } = useEngineState();
  const ledRefs = useRef<(HTMLSpanElement | null)[]>([]);

  // The LED lights the class that last fired. Read from meters, not from a click — the
  // point is to show what the *mouth* triggered.
  useAnimationLoop(() => {
    const m = client.meters.voice;
    for (let c = 0; c < VOICE_CLASS_COUNT; c++) {
      const el = ledRefs.current[c];
      if (el) el.dataset.on = m.lastClass === c ? "true" : "false";
    }
  }, status === "running");

  return (
    <div className="flex flex-col gap-[3px]">
      <div
        className="vk-label"
        style={{ color: "var(--vk-text-dim)", borderBottom: "1px solid var(--vk-line)", paddingBottom: 2 }}
      >
        ROUTING
      </div>
      {Array.from({ length: VOICE_CLASS_COUNT }, (_, c) => {
        const pad = kit.voice.classPads[c] ?? -1;
        return (
          <div key={c} className="flex items-center gap-2">
            <span
              className="vk-led"
              ref={(el) => {
                ledRefs.current[c] = el;
              }}
              data-on="false"
            />
            <span className="vk-label" style={{ width: 40, color: "var(--vk-text)" }}>
              {(VOICE_CLASS_NAMES[c] ?? "?").toUpperCase()}
            </span>
            <select
              className="vk-select min-w-0 flex-1"
              value={String(pad)}
              onChange={(e) => client.setVoiceClassPad(c, Number.parseInt(e.target.value, 10))}
              title="Which pad this class fires. MUTE leaves the class detected but silent."
            >
              <option value="-1">— MUTE —</option>
              {Array.from({ length: PAD_COUNT }, (_, i) => (
                <option key={i} value={String(i)}>
                  {i + 1} · {kit.pads[i]?.name ?? `PAD ${i + 1}`}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </div>
  );
}

/* --------------------------------------------------------------------- panel */

export function SmartVoicePanel({ active = true }: { active?: boolean }) {
  const client = useEngine();
  const { kit, status } = useEngineState();
  const voice = kit.voice;
  const enabled = (voice.params.enabled ?? 0) >= 0.5;
  const monitor = (voice.params.monitor ?? 0) >= 0.5;

  return (
    <div className="vk-panel flex flex-col gap-2 p-2">
      <div className="flex items-baseline justify-between">
        <span className="vk-label" style={{ color: "var(--vk-amber)" }}>
          SMART VOICE
        </span>
        <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
          {status === "running" ? "beatbox the kit" : "engine in standby"}
        </span>
      </div>

      <div className="text-[9px]" style={{ color: "var(--vk-text-mid)" }}>
        Listens to the raw microphone — before the rack, before the mute — and fires pads from
        what it hears. It cannot hear the kit it triggers, so it will not run away with itself.
      </div>

      <div className="flex items-center gap-2">
        <div style={{ width: 132 }}>
          <Toggle
            on={enabled}
            onChange={(v) => client.setVoiceEnabled(v)}
            label={enabled ? "DETECTING" : "OFF"}
            tone="green"
            title="Master switch. Off means the detector is not run at all, so it costs nothing."
          />
        </div>
        <div style={{ width: 116 }}>
          <Toggle
            on={monitor}
            onChange={(v) => client.setVoiceParam("monitor", v ? 1 : 0)}
            label="MONITOR"
            title="Keep firing pads while calibrating. Off — the default — records silently, which is what you want in headphones."
          />
        </div>
      </div>

      <VoiceScope />

      <DefGrid
        defs={VOICE_DEFS}
        values={voice.params}
        onChange={(key, value) => client.setVoiceParam(key as VoiceKey, value)}
        size={38}
      />

      <div className="flex flex-col gap-[2px] text-[9px]" style={{ color: "var(--vk-text-dim)" }}>
        {VOICE_DEFS.filter((d) => d.key === "mode" || d.key === "sensitivity" || d.key === "floorDb").map((d) => (
          <div key={d.key}>
            <span style={{ color: "var(--vk-text-mid)" }}>{d.label}</span> — {PARAM_HINT[d.key]}
          </div>
        ))}
      </div>

      <ClassRouting />

      <div className="flex flex-wrap gap-1">
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "3px 8px" }}
          onClick={() => client.resetVoiceParams()}
          title="Every detector control back to factory. Calibration is untouched."
        >
          RESET CONTROLS
        </button>
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "3px 8px" }}
          onClick={() => client.resetVoiceDetector()}
          title="Drop any half-measured hit and zero the counters. Worth a click after changing microphone."
        >
          RESET DETECTOR
        </button>
      </div>

      <Calibrate active={active} />

      <div className="text-[9px]" style={{ color: "var(--vk-text-dim)" }}>
        Known limits, going in honest: rolls past about twelve hits a second blur together,
        throat bass and inward clicks are spectrally strange and will misfire, and a
        simultaneous kick-and-hat can only come out as one of them. Sing over the top with the
        gate low and it will trigger — that is what GATE is for.
      </div>
    </div>
  );
}

export default SmartVoicePanel;
