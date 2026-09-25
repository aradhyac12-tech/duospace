/**
 * moodScoring — pure expression → mood math, shared by the manual
 * MoodDetector card and useBackgroundMoodDetection (the silent, no-popup
 * mode). Both need to score a face exactly the same way; keeping the math
 * in one place means a future tuning change can't accidentally apply to
 * only one of the two paths.
 *
 * FaceMesh landmark indices (canonical 478-point topology) used for
 * expression features. All reads come from DetectedFace.embedding, which
 * is ALREADY centered on the nose and scaled by inter-ocular distance (see
 * lib/faceRecognition.ts buildEmbedding) — so these deltas are comparable
 * across different faces, distances from camera, and frame resolutions
 * without any extra normalization here.
 */
import { Smile, Frown, Meh, Heart, Angry, Sparkles, Cloud, type LucideIcon } from "lucide-react";
import storage from "@/lib/storage";
import type { BlendshapeScores } from "@/lib/faceRecognition";

// ── On-device calibration (privacy: mood feedback never leaves the device) ──
// The distrust multiplier per mood is computed entirely from locally-stored
// feedback history, not from Supabase. This means mood_logs.feedback
// writes are also local-only — the server never sees whether a read was
// accurate, so there's no way to reconstruct a person's emotional history
// from server-side data.
const CALIBRATION_KEY = "mood-calibration-v1";
interface CalibrationEntry {
  mood: string;
  total: number;
  inaccurate: number;
}
const readCalibration = (): CalibrationEntry[] =>
  storage.getJSON<CalibrationEntry[]>(CALIBRATION_KEY, []);
const writeCalibration = (entries: CalibrationEntry[]) =>
  storage.setJSON(CALIBRATION_KEY, entries);

/** Record a mood feedback event locally. Called by MoodDetector on thumbs-up/down. */
export const recordMoodFeedback = (mood: string, accurate: boolean): void => {
  const entries = readCalibration();
  let entry = entries.find((e) => e.mood === mood);
  if (!entry) {
    entry = { mood, total: 0, inaccurate: 0 };
    entries.push(entry);
  }
  entry.total++;
  if (!accurate) entry.inaccurate++;
  writeCalibration(entries);
};

/** Compute per-mood distrust multipliers from local feedback history.
 *  Returns the same shape as the old Supabase-derived distrustRef. */
export const getLocalDistrust = (): Record<string, number> => {
  const entries = readCalibration();
  const distrust: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.total < 3) continue;
    const inaccurateRate = entry.inaccurate / entry.total;
    distrust[entry.mood] = 1 + Math.min(inaccurateRate, 0.7) * 1.2;
  }
  return distrust;
};

const IDX = {
  mouthLeft: 61, mouthRight: 291,
  lipTop: 13, lipBottom: 14,
  // Additional lip landmarks for more robust mouth-curve calculation.
  // philtrum (upper lip center) and chin give a better vertical reference
  // than just lipTop alone.
  philtrum: 0, chin: 152,
  browLeft: 105, browRight: 334,
  // Inner brow landmarks for better furrow detection (Frustrated mood).
  browInnerLeft: 107, browInnerRight: 336,
  eyeTopLeft: 159, eyeTopRight: 386,
  // Eye bottom landmarks for better eye-aspect-ratio calculation.
  eyeBottomLeft: 145, eyeBottomRight: 374,
};

export interface ExpressionSample {
  mouthCurve: number;   // + = corners lifted (smile), - = corners dropped (frown)
  mouthOpen: number;    // vertical lip gap
  browRaise: number;    // + = brows raised, - = brows lowered/furrowed
  eyeOpenness: number;  // EAR, already computed by faceRecognition
}

const yAt = (embedding: Float32Array, landmark: number) => embedding[landmark * 3 + 1];

/** Extract normalized expression features from one detected face's embedding.
 *  Uses additional landmarks for more robust feature extraction:
 *  - Mouth curve: averaged from corners + philtrum reference for stability
 *  - Brow raise: includes inner brow landmarks for furrow detection
 *  - Eye openness: computed here from landmarks (not just EAR from the caller)
 *    so the mood scorer has its own independent eye signal. */
