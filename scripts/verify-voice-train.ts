/**
 * Verification for Smart Voice CALIBRATION MATH and the kit document it is stored in.
 * Run with `bun scripts/verify-voice-train.ts`.
 *
 * scripts/verify-beat-classify.mjs proves the classifier and scripts/verify-engine-voice.mjs
 * the wiring; this covers the third piece, which is the one a user can lose work in: the
 * trimmed mean that turns captured hits into centroid tables, and the serialisation that
 * has to bring a calibration back intact after a reload — or fail softly rather than
 * silently wrecking a profile someone spent thirty seconds of beatboxing on.
 */
import {
  VOICE_ATTACK_COUNT,
  VOICE_CLASS_COUNT,
  VOICE_DEFAULT_CLASS_PADS,
  VOICE_DEFAULTS,
  VOICE_FEATURE_COUNT,
  VOICE_KEY,
  type VoiceCapture,
} from "../packages/web/src/web/audio/backend";
import {
  defaultVoiceProfile,
  emptyKit,
  exportKit,
  importKit,
  importVoiceProfile,
  type VoiceProfile,
} from "../packages/web/src/web/audio/kit";
import { trainVoiceProfile, untrainVoiceProfile, VOICE_MIN_HITS } from "../packages/web/src/web/audio/voice-train";

let failures = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail = "") {
  checks++;
  if (!cond) {
    failures++;
    console.log(`FAIL  ${name} ${detail}`);
  } else console.log(`ok    ${name} ${detail}`);
}
function close(a: number, b: number, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}

/** One capture row, with every value derived from a seed so a take is reproducible. */
function row(cls: number, base: number, jitter = 0): VoiceCapture {
  const features: number[] = [];
  for (let i = 0; i < VOICE_FEATURE_COUNT; i++) features.push(base + i * 0.05 + jitter);
  const attack: number[] = [];
  for (let i = 0; i < VOICE_ATTACK_COUNT; i++) attack.push(base * 0.5 + i * 0.03 + jitter);
  return { cls, features, attack, strength: 0.4 + base };
}

/** A clean take: `n` rows of one class, jittered symmetrically about `base`. */
function take(cls: number, n: number, base: number, spread = 0.01): VoiceCapture[] {
  const rows: VoiceCapture[] = [];
  for (let i = 0; i < n; i++) rows.push(row(cls, base, (i - (n - 1) / 2) * spread));
  return rows;
}

// ---------------------------------------------------------------------------
console.log("== 1. an uncalibrated profile is factory, not zeros-in-disguise ==");
{
  const v = defaultVoiceProfile();
  ok("default: every param present", VOICE_KEY.every((k) => Number.isFinite(v.params[k])));
  ok(
    "default: params match the engine's own defaults",
    VOICE_KEY.every((k) => close(v.params[k] as number, VOICE_DEFAULTS[k])),
  );
  ok("default: enabled is off", v.params.enabled === 0);
  ok(
    "default: class pads are the factory map",
    v.classPads.length === VOICE_CLASS_COUNT && v.classPads.every((p, c) => p === VOICE_DEFAULT_CLASS_PADS[c]),
    v.classPads.join(","),
  );
  ok("default: no class claims to be trained", v.trained.every((t) => t === 0));
  ok(
    "default: tables sized for the wire",
    v.centroids.length === VOICE_CLASS_COUNT * VOICE_FEATURE_COUNT &&
      v.attack.length === VOICE_CLASS_COUNT * VOICE_ATTACK_COUNT,
  );
  // The factory numbers live in beat-classify.js and nowhere else. A zero row that is
  // marked untrained is never pushed, so it cannot be mistaken for a calibration.
  ok("default: untrained rows are zero, not copied factory values", v.centroids.every((n) => n === 0));
}

