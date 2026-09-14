# Bro.Kodr

Real-time voice and audio processor. A modular effects rack with hand-written DSP, live
metering, recording and MIDI control, shipped as a Windows desktop app (Electron) and as a
web app from the same codebase.

Every control in the UI is wired to real DSP. There are no placeholder effects: the
numbers in the rack are measured by an automated harness (`scripts/verify-dsp.mjs`,
126 assertions) before anything ships.

---

## Quick start

Requirements: **Bun 1.3+** (installs Node-compatible tooling itself). Windows 10/11 for
the desktop build; the web app runs anywhere Chromium does.

```sh
bun install
cd packages/web && bun run db:push   # create the presets table (SQLite/LibSQL)
cd ../.. && bun run dev              # web app  -> http://localhost:4200
bun run dev:desktop                  # Electron shell, loads the dev server
```

Then press **ENGAGE** in the top bar, grant microphone access, and pick your input and
output device in the AUDIO DEVICE panel on the left.

> Wear headphones. Monitoring a live microphone through speakers will feed back, and the
> output limiter protects the signal, not your ears.

---

## Building the Windows `.exe`

```sh
bun run build                # typecheck + build web, then copy web-dist into packages/desktop
cd packages/desktop
bun run dist                 # electron-builder -> release/<version>/
```

Run it in that order. `bun run dist` re-runs the copy step itself, but it needs
`packages/web/dist` to already exist — the root `bun run build` is what produces it.

`bun run dist` produces `Bro.Kodr-Windows-<version>-Setup.exe` (NSIS installer, x64 +
ia32) plus a portable build. Configuration lives in `packages/desktop/electron-builder.json5`.

Caveats, stated plainly:

- **An unsigned installer builds fine on Linux.** Earlier notes here said the `.exe` step
  had to happen on Windows; that was wrong for the unsigned case. `wine` + `wine64` from
  apt is enough (`sudo dpkg --add-architecture i386 && sudo apt-get install wine wine64`),
  and electron-builder brings its own NSIS. The x64 installer in `release/<version>/` was
  produced on Debian this way.
- **A code-signed installer still requires Windows** (or a signing setup electron-builder
  can drive), so SmartScreen will warn on first run of the unsigned build:
  "Windows protected your PC" → More info → Run anyway.
- **Packaging does not reduce input latency.** The desktop build runs the same AudioWorklet
  backend as the web app; there is no ASIO/WASAPI-exclusive path in this build (see
  "Latency" below). What the desktop build buys you is direct device selection without
  browser permission prompts, not a smaller buffer.
- Set `protocols[0].schemes` to your real `runable-<applicationId>` before packaging, or
  deep links and desktop sign-in will not work in the packaged build (dev builds register
  the protocol at runtime).

### If the packaged app opens a blank window

This was a real bug and is now fixed; if you see it again, these are the causes in order of
likelihood.

1. **A dev instance is already running.** The app takes a single-instance lock, so launching
   the installed `.exe` while `bun run dev:desktop` is open makes the second one hand its
   arguments over and exit immediately — which looks like a window that never appears.
   Close the dev app first. The main process logs
   `[brokodr] isPackaged=… gotLock=…` on startup; `gotLock=false` is this case.
2. **The build skipped the copy step.** `packages/desktop/web-dist` must exist and contain
   `index.html` plus the whole `dsp/` tree. The app now detects this and prints an
   on-screen explanation instead of showing nothing.
3. Anything else — the window now renders a `Bro.Kodr — STARTUP FAILED` diagnostic with the
   underlying Chromium error rather than staying blank.

---

## Architecture

```
Electron main  ──►  BrowserWindow (COOP/COEP: cross-origin isolated)
                         │
                    React UI  ──► EngineClient (mirrored chain state, persistence)
                         │
             SharedArrayBuffer + Atomics
             ├─ command ring (1024 × 6 words, lock-free writer)
             ├─ meter block (seqlock, torn reads impossible)
             ├─ scope ring + record ring
                         │
                    Engine backend adapter
                    ├─ WorkletBackend   ◄── ships
                    └─ NativeBackend    ◄── interface + IPC protocol only, not compiled
                         │
                    DSP Engine core (pure math on Float32Array)
                         │
                    WASAPI shared mode ──► device
```

