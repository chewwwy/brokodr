# Bro.Kodr — Design System

Real-time voice/audio processing workstation. Desktop-first (Electron), dark modular rack aesthetic.
The look is **classic pro audio hardware**: console grey panels, machined rotary knobs, LED-segment
meters, engraved labels. Restrained, dense, functional. No decorative animation — CPU belongs to audio.

## Design Principles

1. **The signal path is the layout.** Left→right flow: INPUT → rack chain → OUTPUT. Never hide routing.
2. **Every pixel is a control or a readout.** No marketing space, no hero sections. This is an instrument.
3. **Numbers always visible.** Every knob shows its value in real units (dB, Hz, ms, st, %, :1).
4. **Motion costs audio.** Only meters/scopes animate, on rAF, canvas-only. Zero CSS transitions on
   anything that repaints during playback. No blur, no shadows on animated elements.
5. **Hardware honesty.** Controls look grabbable, feel weighted (drag-vertical, shift = fine, dbl-click = reset).

## Palette

Console greys with a single amber/cyan signal accent. Amber = signal/active, cyan = data/analysis,
red = overload only. Colour is information, never decoration.

```css
--vk-void:      #08090a   /* app background, deepest recess */
--vk-panel:     #16181b   /* rack panel face */
--vk-panel-hi:  #1e2126   /* raised module face */
--vk-panel-lo:  #101215   /* inset wells, displays */
--vk-line:      #2a2e34   /* engraved separators / panel screws */
--vk-line-hi:   #3a4048   /* module borders, active edges */

--vk-text:      #e8eaed   /* primary readouts */
--vk-text-mid:  #9aa2ad   /* labels */
--vk-text-dim:  #5f6772   /* units, inactive */

--vk-amber:     #ffb020   /* signal / active / knob indicator */
--vk-amber-dim: #6b4a10
--vk-cyan:      #35d6d0   /* analysis: spectrum, waveform, data */
--vk-cyan-dim:  #12504f
--vk-green:     #4ade80   /* safe level, record armed idle */
--vk-red:       #ff3b30   /* clip, overload, recording */
--vk-violet:    #a78bfa   /* voice/character modules */
```

Meter gradient: green (−inf…−12) → amber (−12…−3) → red (−3…0), hard segment boundaries, no smoothing.

## Typography

- **Display / readouts:** `Chakra Petch` — technical, squared, hardware-panel feel. Weights 500/600/700.
- **Body / labels:** `Inter Tight` — compact, legible at 10–12px.
- **Numeric values:** `JetBrains Mono` — tabular figures so values don't jitter while animating.