// ---------------------------------------------------------------------------
console.log("== 2. a clean take trains the class it was captured for ==");
{
  const rows = take(0, 8, 0.3);
  const { profile, classes } = trainVoiceProfile(null, rows);
  ok("train: the captured class is trained", classes[0].trained === true);
  ok("train: it used the whole clean take", classes[0].used === 8 && classes[0].rejected === 0, `used=${classes[0].used}`);
  ok("train: nothing was invalid", classes[0].invalid === 0);
  ok("train: hit count recorded on the profile", profile.trained[0] === 8);
  ok("train: the other three classes stay factory", classes.slice(1).every((c) => !c.trained));
  ok("train: their rows are untouched", profile.trained.slice(1).every((t) => t === 0));

  // A symmetric jitter means the mean is the centre row, exactly.
  const centre = row(0, 0.3);
  let centred = true;
  for (let f = 0; f < VOICE_FEATURE_COUNT; f++) {
    if (!close(profile.centroids[f], centre.features[f], 1e-12)) centred = false;
  }
  for (let b = 0; b < VOICE_ATTACK_COUNT; b++) {
    if (!close(profile.attack[b], centre.attack[b], 1e-12)) centred = false;
  }
  ok("train: the centroid is the mean of the take", centred);
  // Every element of a row carries the same jitter, so a row's distance to the mean is
  // |jitter| * sqrt(VOICE_FEATURE_COUNT + VOICE_ATTACK_COUNT) — for this take, a mean
  // |jitter| of 0.02 over sqrt(7), i.e. ~0.053. What matters is that it is two orders of
  // magnitude below the messy take below, not its exact value.
  ok("train: spread reported and small for a tight take", classes[0].spread > 0 && classes[0].spread < 0.1, `${classes[0].spread.toFixed(5)}`);
  ok("train: every trained number finite", profile.centroids.every(Number.isFinite) && profile.attack.every(Number.isFinite));
}

// ---------------------------------------------------------------------------
console.log("== 3. one bad hit in a take does not drag the centroid ==");
{
  const clean = take(1, 7, 0.4, 0.005);
  const withOutlier = [...clean, row(1, 9.0)]; // a clipped hit, nothing like the rest
  const good = trainVoiceProfile(null, clean);
  const messy = trainVoiceProfile(null, withOutlier);
  ok("trim: the outlier was dropped", messy.classes[1].rejected === 1, `rejected=${messy.classes[1].rejected}`);
  ok("trim: the rest were used", messy.classes[1].used === 7, `used=${messy.classes[1].used}`);
  let same = true;
  for (let f = 0; f < VOICE_FEATURE_COUNT; f++) {
    const i = 1 * VOICE_FEATURE_COUNT + f;
    if (!close(messy.profile.centroids[i], good.profile.centroids[i], 1e-9)) same = false;
  }
  ok("trim: the centroid matches the take without it", same);

  // Under TRIM_MIN_ROWS there is not enough spread to call anything an outlier, so a
  // small take is kept whole and the spread readout is what warns the user.
  const small = trainVoiceProfile(null, [...take(2, 3, 0.2, 0.004), row(2, 5)]);
  ok("trim: a four-row take is not trimmed", small.classes[2].rejected === 0 && small.classes[2].used === 4);
  ok("trim: and its spread reads as messy", small.classes[2].spread > 1, `${small.classes[2].spread.toFixed(3)}`);

  // A perfectly consistent performer must not have their whole take rejected by a
  // zero-width limit.
  const identical: VoiceCapture[] = [];
  for (let i = 0; i < 6; i++) identical.push(row(3, 0.5));
  const perfect = trainVoiceProfile(null, identical);
  ok("trim: identical rows all survive", perfect.classes[3].used === 6 && perfect.classes[3].rejected === 0);
  // Not exactly zero: summing six identical doubles and dividing leaves the mean an ulp
  // off the rows it came from, so the distance reads ~1e-16 rather than 0.
  ok("trim: and their spread is zero", perfect.classes[3].spread < 1e-9, `${perfect.classes[3].spread}`);
}

