/**
 * "My playlists" — personal playlists you build from any song (streamed, uploaded or scanned).
 *
 * SCOPE / LIMITS (honest): per signed-in account, per device (localStorage, same scoping as
 * libraryStore.ts). Not synced between phones, not shared with your partner (that is "Our Playlist").
 * Streamed songs keep a slim copy (no stream URL; resolved on play). Uploaded/scanned songs store
 * only their id and are looked up in My Files at read time, so a song removed from My Files
 * simply drops out of the playlist view (it is not deleted from the playlist data until you remove it).
 */
import { useEffect, useState } from "react";
import type { GroicTrack } from "@/lib/music/types";
import { getMusicProfileScope } from "@/lib/music/playHistory";
import { slim, unslim, type StoredTrack } from "@/lib/music/libraryStore";

export interface Playlist { id: string; name: string; createdAt: number; tracks: StoredTrack[] }

const KEY = "groic-my-playlists";
const EVENT = "groic-my-playlists-changed";
export const PLAYLIST_MAX = 50;
export const PLAYLIST_TRACK_MAX = 1000;
export const PLAYLIST_NAME_MAX = 40;

const scopedKey = () => `${KEY}:${getMusicProfileScope()}`;
const cleanName = (n: string) => n.replace(/\s+/g, " ").trim().slice(0, PLAYLIST_NAME_MAX);
const newId = () => `pl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const isStoredTrack = (x: unknown): x is StoredTrack =>
  !!x && typeof x === "object" && typeof (x as StoredTrack).id === "string" && typeof (x as StoredTrack).title === "string"
  && typeof (x as StoredTrack).provider === "string" && typeof (x as StoredTrack).providerTrackId === "string";

export function readPlaylists(): Playlist[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scopedKey()) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.tracks))
      .map((p) => ({ id: p.id, name: p.name, createdAt: Number(p.createdAt) || 0, tracks: p.tracks.filter(isStoredTrack) }));
  } catch { return []; }
}

function write(list: Playlist[]): void {
  try { localStorage.setItem(scopedKey(), JSON.stringify(list)); } catch { /* quota/private mode: best effort */ }
  try { window.dispatchEvent(new Event(EVENT)); } catch { /* non-browser */ }
}

// Local (uploaded/scanned) covers can be big data URLs and change over time: don't persist them here.
const toStored = (t: GroicTrack): StoredTrack => (t.provider === "local" ? { ...slim(t), thumbnail: null } : slim(t));

/** Creates a playlist (optionally seeded with one track). Returns its id, or null if the name is empty / limit reached. */
export function createPlaylist(name: string, first?: GroicTrack): string | null {
  const n = cleanName(name);
  const list = readPlaylists();
  if (!n || list.length >= PLAYLIST_MAX) return null;
  const pl: Playlist = { id: newId(), name: n, createdAt: Date.now(), tracks: first ? [toStored(first)] : [] };
  write([pl, ...list]);
  return pl.id;
}

export function renamePlaylist(id: string, name: string): boolean {
  const n = cleanName(name);
  if (!n) return false;
  const list = readPlaylists();
  const pl = list.find((p) => p.id === id);
  if (!pl) return false;
  pl.name = n;
  write(list);
  return true;
}

export function deletePlaylist(id: string): void { write(readPlaylists().filter((p) => p.id !== id)); }

/** "added" | "duplicate" | "full" | "missing". Newest addition goes to the end, like a normal playlist. */
export function addToPlaylist(id: string, t: GroicTrack): "added" | "duplicate" | "full" | "missing" {
  const list = readPlaylists();
  const pl = list.find((p) => p.id === id);
  if (!pl) return "missing";
  if (pl.tracks.some((x) => x.id === t.id)) return "duplicate";
  if (pl.tracks.length >= PLAYLIST_TRACK_MAX) return "full";
  pl.tracks.push(toStored(t));
  write(list);
  return "added";
}

export function removeFromPlaylist(id: string, trackId: string): void {
  const list = readPlaylists();
  const pl = list.find((p) => p.id === id);
  if (!pl) return;
  pl.tracks = pl.tracks.filter((x) => x.id !== trackId);
  write(list);
}

/**
 * Playable tracks of a playlist. `localById` maps providerTrackId -> current My Files track
 * (fresh cover + title); local songs no longer in My Files are left out of the view.
 */
export function resolvePlaylistTracks(pl: Playlist, localById: Map<string, GroicTrack>): GroicTrack[] {
  const out: GroicTrack[] = [];
  for (const s of pl.tracks) {
    if (s.provider === "local") { const cur = localById.get(s.providerTrackId); if (cur) out.push(cur); }
    else out.push(unslim(s));
  }
  return out;
}

export function usePlaylists(): Playlist[] {
  const [list, setList] = useState<Playlist[]>(readPlaylists);
  useEffect(() => {
    const sync = () => setList(readPlaylists());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener("storage", sync); };
  }, []);
  return list;
}
