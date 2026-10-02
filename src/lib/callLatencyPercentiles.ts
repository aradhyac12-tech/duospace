/**
 * callLatencyPercentiles — P50/P75/P90/P95 helper (migration brief STEP
 * 11: "Create percentile metrics").
 *
 * Percentiles are inherently a many-calls aggregate, not a single-device
 * concern — callLatency.ts's finishTrace() logs one call's metrics via
 * logInfo (telemetry.ts); it doesn't collect a fleet-wide sample. This
 * file is the pure-math piece an aggregation layer (a log sink /
 * warehouse query / future analytics edge function) would call once it
 * has a batch of totalSetupLatencyMs / acceptToAudioLatencyMs values
 * across many calls. No such aggregation pipeline exists yet — this is
 * scaffolding, not a wired dashboard.
 */

export interface LatencyPercentiles {
  p50: number | null;
  p75: number | null;
  p90: number | null;
  p95: number | null;
  sampleSize: number;
}

/** Nearest-rank percentile over a batch of millisecond values. Returns
 *  all-null with sampleSize 0 for an empty input rather than throwing —
 *  callers aggregating real (possibly sparse) telemetry shouldn't need
 *  their own empty-batch special case. */
export function computeLatencyPercentiles(valuesMs: number[]): LatencyPercentiles {
  const clean = valuesMs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) {
    return { p50: null, p75: null, p90: null, p95: null, sampleSize: 0 };
  }
  const at = (p: number) => {
    const idx = Math.min(clean.length - 1, Math.ceil((p / 100) * clean.length) - 1);
    return clean[Math.max(0, idx)];
  };
  return { p50: at(50), p75: at(75), p90: at(90), p95: at(95), sampleSize: clean.length };
}
