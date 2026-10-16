import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createAudioFirstFallback, mapConnectionQuality } from "@/lib/callEngine/audioFirstFallback";

describe("mapConnectionQuality", () => {
  it("maps LiveKit levels to ours", () => {
    expect(mapConnectionQuality("excellent")).toBe("excellent");
    expect(mapConnectionQuality("good")).toBe("good");
    expect(mapConnectionQuality("poor")).toBe("fair");
    expect(mapConnectionQuality("lost")).toBe("poor");
  });
  it("treats unknown as good (no false alarms)", () => {
    expect(mapConnectionQuality("unknown")).toBe("good");
    expect(mapConnectionQuality("")).toBe("good");
  });
});

describe("createAudioFirstFallback", () => {
  let cameraOn: boolean;
  const pause = vi.fn();
  const resume = vi.fn();
  const make = () => createAudioFirstFallback({ isCameraOn: () => cameraOn, pause: () => { cameraOn = false; pause(); }, resume: () => { cameraOn = true; resume(); } });

  beforeEach(() => { vi.useFakeTimers(); cameraOn = true; pause.mockClear(); resume.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it("pauses the camera after 8s of a lost link", () => {
    const f = make();
    f.onQuality("poor");
    vi.advanceTimersByTime(7999);
    expect(pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(f.isAutoPaused()).toBe(true);
  });

  it("does not pause if the link recovers in time", () => {
    const f = make();
    f.onQuality("poor");
    vi.advanceTimersByTime(5000);
    f.onQuality("good");
    vi.advanceTimersByTime(20000);
    expect(pause).not.toHaveBeenCalled();
  });

  it("fair alone never pauses", () => {
    const f = make();
    f.onQuality("fair");
    vi.advanceTimersByTime(60000);
    expect(pause).not.toHaveBeenCalled();
  });

  it("does nothing when the camera is already off", () => {
    cameraOn = false;
    const f = make();
    f.onQuality("poor");
    vi.advanceTimersByTime(20000);
    expect(pause).not.toHaveBeenCalled();
  });

  it("resumes after 10s of a decent link, but not if it dips again", () => {
    const f = make();
    f.onQuality("poor");
    vi.advanceTimersByTime(8000);
    expect(pause).toHaveBeenCalled();
    f.onQuality("good");
    vi.advanceTimersByTime(6000);
    f.onQuality("fair"); // dip cancels the pending resume
    vi.advanceTimersByTime(20000);
    expect(resume).not.toHaveBeenCalled();
    f.onQuality("excellent");
    vi.advanceTimersByTime(10000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(f.isAutoPaused()).toBe(false);
  });

  it("cancel() (manual toggle / call end) forgets the auto-pause and stops timers", () => {
    const f = make();
    f.onQuality("poor");
    vi.advanceTimersByTime(8000);
    f.onQuality("good");
    f.cancel();
    vi.advanceTimersByTime(30000);
    expect(resume).not.toHaveBeenCalled();
    expect(f.isAutoPaused()).toBe(false);
  });
});
