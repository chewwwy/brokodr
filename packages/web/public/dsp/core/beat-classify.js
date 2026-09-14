/**
 * Bro.Kodr DSP core — Smart Voice: beatbox classification and pad firing.
 *
 * `onset.js` answers "a hit started, here is its timbre in four numbers". This answers
 * "which drum was that, and how hard" — and fires the pad. Together they are Smart
 * Voice: mouth in, kit out.
 *
 * ## Nearest centroid, not a model
 *
 * One stored vector per class; a hit is whichever class vector it lands closest to.
 * That is the whole classifier. It is not a compromise:
 *
 *   - It trains from eight examples. A net needs thousands, and nobody is recording
 *     thousands of mouth kicks to use a drum machine.
 *   - It runs in ~30 multiplies, inside the audio callback, with no allocation and no
 *     model file to ship or version.
 *   - It is inspectable. When it gets a sound wrong the user can see *why* — the
 *     hit's four numbers and the four centroids are all on screen — and recalibrating
 *     that one class fixes it. A wrong answer from a net is opaque.
 *
 * The features (`onset.js`) are three normalised band energies plus a zero-crossing
 * rate. Normalising the bands to sum to 1 is what makes this level-invariant: the same
 * kick close to the mic and across the room lands on the same point, so distance means
 * timbre and only timbre. Loudness is deliberately excluded from the feature vector and
 * used for velocity instead, which is where it belongs.
 *
 * ## Why calibration matters more than anything else here
 *
 * The two factory tables below were measured from the factory kit's own one-shots (see
 * `scripts/measure-drum-features.mjs` and `scripts/measure-attack-features.mjs`) and
 * not adjusted afterwards by ear, because there is no mouth in that loop to adjust
 * toward. They are a starting point and nothing more: a mouth is not an 808, and every
 * beatboxer's mouth is spectrally different. Thirty seconds of calibration moves the
 * centroids onto *this* performer and is the difference between "impressive" and
 * "nearly right, constantly". Treat the shipped profile as the thing calibration
 * replaces, not as the product.
 *
 * ## Two-stage firing, and the honest limit of it
 *
 * A hit cannot be classified from its first sample — there is no timbre yet. So:
 *
 *   Stage 1, one block after the onset (~3 ms): classify on the three band envelopes as
 *   they stand then, against a table measured at that same point. Kick versus hat is
 *   obvious this early. If the nearest class wins by a clear margin, fire. Not the
 *   *same* block as the onset, for a reason worth reading — see STAGE1_DELAY_BLOCKS.
 *
 *   Stage 2, `featureMs` after the onset (8 ms by default, live): the real feature
 *   window has closed. Classify on all four features. If stage 1 declined to commit,
 *   fire now — the sound is 8 ms late, which is still inside what a drummer would call
 *   tight. If stage 1 already fired, stage 2 does **not** re-fire or correct it.
 *
 * That last sentence is the honest limit. Once a kick has left the speaker you cannot
 * un-hear it, and firing the "real" answer 6 ms later gives a flam rather than a fix.
 * So a stage-1 mistake stays a mistake, and instead it is *counted* — `corrections` is
 * reported to the UI, so a performer whose fast-mode error rate is visibly high can
 * switch to ACCURATE mode and trade 8 ms for the full four-feature decision on every
 * hit. That is a real dial the user can feel, rather than a hidden heuristic.
 *
 * ## What this deliberately cannot do
 *
 *   - **Simultaneous kick+hat.** Good beatboxers do it constantly; single-label
 *     nearest-centroid cannot express it. It classifies as whichever dominates. A
 *     dedicated combo class is the fix and is not in this pass.
 *   - **Closed versus open hat.** They differ in duration, and every feature here is
 *     measured in the first few milliseconds. Both land on the hat centroid. Splitting
 *     them needs a decay estimate taken ~80 ms in, by which time the pad has long fired.
 *   - **Rolls above ~22 hits/sec.** That is the detector's refractory period, not this.
 *   - **Singing over the top** false-triggers. Sustained pitched material has onsets
 *     too. The gate (`floorDb`) and `sensitivity` are the defence, and they are on the
 *     panel rather than buried, because the right setting is per-room and per-mic.
 *
 * Constraints, same as every file in this directory: no allocation once running, no
 * `#private` fields and no `extends` (the React Native worklet compiler rejects both),
 * and no knowledge of AudioWorklet, AudioContext, the DOM or Node.
 */

