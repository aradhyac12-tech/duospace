/**
 * moodPipeline — the ONE place a capture session's frames become a mood
 * reading. Used by both the manual card (MoodDetector) and the silent
 * background detector, which previously carried two near-identical copies of
 * this logic (and both had the same weaknesses). Pure: no storage, no React,
 * no network — profile / distrust are passed in so it is unit-testable.
 *
 * What changed vs. "average the features, score once":
 *  1. SCORE EVERY FRAME, THEN AGGREGATE. The old code averaged features across
 *     the window and scored the average once, so one noisy frame could swing a
 *     hinge-shaped score and a brief expression looked as strong as a sustained
 *     one. Now each usable frame is scored on its own and the evidence is
 *     quality- and recency-weighted. A single smile frame among ten neutral
 *     ones stays Neutral; a sustained smile wins.
 *  2. REAL TEMPORAL STABILITY. MoodDetector's "rolling window smoothing" only
 *     ever held ONE distribution (it was cleared per scan), so it did nothing.
 *     Stability is now measured directly: the weighted share of frames whose own
 *     best mood agrees with the final one. It feeds confidence.
 *  3. TALKING / CHEWING GUARD. Jaw-open that flickers across the window is
 *     speech, not surprise — the jaw signal is damped to its resting (low-quartile) value
 *     when it is unstable.
 *  4. FAMILY-AWARE AMBIGUITY (see topMoodWithMargin): a Happy/Loving near-tie
 *     is a smile of uncertain flavour, not "no expression".
 *  5. BASELINES CAN'T ABSORB A SUSTAINED EXPRESSION (see
 *     BLENDSHAPE_BASELINE_CAP in moodScoring.ts).
 *  6. CONFIDENCE blends probability, margin, frame stability and face coverage
 *     instead of mostly echoing the softmax value. It is a transparent
 *     heuristic score, NOT a calibrated probability of being correct.
 */
import {
  type ExpressionSample, type MoodLabel,
  blendshapeBaseline, filterBlinks, filterBlinksBlendshapes, scoreMoods, scoreMoodsFromBlendshapes,
  sessionBaseline, softmaxScores, topMoodWithMargin, weightedAvgBlendshapes,
} from "@/lib/moodScoring";
import type { BlendshapeScores } from "@/lib/faceRecognition";
import { mergeBaseline, personalizeEvidence, type Feat, type MoodProfile } from "@/lib/moodProfile";

export interface MoodFrame {
  /** Geometry features for this frame (always present). */
  geo: ExpressionSample;
  /** Trained-model blendshapes for the SAME frame, when the sub-graph populated. */
  blend?: BlendshapeScores | null;
  /** 0.35–1 frame-quality weight (see frameQuality in moodScoring.ts). Default 1. */
  quality?: number;
}

export interface MoodReading {
  /** Label to show / store. A genuinely ambiguous read falls back to Neutral. */
  mood: MoodLabel;
  /** Best guess before the ambiguity fallback (what ranked first). */
  rawMood: MoodLabel;
  probs: Record<MoodLabel, number>;
  /** 0.3–0.97 heuristic trust score (see header note 6). */
  confidence: number;
  margin: number;
  ambiguous: boolean;
  /** Top two are in the same family (e.g. Happy vs Loving). */
  familyTie: boolean;
  /** 0–1: weighted share of frames whose own best mood equals `mood`. */
  stability: number;
  method: "blendshape" | "geometry";
  /** Frames that actually fed the score (after blink filtering). */
  usableFrames: number;
  /** Frames dropped as blinks. */
  blinkFiltered: number;
  /** True when jaw movement looked like speech and was damped. */
  talking: boolean;
  /** For 👍 learning (blendshape path only). */
  learn: { features: Feat; baseline: Feat } | null;
  /** This session's own resting baseline, for the learned profile (blendshape path only). */
  restingBaseline: Feat | null;
}

export interface AnalyzeOptions {
  distrust: Record<string, number>;
  profile: MoodProfile | null;
  /** Fraction of the capture window that had a usable face (0–1). */
  faceCoverage: number;
}

const MOOD_KEYS: MoodLabel[] = ["Happy", "Loving", "Surprised", "Frustrated", "Sad", "Calm", "Neutral"];
const MIN_FRAMES = 3;
/** jawOpen std-dev across the window above which the mouth is treated as moving (talking). */
const TALKING_JAW_STD = 0.1;

const quantile = (v: number[], q: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : 0;
};

/** Soft-saturate one frame's evidence. The rule scores are hinge-shaped and can
 *  reach 20+ for a single extreme frame, which let ONE strong frame out of ~14
 *  outweigh the Neutral floor (2.0) after averaging. tanh keeps the ordering
 *  between moods (so Happy still beats Loving for a bigger smile) while capping
 *  any single frame's pull, so an expression has to be SUSTAINED — roughly a
 *  third of the window — to win. */
const EVIDENCE_SOFT_CAP = 9;
const saturate = (e: Record<MoodLabel, number>): Record<MoodLabel, number> => {
  const out = { ...e };
  for (const k of MOOD_KEYS) if (k !== "Neutral") out[k] = EVIDENCE_SOFT_CAP * Math.tanh(Math.max(0, e[k]) / EVIDENCE_SOFT_CAP);
  return out;
};
const std = (v: number[]) => {
  if (v.length < 2) return 0;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / v.length);
};

