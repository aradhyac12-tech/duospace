import { describe, it, expect } from "vitest";
import { insertAfterCurrent, moveUpcoming, pickNativeWindow, tracksAhead } from "@/lib/music/queueLogic";

/**
 * "The queue UI order is the order actually played": the native player auto-advances through
 * pickNativeWindow(queue, …) with no help from JS, so after ANY queue edit the window must be a
 * contiguous slice of the queue the person sees (non-shuffle) — never a stale or reordered copy.
 */
const q = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (x: { id: string }[]) => x.map((t) => t.id).join("");
const win = (queue: { id: string }[], currentId: string, over: Partial<Parameters<typeof pickNativeWindow>[0]> = {}) =>
  pickNativeWindow({ queue, currentId, shuffle: false, repeatMode: "off", played: new Set(), ...over }).window;

describe("native window follows the visible queue order", () => {
  it("after moveUpcoming the window reflects the new order and keeps the playing track", () => {
    const base = q("a", "b", "c", "d", "e");
    const moved = moveUpcoming(base, "b", "e", -2); // a b e c d
    expect(ids(win(moved, "b"))).toBe("abecd");
  });
  it("play-next lands directly after the current track in the window", () => {
    const base = q("a", "b", "c");
    const next = insertAfterCurrent(base, base[1], { id: "x" }); // a b x c
    expect(ids(win(next, "b"))).toBe("abxc");
  });
  it("removing an upcoming track removes it from the window", () => {
    const base = q("a", "b", "c", "d");
    expect(ids(win(base.filter((t) => t.id !== "c"), "b"))).toBe("abd");
  });
  it("repeat-one never lets the native side advance away from the current track", () => {
    expect(ids(win(q("a", "b", "c"), "b", { repeatMode: "one" }))).toBe("b");
  });
  it("shuffle window only contains queued, unplayed tracks after the current one", () => {
    const base = q("a", "b", "c", "d");
    const w = pickNativeWindow({ queue: base, currentId: "a", shuffle: true, repeatMode: "off", played: new Set(["a", "b"]), random: () => 0 }).window;
    expect(w[0].id).toBe("a");
    expect(ids(w.slice(1)).split("").sort().join("")).toBe("cd");
  });
  it("a current track that is no longer queued yields an empty window (caller handles standalone play)", () => {
    expect(win(q("a", "b"), "gone")).toEqual([]);
  });
});

describe("tracksAhead (queue lead used to decide when to top up)", () => {
  it("counts only what is after the current track in order mode", () => {
    expect(tracksAhead(["a", "b", "c", "d"], "b", false, new Set())).toBe(2);
    expect(tracksAhead(["a", "b", "c", "d"], "d", false, new Set())).toBe(0);
  });
  it("counts unplayed, non-current tracks in shuffle mode", () => {
    expect(tracksAhead(["a", "b", "c", "d"], "a", true, new Set(["a", "b"]))).toBe(2);
  });
});
