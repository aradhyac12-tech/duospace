import { describe, it, expect } from "vitest";
import {
  emptyProfile, mergeBaseline, updateBaseline, learnConfirmed, personalizeEvidence,
  MAX_PERSONAL_WEIGHT, MIN_PROTO_SAMPLES,
} from "@/lib/moodProfile";

const rule = { Happy: 10, Loving: 4, Surprised: 1, Frustrated: 1, Sad: 3, Calm: 2, Neutral: 2 };
const sadFace = { mouthFrownLeft: 0.3, mouthFrownRight: 0.3, browInnerUp: 0.25 };

describe("moodProfile", () => {
  it("is a no-op without a profile or before enough confirmations", () => {
    expect(personalizeEvidence(null, rule, sadFace, {})).toEqual(rule);
    let p = emptyProfile();
    for (let i = 0; i < MIN_PROTO_SAMPLES - 1; i++) p = learnConfirmed(p, "Sad", sadFace, {});
    expect(personalizeEvidence(p, rule, sadFace, {})).toEqual(rule);
  });

  it("learns a person's own Sad and nudges toward it, but never past the weight cap", () => {
    let p = emptyProfile();
    for (let i = 0; i < 25; i++) p = learnConfirmed(p, "Sad", sadFace, {});
    const out = personalizeEvidence(p, rule, sadFace, {});
    expect(out.Sad).toBeGreaterThan(rule.Sad);
    // bound: result <= (1-w)*rule + w*ref (sim<=1), ref = 10 here
    expect(out.Sad).toBeLessThanOrEqual((1 - MAX_PERSONAL_WEIGHT) * rule.Sad + MAX_PERSONAL_WEIGHT * 10 + 1e-9);
    expect(out.Happy).toEqual(rule.Happy);
    expect(out.Neutral).toEqual(rule.Neutral);
  });

  it("does not boost a mood when the face looks nothing like the learned one", () => {
    let p = emptyProfile();
    for (let i = 0; i < 25; i++) p = learnConfirmed(p, "Sad", sadFace, {});
    const smiling = { mouthSmileLeft: 0.7, mouthSmileRight: 0.7 };
    const out = personalizeEvidence(p, rule, smiling, {});
    expect(out.Sad).toBeLessThan(rule.Sad); // pulled toward ~0 similarity
  });

  it("works in delta space: a shifted camera/baseline does not break matching", () => {
    let p = emptyProfile();
    const base = { mouthFrownLeft: 0.1, mouthFrownRight: 0.1 };
    for (let i = 0; i < 25; i++) p = learnConfirmed(p, "Sad", { mouthFrownLeft: 0.4, mouthFrownRight: 0.4, browInnerUp: 0.25 }, base);
    const out = personalizeEvidence(p, rule, { mouthFrownLeft: 0.4, mouthFrownRight: 0.4, browInnerUp: 0.25 }, base);
    expect(out.Sad).toBeGreaterThan(rule.Sad);
  });

  it("baseline: first session passes through, history is blended in and converges", () => {
    const s1 = { jawOpen: 0.1 };
    expect(mergeBaseline(s1, null)).toEqual(s1);
    let p = emptyProfile();
    for (let i = 0; i < 6; i++) p = updateBaseline(p, { jawOpen: 0.2 });
    expect(p.baseline.jawOpen).toBeCloseTo(0.2, 5);
    const merged = mergeBaseline({ jawOpen: 0.5 }, p);
    expect(merged.jawOpen).toBeGreaterThan(0.2);
    expect(merged.jawOpen).toBeLessThan(0.5);
  });

  it("ignores Neutral and clamps garbage input", () => {
    const p = learnConfirmed(emptyProfile(), "Neutral", sadFace, {});
    expect(Object.keys(p.protos)).toHaveLength(0);
    const q = updateBaseline(emptyProfile(), { jawOpen: NaN, mouthClose: 5 });
    expect(q.baseline.jawOpen).toBe(0);
    expect(q.baseline.mouthClose).toBe(1);
  });
});