export const extractExpression = (embedding: Float32Array): ExpressionSample => {
  const cornerAvgY = (yAt(embedding, IDX.mouthLeft) + yAt(embedding, IDX.mouthRight)) / 2;
  const lipCenterY = (yAt(embedding, IDX.lipTop) + yAt(embedding, IDX.lipBottom)) / 2;
  // Philtrum-to-chin vertical span as a face-size reference for normalization.
  const faceSpan = Math.abs(yAt(embedding, IDX.philtrum) - yAt(embedding, IDX.chin)) || 1;

  // Mouth curve: positive = corners above lip center (smile), negative = frown.
  // Normalized by face span so it's comparable across different face sizes.
  const mouthCurve = (lipCenterY - cornerAvgY) / faceSpan;

  // Mouth open: vertical lip gap, normalized by face span.
  const mouthOpen = Math.abs(yAt(embedding, IDX.lipTop) - yAt(embedding, IDX.lipBottom)) / faceSpan;

  // Brow raise: gap between eye top and brow, normalized.
  // Uses both outer and inner brow landmarks for a more stable average.
  const browAvgY = (yAt(embedding, IDX.browLeft) + yAt(embedding, IDX.browRight) +
                    yAt(embedding, IDX.browInnerLeft) + yAt(embedding, IDX.browInnerRight)) / 4;
  const eyeTopAvgY = (yAt(embedding, IDX.eyeTopLeft) + yAt(embedding, IDX.eyeTopRight)) / 2;
  const browRaise = (eyeTopAvgY - browAvgY) / faceSpan;

  // Eye openness: computed from landmarks as a supplement to EAR from the
  // caller. If the caller provides ear, it overrides this (EAR is more
  // reliable from the full 478-point set); this serves as a fallback and
  // as the independent signal for the Calm mood's eyeOpenness term.
  const eyeSpanLeft = Math.abs(yAt(embedding, IDX.eyeTopLeft) - yAt(embedding, IDX.eyeBottomLeft));
  const eyeSpanRight = Math.abs(yAt(embedding, IDX.eyeTopRight) - yAt(embedding, IDX.eyeBottomRight));
  const eyeOpenness = ((eyeSpanLeft + eyeSpanRight) / 2) / faceSpan;

  return { mouthCurve, mouthOpen, browRaise, eyeOpenness };
};

export const moods: Array<{ emoji: string; label: string; icon: LucideIcon; color: string }> = [
  { emoji: "😊", label: "Happy", icon: Smile, color: "text-green-500" },
  { emoji: "😢", label: "Sad", icon: Frown, color: "text-blue-500" },
  { emoji: "😐", label: "Neutral", icon: Meh, color: "text-yellow-500" },
  { emoji: "😍", label: "Loving", icon: Heart, color: "text-pink-500" },
  { emoji: "😤", label: "Frustrated", icon: Angry, color: "text-red-500" },
  { emoji: "😲", label: "Surprised", icon: Sparkles, color: "text-purple-500" },
  { emoji: "😌", label: "Calm", icon: Cloud, color: "text-teal-500" },
];

export const moodToValence: Record<string, { valence: number; arousal: number }> = {
  Happy: { valence: 0.7, arousal: 0.6 },
  Sad: { valence: -0.6, arousal: 0.3 },
  Neutral: { valence: 0, arousal: 0.4 },
  Loving: { valence: 0.9, arousal: 0.7 },
  Frustrated: { valence: -0.5, arousal: 0.8 },
  Surprised: { valence: 0.2, arousal: 0.85 },
  Calm: { valence: 0.4, arousal: 0.15 },
};

/**
 * Evidence score per mood from one averaged feature set. Each term is a
 * nonnegative "how far past the resting threshold" magnitude — these are
 * NOT probabilities yet, softmaxScores() below turns them into a proper
 * distribution. `distrust` (this user's own feedback history) raises the
 * bar for moods they've frequently corrected.
 *
 * Honest scope note: with only 4 landmark-derived scalars (no full FACS
 * Action Units, no per-eyebrow asymmetry, no gaze vector), 7 evidence-backed
 * labels is the practical ceiling here.
 */
export type MoodLabel = "Happy" | "Loving" | "Surprised" | "Frustrated" | "Sad" | "Calm" | "Neutral";

// Fallback used only when a caller has no session samples to derive a real
// baseline from (e.g. an empty pool) — approximate population-average rest
// values, same role the old fixed constants played, but now the exception
// path rather than the only path.
const DEFAULT_BASELINE = { browRaise: 0.24, mouthCurve: 0, eyeOpenness: 0.22 };

