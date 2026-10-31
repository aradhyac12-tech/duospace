import { describe, it, expect, vi } from "vitest";
vi.mock("@/integrations/supabase/appClient", () => ({ supabase: {} }));
vi.mock("@/lib/telemetry", () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));
import { createLibrarySyncEngine, type LibrarySyncIO } from "@/lib/music/librarySync";
import { sanitizeState, emptyState, type SyncState } from "@/lib/music/librarySyncMerge";
import type { StoredTrack } from "@/lib/music/libraryStore";
import type { Playlist } from "@/lib/music/playlists";

const T = (id: string): StoredTrack => ({ id, provider: "soundcloud", providerTrackId: id, title: `t${id}`, artist: "a" } as StoredTrack);

/** A fake Supabase row shared by all phones, with the same optimistic-concurrency semantics as the real push. */
function fakeRemote() {
  let row: { state: SyncState; v: number } | null = null;
  const stats = { pushes: 0, conflicts: 0 };
  return {
    stats,
    pull: async () => (row ? { state: sanitizeState(JSON.parse(JSON.stringify(row.state))), version: String(row.v) } : null),
    push: async (state: SyncState, version: string | null) => {
      if (version === null ? row !== null : row === null || String(row.v) !== version) { stats.conflicts++; return "conflict" as const; }
      stats.pushes++; row = { state: JSON.parse(JSON.stringify(state)), v: (row?.v ?? 0) + 1 }; return "ok" as const;
    },
    raw: () => row,
  };
}

function phone(remote: ReturnType<typeof fakeRemote>, clock: { t: number }, hooks?: { beforePush?: () => Promise<void> }) {
  let liked: StoredTrack[] = []; let pls: Playlist[] = []; let meta: SyncState = emptyState();
  const io: LibrarySyncIO = {
    readLiked: () => liked, readPlaylists: () => pls,
    applyLiked: (l) => { liked = l; }, applyPlaylists: (l) => { pls = l; },
    loadMeta: () => meta, saveMeta: (s) => { meta = s; },
    pull: remote.pull, push: async (s, v) => { await hooks?.beforePush?.(); return remote.push(s, v); },
    now: () => clock.t,
  };
  const engine = createLibrarySyncEngine(io);
  return {
    engine, ids: () => liked.map((t) => t.id), plNames: () => pls.map((p) => p.name),
    like: (id: string) => { liked = [T(id), ...liked]; },
    unlike: (id: string) => { liked = liked.filter((t) => t.id !== id); },
    addPl: (p: Playlist) => { pls = [p, ...pls]; },
    delPl: (id: string) => { pls = pls.filter((p) => p.id !== id); },
  };
}

describe("library sync engine — two phones", () => {
  it("phone B gets what phone A liked and the playlist it built", async () => {
    const r = fakeRemote(), clock = { t: 1000 }; const A = phone(r, clock), B = phone(r, clock);
    A.like("a"); A.like("b"); A.addPl({ id: "p", name: "Road trip", createdAt: 1, tracks: [T("a")] });
    await A.engine.sync(); clock.t = 2000;
    await B.engine.sync();
    expect(B.ids()).toEqual(["b", "a"]); expect(B.plNames()).toEqual(["Road trip"]);
  });

  it("unlike and playlist delete on A propagate to B and are not resurrected by B's next sync", async () => {
    const r = fakeRemote(), clock = { t: 1000 }; const A = phone(r, clock), B = phone(r, clock);
    A.like("a"); A.like("b"); A.addPl({ id: "p", name: "P", createdAt: 1, tracks: [] });
    await A.engine.sync(); clock.t = 2000; await B.engine.sync();
    clock.t = 3000; A.unlike("a"); A.delPl("p"); await A.engine.sync();
    clock.t = 4000; await B.engine.sync();
    expect(B.ids()).toEqual(["b"]); expect(B.plNames()).toEqual([]);
    clock.t = 5000; await B.engine.sync(); await A.engine.sync();
    expect(A.ids()).toEqual(["b"]); expect(B.ids()).toEqual(["b"]);
  });

  it("offline edits on both phones merge instead of overwriting", async () => {
    const r = fakeRemote(), clock = { t: 1000 }; const A = phone(r, clock), B = phone(r, clock);
    A.like("a"); await A.engine.sync(); clock.t = 1500; await B.engine.sync();
    clock.t = 2000; A.like("fromA"); B.like("fromB");
    await A.engine.sync(); clock.t = 2100; await B.engine.sync(); clock.t = 2200; await A.engine.sync();
    expect(new Set(A.ids())).toEqual(new Set(["a", "fromA", "fromB"]));
    expect(new Set(B.ids())).toEqual(new Set(A.ids()));
  });

  it("a push conflict (other phone wrote in between) retries on the fresh row and loses nothing", async () => {
    const r = fakeRemote(), clock = { t: 1000 };
    const B = phone(r, clock);
    let intruded = false;
    const A = phone(r, clock, { beforePush: async () => { if (intruded) return; intruded = true; B.like("fromB"); await B.engine.sync(); } });
    A.like("fromA");
    await A.engine.sync();
    expect(r.stats.conflicts).toBeGreaterThanOrEqual(1);
    expect(new Set(A.ids())).toEqual(new Set(["fromA", "fromB"]));
    expect(new Set(r.raw()!.state.liked ? Object.keys(r.raw()!.state.liked) : [])).toEqual(new Set(["fromA", "fromB"]));
  });

  it("does not push when nothing changed (idle foreground syncs are read-only)", async () => {
    const r = fakeRemote(), clock = { t: 1000 }; const A = phone(r, clock);
    A.like("a"); await A.engine.sync(); const pushes = r.stats.pushes;
    clock.t = 5000; await A.engine.sync(); await A.engine.sync();
    expect(r.stats.pushes).toBe(pushes);
  });

  it("hasLocalChanges ignores unrelated events but sees a real like", async () => {
    const r = fakeRemote(), clock = { t: 1000 }; const A = phone(r, clock);
    A.like("a"); await A.engine.sync();
    expect(A.engine.hasLocalChanges()).toBe(false);
    A.like("b"); expect(A.engine.hasLocalChanges()).toBe(true);
  });

  it("a failing pull aborts the cycle without touching local data", async () => {
    const r = fakeRemote(), clock = { t: 1000 }; const A = phone(r, clock);
    A.like("a");
    const bad = createLibrarySyncEngine({ ...({} as LibrarySyncIO), readLiked: () => [T("a")], readPlaylists: () => [], applyLiked: () => { throw new Error("must not apply"); }, applyPlaylists: () => {}, loadMeta: () => emptyState(), saveMeta: () => {}, pull: async () => { throw new Error("offline"); }, push: async () => "ok", now: () => 1 });
    await expect(bad.sync()).rejects.toThrow("offline");
    expect(A.ids()).toEqual(["a"]);
  });
});
