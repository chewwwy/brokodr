/**
 * Bro.Kodr — BROBEATS sample store.
 *
 * Where a dropped, recorded or sliced sample's *audio* lives once it is on a pad.
 *
 * The kit document (`kit.ts`) is a few hundred bytes of settings and deliberately holds
 * no audio: it stores a `sampleId` per pad and nothing else. This module is the other
 * half of that bargain — the id resolves back to PCM here, so a kit survives a reload
 * with its sounds instead of coming back as a grid of greyed-out names.
 *
 * Two backends, chosen once at runtime:
 *
 *   - **Desktop (Electron): real files on disk.** `<Music>/Bro.Kodr/Samples/<id>.wav`,
 *     32-bit float mono, bit-exact with what the engine had, plus an `index.json`
 *     manifest. Real files because the user owns them: they open in any DAW, back up
 *     with the rest of their music, and survive the app being reinstalled. A profile
 *     database would hide them.
 *   - **Web: IndexedDB.** No filesystem, and localStorage is the wrong tool twice over —
 *     a few megabytes of PCM blows the 5 MB quota, and base64'ing Float32 to get it
 *     through a string column costs 33% and a full re-encode on every save.
 *
 * A third, in-memory backend catches the no-IndexedDB case (SSR, a locked-down browser,
 * the verification scripts under Node). It forgets everything on reload, which is
 * exactly what the app did before this module existed — so the degraded path is the old
 * behaviour rather than a crash.
 *
 * Everything here is async and failure-tolerant by design. Storage is a convenience, not
 * a correctness requirement: a quota error or a missing file must never stop a sample
 * reaching a pad, so writes report failure by returning null and reads by returning
 * null, and the caller carries on with the buffer it already has in memory.
 */

import { decodeWav, encodeWav } from "./recorder";
import { getDesktopAPI } from "../lib/desktop";

/** What is known about a stored sample without reading its audio back. */
export interface SampleMeta {
  id: string;
  /** Display name, usually the source file name or the take it was sliced from. */
  name: string;
  frames: number;
  sampleRate: number;
  /** Epoch ms. */
  createdAt: number;
  /** Size on disk / in the store, bytes. Zero when not known. */
  bytes: number;
}

export interface StoredSample {
  meta: SampleMeta;
  data: Float32Array;
}

export type SampleStoreKind = "disk" | "indexeddb" | "memory";

interface Backend {
  kind: SampleStoreKind;
  put(meta: SampleMeta, data: Float32Array): Promise<void>;
  get(id: string): Promise<StoredSample | null>;
  list(): Promise<SampleMeta[]>;
  remove(id: string): Promise<void>;
}

const DB_NAME = "brokodr";
const DB_VERSION = 1;
const STORE = "samples";
const INDEX_FILE = "index.json";

/**
 * Ids are opaque and stable, and deliberately not the file name: renaming a pad, or
 * dropping two files that happen to share a name, must not move or collide with audio
 * that is already stored. Time-ordered prefix so a directory listing sorts by age.
 */
export function newSampleId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `smp_${t}_${r}`;
}

// ------------------------------------------------------------------ backends

function memoryBackend(): Backend {
  const mem = new Map<string, StoredSample>();
  return {
    kind: "memory",
    async put(meta, data) {
      mem.set(meta.id, { meta, data });
    },
    async get(id) {
      const hit = mem.get(id);
      return hit ? { meta: hit.meta, data: hit.data } : null;
    },
    async list() {
      return [...mem.values()].map((s) => s.meta);
    },
    async remove(id) {
      mem.delete(id);
    },
  };
}

// --- IndexedDB

interface IdbRow extends SampleMeta {
  /** Stored as a typed array; structured clone handles it without a copy or a re-encode. */
  data: Float32Array;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
  });
}

function idbBackend(): Backend {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => (dbPromise ??= openDb());

  return {
    kind: "indexeddb",
    async put(meta, data) {
      const conn = await db();
      const tx = conn.transaction(STORE, "readwrite");
      const row: IdbRow = { ...meta, data };
      await idbRequest(tx.objectStore(STORE).put(row));
    },
    async get(id) {
      const conn = await db();
      const row = await idbRequest<IdbRow | undefined>(
        conn.transaction(STORE, "readonly").objectStore(STORE).get(id),
      );
      if (!row || !row.data) return null;
      const { data, ...meta } = row;
      return { meta, data: data instanceof Float32Array ? data : new Float32Array(data) };
    },
    async list() {
      const conn = await db();
      const rows = await idbRequest<IdbRow[]>(
        conn.transaction(STORE, "readonly").objectStore(STORE).getAll(),
      );
      return rows.map(({ data: _data, ...meta }) => meta);
    },
    async remove(id) {
      const conn = await db();
      await idbRequest(conn.transaction(STORE, "readwrite").objectStore(STORE).delete(id));
    },
  };
}

// --- Electron, real files