// ---------------------------------------------------------------------------
console.log("== 4. too few hits leaves the class alone ==");
{
  const thin = trainVoiceProfile(null, take(0, VOICE_MIN_HITS - 1, 0.3));
  ok("thin: not trained", thin.classes[0].trained === false);
  ok("thin: rows counted for the panel", thin.classes[0].used === VOICE_MIN_HITS - 1);
  ok("thin: profile left factory", thin.profile.trained[0] === 0 && thin.profile.centroids.every((n) => n === 0));

  const exact = trainVoiceProfile(null, take(0, VOICE_MIN_HITS, 0.3));
  ok("thin: exactly the minimum is enough", exact.classes[0].trained === true);

  ok("thin: no rows at all is not an error", trainVoiceProfile(null, []).classes.every((c) => !c.trained));
  const rowsWithNoise = trainVoiceProfile(null, take(0, 5, 0.3), 99);
  ok("thin: a caller can demand more hits", rowsWithNoise.classes[0].trained === false);
}

// ---------------------------------------------------------------------------
console.log("== 5. rubbish rows are thrown out, not propagated ==");
{
  const bad: VoiceCapture[] = [
    { cls: 0, features: [Number.NaN, 0, 0, 0], attack: [0, 0, 0], strength: 1 },
    { cls: 0, features: [0.1, 0.2, 0.3, 0.4], attack: [0.1, 0.2, Number.POSITIVE_INFINITY], strength: 1 },
    { cls: 0, features: [0.1, 0.2], attack: [0.1, 0.2, 0.3], strength: 1 }, // short
    { cls: 0, features: [0.1, 0.2, 0.3, 0.4], attack: [0.1, 0.2, 0.3], strength: Number.NaN },
  ];
  const res = trainVoiceProfile(null, [...take(0, 4, 0.35, 0.004), ...bad]);
  ok("invalid: all four rubbish rows rejected", res.classes[0].invalid === 4, `invalid=${res.classes[0].invalid}`);
  ok("invalid: the good rows still trained the class", res.classes[0].trained === true && res.classes[0].used === 4);
  ok("invalid: nothing non-finite reached the profile", res.profile.centroids.every(Number.isFinite));

  const onlyBad = trainVoiceProfile(null, bad);
  ok("invalid: a take of nothing but rubbish trains nothing", onlyBad.classes[0].trained === false);

  // Rows labelled with a class that does not exist belong to no class and are ignored.
  const stray = trainVoiceProfile(null, [...take(0, 4, 0.3), ...take(99, 6, 0.3)]);
  ok("invalid: out-of-range class labels are ignored", stray.classes[0].used === 4 && stray.classes.length === VOICE_CLASS_COUNT);
}

// ---------------------------------------------------------------------------
console.log("== 6. training is incremental and never touches settings ==");
{
  const base = defaultVoiceProfile();
  base.params.sensitivity = 3.5;
  base.params.enabled = 1;
  base.classPads[2] = 11;
  const first = trainVoiceProfile(base, take(0, 6, 0.3)).profile;
  ok("incremental: params survive a pass", first.params.sensitivity === 3.5 && first.params.enabled === 1);
  ok("incremental: pad routing survives a pass", first.classPads[2] === 11);
  ok("incremental: base was not mutated", base.trained[0] === 0);

  const second = trainVoiceProfile(first, take(1, 6, 0.6)).profile;
  ok("incremental: the first class is still trained", second.trained[0] === 6);
  ok("incremental: the second class is now trained too", second.trained[1] === 6);
  let kept = true;
  for (let f = 0; f < VOICE_FEATURE_COUNT; f++) {
    if (!close(second.centroids[f], first.centroids[f], 1e-12)) kept = false;
  }
  ok("incremental: the first class's numbers are byte-identical", kept);

  const redone = trainVoiceProfile(second, take(0, 4, 0.9)).profile;
  ok("incremental: recalibrating one class replaces its row", redone.trained[0] === 4 && redone.centroids[0] > 0.8);
  ok("incremental: and leaves the other trained class alone", redone.trained[1] === 6);
}

