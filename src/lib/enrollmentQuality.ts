/**
 * enrollmentQuality — post-capture clean-up and scoring of enrollment samples.
 *
 * A single bad frame in the template (another person walking into view for a
 * moment, a half-closed blink, a smeared turn) quietly raises the false-accept
 * rate and drags the personalised threshold down for the life of the profile.
 * Phones guard against that by validating the captured set as a whole; this
 * does the same: drop clear outliers, then report an honest quality grade.
 *
 * Pure (no DOM / storage) so it is unit-testable.
 */

export interface QSample { embedding: Float32Array; step?: string }

const cos = (a: Float32Array, b: Float32Array): number => {
  const n = Math.min(a.length, b.length);
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < n; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  const den = Math.sqrt(x) * Math.sqrt(y);
  return den === 0 ? 0 : d / den;
};
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type QualityGrade = "excellent" | "good" | "fair" | "poor";

export interface QualityReport<T extends QSample> {
  kept: T[];
  dropped: number;
  /** 0..1 — mean pairwise similarity after pruning, rescaled. */
  score: number;
  grade: QualityGrade;
}

/**
 * Drops samples that don't look like the rest of the set. Each sample's
 * "consistency" is its mean similarity to its K nearest siblings; anything more
 * than 3 robust deviations (MAD) below the median consistency is an outlier.
 * Never prunes below `minKeep`, and never prunes a step down to nothing —
 * losing a whole pose would hurt more than one noisy sample.
 */
export function pruneOutliers<T extends QSample>(samples: T[], minKeep = 12, k = 5): QualityReport<T> {
  if (samples.length < 6) return { kept: samples, dropped: 0, score: 0.5, grade: "fair" };
  const consistency = samples.map((s, i) => {
    const sims: number[] = [];
    samples.forEach((o, j) => { if (j !== i) sims.push(cos(s.embedding, o.embedding)); });
    sims.sort((a, b) => b - a);
    const top = sims.slice(0, Math.min(k, sims.length));
    return top.reduce((a, b) => a + b, 0) / top.length;
  });
  const med = median(consistency);
  const mad = median(consistency.map((c) => Math.abs(c - med))) || 0.004;
  const cutoff = med - 3 * 1.4826 * mad;

  const order = consistency.map((c, i) => ({ c, i })).sort((a, b) => a.c - b.c); // worst first
  const drop = new Set<number>();
  const perStep = new Map<string, number>();
  samples.forEach((s) => perStep.set(s.step ?? "", (perStep.get(s.step ?? "") ?? 0) + 1));
  for (const { c, i } of order) {
    if (c >= cutoff) break;
    const step = samples[i].step ?? "";
    if (samples.length - drop.size <= minKeep) break;
    if ((perStep.get(step) ?? 0) <= 1) continue; // keep at least one sample per pose
    drop.add(i);
    perStep.set(step, (perStep.get(step) ?? 0) - 1);
  }
  const kept = samples.filter((_, i) => !drop.has(i));
  const keptCons = consistency.filter((_, i) => !drop.has(i));
  const mean = keptCons.reduce((a, b) => a + b, 0) / keptCons.length;
  // Landmark embeddings of one person cluster tightly; ~0.97+ is excellent.
  const score = Math.max(0, Math.min(1, (mean - 0.9) / 0.09));
  const grade: QualityGrade = score > 0.75 ? "excellent" : score > 0.5 ? "good" : score > 0.25 ? "fair" : "poor";
  return { kept, dropped: drop.size, score, grade };
}
