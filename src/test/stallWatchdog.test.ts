import { describe, it, expect, vi } from "vitest";
import { createStallDetector, withTimeout, type StallSample } from "@/lib/music/stallWatchdog";

const base: StallSample = { trackId: "a", wantPlaying: true, hidden: false, grace: false, positionSeconds: 0 };

describe("stall detector", () => {
  it("flags a frozen position after the threshold, once", () => {
    const d = createStallDetector(3);
    expect(d.sample({ ...base, positionSeconds: 5 })).toBe(false); // first sample establishes position
    expect(d.sample({ ...base, positionSeconds: 5 })).toBe(false);
    expect(d.sample({ ...base, positionSeconds: 5 })).toBe(false);
    expect(d.sample({ ...base, positionSeconds: 5 })).toBe(true);
    expect(d.sample({ ...base, positionSeconds: 5 })).toBe(false); // re-armed, not flagged every tick
  });
  it("never flags a moving position", () => {
    const d = createStallDetector(2);
    for (let i = 0; i < 20; i++) expect(d.sample({ ...base, positionSeconds: i })).toBe(false);
  });
  it("never flags a deliberate pause, a backgrounded app, or a grace period", () => {
    const d = createStallDetector(2);
    for (let i = 0; i < 10; i++) expect(d.sample({ ...base, wantPlaying: false, positionSeconds: 3 })).toBe(false);
    for (let i = 0; i < 10; i++) expect(d.sample({ ...base, hidden: true, positionSeconds: 3 })).toBe(false);
    for (let i = 0; i < 10; i++) expect(d.sample({ ...base, grace: true, positionSeconds: 3 })).toBe(false);
  });
  it("resets when the track changes", () => {
    const d = createStallDetector(3);
    d.sample({ ...base, positionSeconds: 1 }); d.sample({ ...base, positionSeconds: 1 }); d.sample({ ...base, positionSeconds: 1 });
    expect(d.sample({ ...base, trackId: "b", positionSeconds: 1 })).toBe(false);
  });
  it("a pause in the middle of a stall clears the count", () => {
    const d = createStallDetector(3);
    d.sample({ ...base, positionSeconds: 1 }); d.sample({ ...base, positionSeconds: 1 });
    d.sample({ ...base, wantPlaying: false, positionSeconds: 1 });
    expect(d.sample({ ...base, positionSeconds: 1 })).toBe(false);
  });
});

describe("withTimeout", () => {
  it("rejects a never-settling promise", async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise(() => {}), 1000, "native load");
    const assertion = expect(p).rejects.toThrow("native load timed out");
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    vi.useRealTimers();
  });
  it("passes through resolve and reject unchanged", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "x")).resolves.toBe(7);
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000, "x")).rejects.toThrow("boom");
  });
});
