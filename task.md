# Bro.Kodr — build scratchpad

## Decisions (locked)
- Stack: managed template — Bun/Vite/React/Hono/Electron. NO JUCE (told user, accepted).
- DSP lives in `packages/web/public/dsp/` as ES modules; AudioWorklet supports `import` (verified in
  headless Chrome test: `RESULT|import-ok|sample=0.5`). No bundler step needed.
- DSP core is backend-agnostic: pure math on Float32Array, explicit sampleRate, no host API.
  Verified numerically via playwright + OfflineAudioContext harness (`/usr/bin/google-chrome`
  executable_path required — playwright browsers not installed).
- Backend adapter pattern: WorkletBackend (ships) + NativeBackend (interface + stub only, not compiled).
- Presets in SQLite via oRPC + factory presets in code.
- UI: dark modular rack, Chakra Petch / Inter Tight / JetBrains Mono, amber+cyan accents. See design.md.
- App name Bro.Kodr. Ports: web/desktop dev server 4200, electron 4400.

## Progress
- [x] app_init, design.md
- [x] core/utils.js (smoothers, envelopes, LFO, DC block, pitch tracker, polyblep osc, pink noise)
- [x] core/biquad.js (RBJ biquad TDF2, cascade w/ Butterworth Q stagger, SVF, magnitudeDb for curves)
- [x] core/fft.js (radix-2 FFT, hann, CepstralEnvelope for formant separation)
- [x] core/delay-line.js (frac delay lin+hermite, allpass, Oversampler4x)
- [x] effects/base.js — contract
- [x] effects/eq.js — 6-band parametric + curve export
- [x] effects/dynamics.js — comp (soft knee, log domain, lookahead), limiter (sliding max), gate (hysteresis+hold), transient shaper
- [x] effects/drive.js — distortion/saturation (6 curves, 4x oversampled), bitcrusher (TPDF dither, S&H)
- [x] effects/spectral.js — phase vocoder pitch + cepstral formant shift, formant-preserve compensation
- [x] effects/vocoder.js — 16-32 band channel vocoder, carriers, pitch follow, sibilance path
- [x] effects/modulation.js — chorus, flanger, phaser, tremolo, ringmod, freq shifter
- [x] effects/time.js — delay (ping-pong, filtered feedback), reverb (8x8 FDN + Hadamard)
- [x] effects/character.js — 8 transmission modes, glitch/stutter, noise gen
- [x] effects/registry.js — 21 effects
- [x] engine.js — backend-agnostic chain runner, generic dry/wet + bypass, meters, rec taps
- [x] worklet-processor.js — SAB ring buffer + seqlock meters + circular record drain,
      plus a postMessage fallback for when cross-origin isolation is unavailable
- [x] audio/param-schema.ts — every param for all 21 effects; index in the array IS the wire key
- [x] audio/backend.ts — EngineBackend contract, meter/scope/device types, opcodes
- [x] audio/worklet-backend.ts — AudioContext+worklet lifecycle, device enum/select, latency
      negotiation, ring writer, seqlock meter reader, unbounded record drain
- [x] audio/native-backend.ts — WASAPI/ASIO interface + IPC protocol, NOT compiled (documented)
- [x] audio/engine-client.ts — facade: mirrored chain state, io stage, settings persistence
- [x] audio/recorder.ts — WAV/MP3 encode, take management
- [x] audio/midi.ts — Web MIDI + CC learn/mapping
- [x] COOP/COEP headers in vite dev config (credentialless COEP) — still TODO on the hono prod server
- [x] audio/presets.ts — factory presets
- [x] hooks/use-engine.ts — react bindings, rAF loop, canvas helper
- [x] scripts/verify-dsp.mjs — 126/126 numeric checks PASS (run: node scripts/verify-dsp.mjs)
- [x] UI components + rack (topbar, io strip, presets, device, recorder, midi, rack, index layout)
- [x] API route + schema for presets (drizzle table + oRPC routes, db:push applied)
- [x] README + build instructions for Windows .exe
- [x] COOP/COEP on the hono prod server; crossOriginIsolated===true verified in Chrome
- [x] electron-builder.json5 configured for NSIS x64/ia32
- [x] bun run build passes; dev (4200) + electron dev running; end-to-end browser test passed

