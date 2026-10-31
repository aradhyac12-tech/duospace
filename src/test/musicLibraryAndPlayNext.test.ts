import { describe, it, expect, beforeEach } from "vitest";
import { insertAfterCurrent } from "@/lib/music/queueLogic";
import { toggleLiked, readLiked, recordRecentTrack, readRecentTracks, clearRecentTracks, unslim } from "@/lib/music/libraryStore";
import type { GroicTrack } from "@/lib/music/types";

const tr = (n: string): GroicTrack => ({
  id: `soundcloud:${n}`, provider: "soundcloud", providerTrackId: n, videoId: n,
  title: `Song ${n}`, artist: "A", thumbnail: `https://x/${n}.jpg`, duration: 100, streamUrl: "https://expiring/stream", isStreamable: true,
});

describe("insertAfterCurrent (Play Next)", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map(tr);
  it("slots the track directly after the current one", () => {
    expect(insertAfterCurrent([a, b, c], a, d).map((x) => x.id)).toEqual([a.id, d.id, b.id, c.id]);
    expect(insertAfterCurrent([a, b, c], b, d).map((x) => x.id)).toEqual([a.id, b.id, d.id, c.id]);
  });
  it("moves an already-queued track instead of duplicating it", () => {
    expect(insertAfterCurrent([a, b, c], a, c).map((x) => x.id)).toEqual([a.id, c.id, b.id]);
  });
  it("puts the current track in front when the queue is empty, so next() lands on the new song", () => {
    expect(insertAfterCurrent([], a, b).map((x) => x.id)).toEqual([a.id, b.id]);
  });
  it("is a no-op for the current track and works with nothing playing", () => {
    const q = [a, b];
    expect(insertAfterCurrent(q, a, a)).toBe(q);
    expect(insertAfterCurrent([a], null, b).map((x) => x.id)).toEqual([b.id, a.id]);
  });
});

describe("libraryStore", () => {
  beforeEach(() => { localStorage.clear(); });
  it("toggles liked songs, newest first, and never persists the expiring streamUrl", () => {
    expect(toggleLiked(tr("a"))).toBe(true);
    expect(toggleLiked(tr("b"))).toBe(true);
    expect(readLiked().map((t) => t.id)).toEqual(["soundcloud:b", "soundcloud:a"]);
    expect(JSON.stringify(readLiked())).not.toContain("expiring");
    expect(toggleLiked(tr("a"))).toBe(false);
    expect(readLiked().map((t) => t.id)).toEqual(["soundcloud:b"]);
  });
  it("recent tracks de-dupe by moving a replay to the front, cap at 30, and can be cleared", () => {
    for (let i = 0; i < 35; i++) recordRecentTrack(tr(String(i)));
    expect(readRecentTracks()).toHaveLength(30);
    recordRecentTrack(tr("20"));
    expect(readRecentTracks()[0].id).toBe("soundcloud:20");
    expect(readRecentTracks().filter((t) => t.id === "soundcloud:20")).toHaveLength(1);
    clearRecentTracks();
    expect(readRecentTracks()).toEqual([]);
  });
  it("rehydrates a stored track into a playable one and ignores corrupt storage", () => {
    toggleLiked(tr("a"));
    const t = unslim(readLiked()[0]);
    expect(t.artwork).toBe(t.thumbnail);
    expect(t.streamUrl).toBeUndefined();
    localStorage.setItem("groic-liked:anon", "{not json");
    expect(readLiked()).toEqual([]);
  });
});

import { sameNameFamily, buildSearchUpNext, withoutSameName, trackKey } from "@/lib/music/queueQuality";
import { pickNativeWindow } from "@/lib/music/queueLogic";

describe("sameNameFamily", () => {
  const f = (a: string, b: string) => sameNameFamily(trackKey(a), trackKey(b));
  it("matches a title and the same title plus extra words / version tags", () => {
    expect(f("Payal", "Payal")).toBe(true);
    expect(f("Payal", "Payal Ki Jhankar")).toBe(true);
    expect(f("Payal", "Payal (Remix)")).toBe(true);
    expect(f("Tum Hi Ho", "Tum Hi Ho Bandhu")).toBe(true);
  });
  it("does not match different songs, partial words, or very short keys", () => {
    expect(f("Payal", "Payala Dance")).toBe(false);
    expect(f("Tum", "Tum Hi Ho")).toBe(false);
    expect(f("Kesariya", "Tera Naam")).toBe(false);
    expect(f("", "Payal")).toBe(false);
  });
});