**The DSP core is host-agnostic on purpose.** Nothing under `packages/web/public/dsp/core`
or `.../effects` touches `AudioContext`, the `sampleRate` global, the DOM or Node. Sample
rate is passed in explicitly and every effect operates on plain `Float32Array` blocks.
That is what lets `scripts/verify-dsp.mjs` run the entire engine in bare Node, and what
lets the same code be compiled to WASM or dropped into a native WASAPI/ASIO host without
edits.

Audio-thread rules enforced throughout: no allocation inside `process()`, no exceptions,
no `console`, and every parameter change goes through a one-pole smoother so nothing
zippers.

### Project layout

```
packages/web/public/dsp/           DSP — plain ES modules, imported by the AudioWorklet
  core/       utils, biquad (RBJ/TDF2/SVF), fft + cepstrum, delay lines, 4x oversampler
  effects/    21 effects + registry
  engine.js   chain runner: slots, dry/wet, bypass, meters, record taps
  worklet-processor.js   the ONLY file that knows AudioWorklet exists
packages/web/src/web/audio/        param schema, backends, engine client, presets,
                                   recorder (WAV encode), MIDI
packages/web/src/web/components/   rack, controls, meters, EQ curve, panels
packages/web/src/api/routes/       oRPC procedures (presets CRUD)
packages/desktop/electron/         main process, IPC (export paths, folder picker), preload
scripts/verify-dsp.mjs             numeric DSP test harness
design.md                          design system and layout spec
task.md                            build log, decisions, known gotchas
```

### Signal flow

```
Input ─► trim / mono / swap ─► [ reorderable effect slots ] ─► master dry-wet ─► gain ─► Output
                                                              └─► recorder taps (dry + wet)
```

The chain runner owns dry/wet and bypass generically — effects always render 100% wet, so
mixing is consistent across every module and costs one crossfade instead of 21.

---

## Effects (22)

| Module | Notes |
| --- | --- |
| EQ | 6 bands: HP (12/24/36/48 dB), low shelf, 3 bells, high shelf, LP. RBJ biquads, TDF2. Live response curve drawn from the real coefficients. |
| Compressor | Log-domain detector, soft knee, peak/RMS, lookahead, auto makeup. |
| Limiter | Sliding-maximum true lookahead; output cannot exceed the ceiling. |
| Gate | Hysteresis + hold, sidechain HP/LP. |
| Transient shaper | Dual-envelope attack/sustain. |
| Distortion / Saturation | 6 curves, **4x oversampled** with polyphase filters, bias, pre/post tone. |
| Bit crusher | Bit reduction with TPDF dither + sample-and-hold rate reduction. |
| Pitch / Formant | Phase vocoder with cepstral envelope separation, so formants can be preserved or shifted independently. ±24 st. |
| Vocoder | Real filterbank: 16–32 bandpass bands, envelope followers, VCAs, 5 carriers, sibilance path. |
| Talk box | LPC source-filter model: the voice's vocal tract is fitted by Levinson-Durbin and imposed on a driver (6 internal carriers, or a loaded audio file) through a lattice/ladder filter. Tract size / Q, breath path, squelch gate. |
| Chorus / Flanger / Phaser | Modulated fractional delay (Hermite), 4–12 stage allpass phaser. |
| Tremolo / Ring mod / Freq shifter | Hilbert-pair single-sideband shifter. |
| Delay | Ping-pong, tempo sync, filtered feedback, modulation, saturating feedback path. |
| Reverb | 8×8 feedback delay network with Hadamard mixing, damping, modulation, diffusion. |
| Character | 8 transmission models (telephone, radio, megaphone, tape…). |
| Glitch | Buffer stutter / repeat / reverse. |
| Noise gen | Pink/white bed with a level follower. |

Presets: factory bank (Utility / Voice / Robot / Broadcast / Creative / Music) plus user
presets persisted through the API, importable and exportable as `.vkpreset` files.

---

## Audio file player

