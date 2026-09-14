/**
 * Bro.Kodr — Android DSP spike engine.
 *
 * Signal path: mic -> AudioRecorder -> RecorderAdapterNode -> WorkletProcessingNode
 * (our real DSP, on the native audio thread) -> destination.
 *
 * Everything measured here is measured INSIDE the audio callback and pushed to
 * the UI at ~8Hz through a Synchronizable, so the numbers are not polluted by
 * React render time.
 *
 * Native only. react-native-audio-api's worklet nodes are native code; on web
 * this module refuses to start and the screen says so.
 */
import { Platform } from "react-native";
import Constants, { ExecutionEnvironment } from "expo-constants";
import type { Synchronizable } from "react-native-worklets";
import { createRack } from "./dsp/rack";

export type SpikeMetrics = {
  running: boolean;
  sampleRate: number;
  blockSize: number;
  blockMs: number;
  /** mean DSP time per block as a percentage of the block's real-time budget */
  cpuPct: number;
  /** worst single block since start */
  cpuPeakPct: number;
  /** worst block time in ms */
  peakMs: number;
  blocks: number;
  /** callback gaps longer than 1.8x the block period — audible glitches */
  dropouts: number;
  inPeakDb: number;
  outPeakDb: number;
  /** acoustic round-trip: -1 = never measured, -2 = click emitted, listening */
  latencyMs: number;
  /** true once effect instances were constructed on the audio runtime */
  rackAlive: boolean;
  error: string;
};

export type SpikeControl = {
  /** bitmask: 1 = EQ, 2 = COMP, 4 = PITCH */
  stages: number;
  /** true = raw mic straight through, DSP not called at all */
  bypass: boolean;
  /** increment to fire an acoustic round-trip latency measurement */
  clickSeq: number;
};

const EMPTY: SpikeMetrics = {
  running: false,
  sampleRate: 0,
  blockSize: 0,
  blockMs: 0,
  cpuPct: 0,
  cpuPeakPct: 0,
  peakMs: 0,
  blocks: 0,
  dropouts: 0,
  inPeakDb: -120,
  outPeakDb: -120,
  latencyMs: -1,
  rackAlive: false,
  error: "",
};

const INITIAL_CONTROL: SpikeControl = { stages: 1 | 2 | 4, bypass: false, clickSeq: 0 };

// Synchronizables are created lazily, on first start, because creating one
// touches the react-native-worklets native module. In Expo Go and in the web
// preview that module does not exist, and a module-level call would red-screen
// the app before the screen could explain why. Until then these stay null and
// the UI reads the plain fallbacks below.
let metricsBox: Synchronizable<SpikeMetrics> | null = null;
let controlBox: Synchronizable<SpikeControl> | null = null;
let fallbackMetrics: SpikeMetrics = { ...EMPTY };
let fallbackControl: SpikeControl = { ...INITIAL_CONTROL };

let ctx: any = null;
let recorder: any = null;
let node: any = null;

export function readMetrics(): SpikeMetrics {
  return metricsBox ? metricsBox.getDirty() : fallbackMetrics;
}

export function setControl(patch: Partial<SpikeControl>): SpikeControl {
  const next = { ...(metricsBox && controlBox ? controlBox.getDirty() : fallbackControl), ...patch };
  fallbackControl = next;
  controlBox?.setBlocking(next);
  return next;
}

export function isWebPreview(): boolean {
  return Platform.OS === "web";
}

/**
 * Expo Go cannot run this spike at all: react-native-audio-api and
 * react-native-worklets are both native code that Expo Go does not ship. Only a
 * custom dev client (built from the mobile preview dashboard) contains them.
 */
export function isExpoGo(): boolean {
  return Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
}

/** Any environment where the native audio thread is unavailable. */
export function unsupportedReason(): string | null {
  if (isWebPreview()) {
    return "Web preview runs the browser audio path, so any number here would be meaningless.";
  }
  if (isExpoGo()) {
    return "Expo Go does not contain react-native-audio-api or react-native-worklets - both are native code. You need the custom dev client.";
  }
  return null;
}