/** BUGFIX (was: mood detection always reads "Surprised"): browRaise is the
 *  vertical gap between eyebrow and upper eyelid, normalized by face span
 *  (see extractExpression) — and that gap is naturally well above zero even
 *  at complete rest (eyebrows sit a real distance above the eyes on every
 *  face). The old code compared raw browRaise straight against a fixed
 *  0.15 constant meant to represent "eyebrows raised", but most people's
 *  RESTING brow position already clears 0.15-0.3 depending on face
 *  geometry — so the Surprised term fired on nearly every frame, and at
 *  its ×20 weight it beat Neutral's flat floor (2.0) almost unconditionally
 *  regardless of actual expression. Frustrated's mirrored check
 *  (`0.12 - browRaise`) had the same problem in reverse: with a real
 *  resting value usually above 0.12, that term almost never fired, so
 *  Frustrated was effectively dead.
 *
 *  ACCURACY PASS: the same class of bug — a fixed universal constant
 *  standing in for "how this specific face looks at rest" — was quietly
 *  there for mouthCurve and eyeOpenness too, just less catastrophically
 *  (their thresholds happen to sit closer to a typical rest value, so they
 *  didn't monopolize every read the way browRaise did, but a face with a
 *  naturally upturned/downturned resting mouth, or naturally narrow/wide
 *  resting eyes, was still getting a systematically biased score). All
 *  three now score as a DELTA from a per-session baseline (see
 *  sessionBaseline below) — this session's own calm reading for each
 *  feature — instead of one constant assumed to fit every face.
 *
 *  Honest ceiling: this still can't reach "100% accurate". There is no
 *  ground-truth-labeled training set behind these numbers — they're
 *  geometric heuristics on 4 scalars, not a trained classifier — and human
 *  expression reading is inherently ambiguous even between two people
 *  looking at the same face (that's exactly what `margin`/`ambiguous` below
 *  exists to admit rather than hide). What CAN be pushed further, and is
 *  reflected in the deltas below plus MOOD_MIN_MARGIN, is: removing
 *  systematic per-face bias (this pass), rejecting frames too degraded to
 *  trust (moodFrameIssue), rejecting blinks (filterBlinks), smoothing over
 *  time (the caller's rolling window), and refusing to guess when two moods
 *  are genuinely close instead of confidently picking the wrong one. */
export const scoreMoods = (
  f: { mouthCurve: number; mouthOpen: number; browRaise: number; eyeOpenness: number },
  distrust: Record<string, number>,
  baseline: { browRaise: number; mouthCurve: number; eyeOpenness: number } = DEFAULT_BASELINE,
): Record<MoodLabel, number> => {
  const need = (mood: string, base: number) => base * (distrust[mood] ?? 1);
  // + = above THIS session's own calm reading for that feature, - = below.
  const browDelta = f.browRaise - baseline.browRaise;
  const curveDelta = f.mouthCurve - baseline.mouthCurve;
  const eyeDelta = f.eyeOpenness - baseline.eyeOpenness;
  // Thresholds are tuned for face-span-normalized features (see extractExpression).
  // The normalization makes these thresholds more stable across different
  // face sizes, distances from camera, and frame resolutions. mouthOpen is
  // deliberately left un-baselined — a closed resting mouth sits at ~0 for
  // essentially everyone, so there's no comparable per-face bias to correct.
  return {
    Happy:      Math.max(0, curveDelta - need("Happy", 0.012)) * 35
              + Math.max(0, f.mouthOpen - need("Happy", 0.025)) * 18,
    Loving:     Math.max(0, curveDelta - need("Loving", 0.008)) * 25
              + Math.max(0, 0.025 - f.mouthOpen) * 8,
    Surprised:  Math.max(0, browDelta  - need("Surprised", 0.09)) * 24
              + Math.max(0, f.mouthOpen - need("Surprised", 0.05)) * 20,
    Frustrated: Math.max(0, -curveDelta - need("Frustrated", 0.005)) * 28
              + Math.max(0, -browDelta  - need("Frustrated", 0.04)) * 16,
    Sad:        Math.max(0, -curveDelta - need("Sad", 0.003)) * 22
              + Math.max(0, -eyeDelta   - need("Sad", 0.02)) * 14,
    Calm:       Math.max(0, eyeDelta - 0.02) * 10
              + Math.max(0, 0.015 - Math.abs(curveDelta)) * 12,
    // Flat floor, not a feature-derived score — wins only when nothing
    // else clears its own threshold, same role the old `else` branch played.
    Neutral: 2.0,
  };
};