## Bugs found by the harness (fixed)
- EQ smoothers were constructed at `sampleRate` but `.next()` is called once per BLOCK,
  so a 30ms glide actually took 30ms x 128 = ~4s. Now clocked at sampleRate/maxBlock.
  Symptom was a +12dB bell measuring +1.97dB. Any other block-rate smoother must do the same.
- Vocoder carrier bleed defaulted to 0dB and was ungated, so the synth droned through
  silence. Now defaults to -60dB and is squelched by a broadband modulator envelope.

## Notes / gotchas
- Chain runner owns dry/wet + bypass, effects always render 100% wet.
- Pitch module latency = fftSize (report in UI: 1024 = 21ms @48k).
- Do not narrate; user wants working audio, not a mockup. Every param must reach DSP.
- Engine control API is `engine.applyCommand({ t: "add"|"remove"|"move"|"param"|"mix"|
  "bypass"|"reset"|"clear"|"io"|"clipreset"|"panic", id, ... })`. Slots are addressed by
  numeric id, NOT index. `add` takes { id, type, index?, mix?, bypassed?, params? }.
- readMeters layout: 0-3 peak inL/inR/outL/outR (LINEAR, not dB), 4-7 rms, 8-9 clip
  latches, 10 cpu, 11 latency samples, 12 slot count, 16+ per-slot meter.
- EQ param ids: hpFreq hpSlope lsFreq lsGain b1Freq b1Gain b1Q b2* b3* hsFreq hsGain
  lpFreq lpSlope output. There is no per-effect `mix` param — the chain owns dry/wet.

## Verified end to end (browser + electron)
- crossOriginIsolated === true, zero console errors on load.
- ENGAGE -> RUNNING, SR 44.1k, block 128, RT latency reported; preset load switches the chain live.
- Knob drag actually changes a param (EQ HP FREQ 20 Hz -> 159 Hz).
- Record 2.96 s -> EXPORT WAV downloaded 24-bit/44.1k stereo; peak measured -0.50 dBFS,
  exactly the limiter ceiling, which proves the chain is really processing the take.
- Electron window renders the full rack (screenshot via Xvfb).

## Bug 3 (fixed): CPU meter always read 0%
`performance` does NOT exist in AudioWorkletGlobalScope in Chromium (verified with a probe
worklet: typeof performance === 'undefined'), and AudioContext.renderCapacity is missing in
this build too, so both load sources were dead and the meter was a permanent 0.
Now falls back to Date.now(): 1 ms resolution is coarser than a 2.9 ms quantum, but the
truncation is unbiased so a slower one-pole (a=0.004 instead of 0.05) converges on the true
mean. Reads 21% for the full 8-module chain, 9% for the robot preset.

## Sandbox note
node_modules electron shipped without its binary ("Electron failed to install correctly").
Fixed by unzipping electron-v30.5.1-linux-x64 into node_modules/.bun/electron@30.5.1/
node_modules/electron/dist and writing `electron` (no trailing newline) into path.txt.

## Bug 4+5 (fixed): packaged .exe showed a blank window
Reported by the user; reproduced by actually packaging a linux `--dir` build and driving the
packaged binary over CDP.

1. `isDev = process.env.NODE_ENV !== "production"`. Electron does NOT set NODE_ENV in a
   packaged build, so isDev was TRUE inside the installed app: it tried to load the Vite dev
   server (localhost:3000) which obviously is not running on a user's machine. Chromium
   showed ERR_CONNECTION_REFUSED as an empty window. Now keys off `app.isPackaged`.
2. `WEB_DIST = ../web-dist` was never populated. electron-builder listed "web-dist" in
   `files` but nothing ever copied packages/web/dist into it, and electron-builder will not
   reach into a sibling workspace package. Even after fix 1 the loopback server would have
   served nothing. Added packages/desktop/scripts/copy-web-dist.mjs, wired into both
   `build` and `dist`, and it hard-fails if dsp/worklet-processor.js did not come across.
   Also added "@template/web": "workspace:*" to the desktop deps so turbo builds web FIRST
   (turbo orders by dependency graph, and desktop previously declared no dependency on web,
   so it was building in the wrong order).

