import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { base } from "../__core/app";

/**
 * Bro.Kodr — text-to-speech synthesis.
 *
 * Why this is a server route at all: the browser's own `speechSynthesis` cannot be
 * captured. The spec has no path from a synthesised utterance into an audio graph
 * (web-speech-api issue #69, still open), so a browser voice can be *heard* but never
 * *processed* — no pitch shift, no formant morph, no rack. Anything the effect chain is
 * supposed to touch has to arrive as sample data, which means an API that hands back a
 * file. That is this route. The browser path still exists client-side for instant
 * previews and is labelled PREVIEW ONLY in the UI, because lying about which voices the
 * dials affect would be worse than not offering them.
 *
 * Providers are adapters behind one shape: text in, 16-bit PCM WAV out.
 *
 *   gemini — works today. Returns raw headerless L16 PCM (mono, rate in the mime type),
 *            so we wrap a WAV header ourselves. Accent and delivery are steered by a
 *            natural-language instruction prefixed to the text, which is how Gemini TTS
 *            exposes style; there is no separate accent parameter.
 *   groq   — works now that the model terms are accepted. `playai-tts` was decommissioned;
 *            the successor is `canopylabs/orpheus-v1-english`, which returns a real WAV
 *            (streaming RIFF, size field 0xFFFFFFFF — decoders handle it) and accepts only
 *            six fixed voices: autumn, diana, hannah, austin, daniel, troy. It is English
 *            only with no accent or style control, so the accent packs stay Gemini's job
 *            and Groq's entries are labelled by voice, not accent. Verified 2026-08-24.
 */

const GEMINI_MODEL = "gemini-2.5-flash-preview-tts";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GROQ_URL = "https://api.groq.com/openai/v1/audio/speech";
const GROQ_MODEL = "canopylabs/orpheus-v1-english";

/** Hard ceiling on one synthesis request. Long scripts are split into blocks client-side. */
const MAX_CHARS = 1200;

export type ProviderId = "gemini" | "groq";

/**
 * The voice catalog. Accent is a style instruction, not a model parameter, so each entry
 * carries the exact wording that produced the accent reliably in testing. Keep `id`
 * stable — presets store it.
 */
const VOICES = [
  // ---- American
  { id: "us-f", label: "American · Female", accent: "American", gender: "female", provider: "gemini", voice: "Kore",
    style: "Speak in a natural American English accent, clear and neutral" },
  { id: "us-m", label: "American · Male", accent: "American", gender: "male", provider: "gemini", voice: "Puck",
    style: "Speak in a natural American English accent, clear and neutral" },
  // ---- British
  { id: "gb-f", label: "British · Female", accent: "British", gender: "female", provider: "gemini", voice: "Aoede",
    style: "Speak in a natural British English accent, Received Pronunciation" },
  { id: "gb-m", label: "British · Male", accent: "British", gender: "male", provider: "gemini", voice: "Charon",
    style: "Speak in a natural British English accent, Received Pronunciation" },
  // ---- Australian
  { id: "au-f", label: "Australian · Female", accent: "Australian", gender: "female", provider: "gemini", voice: "Zephyr",
    style: "Speak in a natural Australian English accent, relaxed and warm" },
  { id: "au-m", label: "Australian · Male", accent: "Australian", gender: "male", provider: "gemini", voice: "Fenrir",
    style: "Speak in a natural Australian English accent, relaxed and warm" },
  // ---- Italian
  { id: "it-f", label: "Italian · Female", accent: "Italian", gender: "female", provider: "gemini", voice: "Achernar",
    style: "Speak with a natural Italian accent" },
  { id: "it-m", label: "Italian · Male", accent: "Italian", gender: "male", provider: "gemini", voice: "Alnilam",
    style: "Speak with a natural Italian accent" },
  // ---- Spanish. Separate voices from the Italian pair on purpose: sharing one voice made
  // the two packs sound like the same person doing two impressions.
  { id: "es-f", label: "Spanish · Female", accent: "Spanish", gender: "female", provider: "gemini", voice: "Leda",
    style: "Speak with a natural Spanish accent, Castilian" },
  { id: "es-m", label: "Spanish · Male", accent: "Spanish", gender: "male", provider: "gemini", voice: "Orus",
    style: "Speak with a natural Spanish accent, Castilian" },
] as const;

