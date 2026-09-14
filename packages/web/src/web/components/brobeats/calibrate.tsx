/**
 * Bro.Kodr — Smart Voice calibration.
 *
 * Thirty seconds of guided recording that replaces the factory centroid tables with the
 * performer's own mouth. It is the single biggest quality lever in Smart Voice: every
 * beatboxer is spectrally different, and a factory-tuned classifier will always feel
 * slightly wrong on someone else's kick.
 *
 * ## How the flow works
 *
 * One class at a time. The panel arms the detector's capture for that class
 * (`captureVoiceClass`), prompts for eight hits, and counts them off the meter block —
 * `captureCount` is monotonic and absolute, so "hits so far" is the count now minus the
 * count when this class armed. When the take is full the panel disarms, waits out the
 * stage-2 window so the last hit has actually been written, pulls the new rows, and moves
 * to the next class.
 *
 * Three things about that are deliberate:
 *
 *  1. **Rows are pulled after every class, not once at the end.** The capture ring holds
 *     the last 64 hits. Four full takes fit, but an enthusiastic performer plus a retake
 *     does not, and a wrapped ring loses the *oldest* rows — i.e. the kicks — silently.
 *
 *  2. **The class is what the panel asked for, never what the classifier guessed.** That
 *     is the whole point of supervised capture: it is being taught, not tested. The live
 *     readout still shows the guess, because watching it get the wrong answer before
 *     calibration and the right one after is the most convincing thing in the feature.
 *
 *  3. **The pads stay silent while capturing** unless MONITOR is on — the DSP suppresses
 *     firing for captured hits. Calibrating over the top of a kick drum sample triggering
 *     in your headphones is how you end up calibrating the kick drum sample.
 *
 * ## Why undo restores rather than resets
 * `resetVoiceCalibration` puts a class back to *factory*, which is the wrong answer for
 * someone who had a good profile, ran a bad take over it, and wants the old one back. So
 * the panel snapshots the profile before a pass and hands it to `restoreVoiceProfile`.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { VOICE_CLASS_COUNT, VOICE_CLASS_NAMES } from "../../audio/backend";
import type { VoiceCapture } from "../../audio/backend";
import type { VoiceProfile } from "../../audio/kit";
import type { VoiceClassTraining } from "../../audio/voice-train";
import { VOICE_MIN_HITS } from "../../audio/voice-train";
import { useAnimationLoop, useEngine, useEngineState } from "../../hooks/use-engine";

/** Hits asked for per class. Eight is enough to average and short enough to sit through. */
const TARGET_HITS = 8;

/**
 * Pause between the prompt appearing and capture arming. Without it the first "hit" is
 * whatever the room was doing when the button was clicked, which is usually the click.
 */
const READY_MS = 1200;

/**
 * How long to keep listening after the last wanted hit. A hit is written at stage 2, up
 * to `featureMs` after its onset, and the widest that control goes is 30ms — disarming
 * the instant the counter hits eight would throw the eighth hit away.
 */
const SETTLE_MS = 220;

const CLASS_LABEL: Record<number, string> = { 0: "KICKS", 1: "SNARES", 2: "HATS", 3: "CLAPS" };
const CLASS_HINT: Record<number, string> = {
  0: "Low, closed, from the chest — no voice in it",
  1: "Sharp and noisy — the classic /pf/ or rimshot",
  2: "Short and bright — a tight /ts/, not a long hiss",
  3: "Broad and mid-heavy — an open, splashy hit",
};

type Phase = "idle" | "ready" | "capturing" | "review";

interface ClassTake {
  cls: number;
  hits: number;
}

