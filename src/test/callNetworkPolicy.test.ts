import { describe, it, expect } from "vitest";
import { pickNetworkNotice, reconnectGraceMs, remoteVideoQualityFor, RECONNECT_GRACE_ONLINE_MS, RECONNECT_GRACE_OFFLINE_MS } from "@/lib/callEngine/callNetworkPolicy";

describe("reconnectGraceMs", () => {
  it("is patient (90s) when the device is offline, 30s when online", () => {
    expect(reconnectGraceMs(false)).toBe(RECONNECT_GRACE_OFFLINE_MS);
    expect(reconnectGraceMs(true)).toBe(RECONNECT_GRACE_ONLINE_MS);
    expect(RECONNECT_GRACE_OFFLINE_MS).toBeGreaterThan(RECONNECT_GRACE_ONLINE_MS);
  });
});

describe("pickNetworkNotice (most severe first)", () => {
  it("offline beats everything", () => {
    expect(pickNetworkNotice({ online: false, quality: "poor", remoteQuality: "poor" })).toBe("offline");
  });
  it("our lost link = reconnecting; our weak link = weak-you", () => {
    expect(pickNetworkNotice({ online: true, quality: "poor" })).toBe("reconnecting");
    expect(pickNetworkNotice({ online: true, quality: "fair" })).toBe("weak-you");
  });
  it("their weak link only matters when ours is fine", () => {
    expect(pickNetworkNotice({ online: true, quality: "good", remoteQuality: "poor" })).toBe("weak-them");
    expect(pickNetworkNotice({ online: true, quality: "excellent", remoteQuality: "fair" })).toBe("weak-them");
    expect(pickNetworkNotice({ online: true, quality: "fair", remoteQuality: "poor" })).toBe("weak-you");
  });
  it("no banner on a healthy call", () => {
    expect(pickNetworkNotice({ online: true, quality: "good", remoteQuality: "good" })).toBeNull();
    expect(pickNetworkNotice({ online: true, quality: "excellent" })).toBeNull();
  });
});

describe("pickNetworkNotice — signalling socket", () => {
  it("shows signal-down only when media and device are fine (lowest severity)", () => {
    expect(pickNetworkNotice({ online: true, quality: "good", remoteQuality: "good", signaling: "reconnecting" })).toBe("signal-down");
    expect(pickNetworkNotice({ online: true, quality: "good", signaling: "disconnected" })).toBe("signal-down");
  });
  it("every other notice outranks it", () => {
    expect(pickNetworkNotice({ online: false, quality: "good", signaling: "disconnected" })).toBe("offline");
    expect(pickNetworkNotice({ online: true, quality: "poor", signaling: "disconnected" })).toBe("reconnecting");
    expect(pickNetworkNotice({ online: true, quality: "fair", signaling: "disconnected" })).toBe("weak-you");
    expect(pickNetworkNotice({ online: true, quality: "good", remoteQuality: "fair", signaling: "disconnected" })).toBe("weak-them");
  });
  it("no notice when connected/connecting or when signalling is unused (undefined)", () => {
    expect(pickNetworkNotice({ online: true, quality: "good", signaling: "connected" })).toBeNull();
    expect(pickNetworkNotice({ online: true, quality: "good", signaling: "connecting" })).toBeNull();
    expect(pickNetworkNotice({ online: true, quality: "good" })).toBeNull();
  });
});

describe("remoteVideoQualityFor", () => {
  it("asks for the low layer on a weak link, high otherwise", () => {
    expect(remoteVideoQualityFor("fair")).toBe("low");
    expect(remoteVideoQualityFor("poor")).toBe("low");
    expect(remoteVideoQualityFor("good")).toBe("high");
    expect(remoteVideoQualityFor("excellent")).toBe("high");
  });
});

import { vi, beforeEach, afterEach } from "vitest";
import {
  normalizeConnectionKind, connectionNoun, captureProfileForTier, captureTierFor, createAdaptiveCapture,
  pickMaxFps, maxBitrateFor, powerLimitFor, samePowerLimit, LONG_CALL_UNPLUGGED_MS,
} from "@/lib/callEngine/callNetworkPolicy";

