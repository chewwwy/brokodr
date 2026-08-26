/**
 * Bro.Kodr — VOICE LAB (text to speech).
 *
 * Type a line, pick an accent, pick a character, generate. What comes back is not played
 * through some side channel: the WAV is decoded straight into the engine's file player,
 * which is the same player the AUDIO FILE panel drives. That one decision is what gives
 * the generated voice everything the rack already does, for free:
 *
 *   - the whole effect chain applies live, and every dial keeps working after generation
 *   - it can replace the mic as the input source, so you can A/B against your own voice
 *   - it can be the CARRIER for the talk box and vocoder — a synthetic voice driving the
 *     vocal-tract model is a genuinely different instrument to a mic doing it
 *   - EXPORT WAV / MP3 on the recorder captures it, processed
 *
 * Characters are ordinary chains (see audio/voice-presets.ts), so GENERATE loads one into
 * the rack rather than hiding it. Anything a character does can be opened and edited.
 */

import { useState } from "react";
import { FILE_ROUTE } from "../audio/backend";
import { applyMorph, DEFAULT_MORPH, MORPH_DIALS, VOICE_CHARACTERS } from "../audio/voice-presets";
import type { MorphState } from "../audio/voice-presets";
import { useEngine, useEngineState } from "../hooks/use-engine";
import { useSynthesize, useTtsCatalog } from "../queries/tts";
import { Knob, LabeledSelect } from "./controls";

const MAX_CHARS = 1200;