describe("buildSearchUpNext", () => {
  const mk = (title: string, artist: string, id: string) => ({ title, artist, id });
  const pool = [
    mk("Payal", "A", "1"), mk("Payal Ki Jhankar", "B", "2"), mk("Payal Payal", "C", "3"),
    mk("Kaise Hua", "Payal Dev", "4"), mk("Tum Hi Ho", "Payal Dev", "5"), mk("Heer", "Payal Dev", "6"), mk("Raataan", "Other", "7"),
  ];
  it("never queues the same-name family of the tapped song or the search words", () => {
    const out = buildSearchUpNext(pool, pool[0], (x) => x.id, "payal", { random: () => 0 });
    expect(out.every((t) => !/payal/i.test(t.title))).toBe(true);
    expect(out.map((t) => t.id)).not.toContain("1");
  });
  it("keeps at most 2 per artist and 4 in total", () => {
    const out = buildSearchUpNext(pool, pool[0], (x) => x.id, "payal", { random: () => 0 });
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out.filter((t) => t.artist === "Payal Dev").length).toBeLessThanOrEqual(2);
  });
  it("withoutSameName keeps the tapped track but removes its relatives", () => {
    const out = withoutSameName(pool, pool[0]);
    expect(out).toContain(pool[0]);
    expect(out.map((t) => t.id)).not.toContain("2");
    expect(out.map((t) => t.id)).toContain("4");
  });
});

describe("pickNativeWindow (what the native player is allowed to advance to)", () => {
  const q = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const ids = (w: { id: string }[]) => w.map((x) => x.id);
  it("sequential: 1 back, current, up to 5 ahead", () => {
    expect(ids(pickNativeWindow({ queue: q, currentId: "c", shuffle: false, repeatMode: "off", played: new Set() }).window)).toEqual(["b", "c", "d", "e"]);
  });
  it("repeat-one: only the current track, so the native player cannot advance away", () => {
    expect(ids(pickNativeWindow({ queue: q, currentId: "c", shuffle: false, repeatMode: "one", played: new Set() }).window)).toEqual(["c"]);
  });
  it("shuffle: current + unplayed picks, stable across re-syncs", () => {
    const first = pickNativeWindow({ queue: q, currentId: "a", shuffle: true, repeatMode: "off", played: new Set(["a", "b"]), random: () => 0 });
    expect(ids(first.window)).toEqual(["a", "c", "d", "e"]);
    const again = pickNativeWindow({ queue: q, currentId: "a", shuffle: true, repeatMode: "off", played: new Set(["a", "b"]), shuffleChain: first.shuffleChain, random: () => 0.99 });
    expect(ids(again.window)).toEqual(["a", "c", "d", "e"]);
    expect(again.shuffleNextId).toBe("c");
  });
  it("shuffle: drops removed/played picks and re-picks; nothing left → current only", () => {
    const re = pickNativeWindow({ queue: q, currentId: "a", shuffle: true, repeatMode: "off", played: new Set(["a"]), shuffleNextId: "zzz", random: () => 0 });
    expect(ids(re.window)).toEqual(["a", "b", "c", "d", "e"]);
    const done = pickNativeWindow({ queue: q, currentId: "a", shuffle: true, repeatMode: "off", played: new Set(q.map((x) => x.id)) });
    expect(ids(done.window)).toEqual(["a"]);
  });
  it("sequential window is capped at 5 ahead", () => {
    const long = Array.from({ length: 20 }, (_, i) => ({ id: "t" + i }));
    expect(ids(pickNativeWindow({ queue: long, currentId: "t3", shuffle: false, repeatMode: "off", played: new Set() }).window)).toEqual(["t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
  });
  it("reflects Play next immediately in the window", () => {
    const withNext = insertAfterCurrent(q, q[0], { id: "new" });
    expect(ids(pickNativeWindow({ queue: withNext, currentId: "a", shuffle: false, repeatMode: "off", played: new Set() }).window)).toEqual(["a", "new", "b"]);
  });
  it("returns an empty window when the current track is not in the queue", () => {
    expect(pickNativeWindow({ queue: q, currentId: "zzz", shuffle: false, repeatMode: "off", played: new Set() }).window).toEqual([]);
  });
});