export function Calibrate({ active = true }: { active?: boolean }) {
  const client = useEngine();
  const { kit, status } = useEngineState();
  const running = status === "running";
  const voice = kit.voice;

  const [phase, setPhase] = useState<Phase>("idle");
  /** Classes still to record in this pass, current one first. */
  const [queue, setQueue] = useState<number[]>([]);
  const [takes, setTakes] = useState<ClassTake[]>([]);
  const [outcome, setOutcome] = useState<VoiceClassTraining[] | null>(null);

  /** Rows pulled so far this pass, and how far into the ring we have read. */
  const rowsRef = useRef<VoiceCapture[]>([]);
  const seenRef = useRef(0);
  /** `captureCount` at the moment the current class armed. */
  const baseRef = useRef(0);
  /** The profile as it was before this pass, for undo. */
  const beforeRef = useRef<VoiceProfile | null>(null);
  /** True when the detector was off and we turned it on for the duration. */
  const borrowedRef = useRef(false);
  /** Set once the current take is full, so the rAF loop advances exactly once. */
  const fullRef = useRef(false);

  const countRef = useRef<HTMLSpanElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const levelRef = useRef<HTMLDivElement | null>(null);
  const heardRef = useRef<HTMLSpanElement | null>(null);

  const current = phase === "ready" || phase === "capturing" ? (queue[0] ?? null) : null;

  /** Stops everything and puts the detector back how we found it. */
  const disarm = useCallback(() => {
    client.stopVoiceCapture();
    if (borrowedRef.current) {
      client.setVoiceEnabled(false);
      borrowedRef.current = false;
    }
  }, [client]);

  // A tab change or unmount must never leave the detector armed: capture suppresses pad
  // firing, so a forgotten arm reads as "Smart Voice stopped working".
  useEffect(() => {
    if (!active || !running) {
      if (phase === "ready" || phase === "capturing") {
        disarm();
        setPhase("idle");
        setQueue([]);
      }
    }
  }, [active, running, phase, disarm]);

  useEffect(() => () => void disarm(), [disarm]);

  /** Pulls whatever is new in the ring onto the pass's row list. */
  const drain = useCallback(async () => {
    const reply = await client.pullVoiceCaptures(seenRef.current, 64);
    if (reply.rows.length) rowsRef.current = [...rowsRef.current, ...reply.rows];
    seenRef.current = reply.total;
    return reply;
  }, [client]);

  /** Finishes the current class and either moves on or trains. */
  const finishClass = useCallback(
    async (keep: boolean) => {
      const cls = queue[0];
      client.stopVoiceCapture();
      fullRef.current = false;
      if (cls === undefined) return;
      // Let the last hit finish being written before reading the ring.
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      const reply = await drain();
      const hits = Math.max(0, reply.total - baseRef.current);
      if (!keep) {
        // A rejected take is dropped by forgetting its rows, not by clearing the ring —
        // the ring still holds earlier classes we have already read and counted.
        rowsRef.current = rowsRef.current.filter((r) => (r.cls | 0) !== cls);
      } else if (hits > 0) {
        setTakes((t) => [...t.filter((x) => x.cls !== cls), { cls, hits }]);
      }

      const rest = queue.slice(1);
      setQueue(rest);
      if (rest.length) {
        setPhase("ready");
        return;
      }

      // Pass over. Train on this pass's rows only — every class not in them keeps
      // whatever it had, trained or factory.
      disarm();
      if (rowsRef.current.length) {
        const result = client.applyVoiceCalibration(rowsRef.current);
        setOutcome(result.classes);
      } else {
        setOutcome(null);
      }
      setPhase("review");
    },
    [client, queue, drain, disarm],
  );

  /** Throws away the current take and re-arms the same class. */
  const redoClass = useCallback(async () => {
    const cls = queue[0];
    client.stopVoiceCapture();
    fullRef.current = false;
    if (cls === undefined) return;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const reply = await drain();
    rowsRef.current = rowsRef.current.filter((r) => (r.cls | 0) !== cls);
    seenRef.current = reply.total;
    setTakes((t) => t.filter((x) => x.cls !== cls));
    setPhase("ready");
  }, [client, queue, drain]);

  const abort = useCallback(() => {
    disarm();
    fullRef.current = false;
    rowsRef.current = [];
    setQueue([]);
    setTakes([]);
    setOutcome(null);
    setPhase("idle");
  }, [disarm]);

  /** Starts a pass over `classes`. */
  const start = useCallback(
    (classes: number[]) => {
      if (!running || !classes.length) return;
      beforeRef.current = {
        params: { ...voice.params },
        classPads: [...voice.classPads],
        centroids: [...voice.centroids],
        attack: [...voice.attack],
        trained: [...voice.trained],
      };
      // Capture happens inside the detector, so it has to be running. Borrowed rather
      // than switched: someone who had Smart Voice off wants it off again afterwards.
      borrowedRef.current = !client.voiceEnabled;
      if (borrowedRef.current) client.setVoiceEnabled(true);
      client.clearVoiceCaptures();
      client.resetVoiceDetector();
      rowsRef.current = [];
      seenRef.current = 0;
      baseRef.current = 0;
      fullRef.current = false;
      setTakes([]);
      setOutcome(null);
      setQueue(classes);
      setPhase("ready");
    },
    [client, running, voice],
  );

  // The ready pause, then arm.
  useEffect(() => {
    if (phase !== "ready") return;
    const cls = queue[0];
    if (cls === undefined) return;
    const t = setTimeout(() => {
      baseRef.current = client.meters.voice.captureCount;
      fullRef.current = false;
      client.captureVoiceClass(cls);
      setPhase("capturing");
    }, READY_MS);
    return () => clearTimeout(t);
  }, [phase, queue, client]);

  // Live counter, progress bar and input level. Written straight to the DOM — this runs
  // at 60Hz while someone is hitting a microphone, and must not be a React render.
  useAnimationLoop(() => {
    const m = client.meters.voice;
    const got = Math.max(0, m.captureCount - baseRef.current);
    const shown = Math.min(TARGET_HITS, got);
    if (countRef.current) countRef.current.textContent = String(shown);
    if (barRef.current) barRef.current.style.width = `${((shown / TARGET_HITS) * 100).toFixed(1)}%`;
    if (levelRef.current) {
      levelRef.current.style.width = `${(Math.min(1, m.level * 3) * 100).toFixed(1)}%`;
    }
    if (heardRef.current) {
      heardRef.current.textContent =
        m.lastClass >= 0 ? (VOICE_CLASS_NAMES[m.lastClass] ?? "?").toUpperCase() : "—";
    }
    if (got >= TARGET_HITS && !fullRef.current) {
      fullRef.current = true;
      void finishClass(true);
    }
  }, phase === "capturing" && running);

  const undo = useCallback(() => {
    const before = beforeRef.current;
    if (before) client.restoreVoiceProfile(before);
    setOutcome(null);
    setTakes([]);
    setPhase("idle");
  }, [client]);

  /* ------------------------------------------------------------------ render */

  if (!running) {
    return (
      <div className="vk-well p-2">
        <div className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
          CALIBRATION
        </div>
        <div className="mt-1 text-[10px]" style={{ color: "var(--vk-text-mid)" }}>
          ENGAGE the engine first — calibration listens through the live detector.
        </div>
      </div>
    );
  }

  if (phase === "ready" || phase === "capturing") {
    const cls = current ?? 0;
    const done = takes.reduce((n, t) => n + (t.hits > 0 ? 1 : 0), 0);
    return (
      <div className="vk-well flex flex-col gap-2 p-2">
        <div className="flex items-baseline justify-between">
          <span className="vk-label" style={{ color: "var(--vk-amber)" }}>
            CALIBRATING
          </span>
          <span className="vk-label vk-mono" style={{ color: "var(--vk-text-dim)" }}>
            {done + 1} OF {done + queue.length}
          </span>
        </div>

        <div className="text-center">
          <div className="vk-mono text-[15px]" style={{ color: "var(--vk-amber)", letterSpacing: "0.06em" }}>
            {phase === "ready" ? "GET READY…" : `GIVE ME ${TARGET_HITS} ${CLASS_LABEL[cls] ?? "HITS"}`}
          </div>
          <div className="mt-[2px] text-[9px]" style={{ color: "var(--vk-text-mid)" }}>
            {CLASS_HINT[cls] ?? ""}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="vk-mono text-[20px]" style={{ color: "var(--vk-text)", minWidth: 44, textAlign: "right" }}>
            <span ref={countRef}>0</span>
            <span className="text-[11px]" style={{ color: "var(--vk-text-dim)" }}>
              /{TARGET_HITS}
            </span>
          </span>
          <div className="min-w-0 flex-1" style={{ height: 8, background: "var(--vk-void)", borderRadius: 2 }}>
            <div
              ref={barRef}
              style={{ width: "0%", height: "100%", background: "var(--vk-amber)", borderRadius: 2 }}
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
            IN
          </span>
          <div className="min-w-0 flex-1" style={{ height: 4, background: "var(--vk-void)", borderRadius: 2 }}>
            <div
              ref={levelRef}
              style={{ width: "0%", height: "100%", background: "var(--vk-green, #36d07a)", borderRadius: 2 }}
            />
          </div>
          <span
            className="vk-label vk-mono"
            style={{ color: "var(--vk-text-dim)", minWidth: 52 }}
            title="What the classifier would have called that hit — not what is being stored"
          >
            HEARD <span ref={heardRef}>—</span>
          </span>
        </div>

        <div className="flex flex-wrap gap-1">
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "3px 8px" }}
            onClick={() => void finishClass(true)}
            title={`Use the hits recorded so far — ${VOICE_MIN_HITS} is the fewest that will train a class`}
          >
            ENOUGH
          </button>
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "3px 8px" }}
            onClick={() => void redoClass()}
            title="Throw this take away and record the same class again"
          >
            REDO
          </button>
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "3px 8px" }}
            onClick={() => void finishClass(false)}
            title="Leave this class as it is and move on"
          >
            SKIP
          </button>
          <button
            className="vk-btn vk-focus-ring"
            data-tone="danger"
            style={{ fontSize: 9, padding: "3px 8px" }}
            onClick={abort}
            title="Abandon the whole pass — nothing is trained"
          >
            CANCEL
          </button>
        </div>
      </div>
    );
  }

  if (phase === "review") {
    return (
      <div className="vk-well flex flex-col gap-2 p-2">
        <div className="vk-label" style={{ color: "var(--vk-amber)" }}>
          CALIBRATION RESULT
        </div>
        {outcome ? (
          <div className="flex flex-col gap-[2px]">
            {outcome.map((c) => {
              const name = (VOICE_CLASS_NAMES[c.cls] ?? "?").toUpperCase();
              const touched = c.used > 0 || c.invalid > 0;
              if (!touched) {
                return (
                  <div key={c.cls} className="flex items-center justify-between text-[10px]">
                    <span style={{ color: "var(--vk-text-dim)" }}>{name}</span>
                    <span className="vk-mono" style={{ color: "var(--vk-text-dim)" }}>
                      not recorded
                    </span>
                  </div>
                );
              }
              return (
                <div key={c.cls} className="flex items-center justify-between text-[10px]">
                  <span style={{ color: c.trained ? "var(--vk-text)" : "var(--vk-text-mid)" }}>{name}</span>
                  <span
                    className="vk-mono"
                    style={{ color: c.trained ? "var(--vk-green, #36d07a)" : "var(--vk-amber)" }}
                    title={
                      c.trained
                        ? `mean spread ${c.spread.toFixed(3)} — lower is a more consistent performer`
                        : `fewer than ${VOICE_MIN_HITS} usable hits, so this class kept its factory row`
                    }
                  >
                    {c.trained
                      ? `used ${c.used} of ${c.used + c.rejected + c.invalid}`
                      : `too few — left as it was`}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-[10px]" style={{ color: "var(--vk-text-mid)" }}>
            Nothing was recorded, so nothing changed.
          </div>
        )}
        <div className="text-[9px]" style={{ color: "var(--vk-text-dim)" }}>
          Saved with the kit. Dropped hits are ones that sat far outside the rest of their own
          take — a breath, a clip, a chair.
        </div>
        <div className="flex gap-1">
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "3px 10px" }}
            onClick={() => {
              setOutcome(null);
              setPhase("idle");
            }}
          >
            DONE
          </button>
          <button
            className="vk-btn vk-focus-ring"
            style={{ fontSize: 9, padding: "3px 10px" }}
            onClick={undo}
            title="Put the profile back exactly as it was before this pass"
          >
            UNDO
          </button>
        </div>
      </div>
    );
  }

  /* idle */
  const anyTrained = voice.trained.some((t) => t > 0);
  return (
    <div className="vk-well flex flex-col gap-2 p-2">
      <div className="flex items-baseline justify-between">
        <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
          CALIBRATION
        </span>
        <span className="vk-label vk-mono" style={{ color: anyTrained ? "var(--vk-green, #36d07a)" : "var(--vk-text-dim)" }}>
          {anyTrained ? "TRAINED" : "FACTORY"}
        </span>
      </div>

      <div className="text-[9px]" style={{ color: "var(--vk-text-mid)" }}>
        Half a minute of your own mouth, eight hits a class. Every beatboxer is spectrally
        different, so this is the difference between mediocre and convincing. Pads stay quiet
        while you record unless MONITOR is on.
      </div>

      <div className="flex flex-col gap-[2px]">
        {Array.from({ length: VOICE_CLASS_COUNT }, (_, c) => {
          const hits = voice.trained[c] ?? 0;
          return (
            <div key={c} className="flex items-center gap-2">
              <span className="vk-label" style={{ width: 44, color: "var(--vk-text)" }}>
                {(VOICE_CLASS_NAMES[c] ?? "?").toUpperCase()}
              </span>
              <span
                className="vk-mono min-w-0 flex-1 text-[10px]"
                style={{ color: hits > 0 ? "var(--vk-green, #36d07a)" : "var(--vk-text-dim)" }}
              >
                {hits > 0 ? `${hits} hits` : "factory"}
              </span>
              <button
                className="vk-btn vk-focus-ring"
                style={{ fontSize: 9, padding: "2px 6px" }}
                onClick={() => start([c])}
                title={`Record just this class — the other three keep what they have`}
              >
                {hits > 0 ? "REDO" : "TRAIN"}
              </button>
              <button
                className="vk-btn vk-focus-ring"
                style={{ fontSize: 9, padding: "2px 6px" }}
                disabled={hits === 0}
                onClick={() => client.resetVoiceCalibration(c)}
                title="Put this class back to the factory row"
              >
                CLEAR
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-1">
        <button
          className="vk-btn vk-focus-ring"
          style={{ fontSize: 9, padding: "3px 10px" }}
          onClick={() => start(Array.from({ length: VOICE_CLASS_COUNT }, (_, c) => c))}
          title="Guided pass through all four classes, about thirty seconds"
        >
          CALIBRATE ALL
        </button>
        <button
          className="vk-btn vk-focus-ring"
          data-tone="danger"
          style={{ fontSize: 9, padding: "3px 10px" }}
          disabled={!anyTrained}
          onClick={() => client.resetVoiceCalibration(-1)}
          title="Every class back to factory. Detector settings are untouched."
        >
          FORGET ALL
        </button>
      </div>
    </div>
  );
}

export default Calibrate;
