import { describe, it, expect } from "vitest";
import { FaceTracker, iou } from "@/lib/faceTracker";

const box = (x: number, y = 0.3, w = 0.2, h = 0.25) => ({ x, y, w, h });

describe("FaceTracker", () => {
  it("keeps one identity for a face that moves a little", () => {
    const t = new FaceTracker();
    const a = t.update([{ bbox: box(0.30), margin: 0.1 }], 0)[0];
    const b = t.update([{ bbox: box(0.33), margin: 0.1 }], 100)[0];
    expect(b.id).toBe(a.id);
    expect(b.hits).toBe(2);
  });

  it("does not flip an owner to stranger on one bad frame", () => {
    const t = new FaceTracker();
    t.update([{ bbox: box(0.3), margin: 0.12 }], 0);
    t.update([{ bbox: box(0.3), margin: 0.12 }], 100);
    const bad = t.update([{ bbox: box(0.3), margin: -0.08 }], 200)[0];
    expect(bad.verdict).toBe("owner");
  });

  it("flips to stranger after sustained negative evidence", () => {
    const t = new FaceTracker();
    t.update([{ bbox: box(0.3), margin: 0.1 }], 0);
    let v = "owner";
    for (let i = 1; i <= 6; i++) v = t.update([{ bbox: box(0.3), margin: -0.12 }], i * 100)[0].verdict;
    expect(v).toBe("stranger");
  });

  it("a clear stranger is a stranger on the very first frame (instant lock)", () => {
    const t = new FaceTracker();
    expect(t.update([{ bbox: box(0.3), margin: -0.2 }], 0)[0].verdict).toBe("stranger");
  });

  it("remembers a stranger that just left frame, then forgets them", () => {
    const t = new FaceTracker({ maxMissMs: 900 });
    t.update([{ bbox: box(0.3), margin: -0.2 }], 0);
    t.update([], 300);
    expect(t.strangerRecently(300, 800)).toBe(true);
    expect(t.ghosts().length).toBe(1);
    t.update([], 1500);
    expect(t.strangerRecently(1500, 800)).toBe(false);
  });

  it("tracks two faces independently", () => {
    const t = new FaceTracker();
    const [o, s] = t.update([{ bbox: box(0.05), margin: 0.15 }, { bbox: box(0.7), margin: -0.2 }], 0);
    const [o2, s2] = t.update([{ bbox: box(0.06), margin: 0.15 }, { bbox: box(0.69), margin: -0.2 }], 100);
    expect(o2.id).toBe(o.id);
    expect(s2.id).toBe(s.id);
    expect(o2.verdict).toBe("owner");
    expect(s2.verdict).toBe("stranger");
  });

  it("iou is 0 for disjoint boxes and 1 for identical", () => {
    expect(iou(box(0), box(0.9))).toBe(0);
    expect(iou(box(0.2), box(0.2))).toBeCloseTo(1, 5);
  });
});
