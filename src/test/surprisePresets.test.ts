import { describe, it, expect } from "vitest";
import { SURPRISE_PRESETS } from "@/lib/surprisePresets";
import { surprisePresets } from "@/lib/codeSurprises";
import { dnaToSequence, type HapticDNA, type HapticRhythm } from "@/lib/surpriseHapticDNA";

const base: HapticDNA = {
  mood: "romantic", texture: "medium", resolution: "light",
  rhythm: "heartbeat", intensity: 50, anticipation: 50, climax: 80,
};

describe("sensory presets are all distinct", () => {
  it("has unique ids and unique rhythms (no two presets feel alike)", () => {
    const ids = SURPRISE_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rhythms = SURPRISE_PRESETS.map((p) => p.sensory.rhythm);
    expect(new Set(rhythms).size).toBe(rhythms.length);
  });

  it("every preset rhythm realises into a non-empty interact sequence", () => {
    for (const p of SURPRISE_PRESETS) {
      const seq = dnaToSequence({ ...base, rhythm: p.sensory.rhythm as HapticRhythm }, "interact");
      expect(seq.length, p.id).toBeGreaterThan(0);
      // beats must be in time order
      for (let i = 1; i < seq.length; i++) expect(seq[i].delayMs, p.id).toBeGreaterThanOrEqual(seq[i - 1].delayMs);
    }
  });

  it("signature rhythms use their own pinned beat kinds, not just the base texture", () => {
    const thunder = dnaToSequence({ ...base, rhythm: "thunder", texture: "soft", intensity: 50 }, "interact");
    expect(new Set(thunder.map((s) => s.kind)).size).toBeGreaterThan(2);
  });
});

describe("visual code-surprise presets are distinct", () => {
  it("unique ids and no identical stylesheets", () => {
    const ids = surprisePresets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const css = surprisePresets.map((p) => p.css_content.replace(/--accent[^;]*;|--bg[^;]*;/g, "").replace(/\s+/g, ""));
    expect(new Set(css).size).toBe(css.length);
  });

  it("every preset's script parses", () => {
    for (const p of surprisePresets) expect(() => new Function(p.js_content), p.id).not.toThrow();
  });
});
