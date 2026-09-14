/**
 * Bro.Kodr — engine core (backend-agnostic).
 *
 * This is the piece a native (WASAPI/ASIO) backend would call instead of the
 * AudioWorklet. It has NO dependency on AudioWorklet, AudioContext, DOM or Node —
 * it is a pure processor:
 *
 *     const engine = new Engine(sampleRate, maxBlock);
 *     engine.applyCommand(cmd);            // control changes, off the audio thread's queue
 *     engine.process(inL, inR, outL, outR, frames);
 *
 * Design constraints, all deliberate:
 *  - Zero allocation in process(). Every buffer is allocated in the constructor or on
 *    an explicit control command, never in the audio callback.
 *  - No exceptions thrown on the audio path. A broken effect is skipped, not fatal.
 *  - Chain order is an array of slots; reordering is a control command that swaps
 *    references, so audio never stops and no filter state is destroyed.
 *  - Dry/wet and bypass are handled HERE, generically, so effects always render 100%
 *    wet and stay simple.
 *  - Metering (peak/RMS with peak-hold) and the record taps live here so the same
 *    numbers are available regardless of backend.
 */

import { dbToGain, clamp, sanitize, gainToDb } from "./core/utils.js";
import { Smoother } from "./core/utils.js";
import { FilePlayer } from "./core/file-player.js";
import { Chain, MAX_SLOTS } from "./core/chain.js";
import { DrumRack, PAD_COUNT } from "./core/drum-rack.js";
import { Clock } from "./core/clock.js";
import { Looper, LOOP_TRACKS, LOOP_METER_STRIDE } from "./core/looper.js";
import { SmartVoice, CLASS_COUNT, VOICE_METER_STRIDE, CAP_STRIDE } from "./core/beat-classify.js";

/**
 * Where the file player's output goes.
 *  OFF     — silent.
 *  INPUT   — the file is a normal source: it sums into the chain input alongside the
 *            mic (mute the mic to hear the file alone), so every effect AND the
 *            recorder see it.
 *  CARRIER — the file feeds the carrier bus instead: talk box / vocoder use it as the
 *            driver signal that the voice shapes. That is the real talk box rig.
 *  BOTH    — drives the carrier and is audible through the chain.
 */
const FILE_ROUTE = { OFF: 0, INPUT: 1, CARRIER: 2, BOTH: 3 };

/**
 * Where BROBEATS lands in the signal path.
 *  OFF    — rack silent (and skipped entirely).
 *  DIRECT — straight to the output stage, past the voice chain. The default, because a
 *           vocoder or formant shifter set up for a voice does nothing good to a kick.
 *           Summed into BOTH the dry and wet taps so the master dry/wet — which belongs
 *           to the voice — never ducks the drums.
 *  CHAIN  — into the chain input alongside the mic, so the master rack processes voice
 *           and drums together. This is what you want for bus glue, or for deliberately
 *           crushing the whole kit through the same distortion as the vocal.
 */
const DRUM_ROUTE = { OFF: 0, DIRECT: 1, CHAIN: 2 };

