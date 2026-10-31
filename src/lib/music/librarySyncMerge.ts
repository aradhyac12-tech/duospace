/**
 * Pure merge logic for syncing Liked Songs + playlists across a user's phones (no I/O, no React).
 *
 * State is a map per collection keyed by item id, each entry carrying a last-change timestamp `at`
 * and, for removals, a tombstone (`del: true`). Merge = per item, the higher `at` wins. Tombstones are
 * what stop an unlike/delete on phone A being resurrected by a stale copy on phone B.
 *
 * Known, accepted limits: a phone offline for longer than TOMBSTONE_TTL_MS can resurrect something
 * another phone removed; two phones editing the SAME playlist at once keep the later edit of the
 * whole playlist (per-playlist last-writer-wins, not per-song).
 */
import type { StoredTrack } from "@/lib/music/libraryStore";
import type { Playlist } from "@/lib/music/playlists";

export interface LikedEntry { at: number; del?: true; t?: StoredTrack }
export interface PlaylistEntry { at: number; del?: true; pl?: Playlist }
export interface SyncState { liked: Record<string, LikedEntry>; playlists: Record<string, PlaylistEntry> }

export const LIKED_CAP = 500;
export const PLAYLIST_CAP = 50;
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const emptyState = (): SyncState => ({ liked: {}, playlists: {} });

/** Key-sorted JSON so equal states compare equal regardless of key order (jsonb reorders keys). */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}
export const stateEq = (a: SyncState, b: SyncState): boolean => canon(a) === canon(b);

const isTrack = (x: unknown): x is StoredTrack =>
  !!x && typeof x === "object" && ["id", "title", "provider", "providerTrackId"].every((k) => typeof (x as Record<string, unknown>)[k] === "string");
const isPlaylist = (x: unknown): x is Playlist =>
  !!x && typeof x === "object" && typeof (x as Playlist).id === "string" && typeof (x as Playlist).name === "string" && Array.isArray((x as Playlist).tracks);

/** Remote data is untrusted: keep only well-formed entries. */
export function sanitizeState(raw: { liked?: unknown; playlists?: unknown } | null | undefined): SyncState {
  const out = emptyState();
  const L = raw?.liked && typeof raw.liked === "object" ? (raw.liked as Record<string, unknown>) : {};
  for (const [id, e] of Object.entries(L)) {
    const en = e as LikedEntry | null;
    if (!en || typeof en.at !== "number" || !Number.isFinite(en.at)) continue;
    if (en.del === true) out.liked[id] = { at: en.at, del: true };
    else if (isTrack(en.t)) out.liked[id] = { at: en.at, t: en.t };
  }
  const P = raw?.playlists && typeof raw.playlists === "object" ? (raw.playlists as Record<string, unknown>) : {};
  for (const [id, e] of Object.entries(P)) {
    const en = e as PlaylistEntry | null;
    if (!en || typeof en.at !== "number" || !Number.isFinite(en.at)) continue;
    if (en.del === true) out.playlists[id] = { at: en.at, del: true };
    else if (isPlaylist(en.pl)) out.playlists[id] = { at: en.at, pl: { ...en.pl, tracks: en.pl.tracks.filter(isTrack) } };
  }
  return out;
}

const plSig = (p: Playlist) => canon({ id: p.id, name: p.name, createdAt: p.createdAt, tracks: p.tracks.map((t) => t.id) });

/**
 * Turn what is in local storage NOW into a state, using `prev` (the last synced state) to know what
 * changed: new items get `at: now`, items that vanished become tombstones, unchanged items keep their `at`.
 * `likedList` is newest-first, so earlier positions get a (slightly) later `at` to preserve the order.
 */
export function diffLocal(prev: SyncState, likedList: StoredTrack[], playlists: Playlist[], now: number): SyncState {
  const next = emptyState();
  const seenL = new Set<string>();
  likedList.forEach((t, i) => {
    seenL.add(t.id);
    const p = prev.liked[t.id];
    next.liked[t.id] = p && !p.del ? { at: p.at, t } : { at: now - i, t };
  });
  for (const [id, p] of Object.entries(prev.liked)) {
    if (seenL.has(id)) continue;
    next.liked[id] = p.del ? p : { at: now, del: true };
  }
  const seenP = new Set<string>();
  for (const pl of playlists) {
    seenP.add(pl.id);
    const p = prev.playlists[pl.id];
    next.playlists[pl.id] = p && !p.del && p.pl && plSig(p.pl) === plSig(pl) ? { at: p.at, pl } : { at: now, pl };
  }
  for (const [id, p] of Object.entries(prev.playlists)) {
    if (seenP.has(id)) continue;
    next.playlists[id] = p.del ? p : { at: now, del: true };
  }
  return next;
}

function pick<E extends { at: number; del?: true }>(a: E | undefined, b: E | undefined): E | undefined {
  if (!a) return b; if (!b) return a;
  if (a.at !== b.at) return a.at > b.at ? a : b;
  if (!!a.del !== !!b.del) return a.del ? a : b; // tie: a removal wins, deterministically
  return a;
}

/** Per-item last-writer-wins merge, then enforce caps (overflow becomes tombstones so devices agree) and drop old tombstones. */
export function mergeStates(a: SyncState, b: SyncState, now: number): SyncState {
  const out = emptyState();
  for (const id of new Set([...Object.keys(a.liked), ...Object.keys(b.liked)])) {
    const e = pick(a.liked[id], b.liked[id]); if (e) out.liked[id] = e;
  }
  for (const id of new Set([...Object.keys(a.playlists), ...Object.keys(b.playlists)])) {
    const e = pick(a.playlists[id], b.playlists[id]); if (e) out.playlists[id] = e;
  }
  const liveL = Object.entries(out.liked).filter(([, e]) => !e.del).sort((x, y) => y[1].at - x[1].at);
  for (const [id] of liveL.slice(LIKED_CAP)) out.liked[id] = { at: now, del: true };
  const liveP = Object.entries(out.playlists).filter(([, e]) => !e.del).sort((x, y) => (y[1].pl?.createdAt ?? 0) - (x[1].pl?.createdAt ?? 0));
  for (const [id] of liveP.slice(PLAYLIST_CAP)) out.playlists[id] = { at: now, del: true };
  for (const col of [out.liked, out.playlists] as Record<string, { at: number; del?: true }>[]) {
    for (const [id, e] of Object.entries(col)) if (e.del && now - e.at > TOMBSTONE_TTL_MS) delete col[id];
  }
  return out;
}

/** Liked list for local storage: live entries, newest first. */
export const toLikedList = (s: SyncState): StoredTrack[] =>
  Object.values(s.liked).filter((e) => !e.del && e.t).sort((x, y) => y.at - x.at).map((e) => e.t as StoredTrack);

/** Playlists for local storage: live entries, newest-created first (matches createPlaylist's prepend). */
export const toPlaylists = (s: SyncState): Playlist[] =>
  Object.values(s.playlists).filter((e) => !e.del && e.pl).map((e) => e.pl as Playlist).sort((x, y) => y.createdAt - x.createdAt);