import { OnsetDetector, FEATURE_COUNT, ONSET_DEFAULTS } from "./onset.js";

/** Classes Smart Voice can fire, in wire order. APPEND ONLY — the index is persisted. */
export const VOICE_CLASS_NAMES = ["kick", "snare", "hat", "clap"];
export const CLASS_COUNT = 4;

export const VOICE_CLASS = { KICK: 0, SNARE: 1, HAT: 2, CLAP: 3 };

/**
 * FAST commits on the band-only decision when it is confident (see the two-stage note
 * above). ACCURATE never does, so every hit costs `featureMs` and gets all four
 * features. Neither is correct for everyone, which is why it is a control.
 */
export const VOICE_MODE = { FAST: 0, ACCURATE: 1 };

/**
 * Which pad each class fires, by default row 1 of `DEFAULT_KIT_LAYOUT` —
 * kick, snare, closed hat — plus the clap on pad 5. Not a coincidence: that layout was
 * built so the sounds Smart Voice classifies sit under the fingers in the obvious place.
 */
export const DEFAULT_CLASS_PADS = [0, 1, 2, 5];

/**
 * Factory centroids for the stage-2 decision: low, mid, high, zcr per class.
 *
 * These are the measured per-kind means of the factory kit's own one-shots at the live
 * 8 ms feature window — reproduce them with `node scripts/measure-drum-features.mjs 8`.
 * They are measured rather than hand-written on purpose. An earlier pass shipped
 * plausible-looking vectors "nudged toward how a mouth makes these sounds", which is a
 * guess wearing the costume of a measurement: there is no mouth in the loop that could
 * confirm the nudge, and a wrong default is much harder to debug than an honestly
 * derived one. A mouth is still not an 808 — but that gap is calibration's job, and
 * calibration replaces both of these tables with the performer's own numbers.
 */
export const FACTORY_CENTROIDS = [
  [0.336, 0.658, 0.006, 0.104], // kick  — low and mid, no high, very low zcr
  [0.278, 0.467, 0.255, 1.0], // snare — spread across all three, maximum zcr
  [0.0, 0.123, 0.877, 1.0], // hat   — high band only, maximum zcr
  [0.001, 0.869, 0.13, 0.797], // clap  — mid-dominant burst, noisy
];

/**
 * How many whole blocks after the onset block stage 1 waits before reading the band
 * envelopes. One, and this number is the whole of stage 1's reliability.
 *
 * The obvious implementation reads the envelopes at the end of the block the onset
 * fired in. That is wrong, and not by a little. A hit starts at an arbitrary offset
 * inside that block, so the read catches an arbitrary fraction of the attack —
 * sometimes 4 frames of it, sometimes 120. Measured across every sub-block phase
 * (`scripts/measure-attack-features.mjs`), the factory kick's band vector swings over a
 * 0.43-wide range at delay 0 while the gap between the kick and clap rows is 0.17: the
 * phase noise is larger than the thing being measured, so stage 1 cannot be right more
 * than by luck, whatever the centroids say. One block later the same kick's spread
 * collapses to 0.095 and the classes separate cleanly. A second block of delay tightens
 * it slightly further and is not worth another 2.7 ms.
 *
 * The cost is that a stage-1 fire is one block late — 2.7 ms at 48 kHz — instead of
 * same-block. Stage 2 is 8 ms, so fast mode still saves most of what it ever saved, and
 * it now saves it on a decision that is actually correct.
 *
 * Must be at least 1. Zero is the bug described above, not a low-latency option, and
 * FACTORY_ATTACK is measured at whatever this is set to — change one and re-measure the
 * other with `scripts/measure-attack-features.mjs`.
 */
export const STAGE1_DELAY_BLOCKS = 1;

