import { describe, it, expect } from "vitest";
import { classifySample, recommendationForTier, NetworkQualityTracker, type NetworkSample } from "@/lib/networkQualityClassifier";

const sample = (overrides: Partial<NetworkSample>): NetworkSample => ({
  rttMs: null, packetLossPct: null, jitterMs: null, availableBitrateBps: null, ...overrides,
});

describe("classifySample", () => {
  it("classifies a clean connection as excellent", () => {
    expect(classifySample(sample({ rttMs: 40, packetLossPct: 0, jitterMs: 10, availableBitrateBps: 2_000_000 }))).toBe("excellent");
  });

  it("takes the WORST metric, not an average", () => {
    // Great RTT/jitter/bitrate but terrible packet loss — should read as critical, not "mostly fine".
    expect(classifySample(sample({ rttMs: 40, packetLossPct: 20, jitterMs: 10, availableBitrateBps: 2_000_000 }))).toBe("critical");
  });

  it("treats a total absence of data as 'good', not 'critical'", () => {
    // Early in a call, before any WebRTC stats have accumulated — shouldn't
    // read as a network problem before there's any evidence of one.
    expect(classifySample(sample({}))).toBe("good");
  });

  it("classifies high packet loss alone as poor/critical", () => {
    expect(classifySample(sample({ packetLossPct: 12 }))).toBe("poor");
    expect(classifySample(sample({ packetLossPct: 25 }))).toBe("critical");
  });
});

describe("recommendationForTier", () => {
  it("only disables video at critical — audio-continuity priority", () => {
    expect(recommendationForTier("poor").videoEnabled).toBe(true);
    expect(recommendationForTier("critical").videoEnabled).toBe(false);
  });

  it("caps resolution progressively as tier worsens", () => {
    expect(recommendationForTier("excellent").maxVideoResolution).toBe("high");
    expect(recommendationForTier("fair").maxVideoResolution).toBe("medium");
    expect(recommendationForTier("poor").maxVideoResolution).toBe("low");
  });
});

describe("NetworkQualityTracker hysteresis", () => {
  it("does not report a change on a single bad sample (debounced)", () => {
    const tracker = new NetworkQualityTracker({ degradeStreak: 2, upgradeStreak: 8 });
    expect(tracker.currentTier).toBe("good");
    const result = tracker.sample(sample({ packetLossPct: 20 })); // -> critical, but only 1 sample
    expect(result).toBeNull();
    expect(tracker.currentTier).toBe("good");
  });

  it("degrades after the configured streak of consecutive bad samples", () => {
    const tracker = new NetworkQualityTracker({ degradeStreak: 3, upgradeStreak: 8 });
    tracker.sample(sample({ packetLossPct: 20 }));
    tracker.sample(sample({ packetLossPct: 20 }));
    const result = tracker.sample(sample({ packetLossPct: 20 })); // 3rd consecutive
    expect(result).toBe("critical");
    expect(tracker.currentTier).toBe("critical");
  });

  it("resets the streak if a bad run is interrupted by a good sample", () => {
    const tracker = new NetworkQualityTracker({ degradeStreak: 3, upgradeStreak: 8 });
    tracker.sample(sample({ packetLossPct: 20 }));
    tracker.sample(sample({ packetLossPct: 20 }));
    tracker.sample(sample({ rttMs: 40, packetLossPct: 0 })); // interrupts the streak
    const result = tracker.sample(sample({ packetLossPct: 20 })); // back to 1
    expect(result).toBeNull();
    expect(tracker.currentTier).toBe("good");
  });

  it("requires a much longer streak to recover than to degrade (asymmetric hysteresis)", () => {
    const tracker = new NetworkQualityTracker({ degradeStreak: 2, upgradeStreak: 6 });
    tracker.sample(sample({ packetLossPct: 20 }));
    const degraded = tracker.sample(sample({ packetLossPct: 20 }));
    expect(degraded).toBe("critical");

    // Network recovers — but should NOT flip back after just 1-2 good samples.
    tracker.sample(sample({ rttMs: 40, packetLossPct: 0, jitterMs: 10 }));
    const tooSoon = tracker.sample(sample({ rttMs: 40, packetLossPct: 0, jitterMs: 10 }));
    expect(tooSoon).toBeNull();
    expect(tracker.currentTier).toBe("critical"); // still critical — hasn't flapped back yet

    // ...but does recover once the streak requirement is actually met.
    tracker.sample(sample({ rttMs: 40, packetLossPct: 0, jitterMs: 10 }));
    tracker.sample(sample({ rttMs: 40, packetLossPct: 0, jitterMs: 10 }));
    const recovered = tracker.sample(sample({ rttMs: 40, packetLossPct: 0, jitterMs: 10 }));
    expect(recovered).toBe("excellent");
  });

  it("never reports a no-op transition back to the same stable tier", () => {
    const tracker = new NetworkQualityTracker();
    tracker.reset("fair");
    const result = tracker.sample(sample({ rttMs: 350 })); // still fair
    expect(result).toBeNull();
  });
});
