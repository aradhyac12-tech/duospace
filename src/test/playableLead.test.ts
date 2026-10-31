import { describe, it, expect } from "vitest";
import { planLeadTargets, LEAD_TARGETS } from "@/lib/music/warmPlanner";

const t = (provider: string, id: string, extra: Record<string, unknown> = {}) => ({ id: `${provider}:${id}`, provider, providerTrackId: id, ...extra });
const none = () => null;

describe("planLeadTargets (auto-next playable lead)", () => {
  it("picks the first two upcoming native-playable tracks, in queue order, skipping the current and history", () => {
    const q = [t("soundcloud", "h"), t("soundcloud", "cur"), t("soundcloud", "a"), t("audius", "b"), t("soundcloud", "c")];
    expect(planLeadTargets(q, "soundcloud:cur", none)).toEqual([{ provider: "soundcloud", id: "a" }, { provider: "audius", id: "b" }]);
    expect(LEAD_TARGETS).toBe(2);
  });
  it("passes over YouTube/local entries and already-resolved ones", () => {
    const q = [t("soundcloud", "cur"), t("youtube", "y"), t("soundcloud", "hot"), t("jamendo", "j"), t("soundcloud", "z")];
    const peek = (p: string, id: string) => (id === "hot" ? "https://cached" : null);
    expect(planLeadTargets(q, "soundcloud:cur", peek)).toEqual([{ provider: "jamendo", id: "j" }, { provider: "soundcloud", id: "z" }]);
    expect(planLeadTargets([t("soundcloud", "cur"), t("soundcloud", "s", { streamUrl: "file:///x" })], "soundcloud:cur", none)).toEqual([]);
  });
  it("makes no requests offline or in shuffle", () => {
    const q = [t("soundcloud", "cur"), t("soundcloud", "a")];
    expect(planLeadTargets(q, "soundcloud:cur", none, { online: false })).toEqual([]);
    expect(planLeadTargets(q, "soundcloud:cur", none, { shuffle: true })).toEqual([]);
  });
  it("never exceeds n and dedupes repeats", () => {
    const q = [t("soundcloud", "cur"), t("soundcloud", "a"), t("soundcloud", "a"), t("soundcloud", "b"), t("soundcloud", "c")];
    expect(planLeadTargets(q, "soundcloud:cur", none, { n: 2 })).toHaveLength(2);
    expect(planLeadTargets(q, "soundcloud:cur", none, { n: 3 }).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});