function diskBackend(api: NonNullable<ReturnType<typeof getDesktopAPI>>): Backend {
  let dirPromise: Promise<string> | null = null;
  const dir = () => (dirPromise ??= api.samplesDir!());

  // Every index write goes through one chain. Two samples sent to two pads in the same
  // tick would otherwise read the same manifest, and the second write would erase the
  // first — a read-modify-write race that only shows up when the user is being quick.
  let queue: Promise<unknown> = Promise.resolve();
  const serialise = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  const readIndex = async (): Promise<SampleMeta[]> => {
    try {
      const raw = await api.readFile(`${await dir()}/${INDEX_FILE}`);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as SampleMeta[]) : [];
    } catch {
      // Missing or corrupt manifest means "nothing catalogued yet". The .wav files are
      // still there and still readable by id, so this is recoverable rather than fatal.
      return [];
    }
  };

  return {
    kind: "disk",
    async put(meta, data) {
      const base = await dir();
      const blob = encodeWav(data, data, meta.sampleRate, 32, true);
      const bytes = await blob.arrayBuffer();
      await api.writeBinaryFile(`${base}/${meta.id}.wav`, bytes);
      await serialise(async () => {
        const rows = (await readIndex()).filter((r) => r.id !== meta.id);
        rows.push({ ...meta, bytes: bytes.byteLength });
        await api.writeFile(`${base}/${INDEX_FILE}`, JSON.stringify(rows, null, 2));
      });
    },
    async get(id) {
      const base = await dir();
      const bytes = await api.readBinaryFile!(`${base}/${id}.wav`);
      const wav = decodeWav(bytes);
      if (!wav) return null;
      const rows = await readIndex();
      const known = rows.find((r) => r.id === id);
      return {
        meta: known ?? {
          id,
          name: id,
          frames: wav.data.length,
          sampleRate: wav.sampleRate,
          createdAt: Date.now(),
          bytes: bytes.byteLength,
        },
        data: wav.data,
      };
    },
    async list() {
      return readIndex();
    },
    async remove(id) {
      const base = await dir();
      await serialise(async () => {
        const rows = (await readIndex()).filter((r) => r.id !== id);
        await api.writeFile(`${base}/${INDEX_FILE}`, JSON.stringify(rows, null, 2));
      });
      // The manifest entry is what the app reads, so it goes first; an undeletable file
      // is then just an orphan on disk rather than a sample that half-exists.
      try {
        await api.deleteFile!(`${base}/${id}.wav`);
      } catch {
        /* already gone, or locked — the manifest is authoritative */
      }
    },
  };
}

// -------------------------------------------------------------------- facade

let backend: Backend | null = null;

function pick(): Backend {
  if (backend) return backend;
  const api = getDesktopAPI();
  if (api && api.samplesDir && api.readBinaryFile && api.deleteFile) {
    backend = diskBackend(api);
  } else if (typeof indexedDB !== "undefined") {
    backend = idbBackend();
  } else {
    backend = memoryBackend();
  }
  return backend;
}

/** Which backend is live. Shown in the UI so "where did my samples go" has an answer. */
export function sampleStoreKind(): SampleStoreKind {
  return pick().kind;
}

/**
 * Stores a mono buffer and returns its metadata, or null if storage failed.
 *
 * Failure is not exceptional here — a full disk or a browser quota is a normal thing to
 * hit with audio — so it is a return value the caller can shrug at, not a throw that
 * would take a pad load down with it.
 */
export async function putSample(
  name: string,
  data: Float32Array,
  sampleRate: number,
  id: string = newSampleId(),
): Promise<SampleMeta | null> {
  const meta: SampleMeta = {
    id,
    name,
    frames: data.length,
    sampleRate,
    createdAt: Date.now(),
    bytes: data.length * 4,
  };
  try {
    await pick().put(meta, data);
    return meta;
  } catch (e) {
    console.warn("[brobeats] sample store write failed:", e);
    return null;
  }
}

/** Reads a sample back. Null when it was never stored, or the store is unreadable. */
export async function getSample(id: string): Promise<StoredSample | null> {
  if (!id) return null;
  try {
    return await pick().get(id);
  } catch {
    // A missing file on disk throws rather than resolving null; to the caller both mean
    // the same thing — that pad comes back empty and keeps its name.
    return null;
  }
}

/** Everything stored, newest first. */
export async function listSamples(): Promise<SampleMeta[]> {
  try {
    const rows = await pick().list();
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function removeSample(id: string): Promise<void> {
  try {
    await pick().remove(id);
  } catch (e) {
    console.warn("[brobeats] sample store delete failed:", e);
  }
}

/**
 * Drops everything no live kit points at, returning how many went.
 *
 * Clearing a pad deliberately does *not* delete its audio — the same id can sit on
 * several pads, and in several saved kits, so a delete on clear would pull a sound out
 * from under a kit the user hasn't opened in a month. Collection is therefore a separate,
 * explicit sweep over the ids that are actually referenced.
 */
export async function pruneSamples(keep: Iterable<string>): Promise<number> {
  const live = new Set(keep);
  const rows = await listSamples();
  let gone = 0;
  for (const row of rows) {
    if (live.has(row.id)) continue;
    await removeSample(row.id);
    gone++;
  }
  return gone;
}

/** Test seam: forces the next call to re-pick a backend. Used by the verification script. */
export function __resetSampleStore(): void {
  backend = null;
}
