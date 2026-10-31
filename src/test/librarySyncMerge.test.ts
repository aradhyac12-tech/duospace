import { describe, it, expect } from "vitest";
import { diffLocal, mergeStates, emptyState, toLikedList, toPlaylists, sanitizeState, canon, LIKED_CAP, TOMBSTONE_TTL_MS } from "@/lib/music/librarySyncMerge";
import type { StoredTrack } from "@/lib/music/libraryStore";
import type { Playlist } from "@/lib/music/playlists";

const T = (id: string): StoredTrack => ({ id, provider: "soundcloud", providerTrackId: id, title: `t${id}`, artist: "a" } as StoredTrack);
const PL = (id: string, ids: string[], createdAt = 1): Playlist => ({ id, name: id, createdAt, tracks: ids.map(T) });

describe("diffLocal", () => {
  it("new likes get at=now (newest-first order preserved); unchanged keep their at; removals become tombstones", () => {
    const s1 = diffLocal(emptyState(), [T("b"), T("a")], [], 1000);
    expect(s1.liked.b.at).toBeGreaterThan(s1.liked.a.at);
    const s2 = diffLocal(s1, [T("b")], [], 2000);
    expect(s2.liked.b.at).toBe(s1.liked.b.at);
    expect(s2.liked.a).toEqual({ at: 2000, del: true });
  });
  it("re-liking a tombstoned song revives it with a newer at", () => {
    const s = diffLocal(diffLocal(emptyState(), [T("a")], [], 1000), [], [], 2000);
    expect(diffLocal(s, [T("a")], [], 3000).liked.a.at).toBe(3000);
  });
  it("playlist edits bump at only when contents change", () => {
    const s1 = diffLocal(emptyState(), [], [PL("p", ["a"])], 1000);
    expect(diffLocal(s1, [], [PL("p", ["a"])], 2000).playlists.p.at).toBe(1000);
    expect(diffLocal(s1, [], [PL("p", ["a", "b"])], 2000).playlists.p.at).toBe(2000);
  });
});

describe("mergeStates", () => {
  it("an unlike on one phone beats a stale copy on the other (no resurrection)", () => {
    const base = diffLocal(emptyState(), [T("a")], [], 1000);
    const phoneA = diffLocal(base, [], [], 2000);           // unliked at 2000
    const phoneB = base;                                     // still has it, at 1000
    const m = mergeStates(phoneA, phoneB, 3000);
    expect(toLikedList(m)).toEqual([]);
    expect(m.liked.a.del).toBe(true);
  });
  it("likes from both phones are unioned", () => {
    const a = diffLocal(emptyState(), [T("a")], [], 1000), b = diffLocal(emptyState(), [T("b")], [], 2000);
    expect(toLikedList(mergeStates(a, b, 3000)).map((t) => t.id)).toEqual(["b", "a"]);
  });
  it("is commutative and idempotent", () => {
    const a = diffLocal(emptyState(), [T("a"), T("c")], [PL("p", ["a"])], 1000);
    const b = diffLocal(diffLocal(emptyState(), [T("b")], [PL("q", [])], 900), [T("b")], [], 1500);
    const ab = mergeStates(a, b, 5000), ba = mergeStates(b, a, 5000);
    expect(canon(ab)).toBe(canon(ba));
    expect(canon(mergeStates(ab, ab, 5000))).toBe(canon(ab));
  });
  it("tie on timestamp: a removal wins deterministically", () => {
    const live = { liked: { a: { at: 5, t: T("a") } }, playlists: {} };
    const dead = { liked: { a: { at: 5, del: true as const } }, playlists: {} };
    expect(mergeStates(live, dead, 6).liked.a.del).toBe(true);
    expect(mergeStates(dead, live, 6).liked.a.del).toBe(true);
  });
  it("caps live likes; overflow becomes tombstones so devices stay consistent", () => {
    const many = diffLocal(emptyState(), Array.from({ length: LIKED_CAP + 20 }, (_, i) => T(`x${i}`)), [], 10_000);
    const m = mergeStates(many, emptyState(), 10_000);
    expect(toLikedList(m)).toHaveLength(LIKED_CAP);
    // stable: a second merge+diff does not change what is live
    const again = mergeStates(diffLocal(m, toLikedList(m), [], 11_000), m, 11_000);
    expect(toLikedList(again)).toHaveLength(LIKED_CAP);
  });
  it("drops tombstones older than the TTL", () => {
    const s = { liked: { a: { at: 1, del: true as const } }, playlists: { p: { at: 1, del: true as const } } };
    const m = mergeStates(s, emptyState(), TOMBSTONE_TTL_MS + 100);
    expect(m.liked.a).toBeUndefined(); expect(m.playlists.p).toBeUndefined();
  });
  it("playlist delete propagates; per-playlist last edit wins", () => {
    const base = diffLocal(emptyState(), [], [PL("p", ["a"])], 1000);
    const deleted = diffLocal(base, [], [], 2000);
    expect(toPlaylists(mergeStates(deleted, base, 3000))).toEqual([]);
    const edA = diffLocal(base, [], [PL("p", ["a", "x"])], 2000), edB = diffLocal(base, [], [PL("p", ["a", "y"])], 2500);
    expect(toPlaylists(mergeStates(edA, edB, 3000))[0].tracks.map((t) => t.id)).toEqual(["a", "y"]);
  });
});

describe("sanitizeState (remote is untrusted)", () => {
  it("drops malformed entries and non-numeric timestamps", () => {
    const s = sanitizeState({
      liked: { ok: { at: 1, t: T("ok") }, bad1: { at: "x", t: T("b") }, bad2: { at: 1, t: { id: 5 } }, bad3: null, gone: { at: 2, del: true } },
      playlists: { p: { at: 1, pl: { id: "p", name: "n", createdAt: 1, tracks: [T("a"), { nope: 1 }] } }, q: { at: 1, pl: "str" } },
    });
    expect(Object.keys(s.liked).sort()).toEqual(["gone", "ok"]);
    expect(Object.keys(s.playlists)).toEqual(["p"]);
    expect(s.playlists.p.pl!.tracks).toHaveLength(1);
  });
  it("handles null / junk input", () => {
    expect(sanitizeState(null)).toEqual(emptyState());
    expect(sanitizeState({ liked: "x", playlists: 5 })).toEqual(emptyState());
  });
});
