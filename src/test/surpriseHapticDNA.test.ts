/**
 * Tests for src/lib/surpriseHapticDNA.ts — deterministic per-surprise
 * Haptic DNA generation and its realization into concrete sequences.
 */
import { describe, it, expect } from "vitest";
import { buildHapticDNA, dnaToSequence, type HapticDNA } from "@/lib/surpriseHapticDNA";
import type { SurpriseAnalysis } from "@/lib/surpriseHaptics";

const analysis = (mood: SurpriseAnalysis["mood"], confidence = 0.8): SurpriseAnalysis => ({
  mood, secondaryMood: null, confidence, emojisFound: [], contentDurationMs: 4000,
});

describe("buildHapticDNA", () => {
  it("is deterministic — same id, same mood, same DNA every time", () => {
    const a = buildHapticDNA("surprise-abc", analysis("romantic"));
    const b = buildHapticDNA("surprise-abc", analysis("romantic"));
    expect(a).toEqual(b);
  });

  it("varies rhythm/texture across different ids sharing the same mood", () => {
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    const dnas = ids.map((id) => buildHapticDNA(id, analysis("romantic")));
    const rhythms = new Set(dnas.map((d) => d.rhythm));
    // Not asserting every id is unique (the mood's rhythm pool is only 3
    // wide) — asserting the brief's actual requirement: "do not make
    // every romantic surprise feel identical", i.e. more than one rhythm
    // shows up across a handful of different surprises.
    expect(rhythms.size).toBeGreaterThan(1);
  });

  it("only ever picks rhythm/texture from that mood's own vocabulary", () => {
    const dna = buildHapticDNA("surprise-xyz", analysis("intense"));
    expect(["crescendo", "burst", "knock"]).toContain(dna.rhythm);
    expect(["heavy", "rigid", "medium"]).toContain(dna.texture);
  });

  it("keeps all numeric fields within 0-100", () => {
    for (const id of ["a", "bb", "ccc", "dddd", "eeeee"]) {
      const dna = buildHapticDNA(id, analysis("celebratory"));
      for (const field of [dna.intensity, dna.anticipation, dna.climax] as const) {
        expect(field).toBeGreaterThanOrEqual(0);
        expect(field).toBeLessThanOrEqual(100);
      }
    }
  });

  it("pulls resolution toward the gentlest option when mood confidence is low", () => {
    const shaky = buildHapticDNA("surprise-shaky", analysis("intense", 0.1));
    // RESOLUTION_BY_MOOD.intense[0] is "medium" — the gentlest listed for
    // that mood; a low-confidence read should land exactly there rather
    // than the seed's full pick.
    expect(shaky.resolution).toBe("medium");
  });
});

describe("dnaToSequence", () => {
  const dna: HapticDNA = {
    mood: "romantic", texture: "soft", resolution: "light",
    rhythm: "heartbeat", intensity: 45, anticipation: 50, climax: 80,
  };

  it("receive is always a single quiet tick regardless of DNA", () => {
    expect(dnaToSequence(dna, "receive")).toEqual([{ kind: "tick", delayMs: 0 }]);
  });

  it("majorReveal ends on a climax beat scaled by dna.climax", () => {
    const low = dnaToSequence({ ...dna, climax: 10 }, "majorReveal");
    const high = dnaToSequence({ ...dna, climax: 90 }, "majorReveal");
    expect(low[low.length - 1].kind).toBe("medium");
    expect(high[high.length - 1].kind).toBe("rigid");
  });

  it("complete adds an affirming extra beat after the resolution texture", () => {
    const seq = dnaToSequence(dna, "complete");
    expect(seq[0].kind).toBe("light"); // dna.resolution
    expect(seq[1]).toEqual({ kind: "double", delayMs: 160 });
  });

  it("close is a single beat at the resolution texture", () => {
    expect(dnaToSequence(dna, "close")).toEqual([{ kind: "light", delayMs: 0 }]);
  });

  it("interact realizes every beat in the rhythm's curve, at the DNA's own texture", () => {
    const seq = dnaToSequence(dna, "interact");
    expect(seq.every((s) => s.kind === "soft")).toBe(true);
    expect(seq.length).toBe(2); // heartbeat curve has 2 beats
  });

  // §2 audit fix regression: dna.intensity was generated but never actually
  // read by dnaToSequence — locking down that it now shifts the realized
  // texture up/down the strength ladder rather than being silently ignored.
  it("intensity shifts the realized texture on the strength ladder", () => {
    const base = { ...dna, texture: "medium" as const };
    const low = dnaToSequence({ ...base, intensity: 10 }, "interact");
    const mid = dnaToSequence({ ...base, intensity: 50 }, "interact");
    const high = dnaToSequence({ ...base, intensity: 90 }, "interact");
    expect(low[0].kind).toBe("light");
    expect(mid[0].kind).toBe("medium");
    expect(high[0].kind).toBe("heavy");
  });

  it("intensity leaves shape textures (selection/double) alone — they aren't strength tiers", () => {
    const seq = dnaToSequence({ ...dna, texture: "selection", intensity: 95 }, "interact");
    expect(seq[0].kind).toBe("selection");
  });

  it("intensity never pushes a texture past the ends of the ladder", () => {
    const low = dnaToSequence({ ...dna, texture: "soft", intensity: 0 }, "interact");
    const high = dnaToSequence({ ...dna, texture: "rigid", intensity: 100 }, "interact");
    expect(low[0].kind).toBe("soft");
    expect(high[0].kind).toBe("rigid");
  });
});
