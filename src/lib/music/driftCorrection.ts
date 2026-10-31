/**
 * Pure drift-correction math for shared listening — extracted out of
 * GroicContext's onGuestEvent("tick", ...) handler so the actual
 * decision logic (hard seek vs. soft playback-rate nudge vs. do nothing)
 * is unit-testable without a Supabase Realtime channel or a real player.
 *
 * expectedPosition = hostPosition + (now - hostTimestamp)
 * — accounts for the time the broadcast itself took to arrive, so a
 * guest on a slower connection doesn't perpetually look "behind" purely
 * from network latency rather than an actual playback discrepancy.
 */

export type DriftAction = "seek" | "nudge-fast" | "nudge-slow" | "none";

export interface DriftDecision {
  expectedPosition: number;
  drift: number; // expectedPosition - localPosition, seconds (positive = local is behind)
  action: DriftAction;
}

/** Seconds — see docs/MUSIC_NATIVE_PLAYBACK.md's shared-listening section
 *  for why these specific values. Exported so tests exercise the exact
 *  thresholds actually used in GroicContext, not a re-typed copy of them. */
export const HARD_DRIFT_SECONDS = 1.0;
export const SOFT_DRIFT_SECONDS = 0.3;

export function computeDrift(
  hostPosition: number,
  hostTimestampMs: number,
  nowMs: number,
  localPosition: number,
  /** The native engine has no playback-rate nudge exposed — only a hard
   *  seek is available for it, so soft drift is treated as "close enough,
   *  do nothing" instead of the YouTube-only nudge behavior. */
  supportsRateNudge: boolean,
): DriftDecision {
  const networkLag = Math.max(0, (nowMs - hostTimestampMs) / 1000);
  const expectedPosition = hostPosition + networkLag;
  const drift = expectedPosition - localPosition;
  const absDrift = Math.abs(drift);

  let action: DriftAction = "none";
  if (absDrift > HARD_DRIFT_SECONDS) {
    action = "seek";
  } else if (supportsRateNudge && absDrift > SOFT_DRIFT_SECONDS) {
    action = drift > 0 ? "nudge-fast" : "nudge-slow";
  }

  return { expectedPosition, drift, action };
}

export interface OffsetSample { offsetMs: number; rttMs: number }

/** NTP-style: t0 = my send time, t1 = peer clock when it replied, t2 = my
 *  receive time. Returns (peerClock - myClock) assuming symmetric latency. */
export function estimateClockOffset(t0: number, t1: number, t2: number): OffsetSample {
  return { offsetMs: t1 - (t0 + t2) / 2, rttMs: Math.max(0, t2 - t0) };
}

/** The lowest-RTT sample is the least distorted by asymmetric latency. */
export function pickBestOffset(samples: OffsetSample[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((a, b) => (b.rttMs < a.rttMs ? b : a)).offsetMs;
}