export class Engine {
  constructor(sampleRate, maxBlock) {
    this.sr = sampleRate;
    this.maxBlock = maxBlock;

    // Scratch buffers — allocated once.
    this.dryL = new Float32Array(maxBlock);
    this.dryR = new Float32Array(maxBlock);
    this.chainInL = new Float32Array(maxBlock);
    this.chainInR = new Float32Array(maxBlock);

    // File player + carrier bus. The bus is a second signal path that effects can opt
    // into (talk box, vocoder) via setCarrierBus(); it is filled before the chain runs
    // so an effect always reads carrier samples that belong to the current block.
    this.player = new FilePlayer(sampleRate, maxBlock);
    this.carrierL = new Float32Array(maxBlock);
    this.carrierR = new Float32Array(maxBlock);
    this.fileRoute = FILE_ROUTE.INPUT;

    // The master chain. Everything about slot ordering, per-slot dry/wet and bypass
    // lives in Chain, so drum pads and loop tracks get identical behaviour for free.
    // Built after the carrier bus so effects that opt in receive the real references.
    this.chain = new Chain(sampleRate, maxBlock, {
      maxSlots: MAX_SLOTS,
      carrierL: this.carrierL,
      carrierR: this.carrierR,
    });

    // BROBEATS. Its own bus so the route can change without the drums ever being
    // caught half-way through a block on two different paths.
    this.drums = new DrumRack(sampleRate, maxBlock);
    this.drumL = new Float32Array(maxBlock);
    this.drumR = new Float32Array(maxBlock);
    this.drumRoute = DRUM_ROUTE.DIRECT;

    // Transport + looper. The clock free-runs from engine start (see clock.js for why),
    // and the looper is clock-slaved, so both exist for the engine's whole life.
    this.clock = new Clock(sampleRate);
    this.looper = new Looper(sampleRate, maxBlock);
    // The master tap: the post-chain, post-drums blend the looper RECORDS, and the
    // buffer loop playback sums into. Two separate pairs deliberately — a loop must
    // never be able to record itself, and keeping the record source physically
    // separate from the loop output makes that structural rather than a subtle
    // read-before-write argument that a later refactor could quietly break.
    this.tapL = new Float32Array(maxBlock);
    this.tapR = new Float32Array(maxBlock);
    this.loopL = new Float32Array(maxBlock);
    this.loopR = new Float32Array(maxBlock);
    // Record-source descriptor, reused every block so process() allocates nothing.
    this.recSrc = { masterL: null, masterR: null, drumL: null, drumR: null };

    // Smart Voice. It listens to its own tap — see the block in process() for why it
    // cannot be handed any of the existing ones — so it owns a mono scratch buffer,
    // allocated here like everything else.
    this.voice = new SmartVoice(sampleRate);
    this.voiceBuf = new Float32Array(maxBlock);

    // I/O gain stages.
    this.inGain = new Smoother(sampleRate, 20, 1);
    this.outGain = new Smoother(sampleRate, 20, 1);
    this.masterMix = new Smoother(sampleRate, 25, 1);
    this.inMuted = false;
    this.masterBypass = false;
    this.monoInput = false;
    this.inputSwap = false;

    // Metering state.
    this.meterInL = 0;
    this.meterInR = 0;
    this.meterOutL = 0;
    this.meterOutR = 0;
    this.rmsInL = 0;
    this.rmsInR = 0;
    this.rmsOutL = 0;
    this.rmsOutR = 0;
    this.clipIn = 0;
    this.clipOut = 0;
    this.peakHoldIn = 0;
    this.peakHoldOut = 0;

    // Per-slot meter readouts, polled by the UI.
    this.slotMeters = new Float32Array(MAX_SLOTS);

    this.blockCount = 0;
    this.cpuLoad = 0;
  }

  /**
   * The master chain's slots. Kept as a property on Engine because the worklet host and
   * the DSP test harness both read `engine.slots` directly.
   */
  get slots() {
    return this.chain.slots;
  }

  get latencySamples() {
    return this.chain.latencySamples;
  }

  // ---------------------------------------------------------------- control

