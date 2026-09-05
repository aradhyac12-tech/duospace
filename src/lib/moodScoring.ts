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

export const scoreMoods = (
  f: { mouthCurve: number; mouthOpen: number; browRaise: number; eyeOpenness: number },
  distrust: Record<string, number>,
): Record<MoodLabel, number> => {
  const need = (mood: string, base: number) => base * (distrust[mood] ?? 1);
  // Thresholds are tuned for face-span-normalized features (see extractExpression).
  // The normalization makes these thresholds more stable across different
  // face sizes, distances from camera, and frame resolutions.
  return {
    Happy:      Math.max(0, f.mouthCurve - need("Happy", 0.012)) * 35
              + Math.max(0, f.mouthOpen  - need("Happy", 0.025)) * 18,
    Loving:     Math.max(0, f.mouthCurve - need("Loving", 0.008)) * 25
              + Math.max(0, 0.025 - f.mouthOpen) * 8,
    Surprised:  Math.max(0, f.browRaise  - need("Surprised", 0.15)) * 20
              + Math.max(0, f.mouthOpen  - need("Surprised", 0.04)) * 22,
    Frustrated: Math.max(0, -f.mouthCurve - need("Frustrated", 0.005)) * 28
              + Math.max(0, 0.12 - f.browRaise) * 16,
    Sad:        Math.max(0, -f.mouthCurve - need("Sad", 0.003)) * 22
              + Math.max(0, 0.18 - f.eyeOpenness) * 14,
    Calm:       Math.max(0, f.eyeOpenness - 0.16) * 10
              + Math.max(0, 0.015 - Math.abs(f.mouthCurve)) * 12,
    // Flat floor, not a feature-derived score — wins only when nothing
    // else clears its own threshold, same role the old `else` branch played.
    Neutral: 2.0,
  };
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
export const MOOD_MIN_FACE_AREA = 0.025;   // face smaller than ~16%x16% of frame: too far to trust sub-pixel deltas
export const MOOD_MAX_YAW = 0.1;           // beyond this, foreshortening skews mouthCurve/browRaise geometry
export const MOOD_MAX_PITCH = 0.1;
export const MOOD_MIN_LAPLACIAN_VAR = 8;   // below this, motion/focus blur swamps the fine landmark deltas
export const MOOD_MIN_LUMA = 45;           // dimmer than this, landmark noise floor exceeds the signal we're measuring

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