/** Per-session baseline: what THIS face looked like at its calmest during
 *  THIS capture, per feature — used to score brow/mouth-curve/eye-openness
 *  as deltas instead of against one fixed constant assumed to fit every
 *  face (see scoreMoods' doc comment above for why that was the actual bug
 *  behind "always Surprised", and why the same fix now covers the other
 *  two person-variable features as well).
 *  - browRaise, eyeOpenness: 20th percentile (low end, not the bare
 *    minimum — one freak low-reading frame can't anchor the whole session).
 *  - mouthCurve: median — unlike brow/eye, a resting mouth can genuinely
 *    curve either up or down depending on the person, so "low end" isn't
 *    the right reference; the session's typical (middle) reading is.
 *  Call this on the same `pool` (post filterBlinks) passed to weightedAvg,
 *  and pass the result as scoreMoods' `baseline` argument. */
export const sessionBaseline = (
  pool: ExpressionSample[],
): { browRaise: number; mouthCurve: number; eyeOpenness: number } => {
  if (pool.length === 0) return DEFAULT_BASELINE;
  const percentile = (vals: number[], p: number) => {
    const sorted = [...vals].sort((a, b) => a - b);
    return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
  };
  return {
    browRaise: percentile(pool.map((s) => s.browRaise), 0.2),
    mouthCurve: percentile(pool.map((s) => s.mouthCurve), 0.5),
    eyeOpenness: percentile(pool.map((s) => s.eyeOpenness), 0.2),
  };
};

/**
 * scoreMoodsFromBlendshapes — mood evidence from MediaPipe's trained face
 * blendshape model (52 ARKit-compatible per-muscle activation scores, each
 * already ~0 at genuine rest and calibrated across many real faces) instead
 * of raw landmark geometry. This is the accuracy upgrade over scoreMoods()
 * above: blendshapes are themselves the output of a trained regression
 * model, so "0" genuinely means "that muscle isn't engaged" for THIS face,
 * not a fixed number borrowed from someone else's resting geometry — the
 * exact class of bug scoreMoods() needed sessionBaseline() to work around.
 * Callers should prefer this path whenever blendshapes are available and
 * fall back to scoreMoods()'s geometry pipeline only when they aren't
 * (older/slower device, model still warming up, etc.) — see MoodDetector.tsx
 * and useBackgroundMoodDetection.ts for that fallback decision.
 *
 * Mapping is FACS-informed (Facial Action Coding System), not invented:
 *  - Happy:      mouthSmileLeft/Right (AU12, lip-corner pull), boosted by
 *                cheekSquintLeft/Right (AU6 — the "Duchenne marker" long
 *                used to separate a genuine smile from a posed one).
 *  - Loving:     the same lip-corner pull, but a closed-mouth read (low
 *                jawOpen, high mouthClose) — an open-mouth grin/laugh reads
 *                as Happy instead.
 *  - Surprised:  browInnerUp + browOuterUpLeft/Right (AU1+2, both brow
 *                segments raised together) with jawOpen (AU26) and
 *                eyeWideLeft/Right (AU5).
 *  - Frustrated: browDownLeft/Right (AU4, a furrow) with a pressed/tight
 *                mouth (AU23/24) weighted over a soft, open frown.
 *  - Sad:        mouthFrownLeft/Right (AU15) together with inner-brow rise
 *                WITHOUT the outer-brow rise — AU1 without AU2 is the
 *                classic "sad brow" (inner corners pull up, outer corners
 *                stay down), the textbook FACS way to tell Sad's brow from
 *                Surprised's.
 *  - Calm:       low activation everywhere (brows, mouth tension, jaw) plus
 *                a closed mouth — scored as an absence of tension rather
 *                than one specific action unit, since "calm" isn't itself
 *                a FACS-coded expression.
 */