  /**
   * Apply one control command. Called from the audio thread's command drain
   * (before processing a block), so allocation here is acceptable only for
   * structural commands — which is why param changes are a separate, allocation-free path.
   */
  applyCommand(cmd) {
    switch (cmd.t) {
      case "add": {
        this.chain.add(cmd);
        break;
      }
      case "remove": {
        this.chain.remove(cmd.id);
        break;
      }
      case "move": {
        this.chain.move(cmd.id, cmd.index);
        break;
      }
      case "param": {
        this.chain.setParam(cmd.id, cmd.key, cmd.value);
        break;
      }
      case "mix": {
        this.chain.setMix(cmd.id, cmd.value);
        break;
      }
      case "bypass": {
        this.chain.setBypass(cmd.id, cmd.value);
        break;
      }
      case "reset": {
        this.chain.resetSlot(cmd.id);
        break;
      }
      case "clear": {
        this.chain.clear();
        break;
      }
      case "io": {
        if (cmd.inGain !== undefined) this.inGain.set(dbToGain(cmd.inGain));
        if (cmd.outGain !== undefined) this.outGain.set(dbToGain(cmd.outGain));
        if (cmd.mute !== undefined) this.inMuted = !!cmd.mute;
        if (cmd.bypass !== undefined) this.masterBypass = !!cmd.bypass;
        if (cmd.mono !== undefined) this.monoInput = !!cmd.mono;
        if (cmd.swap !== undefined) this.inputSwap = !!cmd.swap;
        if (cmd.masterMix !== undefined) this.masterMix.set(clamp(cmd.masterMix, 0, 1));
        break;
      }
      case "fileload": {
        // Structural: the decoded audio arrives as SAB-backed views, so this is a
        // pointer handoff, not a copy, no matter how long the file is.
        this.player.setBuffer(cmd.chL, cmd.chR, cmd.frames, cmd.rate);
        break;
      }
      case "fileclear": {
        this.player.clearBuffer();
        break;
      }
      case "file": {
        this.player.setParam(cmd.key, cmd.value);
        break;
      }
      case "fileroute": {
        this.fileRoute = clamp(Math.round(cmd.value), 0, 3);
        break;
      }
      // ---- BROBEATS ------------------------------------------------------
      case "pad": {
        // Hit. The hottest command in the app once Smart Voice is driving it, so it
        // stays a plain numeric op all the way down.
        this.drums.trigger(cmd.index | 0, cmd.vel === undefined ? 1 : cmd.vel);
        break;
      }
      case "padoff": {
        this.drums.release(cmd.index | 0);
        break;
      }
      case "padparam": {
        this.drums.setPadParam(cmd.index | 0, cmd.key, cmd.value);
        break;
      }
      case "padload": {
        // Same handoff as "fileload": decoded on the UI thread, arrives as SAB-backed
        // views, so loading a 30-second sample onto a pad copies nothing here.
        this.drums.setPadBuffer(cmd.index | 0, cmd.layer | 0, cmd.data, cmd.frames, cmd.rate);
        break;
      }
      case "padclear": {
        this.drums.clearPad(cmd.index | 0);
        break;
      }
      case "drum": {
        if (cmd.key === "route") this.drumRoute = clamp(Math.round(cmd.value), 0, 2);
        else this.drums.setParam(cmd.key, cmd.value);
        break;
      }
      case "drumreset": {
        this.drums.reset();
        break;
      }
      // Per-pad effect chain. Same verbs as the master rack, one extra field for which
      // pad — the whole point of Chain being shared.
      case "padfx": {
        const chain = this.drums.chainFor(cmd.index | 0);
        if (!chain) break;
        switch (cmd.op) {
          case "add":
            chain.add(cmd);
            break;
          case "remove":
            chain.remove(cmd.id);
            break;
          case "move":
            chain.move(cmd.id, cmd.at);
            break;
          case "param":
            chain.setParam(cmd.id, cmd.key, cmd.value);
            break;
          case "mix":
            chain.setMix(cmd.id, cmd.value);
            break;
          case "bypass":
            chain.setBypass(cmd.id, cmd.value);
            break;
          case "reset":
            chain.resetSlot(cmd.id);
            break;
          case "clear":
            chain.clear();
            break;
        }
        break;
      }
      // ---- looper ---------------------------------------------------------
      // Transport verbs. Every one is quantised by the looper against this.clock, so a
      // command that arrives mid-block still lands on the next grid line, not on the
      // block boundary it happened to be drained at.
      case "loop": {
        const i = cmd.index | 0;
        switch (cmd.op) {
          case "rec":
            this.looper.recordToggle(i, this.clock);
            break;
          case "play":
            this.looper.playToggle(i, this.clock);
            break;
          case "stop":
            this.looper.stop(i, this.clock);
            break;
          case "clear":
            this.looper.clear(i);
            break;
          case "clearall":
            this.looper.clearAll();
            break;
          case "undo":
            this.looper.undo(i);
            break;
        }
        break;
      }
      case "loopparam": {
        this.looper.setTrackParam(cmd.index | 0, cmd.key, cmd.value);
        break;
      }
      case "looperparam": {
        this.looper.setParam(cmd.key, cmd.value);
        break;
      }
      // Per-loop-track effect chain. Identical verbs to "padfx" — the same Chain, so
      // the same protocol, deliberately.
      case "loopfx": {
        const chain = this.looper.chainFor(cmd.index | 0);
        if (!chain) break;
        switch (cmd.op) {
          case "add":
            chain.add(cmd);
            break;
          case "remove":
            chain.remove(cmd.id);
            break;
          case "move":
            chain.move(cmd.id, cmd.at);
            break;
          case "param":
            chain.setParam(cmd.id, cmd.key, cmd.value);
            break;
          case "mix":
            chain.setMix(cmd.id, cmd.value);
            break;
          case "bypass":
            chain.setBypass(cmd.id, cmd.value);
            break;
          case "reset":
            chain.resetSlot(cmd.id);
            break;
          case "clear":
            chain.clear();
            break;
        }
        break;
      }
      // ---- Smart Voice ----------------------------------------------------
      // Params on one verb, calibration on another. Split because the param path is
      // hot (a panel fader sends a stream of them) while calibration is a handful of
      // deliberate commands, and keeping the fader off a nested switch keeps it flat.
      case "voice": {
        this.voice.setParam(cmd.key, cmd.value);
        break;
      }
      case "voicecal": {
        switch (cmd.op) {
          case "centroid":
            this.voice.setCentroid(cmd.cls | 0, cmd.feature | 0, cmd.value);
            break;
          case "attack":
            this.voice.setAttackCentroid(cmd.cls | 0, cmd.band | 0, cmd.value);
            break;
          case "pad":
            // No default of 0 here: an absent pad means "mute this class", and a
            // missing field silently firing pad 0 would be a confusing bug to chase.
            this.voice.setClassPad(cmd.cls | 0, cmd.pad === undefined ? -1 : cmd.pad | 0);
            break;
          case "capture":
            this.voice.setCapture(cmd.cls === undefined ? -1 : cmd.cls | 0);
            break;
          case "clear":
            this.voice.clearCaptures();
            break;
          case "reset":
            this.voice.resetCentroids();
            break;
          case "detreset":
            this.voice.resetDetector();
            break;
        }
        break;
      }
      case "clock": {
        this.clock.setParam(cmd.key, cmd.value);
        break;
      }
      case "clipreset": {
        this.clipIn = 0;
        this.clipOut = 0;
        this.peakHoldIn = 0;
        this.peakHoldOut = 0;
        break;
      }
      case "panic": {
        this.chain.panic();
        this.drums.reset();
        // The detector's envelopes go with it: a panic in the middle of a hit would
        // otherwise leave a half-measured onset pending, which fires or miscounts as
        // soon as audio resumes.
        this.voice.resetDetector();
        // Drops an in-progress take and silences playback, but keeps recorded audio:
        // panic means "stop the noise", not "destroy the performance".
        this.looper.reset();
        break;
      }
    }
  }