export async function startSpike(): Promise<{ ok: boolean; error?: string }> {
  const blocked = unsupportedReason();
  if (blocked) return { ok: false, error: blocked };
  if (ctx) return { ok: true };

  const { createSynchronizable } = require("react-native-worklets");
  if (!metricsBox) metricsBox = createSynchronizable({ ...EMPTY });
  if (!controlBox) controlBox = createSynchronizable({ ...fallbackControl });

  const RNAA = require("react-native-audio-api");
  const { AudioContext, AudioManager, AudioRecorder } = RNAA;

  const granted = await AudioManager.requestRecordingPermissions();
  if (granted !== "Granted" && granted !== true && granted?.status !== "Granted") {
    return { ok: false, error: `Microphone permission: ${JSON.stringify(granted)}` };
  }

  // Low-latency voice-chat session: this is the mode that actually gets us the
  // small hardware buffer on Android. "playAndRecord" alone does not.
  AudioManager.setAudioSessionOptions?.({
    iosCategory: "playAndRecord",
    iosMode: "voiceChat",
    iosOptions: ["allowBluetooth", "defaultToSpeaker"],
  });
  AudioManager.setLockScreenInfo?.({ title: "Bro.Kodr spike" });

  ctx = new AudioContext();
  const sampleRate: number = ctx.sampleRate;
  const metrics = metricsBox!;
  const control = controlBox!;

  // Captured plain object: cloned ONCE into the audio runtime when the callback
  // is serialized, so mutations below persist across callbacks on that runtime
  // and never touch the JS thread.
  const st = {
    rack: null as any,
    inited: false,
    err: "",
    blocks: 0,
    accMs: 0,
    peakMs: 0,
    dropouts: 0,
    lastTime: -1,
    inPeak: 0,
    outPeak: 0,
    lastPush: 0,
    seenClick: 0,
    emitAt: -1,
    listening: false,
    noiseFloor: 1e-4,
    latencyMs: -1,
  };

  const cb = (inputData: Float32Array[], outputData: Float32Array[], framesToProcess: number, currentTime: number) => {
    "worklet";
    const nowMs = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

    // ---- dropout detection: the callback should arrive every frames/sr seconds.
    const period = framesToProcess / sampleRate;
    if (st.lastTime >= 0 && currentTime - st.lastTime > period * 1.8) st.dropouts++;
    st.lastTime = currentTime;

    const L = outputData[0];
    const R = outputData.length > 1 ? outputData[1] : outputData[0];
    const inL = inputData[0];
    const inR = inputData.length > 1 ? inputData[1] : inputData[0];

    // Copy mic -> output buffers; the DSP contract is in-place on the buffers.
    let ip = 0;
    for (let i = 0; i < framesToProcess; i++) {
      const a = inL[i];
      const b = inR[i];
      const m = a > 0 ? a : -a;
      if (m > ip) ip = m;
      L[i] = a;
      if (R !== L) R[i] = b;
    }
    st.inPeak = ip > st.inPeak ? ip : st.inPeak;

    const ctl = control.getDirty();

    // ---- THE question: do the real DSP classes construct on this runtime?
    if (!st.inited) {
      st.inited = true;
      try {
        st.rack = createRack(sampleRate, 1024);
      } catch (e: any) {
        st.rack = null;
        st.err = "rack init failed: " + (e && e.message ? e.message : String(e));
      }
    }

    if (st.rack && !ctl.bypass && ctl.stages !== 0) {
      try {
        st.rack.process(L, R, framesToProcess, ctl.stages);
      } catch (e: any) {
        st.err = "process threw: " + (e && e.message ? e.message : String(e));
        st.rack = null;
      }
    }

    // ---- acoustic round-trip latency: emit a 2ms full-scale 3kHz burst, then
    // listen on the mic for it. Includes speaker + air + mic + both buffers,
    // which is exactly the number a singer hears.
    if (ctl.clickSeq !== st.seenClick) {
      st.seenClick = ctl.clickSeq;
      st.noiseFloor = st.inPeak > 1e-5 ? st.inPeak : 1e-4;
      const burst = Math.min(framesToProcess, Math.floor(sampleRate * 0.002));
      for (let i = 0; i < burst; i++) {
        const v = Math.sin((2 * Math.PI * 3000 * i) / sampleRate);
        L[i] = v;
        if (R !== L) R[i] = v;
      }
      st.emitAt = currentTime;
      st.listening = true;
      st.latencyMs = -2;
    } else if (st.listening) {
      const thresh = Math.max(st.noiseFloor * 8, 0.02);
      for (let i = 0; i < framesToProcess; i++) {
        const a = inL[i];
        const m = a > 0 ? a : -a;
        if (m > thresh) {
          st.latencyMs = (currentTime + i / sampleRate - st.emitAt) * 1000;
          st.listening = false;
          break;
        }
      }
      if (st.listening && currentTime - st.emitAt > 1.0) {
        st.listening = false;
        st.latencyMs = -1;
      }
    }

    let op = 0;
    for (let i = 0; i < framesToProcess; i++) {
      const m = L[i] > 0 ? L[i] : -L[i];
      if (m > op) op = m;
    }
    st.outPeak = op > st.outPeak ? op : st.outPeak;

    const endMs = typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    const dur = endMs - nowMs;
    st.blocks++;
    st.accMs += dur;
    if (dur > st.peakMs) st.peakMs = dur;

    // ---- push to UI at ~8Hz. setBlocking takes a lock, so it must be rare.
    if (endMs - st.lastPush > 125) {
      st.lastPush = endMs;
      const budget = (framesToProcess / sampleRate) * 1000;
      const mean = st.blocks > 0 ? st.accMs / st.blocks : 0;
      const db = (x: number) => (x > 1e-6 ? 20 * Math.log10(x) : -120);
      metrics.setBlocking({
        running: true,
        sampleRate,
        blockSize: framesToProcess,
        blockMs: budget,
        cpuPct: (mean / budget) * 100,
        cpuPeakPct: (st.peakMs / budget) * 100,
        peakMs: st.peakMs,
        blocks: st.blocks,
        dropouts: st.dropouts,
        inPeakDb: db(st.inPeak),
        outPeakDb: db(st.outPeak),
        latencyMs: st.latencyMs,
        rackAlive: !!st.rack,
        error: st.err,
      });
      st.inPeak = 0;
      st.outPeak = 0;
    }
  };

  node = ctx.createWorkletProcessingNode(cb, "AudioRuntime");

  recorder = new AudioRecorder({ sampleRate, bufferLengthInSamples: 256 });
  const adapter = ctx.createRecorderAdapter();
  recorder.connect(adapter);
  adapter.connect(node);
  node.connect(ctx.destination);

  const res = await recorder.start();
  if (res && res.status === "error") {
    return { ok: false, error: `recorder.start: ${JSON.stringify(res)}` };
  }
  return { ok: true };
}

export async function stopSpike(): Promise<void> {
  try {
    await recorder?.stop?.();
  } catch {}
  try {
    recorder?.disconnect?.();
    node?.disconnect?.();
    await ctx?.close?.();
  } catch {}
  recorder = null;
  node = null;
  ctx = null;
  fallbackMetrics = { ...EMPTY };
  metricsBox?.setBlocking({ ...EMPTY });
}

export function resetCounters(): void {
  if (!metricsBox) return;
  const m = metricsBox.getDirty();
  metricsBox.setBlocking({ ...m, dropouts: 0, blocks: 0, cpuPeakPct: 0, peakMs: 0, latencyMs: -1 });
}
