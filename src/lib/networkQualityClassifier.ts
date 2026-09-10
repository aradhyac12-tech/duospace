/**
 * networkQualityClassifier — turns raw WebRTC/Daily network stats into one
 * of five quality tiers, with hysteresis so a momentary blip doesn't
 * trigger a UI/media change and then immediately reverse it.
 *
 * WHY A SEPARATE TIER SYSTEM FROM DAILY'S OWN networkState
 * ----------------------------------------------------------
 * Daily's `network-quality-change` event (still driving the existing
 * degrade-to-audio-only logic in useDailyCall.ts, untouched by this file)
 * gives a 3-state assessment (good/warning/bad, or the deprecated
 * good/low/very-low) averaged over a ~30s rolling window — good for "is
 * this call in trouble", too coarse for "exactly how much should we back
 * off, and in which order" (per the brief: audio continuity > audio
 * quality > video continuity > resolution). This module classifies the
 * finer-grained fields getNetworkStats() already exposes (RTT, packet
 * loss, jitter, available bitrate) into 5 tiers and — critically — uses a
 * MUCH shorter window than Daily's 30s average, so a controller built on
 * top of it can react in a few seconds rather than tens of seconds.
 *
 * HYSTERESIS
 * ----------
 * Degrading is intentionally faster to trigger than recovering: a couple
 * of bad samples should back off video quickly (nobody minds a fast
 * downgrade), but recovery needs sustained good samples before upgrading
 * back (nobody wants video flickering on/off/on as the network hovers
 * near a threshold). NetworkQualityTracker enforces this with different
 * dwell requirements in each direction — see DEGRADE_STREAK/UPGRADE_STREAK.
 */

export type QualityTier = "excellent" | "good" | "fair" | "poor" | "critical";

export interface NetworkSample {
  /** Round-trip time, milliseconds. */
  rttMs: number | null;
  /** 0-100. Combines send+recv, audio+video — pass the worst of what you have if only some are available. */
  packetLossPct: number | null;
  /** Milliseconds. */
  jitterMs: number | null;
  /** bits per second, if known (available outgoing bandwidth estimate). */
  availableBitrateBps: number | null;
}

const TIER_ORDER: QualityTier[] = ["critical", "poor", "fair", "good", "excellent"];
const tierRank = (t: QualityTier) => TIER_ORDER.indexOf(t);

/**
 * Classify a single sample. Each metric independently maps to a tier;
 * the sample's overall tier is the WORST (lowest-ranked) of the four —
 * a call with great RTT but terrible packet loss is a bad call, not an
 * average one.
 */
export function classifySample(sample: NetworkSample): QualityTier {
  const tiers: QualityTier[] = [];

  if (sample.rttMs !== null) {
    if (sample.rttMs < 150) tiers.push("excellent");
    else if (sample.rttMs < 300) tiers.push("good");
    else if (sample.rttMs < 500) tiers.push("fair");
    else if (sample.rttMs < 800) tiers.push("poor");
    else tiers.push("critical");
  }

  if (sample.packetLossPct !== null) {
    if (sample.packetLossPct < 1) tiers.push("excellent");
    else if (sample.packetLossPct < 3) tiers.push("good");
    else if (sample.packetLossPct < 8) tiers.push("fair");
    else if (sample.packetLossPct < 15) tiers.push("poor");
    else tiers.push("critical");
  }

  if (sample.jitterMs !== null) {
    if (sample.jitterMs < 30) tiers.push("excellent");
    else if (sample.jitterMs < 60) tiers.push("good");
    else if (sample.jitterMs < 100) tiers.push("fair");
    else if (sample.jitterMs < 150) tiers.push("poor");
    else tiers.push("critical");
  }

  if (sample.availableBitrateBps !== null) {
    if (sample.availableBitrateBps > 800_000) tiers.push("excellent");
    else if (sample.availableBitrateBps > 400_000) tiers.push("good");
    else if (sample.availableBitrateBps > 150_000) tiers.push("fair");
    else if (sample.availableBitrateBps > 60_000) tiers.push("poor");
    else tiers.push("critical");
  }

  if (tiers.length === 0) return "good"; // no data yet — don't assume the worst before we know anything
  return tiers.reduce((worst, t) => (tierRank(t) < tierRank(worst) ? t : worst));
}

/** What a controller (e.g. useDailyCall) should do at each tier, per the
 *  brief's stated priority: audio continuity > audio quality > video
 *  continuity > video resolution. Deliberately conservative — this is
 *  guidance, not something that directly touches media tracks itself. */
export interface QualityRecommendation {
  tier: QualityTier;
  videoEnabled: boolean;
  /** Suggested cap; a controller with resolution control can use this, one without can ignore it. */
  maxVideoResolution: "high" | "medium" | "low" | null;
}

export function recommendationForTier(tier: QualityTier): QualityRecommendation {
  switch (tier) {
    case "excellent": return { tier, videoEnabled: true, maxVideoResolution: "high" };
    case "good":       return { tier, videoEnabled: true, maxVideoResolution: "high" };
    case "fair":       return { tier, videoEnabled: true, maxVideoResolution: "medium" };
    case "poor":       return { tier, videoEnabled: true, maxVideoResolution: "low" };
    case "critical":   return { tier, videoEnabled: false, maxVideoResolution: null };
  }
}

interface TrackerOptions {
  /** Consecutive samples at-or-below a worse tier before degrading. Small — degrade fast. */
  degradeStreak?: number;
  /** Consecutive samples at-or-above a better tier before upgrading. Large — recover slow. */
  upgradeStreak?: number;
}

/**
 * Stateful hysteresis wrapper. Feed it samples via `.sample()`; it only
 * reports a NEW stable tier once the streak requirement for that
 * direction is met, and returns null otherwise (no change to report).
 */
export class NetworkQualityTracker {
  private stableTier: QualityTier = "good"; // optimistic default before any data
  private candidateTier: QualityTier | null = null;
  private candidateStreak = 0;
  private readonly degradeStreak: number;
  private readonly upgradeStreak: number;

  constructor(options: TrackerOptions = {}) {
    this.degradeStreak = options.degradeStreak ?? 2; // ~4s at a 2s poll interval
    this.upgradeStreak = options.upgradeStreak ?? 8;  // ~16s at a 2s poll interval — deliberately 4x slower than degrade
  }

  get currentTier(): QualityTier {
    return this.stableTier;
  }

  /** Feed one sample. Returns the new stable tier if this sample caused a
   *  (hysteresis-confirmed) transition, or null if nothing changed yet. */
  sample(sample: NetworkSample): QualityTier | null {
    const observed = classifySample(sample);
    if (observed === this.stableTier) {
      this.candidateTier = null;
      this.candidateStreak = 0;
      return null;
    }

    if (observed !== this.candidateTier) {
      this.candidateTier = observed;
      this.candidateStreak = 1;
    } else {
      this.candidateStreak += 1;
    }

    const degrading = tierRank(observed) < tierRank(this.stableTier);
    const requiredStreak = degrading ? this.degradeStreak : this.upgradeStreak;

    if (this.candidateStreak >= requiredStreak) {
      this.stableTier = observed;
      this.candidateTier = null;
      this.candidateStreak = 0;
      return this.stableTier;
    }
    return null;
  }

  reset(initial: QualityTier = "good") {
    this.stableTier = initial;
    this.candidateTier = null;
    this.candidateStreak = 0;
  }
}