  /** Sum of latency-introducing modules (currently only the STFT pitch shifter). */
  recalcLatency() {
    return this.chain.recalcLatency();
  }

  /** Snapshot of per-slot meters + engine meters for the UI. */
  readMeters(out) {
    out[0] = this.meterInL;
    out[1] = this.meterInR;
    out[2] = this.meterOutL;
    out[3] = this.meterOutR;
    out[4] = this.rmsInL;
    out[5] = this.rmsInR;
    out[6] = this.rmsOutL;
    out[7] = this.rmsOutR;
    out[8] = this.clipIn;
    out[9] = this.clipOut;
    out[10] = this.cpuLoad;
    out[11] = this.latencySamples;
    out[12] = this.slots.length;
    // 40+ is free space past the per-slot meters (16 + MAX_SLOTS = 40): file transport.
    out[40] = this.player.position;
    out[41] = this.player.playing ? 1 : 0;
    out[42] = this.player.frames;
    out[43] = this.player.loaded ? this.player.srcRate : 0;
    out[44] = this.player.meter;
    this.chain.readSlotMeters(out, 16);

    // 48+ : BROBEATS. Sixteen pad peaks, the rack bus, and the pads that fired this
    // read as a bitmask — a bitmask because a pad can fire and finish between two UI
    // frames, and a peak alone would miss the flash.
    const pads = this.drums.padMeters;
    let fired = 0;
    for (let i = 0; i < PAD_COUNT; i++) {
      out[48 + i] = pads[i];
      if (this.drums.triggerFlags[i] > 0) fired |= 1 << i;
    }
    out[64] = this.drums.meterL;
    out[65] = this.drums.meterR;
    out[66] = fired;
    out[67] = this.drumRoute;

    // 68+ : the looper. LOOP_TRACKS * LOOP_METER_STRIDE values (68..99 at four tracks),
    // then the transport. Append-only past here, same rule as everything above.
    this.looper.readMeters(out, 68);
    const base = 68 + LOOP_TRACKS * LOOP_METER_STRIDE;
    out[base] = this.clock.bpm;
    out[base + 1] = this.clock.beatsPerBar;
    out[base + 2] = this.clock.quantize;
    out[base + 3] = this.clock.running ? 1 : 0;
    // Bar phase and bar count come from the engine rather than being counted in the UI:
    // a UI-side counter drifts against the audio clock the moment a frame is dropped,
    // and a playhead that drifts is worse than no playhead.
    out[base + 4] = this.clock.barPhase;
    out[base + 5] = Math.floor(this.clock.bar);
    out[base + 6] = this.looper.meterL;
    out[base + 7] = this.looper.meterR;

    // Next block along: Smart Voice. Its own 12 readouts, then the live attack bands
    // and the class->pad map, which are state the panel has to display but which are
    // not meters — they ride here anyway because the meter poll is the only channel
    // that already runs every UI frame, and a second one would just be a second thing
    // to keep in sync.
    const vb = base + 8;
    this.voice.readMeters(out, vb);
    const band = this.voice.lastBand;
    out[vb + VOICE_METER_STRIDE] = band[0];
    out[vb + VOICE_METER_STRIDE + 1] = band[1];
    out[vb + VOICE_METER_STRIDE + 2] = band[2];
    for (let c = 0; c < CLASS_COUNT; c++) {
      out[vb + VOICE_METER_STRIDE + 3 + c] = this.voice.classPad[c];
    }
  }