// BUGFIX (was: mood detection always reads "Surprised", blendshape path):
// this is the SAME class of bug that sessionBaseline() above exists to fix
// for the geometry path — a fixed universal constant standing in for "what
// this face/camera setup looks like at rest" — just not yet applied here.
// The doc comment above claims blendshapes are "already ~0 at genuine
// rest", which is the model's design intent, but in practice a phone's
// front camera is usually held BELOW eye level, and that upward viewing
// angle alone reads to the model as partially raised eyebrows and slightly
// widened eyes for almost everyone — exactly the "browRaise looks nonzero
// at rest" problem the geometry path already had to correct for. Since
// this path is PREFERRED over the geometry path whenever the blendshape
// model is available (see MoodDetector.tsx / useBackgroundMoodDetection.ts
// — blendshapePool.length >= 3), most sessions on most devices were
// actually hitting this unbaselined path, not the one that got fixed —
// which is why "always Surprised" could still reproduce after that fix.
// Same per-session-baseline treatment now applies here: brow/eye/jaw
// features are scored as a delta from THIS session's own calm reading,
// not against a constant assumed to be universal.
const blendshapeKeys = [
  "mouthSmileLeft", "mouthSmileRight", "cheekSquintLeft", "cheekSquintRight",
  "browInnerUp", "browOuterUpLeft", "browOuterUpRight", "browDownLeft", "browDownRight",
  "jawOpen", "mouthClose", "eyeWideLeft", "eyeWideRight",
  "mouthFrownLeft", "mouthFrownRight", "mouthPressLeft", "mouthPressRight",
] as const;

/** Per-session baseline for the blendshape path — 20th-percentile (low end,
 *  not bare minimum) reading of each relevant blendshape across this
 *  session's frames, the same percentile choice sessionBaseline() uses for
 *  brow/eye and for the same reason. Call on the same pool passed to
 *  weightedAvgBlendshapes, and pass the result as scoreMoodsFromBlendshapes'
 *  `baseline` argument. */
export const blendshapeBaseline = (pool: BlendshapeScores[]): Record<string, number> => {
  const baseline: Record<string, number> = {};
  if (pool.length === 0) return baseline;
  const percentile = (vals: number[], p: number) => {
    const sorted = [...vals].sort((a, b) => a - b);
    return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
  };
  for (const key of blendshapeKeys) {
    baseline[key] = percentile(pool.map((s) => s[key] ?? 0), 0.2);
  }
  return baseline;
};

export const scoreMoodsFromBlendshapes = (
  b: BlendshapeScores,
  distrust: Record<string, number>,
  baseline: Record<string, number> = {},
): Record<MoodLabel, number> => {
  const need = (mood: string, base: number) => base * (distrust[mood] ?? 1);
  // Delta from this session's own baseline reading for that blendshape,
  // never below 0 — a face relaxing BELOW its own baseline isn't "extra"
  // smile/brow-raise/etc, it's just noise around the resting point.
  const g = (name: string) => Math.max(0, (b[name] ?? 0) - (baseline[name] ?? 0));

  const smile      = (g("mouthSmileLeft") + g("mouthSmileRight")) / 2;
  const duchenne    = (g("cheekSquintLeft") + g("cheekSquintRight")) / 2;
  const browInnerUp = g("browInnerUp");
  const browOuterUp = (g("browOuterUpLeft") + g("browOuterUpRight")) / 2;
  const browDown    = (g("browDownLeft") + g("browDownRight")) / 2;
  const jawOpen      = g("jawOpen");
  const mouthClose   = g("mouthClose");
  const eyeWide      = (g("eyeWideLeft") + g("eyeWideRight")) / 2;
  const frown        = (g("mouthFrownLeft") + g("mouthFrownRight")) / 2;
  const press        = (g("mouthPressLeft") + g("mouthPressRight")) / 2;
  const tension       = browDown + jawOpen + frown + press; // rough "not relaxed" total

  return {
    Happy:      Math.max(0, smile - need("Happy", 0.18)) * 55
              + duchenne * 15,
    Loving:     Math.max(0, smile - need("Loving", 0.12)) * 40
              + Math.max(0, mouthClose - jawOpen) * 10,
    Surprised:  Math.max(0, (browInnerUp + browOuterUp) / 2 - need("Surprised", 0.25)) * 45
              + Math.max(0, jawOpen - need("Surprised", 0.2)) * 25
              + eyeWide * 10,
    Frustrated: Math.max(0, browDown - need("Frustrated", 0.2)) * 45
              + Math.max(0, press - frown) * 15,
    Sad:        Math.max(0, frown - need("Sad", 0.12)) * 40
              + Math.max(0, browInnerUp - browOuterUp - need("Sad", 0.05)) * 20,
    Calm:       Math.max(0, 0.15 - tension) * 6
              + mouthClose * 4,
    // Flat floor, not a feature-derived score — wins only when nothing
    // else clears its own threshold, same role it plays in scoreMoods().
    Neutral: 2.0,
  };
};

