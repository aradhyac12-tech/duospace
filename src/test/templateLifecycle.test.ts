import { describe, it, expect } from "vitest";
import { dropExpiredAdaptive, ADAPT_TTL_MS } from "@/lib/templateLifecycle";

const DAY = 86_400_000;
const mk = (added: number[], anchorCount: number) => ({
  embeddings: added.map((_, i) => `e${i}`), poses: added.map(() => ({ yaw: 0, pitch: 0 })),
  addedAt: added, anchorCount, count: added.length,
});

describe("dropExpiredAdaptive", () => {
  const now = 1_000 * DAY;
  it("never expires anchors, however old", () => {
    const p = mk([now - 400 * DAY, now - 400 * DAY, now - 1 * DAY], 2);
    expect(dropExpiredAdaptive(p, now).count).toBe(3);
  });
  it("drops passive samples older than the TTL and keeps arrays aligned", () => {
    const p = mk([now - 400 * DAY, now - 60 * DAY, now - 2 * DAY], 1);
    const r = dropExpiredAdaptive(p, now);
    expect(r.count).toBe(2);
    expect(r.embeddings.length).toBe(2);
    expect(r.poses!.length).toBe(2);
    expect(r.addedAt.length).toBe(2);
  });
  it("leaves legacy profiles without timestamps alone", () => {
    const p = { embeddings: ["a", "b"], count: 2 };
    expect(dropExpiredAdaptive(p, now)).toBe(p);
  });
  it("TTL is 45 days", () => { expect(ADAPT_TTL_MS).toBe(45 * DAY); });
});