// ---------------------------------------------------------------------------
console.log("== 7. untraining is per class and keeps the settings ==");
{
  let p = trainVoiceProfile(null, [...take(0, 5, 0.3), ...take(1, 5, 0.6)]).profile;
  p.params.velDb = 33;
  p.classPads[0] = 7;
  const one = untrainVoiceProfile(p, 0);
  ok("untrain: the named class is factory again", one.trained[0] === 0);
  ok("untrain: its rows are zeroed", one.centroids.slice(0, VOICE_FEATURE_COUNT).every((n) => n === 0));
  ok("untrain: the other class survives", one.trained[1] === 5);
  ok("untrain: params and routing survive", one.params.velDb === 33 && one.classPads[0] === 7);
  ok("untrain: the input was not mutated", p.trained[0] === 5);

  const all = untrainVoiceProfile(p, -1);
  ok("untrain: -1 clears every class", all.trained.every((t) => t === 0) && all.centroids.every((n) => n === 0));
  ok("untrain: still keeps params", all.params.velDb === 33);
}

// ---------------------------------------------------------------------------
console.log("== 8. a calibration survives the kit document ==");
{
  const kit = emptyKit();
  ok("kit: a new kit carries a factory profile", kit.voice.trained.every((t) => t === 0));

  kit.voice = trainVoiceProfile(kit.voice, [...take(0, 6, 0.31), ...take(2, 5, 0.77)]).profile;
  kit.voice.params.sensitivity = 2.9;
  kit.voice.params.mode = 1;
  kit.voice.classPads[3] = -1;

  const doc = exportKit(kit);
  ok("kit: the document carries the profile", !!doc.voice);
  const round = importKit(JSON.parse(JSON.stringify(doc)));
  ok("kit: params round-trip", round.voice.params.sensitivity === 2.9 && round.voice.params.mode === 1);
  ok("kit: a muted class round-trips as -1", round.voice.classPads[3] === -1);
  ok("kit: trained counts round-trip", round.voice.trained[0] === 6 && round.voice.trained[2] === 5);
  ok("kit: untrained classes stay untrained", round.voice.trained[1] === 0 && round.voice.trained[3] === 0);
  let exact = true;
  for (let i = 0; i < kit.voice.centroids.length; i++) {
    if (kit.voice.trained[Math.floor(i / VOICE_FEATURE_COUNT)] === 0) continue;
    if (!close(round.voice.centroids[i], kit.voice.centroids[i], 1e-12)) exact = false;
  }
  for (let i = 0; i < kit.voice.attack.length; i++) {
    if (kit.voice.trained[Math.floor(i / VOICE_ATTACK_COUNT)] === 0) continue;
    if (!close(round.voice.attack[i], kit.voice.attack[i], 1e-12)) exact = false;
  }
  ok("kit: trained tables round-trip exactly", exact);
  ok("kit: the export is a copy, not a reference", doc.voice !== kit.voice && doc.voice?.centroids !== kit.voice.centroids);
}

// ---------------------------------------------------------------------------
console.log("== 9. a damaged document loses as little as possible ==");
{
  ok("import: no profile at all reads as factory", importVoiceProfile(undefined).trained.every((t) => t === 0));
  ok("import: null reads as factory", importVoiceProfile(null).trained.every((t) => t === 0));
  ok("import: a pre-Phase-4 kit document still loads", importKit({ name: "old", pads: [] }).voice.trained.every((t) => t === 0));

  const trained = trainVoiceProfile(null, [...take(0, 5, 0.3), ...take(1, 5, 0.6)]).profile;
  const doc = JSON.parse(JSON.stringify(trained)) as VoiceProfile;
  // One corrupt number in class 1 must cost class 1 and nothing else.
  doc.centroids[1 * VOICE_FEATURE_COUNT + 2] = Number.NaN;
  const partial = importVoiceProfile(doc);
  ok("import: the corrupt class falls back to factory", partial.trained[1] === 0);
  ok("import: the intact class is kept", partial.trained[0] === 5);
  ok("import: no NaN reached the profile", partial.centroids.every(Number.isFinite));

  const short = JSON.parse(JSON.stringify(trained)) as VoiceProfile;
  short.centroids = short.centroids.slice(0, 2);
  short.attack = [];
  const trimmed = importVoiceProfile(short);
  ok("import: truncated tables read as untrained", trimmed.trained.every((t) => t === 0));
  ok("import: and the params still come back", trimmed.params.sensitivity === trained.params.sensitivity);

  const nonsense = importVoiceProfile({
    params: { sensitivity: Number.NaN, velDb: 19, nonsense: 5 } as Record<string, number>,
    classPads: [99, -5, 2, Number.NaN] as number[],
    centroids: null as unknown as number[],
    attack: undefined as unknown as number[],
    trained: ["x" as unknown as number, 3, 0, 0],
  });
  ok("import: a NaN param falls back to the default", nonsense.params.sensitivity === VOICE_DEFAULTS.sensitivity);
  ok("import: a good param is taken", nonsense.params.velDb === 19);
  ok("import: an unknown param key is dropped", nonsense.params.nonsense === undefined);
  ok("import: an out-of-rack pad is refused", nonsense.classPads[0] === VOICE_DEFAULT_CLASS_PADS[0], `${nonsense.classPads[0]}`);
  ok("import: a negative pad clamps to mute", nonsense.classPads[1] === -1);
  ok("import: a good pad is taken", nonsense.classPads[2] === 2);
  ok("import: a NaN pad falls back", nonsense.classPads[3] === VOICE_DEFAULT_CLASS_PADS[3]);
  ok("import: missing tables mean untrained, not a throw", nonsense.trained.every((t) => t === 0));
}

