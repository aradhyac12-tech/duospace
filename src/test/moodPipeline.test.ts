import { describe, it, expect } from "vitest";
import { analyzeMoodFrames, readingConfidence, type MoodFrame } from "@/lib/moodPipeline";
import { blendshapeBaseline, frameQuality, sessionBaseline, topMoodWithMargin, type MoodLabel } from "@/lib/moodScoring";

// Deterministic pseudo-noise so tests are stable but not perfectly flat.
const noise = (i: number, amp = 0.01) => Math.sin(i * 12.9898) * amp;
const geo = (curve = 0, open = 0.01, brow = 0.24, eye = 0.22) => ({ mouthCurve: curve, mouthOpen: open, browRaise: brow, eyeOpenness: eye });
const frame = (i: number, b: Record<string, number>): MoodFrame => ({
  geo: geo(),
  blend: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.max(0, v + noise(i + k.length))])),
});
const run = (n: number, f: (i: number) => Record<string, number>) => Array.from({ length: n }, (_, i) => frame(i, f(i)));
const opts = { distrust: {}, profile: null, faceCoverage: 1 };
const REST = { browInnerUp: 0.05, jawOpen: 0.03, mouthClose: 0.05 };

describe("analyzeMoodFrames — blendshape path", () => {
  it("needs a minimum number of frames", () => {
    expect(analyzeMoodFrames(run(2, () => REST), opts)).toBeNull();
  });

  it("a smile held for the WHOLE window is Happy, not absorbed into the baseline", () => {
    const r = analyzeMoodFrames(run(14, () => ({ ...REST, mouthSmileLeft: 0.55, mouthSmileRight: 0.55, cheekSquintLeft: 0.35, cheekSquintRight: 0.35, jawOpen: 0.25 })), opts)!;
    expect(r.method).toBe("blendshape");
    expect(r.mood).toBe("Happy");
    expect(r.confidence).toBeGreaterThan(0.6);
  });

  it("one smile frame among many neutral ones stays Neutral", () => {
    const r = analyzeMoodFrames(run(14, (i) => (i === 10 ? { ...REST, mouthSmileLeft: 0.7, mouthSmileRight: 0.7 } : REST)), opts)!;
    expect(r.mood).toBe("Neutral");
  });

  it("raised-brow/wide-eye camera-angle bias at rest is NOT Surprised", () => {
    const r = analyzeMoodFrames(run(14, () => ({ ...REST, browInnerUp: 0.3, browOuterUpLeft: 0.28, browOuterUpRight: 0.28, eyeWideLeft: 0.22, eyeWideRight: 0.22 })), opts)!;
    expect(r.mood).not.toBe("Surprised");
  });

  it("a genuine, sustained surprise is Surprised", () => {
    const r = analyzeMoodFrames(run(14, () => ({ browInnerUp: 0.8, browOuterUpLeft: 0.75, browOuterUpRight: 0.75, eyeWideLeft: 0.6, eyeWideRight: 0.6, jawOpen: 0.55, mouthClose: 0 })), opts)!;
    expect(r.mood).toBe("Surprised");
  });

  it("flickering jaw (talking) is damped and never read as Surprised", () => {
    const r = analyzeMoodFrames(run(14, (i) => ({ ...REST, jawOpen: i % 2 ? 0.6 : 0.02 })), opts)!;
    expect(r.talking).toBe(true);
    expect(r.mood).not.toBe("Surprised");
  });

  it("a Happy/Loving near-tie is a positive read, not an ambiguity fallback to Neutral", () => {
    const r = analyzeMoodFrames(run(14, () => ({ mouthSmileLeft: 0.42, mouthSmileRight: 0.42, jawOpen: 0, mouthClose: 0 })), opts)!;
    expect(["Happy", "Loving"]).toContain(r.mood);
    expect(r.ambiguous).toBe(false);
  });

  it("drops blink frames", () => {
    const frames = run(14, (i) => ({ ...REST, eyeBlinkLeft: i % 4 === 0 ? 0.9 : 0.05, eyeBlinkRight: i % 4 === 0 ? 0.9 : 0.05 }));
    const r = analyzeMoodFrames(frames, opts)!;
    expect(r.blinkFiltered).toBeGreaterThan(0);
  });

  it("a steady read is more stable and more confident than a flickering one", () => {
    const smile = { ...REST, mouthSmileLeft: 0.55, mouthSmileRight: 0.55, cheekSquintLeft: 0.3, cheekSquintRight: 0.3, jawOpen: 0.25 };
    const steady = analyzeMoodFrames(run(14, () => smile), opts)!;
    const flicker = analyzeMoodFrames(run(14, (i) => (i % 2 ? smile : REST)), opts)!;
    expect(steady.stability).toBeGreaterThan(flicker.stability);
    expect(steady.confidence).toBeGreaterThan(flicker.confidence);
  });
});