/** base64 -> ArrayBuffer. The route returns WAV bytes as base64 inside the JSON payload. */
function b64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function TtsPanel() {
  const client = useEngine();
  const { status } = useEngineState();
  const catalog = useTtsCatalog();
  const synth = useSynthesize();

  const [text, setText] = useState("Bro dot Kodr. Voice lab online.");
  const [provider, setProvider] = useState("gemini");
  const [voiceId, setVoiceId] = useState("au-m");
  const [character, setCharacter] = useState<string | null>(null);
  const [morph, setMorph] = useState<MorphState>({ ...DEFAULT_MORPH });
  const [style, setStyle] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const providers = catalog.data?.providers ?? [];
  const voices = catalog.data?.voices ?? [];
  const activeProvider = providers.find((p) => p.id === provider);
  const engaged = status !== "idle";

  /** Load the selected character (plus morph offsets) into the rack. */
  const applyChain = (charId: string | null, m: MorphState) => {
    const base = VOICE_CHARACTERS.find((c) => c.id === charId);
    if (!base) return;
    client.loadChain(applyMorph(base.chain, m), null);
  };

  const pickCharacter = (id: string) => {
    const next = character === id ? null : id;
    setCharacter(next);
    if (next) applyChain(next, morph);
  };

  const setDial = (key: string, v: number) => {
    const next = { ...morph, [key]: v };
    setMorph(next);
    // Morph dials only mean something relative to a character chain. Without one, the
    // rack is whatever the user built and we must not stomp on it.
    if (character) applyChain(character, next);
  };

  const generate = async () => {
    setNote(null);
    if (!engaged) {
      setNote("Press ENGAGE first — decoding needs the audio engine running.");
      return;
    }
    try {
      const res = await synth.mutateAsync({
        text: text.slice(0, MAX_CHARS),
        voiceId,
        provider: provider as "gemini" | "groq",
        style,
      });
      await client.loadAudioBytes(b64ToBytes(res.wavBase64), `${voiceId} · ${text.slice(0, 24)}`);
      client.fileRoute(FILE_ROUTE.INPUT);
      client.filePlay(true);
      setNote(`${(res.frames / res.sampleRate).toFixed(2)}s at ${res.sampleRate} Hz · ${res.ms} ms`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Synthesis failed");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {/* ---------------------------------------------------------- script */}
      <label className="flex flex-col gap-[3px]">
        <span className="vk-label">SCRIPT</span>
        <textarea
          className="vk-input vk-mono"
          rows={3}
          value={text}
          maxLength={MAX_CHARS}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type the line to speak…"
          style={{ resize: "vertical", fontSize: 11, lineHeight: 1.4 }}
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <LabeledSelect
          label="ENGINE"
          value={provider}
          onChange={setProvider}
          options={providers.map((p) => ({
            value: p.id,
            label: p.available ? p.label : `${p.label} — unavailable`,
          }))}
          title={activeProvider?.note}
        />
        <LabeledSelect
          label="VOICE"
          value={voiceId}
          onChange={setVoiceId}
          options={voices.map((v) => ({ value: v.id, label: v.label }))}
        />
      </div>

      {provider === "groq" && (
        <div className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)", lineHeight: 1.4 }}>
          Groq / Orpheus has six fixed English voices and no accent control — the accent
          packs above map to the nearest one. Use Gemini for real British, Australian,
          Italian and Spanish delivery.
        </div>
      )}

      <label className="flex flex-col gap-[3px]">
        <span className="vk-label">DIRECTION (optional)</span>
        <input
          className="vk-input vk-mono"
          value={style}
          maxLength={300}
          onChange={(e) => setStyle(e.target.value)}
          placeholder="e.g. slow and menacing, almost whispering"
          style={{ fontSize: 11 }}
        />
      </label>

      {/* ------------------------------------------------------ characters */}
      <div className="flex flex-col gap-[4px]">
        <span className="vk-label">CHARACTER</span>
        <div className="grid grid-cols-3 gap-[4px]">
          {VOICE_CHARACTERS.map((c) => (
            <button
              key={c.id}
              className="vk-btn vk-focus-ring"
              data-active={character === c.id}
              style={{ fontSize: 9, padding: "3px 4px" }}
              onClick={() => pickCharacter(c.id)}
              title={c.blurb}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)", lineHeight: 1.4 }}>
          {character
            ? VOICE_CHARACTERS.find((c) => c.id === character)?.blurb
            : "A character loads a full chain into the rack — click again to release it and keep your own."}
        </div>
      </div>

      {/* ----------------------------------------------------- morph dials */}
      <div className="flex flex-col gap-[4px]">
        <span className="vk-label">MORPH</span>
        <div className="flex flex-wrap gap-x-2 gap-y-1">
          {MORPH_DIALS.map((d) => (
            <div key={d.key} className="flex flex-col items-center" style={{ width: 52 }}>
              <Knob def={d} value={morph[d.key]} onChange={(v) => setDial(d.key, v)} size={38} />
            </div>
          ))}
        </div>
        <div className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)", lineHeight: 1.4 }}>
          Offsets on top of the character, not absolutes. ROUGHNESS is the real
          younger↔older control — an aged voice loses steadiness, it does not just drop in
          pitch. VIB uses chorus, the nearest thing the rack has to pitch vibrato.
        </div>
      </div>

      {/* ---------------------------------------------------------- action */}
      <button
        className="vk-btn vk-focus-ring"
        data-tone="cyan"
        onClick={generate}
        disabled={synth.isPending || !text.trim() || !activeProvider?.available}
        style={{ padding: "5px 8px" }}
      >
        {synth.isPending ? "GENERATING…" : "GENERATE VOICE"}
      </button>

      {!engaged && (
        <div className="vk-mono text-[10px]" style={{ color: "var(--vk-amber)" }}>
          Engine is in standby — press ENGAGE before generating.
        </div>
      )}

      {note && (
        <div className="vk-mono text-[10px]" style={{ color: "var(--vk-text-mid)", lineHeight: 1.4 }}>
          {note}
        </div>
      )}

      <div className="vk-mono text-[10px]" style={{ color: "var(--vk-text-dim)", lineHeight: 1.4 }}>
        Generated speech lands in the file player: set its route to CARRIER on the AUDIO FILE
        panel to drive the talk box or vocoder, and use the recorder to export it processed.
      </div>
    </div>
  );
}
