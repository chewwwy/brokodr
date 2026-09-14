/**
 * Bro.Kodr — Smart Voice calibration: captures in, centroid tables out.
 *
 * This is the whole of "calibration" as a computation. `calibrate.tsx` collects hits by
 * arming the detector's capture for one class at a time; the worklet stores each onset's
 * two feature vectors; this turns a pile of those rows into the two centroid tables the
 * classifier compares against.
 *
 * It lives on the UI side, not in the DSP, because it runs once at the end of a 30-second
 * calibration pass and touches every captured row — exactly the kind of work that has no
 * business on an audio thread. The DSP only ever *receives* a finished table.
 *
 * ## Why a trimmed mean rather than a mean
 * A calibration pass is eight hits made by a human into a microphone. One of them is
 * usually not the sound they meant: a breath caught on the way in, a hit that clipped, a
 * chair creak the gate let through. A plain mean lets that single row drag the class
 * centroid a long way, and the failure is invisible — the user sees "calibrated" and a
 * classifier that got worse. So a row that sits far outside its own class's spread is
 * dropped and the mean recomputed without it, and the caller is told how many were
 * dropped so the panel can say "used 7 of 8" instead of quietly discarding a third of
 * someone's take.
 *
 * ## Why classes can stay factory
 * Training is per class. Give it kicks and snares only and it returns tables where the
 * hat and clap rows are marked untrained, which the client then does not push — leaving
 * those two on `beat-classify.js`'s measured factory rows. Half a calibration is better
 * than a whole one on classes that were never recorded, and much better than zeros.
 */

import { VOICE_ATTACK_COUNT, VOICE_CLASS_COUNT, VOICE_FEATURE_COUNT, type VoiceCapture } from "./backend";
import { defaultVoiceProfile, type VoiceProfile } from "./kit";

/** Fewest usable hits a class needs before its row is trained rather than left factory. */
export const VOICE_MIN_HITS = 3;

/**
 * Below this many hits, outlier rejection is off: with four rows there is not enough
 * spread to tell an outlier from the class, and dropping one is as likely to be wrong as
 * right.
 */
const TRIM_MIN_ROWS = 5;

/** A row is dropped when its distance to the class mean exceeds this multiple of the mean distance. */
const TRIM_FACTOR = 2;

export interface VoiceClassTraining {
  cls: number;
  /** Rows that reached the mean. */
  used: number;
  /** Rows dropped as outliers. */
  rejected: number;
  /** Rows thrown out before that for being non-finite or out of range. */
  invalid: number;
  /** False when `used` fell short of VOICE_MIN_HITS — the class stays factory. */
  trained: boolean;
  /** Mean distance of the used rows to their centroid. Spread, i.e. how consistent the performer was. */
  spread: number;
}

export interface VoiceTrainResult {
  /** `base` with the trained rows replaced. Untrained rows and every param are untouched. */
  profile: VoiceProfile;
  /** Per-class outcome, in class order, for the panel's readout. */
  classes: VoiceClassTraining[];
}

function finiteRow(r: VoiceCapture): boolean {
  if (!Number.isFinite(r.strength)) return false;
  if (r.features.length < VOICE_FEATURE_COUNT || r.attack.length < VOICE_ATTACK_COUNT) return false;
  for (let i = 0; i < VOICE_FEATURE_COUNT; i++) if (!Number.isFinite(r.features[i])) return false;
  for (let i = 0; i < VOICE_ATTACK_COUNT; i++) if (!Number.isFinite(r.attack[i])) return false;
  return true;
}

/** Squared distance across both vectors at once — a row is an outlier if either half is. */
function rowDistance(r: VoiceCapture, feat: Float64Array, atk: Float64Array): number {
  let d = 0;
  for (let i = 0; i < VOICE_FEATURE_COUNT; i++) {
    const diff = (r.features[i] as number) - (feat[i] as number);
    d += diff * diff;
  }
  for (let i = 0; i < VOICE_ATTACK_COUNT; i++) {
    const diff = (r.attack[i] as number) - (atk[i] as number);
    d += diff * diff;
  }
  return d;
}