/**
 * Factory centroids for the stage-1 decision: low, mid, high one block after the onset.
 *
 * A separate table from the stage-2 one, because the same hit does not look the same
 * 3 ms in as it does 8 ms in — and conflating the two is the mistake the first version
 * of this file made. Every drum's attack is broadband, so this early *everything except
 * a hat* is mid-dominated. Comparing attack-time bands against window-time centroids
 * classified kicks and snares as claps with high confidence, which is the worst failure
 * available here: wrong, early, and committed.
 *
 * Measured by `scripts/measure-attack-features.mjs` at `STAGE1_DELAY_BLOCKS`, from one
 * prototype pad per class — the pad that class fires, per `DEFAULT_CLASS_PADS` — rather
 * than the mean over every pad of that kind. Averaging is what the stage-2 table does
 * and it is wrong here: the kit's kick pads are a mid-dominated thump and a nearly pure
 * sine sub, and their mean describes neither, leaving a plain kick closer to the clap
 * row than to its own. A prototype cannot have that failure mode.
 *
 * The classes sit closer together here than at stage 2 — the nearest pair, kick and
 * clap, are 0.17 apart — which is why `margin` exists rather than a bare nearest-class
 * answer. Measured against these rows, all four of the kit's own prototypes clear the
 * default margin comfortably (distance ratios 0.00-0.39 against a 0.62 threshold) and
 * so fire at stage 1, while sounds that are not one of the four classes at all — the
 * kit's rim and tom — never clear it and always fall through to stage 2. That is the
 * behaviour to want from a margin. A mouth is a harder case than a synthesised one-shot
 * and will defer more often, which is the system working, not failing.
 */
export const FACTORY_ATTACK = [
  [0.127, 0.865, 0.008], // kick  — mid-dominated with a low shelf, no high at all
  [0.394, 0.448, 0.158], // snare — body in the low band, noise up top
  [0.0, 0.062, 0.938], // hat   — unmistakable from the first block
  [0.001, 0.884, 0.116], // clap  — almost pure mid
];

/**
 * Per-axis weights in the distance. The three band energies are worth more than the
 * zero-crossing rate because ZCR saturates: snare, hat and clap all sit at or near the
 * top of its range, so on that axis they are indistinguishable and only the bands can
 * separate them. Weighting the bands up is what keeps snare-versus-clap working.
 */
const AXIS_WEIGHT = [1.4, 1.4, 1.4, 1.0];

/** Parameter names for the wire. APPEND ONLY — the index is what the command ring stores. */
export const VOICE_KEY = [
  "enabled",
  "sensitivity",
  "floorDb",
  "minGapMs",
  "featureMs",
  "mode",
  "margin",
  "velMin",
  "velDb",
  "monitor",
];

export const VOICE_DEFAULTS = {
  /** Master switch. Off means the detector is not even run. */
  enabled: false,
  /** Onset threshold, passed straight through to the detector. */
  sensitivity: 2.1,
  /** Noise gate in dBFS. Below this nothing is a hit — the first defence against a room. */
  floorDb: -42,
  /** Refractory period in ms. 45 caps the detector at ~22 hits/sec. */
  minGapMs: 45,
  /**
   * Feature window in ms, and therefore exactly how late a stage-2 decision is.
   * 8 ms live rather than the detector's 22 ms default: 22 ms is a better measurement
   * and an audibly late drum. 8 ms is the shortest window that still separates the
   * classes reliably in testing.
   */
  featureMs: 8,
  mode: VOICE_MODE.FAST,
  /**
   * How clearly stage 1 must win to commit early: nearest distance must be below
   * `margin` x the runner-up's. At 0.62 the four factory sounds all commit early and
   * sounds that are none of the four classes (rim, tom) defer to stage 2 — see
   * FACTORY_ATTACK. Lower it to make fast mode more cautious without leaving fast mode.
   */
  margin: 0.62,
  /** Velocity floor: the quietest a detected hit can fire. Never 0 — a hit that fires silent reads as a miss. */
  velMin: 0.32,
  /** dB above the gate that maps to full velocity. 26 is roughly a mouth's usable dynamic range. */
  velDb: 26,
  /** Fire pads while calibrating. Off by default: monitoring through speakers feeds the mic. */
  monitor: false,
};

