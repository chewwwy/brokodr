/**
 * Bro.Kodr — BROBEATS kit browser.
 *
 * The counterpart to the rack's preset browser: named snapshots of the whole sixteen-pad
 * kit, stored in the database. There is no factory bank here — the stock kit is what
 * RESET KIT on the pad grid gives you, so every row in this list is the user's own.
 *
 * Two things are deliberately different from presets:
 *
 * 1. **Audio does not live in the row.** A kit stores each sample pad's `sampleId`, a
 *    reference into the sample store, not the samples themselves. Loading a kit therefore
 *    restores the pads' audio only when those samples are still on this machine, so the
 *    panel checks the store after a load and says plainly how many pads came up silent
 *    rather than leaving you tapping a dead pad wondering why.
 * 2. **No file import/export.** A `.vkkit` that carried settings but no audio would be a
 *    trap, and one that carried audio is a different feature (a kit archive) with its own
 *    design. Until that exists, kits stay where their samples are.
 */

import { useMemo, useState } from "react";
import { listSamples } from "../../audio/sample-store";
import { useEngine, useEngineState } from "../../hooks/use-engine";
import { useCreateKit, useDeleteKit, useKits, useUpdateKit, type StoredKit } from "../../queries/kits";

/** "3 minutes ago" style stamp, short enough for a list row. */
function ago(when: Date): string {
  const ms = Date.now() - new Date(when).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/** Count of pads carrying audio, for the row's second line. */
function padCounts(kit: StoredKit["kit"]): { synth: number; sample: number } {
  let synth = 0;
  let sample = 0;
  for (const p of kit.pads) {
    if (p.source.kind === "synth") synth++;
    else if (p.source.kind === "sample") sample++;
  }
  return { synth, sample };
}

export function KitBrowser() {
  const client = useEngine();
  const { kit } = useEngineState();
  const stored = useKits();
  const create = useCreateKit();
  const update = useUpdateKit();
  const remove = useDeleteKit();

  const [filter, setFilter] = useState("");
  const [favesOnly, setFavesOnly] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Which stored kit the pads currently came from. Local to the panel rather than on the
  // engine: it is a browser affordance ("this is the one you loaded"), not engine state,
  // and the panel stays mounted across tab switches so it survives everywhere it matters.
  const [activeId, setActiveId] = useState<number | null>(null);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (stored.data ?? []).filter(
      (k) =>
        (!favesOnly || k.favorite) &&
        (!q ||
          k.name.toLowerCase().includes(q) ||
          k.description.toLowerCase().includes(q) ||
          k.summary.toLowerCase().includes(q)),
    );
  }, [stored.data, filter, favesOnly]);

  const busy = create.isPending || update.isPending || remove.isPending;

  /**
   * Loads the kit, then reports how many of its sample pads had no audio in the store.
   * Checked after the load rather than before so the answer describes what you are now
   * hearing, and so a kit whose samples are all present says nothing at all.
   */
  const load = async (row: StoredKit) => {
    setNote(null);
    try {
      await client.loadKit(row.kit);
      setActiveId(row.id);
      const wanted = row.kit.pads.filter((p) => p.source.kind === "sample" && p.source.sampleId);
      if (wanted.length) {
        const have = new Set((await listSamples()).map((m) => m.id));
        const missing = wanted.filter((p) => !have.has(p.source.sampleId!)).length;
        setNote(
          missing
            ? `Loaded “${row.name}”. ${missing} sample pad${missing === 1 ? "" : "s"} silent — that audio is not on this machine.`
            : `Loaded “${row.name}”.`,
        );
      } else {
        setNote(`Loaded “${row.name}”.`);
      }
    } catch (e) {
      setNote(`Load failed: ${(e as Error).message}`);
    }
  };

  const saveAs = async () => {
    const name = window.prompt("Kit name", kit.name || "New Kit");
    if (!name) return;
    // The document's own name follows the row's, so a kit exported or reloaded later
    // still calls itself what the list calls it.
    client.setKitName(name);
    try {
      const row = await create.mutateAsync({
        name,
        category: "User",
        description: "",
        kit: client.exportKit() as never,
      });
      if (row) setActiveId(row.id);
      setNote(`Saved “${name}”.`);
    } catch (e) {
      setNote(`Save failed: ${(e as Error).message}`);
    }
  };

  const overwrite = async (row: StoredKit) => {
    if (!window.confirm(`Overwrite “${row.name}” with the kit on the pads?`)) return;
    try {
      await update.mutateAsync({ id: row.id, kit: client.exportKit() as never });
      setActiveId(row.id);
      setNote(`Updated “${row.name}”.`);
    } catch (e) {
      setNote(`Update failed: ${(e as Error).message}`);
    }
  };

  const rename = async (row: StoredKit) => {
    const name = window.prompt("Rename kit", row.name);
    if (!name || name === row.name) return;
    try {
      await update.mutateAsync({ id: row.id, name });
      if (activeId === row.id) client.setKitName(name);
      setNote(`Renamed to “${name}”.`);
    } catch (e) {
      setNote(`Rename failed: ${(e as Error).message}`);
    }
  };

  const toggleFave = async (row: StoredKit) => {
    try {
      await update.mutateAsync({ id: row.id, favorite: !row.favorite });
    } catch (e) {
      setNote(`Update failed: ${(e as Error).message}`);
    }
  };

  const del = async (row: StoredKit) => {
    // Deleting a kit deliberately leaves its samples in the store: another kit, or the
    // pads right now, may be playing the same audio.
    if (!window.confirm(`Delete kit “${row.name}”? The pads keep playing what they have.`)) return;
    try {
      await remove.mutateAsync({ id: row.id });
      if (activeId === row.id) setActiveId(null);
      setNote(`Deleted “${row.name}”.`);
    } catch (e) {
      setNote(`Delete failed: ${(e as Error).message}`);
    }
  };

  return (
    <div className="vk-panel flex min-h-0 flex-col gap-2 p-2">
      <div className="flex items-center gap-2">
        <span className="vk-label" style={{ color: "var(--vk-violet)" }}>
          KIT LIBRARY
        </span>
        <span className="vk-label truncate" style={{ color: "var(--vk-text-dim)" }}>
          on the pads now: {kit.name || "untitled"}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <input
          className="vk-input min-w-0 flex-1"
          placeholder="Search kits…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          className="vk-btn vk-focus-ring shrink-0"
          data-active={favesOnly}
          style={{ fontSize: 9, padding: "2px 7px" }}
          onClick={() => setFavesOnly((v) => !v)}
          title="Show favourites only"
        >
          ★
        </button>
      </div>

      <div className="flex min-h-0 flex-col gap-[2px] overflow-y-auto" style={{ maxHeight: 300 }}>
        {rows.length === 0 && (
          <div className="vk-label px-1 py-2" style={{ color: "var(--vk-text-dim)" }}>
            {stored.isLoading
              ? "Loading…"
              : (stored.data?.length ?? 0) === 0
                ? "No saved kits yet. Build one on the pads, then SAVE AS…"
                : "Nothing matches."}
          </div>
        )}
        {rows.map((r) => {
          const active = activeId === r.id;
          const counts = padCounts(r.kit);
          return (
            <div
              key={r.id}
              className="vk-well group flex items-center gap-1 px-2 py-[5px]"
              style={{ borderColor: active ? "var(--vk-violet)" : undefined, cursor: "pointer" }}
              onClick={() => void load(r)}
              onKeyDown={(e) => e.key === "Enter" && void load(r)}
              role="button"
              tabIndex={0}
              title={r.summary || r.name}
            >
              <span className="vk-led" data-tone="cyan" data-on={active} />
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-[11px]"
                  style={{ color: active ? "var(--vk-violet)" : "var(--vk-text)" }}
                >
                  {r.favorite ? "★ " : ""}
                  {r.name}
                </div>
                <div className="vk-label truncate" style={{ color: "var(--vk-text-dim)" }}>
                  {counts.synth} synth · {counts.sample} sample · {ago(r.updatedAt)}
                  {r.description ? ` — ${r.description}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 gap-[2px] opacity-0 group-hover:opacity-100">
                <button
                  className="vk-btn vk-focus-ring"
                  data-active={r.favorite}
                  style={{ fontSize: 9, padding: "1px 4px" }}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void toggleFave(r);
                  }}
                  title="Favourite — favourites sort to the top"
                >
                  ★
                </button>
                <button
                  className="vk-btn vk-focus-ring"
                  style={{ fontSize: 9, padding: "1px 4px" }}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void rename(r);
                  }}
                  title="Rename"
                >
                  ✎
                </button>
                <button
                  className="vk-btn vk-focus-ring"
                  style={{ fontSize: 9, padding: "1px 4px" }}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void overwrite(r);
                  }}
                  title="Overwrite with the kit on the pads"
                >
                  SAVE
                </button>
                <button
                  className="vk-btn vk-focus-ring"
                  data-tone="danger"
                  style={{ fontSize: 9, padding: "1px 4px" }}
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void del(r);
                  }}
                  title="Delete kit"
                >
                  ✕
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button
        className="vk-btn vk-focus-ring justify-center"
        onClick={() => void saveAs()}
        disabled={busy}
        title="Store the sixteen pads, their voices and their effects under a name"
      >
        SAVE AS…
      </button>

      {stored.isError && (
        <div className="vk-well vk-mono px-2 py-1 text-[10px]" style={{ color: "var(--vk-amber)" }}>
          Kit storage is unreachable. The pads still work; saving and loading are disabled.
        </div>
      )}

      {note && (
        <div className="vk-well vk-mono px-2 py-1 text-[10px]" style={{ color: "var(--vk-text-mid)" }}>
          {note}
        </div>
      )}
    </div>
  );
}
