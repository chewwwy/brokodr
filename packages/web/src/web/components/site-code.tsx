/**
 * Marketing-site code block with a copy button.
 *
 * Docs pages live or die on whether the reader can get the command into a terminal
 * without transcription errors, so every shell snippet is copyable. Clipboard writes
 * can reject (insecure context, denied permission), so the failure is shown in the
 * button label rather than swallowed.
 */

import { useState } from "react";

export function CodeBlock({ lines, label }: { lines: string[]; label?: string }) {
  const [state, setState] = useState<"idle" | "ok" | "fail">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setState("ok");
    } catch {
      setState("fail");
    }
    setTimeout(() => setState("idle"), 1600);
  };

  return (
    <div className="group relative border border-[#3c4043]/60 bg-[#0b0d0e]">
      {label && (
        <div className="flex items-center justify-between border-b border-[#3c4043]/50 px-4 py-2">
          <span className="bk-eyebrow">{label}</span>
        </div>
      )}
      <button
        type="button"
        onClick={copy}
        className="bk-eyebrow absolute top-2 right-2 border border-[#3c4043] bg-black/60 px-2 py-1 text-[#79837a] transition-colors hover:border-[#35d6d0] hover:text-[#35d6d0]"
      >
        {state === "ok" ? "COPIED" : state === "fail" ? "COPY FAILED" : "COPY"}
      </button>
      <pre className="overflow-x-auto px-4 py-4 pr-24 text-[12px] leading-[1.85] text-[#f4f4f2]">
        <code style={{ fontFamily: "var(--font-mono)" }}>
          {lines.map((l) => (
            <span key={l} className="block">
              {l.startsWith("#") ? <span className="text-[#79837a]">{l}</span> : l}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/** A callout. `tone` carries the meaning: note = neutral, warn = read this or lose time. */
export function Callout({
  tone = "note",
  title,
  children,
}: {
  tone?: "note" | "warn";
  title: string;
  children: React.ReactNode;
}) {
  const accent = tone === "warn" ? "#ffb020" : "#35d6d0";
  return (
    <div
      className="border-l-2 bg-[#0b0d0e] px-5 py-4"
      style={{ borderLeftColor: accent, borderTop: "1px solid rgba(60,64,67,0.4)" }}
    >
      <p className="bk-eyebrow mb-2" style={{ color: accent }}>
        {tone === "warn" ? "⚠ " : ""}
        {title}
      </p>
      <div className="bk-body">{children}</div>
    </div>
  );
}