function meanInto(rows: VoiceCapture[], feat: Float64Array, atk: Float64Array): void {
  feat.fill(0);
  atk.fill(0);
  if (rows.length === 0) return;
  for (const r of rows) {
    for (let i = 0; i < VOICE_FEATURE_COUNT; i++) feat[i] += r.features[i] as number;
    for (let i = 0; i < VOICE_ATTACK_COUNT; i++) atk[i] += r.attack[i] as number;
  }
  for (let i = 0; i < VOICE_FEATURE_COUNT; i++) feat[i] /= rows.length;
  for (let i = 0; i < VOICE_ATTACK_COUNT; i++) atk[i] /= rows.length;
}

/**
 * Trains both centroid tables from captured hits.
 *
 * `base` supplies the params, the pad routing, and any rows this pass does not retrain —
 * so calibrating one class twice, or one class at a time across several passes, keeps
 * everything else exactly as it was.
 */
export function trainVoiceProfile(
  base: VoiceProfile | null,
  rows: VoiceCapture[],
  minHits = VOICE_MIN_HITS,
): VoiceTrainResult {
  const src = base ?? defaultVoiceProfile();
  const profile: VoiceProfile = {
    params: { ...src.params },
    classPads: [...src.classPads],
    centroids: [...src.centroids],
    attack: [...src.attack],
    trained: [...src.trained],
  };
  const classes: VoiceClassTraining[] = [];

  const feat = new Float64Array(VOICE_FEATURE_COUNT);
  const atk = new Float64Array(VOICE_ATTACK_COUNT);

  for (let c = 0; c < VOICE_CLASS_COUNT; c++) {
    const all = rows.filter((r) => (r.cls | 0) === c);
    const valid = all.filter(finiteRow);
    const invalid = all.length - valid.length;

    let kept = valid;
    let rejected = 0;
    if (valid.length >= TRIM_MIN_ROWS) {
      meanInto(valid, feat, atk);
      let sum = 0;
      for (const r of valid) sum += Math.sqrt(rowDistance(r, feat, atk));
      const limit = (sum / valid.length) * TRIM_FACTOR;
      // A limit of zero means every row is identical, so nothing can exceed it — the
      // comparison is deliberately strict rather than >=, or a perfectly consistent
      // performer would have their whole take rejected.
      const trimmed = valid.filter((r) => Math.sqrt(rowDistance(r, feat, atk)) <= limit || limit === 0);
      // Never trim below the minimum: if rejection would leave too few rows, keep them
      // all and let `spread` tell the panel the take was messy.
      if (trimmed.length >= minHits) {
        rejected = valid.length - trimmed.length;
        kept = trimmed;
      }
    }

    let spread = 0;
    const trained = kept.length >= minHits;
    if (trained) {
      meanInto(kept, feat, atk);
      for (let f = 0; f < VOICE_FEATURE_COUNT; f++) profile.centroids[c * VOICE_FEATURE_COUNT + f] = feat[f] as number;
      for (let b = 0; b < VOICE_ATTACK_COUNT; b++) profile.attack[c * VOICE_ATTACK_COUNT + b] = atk[b] as number;
      profile.trained[c] = kept.length;
      let sum = 0;
      for (const r of kept) sum += Math.sqrt(rowDistance(r, feat, atk));
      spread = sum / kept.length;
    }

    classes.push({ cls: c, used: kept.length, rejected, invalid, trained, spread });
  }

  return { profile, classes };
}

/**
 * Clears the calibration for one class (or every class, with -1), putting those rows back
 * to factory. Params and pad routing survive: forgetting a bad kick take should not also
 * forget that the user turned the gate up.
 */
export function untrainVoiceProfile(base: VoiceProfile, cls: number): VoiceProfile {
  const profile: VoiceProfile = {
    params: { ...base.params },
    classPads: [...base.classPads],
    centroids: [...base.centroids],
    attack: [...base.attack],
    trained: [...base.trained],
  };
  for (let c = 0; c < VOICE_CLASS_COUNT; c++) {
    if (cls >= 0 && c !== cls) continue;
    profile.trained[c] = 0;
    for (let f = 0; f < VOICE_FEATURE_COUNT; f++) profile.centroids[c * VOICE_FEATURE_COUNT + f] = 0;
    for (let b = 0; b < VOICE_ATTACK_COUNT; b++) profile.attack[c * VOICE_ATTACK_COUNT + b] = 0;
  }
  return profile;
}
