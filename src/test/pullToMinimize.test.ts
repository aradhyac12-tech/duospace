import { describe, it, expect } from "vitest";
import {
  DISMISS_COMMIT, DISMISS_VELOCITY, PULL_ENGAGE_PX,
  pullProgress, pullRange, releaseVelocity, shouldEngagePull, shouldMinimize, springVelocity,
} from "@/lib/music/pullToMinimize";

describe("pull-to-minimise maths", () => {
  it("range scales with the artwork's travel but stays within bounds", () => {
    expect(pullRange(100)).toBe(220);
    expect(pullRange(-500)).toBeCloseTo(310, 5);
    expect(pullRange(5000)).toBe(380);
  });

  it("progress is clamped to 0..1", () => {
    expect(pullProgress(-40, 300)).toBe(0);
    expect(pullProgress(150, 300)).toBeCloseTo(0.5, 5);
    expect(pullProgress(900, 300)).toBe(1);
  });

  it("only claims a touch that is at the top, clearly downward and mostly vertical", () => {
    expect(shouldEngagePull(0, PULL_ENGAGE_PX + 1, 0)).toBe(true);
    expect(shouldEngagePull(0, PULL_ENGAGE_PX, 0)).toBe(false);      // below slop
    expect(shouldEngagePull(0, 40, 12)).toBe(false);                  // not at the top: native scroll owns it
    expect(shouldEngagePull(60, 40, 0)).toBe(false);                  // horizontal: artwork track-swipe
    expect(shouldEngagePull(0, -40, 0)).toBe(false);                  // upward
  });

  it("commits on a long enough pull, or a quick flick, but not a short slow drag", () => {
    const range = 300;
    expect(shouldMinimize(range * DISMISS_COMMIT + 5, range, 0)).toBe(true);
    expect(shouldMinimize(range * DISMISS_COMMIT - 5, range, 0.1)).toBe(false);
    expect(shouldMinimize(40, range, DISMISS_VELOCITY + 0.2)).toBe(true);   // flick
    expect(shouldMinimize(10, range, DISMISS_VELOCITY + 0.2)).toBe(false);  // too small to be intentional
  });

  it("release velocity is px/ms over the sampled window, signed", () => {
    expect(releaseVelocity([])).toBe(0);
    expect(releaseVelocity([{ t: 0, y: 0 }])).toBe(0);
    expect(releaseVelocity([{ t: 0, y: 100 }, { t: 100, y: 150 }])).toBeCloseTo(0.5, 5);
    expect(releaseVelocity([{ t: 0, y: 150 }, { t: 50, y: 100 }])).toBeCloseTo(-1, 5);
    expect(releaseVelocity([{ t: 10, y: 0 }, { t: 10, y: 50 }])).toBe(0);
  });
});

describe("spring hand-off velocity", () => {
  it("converts px/ms to progress/second using the pull range", () => {
    expect(springVelocity(0.3, 300)).toBeCloseTo(1, 5);
    expect(springVelocity(-0.3, 300)).toBeCloseTo(-1, 5);
    expect(springVelocity(0, 300)).toBe(0);
  });

  it("clamps a runaway flick so the glide never gets flung", () => {
    expect(springVelocity(5, 220)).toBe(3);
    expect(springVelocity(-5, 220)).toBe(-3);
  });

  it("tolerates a zero range", () => {
    expect(Number.isFinite(springVelocity(0.5, 0))).toBe(true);
  });
});