// ---------------------------------------------------------------------------
console.log("== 10. fuzz: any pile of rows, any order ==");
{
  let seed = 20260913;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let allFinite = true;
  let shapesOk = true;
  let threw = false;
  let profile: VoiceProfile | null = null;
  try {
    for (let pass = 0; pass < 400; pass++) {
      const rows: VoiceCapture[] = [];
      const n = (rnd() * 30) | 0;
      for (let i = 0; i < n; i++) {
        const cls = ((rnd() * 6) | 0) - 1;
        const wild = rnd() < 0.15;
        const r = row(cls, wild ? (rnd() - 0.5) * 1000 : rnd());
        if (rnd() < 0.08) r.features[(rnd() * VOICE_FEATURE_COUNT) | 0] = rnd() < 0.5 ? Number.NaN : Number.POSITIVE_INFINITY;
        if (rnd() < 0.05) r.attack = r.attack.slice(0, 1);
        rows.push(r);
      }
      const res = trainVoiceProfile(rnd() < 0.5 ? profile : null, rows, 1 + ((rnd() * 5) | 0));
      profile = rnd() < 0.3 ? untrainVoiceProfile(res.profile, ((rnd() * 6) | 0) - 1) : res.profile;
      if (!profile.centroids.every(Number.isFinite) || !profile.attack.every(Number.isFinite)) allFinite = false;
      if (
        profile.centroids.length !== VOICE_CLASS_COUNT * VOICE_FEATURE_COUNT ||
        profile.attack.length !== VOICE_CLASS_COUNT * VOICE_ATTACK_COUNT ||
        profile.trained.length !== VOICE_CLASS_COUNT ||
        profile.classPads.length !== VOICE_CLASS_COUNT
      ) {
        shapesOk = false;
      }
      if (res.classes.length !== VOICE_CLASS_COUNT) shapesOk = false;
      for (const c of res.classes) {
        if (!Number.isFinite(c.spread) || c.used < 0 || c.rejected < 0 || c.invalid < 0) shapesOk = false;
      }
    }
  } catch (e) {
    threw = true;
    console.log(String(e));
  }
  ok("fuzz: never threw", !threw);
  ok("fuzz: profile always finite", allFinite);
  ok("fuzz: profile shape never drifted", shapesOk);
  ok(
    "fuzz: params never lost",
    !!profile && VOICE_KEY.every((k) => Number.isFinite((profile as VoiceProfile).params[k])),
  );
  // And whatever the fuzz produced must still survive a save and a load.
  const survived = importVoiceProfile(JSON.parse(JSON.stringify(profile)));
  ok("fuzz: the result still round-trips through the document", survived.centroids.every(Number.isFinite));
}

console.log("");
console.log(`${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