Scale: labels 10px/600/`0.08em` uppercase tracking · values 11–13px mono · module titles 12px/700
uppercase · section headers 14px/700 · master readout 22px mono.

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ TOPBAR  logo · engine state · sample rate · buffer · CPU · MIDI  │
├──────────┬──────────────────────────────────────────┬───────────┤
│ LEFT     │ CENTER                                   │ RIGHT     │
│ preset   │ scope strip (waveform + spectrum)        │ INPUT     │
│ browser  │ ─────────────────────────────────────    │ trim/mute │
│ +        │ RACK — horizontally scrolling modules,   │ meters    │
│ device / │ drag to reorder, each with bypass +      │ ─────     │
│ latency  │ dry/wet + knob grid                      │ OUTPUT    │
│ panel    │ ─────────────────────────────────────    │ gain      │
│          │ RECORDER — arm, waveform, take list      │ limiter   │
│          │                                          │ bypass    │
└──────────┴──────────────────────────────────────────┴───────────┘
```

- Fixed viewport height, no page scroll. Panes scroll internally. `overflow: hidden` on root.
- Rack modules: fixed 208px width, full-height cards, snap into a horizontal flex row.
- Panel surfaces: 1px `--vk-line-hi` border, 3px radius (hardware, not app-store rounded),
  subtle inset top highlight `inset 0 1px 0 rgba(255,255,255,.04)`.
- Gutters 8px, module padding 10px, dense by intent.

## Components

- **Knob** — 44px canvas-free CSS rotary. Arc track behind, amber indicator arc, notch pointer.
  Drag vertical (140px = full range), Shift = ×0.2 fine, double-click = default, wheel supported.
  Label above, value below. Bipolar params draw the arc from centre.
- **Fader** — 12px track, machined cap, used for gains and mix.
- **Meter** — canvas, 6px wide segments, peak-hold tick that decays 12dB/s, clip LED latches until click.
- **Scope** — canvas waveform (cyan, 1px, no fill) + spectrum (log-frequency, amber bars, 60fps rAF).
- **EQ curve** — canvas, log-frequency grid, draggable band nodes, composite response line.
- **Switch/Bypass** — engraved rectangle, amber LED dot when active, hard state change (no fade).
- **Module header** — drag handle (⠿), name, bypass LED, dry/wet micro-knob, kebab (reset/duplicate/remove).
- **Segment display** — inset `--vk-panel-lo` well, mono text, cyan glow only at rest (`text-shadow` static).

## UX Patterns

- Engine must be explicitly started (browser gesture requirement) — a large ENGAGE control, not a modal.
- Device/buffer changes rebuild the graph, with an explicit "restart engine" state, never silent failure.
- Parameter changes are optimistic locally and sent to the audio thread over a lock-free ring buffer.
- Undo/redo on parameter + chain edits (Cmd/Ctrl+Z), coalescing continuous drags into one step.
- Keyboard: `Space` record toggle, `B` master bypass, `M` mute input, `1–9` preset slots, `Cmd+Z/Y` undo.
- Overload is loud visually: clip LEDs latch, master readout turns red, limiter GR meter shows work done.
- Never block the UI thread on audio work; never allocate in the audio callback.

---

## Marketing Site (`/site`)

Separate from the instrument UI. The app is dense and scroll-free; the site is the opposite —
full-bleed, scrolling, generous. Layout and rhythm ported from midnightrebels.com: monospace-led,
near-monochrome, technical-HUD decoration, giant condensed uppercase headlines.

### Site palette (overrides, `--bk-*`)

```css
--bk-black:  #000000   /* page ground, full black not --vk-void */
--bk-ink:    #0b0d0e   /* alternating band */
--bk-slate:  #1e252b   /* card / hairline fill */
--bk-steel:  #3c4043   /* borders */
--bk-ash:    #79837a   /* dim mono labels */
--bk-mist:   #9aa39b   /* body copy */
--bk-paper:  #f4f4f2   /* headlines, off-white not pure */
--bk-accent: #35d6d0   /* single accent — reuses the app's cyan */
```

### Site type scale (7 steps, no more)

`10 / 12 / 14 / 20 / 32 / 48 / 72` px.
- Headlines: Chakra Petch 700, uppercase, `letter-spacing -0.02em`, `line-height 0.92`.
- Everything else — nav, labels, body, index rows, footer: JetBrains Mono, uppercase for labels
  (`letter-spacing 0.14em`), sentence case for body at `line-height 1.7`.
- Reference site runs weight 900; only 700 is self-hosted, so weight is carried by size and tracking.

### Logo choreography

Single source of truth: scroll progress `p` over the first viewport height.
- `p=0` — logo 440px wide, centred at mid-viewport.
- `p=1` — logo 48px tall, docked centre of the top nav; nav background fades in behind it.
- Interpolated with one Motion `useScroll` + `useTransform` chain on the site scroll container.
  No per-section triggers, no scroll listeners.
- Docked state: 4s breathing pulse (opacity + drop-shadow).
- **Erratic shock** — a random 6–18s timer fires a 120–200ms burst: hot cyan/white blowout,
  2–3 stutter frames, ±2px x-jitter, then decay. Random interval and duration so it never
  reads as a loop. Disabled under `prefers-reduced-motion`.

### Sections

1. **Hero** — logo, tagline, `SCROLL ↓` oversized mono bottom-right, faint HUD overlay + floating
   mono labels (`EST. 2026`, `48kHz / 128`).
2–4. **Feature blocks** — rack / vocoder + talk box / MIDI. Asymmetric split, angled closeup 3D
   render one side, headline + mono body + spec list the other. Alternating sides.
5. **Effects index** — all 22 registry modules as a dense mono table with category tags.
6. **Download** — Windows CTA, system requirements. Honest: no `.exe` is built in the sandbox.
7. **Footer** — Kane Bateman, Australia.

### 3D renders

`packages/web/public/images/render-*.png`. Dark studio product shots: machined black anodised
aluminium and smoked glass modules, knurled knobs, teal LED segments, single hard rim light,
pure black seamless background, angled three-quarter closeup, shallow depth of field.

## Metal Skin (rack modules)

The instrument UI is reskinned to match the 3D product renders. Round 1 was approved on
2026-08-26 with light silver faceplates; **round 2 reversed that on Kane's instruction** —
he saw the silver against the render and asked for the render's dark metal instead. The
silver recipe was thrown away deliberately; do not reinstate it.

Locked decisions:

1. **Dark brushed metal throughout.** Near-black brushed aluminium faceplates with vertical
   grain over a near-black chassis, thin bright bevel at the plate edge, hex screws, black
   glass windows. Directly off `BroCoder_Mok_up`, a 500-series style rack.
2. **Single teal accent — `#35d6d0` everywhere.** This retires the per-section colour coding
   in `CATEGORY_COLOR` inside metal modules. Cost accepted knowingly: you can no longer tell
   a dynamics module from a drive module by colour alone.
