/**
 * Bro.Kodr — preset browser.
 *
 * Factory banks are read-only and compiled in; user presets live in the database. Loading a
 * preset replaces the whole chain and the I/O stage in one command batch, so you never hear
 * a half-applied chain. Presets also import/export as `.vkpreset` files so they move
 * between machines.
 */

import { useMemo, useRef, useState } from "react";
import { decodePresetFile, encodePresetFile, migrateChain, presetFilename } from "../audio/preset-file";
import { FACTORY_PRESETS, PRESET_CATEGORIES } from "../audio/presets";
import { downloadBlob } from "../audio/recorder";
import { useEngine, useEngineState } from "../hooks/use-engine";
import { useCreatePreset, useDeletePreset, usePresets, useUpdatePreset } from "../queries/presets";

interface Row {
  key: string;
  /** Numeric id for stored presets, string id for factory ones. */
  storedId: number | null;
  factoryId: string | null;
  name: string;
  category: string;
  description: string;
  favorite: boolean;
}

export function PresetBrowser() {
  const client = useEngine();
  const { activePresetId, dirty } = useEngineState();
  const stored = usePresets();
  const create = useCreatePreset();
  const update = useUpdatePreset();
  const remove = useDeletePreset();

  const [filter, setFilter] = useState("");
  const [cat, setCat] = useState("All");
  const [note, setNote] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const rows = useMemo<Row[]>(() => {
    const all: Row[] = [
      ...FACTORY_PRESETS.map((p) => ({
        key: `f:${p.id}`,
        storedId: null,
        factoryId: p.id,
        name: p.name,
        category: p.category,
        description: p.description,
        favorite: false,
      })),
      ...(stored.data ?? []).map((p) => ({
        key: `u:${p.id}`,
        storedId: p.id,
        factoryId: null,
        name: p.name,
        category: p.category || "User",
        description: p.description || p.summary,
        favorite: p.favorite,
      })),
    ];
    const q = filter.trim().toLowerCase();
    return all.filter(
      (r) =>
        (cat === "All" || r.category === cat) &&
        (!q || r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)),
    );
  }, [stored.data, filter, cat]);

  const load = (row: Row) => {
    const chain = row.factoryId
      ? FACTORY_PRESETS.find((p) => p.id === row.factoryId)?.chain
      : stored.data?.find((p) => p.id === row.storedId)?.chain;
    if (!chain) return;
    client.loadChain(migrateChain(chain), row.key);
    setNote(null);
  };

  const saveCurrent = async () => {
    const current = rows.find((r) => r.key === activePresetId);
    const name = window.prompt("Preset name", current ? `${current.name} copy` : "New Preset");
    if (!name) return;
    try {
      const row = await create.mutateAsync({
        name,
        category: "User",
        description: "",
        basedOn: current?.name ?? null,
        chain: client.exportChain() as never,
      });
      client.markPreset(`u:${row!.id}`);
      setNote(`Saved “${name}”.`);
    } catch (e) {
      setNote(`Save failed: ${(e as Error).message}`);
    }
  };

  const overwrite = async (row: Row) => {
    if (row.storedId === null) return;
    try {
      await update.mutateAsync({ id: row.storedId, chain: client.exportChain() as never });
      client.markPreset(row.key);
      setNote(`Updated “${row.name}”.`);
    } catch (e) {
      setNote(`Update failed: ${(e as Error).message}`);
    }
  };

  const del = async (row: Row) => {
    if (row.storedId === null) return;
    if (!window.confirm(`Delete preset “${row.name}”? This cannot be undone.`)) return;
    await remove.mutateAsync({ id: row.storedId });
    if (activePresetId === row.key) client.markPreset(null);
  };

  const exportRow = (row: Row) => {
    const chain = row.factoryId
      ? FACTORY_PRESETS.find((p) => p.id === row.factoryId)?.chain
      : stored.data?.find((p) => p.id === row.storedId)?.chain;
    if (!chain) return;
    const text = encodePresetFile([
      { name: row.name, category: row.category, description: row.description, chain: migrateChain(chain) },
    ]);
    downloadBlob(new Blob([text], { type: "application/json" }), presetFilename(row.name));
  };

  const exportBank = () => {
    const list = stored.data ?? [];
    if (!list.length) return;
    const text = encodePresetFile(
      list.map((p) => ({
        name: p.name,
        category: p.category,
        description: p.description,
        chain: migrateChain(p.chain),
      })),
    );
    downloadBlob(new Blob([text], { type: "application/json" }), presetFilename("brokodr", true));
  };

  const onImport = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    const res = decodePresetFile(await file.text());
    if (res.error) {
      setNote(res.error);
      return;
    }
    let ok = 0;
    for (const p of res.presets) {
      try {
        await create.mutateAsync({
          name: p.name,
          category: p.category,
          description: p.description,
          basedOn: null,
          chain: p.chain as never,
        });
        ok++;
      } catch {
        // keep importing the rest of the bank
      }
    }
    setNote(`Imported ${ok} of ${res.presets.length} preset${res.presets.length === 1 ? "" : "s"}.`);
  };

  const categories = ["All", ...PRESET_CATEGORIES, "User"];
  const busy = create.isPending || update.isPending || remove.isPending;

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <input className="vk-input" placeholder="Search presets…" value={filter} onChange={(e) => setFilter(e.target.value)} />

      <div className="vk-scroll-x flex gap-[3px]">
        {categories.map((c) => (
          <button
            key={c}
            className="vk-btn vk-focus-ring shrink-0"
            data-active={cat === c}
            onClick={() => setCat(c)}
            style={{ fontSize: 9, padding: "2px 6px" }}
          >
            {c.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="flex min-h-0 flex-col gap-[2px] overflow-y-auto" style={{ maxHeight: 264 }}>
        {rows.length === 0 && (
          <div className="vk-label px-1 py-2" style={{ color: "var(--vk-text-dim)" }}>
            {stored.isLoading ? "Loading…" : "Nothing matches."}
          </div>
        )}
        {rows.map((r) => {
          const active = activePresetId === r.key;
          return (
            <div
              key={r.key}
              className="vk-well group flex items-center gap-1 px-2 py-[5px]"
              style={{ borderColor: active ? "var(--vk-amber)" : undefined, cursor: "pointer" }}
              onClick={() => load(r)}
              onKeyDown={(e) => e.key === "Enter" && load(r)}
              role="button"
              tabIndex={0}
              title={r.description || r.name}
            >
              <span className="vk-led" data-on={active} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px]" style={{ color: active ? "var(--vk-amber)" : "var(--vk-text)" }}>
                  {r.name}
                  {active && dirty && <span style={{ color: "var(--vk-amber)" }}> *</span>}
                </div>
                <div className="vk-label truncate" style={{ color: "var(--vk-text-dim)" }}>
                  {r.category}
                  {r.description ? ` — ${r.description}` : ""}
                </div>
              </div>
              <div className="flex shrink-0 gap-[2px] opacity-0 group-hover:opacity-100">
                <button
                  className="vk-btn vk-focus-ring"
                  style={{ fontSize: 9, padding: "1px 4px" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    exportRow(r);
                  }}
                  title="Export as .vkpreset"
                >
                  ↧
                </button>
                {r.storedId !== null && (
                  <>
                    <button
                      className="vk-btn vk-focus-ring"
                      style={{ fontSize: 9, padding: "1px 4px" }}
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void overwrite(r);
                      }}
                      title="Overwrite with the current chain"
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
                      title="Delete preset"
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-1">
        <button className="vk-btn vk-focus-ring justify-center" onClick={() => void saveCurrent()} disabled={busy}>
          SAVE AS…
        </button>
        <button className="vk-btn vk-focus-ring justify-center" onClick={() => fileRef.current?.click()} disabled={busy}>
          IMPORT
        </button>
        <button
          className="vk-btn vk-focus-ring justify-center"
          onClick={exportBank}
          disabled={!stored.data?.length}
          title="Export every user preset as one bank file"
        >
          EXPORT BANK
        </button>
        <button
          className="vk-btn vk-focus-ring justify-center"
          data-tone="danger"
          onClick={() => window.confirm("Clear the whole chain?") && client.clearChain()}
          title="Remove every module from the rack"
        >
          CLEAR CHAIN
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".vkpreset,application/json"
        className="hidden"
        onChange={(e) => void onImport(e.target.files?.[0])}
      />

      {stored.isError && (
        <div className="vk-well vk-mono px-2 py-1 text-[10px]" style={{ color: "var(--vk-amber)" }}>
          Preset storage is unreachable. Factory presets still load; saving is disabled.
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