const emptyEvidence = (): Record<MoodLabel, number> => ({ Happy: 0, Loving: 0, Surprised: 0, Frustrated: 0, Sad: 0, Calm: 0, Neutral: 0 });

/** Recency (later frames count more: first ~1 s still carries "camera just turned on") × quality. */
const frameWeights = (frames: { quality?: number }[]): number[] =>
  frames.map((f, i) => (0.5 + i / Math.max(1, frames.length - 1)) * (f.quality ?? 1));

const argmax = (e: Record<MoodLabel, number>): MoodLabel =>
  MOOD_KEYS.reduce((best, k) => (e[k] > e[best] ? k : best), "Neutral" as MoodLabel);

/**
 * Confidence = how decisively the mood won (probability, margin), how
 * consistently the frames agreed (stability) and how much of the window had a
 * face, with explicit caps for ambiguity. Honest ceiling: still a heuristic.
 */
export const readingConfidence = (a: {
  mood: MoodLabel; topProb: number; margin: number; stability: number; faceCoverage: number;
  ambiguous: boolean; familyTie: boolean;
}): number => {
  const decisive = 0.5 * a.topProb + 0.3 * a.stability + 0.2 * Math.min(1, Math.max(0, a.margin) / 0.5);
  let c = 0.3 + 0.67 * decisive;
  c *= Math.min(1, a.faceCoverage + 0.3);
  if (a.familyTie) c *= 0.88;
  if (a.ambiguous) c = Math.min(c, 0.55);
  return Math.max(0.3, Math.min(0.97, c));
};

/** Score a session's frames. Returns null when there is too little usable signal. */
export const analyzeMoodFrames = (frames: MoodFrame[], opts: AnalyzeOptions): MoodReading | null => {
  if (frames.length < MIN_FRAMES) return null;
  const { distrust, profile } = opts;

  // Prefer the trained blendshape model when enough frames carry it; geometry
  // is the fallback, not a second vote (mixing would re-import its biases).
  const withBlend = frames.filter((f) => f.blend);
  const keptBlend = new Set(filterBlinksBlendshapes(withBlend.map((f) => f.blend as BlendshapeScores)));
  const blendFrames = withBlend.filter((f) => keptBlend.has(f.blend as BlendshapeScores));

  let perFrame: Record<MoodLabel, number>[];
  let used: MoodFrame[];
  let method: MoodReading["method"];
  let learn: MoodReading["learn"] = null;
  let restingBaseline: Feat | null = null;
  let talking = false;
  let blinkFiltered: number;

  if (blendFrames.length >= MIN_FRAMES) {
    method = "blendshape";
    used = blendFrames;
    blinkFiltered = withBlend.length - blendFrames.length;
    let pool = blendFrames.map((f) => f.blend as BlendshapeScores);

    const jaw = pool.map((b) => b.jawOpen ?? 0);
    if (std(jaw) > TALKING_JAW_STD) {
      talking = true;
      // Damp to the LOW quartile (the mouth's rest position between words), not
      // the median — with speech the median can land on the open-mouth value.
      const jm = quantile(jaw, 0.25);
      pool = pool.map((b) => ({ ...b, jawOpen: Math.min(b.jawOpen ?? 0, jm) }));
    }

    const sessionBase = blendshapeBaseline(pool);
    const base = mergeBaseline(sessionBase, profile);
    perFrame = pool.map((b) => personalizeEvidence(profile, scoreMoodsFromBlendshapes(b, distrust, base), b, base));
    learn = { features: weightedAvgBlendshapes(pool) as Feat, baseline: base };
    restingBaseline = sessionBase;
  } else {
    method = "geometry";
    const geo = filterBlinks(frames.map((f) => f.geo));
    const keptGeo = new Set(geo);
    used = frames.filter((f) => keptGeo.has(f.geo));
    blinkFiltered = frames.length - used.length;
    const baseline = sessionBaseline(geo);
    perFrame = used.map((f) => scoreMoods(f.geo, distrust, baseline));
  }

  // Quality × recency weighted mean of per-frame evidence.
  const w = frameWeights(used);
  const wSum = w.reduce((a, b) => a + b, 0) || 1;
  const evidence = emptyEvidence();
  const saturated = perFrame.map(saturate);
  saturated.forEach((e, i) => { for (const k of MOOD_KEYS) evidence[k] += e[k] * w[i]; });
  for (const k of MOOD_KEYS) evidence[k] /= wSum;

  const probs = softmaxScores(evidence);
  const ranked = topMoodWithMargin(probs);
  const mood: MoodLabel = ranked.ambiguous ? "Neutral" : ranked.mood;

  // Stability: weighted share of frames that individually agree with the result.
  let agree = 0;
  perFrame.forEach((e, i) => { if (argmax(e) === mood) agree += w[i]; });
  const stability = agree / wSum;

  const topProb = ranked.ambiguous ? probs.Neutral : ranked.topProb;
  const confidence = readingConfidence({
    mood, topProb, margin: ranked.margin, stability, faceCoverage: opts.faceCoverage,
    ambiguous: ranked.ambiguous, familyTie: ranked.familyTie,
  });

  return {
    mood, rawMood: ranked.mood, probs, confidence, margin: ranked.margin, ambiguous: ranked.ambiguous,
    familyTie: ranked.familyTie, stability, method, usableFrames: used.length, blinkFiltered, talking,
    learn, restingBaseline,
  };
};
