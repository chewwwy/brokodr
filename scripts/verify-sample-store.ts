/**
 * Verification for the sample storage layer. Run with `bun scripts/verify-sample-store.ts`.
 *
 * Two things are worth proving here, and both of them are the kind of bug you only find
 * after a user has lost work:
 *
 *   1. **The WAV round trip is lossless.** The desktop backend keeps pad audio as real
 *      32-bit float .wav files, so `decodeWav(encodeWav(x))` has to give back exactly x.
 *      If it drifts, every kit reload quietly degrades the sound.
 *   2. **The store's contract holds.** put/get/list/remove/prune behave the same whichever
 *      backend is live, including the awkward parts: ids are opaque and unique, a missing
 *      id reads as null rather than throwing, and pruning keeps what a kit points at.
 *
 * Under Bun there is no IndexedDB and no Electron, so the store falls through to its
 * in-memory backend — which is the third backend and equally worth exercising, since it
 * is what a locked-down browser gets.
 */
import { decodeWav, encodeWav } from "../packages/web/src/web/audio/recorder";

// The store reaches for `window.electronAPI` to decide on a backend. There is no window
// here; a bare object is enough to make the check say "not desktop".
(globalThis as { window?: unknown }).window = {};

const {
  getSample,
  listSamples,
  newSampleId,
  pruneSamples,
  putSample,
  removeSample,
  sampleStoreKind,
} = await import("../packages/web/src/web/audio/sample-store");

const SR = 48000;
let checks = 0;
let failures = 0;

function ok(name: string, cond: boolean, detail = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  } else console.log(`ok    ${name} ${detail}`);
}

function tone(n: number, hz: number, amp = 0.5): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * hz * i) / SR);
  return a;
}

async function blobBytes(b: Blob): Promise<ArrayBuffer> {
  return b.arrayBuffer();
}

console.log("== wav: float round trip ==");
{
  const src = tone(4096, 440);
  const wav = decodeWav(await blobBytes(encodeWav(src, src, SR, 32, true)));
  ok("float32 mono decodes", !!wav);
  if (wav) {
    ok("float32: sample rate survives", wav.sampleRate === SR, `${wav.sampleRate}`);
    ok("float32: one channel", wav.channels === 1, `${wav.channels}`);
    ok("float32: frame count survives", wav.data.length === src.length, `${wav.data.length}`);
    // Bit-exact, not approximately: float WAV is the same IEEE754 the engine held.
    let worst = 0;
    for (let i = 0; i < src.length; i++) worst = Math.max(worst, Math.abs(wav.data[i] - src[i]));
    ok("float32: bit exact", worst === 0, `worst ${worst}`);
  }
}

console.log("\n== wav: integer depths and channel sum ==");
{
  const src = tone(2048, 220, 0.8);
  for (const depth of [16, 24] as const) {
    const wav = decodeWav(await blobBytes(encodeWav(src, src, SR, depth, true)));
    ok(`${depth}-bit decodes`, !!wav);
    if (!wav) continue;
    let worst = 0;
    for (let i = 0; i < src.length; i++) worst = Math.max(worst, Math.abs(wav.data[i] - src[i]));
    // Quantisation plus a full LSB of TPDF dither — the tolerance is the word length,
    // which is the point: nothing beyond dither is being added on the way through.
    const lsb = depth === 16 ? 1 / 32768 : 1 / 8388608;
    ok(`${depth}-bit: within a dithered LSB`, worst < lsb * 2.5, `worst ${worst.toExponential(2)}`);
    ok(`${depth}-bit: all finite`, wav.data.every(Number.isFinite));
  }

  // A stereo file must arrive summed to mono: the drum voice plays mono buffers.
  const l = new Float32Array(64).fill(0.5);
  const r = new Float32Array(64).fill(-0.1);
  const stereo = decodeWav(await blobBytes(encodeWav(l, r, SR, 32, false)));
  ok("stereo: decodes", !!stereo);
  if (stereo) {
    ok("stereo: reports two channels", stereo.channels === 2);
    ok("stereo: frames not doubled by interleaving", stereo.data.length === 64, `${stereo.data.length}`);
    ok("stereo: summed to the mean", Math.abs(stereo.data[0] - 0.2) < 1e-6, `${stereo.data[0]}`);
  }
}

