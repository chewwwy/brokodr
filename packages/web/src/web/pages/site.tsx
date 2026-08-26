/**
 * Bro.Kodr marketing site — /site
 *
 * Deliberately separate from the instrument at `/`. The app is a fixed-viewport,
 * scroll-free control surface; this is the opposite — a full-bleed scrolling page.
 * Layout and rhythm are ported from the reference (midnightrebels.com): monospace-led,
 * near-monochrome, giant condensed uppercase headlines, faint technical HUD decoration.
 *
 * The page owns its own scroll container (`.bk-site`) because the app sets
 * `overflow: hidden` on html/body/#root — the site cannot rely on document scroll.
 * That container ref is also what drives the logo choreography in <SiteLogo />.
 */

import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { SiteLogo } from "../components/site-logo";

/* ------------------------------------------------------------------ content */

const NAV = [
  { label: "FEATURES", href: "#features" },
  { label: "EFFECTS", href: "#effects" },
  { label: "DOWNLOAD", href: "#download" },
  { label: "DOCS", href: "/docs" },
];

type Feature = {
  index: string;
  eyebrow: string;
  title: string;
  body: string;
  specs: [string, string][];
  image: string;
};

const FEATURES: Feature[] = [
  {
    index: "01",
    eyebrow: "SIGNAL PATH",
    title: "Twenty-two modules. One live chain.",
    body: "Drag modules into any order and hear the change immediately. Every stage runs hand-written DSP on the audio thread — no browser effect nodes, no allocation in the callback, no dropouts. Nonlinear stages oversample four times so drive stays clean instead of aliasing.",
    specs: [
      ["MODULES", "22"],
      ["ROUTING", "FREE ORDER"],
      ["OVERSAMPLING", "4× NONLINEAR"],
      ["PARAM TRANSPORT", "LOCK-FREE RING"],
    ],
    image: "/images/render-rack_1787700788354.png",
  },
  {
    index: "02",
    eyebrow: "VOICE",
    title: "Vocoder and talk box, carrier-fed.",
    body: "A classic band vocoder and a true talk-box model, both fed from any carrier you like — an oscillator, a loaded file, or the Voice Lab's generated speech. Formant tracking follows the modulator envelope per band, so consonants stay intelligible instead of smearing into a pad.",
    specs: [
      ["VOCODER BANDS", "SELECTABLE"],
      ["CARRIER SOURCE", "OSC / FILE / TTS"],
      ["TALK BOX", "PHYSICAL MODEL"],
      ["LATENCY", "BLOCK-ALIGNED"],
    ],
    image: "/images/render-vocoder_1787701085320.png",
  },
  {
    index: "03",
    eyebrow: "CONTROL",
    title: "MIDI on every knob.",
    body: "Learn any continuous controller to any parameter in two clicks. Mappings live in the preset, so a rig travels with the sound. Program-change messages recall presets, which means the whole rack is playable from a foot controller without touching the screen.",
    specs: [
      ["MIDI IN", "WEB MIDI"],
      ["CC LEARN", "PER PARAM"],
      ["PROGRAM CHANGE", "PRESET RECALL"],
      ["STORED IN", "PRESET FILE"],
    ],
    image: "/images/render-midi_1787701085320.png",
  },
];

const EFFECTS: [string, string][] = [
  ["PARAMETRIC EQ", "TONE"],
  ["COMPRESSOR", "DYNAMICS"],
  ["LIMITER", "DYNAMICS"],
  ["NOISE GATE", "DYNAMICS"],
  ["TRANSIENT SHAPER", "DYNAMICS"],
  ["DISTORTION", "DRIVE"],
  ["SATURATION", "DRIVE"],
  ["BIT CRUSHER", "DRIVE"],
  ["PITCH + FORMANT", "VOICE"],
  ["VOCODER", "VOICE"],
  ["TALK BOX", "VOICE"],
  ["CHARACTER", "VOICE"],
  ["CHORUS", "MODULATION"],
  ["FLANGER", "MODULATION"],
  ["PHASER", "MODULATION"],
  ["TREMOLO", "MODULATION"],
  ["RING MODULATOR", "MODULATION"],
  ["FREQUENCY SHIFTER", "MODULATION"],
  ["DELAY", "TIME"],
  ["REVERB", "TIME"],
  ["GLITCH", "FX"],
  ["NOISE GENERATOR", "FX"],
];

/* ------------------------------------------------------------------ page */