  /**
   * One calibration capture, by number. Off the meter path deliberately: captures are
   * drained a handful at a time when the calibration UI is open, not every frame, and
   * CAP_STRIDE values x 64 slots has no business in a per-frame snapshot.
   */
  readVoiceCapture(n, out) {
    return this.voice.readCapture(n, out);
  }

  /**
   * Values per capture row, so a host can size its own scratch without importing
   * beat-classify.js. The worklet adapter deliberately imports nothing but this file.
   */
  get voiceCaptureStride() {
    return CAP_STRIDE;
  }

  // ---------------------------------------------------------------- audio

  /**
   * Process one block. inL/inR and outL/outR may be the same arrays.
   * Returns nothing; never throws.
   */
  process(inL, inR, outL, outR, frames) {
    const dryL = this.dryL;
    const dryR = this.dryR;
    const cInL = this.chainInL;
    const cInR = this.chainInR;

    // ---- input stage: gain, mute, mono fold, channel swap, metering --------
    let pkInL = 0;
    let pkInR = 0;
    let sqInL = 0;
    let sqInR = 0;
    const muted = this.inMuted;

    // ---- file player -> carrier bus ---------------------------------------
    // Rendered before the input stage so the bus is valid for every effect in this
    // block, and so INPUT routing can sum it in below at the same gain stage as the
    // mic (which is what makes the recorder capture it for free).
    const route = this.fileRoute;
    const carL = this.carrierL;
    const carR = this.carrierR;
    let fileOn = false;
    if (route !== FILE_ROUTE.OFF && this.player.loaded) {
      fileOn = this.player.process(carL, carR, frames);
    } else {
      for (let i = 0; i < frames; i++) {
        carL[i] = 0;
        carR[i] = 0;
      }
    }
    const fileToInput = fileOn && (route === FILE_ROUTE.INPUT || route === FILE_ROUTE.BOTH);

    // ---- Smart Voice ------------------------------------------------------
    // Runs BEFORE the rack renders, so a hit decided in this block is audible in this
    // block rather than one buffer later.
    //
    // It reads the raw input, not dryL/dryR and not the chain input, for three reasons
    // that are all structural rather than preference:
    //  - pre-effects: a pitch shifter or vocoder in the chain rewrites exactly the
    //    spectral features the classifier measures, so a calibrated profile would stop
    //    matching the moment the performer added an effect;
    //  - pre-mute: muting the mic is how you beatbox without your voice in the mix,
    //    which is the single most obvious way to play this thing. dryL/dryR is already
    //    zeroed by the mute, so feeding it would make mute mean "stop the drums too";
    //  - no file, no drums: both sum into the input stage below, and a detector that
    //    can hear the kit it is firing retriggers itself into a runaway roll.
    // Input gain is not applied either — it is a Smoother, advanced exactly once per
    // sample in the loop below, and the detector's own gate (`floorDb`) plus
    // `sensitivity` are the level controls that belong to detection.
    //
    // Folded to mono by a plain average: it costs a true one-sided mic 6 dB, which the
    // gate absorbs, and unlike picking the louder channel it cannot invent harmonics in
    // the bands the classifier reads.
    const sv = this.voice;
    if (sv.enabled) {
      const vb = this.voiceBuf;
      for (let i = 0; i < frames; i++) vb[i] = sanitize((inL[i] + inR[i]) * 0.5);
      const hits = sv.process(vb, frames);
      for (let i = 0; i < hits; i++) this.drums.trigger(sv.firePad[i], sv.fireVel[i]);
    }

    // ---- BROBEATS ---------------------------------------------------------
    // Rendered before the input stage so the CHAIN route can sum it in below at the
    // same point as the mic. Skipped entirely when nothing is ringing: an idle rack
    // must cost nothing, because it is idle most of the time.
    const drumRoute = this.drumRoute;
    const drumL = this.drumL;
    const drumR = this.drumR;
    const drumsOn = drumRoute !== DRUM_ROUTE.OFF && this.drums.sounding;
    if (drumsOn) {
      for (let i = 0; i < frames; i++) {
        drumL[i] = 0;
        drumR[i] = 0;
      }
      this.drums.process(drumL, drumR, frames);
    }
    const drumsToInput = drumsOn && drumRoute === DRUM_ROUTE.CHAIN;
    const drumsDirect = drumsOn && drumRoute === DRUM_ROUTE.DIRECT;

    for (let i = 0; i < frames; i++) {
      const g = this.inGain.next();
      let l = inL[i];
      let r = inR[i];
      if (this.inputSwap) {
        const t = l;
        l = r;
        r = t;
      }
      if (this.monoInput) {
        const m = (l + r) * 0.5;
        l = m;
        r = m;
      }
      l = muted ? 0 : sanitize(l * g);
      r = muted ? 0 : sanitize(r * g);
      if (fileToInput) {
        // Summed post input-gain so the file level is set by its own fader, not by the
        // mic trim, and so dryL/dryR (the clean-take tap) contain it.
        l = sanitize(l + carL[i]);
        r = sanitize(r + carR[i]);
      }
      if (drumsToInput) {
        // Post input-gain for the same reason the file is: the kit has its own fader,
        // and the clean-take tap should contain what the performer actually played.
        l = sanitize(l + drumL[i]);
        r = sanitize(r + drumR[i]);
      }

      const al = Math.abs(l);
      const ar = Math.abs(r);
      if (al > pkInL) pkInL = al;
      if (ar > pkInR) pkInR = ar;
      sqInL += l * l;
      sqInR += r * r;

      cInL[i] = l;
      cInR[i] = r;
      dryL[i] = l;
      dryR[i] = r;
    }

    if (pkInL >= 0.999 || pkInR >= 0.999) this.clipIn = 1;
    this.meterInL = pkInL;
    this.meterInR = pkInR;
    this.rmsInL = Math.sqrt(sqInL / frames);
    this.rmsInR = Math.sqrt(sqInR / frames);

    // ---- effect chain ------------------------------------------------------
    // Rendered in place. Slot ordering, per-slot dry/wet and bypass all live in Chain.
    if (!this.masterBypass) this.chain.process(cInL, cInR, frames);

    // DIRECT drums join here, past the voice chain but before the master fader, and
    // into both taps: the master dry/wet is the VOICE's blend, and pulling it back to
    // hear a dry vocal must not fade the kit out with it.
    if (drumsDirect) {
      for (let i = 0; i < frames; i++) {
        const l = drumL[i];
        const r = drumR[i];
        dryL[i] += l;
        dryR[i] += r;
        cInL[i] += l;
        cInR[i] += r;
      }
    }

    // ---- master tap, looper, output stage -----------------------------------
    // The voice dry/wet is resolved one stage BEFORE the master fader, because that
    // blend is exactly "everything you hear except loop playback" — which is what a
    // looper has to record. Recording after the fader would bake fader moves into the
    // take; recording before the blend would record a vocal the performer is not
    // hearing.
    //
    // Two paths on purpose. An idle looper is the overwhelmingly common case and keeps
    // the original single fused pass — blend, fade, meter, clamp, one pass over the
    // block. Only a live looper pays for the separate tap buffer it records from, and
    // the second pass over the block that implies. An idle looper costs one boolean.
    const loopOn = this.looper.active;
    let pkOutL = 0;
    let pkOutR = 0;
    let sqOutL = 0;
    let sqOutR = 0;

    if (loopOn) {
      const tapL = this.tapL;
      const tapR = this.tapR;
      const loopL = this.loopL;
      const loopR = this.loopR;
      for (let i = 0; i < frames; i++) {
        const mm = this.masterMix.next();
        tapL[i] = dryL[i] * (1 - mm) + cInL[i] * mm;
        tapR[i] = dryR[i] * (1 - mm) + cInR[i] * mm;
        loopL[i] = 0;
        loopR[i] = 0;
      }
      const src = this.recSrc;
      src.masterL = tapL;
      src.masterR = tapR;
      // Null when the rack is idle: drumL/drumR then hold the last block it played, and
      // a track set to record DRUMS would otherwise capture that stale block on repeat.
      src.drumL = drumsOn ? drumL : null;
      src.drumR = drumsOn ? drumR : null;
      this.looper.process(src, loopL, loopR, frames, this.clock);

      for (let i = 0; i < frames; i++) {
        const g = this.outGain.next();
        // Loop playback joins the tap and both go through the master fader together.
        // It is NOT touched by the voice dry/wet: that blend was already resolved into
        // the tap, and pulling the vocal dry must not duck the loops with it.
        const l = (tapL[i] + loopL[i]) * g;
        const r = (tapR[i] + loopR[i]) * g;

        const al = Math.abs(l);
        const ar = Math.abs(r);
        if (al > pkOutL) pkOutL = al;
        if (ar > pkOutR) pkOutR = ar;
        sqOutL += l * l;
        sqOutR += r * r;

        // Hard safety clamp — protects speakers/ears from a runaway feedback path.
        // Never a substitute for the limiter; purely a last resort.
        outL[i] = sanitize(clamp(l, -1.4, 1.4));
        outR[i] = sanitize(clamp(r, -1.4, 1.4));
      }
    } else {
      for (let i = 0; i < frames; i++) {
        const mm = this.masterMix.next();
        const g = this.outGain.next();
        const l = (dryL[i] * (1 - mm) + cInL[i] * mm) * g;
        const r = (dryR[i] * (1 - mm) + cInR[i] * mm) * g;

        const al = Math.abs(l);
        const ar = Math.abs(r);
        if (al > pkOutL) pkOutL = al;
        if (ar > pkOutR) pkOutR = ar;
        sqOutL += l * l;
        sqOutR += r * r;

        outL[i] = sanitize(clamp(l, -1.4, 1.4));
        outR[i] = sanitize(clamp(r, -1.4, 1.4));
      }
    }

    if (pkOutL >= 0.999 || pkOutR >= 0.999) this.clipOut = 1;
    this.meterOutL = pkOutL;
    this.meterOutR = pkOutR;
    this.rmsOutL = Math.sqrt(sqOutL / frames);
    this.rmsOutR = Math.sqrt(sqOutR / frames);

    // Last, so every punch inside this block was quantised against the frame number the
    // block STARTED at. Advancing first would put the grid a block ahead of the audio.
    this.clock.advance(frames);
    this.blockCount++;
  }
}

export { MAX_SLOTS };
