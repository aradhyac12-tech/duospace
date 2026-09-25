import { describe, it, expect } from "vitest";
import { computeDrift, HARD_DRIFT_SECONDS, SOFT_DRIFT_SECONDS } from "@/lib/music/driftCorrection";

describe("computeDrift", () => {
  it("does nothing when perfectly in sync", () => {
    const now = 10_000;
    const decision = computeDrift(/* hostPosition */ 30, /* hostTs */ now, /* now */ now, /* localPos */ 30, true);
    expect(decision.action).toBe("none");
    expect(decision.drift).toBe(0);
  });

  it("accounts for network lag when computing expected position", () => {
    const hostTs = 10_000;
    const now = 12_000; // 2s of lag between broadcast and receipt
    const decision = computeDrift(30, hostTs, now, 30, true);
    // expectedPosition = hostPosition + networkLag = 30 + 2 = 32
    expect(decision.expectedPosition).toBe(32);
    expect(decision.drift).toBe(2); // local (30) is 2s behind expected (32)
  });

  it("small drift under the soft threshold: no action", () => {
    const now = 10_000;
    const decision = computeDrift(30, now, now, 30.2, true); // 0.2s drift
    expect(decision.action).toBe("none");
  });

  it("drift just over the soft threshold, under hard: nudges (rate-nudge-capable player)", () => {
    const now = 10_000;
    const decision = computeDrift(30 + SOFT_DRIFT_SECONDS + 0.1, now, now, 30, true);
    expect(decision.action).toBe("nudge-fast"); // local is behind -> speed up
  });

  it("local ahead of expected, in soft range: nudges slow", () => {
    const now = 10_000;
    const decision = computeDrift(30 - SOFT_DRIFT_SECONDS - 0.1, now, now, 30, true);
    expect(decision.action).toBe("nudge-slow");
  });

  it("drift over the hard threshold: hard seek, regardless of nudge support", () => {
    const now = 10_000;
    const decision = computeDrift(30 + HARD_DRIFT_SECONDS + 1, now, now, 30, true);
    expect(decision.action).toBe("seek");
  });

  it("native engine (no rate-nudge support): soft drift is treated as close enough, never nudges", () => {
    const now = 10_000;
    const decision = computeDrift(30 + SOFT_DRIFT_SECONDS + 0.1, now, now, 30, /* supportsRateNudge */ false);
    expect(decision.action).toBe("none");
  });

  it("native engine still hard-seeks on large drift even without nudge support", () => {
    const now = 10_000;
    const decision = computeDrift(30 + HARD_DRIFT_SECONDS + 1, now, now, 30, false);
    expect(decision.action).toBe("seek");
  });

  it("never reports negative network lag even with a clock skew edge case", () => {
    const now = 10_000;
    const hostTs = 11_000; // host timestamp "in the future" relative to `now` — clock skew
    const decision = computeDrift(30, hostTs, now, 30, true);
    expect(decision.expectedPosition).toBe(30); // lag clamped to 0, not negative
  });
});