3. **The 16-band vocoder ladder is live data**, not decoration.
4. **Rollout is module by module.** The vocoder is the preview; nothing else is reskinned
   until the look is signed off.

### Palette (declared on `.mk`)

| Token | Value | Use |
|---|---|---|
| `--mk-chassis` | `#07080a` | chassis behind the plates |
| `--mk-face` | `#1d2124` | faceplate base metal |
| `--mk-face-hi` / `--mk-face-lo` | `#2b3033` / `#121517` | sheen ends |
| `--mk-bezel` | `#34393c` | dial bezels, raised hardware |
| `--mk-etch` / `--mk-etch-dim` | `#ccd2d5` / `#7d868b` | engraved lettering (light ink) |
| `--mk-teal` | `#35d6d0` | the single accent |
| `--mk-glass` | `#050708` | sunken readout windows |

### Recipes

- **Brushed faceplate** (`.mk-face`) — three stacked layers, cheapest first: a 1px repeating
  gradient for the vertical hairline grain, a 157° sheen, then the base tone. Grain contrast
  is **7% / 20%**, not the 4-5% used on silver: on a dark plate a 4% delta is invisible and
  the grain disappears entirely. The machined edge is inset box-shadows — bright top lip,
  black bottom lip.
- **Engraving** (`.mk-etch`) — light ink with the shadow **above** the stroke
  (`0 -1px 0 rgb(0 0 0 / 85%)`) plus a faint light lip below. Inverted from the silver
  recipe, and it has to be: on dark metal an engraved character is a light cut with its
  shadow above it. Keeping the silver recipe made type read as printed on top of the plate.
- **Screws** (`.mk-screw`) — machined dome via a 140° gradient over a black outer ring, slot
  drawn as a hairline band in `::after`. `:nth-child(even)` rotates the slot 84°, because
  screws in a real rack are never aligned and aligned ones read as texture, not hardware.
- **Buttons** (`.mk-btn`) — dark plate cap; `[data-active="true"]` becomes lit teal *glass*
  with an inner glow, matching the boxed teal `IN` button in the render. Not a lit metal cap.
- **Dials** (`Knob` `skin="metal"`, in `controls.tsx`) — geometry copied from the `Dial`
  reference: **61 hairline ticks on an arc outside the knob** over the 270° travel, every 5th
  a longer major graduation, lit in teal up to the current value (from centre outward for
  bipolar params) and `#5c6367` beyond. Broad bezel with a hard black inner shadow ring, a
  turned cap at `r * 0.62` textured with 28 alternating hairline spokes and a specular arc,
  and a **short index notch near the cap edge** — not a full-radius line. The metal branch
  draws **no separate value arc**; the lit tick run carries the value, as on the reference.
- **VU meters** (`vu-meter.tsx`) — cream face, black graduation arc turning red past 0,
  hairline needle, pivot cowl, PEAK lamp. Two things make or break it: the printed scale is
  **non-linear** (a `SCALE` table of measured graduation positions, crowded toward 0 with a
  stretched red overrun — a linear dB mapping looks wrong instantly), and the needle is a
  **critically-damped spring** (`omega 22`, `zeta 0.72`), not the one-pole smoother used
  elsewhere. 0 VU is aligned to -18 dBFS. That 300ms integration is the entire reason a VU
  reads as loudness rather than as samples.
- **Oscilloscope** (`oscilloscope.tsx`) — 8x4 teal graticule, input trace at 0.32 alpha under
  the output at full. The sweep is **triggered** on the first rising zero crossing inside the
  first half of the window (hold-off leaves a full sweep to draw); without it the trace
  skates sideways every frame because each frame starts on a different phase. Runs off the
  existing `pollScope` transport — no new DSP plumbing.
- **Recorder** (`.rec-*`) — the transport carries a red identity so it never reads as just
  another panel: a 135° dark/light red striped header, a 34px domed round record button whose
  lens becomes a stop square when armed, and a `rec-pulse` box-shadow animation while
  recording (**box-shadow, not `filter: drop-shadow`** — a filter repaints offscreen every
  pulse frame). Take waveforms are red, matching. Pulse is disabled under
  `prefers-reduced-motion`.