/**
 * Groq / Orpheus accepts exactly six voices and no accent control, so these are the
 * nearest match per catalog id rather than a real accent map — the UI says as much.
 * An unknown id falls back to `autumn`.
 */
const GROQ_VOICES: Record<string, string> = {
  "us-f": "autumn", "us-m": "austin", "gb-f": "diana", "gb-m": "daniel",
  "au-f": "hannah", "au-m": "troy", "it-f": "diana", "it-m": "daniel",
  "es-f": "autumn", "es-m": "austin",
};

function hasKey(p: ProviderId): boolean {
  const k = p === "gemini" ? process.env.GOOGLE_GENERATIVE_AI_API_KEY : process.env.GROQ_API_KEY;
  return typeof k === "string" && k.length > 0;
}

/**
 * Wraps mono 16-bit PCM in a canonical 44-byte WAV header. Written by hand rather than
 * pulled from a dependency because the browser's decodeAudioData is the consumer and it
 * only needs the canonical layout — and because a wrong byte here is far easier to find
 * in twenty lines than in a library.
 */
function wavFromPcm16(pcm: Buffer, sampleRate: number, channels = 1): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format = PCM integer
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Pulls the sample rate out of a mime like `audio/L16;codec=pcm;rate=24000`. */
function rateFromMime(mime: string): number {
  const m = /rate=(\d+)/.exec(mime);
  const r = m ? Number(m[1]) : 24000;
  return Number.isFinite(r) && r >= 8000 && r <= 96000 ? r : 24000;
}

/**
 * Style instructions are prepended as an instruction line rather than merged into the
 * spoken sentence, so the model treats them as delivery direction and does not read them
 * aloud. Empirically the colon matters; without it the instruction sometimes gets spoken.
 */
function buildPrompt(style: string, extra: string, text: string): string {
  const dir = [style, extra.trim()].filter(Boolean).join(", ");
  return dir ? `${dir}: ${text}` : text;
}

async function synthGemini(text: string, voice: string, style: string, extra: string) {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) throw new ORPCError("BAD_REQUEST", { message: "GOOGLE_GENERATIVE_AI_API_KEY is not set" });

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(style, extra, text) }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new ORPCError("BAD_GATEWAY", { message: `Gemini TTS ${res.status}: ${body.slice(0, 400)}` });
  }

  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
  };
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  const data = part?.inlineData?.data;
  if (!data) throw new ORPCError("BAD_GATEWAY", { message: "Gemini returned no audio" });

  const sampleRate = rateFromMime(part?.inlineData?.mimeType ?? "");
  const wav = wavFromPcm16(Buffer.from(data, "base64"), sampleRate);
  return { wav, sampleRate };
}

async function synthGroq(text: string, voice: string) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new ORPCError("BAD_REQUEST", { message: "GROQ_API_KEY is not set" });

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: GROQ_MODEL, voice, input: text, response_format: "wav" }),
  });

  if (!res.ok) {
    const body = await res.text();
    // Surface the terms gate as something actionable instead of a raw 400.
    if (body.includes("terms acceptance")) {
      throw new ORPCError("BAD_GATEWAY", {
        message: "Groq TTS needs its model terms accepted once at console.groq.com/playground?model=canopylabs/orpheus-v1-english — until then use Gemini.",
      });
    }
    throw new ORPCError("BAD_GATEWAY", { message: `Groq TTS ${res.status}: ${body.slice(0, 400)}` });
  }

  // Orpheus returns a *streaming* RIFF: the size fields are 0xFFFFFFFF and an ffmpeg
  // LIST/INFO chunk sits between fmt and data. Rather than trust either, parse the chunks
  // and re-wrap the payload with our own canonical 44-byte header. That fixes three things
  // at once: the real sample rate (24k, not the 48k the docs imply), a `frames` count that
  // isn't thrown off by the extra chunk, and a size field decoders can actually believe.
  const raw = Buffer.from(await res.arrayBuffer());
  const { pcm, sampleRate, channels } = parseWav(raw);
  return { wav: wavFromPcm16(pcm, sampleRate, channels), sampleRate };
}