describe("analyzeMoodFrames — geometry fallback", () => {
  it("a sustained smile is still Happy (resting mouth-curve baseline is clamped)", () => {
    const frames: MoodFrame[] = Array.from({ length: 12 }, (_, i) => ({ geo: geo(0.12 + noise(i, 0.003), 0.03) }));
    const r = analyzeMoodFrames(frames, opts)!;
    expect(r.method).toBe("geometry");
    expect(r.mood).toBe("Happy");
  });
  it("a face at rest is Neutral/Calm, not an expression", () => {
    const frames: MoodFrame[] = Array.from({ length: 12 }, (_, i) => ({ geo: geo(noise(i, 0.002)) }));
    expect(["Neutral", "Calm"]).toContain(analyzeMoodFrames(frames, opts)!.mood);
  });
});

describe("helpers", () => {
  it("blendshape baseline can't exceed a resting ceiling", () => {
    const pool = run(10, () => ({ mouthSmileLeft: 0.7, mouthSmileRight: 0.7, browInnerUp: 0.9 }));
    const b = blendshapeBaseline(pool.map((f) => f.blend!));
    expect(b.mouthSmileLeft).toBeLessThanOrEqual(0.08);
    expect(b.browInnerUp).toBeLessThanOrEqual(0.35);
  });
  it("geometry baseline mouth curve is clamped", () => {
    expect(sessionBaseline(Array.from({ length: 6 }, () => geo(0.2))).mouthCurve).toBeLessThanOrEqual(0.02);
  });
  it("family-aware margin: Happy≈Loving is not ambiguous, Happy≈Sad is", () => {
    const base = { Happy: 0.4, Loving: 0.38, Surprised: 0.05, Frustrated: 0.05, Sad: 0.05, Calm: 0.04, Neutral: 0.03 } as Record<MoodLabel, number>;
    const t = topMoodWithMargin(base);
    expect(t.ambiguous).toBe(false);
    expect(t.familyTie).toBe(true);
    const rival = topMoodWithMargin({ ...base, Loving: 0.05, Sad: 0.37 });
    expect(rival.ambiguous).toBe(true);
  });
  it("frame quality is bounded and rewards big, frontal, sharp faces", () => {
    const good = frameQuality({ area: 0.08, pose: { yaw: 0, pitch: 0 }, textureScore: { laplacianVar: 40, lumaStdDev: 30 } });
    const poor = frameQuality({ area: 0.021, pose: { yaw: 0.12, pitch: 0.11 }, textureScore: { laplacianVar: 6.5, lumaStdDev: 10 } });
    expect(good).toBeGreaterThan(poor);
    expect(poor).toBeGreaterThanOrEqual(0.35);
    expect(good).toBeLessThanOrEqual(1);
  });
  it("confidence is capped when ambiguous and lower with poor face coverage", () => {
    const a = { mood: "Happy" as MoodLabel, topProb: 0.9, margin: 0.8, stability: 1, faceCoverage: 1, ambiguous: false, familyTie: false };
    expect(readingConfidence({ ...a, ambiguous: true })).toBeLessThanOrEqual(0.55);
    expect(readingConfidence({ ...a, faceCoverage: 0.2 })).toBeLessThan(readingConfidence(a));
  });
});