/** Recency-weighted average of blendshape scores across a session's frames
 *  — same weighting scheme as weightedAvg() below (later samples count
 *  more, since expressions typically settle over the capture window),
 *  applied per blendshape category instead of a single scalar. */
export const weightedAvgBlendshapes = (pool: BlendshapeScores[]): BlendshapeScores => {
  const out: BlendshapeScores = {};
  if (pool.length === 0) return out;
  const keys = Object.keys(pool[pool.length - 1]);
  const weights = pool.map((_, i) => 0.5 + i / Math.max(1, pool.length - 1));
  const wSum = weights.reduce((a, w) => a + w, 0);
  for (const key of keys) {
    let vSum = 0;
    pool.forEach((s, i) => { vSum += (s[key] ?? 0) * weights[i]; });
    out[key] = vSum / wSum;
  }
  return out;
};

/** Reject blink frames before averaging, using the model's OWN trained
 *  blink signal (eyeBlinkLeft/Right) rather than filterBlinks()' geometry
 *  EAR proxy below — more reliable since it isn't affected by how open
 *  THIS face's eyes normally sit at rest. */
export const filterBlinksBlendshapes = (samples: BlendshapeScores[]): BlendshapeScores[] => {
  const isBlink = (s: BlendshapeScores) => Math.max(s.eyeBlinkLeft ?? 0, s.eyeBlinkRight ?? 0) > 0.5;
  const filtered = samples.filter((s) => !isBlink(s));
  return filtered.length >= 3 ? filtered : samples;
};

/** Turn evidence scores into a probability distribution over all moods, so
 *  we can store "Happy 74%, Loving 12%, Surprised 8%, ..." instead of just
 *  the single winning label — this is what lets confidence reflect genuine
 *  ambiguity (two moods close together) rather than only signal magnitude.
 *  Temperature parameter (0.8) controls how peaked the distribution is:
 *  lower = more confident, higher = more uniform. 0.8 is a good balance
 *  between distinguishing clear expressions and tolerating noisy inputs. */
export const softmaxScores = (scores: Record<MoodLabel, number>): Record<MoodLabel, number> => {
  const entries = Object.entries(scores) as [MoodLabel, number][];
  const max = Math.max(...entries.map(([, v]) => v));
  const exps = entries.map(([k, v]) => [k, Math.exp((v - max) * 0.8)] as const);
  const sum = exps.reduce((a, [, v]) => a + v, 0) || 1;
  return Object.fromEntries(exps.map(([k, v]) => [k, v / sum])) as Record<MoodLabel, number>;
};

/**
 * Pick the winning mood from a probability distribution AND report how
 * decisively it won (top1 − top2). Softmax probabilities alone are a poor
 * stand-in for genuine confidence — a well-known failure mode in modern
 * classifiers (Guo et al., "On Calibration of Modern Neural Networks",
 * ICML 2017) is that even a low-evidence, near-tied distribution can still
 * produce a "winning" class that LOOKS confident once temperature-scaled
 * softmax has spread it out. A separate margin check (top1 − top2) catches
 * exactly the ambiguous case that a single softmax number can hide: two
 * moods (e.g. Happy vs Loving, both driven by mouthCurve) landing close
 * together isn't "probably Happy", it's "the face doesn't clearly say
 * either" — this exists so callers can tell those two situations apart
 * instead of silently reporting whichever mood happened to round up.
 */
export const MOOD_MIN_MARGIN = 0.12;

export const topMoodWithMargin = (
  scores: Record<MoodLabel, number>,
): { mood: MoodLabel; topProb: number; margin: number; ambiguous: boolean } => {
  const ranked = (Object.entries(scores) as [MoodLabel, number][]).sort((a, b) => b[1] - a[1]);
  const [mood, topProb] = ranked[0];
  const second = ranked[1]?.[1] ?? 0;
  const margin = topProb - second;
  return { mood, topProb, margin, ambiguous: margin < MOOD_MIN_MARGIN };
};

/** Cheap average-brightness estimate (0-255) from a downsampled frame — just
 *  enough to tell "too dark to read a face" apart from "no face in frame". */