export default function Site() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [docked, setDocked] = useState(false);

  // Nav background only appears once the logo has docked. One listener, passive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => setDocked(el.scrollTop > window.innerHeight * 0.55);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div ref={scrollRef} className="bk-site">
      <SiteLogo containerRef={scrollRef} />

      {/* ---------------------------------------------------------- nav */}
      <header
        className="fixed inset-x-0 top-0 z-30 transition-colors duration-500"
        style={{
          background: docked ? "rgba(0,0,0,0.82)" : "transparent",
          backdropFilter: docked ? "blur(14px)" : "none",
          borderBottom: docked ? "1px solid rgba(60,64,67,0.5)" : "1px solid transparent",
        }}
      >
        {/* Links sit left, beside the wordmark: the centre of the bar belongs to the
            docked logo, so nothing may occupy it. */}
        <div className="mx-auto flex h-24 max-w-[1600px] items-start justify-between px-6 pt-7 md:px-10">
          <div className="flex items-baseline gap-10">
            <a href="#top" className="bk-eyebrow tracking-[0.2em] hover:text-[#f4f4f2]">
              BRO.KODR
            </a>
            <nav className="hidden gap-8 md:flex">
              {NAV.map((n) =>
                /* `#anchor` entries are in-page jumps and must stay plain <a>;
                   route entries need Wouter's <Link> or the SPA does a full reload. */
                n.href.startsWith("/") ? (
                  <Link key={n.label} href={n.href} className="bk-eyebrow bk-link tracking-[0.16em]">
                    {n.label}
                  </Link>
                ) : (
                  <a key={n.label} href={n.href} className="bk-eyebrow bk-link tracking-[0.16em]">
                    {n.label}
                  </a>
                ),
              )}
            </nav>
          </div>

          <Link
            href="/"
            className="bk-eyebrow border border-[#3c4043] px-3 py-1.5 tracking-[0.16em] text-[#9aa39b] transition-colors hover:border-[#35d6d0] hover:text-[#35d6d0]"
          >
            [ OPEN THE RACK ]
          </Link>
        </div>
      </header>

      {/* ---------------------------------------------------------- hero */}
      <section
        id="top"
        className="bk-hud relative flex h-screen w-full flex-col justify-end overflow-hidden"
      >
        {/* Layered ground: pure black with one soft off-centre teal wash. */}
        <div
          className="absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(120% 80% at 68% 18%, rgba(53,214,208,0.10), transparent 60%), radial-gradient(90% 60% at 20% 90%, rgba(30,37,43,0.9), #000 70%)",
          }}
        />

        {/* Floating technical labels, as on the reference. */}
        <span className="bk-eyebrow absolute top-[22%] left-6 tracking-[0.3em] opacity-45 md:left-10">
          EST. 2026
        </span>
        <span className="bk-eyebrow absolute top-[30%] right-6 tracking-[0.3em] opacity-45 md:right-10">
          48 kHz / 128
        </span>
        <span className="bk-eyebrow absolute bottom-[34%] left-6 tracking-[0.3em] opacity-35 md:left-10">
          22 MODULES / 0 LATENCY COMPROMISE
        </span>

        <div className="relative z-10 mx-auto w-full max-w-[1600px] px-6 pb-14 md:px-10">
          <p className="bk-eyebrow mb-5 tracking-[0.3em]">REAL-TIME VOICE PROCESSING · WINDOWS</p>
          <h1 className="bk-h max-w-[13ch] text-[13vw] leading-[0.88] md:text-[76px]">
            Your voice, rebuilt in real time.
          </h1>

          <div className="mt-10 flex items-end justify-between gap-8">
            <p className="bk-body max-w-[46ch]">
              A modular processing rack that runs on the audio thread. Twenty-two hand-written DSP
              modules, a vocoder and talk box, formant morphing, MIDI on every knob, and a
              text-to-speech lab that feeds straight into the chain.
            </p>
            <span
              className="hidden shrink-0 items-center gap-4 text-[#79837a] md:flex"
              style={{ fontFamily: "var(--font-mono)", fontSize: 40, letterSpacing: "0.16em" }}
            >
              SCROLL <span className="text-[#35d6d0]">↓</span>
            </span>
          </div>
        </div>

        <div className="bk-rule mx-6 md:mx-10" />
      </section>

      {/* ---------------------------------------------------------- features */}
      <section id="features" className="relative">
        {FEATURES.map((f, i) => (
          <FeatureBlock key={f.index} feature={f} flipped={i % 2 === 1} />
        ))}
      </section>

      {/* ---------------------------------------------------------- effects index */}
      <section id="effects" className="border-t border-[#3c4043]/50 bg-[#0b0d0e] py-28">
        <div className="mx-auto max-w-[1600px] px-6 md:px-10">
          <div className="mb-14 flex flex-wrap items-end justify-between gap-6">
            <div>
              <p className="bk-eyebrow mb-4 tracking-[0.3em]">INDEX</p>
              <h2 className="bk-h text-[9vw] md:text-[48px]">The full module list</h2>
            </div>
            <p className="bk-body max-w-[38ch]">
              Every module is registry-driven. Adding one is a class, one registry line, one schema
              entry — the rack and the whole UI follow automatically.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-x-12 sm:grid-cols-2 lg:grid-cols-3">
            {EFFECTS.map(([name, cat], i) => (
              <div
                key={name}
                className="flex items-baseline justify-between gap-4 border-b border-[#3c4043]/40 py-4"
              >
                <span className="bk-eyebrow w-8 shrink-0 opacity-50">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span
                  className="flex-1 text-[13px] tracking-[0.06em] text-[#f4f4f2]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {name}
                </span>
                <span className="bk-eyebrow shrink-0 text-[#35d6d0]/70">{cat}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- download */}
      <section id="download" className="bk-hud relative overflow-hidden py-32">
        <div
          className="absolute inset-0 -z-10"
          style={{
            background:
              "radial-gradient(100% 70% at 50% 0%, rgba(53,214,208,0.10), transparent 62%), #000",
          }}
        />
        <div className="mx-auto max-w-[1600px] px-6 md:px-10">
          <p className="bk-eyebrow mb-5 tracking-[0.3em]">DOWNLOAD</p>
          <h2 className="bk-h max-w-[18ch] text-[11vw] md:text-[64px]">Built for Windows.</h2>

          <div className="mt-14 grid gap-14 lg:grid-cols-[1fr_auto]">
            <div className="max-w-[52ch]">
              <p className="bk-body">
                Bro.Kodr ships as a native Windows desktop application — the same engine as the
                browser build, with local device access, lower buffer sizes and offline operation.
                Run it in the browser now, or take the desktop build for a full-duplex rig.
              </p>
              <p className="bk-body mt-6 text-[#79837a]">
                The Windows installer is produced on a Windows build runner and is not yet published.
                In the meantime the browser build is complete and identical in features.
              </p>

              <div className="mt-10 flex flex-wrap gap-4">
                <Link
                  href="/"
                  className="border border-[#35d6d0] px-6 py-3 text-[11px] tracking-[0.18em] text-[#35d6d0] uppercase transition-colors hover:bg-[#35d6d0] hover:text-black"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  Launch in browser
                </Link>
                <span
                  className="cursor-not-allowed border border-[#3c4043] px-6 py-3 text-[11px] tracking-[0.18em] text-[#79837a] uppercase"
                  style={{ fontFamily: "var(--font-mono)" }}
                  title="Windows installer not yet published"
                >
                  Windows .exe — soon
                </span>
              </div>
            </div>

            <dl className="min-w-[280px] border-t border-[#3c4043]/60">
              {[
                ["PLATFORM", "WINDOWS 10 / 11 · 64-BIT"],
                ["ALSO RUNS IN", "CHROME · EDGE"],
                ["AUDIO", "WASAPI / ASIO VIA DEVICE"],
                ["SAMPLE RATES", "44.1 / 48 / 96 kHz"],
                ["BUFFER", "128 – 1024 SAMPLES"],
                ["PRESETS", "PORTABLE JSON"],
              ].map(([k, v]) => (
                <div
                  key={k}
                  className="flex items-baseline justify-between gap-8 border-b border-[#3c4043]/40 py-3"
                >
                  <dt className="bk-eyebrow">{k}</dt>
                  <dd
                    className="text-right text-[11px] text-[#f4f4f2]"
                    style={{ fontFamily: "var(--font-mono)" }}
                  >
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------- footer */}
      <footer className="border-t border-[#3c4043]/50 bg-black py-14">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-6 px-6 md:px-10">
          <span className="bk-eyebrow tracking-[0.2em]">BRO.KODR</span>
          <span className="bk-eyebrow">KANE BATEMAN · AUSTRALIA</span>
          <span className="bk-eyebrow opacity-50">© 2026 · ALL RIGHTS RESERVED</span>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ feature block */

function FeatureBlock({ feature, flipped }: { feature: Feature; flipped: boolean }) {
  return (
    <div className="border-t border-[#3c4043]/50 py-24 md:py-32">
      <div
        className={`mx-auto grid max-w-[1600px] items-center gap-14 px-6 md:px-10 lg:gap-24 ${
          flipped ? "lg:grid-cols-[1fr_1.15fr]" : "lg:grid-cols-[1.15fr_1fr]"
        }`}
      >
        {/* Render — angled closeup. Order swaps on alternating blocks. */}
        <div className={flipped ? "lg:order-2" : ""}>
          <div className="relative">
            <div
              className="absolute -inset-8 -z-10 blur-3xl"
              style={{ background: "radial-gradient(50% 50% at 50% 50%, rgba(53,214,208,0.14), transparent 70%)" }}
            />
            <img
              src={feature.image}
              alt=""
              className="w-full border border-[#3c4043]/40"
              loading="lazy"
            />
            <span className="bk-eyebrow absolute -top-6 left-0 tracking-[0.3em] opacity-60">
              FIG. {feature.index}
            </span>
          </div>
        </div>

        {/* Copy */}
        <div className={flipped ? "lg:order-1" : ""}>
          <p className="bk-eyebrow mb-5 tracking-[0.3em]">
            {feature.index} — {feature.eyebrow}
          </p>
          <h2 className="bk-h mb-7 text-[8.5vw] md:text-[44px]">{feature.title}</h2>
          <p className="bk-body max-w-[48ch]">{feature.body}</p>

          <dl className="mt-10 border-t border-[#3c4043]/60">
            {feature.specs.map(([k, v]) => (
              <div
                key={k}
                className="flex items-baseline justify-between gap-8 border-b border-[#3c4043]/40 py-3"
              >
                <dt className="bk-eyebrow">{k}</dt>
                <dd
                  className="text-right text-[11px] text-[#f4f4f2]"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </div>
  );
}