describe("connection kind", () => {
  it("normalises Capacitor / web types", () => {
    expect(normalizeConnectionKind("wifi")).toBe("wifi");
    expect(normalizeConnectionKind("ethernet")).toBe("wifi");
    expect(normalizeConnectionKind("cellular")).toBe("cellular");
    expect(normalizeConnectionKind("bluetooth")).toBe("unknown");
    expect(normalizeConnectionKind(undefined)).toBe("unknown");
    expect(normalizeConnectionKind("wifi", false)).toBe("none");
  });
  it("labels", () => {
    expect(connectionNoun("wifi")).toBe("Wi-Fi");
    expect(connectionNoun("cellular")).toBe("mobile data");
    expect(connectionNoun("unknown")).toBe("connection");
    expect(connectionNoun(undefined)).toBe("connection");
  });
});

describe("capture profiles", () => {
  it("maps quality to tier and swaps dimensions in portrait", () => {
    expect(captureTierFor("excellent")).toBe("full");
    expect(captureTierFor("good")).toBe("full");
    expect(captureTierFor("fair")).toBe("reduced");
    expect(captureTierFor("poor")).toBe("minimal");
    expect(captureProfileForTier("reduced", false)).toEqual({ tier: "reduced", width: 640, height: 360, frameRate: 20 });
    expect(captureProfileForTier("reduced", true)).toEqual({ tier: "reduced", width: 360, height: 640, frameRate: 20 });
  });
});

describe("top tier: up to 1080p at 90/60 fps by device", () => {
  it("picks 90 / 60 / 30 from the device's reported max (60 when unknown)", () => {
    expect(pickMaxFps({ maxFps: 120 })).toBe(90);
    expect(pickMaxFps({ maxFps: 90 })).toBe(90);
    expect(pickMaxFps({ maxFps: 60 })).toBe(60);
    expect(pickMaxFps({ maxFps: 30 })).toBe(30);
    expect(pickMaxFps({ maxFps: 24 })).toBe(30);
    expect(pickMaxFps()).toBe(60);
    expect(pickMaxFps({ maxFps: NaN })).toBe(60);
  });
  it("full = 1080p landscape / 1080x1920 portrait, clamped to what the camera can do", () => {
    expect(captureProfileForTier("full", false)).toEqual({ tier: "full", width: 1920, height: 1080, frameRate: 60 });
    expect(captureProfileForTier("full", true)).toEqual({ tier: "full", width: 1080, height: 1920, frameRate: 60 });
    expect(captureProfileForTier("full", false, { maxWidth: 4000, maxHeight: 3000, maxFps: 120 }))
      .toEqual({ tier: "full", width: 1920, height: 1080, frameRate: 90 });
    // 720p-only webcam, 30fps
    expect(captureProfileForTier("full", false, { maxWidth: 1280, maxHeight: 720, maxFps: 30 }))
      .toEqual({ tier: "full", width: 1280, height: 720, frameRate: 30 });
    // capability reported in sensor orientation (portrait-ish) still clamps the long/short sides correctly
    expect(captureProfileForTier("full", true, { maxWidth: 720, maxHeight: 1280, maxFps: 60 }))
      .toEqual({ tier: "full", width: 720, height: 1280, frameRate: 60 });
  });
  it("encoder ceiling scales with pixels x fps within 0.3-8 Mbps", () => {
    expect(maxBitrateFor({ width: 1920, height: 1080, frameRate: 30 })).toBe(3_110_400);
    expect(maxBitrateFor({ width: 1920, height: 1080, frameRate: 60 })).toBe(6_220_800);
    expect(maxBitrateFor({ width: 1920, height: 1080, frameRate: 90 })).toBe(8_000_000);
    expect(maxBitrateFor({ width: 320, height: 180, frameRate: 15 })).toBe(300_000);
  });
});