`AUDIO FILE` in the left rail loads a **WAV or MP3** off disk and plays it into the engine.

| Routing | What it does |
| --- | --- |
| `OFF` | File is loaded but silent. |
| `INPUT` | File is summed with the mic and runs through the whole effects chain. Mute the input on the I/O strip for file-only. |
| `CARRIER` | File becomes the driver the **talk box** and **vocoder** shape with your voice — load a guitar riff, mouth words into the mic. Set the module's `SOURCE` to `Audio File`. |
| `BOTH` | Both at once. |

- **Speed and pitch are independent.** WSOLA time-stretch feeds a cubic-interpolating
  resampler, so `0.5x` speed holds pitch exactly (measured: 200.0 Hz stays 200.0 Hz) and
  `+12 st` keeps the original duration. At 1x / 0 st the stretcher degenerates to a straight
  copy, so the default path costs nothing and adds no artefacts.
- **Transport**: play / stop with a 6 ms fade (never a click), return-to-start, loop toggle,
  and a waveform you can click to scrub — shift-click sets the loop in point, alt-click sets
  the loop out point. Loop is off by default.
- The file sums in **after input gain**, so its `LEVEL` knob is its own fader and the clean-take
  tap sees it — `EXPORT WAV` therefore captures the processed file with no extra wiring.
- Decoding is `decodeAudioData` on the UI thread; PCM is copied once into a `SharedArrayBuffer`
  and the worklet gets a reference, so nothing is allocated or copied on the audio thread.

---

## Verification

```sh
node scripts/verify-dsp.mjs   # 173/173 checks
```

It measures, rather than asserts on faith: a +12 dB bell at 1 kHz reads 12.00 dB, a 500 Hz
high-pass attenuates 50 Hz by 80.4 dB, a 4:1 compressor produces 6.48 dB of gain reduction
at the tested level, the limiter never exceeds its ceiling, a 4-bit crush yields exactly
27 distinct codes, delay taps land on the sample, pitch shifts land on the semitone, and
the chain is bit-transparent when bypassed.

Two real bugs were caught this way and fixed: EQ smoothers clocked per-sample but stepped
per-block (a +12 dB bell was measuring +1.97 dB), and an ungated vocoder carrier that
droned through silence.

---

## Honest limitations

- **Latency is ~15–35 ms round trip.** Chromium's audio backend is WASAPI shared mode.
  There is no ASIO path in this build, so sub-10 ms is not achievable. The top bar shows
  the real measured figure, not a nominal one.
- **The native backend is not compiled.** `native-backend.ts` defines the interface and
  IPC protocol for a WASAPI exclusive-mode / ASIO host process; building it needs MSVC on
  Windows. The app runs on the AudioWorklet backend and says so in the device panel.
- **The bundled `.exe` is unsigned** — built on Linux via Wine, so Windows SmartScreen
  warns on first run. See the build section above.
- **Not a plugin.** Bro.Kodr is a standalone app, not VST/AU/AAX.
- Real-time time-stretch is not offered because it is not physically possible; pitch
  shifting is, and is implemented properly.
- Timeline automation is out of scope for v1. MIDI CC mapping with smoothed parameters is in.

## Keyboard

`Space` record · `B` master bypass · `M` mute · `1–9` preset slots · `Ctrl/Cmd+Z` undo ·
`Ctrl/Cmd+Y` redo · `?` shortcut list.

---

## Monorepo commands

| Command | Purpose |
| --- | --- |
| `bun run dev` / `dev:desktop` | Dev servers (web on `$PORT`, default 4200) |
| `bun run build` | Typecheck + build everything |
| `bun run start` / `stop` | Production server under pm2 |
| `bun run lint` / `typecheck` | Static checks |
| `bun run db:push` / `db:generate` / `db:migrate` | Database workflows |

Secrets live in the root `.env`. The server listens on `$PORT` with a health endpoint at
`/api/health`. Cross-origin isolation headers (`COOP: same-origin`,
`COEP: credentialless`) are set in both the Vite dev server and the Hono production
server — without them `SharedArrayBuffer` is unavailable and the engine silently falls
back to a slower `postMessage` transport.
