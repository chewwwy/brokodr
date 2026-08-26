/**
 * Bro.Kodr docs — /docs
 *
 * The README's install / build / Windows-installer sections as a readable page, in the
 * marketing site's visual language (see design.md → "Marketing Site"). Same reasoning as
 * /site: this page owns its own scroll container because the app sets `overflow: hidden`
 * on html/body/#root for the instrument UI.
 *
 * Content is deliberately a mirror of README.md rather than a rewrite — including the
 * caveats. A docs page that quietly drops "the installer must be built on Windows" would
 * cost the reader an afternoon.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { CodeBlock, Callout } from "../components/site-code";

const SECTIONS = [
  { id: "install", n: "01", label: "INSTALL" },
  { id: "run", n: "02", label: "RUN IT" },
  { id: "build", n: "03", label: "BUILD" },
  { id: "exe", n: "04", label: "WINDOWS .EXE" },
  { id: "blank", n: "05", label: "TROUBLESHOOTING" },
  { id: "verify", n: "06", label: "VERIFY DSP" },
  { id: "commands", n: "07", label: "COMMANDS" },
];

const COMMANDS: [string, string][] = [
  ["bun run dev", "Web app dev server — http://localhost:4200"],
  ["bun run dev:desktop", "Electron shell, loads the dev server"],
  ["bun run build", "Typecheck + build everything"],
  ["bun run start / stop", "Production server under pm2"],
  ["bun run lint / typecheck", "Static checks"],
  ["bun run db:push", "Create / sync the presets table"],
  ["bun run db:generate", "Generate migration files"],
  ["bun run db:migrate", "Run migrations"],
  ["node scripts/verify-dsp.mjs", "Numeric DSP harness — 182 checks"],
];

export default function Docs() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState("install");

  // Active TOC entry = the last heading above the fold. One passive listener on the
  // container; no IntersectionObserver needed for seven static anchors.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      let current = SECTIONS[0].id;
      for (const s of SECTIONS) {
        const node = document.getElementById(s.id);
        if (node && node.getBoundingClientRect().top < 160) current = s.id;
      }
      setActive(current);
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  const toc = useMemo(() => SECTIONS, []);

  return (
    <div ref={scrollRef} className="bk-site">
      {/* ---------------------------------------------------------- nav */}
      <header className="sticky top-0 z-30 border-b border-[#3c4043]/50 bg-black/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center justify-between px-6 md:px-10">
          <div className="flex items-baseline gap-10">
            <Link href="/site" className="bk-eyebrow tracking-[0.2em] hover:text-[#f4f4f2]">
              BRO.KODR
            </Link>
            <span className="bk-eyebrow tracking-[0.16em] text-[#35d6d0]">DOCS</span>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/site" className="bk-eyebrow bk-link tracking-[0.16em]">
              ← SITE
            </Link>
            <Link
              href="/"
              className="bk-eyebrow border border-[#3c4043] px-3 py-1.5 tracking-[0.16em] text-[#9aa39b] transition-colors hover:border-[#35d6d0] hover:text-[#35d6d0]"
            >
              [ OPEN THE RACK ]
            </Link>
          </div>
        </div>
      </header>

      {/* ---------------------------------------------------------- masthead */}
      <section className="bk-hud border-b border-[#3c4043]/50">
        <div className="mx-auto max-w-[1600px] px-6 py-24 md:px-10">
          <p className="bk-eyebrow mb-5 tracking-[0.3em]">DOCUMENTATION · V1</p>
          <h1 className="bk-h max-w-[20ch] text-[11vw] md:text-[64px]">
            Install, build, ship the installer.
          </h1>
          <p className="bk-body mt-8 max-w-[54ch]">
            Everything needed to get Bro.Kodr running from a clean checkout, and to produce the
            signed Windows installer. Commands are copyable. Caveats are stated, not buried.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------- body */}
      <div className="mx-auto grid max-w-[1600px] gap-16 px-6 py-20 md:px-10 lg:grid-cols-[220px_1fr] lg:gap-24">
        {/* TOC */}
        <aside className="hidden lg:block">
          <div className="sticky top-28">
            <p className="bk-eyebrow mb-5 tracking-[0.3em]">CONTENTS</p>
            <nav className="flex flex-col">
              {toc.map((s) => (
                <a
                  key={s.id}
                  href={`#${s.id}`}
                  className="flex items-baseline gap-3 border-b border-[#3c4043]/30 py-3 text-[11px] tracking-[0.1em] transition-colors"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: active === s.id ? "#35d6d0" : "#79837a",
                  }}
                >
                  <span className="opacity-60">{s.n}</span>
                  {s.label}
                </a>
              ))}
            </nav>
          </div>
        </aside>

        {/* Content */}
        <main className="min-w-0 max-w-[74ch]">
          <Doc id="install" n="01" title="Install">
            <p className="bk-body">
              One requirement: <Mono>Bun 1.3+</Mono>. It installs the Node-compatible tooling
              itself, so there is no separate Node or npm step. Windows 10/11 is needed only for
              the desktop build — the web app runs anywhere Chromium does.
            </p>
            <CodeBlock
              label="CLEAN CHECKOUT"
              lines={[
                "bun install",
                "",
                "# create the presets table (SQLite / LibSQL)",
                "cd packages/web && bun run db:push",
                "cd ../..",
              ]}
            />
            <Callout title="Secrets live in one place">
              All environment variables go in the root <Mono>.env</Mono>. Bun and Vite load it
              automatically — no dotenv, and no <Mono>.env.local</Mono>. Deployments ship only{" "}
              <Mono>.env</Mono>, so values anywhere else work in dev and silently vanish in
              production.
            </Callout>
          </Doc>

          <Doc id="run" n="02" title="Run it">
            <CodeBlock
              label="DEV SERVERS"
              lines={[
                "bun run dev            # web app  -> http://localhost:4200",
                "bun run dev:desktop    # Electron shell, loads the dev server",
              ]}
            />
            <p className="bk-body">
              Press <Mono>ENGAGE</Mono> in the top bar, grant microphone access, then pick your
              input and output device in the <Mono>AUDIO DEVICE</Mono> panel on the left.
            </p>
            <Callout tone="warn" title="Wear headphones">
              Monitoring a live microphone through speakers will feed back. The output limiter
              protects the signal, not your ears.
            </Callout>
            <p className="bk-body">
              Cross-origin isolation headers (<Mono>COOP: same-origin</Mono>,{" "}
              <Mono>COEP: credentialless</Mono>) are set in both the Vite dev server and the Hono
              production server. Without them <Mono>SharedArrayBuffer</Mono> is unavailable and the
              engine falls back to a slower <Mono>postMessage</Mono> transport.
            </p>
          </Doc>

          <Doc id="build" n="03" title="Build">
            <CodeBlock
              label="TYPECHECK + BUILD"
              lines={["bun run build"]}
            />
            <p className="bk-body">
              This typechecks and builds the web app, then copies <Mono>packages/web/dist</Mono>{" "}
              into <Mono>packages/desktop/web-dist</Mono>. It is the gate: if this fails, nothing
              ships.
            </p>
          </Doc>

          <Doc id="exe" n="04" title="Windows .exe">
            <CodeBlock
              label="INSTALLER — RUN IN THIS ORDER"
              lines={[
                "bun run build          # produces packages/web/dist",
                "cd packages/desktop",
                "bun run dist           # electron-builder -> release/<version>/",
              ]}
            />
            <p className="bk-body">
              Order matters. <Mono>bun run dist</Mono> re-runs the copy step itself, but it needs{" "}
              <Mono>packages/web/dist</Mono> to already exist — the root <Mono>bun run build</Mono>{" "}
              is what produces it.
            </p>
            <p className="bk-body">
              Output is <Mono>Bro.Kodr-Windows-&lt;version&gt;-Setup.exe</Mono> (NSIS installer, x64
              and ia32) plus a portable build. Configuration lives in{" "}
              <Mono>packages/desktop/electron-builder.json5</Mono>.
            </p>
            <Callout tone="warn" title="The installer must be produced on Windows">
              electron-builder cannot cross-compile a Windows installer from Linux without Wine,
              and a code-signed one not at all. This repo builds and runs on Linux; the{" "}
              <Mono>.exe</Mono> step is configured but has never been executed here. Run it on a
              Windows machine, or on a <Mono>windows-latest</Mono> CI runner.
            </Callout>
            <Callout tone="warn" title="Set the protocol scheme before packaging">
              Set <Mono>protocols[0].schemes</Mono> to your real{" "}
              <Mono>runable-&lt;applicationId&gt;</Mono> before packaging, or deep links and desktop
              sign-in will not work in the packaged build. Dev builds register the protocol at
              runtime, so this failure only appears after packaging.
            </Callout>
          </Doc>

          <Doc id="blank" n="05" title="If the packaged app opens a blank window">
            <p className="bk-body">
              This was a real bug and is fixed. If it reappears, these are the causes in order of
              likelihood.
            </p>
            <ol className="mt-6 flex flex-col gap-5">
              {[
                [
                  "A dev instance is already running.",
                  "The app takes a single-instance lock, so launching the installed .exe while bun run dev:desktop is open makes the second one hand its arguments over and exit immediately — which looks like a window that never appears. Close the dev app first. The main process logs [brokodr] isPackaged=… gotLock=… on startup; gotLock=false is this case.",
                ],
                [
                  "The build skipped the copy step.",
                  "packages/desktop/web-dist must exist and contain index.html plus the whole dsp/ tree. The app now detects this and prints an on-screen explanation instead of showing nothing.",
                ],
                [
                  "Anything else.",
                  "The window renders a Bro.Kodr — STARTUP FAILED diagnostic with the underlying Chromium error rather than staying blank.",
                ],
              ].map(([head, body], i) => (
                <li key={head} className="flex gap-5 border-b border-[#3c4043]/40 pb-5">
                  <span className="bk-eyebrow shrink-0 pt-1 text-[#35d6d0]">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <p className="mb-1 text-[13px] text-[#f4f4f2]" style={{ fontFamily: "var(--font-mono)" }}>
                      {head}
                    </p>
                    <p className="bk-body">{body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </Doc>

          <Doc id="verify" n="06" title="Verify the DSP">
            <CodeBlock label="NUMERIC HARNESS" lines={["node scripts/verify-dsp.mjs   # 182/182 checks"]} />
            <p className="bk-body">
              It measures rather than asserting on faith: a +12 dB bell at 1 kHz reads 12.00 dB, a
              500 Hz high-pass attenuates 50 Hz by 80.4 dB, a 4:1 compressor produces 6.48 dB of
              gain reduction at the tested level, the limiter never exceeds its ceiling, a 4-bit
              crush yields exactly 27 distinct codes, delay taps land on the sample, pitch shifts
              land on the semitone, and the chain is bit-transparent when bypassed.
            </p>
            <p className="bk-body">
              It runs in bare Node because the DSP core touches no <Mono>AudioContext</Mono>, no
              DOM and no Node API — sample rate is passed in explicitly and every effect operates
              on plain <Mono>Float32Array</Mono> blocks.
            </p>
          </Doc>

          <Doc id="commands" n="07" title="Commands">
            <dl className="border-t border-[#3c4043]/60">
              {COMMANDS.map(([cmd, purpose]) => (
                <div
                  key={cmd}
                  className="grid gap-2 border-b border-[#3c4043]/40 py-4 sm:grid-cols-[minmax(0,260px)_1fr] sm:gap-8"
                >
                  <dt className="text-[12px] text-[#35d6d0]" style={{ fontFamily: "var(--font-mono)" }}>
                    {cmd}
                  </dt>
                  <dd className="bk-body">{purpose}</dd>
                </div>
              ))}
            </dl>
            <p className="bk-body mt-8">
              The server listens on <Mono>$PORT</Mono> with a health endpoint at{" "}
              <Mono>/api/health</Mono>.
            </p>
          </Doc>
        </main>
      </div>

      <footer className="border-t border-[#3c4043]/50 bg-black py-14">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-6 px-6 md:px-10">
          <span className="bk-eyebrow tracking-[0.2em]">BRO.KODR · DOCS</span>
          <span className="bk-eyebrow">KANE BATEMAN · AUSTRALIA</span>
          <span className="bk-eyebrow opacity-50">© 2026</span>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ bits */

function Doc({
  id,
  n,
  title,
  children,
}: {
  id: string;
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28 border-t border-[#3c4043]/50 py-14 first:border-t-0 first:pt-0">
      <p className="bk-eyebrow mb-4 tracking-[0.3em]">{n}</p>
      <h2 className="bk-h mb-8 text-[7.5vw] md:text-[36px]">{title}</h2>
      <div className="flex flex-col gap-7">{children}</div>
    </section>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code
      className="border border-[#3c4043]/60 bg-[#0b0d0e] px-1.5 py-0.5 text-[11px] text-[#f4f4f2]"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {children}
    </code>
  );
}
