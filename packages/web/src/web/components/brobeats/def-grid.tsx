/**
 * Bro.Kodr — generic parameter grid.
 *
 * Renders any `ParamDef[]` against a plain value bag, grouping by the defs' own `group`
 * field. The rack has its own version bound to `SlotState`; the things this one serves —
 * a pad's voice params, a pad effect's params, a loop lane effect's params — are not
 * slots, so it takes the defs and the values separately.
 *
 * It lived inside the pad editor until the loop deck needed the identical grid for its
 * lane chains. Nothing about it changed in the move.
 */

import { useMemo } from "react";
import type { ParamDef } from "../../audio/param-schema";
import { Knob, SelectControl, Toggle } from "../controls";

export function DefGrid({
  defs,
  values,
  onChange,
  size = 40,
  accent,
}: {
  defs: ParamDef[];
  values: Record<string, number>;
  onChange: (key: string, value: number) => void;
  size?: number;
  accent?: string;
}) {
  const groups = useMemo(() => {
    const out: { name: string | null; params: ParamDef[] }[] = [];
    for (const p of defs) {
      const name = p.group ?? null;
      const last = out[out.length - 1];
      if (last && last.name === name) last.params.push(p);
      else out.push({ name, params: [p] });
    }
    return out;
  }, [defs]);

  return (
    <div className="flex flex-col gap-[6px]">
      {groups.map((g, gi) => (
        <div key={`${g.name ?? "x"}-${gi}`} className="flex flex-col gap-[2px]">
          {g.name && (
            <div
              className="vk-label"
              style={{ color: "var(--vk-text-dim)", borderBottom: "1px solid var(--vk-line)", paddingBottom: 2 }}
            >
              {g.name}
            </div>
          )}
          <div className="flex flex-wrap items-start gap-x-[2px] gap-y-1">
            {g.params.map((p) => {
              const value = values[p.key] ?? p.def;
              if (p.kind === "toggle") {
                return (
                  <div key={p.key} style={{ width: 92 }}>
                    <Toggle label={p.label} on={value >= 0.5} onChange={(v) => onChange(p.key, v ? 1 : 0)} />
                  </div>
                );
              }
              if (p.kind === "select") {
                return (
                  <div key={p.key} className="flex" style={{ width: 104 }}>
                    <SelectControl def={p} value={value} onChange={(v) => onChange(p.key, v)} />
                  </div>
                );
              }
              return (
                <Knob
                  key={p.key}
                  def={p}
                  value={value}
                  size={size}
                  skin="metal"
                  {...(accent ? { accent } : {})}
                  onChange={(v) => onChange(p.key, v)}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default DefGrid;