export const sampleLuma = (video: HTMLVideoElement, canvas: HTMLCanvasElement): number | null => {
  const SIZE = 16;
  canvas.width = SIZE; canvas.height = SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, SIZE, SIZE);
    const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    return sum / (data.length / 4);
  } catch { return null; }
};

/** Weighted average helper — later samples in a window count more (see
 *  callers): expressions typically settle over a capture window, so the
 *  first fraction often still carries "surprised by the camera turning on". */
export const weightedAvg = (pool: ExpressionSample[], fn: (s: ExpressionSample) => number): number => {
  let wSum = 0, vSum = 0;
  pool.forEach((s, i) => {
    const w = 0.5 + i / Math.max(1, pool.length - 1);
    wSum += w; vSum += fn(s) * w;
  });
  return vSum / wSum;
};

/** Reject blink frames before averaging — a closed-eye sample would drag
 *  eyeOpenness down in a way that's unrelated to the "eyes narrowed" cue
 *  used for Sad, and can momentarily distort mouth/brow readings too. */
export const filterBlinks = (samples: ExpressionSample[]): ExpressionSample[] => {
  const sortedEye = [...samples.map((s) => s.eyeOpenness)].sort((a, b) => a - b);
  const medianEye = sortedEye[Math.floor(sortedEye.length / 2)] || 0;
  const blinkFiltered = samples.filter((s) => medianEye === 0 || s.eyeOpenness > medianEye * 0.55);
  return blinkFiltered.length >= 3 ? blinkFiltered : samples;
};

// ── Per-frame quality gate ───────────────────────────────────────────────
// Mood scoring reads much smaller signals than owner/stranger matching does
// (a mouth-curve delta of a couple percent of face-span is the whole
// difference between "Neutral" and "Happy") — so it's *more* sensitive to
// degraded landmarks than Peek Guard's face matching is, not less. A face
// can pass MediaPipe's own detection threshold while still being too small,
// too blurry, or too off-angle for THOSE specific few-percent deltas to be
// trustworthy. This gate exists so both capture paths (manual card,
// background) reject that kind of frame before it ever reaches
// extractExpression, instead of silently averaging noise into the read.
export interface FaceQualityInput {
  area: number;
  pose: { yaw: number; pitch: number };
  textureScore?: { laplacianVar: number; lumaStdDev: number } | null;
}
// Deliberately a bit stricter than Peek Guard's equivalent gates — Peek
// Guard only needs to tell "is this roughly the owner's face shape",
// mood scoring needs the fine geometry of lip corners and brow position.
// TUNING PASS: thresholds loosened slightly so ordinary indoor lighting and
// minor head turns don't keep silently dropping frames without scoring them.
export const MOOD_MIN_FACE_AREA = 0.020;   // LOWERED from 0.025: ~14%x14% still has enough pixels for deltas
export const MOOD_MAX_YAW = 0.13;          // WIDENED from 0.10: slight head turns are normal conversation posture
export const MOOD_MAX_PITCH = 0.12;        // WIDENED from 0.10: glancing slightly down at phone is normal
export const MOOD_MIN_LAPLACIAN_VAR = 6;   // LOWERED from 8: minor motion blur still leaves usable deltas
export const MOOD_MIN_LUMA = 38;           // LOWERED from 45: modern sensors handle dim rooms better than 45 implies

export type MoodFrameIssue = "too_dark" | "too_blurry" | "off_angle" | "too_small" | null;

/** Returns null when the frame is usable, or which single reason it isn't
 *  (checked in the order most likely to actually be the cause, so the UI
 *  can surface one specific hint rather than a generic "bad frame"). Luma
 *  is checked separately by the caller (it's cheap and worth doing even on
 *  frames with zero faces, to tell "too dark" apart from "not in frame") —
 *  this only judges the face itself once one is already detected. */
export const moodFrameIssue = (f: FaceQualityInput): MoodFrameIssue => {
  if (f.area < MOOD_MIN_FACE_AREA) return "too_small";
  if (Math.abs(f.pose.yaw) > MOOD_MAX_YAW || Math.abs(f.pose.pitch) > MOOD_MAX_PITCH) return "off_angle";
  if (f.textureScore && f.textureScore.laplacianVar < MOOD_MIN_LAPLACIAN_VAR) return "too_blurry";
  return null;
};
