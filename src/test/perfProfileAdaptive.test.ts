import { describe, it, expect } from "vitest";
import { isJankyWindow, resolveEffectsMode } from "@/lib/perfProfile";

describe("perfProfile adaptive effects", () => {
  it("isJankyWindow needs a real sample and >20% slow frames", () => {
    expect(isJankyWindow(50, 50)).toBe(false);   // too few frames to judge
    expect(isJankyWindow(150, 20)).toBe(false);  // 13% slow — fine
    expect(isJankyWindow(150, 45)).toBe(true);   // 30% slow — laggy
  });
  it("auto stays full on a fast-looking device; explicit choices win", () => {
    const fast = { deviceMemory: 8, hardwareConcurrency: 8 };
    expect(resolveEffectsMode("auto", fast)).toBe("full");
    expect(resolveEffectsMode("lite", fast)).toBe("lite");
    expect(resolveEffectsMode("full", { deviceMemory: 2 })).toBe("full");
  });
});