/**
 * Minimal RIFF/WAVE chunk walker: pulls the sample rate, channel count and 16-bit PCM
 * payload out of a WAV, tolerating extra chunks and bogus (streaming) size fields.
 */
function parseWav(buf: Buffer): { pcm: Buffer; sampleRate: number; channels: number } {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new ORPCError("BAD_GATEWAY", { message: "TTS provider returned something that is not a WAV" });
  }
  let sampleRate = 24000;
  let channels = 1;
  let pcm: Buffer | null = null;

  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString("ascii", off, off + 4);
    const declared = buf.readUInt32LE(off + 4);
    const body = off + 8;
    // A streaming writer leaves 0xFFFFFFFF here; clamp to whatever is actually present.
    const size = Math.min(declared, buf.length - body);

    if (id === "fmt ") {
      channels = Math.max(1, Math.min(2, buf.readUInt16LE(body + 2)));
      sampleRate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (bits !== 16) throw new ORPCError("BAD_GATEWAY", { message: `Expected 16-bit PCM, got ${bits}-bit` });
    } else if (id === "data") {
      pcm = buf.subarray(body, body + size - (size % 2));
      break; // data runs to the end of a streamed file; nothing useful follows.
    }
    off = body + size + (size % 2); // chunks are word-aligned
  }

  if (!pcm?.length) throw new ORPCError("BAD_GATEWAY", { message: "WAV contained no audio data" });
  return { pcm, sampleRate, channels };
}

export const tts = {
  /** Which providers this deployment can actually reach, and the voice catalog. */
  catalog: base.handler(() => ({
    providers: [
      { id: "gemini" as const, label: "Gemini", available: hasKey("gemini"), note: "All four accent packs" },
      {
        id: "groq" as const,
        label: "Groq · Orpheus",
        available: hasKey("groq"),
        note: hasKey("groq")
          ? "Six fixed English voices — no accent or style control"
          : "No key set",
      },
    ],
    voices: VOICES.map((v) => ({
      id: v.id, label: v.label, accent: v.accent, gender: v.gender, provider: v.provider,
    })),
  })),

  /**
   * Synthesises one block of text. Returns base64 WAV — the client decodes it with
   * decodeAudioData and hands the samples to the engine's file player, which is what puts
   * generated speech through the effect rack.
   */
  synth: base
    .input(
      z.object({
        text: z.string().min(1).max(MAX_CHARS),
        voiceId: z.string().min(1).max(40),
        provider: z.enum(["gemini", "groq"]).default("gemini"),
        /** Extra delivery direction on top of the voice's accent, e.g. "whispering, slow". */
        style: z.string().max(300).default(""),
      }),
    )
    .handler(async ({ input }) => {
      const entry = VOICES.find((v) => v.id === input.voiceId);
      if (!entry) throw new ORPCError("NOT_FOUND", { message: `Unknown voice ${input.voiceId}` });

      const started = Date.now();
      const { wav, sampleRate } =
        input.provider === "groq"
          ? await synthGroq(input.text, GROQ_VOICES[entry.id] ?? "autumn")
          : await synthGemini(input.text, entry.voice, entry.style, input.style);

      return {
        wavBase64: wav.toString("base64"),
        sampleRate,
        bytes: wav.length,
        /** Frames of 16-bit mono audio, i.e. duration * rate. Useful for groove maths. */
        frames: Math.max(0, (wav.length - 44) / 2),
        ms: Date.now() - started,
        voiceId: entry.id,
        provider: input.provider,
      };
    }),
};