describe("createAdaptiveCapture (down immediately, up after a stable stretch)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("steps down at once and only on change", () => {
    const apply = vi.fn();
    const c = createAdaptiveCapture({ apply });
    c.onQuality("good");
    expect(apply).not.toHaveBeenCalled();
    c.onQuality("fair");
    c.onQuality("fair");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith("reduced");
    c.onQuality("poor");
    expect(apply).toHaveBeenLastCalledWith("minimal");
  });
  it("steps back up only after the link has stayed better for upDelayMs", () => {
    const apply = vi.fn();
    const c = createAdaptiveCapture({ apply, upDelayMs: 10_000 });
    c.onQuality("poor");
    c.onQuality("good");
    vi.advanceTimersByTime(9_999);
    expect(c.current()).toBe("minimal");
    vi.advanceTimersByTime(1);
    expect(c.current()).toBe("full");
    expect(apply).toHaveBeenLastCalledWith("full");
  });
  it("a dip during the wait cancels the step up", () => {
    const apply = vi.fn();
    const c = createAdaptiveCapture({ apply, upDelayMs: 10_000 });
    c.onQuality("fair");
    c.onQuality("good");
    vi.advanceTimersByTime(6_000);
    c.onQuality("fair");
    vi.advanceTimersByTime(20_000);
    expect(c.current()).toBe("reduced");
    expect(apply).toHaveBeenCalledTimes(1);
  });
  it("reapply() re-sends the current tier; cancel() forgets timers and resets", () => {
    const apply = vi.fn();
    const c = createAdaptiveCapture({ apply });
    c.onQuality("fair");
    c.reapply();
    expect(apply).toHaveBeenCalledTimes(2);
    c.onQuality("good");
    c.cancel();
    vi.advanceTimersByTime(60_000);
    expect(c.current()).toBe("full");
    expect(apply).toHaveBeenCalledTimes(2);
  });
});

describe("power / long-call cap on the top tier", () => {
  it("no cap while charging, whatever the level or call length", () => {
    expect(powerLimitFor({ level: 5, charging: true }, 99 * 60_000)).toBeNull();
  });
  it("healthy battery, short call: no cap; unknown battery: no battery cap", () => {
    expect(powerLimitFor({ level: 80, charging: false }, 60_000)).toBeNull();
    expect(powerLimitFor({ level: null, charging: null }, 60_000)).toBeNull();
  });
  it("<=30% unplugged: 30fps; <=15%: 720p30", () => {
    expect(powerLimitFor({ level: 30, charging: false }, 0)).toEqual({ maxFps: 30, reason: "battery-saver" });
    expect(powerLimitFor({ level: 15, charging: null }, 0)).toEqual({ maxFps: 30, maxShortSide: 720, reason: "low-battery" });
  });
  it("20 min unplugged on a call: 30fps even with plenty of battery", () => {
    expect(powerLimitFor({ level: 90, charging: false }, LONG_CALL_UNPLUGGED_MS - 1)).toBeNull();
    expect(powerLimitFor({ level: 90, charging: false }, LONG_CALL_UNPLUGGED_MS)).toEqual({ maxFps: 30, reason: "long-call" });
  });
  it("limits shape only the top tier's profile", () => {
    const caps = { maxWidth: 4000, maxHeight: 3000, maxFps: 120 };
    expect(captureProfileForTier("full", false, caps, { maxFps: 30, reason: "battery-saver" }))
      .toEqual({ tier: "full", width: 1920, height: 1080, frameRate: 30 });
    expect(captureProfileForTier("full", false, caps, { maxFps: 30, maxShortSide: 720, reason: "low-battery" }))
      .toEqual({ tier: "full", width: 1280, height: 720, frameRate: 30 });
    expect(captureProfileForTier("full", true, caps, { maxFps: 30, maxShortSide: 720, reason: "low-battery" }))
      .toEqual({ tier: "full", width: 720, height: 1280, frameRate: 30 });
    expect(captureProfileForTier("reduced", false, caps, { maxFps: 15, reason: "low-battery" }))
      .toEqual({ tier: "reduced", width: 640, height: 360, frameRate: 20 });
  });
  it("samePowerLimit compares by reason", () => {
    expect(samePowerLimit(null, null)).toBe(true);
    expect(samePowerLimit({ maxFps: 30, reason: "long-call" }, { maxFps: 30, reason: "long-call" })).toBe(true);
    expect(samePowerLimit(null, { maxFps: 30, reason: "long-call" })).toBe(false);
  });
});