/**
 * Captured calibration hits held for the UI to drain:
 * `[class, f0..f3, attackLow, attackMid, attackHigh, strength]`.
 *
 * Both vectors, because there are two centroid tables and one calibration pass has to
 * train both of them. Capturing only the stage-2 features would leave a calibrated
 * performer with factory stage-1 centroids, i.e. their kick recognised correctly 8 ms
 * late and guessed at early — which reads as "calibration made it worse".
 */
const CAP_SLOTS = 64;
export const CAP_STRIDE = FEATURE_COUNT + 5;
export const CAP_ATTACK_OFFSET = FEATURE_COUNT + 1;

/** Hits awaiting their stage-2 features. Matches the detector's commit ring exactly. */
const PEND_SLOTS = 16;

/** Most hits one block can fire. The detector caps at 8 per block, so this cannot overflow. */
const FIRE_MAX = 8;

/** Meter values written by readMeters. Append only. */
export const VOICE_METER_STRIDE = 12;

/**
 * Squared weighted distance from a feature vector to one row of a centroid table.
 * `axes` lets the stage-1 call compare on the three band axes only; `centroids` is
 * which table — the attack one at stage 1, the feature one at stage 2.
 */
function distanceTo(features, fOff, centroids, cls, axes) {
  let d = 0;
  const base = cls * FEATURE_COUNT;
  for (let i = 0; i < axes; i++) {
    const diff = features[fOff + i] - centroids[base + i];
    d += diff * diff * AXIS_WEIGHT[i];
  }
  return d;
}

/**
 * Smart Voice.
 *
 *     const sv = new SmartVoice(sampleRate);
 *     sv.process(monoBlock, frames);      // mic in, pre-effects, pre-mute
 *     for (let i = 0; i < sv.fireCount; i++) rack.trigger(sv.firePad[i], sv.fireVel[i]);
 *
 * The caller does the triggering rather than this owning a rack reference, so the same
 * object serves the engine, a test harness, and (later) a MIDI-out path without any of
 * them needing to know about the others.
 */