Also hardened while in there:
- did-fail-load / render-process-gone / missing-index handlers now paint an on-screen
  "STARTUP FAILED" diagnostic. A blank window is never an acceptable failure mode.
- the loopback static server used to fall back to index.html for EVERY missing path, which
  meant a missing /dsp/*.js returned HTML and AudioWorklet.addModule() failed with a
  nonsense syntax error. Assets (anything with an extension) now 404 properly; only
  navigation requests fall back to index.html.
- one startup log line: `[brokodr] isPackaged=… gotLock=… webDist=…`.

### Verified on the real packaged binary (not the dev server)
isPackaged=true, gotLock=true, webDist resolved inside app.asar, title/UI rendered
(5659 chars of body), crossOriginIsolated=true, SharedArrayBuffer available,
GET /dsp/worklet-processor.js -> 200 text/javascript from inside the asar,
GET /dsp/does-not-exist.js -> 404. Engine reports "Requested device not found" because this
Linux sandbox has no microphone — correct, honest failure, not a hang.

### Gotcha for future sandbox work
`gotLock=false` will silently quit the packaged build if a dev electron is still running —
same userData dir, same lock. Kill the dev session before testing a package.
Also: never `pkill -f electron` here, the pattern matches the invoking shell command itself.

---

## Feature: Talk box (shipped)
Requested as "a talk box vocoder type of device ... in the plugin area where all the chorus
and everything else is". Built as a normal rack module (`talkbox`), not a special case.

Source-filter separation by LPC rather than a filterbank, because a real talk box is
literally the player's vocal tract acting on a driver signal:
pre-emphasis (0.95) -> Hamming window -> autocorrelation -> Levinson-Durbin -> reflection
coefficients -> applied to the driver in **lattice/ladder form**, interpolated per sample.
Direct form with interpolated coefficients explodes — that would be a speaker-destroying
bug in a live monitor. Stability is guaranteed while every |k| < 1 (K_LIMIT = 0.985).

- Tract Size resamples the analysis frame before the fit, so the whole envelope scales
  (measured: formant peak moves 890 -> 1010 -> 1210 Hz).
- Tract Q scales k by 0.6 + 0.4*tractq (|k| only shrinks, so still stable).
- Breath mixes a high-passed slice of dry mic back — a real tube loses /s/, /f/, /t/.
- Squelch gates on the mic envelope so the driver does not drone through silence.
- CARRIER_RMS normalises each internal driver to unit RMS; the Levinson-Durbin residual
  gain is only meaningful against unit-variance excitation.
- Six drivers, xorshift noise (no Math.random on the audio thread), nothing allocated in
  process().

Presets `talkbox-lead` and `talkbox-robot`. MIDI note mode "Play talk box driver" frets the
driver oscillator, same mapping as the vocoder mode.

## Feature: audio file loading (shipped)
Requested after the talk box. Scoped with the user: WAV + MP3, full transport with speed
and pitch, feeding the recorder, and **both** roles — file as chain input, and file as the
talk box / vocoder carrier.

`core/file-player.js` lives in DSP core, not in the worklet, so it stays backend-agnostic
and a future native host gets it for free.

Speed and pitch are independent by construction:
`source -> [WSOLA stretch, alpha] -> FIFO -> [cubic resampler, r] -> out`, net rate
`alpha*r`, net pitch `r`. With speed s and pitch ratio p and base = srcRate/engineRate:
`r = base*p`, `alpha = s/p`. When |alpha-1| < 1e-3 the stretcher degenerates to a straight
copy, so the default 1x / 0 st path is bit-clean and artefact-free.
Verified: 0.5x speed holds 200.0 Hz; +12 st reads 400.0 Hz with position drift < 0.03.

WSOLA over fixed-hop OLA because OLA makes sustained notes phasey. The correlation search
is decimated (CORR 256, step 2, tolerance 160) — full resolution costs ~10x for no audible
gain — and energy-normalised, otherwise the search finds the loudest spot rather than the
best match. Catmull-Rom read; linear is audibly dull on cymbals and pick attack.

Routing enum OFF/INPUT/CARRIER/BOTH. INPUT **sums** with the mic instead of replacing it —
muting the input strip gives file-only, which is strictly more flexible. The file sums in
after input gain, so its level is its own fader and engine.dryL/dryR (the clean-take tap)
contain it, which is how EXPORT WAV captures the processed file with zero recorder changes.

Carrier bus pointers are handed to effects once at add time via optional
`setCarrierBus(L, R)`, so process() needs no lookup. The file carrier is RMS-normalised
inside each effect (~100 ms running mean-square) rather than by a per-waveform constant,
because an arbitrary track's level is unknown.

Decode is decodeAudioData on the UI thread (the only decoder available without shipping
one, and it covers WAV + MP3), then PCM is copied once into a SharedArrayBuffer that the
worklet references. Falls back to transferred ArrayBuffers without SAB.

### Two real bugs the new tests caught
1. Loop defaulted ON, so a one-shot never ended and `position` ran past 1.0. A freshly
   loaded file that instantly loops forever is a worse surprise than one that stops —
   loop now defaults off.
2. `srcPos` was not wrapped while looping. Reads were already wrapped via #srcIndex, so it
   sounded right, but the reported position (and therefore the playhead) ran off the end of
   the file. Added #wrapPos().

Verified in a real browser: load WAV, scrub, loop points, speed 1.63x, switch to CARRIER,
add Talk Box, record round trip, eject, load MP3, play. Zero console errors.

---

## VOICE LAB (text-to-speech section) — approved plan, Aug 24 2026

Two speech paths. Browser `speechSynthesis` = instant/free/offline but PREVIEW ONLY
(the spec has no way to route synth output into an audio graph, so no dial can touch it).
API path (Gemini TTS + Groq PlayAI) returns a WAV we decode, so the whole rack applies.

Accent packs: American, British, Australian (both providers), Italian (Gemini only —
Groq PlayAI is English+Arabic). Accent/style is a natural-language instruction on Gemini.

Routing: generated audio becomes an AudioBuffer fed into the EXISTING core file-player.
That one hook gives live rack processing, mic-replacement input source, talk box/vocoder
carrier via the existing setCarrierBus(), and WAV/MP3 export through the existing recorder.

12 character presets: Toy, Devil, Monster, Giant, Cartoon, Robot, Alien, Child, Elderly,
Whisper, Announcer, Ghost — all built from spectral (independent pitch/formant with the
preserve flag), character, drive, dynamics, modulation, time.

Morph dials: PITCH, VOCAL TRACT (the real younger<->older control), BREATH, ROUGHNESS
(jitter/shimmer — 2 params APPENDED to spectral, never reordered), BRIGHTNESS, VIBRATO.

Editor: block-per-line script. Markup [p:300] pause ms, *word* emphasis, {rate:0.8}.
GROOVE strip: BPM, grid (1/4, 1/8, 1/16, triplet), SWING %, per-block start at bar.beat.
API voices additionally get word-by-word synthesis so each word lands on its own grid slot.

Phases: 1 = API path, panel, character presets, morph dials, rack routing, export.
2 = script editor, markup, groove/swing, word scheduling. 3 = preset persistence + browser preview.

### Backlog — raised and deliberately deferred (remind Kane)
- **Note-per-syllable pitch track** — turns rhythmic placement into actual melody
  (sung vocal). Explicitly deferred; REMIND HIM about this later.
- **Rhythm reference tool** — his idea: a metronome and/or a user-loaded backing track
  looping underneath the Voice Lab, so the vocal groove can be tweaked against the
  actual music it is for. Fits Phase 2 alongside GROOVE. The core file-player already
  does loop points, so the backing-loop half is mostly wiring a second player instance.
- **Time-domain (cheap) pitch/formant shifter** as a second low-latency mode for
  character presets on the LIVE mic. Deferred — FFT spectral shifting is fine for
  generated speech, too laggy for live monitoring.

## Metal skin reskin — approved 2026-08-26

Kane asked for the instrument UI to be reskinned to match the 3D product renders
("love the blue on brushed aluminium look, the screws even, the font, the dials").
Four decisions taken via form, all approved:

1. Two-tone: dark anodised chassis + light silver brushed faceplates (a deliberate
   hybrid — the renders are dark metal). **REVERSED in round 2 on Kane's instruction:
   he saw the silver and asked for the render's dark metal instead. The silver recipe
   was deliberately discarded — do not reinstate it.**
2. Full single-teal accent `#35d6d0`; per-section colour coding is sacrificed inside
   metal modules. He chose looks over the colour code explicitly.
3. The live 16-band vocoder ladder is in scope now — told him it is DSP wiring, not
   paint, and he said do it now.
4. Preview one panel, roll out after approval.

### Done
- `styles.css` — `.mk*` metal-skin block (faceplate, chassis, screws, glass, etch,
  LED, button) + `.mk` overrides for `.vk-label` / `.vk-value` on silver.
- `controls.tsx` — `Knob` gained `skin?: "flat" | "metal"`; metal branch draws the
  machined dial. Every existing call site is unchanged (`skin` defaults to flat).
- `vocoder.js` — band envelopes now published: `level` on each band object,
  `b.level = e` in the band loop, cleared in `reset()`, exposed via `get visual()`
  through a -60dB floor into a preallocated buffer (no audio-thread allocation).
- `band-ladder.tsx` — new. 24fps poll with in-flight guard, eased release, canvas.
- `rack.tsx` — `MetalVocoderModule`: brushed faceplate, four corner screws, engraved
  nameplate, INT/EXT/FOLLOW LED row, live ladder, teal machined dials. Routed only
  for `slot.type === "vocoder"`; every other module still renders `RackModule`.
- `verify-dsp.mjs` — new section 13 covering the visual channel. **193/193 passing**
  (was 182).

## Metal skin round 2 + three side asks — approved and implemented 2026-08-26

Kane sent four reference images (500-series rack mock-up, a dial, a VU/fader/rocker
sheet, a dark teal UI kit) and asked for dark faceplates, the reference dial geometry,
retro analogue VU meters, and the spectrum/waveform pane replaced by dual VU + a
scope. On approving he added three things: run **both** Italian and Spanish voices
(this closes the long-standing stale question), keep the spectrum analyser as a
**toggle** rather than deleting it, and fix the add-module control — *a friend of his
could not work out how to add a module at all*, with creative freedom given.

### Done — build green, 193/193 DSP checks, zero console errors
- `tts.ts` / `tts-panel.tsx` — Spanish pack added **alongside** Italian: `es-f`
  (Gemini `Leda`) and `es-m` (Gemini `Orus`), appended to `VOICES` so preset ids stay
  stable, plus nearest-match Groq fallbacks (`autumn` / `austin`). Deliberately
  different Gemini voices from the Italian pair — sharing one voice made both packs
  sound like the same person doing two impressions. **Both verified live against the
  API: HTTP 200, ~168 KB of PCM each.**
- `styles.css` — faceplate re-toned to dark brushed metal (`--mk-face #1d2124`), grain
  contrast raised to 7%/20%, bevel and engraving shadows inverted, `--mk-etch` is now
  a light ink, active `.mk-btn` is lit teal glass. This also fixed the low-contrast
  10px value text flagged as a round-1 caveat.
- `styles.css` + `recorder-panel.tsx` + `meters.tsx` — recorder red identity: 135°
  dark/light red striped header, domed round record button with a lit pulse and a stop
  square when armed, take waveform orange -> red. Pulse is a box-shadow (not a
  filter) and is disabled under `prefers-reduced-motion`.
- `controls.tsx` — metal `Knob` branch rebuilt to the reference dial: 61 hairline
  ticks on an outer arc lit teal to the current value, broad bezel with a hard inner
  shadow, 28-spoke turned cap, short index notch. The value arc is gone; the lit tick
  run carries the value. The flat branch (every other call site) is untouched.
- `vu-meter.tsx` — new. Non-linear printed VU scale from a measured graduation table,
  needle as a critically-damped spring (300ms to 99%, slight overshoot), 0 VU at
  -18 dBFS, cream face, red overrun, PEAK lamp.
- `oscilloscope.tsx` — new. Triggered sweep on the first rising zero crossing with
  hold-off, so the trace locks instead of skating sideways. Runs entirely off the
  existing `pollScope` transport — no new DSP plumbing, no SharedArrayBuffer change.
- `meters.tsx` / `index.tsx` — `ScopeStrip` is now a layout switch: `vu` (default,
  VU pair + scope) or `spectrum` (the original canvas, kept per Kane). Mode union,
  default, header buttons and legend all updated.
- `rack.tsx` — `AddModule` redesigned: a full-height dashed amber bay with a circled
  `+`, `ADD MODULE` and a "click to pick an effect" hint, all legible without hover.
  The `title="Add a module to the chain"` selector was preserved for the harness.

### Next — blocked on Kane's approval of round 2
Roll the skin out to the remaining 21 modules + topbar/io-strip, or adjust the
faceplate tone / dial / VU / recorder / add-module design first.

## Metal skin round 3 — four layout/finish fixes, implemented 2026-08-26

Precise corrections to already-approved work, so implemented directly without a plan gate.

1. **Voice Lab was crammed** — moved out of the left rail into the right column
   (`io-strip.tsx`), and `RAIL_TONE` gained `voice: "#f472b6"`. Root cause of the missing
   colour: `index.tsx` already passed `tone={RAIL_TONE.voice}` but `RAIL_TONE` had no
   `voice` key, so the tone was `undefined`.
2. **INPUT + OUTPUT merged into one panel** — console layout, faders outboard, IN/OUT
   meters back-to-back in the middle, four switches in a 2-col grid below. Aside 188 -> 286.
3. **VU meters moved to the outside** of the analyser pane with the oscilloscope between
   them. `VuPair` is still exported from `vu-meter.tsx` but is now unused.
4. **Vocoder finish** — grain rebuilt as two soft-stop layers (hard 1px stops were aliasing
   into dots), and the four screws unbunched by moving `position: absolute` into the inline
   style, since `.mk-screw`'s `position: relative` was winning on source order.

Follow-up in the same round: the VU legends were clipped, so the face now reserves an 11px
footer band (`fh = h - pad*2 - foot`).

Verified: `bun run build` green (6.1s), `node scripts/verify-dsp.mjs` 193/193, Playwright
harness zero console errors with screws measured at four distinct corners. Screenshots in
`snapshots/round3/`.

### Outstanding gate
Roll the metal skin past the vocoder to the other 21 modules + topbar + IO strip. It is the
one-line `const Module = slot.type === "vocoder" ? MetalVocoderModule : RackModule;` switch
in `rack.tsx`. Not done — needs Kane's go-ahead.

## Gradient skin + slider restyle — implemented 2026-08-26 (round 4)

Kane's call: the brushed-metal face still looked wrong, and he supplied a gradient render
instead ("gradients from both sides into the middle"). Implemented directly - it is a
restyle of already-approved surface, not a new feature.

- `.mk-face` rebuilt as the symmetric edge->centre gradient, 10px radius, no grain, no
  bevels, and `<ScrewRow />` is no longer rendered (the function is retained but unused).
- New `.vk-grad-face` puts the same gradient behind **every** flat rack module - he asked for
  it as the background for each module unit in the chain, so it is not gated on the metal
  rollout. Background only; borders, tone headers and layout untouched.
- `MiniSlider` restyled off `slider.jpg` (hatched channel, glowing accent run, milled
  handle). It is the single dry/wet control, so master + all 22 module MIX strips changed at
  once - which is what "make this global for all wet/dry's" asked for.
- I/O panel header is now `justify-between`: INPUT over TRIM, OUTPUT over GAIN.

Verified: `bun run build` green (6.3s), Playwright harness zero console errors, screws
correctly absent. Screenshots in `snapshots/round4/`.

### Dropped from the backlog
The `og:image` absolute-URL issue is **closed, not deferred** - he is focused on the .exe and
does not care about web link previews. Do not raise it again.

## Round 5 — metal control rollout + VU finish, implemented 2026-08-26
- Metal `ParamGrid` rolled out to all 22 modules ("ok rollout the metal controls to all").
  `RackModule` root gained the `mk` class (required for the `--mk-*` vars) and
  `skin="metal" accent={CATEGORY_COLOR}`.
- Accent moved from single teal back to per-category colour on purpose — see design.md.
- VU meter: `VU` legend moved out of the numeral arc into the boxed bottom-left corner with a
  `BRO.KODR` mark opposite; numerals thinned to 20/10/5/3/0/+3 below 170px (ticks kept);
  vignette, red overrun band, tapered needle, cast shadow and glass reflection added.

Verified: `bun run build` green (6.6s), Playwright harness zero console errors,
`node scripts/verify-dsp.mjs` 193/193. Screenshots in `snapshots/round5/`.

## Round 5b — vocoder shell rolled out to all modules, 2026-08-26
"can the vocoder shape be done to all the others too (round corners etc)". `RackModule` now
renders chassis + inset rounded plate exactly like `MetalVocoderModule`, widths +6px,
`overflow-hidden` on the plate so the square header clips to the radius.
Verified: `bun run build` green (6.7s), harness zero console errors, DSP 193/193.

## Round 5c — vocoder header unified, 2026-08-26
Engraved nameplate replaced with the shared `.vk-tone-head` category bar (voice = #a78bfa),
in both the expanded and collapsed states. Verified: `bun run build` green (6.9s), harness
zero console errors.

## Git / GitHub — 2026-08-26
Repo initialised (`main`, 195 files, one commit). `.gitignore` gained
`!scripts/verify-dsp.mjs` — the template ignores all of `scripts/`, but the Actions build
runs that suite so it must be in the repo. `.env` is correctly ignored.
Pushed to **https://github.com/chewwwy/brokodr** (public). Token account is `chewwwy`, not
`kanebateman` - confirmed with Kane before creating.

Repo secret `GOOGLE_GENERATIVE_AI_API_KEY` set via the Actions secrets API (sealed box), because
`bun run build` needs it for the Voice Lab route.

Repo was created private first, but a private-repo run sat `queued` for 13 min with zero jobs
allocated (no Actions minutes available on the account). Flipped to public on Kane's instruction -
public repos get unlimited free Actions minutes - and the run started immediately.

### Three CI failures fixed to get the first green build
1. `.gitignore` also swallowed `packages/desktop/scripts/copy-web-dist.mjs` (the `scripts/`
   pattern matches at any depth, and the round-1 fix only un-ignored the root
   `scripts/verify-dsp.mjs`). The desktop `build` script imports it, so CI failed with
   `Module not found`. Added the mobile-style un-ignore triple for that one file.
2. `electron-builder` hard-failed with `Cannot detect repository by .git/config`: it tries to
   derive a publish/auto-update target on CI. Added **`"publish": null`** to
   `electron-builder.json5` - CI ships the .exe as a build artifact, not a GitHub release.
3. (config, not a failure) `protocols[0].schemes` set to the real
   **`runable-vowkodr-xzbcl8r`** on Kane's instruction, replacing the `runable-app` placeholder.
   That matches what `createManagedDeepLinks` derives from `APPLICATION_ID` at runtime. A vanity
   `brokodr://` scheme was discussed and deliberately deferred until there are preset links worth
   sharing.

### First Windows installer - SHIPPED
Run 32986421790 green. `Bro.Kodr-Windows-0.0.0-Setup.exe`, 100.8 MB, NSIS x64, per-user,
install dir selectable.

Published as a **prerelease** so it has a permanent no-login download URL (the raw Actions
artifact needs a GitHub login, and `upload` rejects anything this large):
https://github.com/chewwwy/brokodr/releases/download/v0.0.0-alpha.1/Bro.Kodr-Windows-0.0.0-Setup.exe

Still true: the build is **unsigned**, so SmartScreen warns on first run.

Note: creating tag `v0.0.0-alpha.1` re-triggers the workflow (it fires on `v*`). Harmless
duplicate build.

### Next on the .exe
- Wire the marketing-site download button (`pages/site.tsx` ~line 295, currently the disabled
  `Windows .exe - soon`) to that release URL. Not done - it needs Kane's go-ahead since it
  publishes an unsigned build to anyone who visits the site.
- `version` is still `0.0.0` from the template, so the filename reads `0.0.0`. Worth setting a
  real version before a public download link goes live.
- No app icon (`electron-builder.json5` has no `icon` key), so the installer and taskbar use the
  default Electron icon.