- **Analyser pane** — two views, toggled in the header. `VU / SCOPE` (default) is the VU pair
  beside the oscilloscope; `SPECTRUM` keeps the original waveform + log-frequency canvas,
  which is still the view you want when hunting a resonance rather than setting a level.
- **Add-module control** (`AddModule` in `rack.tsx`) — a full-height dashed amber drop-zone
  bay with a circled `+`, the words `ADD MODULE` and a hint line, all legible without
  hovering. The previous 46px rail labelled with a bare `+` glyph failed a real first-time
  user, who could not work out how to add anything to the chain.

- **Dials** (`<Knob skin="metal">`) — SVG only: an 11-pip dot scale ring outside the dial
  (pips before the value tint teal), 36 alternating knurl ticks on the rim, rim ring +
  domed cap from two size-keyed gradients, one specular arc, teal value arc, white index
  line. Gradient ids are keyed by **size**, not by instance, so the `<defs>` count stays
  flat with 50 knobs on screen.

### Performance rule — no CSS filters, no bitmaps

Gradients and box-shadows only. A `filter: blur()` or `drop-shadow` forces an offscreen
compositing pass **per element**; with 50+ knobs and several faceplates visible that is
the difference between a 60fps knob drag and a 30fps one. Any future depth effect must be
faked with layered gradients.

### Live band ladder

`components/band-ladder.tsx` draws the vocoder's real per-band VCA gains — each bar IS the
envelope follower opening that band, mapped through a -60dB floor so consonants move it (a
linear envelope only responds to a shout). Transport is the existing `getVisual()` channel:
one postMessage + Promise per request, polled at **~24fps with an in-flight guard**, with
local eased release between polls so the fall is smooth instead of stepping at the poll
rate. The faster option — writing envelopes into the SharedArrayBuffer meter block — was
rejected for now because it changes the SAB layout, which is far deeper than a display
warrants.

### Round 3 corrections (2026-08-26)

**Brushed grain — why the first attempt read as dots.** The `.mk-face` grain was a
`repeating-linear-gradient(90deg, ...)` with hard 1px on/off stops. Hard 1px stops alias
against fractional device pixel ratios and render as a field of dots rather than hairlines.
It is now **two soft-stop layers**: a fine 5px-period layer (5% white / 12% black, each
fading through 0%) plus a coarse 23px-period layer (3.5% / 8%). Two frequencies matter —
real brushed metal has long uneven drag marks, not one ruled pitch. The 157 deg sheen and
base tone layers are unchanged.

**Screws — a specificity trap, recorded so nobody re-adds it.** `ScrewRow()` positioned
its four bolts with the Tailwind class `absolute`, but `.mk-screw` declares
`position: relative` for its slot pseudo-element. Both are single-class selectors, so
source order decided and the stylesheet won: all four bolts collapsed into normal flow at
the top-left. Position now lives in the **inline style** (`position: absolute`, 7px inset),
which outranks both.

**Merged INPUT -> OUTPUT panel** (`components/io-strip.tsx`). Two stacked panels wasted a
header and put in-level and out-level — the two things you actually compare — as far apart
as possible. One console-style panel now runs **TRIM fader (left, cyan) - IN and OUT meters
back-to-back in the centre (22px each) - GAIN fader (right)**, all 138px tall, with MONO /
SWAP / MUTE / BYPASS as a compact 2-col switch grid beneath. Aside width 188 -> 286.

**VU meters outboard.** `ScopeStrip` is now `VuMeter L - oscilloscope - VuMeter R`: the
scope is the thing you read continuously, so it takes the wide centre and the two needles
frame it. Each meter reserves an **11px footer band** below the cream face for the
`VU METER L/R` and `PEAK` legends — previously they were drawn over a 5px bezel sliver and
read as clipped.

**Voice Lab moved to the right column** and given its own tone `#f472b6`. It was crammed in
the left rail against the presets browser, and it had been passing `tone={RAIL_TONE.voice}`
against a `RAIL_TONE` that never declared a `voice` key, so it rendered untinted.

## Gradient skin (round 4, 2026-08-26) — supersedes the brushed-metal face

The brushed-aluminium faceplate is retired. The new reference is a moulded module with a
**symmetric horizontal gradient**: near-black at both outer edges lifting to a broad soft
crest through the centre.

Sampled off the reference render (neutral grey, no blue tint, near-flat vertically):
edge `#131314` -> `#1c1d1e` at 14% -> `#26282a` at 34% -> `#2c2e30` at 50%, mirrored.