export class SmartVoice {
  constructor(sampleRate) {
    this.sr = sampleRate || 48000;

    this.enabled = VOICE_DEFAULTS.enabled;
    this.mode = VOICE_DEFAULTS.mode;
    this.margin = VOICE_DEFAULTS.margin;
    this.velMin = VOICE_DEFAULTS.velMin;
    this.velDb = VOICE_DEFAULTS.velDb;
    this.monitor = VOICE_DEFAULTS.monitor;
    this.floorDb = VOICE_DEFAULTS.floorDb;

    this.det = new OnsetDetector(this.sr, {
      sensitivity: VOICE_DEFAULTS.sensitivity,
      floorDb: VOICE_DEFAULTS.floorDb,
      minGapMs: VOICE_DEFAULTS.minGapMs,
      featureMs: VOICE_DEFAULTS.featureMs,
      lowCrossHz: ONSET_DEFAULTS.lowCrossHz,
      highCrossHz: ONSET_DEFAULTS.highCrossHz,
    });

    // Both tables live flat so a single wire command can set one number of one class.
    // `attack` keeps the same 4-wide stride as `centroids` with an unused zcr slot, so
    // one distance function serves both and stage 1 is a plain `axes = 3` call.
    this.centroids = new Float32Array(CLASS_COUNT * FEATURE_COUNT);
    this.attack = new Float32Array(CLASS_COUNT * FEATURE_COUNT);
    this.resetCentroids();

    // Which pad each class fires; -1 mutes that class without losing its centroid,
    // which is what you want for a performer who does not do claps.
    this.classPad = new Int32Array(CLASS_COUNT);
    for (let c = 0; c < CLASS_COUNT; c++) this.classPad[c] = DEFAULT_CLASS_PADS[c];

    // Hits decided this block, drained by the caller.
    this.fireCount = 0;
    this.firePad = new Int32Array(FIRE_MAX);
    this.fireVel = new Float32Array(FIRE_MAX);
    this.fireClass = new Int32Array(FIRE_MAX);
    this.fireStage = new Int32Array(FIRE_MAX);
    this.fireConf = new Float32Array(FIRE_MAX);

    // Hits waiting for stage 2, indexed by onset number modulo PEND_SLOTS. Indexing by
    // number rather than queueing means a dropped entry cannot desynchronise the rest
    // from the detector's commit ring: validity is checked, not assumed.
    this.pendId = new Int32Array(PEND_SLOTS);
    this.pendClass = new Int32Array(PEND_SLOTS);
    this.pendVel = new Float32Array(PEND_SLOTS);
    this.pendStrength = new Float32Array(PEND_SLOTS);
    this.pendFired = new Int32Array(PEND_SLOTS);
    // `pendWait` counts down the blocks left before this hit's band envelopes get
    // read, and `pendRead` records that they have been. A hit therefore exists in two
    // states: detected but not yet measured, then classified and waiting for stage 2.
    // A countdown rather than a target block index on purpose — there is no counter to
    // overflow and nothing to rebase when the detector is reset mid-performance.
    this.pendWait = new Int32Array(PEND_SLOTS);
    this.pendRead = new Int32Array(PEND_SLOTS);
    // The attack bands travel with the pending hit so a capture written at stage 2 can
    // carry both vectors of the same hit. Recomputing them then is not an option — by
    // then the envelopes have moved on.
    this.pendBand = new Float32Array(PEND_SLOTS * 3);
    for (let i = 0; i < PEND_SLOTS; i++) this.pendId[i] = -1;

    this.onsetCount = 0;
    this.drained = 0;

    // Calibration capture ring. Written on stage 2 (finished features only — a
    // half-measured hit would poison the centroid it trains).
    this.captureClass = -1;
    this.captureCount = 0;
    this.captures = new Float32Array(CAP_SLOTS * CAP_STRIDE);

    // Scratch, allocated once: the stage-1 band vector and the stage-2 feature read.
    this.bandScratch = new Float32Array(FEATURE_COUNT);
    this.featScratch = new Float32Array(FEATURE_COUNT);

    // Live readouts for the UI.
    this.hitCount = 0;
    this.lastClass = -1;
    this.lastConf = 0;
    this.lastVel = 0;
    this.lastStage = 0;
    this.lastStrength = 0;
    this.corrections = 0;
    this.level = 0;
    /** Attack bands of the most recent onset, for the panel's live display. */
    this.lastBand = new Float32Array(3);

    // Declared here rather than sprung into existence inside classify(): a property
    // added on first call changes the object's shape mid-stream, which is exactly the
    // sort of thing that deoptimises an audio-thread hot path.
    this.scratchRatio = 1;
    this.scratchConf = 0;
  }

  // ---------------------------------------------------------------- control

  setParam(key, value) {
    if (!Number.isFinite(value)) return;
    if (key === "enabled") {
      const on = value >= 0.5;
      // Entering from idle with a poisoned envelope state would either miss the first
      // hit or invent one, so the detector starts clean every time it is switched on.
      if (on && !this.enabled) this.resetDetector();
      this.enabled = on;
    } else if (key === "mode") this.mode = value >= 0.5 ? VOICE_MODE.ACCURATE : VOICE_MODE.FAST;
    else if (key === "margin") this.margin = Math.max(0.05, Math.min(0.99, value));
    else if (key === "velMin") this.velMin = Math.max(0, Math.min(0.95, value));
    else if (key === "velDb") this.velDb = Math.max(3, Math.min(60, value));
    else if (key === "monitor") this.monitor = value >= 0.5;
    else if (key === "floorDb") {
      this.floorDb = Math.max(-90, Math.min(-6, value));
      this.det.setParam("floorDb", value);
    } else if (
      key === "sensitivity" ||
      key === "minGapMs" ||
      key === "featureMs" ||
      key === "lowCrossHz" ||
      key === "highCrossHz"
    ) {
      this.det.setParam(key, value);
    }
  }

  /** One number of one class. Called per feature so the wire stays a flat numeric ring. */
  setCentroid(cls, feature, value) {
    const c = cls | 0;
    const f = feature | 0;
    if (c < 0 || c >= CLASS_COUNT || f < 0 || f >= FEATURE_COUNT) return;
    if (!Number.isFinite(value)) return;
    this.centroids[c * FEATURE_COUNT + f] = value;
  }

