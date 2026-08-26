/**
 * Bro.Kodr — I/O strip.
 *
 * Input trim / output gain / master dry-wet with real metering on both ends. These are the
 * only gain stages outside the rack, and they live in the engine's I/O stage so they are
 * applied on the audio thread, not by a Web Audio GainNode.
 *
 * Input and output share ONE panel, laid out like a console channel rather than two stacked
 * boxes: faders on the outer edges, the two meters back to back in the middle so you read
 * gain change across the chain in a single glance, and the switches shrunk to a compact
 * grid underneath. Splitting them into two panels wasted a whole panel header and put the
 * two things you actually compare — in level and out level — as far apart as possible.
 */

import { useCallback } from "react";
import { useEngine, useEngineState } from "../hooks/use-engine";
import { Fader, MiniSlider, Section, Toggle } from "./controls";
import { LevelMeter } from "./meters";
import { TtsPanel } from "./tts-panel";

const dbFmt = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;

const FADER_H = 138;

export function IoStrip({ voiceTone }: { voiceTone?: string }) {
  const client = useEngine();
  const { io } = useEngineState();

  const readIn = useCallback((): [number, number, number, number] => {
    const m = client.meters;
    return [m.peakInL, m.peakInR, m.rmsInL, m.rmsInR];
  }, [client]);

  const readOut = useCallback((): [number, number, number, number] => {
    const m = client.meters;
    return [m.peakOutL, m.peakOutR, m.rmsOutL, m.rmsOutR];
  }, [client]);

  const clipIn = useCallback(() => client.meters.clipIn, [client]);
  const clipOut = useCallback(() => client.meters.clipOut, [client]);
  const resetClip = useCallback(() => client.resetClip(), [client]);

  return (
    <aside
      className="flex shrink-0 flex-col gap-2 overflow-y-auto p-2"
      style={{ width: 286, background: "var(--vk-panel-lo)", borderLeft: "1px solid var(--vk-line)" }}
    >
      {/* ------------------------------------------------- input + output, one panel */}
      <div className="vk-panel flex shrink-0 flex-col gap-2 p-2">
        {/* The two words sit over the control each one owns: INPUT above the TRIM fader on
            the left, OUTPUT above the GAIN fader on the right, arrow centred over the meters. */}
        <div className="flex items-center justify-between gap-2">
          <span className="vk-title" style={{ color: "var(--vk-cyan)" }}>
            INPUT
          </span>
          <span className="vk-label" style={{ color: "var(--vk-text-dim)" }}>
            →
          </span>
          <span className="vk-title" style={{ color: "var(--vk-amber)" }}>
            OUTPUT
          </span>
        </div>

        {/* faders outside, meters inside */}
        <div className="flex items-start justify-between gap-1">
          <Fader
            value={io.inGain}
            min={-24}
            max={24}
            onChange={(v) => client.setIo("inGain", v)}
            label="TRIM dB"
            format={dbFmt}
            height={FADER_H}
            accent="var(--vk-cyan)"
          />
          <div className="flex items-start gap-[3px]">
            <LevelMeter read={readIn} clipped={clipIn} onResetClip={resetClip} height={FADER_H} width={22} label="IN" />
            <LevelMeter read={readOut} clipped={clipOut} onResetClip={resetClip} height={FADER_H} width={22} label="OUT" />
          </div>
          <Fader
            value={io.outGain}
            min={-60}
            max={12}
            onChange={(v) => client.setIo("outGain", v)}
            label="GAIN dB"
            format={dbFmt}
            height={FADER_H}
          />
        </div>

        {/* switches: compact 2x2, they are set once and then left alone */}
        <div className="grid grid-cols-2 gap-[3px]">
          <Toggle
            on={io.mono}
            onChange={(v) => client.setIo("mono", v)}
            label="MONO"
            tone="cyan"
            title="Sum both input channels to mono before the chain"
          />
          <Toggle
            on={io.swap}
            onChange={(v) => client.setIo("swap", v)}
            label="SWAP"
            tone="cyan"
            title="Swap left and right input channels"
          />
          <Toggle on={io.mute} onChange={(v) => client.setIo("mute", v)} label="MUTE" tone="red" title="Mute the output (M)" />
          <Toggle
            on={io.bypass}
            onChange={(v) => client.setIo("bypass", v)}
            label="BYPASS"
            tone="red"
            title="Bypass the entire chain — hear the raw input (B)"
          />
        </div>

        <label className="flex items-center gap-2">
          <span className="vk-label" style={{ width: 46 }}>
            DRY/WET
          </span>
          <MiniSlider
            value={io.masterMix}
            onChange={(v) => client.setIo("masterMix", v)}
            width={110}
            title="Master dry/wet blend across the whole chain"
          />
          <span className="vk-value" style={{ width: 32, textAlign: "right" }}>
            {Math.round(io.masterMix * 100)}%
          </span>
        </label>
      </div>

      {/* -------------------------------------------------------------- voice lab */}
      <Section title="VOICE LAB" tone={voiceTone}>
        <TtsPanel />
      </Section>

      <div className="vk-panel shrink-0 p-2">
        <div className="vk-title mb-1">SAFETY</div>
        <p className="vk-label" style={{ lineHeight: 1.5, textTransform: "none", letterSpacing: 0 }}>
          Wear headphones. Monitoring your own mic through speakers will feed back. The output
          limiter only protects the signal, not your ears.
        </p>
        <button className="vk-btn vk-focus-ring mt-2 w-full justify-center" onClick={resetClip}>
          RESET CLIP
        </button>
      </div>
    </aside>
  );
}