console.log("\n== wav: malformed input ==");
{
  ok("empty buffer is rejected", decodeWav(new ArrayBuffer(0)) === null);
  ok("short buffer is rejected", decodeWav(new ArrayBuffer(20)) === null);
  const junk = new Uint8Array(128);
  junk.fill(7);
  ok("non-RIFF is rejected", decodeWav(junk.buffer) === null);

  // A LIST chunk ahead of `data` is what most DAWs write. Reading at a fixed offset 44
  // would hand back the metadata as audio, so the walker is load-bearing.
  const src = tone(256, 330);
  const plain = new Uint8Array(await blobBytes(encodeWav(src, src, SR, 32, true)));
  const listBytes = 16;
  const out = new Uint8Array(plain.length + 8 + listBytes);
  out.set(plain.subarray(0, 36), 0);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[36 + i] = "LIST".charCodeAt(i);
  dv.setUint32(40, listBytes, true);
  out.set(plain.subarray(36), 44 + listBytes);
  dv.setUint32(4, out.length - 8, true);
  const walked = decodeWav(out.buffer);
  ok("a LIST chunk before data is skipped", !!walked && walked.data.length === src.length);
  if (walked) {
    let worst = 0;
    for (let i = 0; i < src.length; i++) worst = Math.max(worst, Math.abs(walked.data[i] - src[i]));
    ok("chunk walk: audio still bit exact", worst === 0, `worst ${worst}`);
  }
}

console.log("\n== sample store: ids ==");
{
  const ids = new Set<string>();
  for (let i = 0; i < 500; i++) ids.add(newSampleId());
  ok("ids are unique across a burst", ids.size === 500, `${ids.size}/500`);
  ok("ids are prefixed", [...ids].every((id) => id.startsWith("smp_")));
  ok("ids are filename safe", [...ids].every((id) => /^[A-Za-z0-9_]+$/.test(id)));
}

console.log("\n== sample store: put / get / list / remove ==");
{
  ok("falls back to the in-memory backend here", sampleStoreKind() === "memory", sampleStoreKind());

  const a = tone(1000, 100);
  const metaA = await putSample("kick.wav", a, SR);
  ok("put returns metadata", !!metaA);
  ok("put records the frame count", metaA?.frames === 1000, `${metaA?.frames}`);
  ok("put records the sample rate", metaA?.sampleRate === SR);
  ok("put records the name", metaA?.name === "kick.wav");
  ok("put stamps a creation time", !!metaA && metaA.createdAt > 0);

  const back = await getSample(metaA!.id);
  ok("get returns the sample", !!back);
  ok("get returns the same length", back?.data.length === 1000, `${back?.data.length}`);
  ok("get returns the same audio", !!back && back.data.every((v, i) => v === a[i]));

  ok("an unknown id reads as null, not a throw", (await getSample("smp_nope")) === null);
  ok("an empty id reads as null", (await getSample("")) === null);

  const metaB = await putSample("snare.wav", tone(500, 200), SR);
  const rows = await listSamples();
  ok("list sees both", rows.length === 2, `${rows.length}`);
  ok("list is newest first", rows[0].createdAt >= rows[1].createdAt);

  // Writing the same id twice replaces rather than duplicates — that is what makes a
  // re-edit of the same pad idempotent instead of doubling the library.
  await putSample("kick.wav", tone(777, 100), SR, metaA!.id);
  const rows2 = await listSamples();
  ok("re-putting an id replaces it", rows2.length === 2, `${rows2.length}`);
  ok("re-putting an id updates the audio", (await getSample(metaA!.id))?.data.length === 777);

  await removeSample(metaB!.id);
  ok("remove drops it from the list", (await listSamples()).length === 1);
  ok("remove makes it unreadable", (await getSample(metaB!.id)) === null);
  ok("removing an unknown id is a no-op", (await removeSample("smp_nope"), true));
}

console.log("\n== sample store: pruning ==");
{
  const keep = await putSample("keep.wav", tone(64, 440), SR);
  const drop1 = await putSample("drop1.wav", tone(64, 440), SR);
  const drop2 = await putSample("drop2.wav", tone(64, 440), SR);
  ok("three more are stored", (await listSamples()).length >= 3);

  const gone = await pruneSamples([keep!.id]);
  const left = await listSamples();
  ok("prune removes everything unreferenced", left.length === 1, `${left.length} left, ${gone} pruned`);
  ok("prune keeps what the kit points at", left[0].id === keep!.id);
  ok("pruned audio is gone", (await getSample(drop1!.id)) === null && (await getSample(drop2!.id)) === null);
  ok("prune is idempotent", (await pruneSamples([keep!.id])) === 0);
  ok("pruning with nothing referenced empties the store", (await pruneSamples([])) === 1);
  ok("the store is empty afterwards", (await listSamples()).length === 0);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