  /** Same, for the stage-1 table. Only the three band axes exist there. */
  setAttackCentroid(cls, band, value) {
    const c = cls | 0;
    const b = band | 0;
    if (c < 0 || c >= CLASS_COUNT || b < 0 || b > 2) return;
    if (!Number.isFinite(value)) return;
    this.attack[c * FEATURE_COUNT + b] = value;
  }

  setClassPad(cls, pad) {
    const c = cls | 0;
    if (c < 0 || c >= CLASS_COUNT) return;
    this.classPad[c] = pad < 0 ? -1 : pad | 0;
  }

  /** Both tables back to the factory profile — they are one profile, not two. */
  resetCentroids() {
    for (let c = 0; c < CLASS_COUNT; c++) {
      for (let f = 0; f < FEATURE_COUNT; f++) {
        this.centroids[c * FEATURE_COUNT + f] = FACTORY_CENTROIDS[c][f];
        this.attack[c * FEATURE_COUNT + f] = f < 3 ? FACTORY_ATTACK[c][f] : 0;
      }
    }
  }

  /**
   * Start capturing hits as examples of `cls`, or -1 to stop. Capture is supervised —
   * the class comes from the UI prompt ("give me eight kicks"), not from the
   * classifier, which is the entire point: it is being taught, not tested.
   */
  setCapture(cls) {
    const c = cls | 0;
    this.captureClass = c >= 0 && c < CLASS_COUNT ? c : -1;
  }

  clearCaptures() {
    this.captureCount = 0;
  }

  /**
   * Copies capture number `n` into `out` as
   * `[class, f0..f3, attackLow, attackMid, attackHigh, strength]` — CAP_STRIDE values.
   * Returns false once it has been overwritten or has not happened yet.
   */
  readCapture(n, out) {
    if (n < 0 || n >= this.captureCount || n < this.captureCount - CAP_SLOTS) return false;
    const base = (n % CAP_SLOTS) * CAP_STRIDE;
    for (let i = 0; i < CAP_STRIDE; i++) out[i] = this.captures[base + i];
    return true;
  }

  resetDetector() {
    this.det.reset();
    this.fireCount = 0;
    this.onsetCount = 0;
    this.drained = 0;
    for (let i = 0; i < PEND_SLOTS; i++) {
      this.pendId[i] = -1;
      this.pendRead[i] = 0;
    }
    this.level = 0;
  }

  reset() {
    this.resetDetector();
    this.captureClass = -1;
    this.captureCount = 0;
    this.hitCount = 0;
    this.lastClass = -1;
    this.lastConf = 0;
    this.lastVel = 0;
    this.lastStage = 0;
    this.lastStrength = 0;
    this.corrections = 0;
    this.lastBand[0] = 0;
    this.lastBand[1] = 0;
    this.lastBand[2] = 0;
  }

  // ---------------------------------------------------------------- classify

  /**
   * Nearest centroid in `table` over the first `axes` features of `features` at `fOff`.
   * The class is returned; `this.scratchConf` and `this.scratchRatio` carry the
   * confidence and the raw distance ratio, which avoids allocating a result object per
   * hit on the audio thread.
   */
  classify(features, fOff, axes, table) {
    let best = -1;
    let bestD = Infinity;
    let secondD = Infinity;
    for (let c = 0; c < CLASS_COUNT; c++) {
      const d = distanceTo(features, fOff, table, c, axes);
      if (d < bestD) {
        secondD = bestD;
        bestD = d;
        best = c;
      } else if (d < secondD) secondD = d;
    }
    // Confidence is the relative margin over the runner-up, not the absolute distance:
    // "closer to a kick than to anything else, by a lot" is the useful statement, and
    // it is the same number the stage-1 commit test needs.
    const ratio = secondD > 1e-12 ? Math.sqrt(bestD / secondD) : 1;
    this.scratchRatio = ratio;
    this.scratchConf = Math.max(0, Math.min(1, 1 - ratio));
    return best;
  }

  /** Velocity from loudness, mapped from the gate upward. See VOICE_DEFAULTS. */
  velocityFrom(db) {
    const t = (db - this.floorDb) / this.velDb;
    const c = t < 0 ? 0 : t > 1 ? 1 : t;
    return this.velMin + (1 - this.velMin) * c;
  }

