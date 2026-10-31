/**
 * Tests for src/lib/surpriseCapabilities.ts — device tier detection and
 * sequence shaping. detectHapticTier() caches its result per module
 * instance (deliberately — see its own comment), so each test here resets
 * modules and re-imports fresh rather than sharing one cached tier across
 * cases.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const setEnv = (native: boolean, vibrate: boolean) => {
  vi.doMock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => native } }));
  // test-only shape: real navigator.vibrate isn't in jsdom by default
  globalThis.navigator.vibrate = vibrate ? () => true : undefined;
};

beforeEach(() => {
  vi.resetModules();
  vi.unmock("@capacitor/core");
});

describe("detectHapticTier", () => {
  it("native + vibrate available → advanced", async () => {
    setEnv(true, true);
    const { detectHapticTier } = await import("@/lib/surpriseCapabilities");
    expect(detectHapticTier()).toBe("advanced");
  });

  it("native, no vibrate → standard (e.g. iOS)", async () => {
    setEnv(true, false);
    const { detectHapticTier } = await import("@/lib/surpriseCapabilities");
    expect(detectHapticTier()).toBe("standard");
  });

  it("not native, vibrate available → vibration (Android browser)", async () => {
    setEnv(false, true);
    const { detectHapticTier } = await import("@/lib/surpriseCapabilities");
    expect(detectHapticTier()).toBe("vibration");
  });

  it("neither → visual-only", async () => {
    setEnv(false, false);
    const { detectHapticTier } = await import("@/lib/surpriseCapabilities");
    expect(detectHapticTier()).toBe("visual-only");
  });

  it("caches the result — a capability change mid-session doesn't retroactively change tier", async () => {
    setEnv(true, true);
    const { detectHapticTier } = await import("@/lib/surpriseCapabilities");
    expect(detectHapticTier()).toBe("advanced");
    // test-only
    globalThis.navigator.vibrate = undefined;
    expect(detectHapticTier()).toBe("advanced"); // still cached, not re-derived
  });
});

describe("supportsCustomWaveform", () => {
  it("true only for advanced/vibration tiers", async () => {
    setEnv(true, true);
    const advanced = await import("@/lib/surpriseCapabilities");
    expect(advanced.supportsCustomWaveform()).toBe(true);

    vi.resetModules();
    setEnv(true, false);
    const standard = await import("@/lib/surpriseCapabilities");
    expect(standard.supportsCustomWaveform()).toBe(false);
  });
});

describe("playCapabilityAwareSequence", () => {
  it("returns a no-op stop function for an empty sequence without touching haptics", async () => {
    setEnv(false, false);
    const { playCapabilityAwareSequence } = await import("@/lib/surpriseCapabilities");
    const stop = playCapabilityAwareSequence([]);
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("on the 'standard' tier, collapses a long sequence to first+last beat only", async () => {
    setEnv(true, false); // native, no vibrate → standard
    const playHapticSequence = vi.fn(() => () => {});
    vi.doMock("@/lib/surpriseHaptics", () => ({ playHapticSequence }));
    const { playCapabilityAwareSequence } = await import("@/lib/surpriseCapabilities");

    const long = [
      { kind: "soft" as const, delayMs: 0 },
      { kind: "soft" as const, delayMs: 90 },
      { kind: "soft" as const, delayMs: 160 },
      { kind: "rigid" as const, delayMs: 300 },
    ];
    playCapabilityAwareSequence(long);
    expect(playHapticSequence).toHaveBeenCalledWith([long[0], long[3]]);
  });

  it("on the 'advanced' tier, plays the full sequence unshaped", async () => {
    setEnv(true, true); // advanced
    const playHapticSequence = vi.fn(() => () => {});
    vi.doMock("@/lib/surpriseHaptics", () => ({ playHapticSequence }));
    const { playCapabilityAwareSequence } = await import("@/lib/surpriseCapabilities");

    const long = [
      { kind: "soft" as const, delayMs: 0 },
      { kind: "soft" as const, delayMs: 90 },
      { kind: "rigid" as const, delayMs: 300 },
    ];
    playCapabilityAwareSequence(long);
    expect(playHapticSequence).toHaveBeenCalledWith(long);
  });
});
