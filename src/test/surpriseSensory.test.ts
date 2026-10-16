/**
 * Tests for src/lib/surpriseSensory.ts — Sensory Director overrides applied
 * on top of deterministic Haptic DNA.
 */
import { describe, it, expect } from "vitest";
import { applySensoryOverride, sensory3dScale } from "@/lib/surpriseSensory";
import type { HapticDNA } from "@/lib/surpriseHapticDNA";

const baseDNA: HapticDNA = {
  mood: "romantic", texture: "soft", resolution: "light",
  rhythm: "heartbeat", intensity: 45, anticipation: 50, climax: 80,
};

describe("applySensoryOverride", () => {
  it("returns the DNA unchanged when there's no settings object (Auto)", () => {
    expect(applySensoryOverride(baseDNA, undefined)).toEqual(baseDNA);
    expect(applySensoryOverride(baseDNA, null)).toEqual(baseDNA);
  });

  it("leaves every field Auto when the settings object is empty", () => {
    expect(applySensoryOverride(baseDNA, {})).toEqual(baseDNA);
  });

  it("overrides only the fields actually set, leaving the rest at their Auto/DNA value", () => {
    const result = applySensoryOverride(baseDNA, { climax: 95 });
    expect(result.climax).toBe(95);
    expect(result.texture).toBe(baseDNA.texture);
    expect(result.rhythm).toBe(baseDNA.rhythm);
    expect(result.intensity).toBe(baseDNA.intensity);
  });

  it("a literal 'auto' value for haptic/rhythm leaves DNA's own pick alone", () => {
    const result = applySensoryOverride(baseDNA, { haptic: "auto", rhythm: "auto" });
    expect(result.texture).toBe(baseDNA.texture);
    expect(result.rhythm).toBe(baseDNA.rhythm);
  });

  it("pins texture when a concrete haptic choice is given", () => {
    const result = applySensoryOverride(baseDNA, { haptic: "rigid" });
    expect(result.texture).toBe("rigid");
  });

  it("rhythmSpeed sets anticipation, but an explicit anticipation override wins over it", () => {
    const slow = applySensoryOverride(baseDNA, { rhythmSpeed: "slow" });
    expect(slow.anticipation).toBe(80);

    const overridden = applySensoryOverride(baseDNA, { rhythmSpeed: "slow", anticipation: 10 });
    expect(overridden.anticipation).toBe(10);
  });

  it("'custom' rhythm doesn't touch DNA's rhythm field (no custom-waveform authoring yet)", () => {
    const result = applySensoryOverride(baseDNA, { rhythm: "custom" });
    expect(result.rhythm).toBe(baseDNA.rhythm);
  });
});

describe("sensory3dScale", () => {
  it("defaults to full (1.0) scale for both axes with no settings", () => {
    expect(sensory3dScale(undefined)).toEqual({ depth3d: 1, tiltResponse: 1 });
    expect(sensory3dScale(null)).toEqual({ depth3d: 1, tiltResponse: 1 });
    expect(sensory3dScale({})).toEqual({ depth3d: 1, tiltResponse: 1 });
  });

  it("scales each axis independently from its own 0-100 field", () => {
    expect(sensory3dScale({ depth3d: 50 })).toEqual({ depth3d: 0.5, tiltResponse: 1 });
    expect(sensory3dScale({ tiltResponse: 25 })).toEqual({ depth3d: 1, tiltResponse: 0.25 });
  });
});