  // ---------------------------------------------------------------- audio

  /**
   * Measure one pending hit's band envelopes and take the stage-1 decision on them.
   *
   * Called a block after the onset (see STAGE1_DELAY_BLOCKS), so what it reads is the
   * detector's three fast envelopes as they stand at the end of *that* block. With a
   * 45 ms refractory period two onsets never share a block, so a single read per block
   * cannot mix two hits together.
   *
   * `allowEarly` is 0 when this runs late, from the stage-2 drain: the bands still get
   * measured and stored for calibration, but firing on them would be a duplicate of the
   * stage-2 fire happening in the same block.
   */
  #stage1(slot, allowEarly) {
    const det = this.det;
    const eLo = det.fastLow.env;
    const eMid = det.fastMid.env;
    const eHi = det.fastHigh.env;
    const total = eLo * eLo + eMid * eMid + eHi * eHi;
    const band = this.bandScratch;
    if (total > 1e-12) {
      band[0] = (eLo * eLo) / total;
      band[1] = (eMid * eMid) / total;
      band[2] = (eHi * eHi) / total;
    } else {
      band[0] = 0;
      band[1] = 0;
      band[2] = 0;
    }
    band[3] = 0;
    this.lastBand[0] = band[0];
    this.lastBand[1] = band[1];
    this.lastBand[2] = band[2];
    this.pendBand[slot * 3] = band[0];
    this.pendBand[slot * 3 + 1] = band[1];
    this.pendBand[slot * 3 + 2] = band[2];

    // Loudness is read at the same point as the timbre, which is also the better place
    // for it: a block after the onset the level envelope is at or near the hit's peak,
    // where in the onset block itself it is still climbing through it.
    const db = 20 * Math.log10(Math.max(1e-9, det.level.env));
    const vel = this.velocityFrom(db);
    // Against the attack table, not the feature table: see FACTORY_ATTACK.
    const cls1 = this.classify(band, 0, 3, this.attack);
    const conf1 = this.scratchConf;

    this.pendClass[slot] = cls1;
    this.pendVel[slot] = vel;
    this.pendRead[slot] = 1;

