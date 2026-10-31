/**
 * moodProfile — per-person mood "database" built ONLY from this person's own confirmed reads (pure logic).
 *
 * WHY (research, Oct 2026): the big public FER image sets (AffectNet, RAF-DB; FER2013 has no licence) are
 * non-commercial / unlicensed, and weights trained on them inherit that problem; DuoSpace has paid plans.
 * Population models also drop sharply on 8-class in-the-wild data (~60-65% AffectNet). So instead of shipping a
 * third-party dataset, each device learns the owner's own resting face + what THEIR confirmed moods look like,
 * entirely on-device, in blendshape space (MediaPipe, Apache-2.0 — already used here).
 *
 *  - baseline: EMA of per-session resting readings => stable across sessions/lighting (the old baseline was
 *    per-session only, so a short or expressive session skewed it).
 *  - prototypes: running mean of (features - baseline) for reads the user confirmed with 👍. Delta space is
 *    robust to camera angle. Used as a bounded nudge on the rule-based scores, never a replacement.
 *
 * No imports: persistence lives in moodProfileStore.ts so this file stays unit-testable.
 */
export type Feat = Record<string, number>;
export type MoodKey = string;

export interface Proto { n: number; mean: Feat }
export interface MoodProfile {
  v: 1;
  baseline: Feat;
  baselineN: number;
  protos: Record<MoodKey, Proto>;
  updatedAt: number;
}

/** Blendshapes scoreMoodsFromBlendshapes actually reads. */
export const FEATURE_KEYS = [
  "mouthSmileLeft", "mouthSmileRight", "cheekSquintLeft", "cheekSquintRight", "browInnerUp",
  "browOuterUpLeft", "browOuterUpRight", "browDownLeft", "browDownRight", "jawOpen", "mouthClose",
  "eyeWideLeft", "eyeWideRight", "mouthFrownLeft", "mouthFrownRight", "mouthPressLeft", "mouthPressRight",
] as const;

export const BASELINE_N_CAP = 30;       // older sessions fade: EMA floor alpha = 1/30
export const PROTO_N_CAP = 40;          // slow drift allowed
export const MIN_PROTO_SAMPLES = 3;     // no personalization before 3 confirmations of a mood
export const MAX_PERSONAL_WEIGHT = 0.4; // personalization can never dominate the rule scores
const SIM_SCALE = 0.12;                 // RMS delta distance at which similarity falls to ~e^-1

export const emptyProfile = (): MoodProfile => ({ v: 1, baseline: {}, baselineN: 0, protos: {}, updatedAt: 0 });

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const pick = (f: Feat): Feat => { const o: Feat = {}; for (const k of FEATURE_KEYS) o[k] = clamp01(f[k] ?? 0); return o; };

/** Blend this session's baseline with the learned resting baseline (profile weight grows with history, max 0.6). */
export const mergeBaseline = (session: Feat, profile: MoodProfile | null): Feat => {
  if (!profile || profile.baselineN < 2) return session;
  const wp = Math.min(0.6, 0.1 * profile.baselineN);
  const out: Feat = { ...session };
  for (const k of FEATURE_KEYS) out[k] = (1 - wp) * (session[k] ?? 0) + wp * (profile.baseline[k] ?? 0);
  return out;
};

/** Fold one session's resting baseline into the profile (EMA, alpha = max(1/(n+1), 1/30)). */
export const updateBaseline = (profile: MoodProfile, session: Feat, now = Date.now()): MoodProfile => {
  const s = pick(session);
  const n = profile.baselineN;
  const alpha = Math.max(1 / (n + 1), 1 / BASELINE_N_CAP);
  const baseline: Feat = {};
  for (const k of FEATURE_KEYS) baseline[k] = n === 0 ? s[k] : (1 - alpha) * (profile.baseline[k] ?? 0) + alpha * s[k];
  return { ...profile, baseline, baselineN: Math.min(n + 1, BASELINE_N_CAP), updatedAt: now };
};

const deltas = (features: Feat, baseline: Feat): Feat => {
  const d: Feat = {};
  for (const k of FEATURE_KEYS) d[k] = Math.max(0, clamp01(features[k] ?? 0) - clamp01(baseline[k] ?? 0));
  return d;
};

/** A read the user confirmed (👍): update that mood's prototype (running mean in delta space). */
export const learnConfirmed = (profile: MoodProfile, mood: MoodKey, features: Feat, baselineUsed: Feat, now = Date.now()): MoodProfile => {
  if (mood === "Neutral") return profile; // Neutral is a floor, not an expression to imitate
  const d = deltas(features, baselineUsed);
  const prev = profile.protos[mood];
  const n = Math.min((prev?.n ?? 0) + 1, PROTO_N_CAP);
  const mean: Feat = {};
  for (const k of FEATURE_KEYS) {
    const old = prev?.mean[k] ?? 0;
    mean[k] = prev ? old + (d[k] - old) / n : d[k];
  }
  return { ...profile, protos: { ...profile.protos, [mood]: { n, mean } }, updatedAt: now };
};

/** RMS distance between two delta vectors over FEATURE_KEYS. */
const dist = (a: Feat, b: Feat): number => {
  let s = 0;
  for (const k of FEATURE_KEYS) { const x = (a[k] ?? 0) - (b[k] ?? 0); s += x * x; }
  return Math.sqrt(s / FEATURE_KEYS.length);
};

/**
 * Nudge rule-based evidence toward moods this person has confirmed before.
 * score' = (1-w)*rule + w*(similarity * ref), w = MAX*(n-2)/10 clamped to [0, MAX]; Neutral untouched.
 * ref = strongest non-Neutral rule score (>= 2) so both terms share a scale.
 */
export const personalizeEvidence = <T extends Record<string, number>>(
  profile: MoodProfile | null, rule: T, features: Feat, baselineUsed: Feat,
): T => {
  if (!profile) return rule;
  const d = deltas(features, baselineUsed);
  let ref = 2;
  for (const [m, v] of Object.entries(rule)) if (m !== "Neutral" && v > ref) ref = v;
  const out = { ...rule } as Record<string, number>;
  for (const [mood, proto] of Object.entries(profile.protos)) {
    if (!(mood in rule) || mood === "Neutral" || proto.n < MIN_PROTO_SAMPLES) continue;
    const w = Math.min(MAX_PERSONAL_WEIGHT, Math.max(0, (MAX_PERSONAL_WEIGHT * (proto.n - 2)) / 10));
    const sim = Math.exp(-dist(d, proto.mean) / SIM_SCALE);
    out[mood] = (1 - w) * rule[mood] + w * sim * ref;
  }
  return out as T;
};