- `.mk-face` (the vocoder's metal plate) = that gradient + a faint top-down sheen,
  `border-radius: 10px`, one bright top lip and a black bottom lip. **No texture layer, no
  side bevels, no screws.** Any hairline grain at this panel size either aliases into dots
  or reads as noise; side bevels doubled up against the gradient falloff and gave the plate
  a drawn outline. `ScrewRow()` still exists but is no longer rendered.
- `.vk-grad-face` = the same gradient as a **background-only** class on every flat rack
  module, so the whole chain shares the look without dragging the metal control skin
  (dials, engraving, glass windows) onto all 22 modules. Panel border, category-coloured
  header and layout are untouched.

### Dry/wet slider

`MiniSlider` in `controls.tsx` is the only dry/wet control in the app — the master blend and
every per-module MIX strip render through it, so the restyle is global by construction.
Built from the slider reference: a sunken hatched channel (6px, `72deg` hairline repeat over
a dark vertical base), a lit accent run that **glows via box-shadow** up to the value, and a
10x16 milled handle straddling the channel. The glow is a box-shadow and never a
`filter: drop-shadow` — a filter repaints offscreen per element and there can be 20+ of
these visible at once.

### I/O header

`INPUT` and `OUTPUT` are `justify-between` so each word sits over the fader it owns — INPUT
above TRIM on the left, OUTPUT above GAIN on the right, arrow centred over the meters.

## Round 5 (2026-08-26) — metal controls everywhere, VU face finished

### Metal controls on all 22 modules
The round-1 gate ("preview one panel, then roll out") is open. `RackModule` in `rack.tsx` now
renders `<ParamGrid skin="metal" accent={color} />` and carries a leading **`mk`** class on
its root div. That `mk` class is not cosmetic: it is what declares the `--mk-*` custom
properties, so without it the dial gradients and `.mk-etch` group labels resolve against
nothing.

**Accent is the module's `CATEGORY_COLOR`, not a single teal.** This partially reverses
round-1 decision 2, deliberately. Teal-only was fine while exactly one module was metal; with
all 22 skinned it made every module in the rack look identical, which is the one caveat that
was logged against that decision. Per-category accents on metal dials resolve it — a glance
still tells you which module you are on.

`MetalVocoderModule` stays a separate component, but no longer because it is the only metal
module: it carries the live 16-band ladder and the carrier-source LED row.

### VU face
Two problems, both fixed:

1. **`VU` legend overlapped the numerals.** It was drawn at 46% of face height, dead centre —
   exactly where the graduation arc's numbers pass through. Moving it to bottom-centre failed
   too (the needle pivots below centre and swept straight through it). It now sits boxed in
   the **bottom-left corner** with a `BRO.KODR` maker mark balancing the bottom-right. On a VU
   card the corners are the only genuinely clear area.
2. **Numerals crowded.** At 152px wide, 10/7/5 and 3/2/1/0 touched. Type was reduced
   (`fh * 0.115`), travel widened to +/-0.68 rad, and the intermediate numbers (7, 2, 1, +1)
   **lose their digits but keep their ticks** below 170px — which is exactly what real
   small-format meters do. The face now prints 20 10 5 3 0 +3.

"A bit plain" was answered with five additions, all gradients and strokes, no filters:
radial vignette over the cream (the flat rectangle was what made it read as a drawing), a
wide translucent red overrun **band** inboard of the arc (on a real face the red is an area,
not a coloured line), a tapered needle, a needle cast shadow drawn as a second offset stroke,
and clipped diagonal glass reflection plus dark inner / light outer lips around the face
opening.

### Module shell (round 5b)
The vocoder's shell is now every module's shell: a dark `.mk-chassis` with 3px showing all
round and a moulded `.mk-face` plate inset into it, replacing the single flat `.vk-panel`
with a 3px border radius. The plate carries the 10px radius measured off the render, and the
3px of visible chassis is what makes each module read as a separate unit in the chain rather
than a cell in a grid. `overflow-hidden` on the plate is load-bearing — the category header
and the mix strip are square, and without it their corners punch back through the rounded
plate. Module widths gained 6px (208 -> 214, 268 -> 274) so the control area inside is
unchanged. `.vk-grad-face` is no longer applied to modules: `.mk-face` carries the same
gradient, so the background-only class is now unused.

### Module headers (round 5c)
The vocoder now wears the same `.vk-tone-head` category bar as every other module, expanded
and collapsed. Its engraved nameplate was the last piece of the original one-off metal
treatment, and it left the vocoder as the only module in the chain with no colour box — the
one module you could not place by category at a glance. The plate keeps `overflow-hidden` so
the square header clips to the 10px radius.