    const capturing = this.captureClass >= 0;
    const allowFire = !capturing || this.monitor;
    if (allowEarly && allowFire && this.mode === VOICE_MODE.FAST && this.scratchRatio < this.margin) {
      this.#emit(cls1, vel, 1, conf1, this.pendStrength[slot]);
      this.pendFired[slot] = 1;
    }
  }

  /**
   * One mono block of mic signal. Returns how many pad hits were decided, which are in
   * `firePad`/`fireVel`/`fireClass` for the caller to fire.
   *
   * `block` is only read. Feed it the mic *before* the effect chain, *before* the mute,
   * and without the drum bus summed in — a detector that can hear the kit it is firing
   * will retrigger itself into a runaway roll.
   */
  process(block, frames) {
    this.fireCount = 0;
    if (!this.enabled) return 0;

    const det = this.det;
    const found = det.process(block, frames);
    this.level = det.level.env;

    // ---- stage 1: the band-envelope decision, STAGE1_DELAY_BLOCKS after the onset ----
    // Every hit still waiting ticks down a block, and whichever reaches zero is read
    // now — before this block's own onsets are registered below, so a hit registered
    // this block waits its full delay rather than being read the moment it arrives.
    // The scan is 16 slots of two integer reads; the refractory period means at most
    // one is ever outstanding, but scanning does not have to assume that to be cheap.
    for (let s = 0; s < PEND_SLOTS; s++) {
      if (this.pendId[s] < 0 || this.pendRead[s]) continue;
      this.pendWait[s]--;
      if (this.pendWait[s] <= 0) this.#stage1(s, 1);
    }

    for (let h = 0; h < found; h++) {
      const id = this.onsetCount++;
      const slot = id % PEND_SLOTS;
      this.pendId[slot] = id;
      this.pendStrength[slot] = det.strengths[h];
      this.pendWait[slot] = STAGE1_DELAY_BLOCKS;
      this.pendRead[slot] = 0;
      this.pendFired[slot] = 0;
      this.pendClass[slot] = -1;
      this.pendVel[slot] = 0;
    }

    // ---- stage 2: the four-feature decision, featureMs after the onset ----
    // The Nth commit belongs to the Nth onset (onset.js keeps that one-for-one), so the
    // pending entry is looked up by number and validated rather than popped off a queue.
    if (this.drained < det.commitCount - PEND_SLOTS) {
      // Fell behind far enough that the ring wrapped. Only possible if the caller
      // stopped draining; skip to what is still readable rather than reading garbage.
      this.drained = det.commitCount - PEND_SLOTS;
    }
    const feat = this.featScratch;
    while (this.drained < det.commitCount) {
      if (!det.readCommitted(this.drained, feat)) break;
      const id = this.drained;
      this.drained++;
      const slot = id % PEND_SLOTS;
      if (this.pendId[slot] !== id) continue; // its stage 1 was lost; nothing to finish
      // `featureMs` can be set short enough that the features arrive before the
      // stage-1 read was due. Measure the bands now rather than dropping the hit: they
      // are late and the early-fire window is gone, but calibration still needs them.
      if (!this.pendRead[slot]) this.#stage1(slot, 0);

      const cls2 = this.classify(feat, 0, FEATURE_COUNT, this.centroids);
      const conf2 = this.scratchConf;
      const capturing = this.captureClass >= 0;

      if (capturing) {
        const base = (this.captureCount % CAP_SLOTS) * CAP_STRIDE;
        this.captures[base] = this.captureClass;
        for (let i = 0; i < FEATURE_COUNT; i++) this.captures[base + 1 + i] = feat[i];
        for (let i = 0; i < 3; i++) {
          this.captures[base + CAP_ATTACK_OFFSET + i] = this.pendBand[slot * 3 + i];
        }
        this.captures[base + CAP_STRIDE - 1] = this.pendStrength[slot];
        this.captureCount++;
        // Readouts still move while calibrating so the panel can show what it heard,
        // but the class shown is what the classifier *would* have said, which is the
        // interesting number mid-calibration.
        this.lastClass = cls2;
        this.lastConf = conf2;
        this.lastStage = 2;
        this.lastStrength = this.pendStrength[slot];
      }

      if (this.pendFired[slot]) {
        // Committed early. A late correction would be a flam, so the disagreement is
        // counted instead — that count is the user's evidence for switching to ACCURATE.
        if (cls2 !== this.pendClass[slot]) this.corrections++;
      } else if (!capturing || this.monitor) {
        this.#emit(cls2, this.pendVel[slot], 2, conf2, this.pendStrength[slot]);
      }
      this.pendId[slot] = -1;
    }

    return this.fireCount;
  }

  /** Queue one decided hit for the caller. Silently drops a class with no pad assigned. */
  #emit(cls, vel, stage, conf, strength) {
    const pad = this.classPad[cls];
    this.hitCount++;
    this.lastClass = cls;
    this.lastConf = conf;
    this.lastVel = vel;
    this.lastStage = stage;
    this.lastStrength = strength;
    if (pad < 0 || this.fireCount >= FIRE_MAX) return;
    const n = this.fireCount++;
    this.firePad[n] = pad;
    this.fireVel[n] = vel;
    this.fireClass[n] = cls;
    this.fireStage[n] = stage;
    this.fireConf[n] = conf;
  }

  // ---------------------------------------------------------------- meters

  /** Writes VOICE_METER_STRIDE values at `offset`. Returns how many. */
  readMeters(out, offset) {
    out[offset] = this.enabled ? 1 : 0;
    out[offset + 1] = this.hitCount;
    out[offset + 2] = this.lastClass;
    out[offset + 3] = this.lastConf;
    out[offset + 4] = this.lastVel;
    out[offset + 5] = this.lastStage;
    out[offset + 6] = this.level;
    out[offset + 7] = this.lastStrength;
    out[offset + 8] = this.captureClass;
    out[offset + 9] = this.captureCount;
    out[offset + 10] = this.corrections;
    out[offset + 11] = this.onsetCount;
    return VOICE_METER_STRIDE;
  }
}
