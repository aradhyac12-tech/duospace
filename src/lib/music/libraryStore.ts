/**
 * Local music library — Liked Songs + Recently Played (full tracks).
 *
 * WHY: playHistory.ts only keeps song *keys* (enough to avoid repeats, not
 * enough to render a "Recently played" shelf or a Liked Songs list). This
 * stores a slim copy of each track so the home screen can show real covers
 * and replay them in one tap.
 *
 * SCOPE / LIMITS (honest):
 *  - Per signed-in account (localStorage, same scoping as playHistory.ts), and Liked Songs are
 *    mirrored to Supabase `music_library` by librarySync.ts so they follow the ACCOUNT across phones.
 *    Recently Played stays per-device. NOT shared between partners (that is "Our Playlist").
 *  - `streamUrl` is never stored (stream URLs expire); the player resolves
 *    a fresh one on play, exactly like Our Playlist rows already do.
 */
import { toast } from "sonner";
import { useEffect, useState } from "react";
import type { GroicTrack } from "@/lib/music/types";
import { getMusicProfileScope } from "@/lib/music/playHistory";

const LIKED_KEY = "groic-liked";
const RECENT_KEY = "groic-recent-tracks";
const LIKED_MAX = 500;
const RECENT_MAX = 30;

/** The subset of a track that is safe + useful to persist. */
export type StoredTrack = Pick<
  GroicTrack,
  "id" | "provider" | "providerTrackId" | "videoId" | "title" | "artist" | "thumbnail" | "duration" | "permalink" | "isStreamable" | "isDownloadable"
>;

const EVENT = "groic-library-changed";
export const LIBRARY_EVENT = EVENT;
const scopedKey = (base: string) => `${base}:${getMusicProfileScope()}`;

export const slim = (t: GroicTrack): StoredTrack => ({
  id: t.id,
  provider: t.provider,
  providerTrackId: t.providerTrackId,
  videoId: t.videoId,
  title: t.title,
  artist: t.artist,
  thumbnail: t.thumbnail ?? t.artwork ?? null,
  duration: t.duration ?? 0,
  permalink: t.permalink,
  isStreamable: t.isStreamable,
  isDownloadable: t.isDownloadable,
});

/** Rehydrate into a playable GroicTrack (no streamUrl — resolved on play). */
export const unslim = (s: StoredTrack): GroicTrack => ({ ...s, artwork: s.thumbnail });

const isStored = (x: unknown): x is StoredTrack =>
  !!x && typeof x === "object"
  && typeof (x as StoredTrack).id === "string"
  && typeof (x as StoredTrack).title === "string"
  && typeof (x as StoredTrack).provider === "string"
  && typeof (x as StoredTrack).providerTrackId === "string";

function read(base: string): StoredTrack[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey(base)) || "[]");
    return Array.isArray(raw) ? raw.filter(isStored) : [];
  } catch {
    return [];
  }
}

function write(base: string, list: StoredTrack[], max: number): void {
  try { localStorage.setItem(scopedKey(base), JSON.stringify(list.slice(0, max))); } catch { toast.error("Couldn't save — phone storage is full or blocked."); }
  try { window.dispatchEvent(new Event(EVENT)); } catch { /* non-browser (tests) */ }
}

// ── Liked songs ─────────────────────────────────────────────────────────────
export const readLiked = (): StoredTrack[] => read(LIKED_KEY);
export const isLiked = (id: string): boolean => readLiked().some((t) => t.id === id);

/** Returns the NEW liked state. Newest like goes first. */
export function toggleLiked(t: GroicTrack): boolean {
  const list = readLiked();
  const has = list.some((x) => x.id === t.id);
  write(LIKED_KEY, has ? list.filter((x) => x.id !== t.id) : [slim(t), ...list], LIKED_MAX);
  return !has;
}

/** Sync only: replace Liked Songs with the merged cross-device list. */
export const replaceLiked = (list: StoredTrack[]): void => write(LIKED_KEY, list, LIKED_MAX);

// ── Recently played tracks ──────────────────────────────────────────────────
export const readRecentTracks = (): StoredTrack[] => read(RECENT_KEY);

/** Call once per actual play. Moves a repeat play to the front (no dupes). */
export function recordRecentTrack(t: GroicTrack): void {
  if (!t?.id || !t.title) return;
  write(RECENT_KEY, [slim(t), ...readRecentTracks().filter((x) => x.id !== t.id)], RECENT_MAX);
}

export function clearRecentTracks(): void {
  write(RECENT_KEY, [], RECENT_MAX);
}

// ── React hooks (re-read on any library change, account switch, or other tab) ─
function useLibrary(reader: () => StoredTrack[]): StoredTrack[] {
  const [list, setList] = useState<StoredTrack[]>(reader);
  useEffect(() => {
    const sync = () => setList(reader());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", sync); };
  }, [reader]);
  return list;
}

export const useLikedTracks = (): StoredTrack[] => useLibrary(readLiked);
export const useRecentTracks = (): StoredTrack[] => useLibrary(readRecentTracks);

/** Cheap per-track like state for a heart button. */
export function useIsLiked(id: string | undefined): boolean {
  const liked = useLikedTracks();
  return !!id && liked.some((t) => t.id === id);
}
