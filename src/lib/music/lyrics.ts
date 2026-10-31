/**
 * Lyrics for the full player.
 *
 * WHY THIS FILE EXISTS: the music player never had lyrics at all — there was
 * no provider, no UI and no cache anywhere in the codebase, which is why
 * "lyrics are missing" (nothing was broken, nothing was ever built).
 *
 * Source: LRCLIB (https://lrclib.net) — free, no API key, no account, and it
 * serves TIME-SYNCED lyrics (LRC) as well as plain text. It is queried
 * straight from the client (public, CORS-enabled GET) so there is no edge
 * function to deploy. Everything here is best-effort: a miss, a timeout or
 * being offline never affects playback, it just shows an empty state.
 *
 * Pure helpers (parseLrc, cleanTrackQuery, pickBestMatch, activeLineIndex)
 * are exported separately from the network/hook code so they are unit-testable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { GroicTrack } from "@/lib/music/types";

export interface LyricLine {
  /** Start time in seconds. */
  t: number;
  text: string;
}

export interface LyricsData {
  /** Time-synced lines, ascending by `t`. null when the song only has plain text. */
  synced: LyricLine[] | null;
  /** Plain (un-timed) text. Always derivable when `synced` exists. */
  plain: string | null;
  /** The song is an instrumental — nothing to show, and that's correct. */
  instrumental: boolean;
}

const API = "https://lrclib.net/api";
const FETCH_TIMEOUT_MS = 8000;
const STORAGE_KEY = "groic:lyrics:v1";
const STORAGE_MAX_ENTRIES = 60;

// ── LRC parsing ─────────────────────────────────────────────────────────────

const TIME_TAG_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Parses an LRC document. Handles multiple timestamps per line
 *  (`[00:10.00][01:20.50]chorus`), 2- or 3-digit fractions, and ignores
 *  metadata tags such as `[ar:Artist]`. Blank lines are dropped. */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps: number[] = [];
    TIME_TAG_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let lastEnd = 0;
    while ((m = TIME_TAG_RE.exec(raw)) !== null) {
      const frac = m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0;
      stamps.push(Number(m[1]) * 60 + Number(m[2]) + frac);
      lastEnd = TIME_TAG_RE.lastIndex;
    }
    if (stamps.length === 0) continue;
    const text = raw.slice(lastEnd).trim();
    if (!text) continue;
    for (const t of stamps) out.push({ t, text });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Index of the line that is "current" at `position` seconds, or -1 before the
 *  first line. Binary search — runs on every position tick. `lead` shows a line
 *  a hair early, which reads as in-sync given render/seek latency. */
export function activeLineIndex(lines: LyricLine[], position: number, lead = 0.25): number {
  const p = position + lead;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= p) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans;
}

// ── Track-title cleanup ─────────────────────────────────────────────────────
// Most tracks come from YouTube, where the "title" is an upload title
// ("Artist - Song (Official Video) | HD") and the "artist" is a channel name
// ("ArtistVEVO", "Artist - Topic"). LRCLIB matches on the real song/artist, so
// both are normalized first.

const NOISE_BRACKET_RE = /[([][^)\]]*(official|video|audio|lyric|lyrics|hd|hq|4k|visuali[sz]er|mv|m\/v|explicit|clean|remaster(ed)?|remix(ed)?|cover|live|acoustic|version|edit|extended|slowed|reverb|sped up|feat\.?|ft\.?|prod\.?)[^)\]]*[)\]]/gi;
const FEAT_TAIL_RE = /\s+(feat\.?|ft\.?|featuring)\s+.*$/i;
const PIPE_TAIL_RE = /\s*[|｜•].*$/;
const CHANNEL_NOISE_RE = /\s*(-\s*topic|vevo|official( channel)?|music|records|entertainment)\s*$/i;

export interface TrackQuery {
  title: string;
  artist: string;
  /** Alternate reading when the upload title looked like "Artist - Song". */
  alt?: { title: string; artist: string };
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function cleanTrackQuery(track: Pick<GroicTrack, "title" | "artist" | "provider">): TrackQuery {
  let title = track.title ?? "";
  let artist = track.artist ?? "";

  title = title.replace(NOISE_BRACKET_RE, " ").replace(PIPE_TAIL_RE, "");
  title = clean(title);
  artist = clean(artist.replace(CHANNEL_NOISE_RE, "").replace(FEAT_TAIL_RE, "").split(/\s*(?:,|&|\bx\b)\s*/i)[0] ?? "");

  const dash = title.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) {
    const left = clean(dash[1]);
    const right = clean(dash[2].replace(FEAT_TAIL_RE, ""));
    // "Artist - Song" (the near-universal upload convention) is the primary
    // reading for the video-style providers; the untouched title/channel pair
    // stays available as the alternate.
    if (track.provider === "youtube" || track.provider === "soundcloud" || !artist) {
      return { title: right, artist: left, alt: { title: clean(title.replace(FEAT_TAIL_RE, "")), artist } };
    }
    return { title: clean(title.replace(FEAT_TAIL_RE, "")), artist, alt: { title: right, artist: left } };
  }
  return { title: clean(title.replace(FEAT_TAIL_RE, "")), artist };
}

// ── Matching ────────────────────────────────────────────────────────────────

interface LrclibRecord {
  id?: number;
  trackName?: string;
  artistName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

/** Best candidate from a result list: prefer synced lyrics, then the closest
 *  duration (a different cut/remaster of the song has different timing, so a
 *  wildly different length is a wrong match for sync purposes). */
export function pickBestMatch(results: LrclibRecord[], duration: number): LrclibRecord | null {
  const usable = results.filter((r) => r && (r.syncedLyrics || r.plainLyrics || r.instrumental));
  if (usable.length === 0) return null;
  const diff = (r: LrclibRecord) => (duration > 0 && r.duration ? Math.abs(r.duration - duration) : 0);
  const score = (r: LrclibRecord) => (r.syncedLyrics ? 0 : 1000) + Math.min(diff(r), 900);
  const ranked = [...usable].sort((a, b) => score(a) - score(b));
  const best = ranked[0];
  // A synced result whose length is way off would scroll out of step with the
  // audio — only accept it when duration is unknown or within 20s.
  if (best.syncedLyrics && duration > 0 && best.duration && diff(best) > 20) {
    const plainOnly = ranked.find((r) => r.plainLyrics);
    return plainOnly ?? best;
  }
  return best;
}

function toLyricsData(r: LrclibRecord): LyricsData {
  const synced = r.syncedLyrics ? parseLrc(r.syncedLyrics) : [];
  const plain = r.plainLyrics?.trim()
    || (synced.length ? synced.map((l) => l.text).join("\n") : null);
  return {
    synced: synced.length >= 2 ? synced : null,
    plain: plain || null,
    instrumental: !!r.instrumental && !synced.length && !plain,
  };
}

// ── Network ─────────────────────────────────────────────────────────────────

async function getJson<T>(url: string, signal: AbortSignal): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  signal.addEventListener("abort", onAbort);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Lyrics service returned ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

/** Resolves lyrics for a track. Returns null when nothing was found (a normal
 *  outcome); throws only for transport failures so the UI can offer Retry. */
export async function fetchLyrics(
  track: Pick<GroicTrack, "title" | "artist" | "provider" | "duration">,
  signal: AbortSignal,
): Promise<LyricsData | null> {
  const q = cleanTrackQuery(track);
  const duration = Math.round(track.duration || 0);
  const readings = [q, ...(q.alt ? [q.alt] : [])].filter((r) => r.title);
  let hadNetworkSuccess = false;
  let lastError: unknown = null;

  const attempt = async <T,>(url: string): Promise<T | null> => {
    try {
      const out = await getJson<T>(url, signal);
      hadNetworkSuccess = true;
      return out;
    } catch (e) {
      if (signal.aborted) throw e;
      lastError = e;
      return null;
    }
  };

  // 1) Exact signature lookup (needs artist + a duration within ±2s).
  for (const r of readings) {
    if (!r.artist || duration <= 0) continue;
    const hit = await attempt<LrclibRecord>(`${API}/get?${qs({ track_name: r.title, artist_name: r.artist, duration })}`);
    if (hit && (hit.syncedLyrics || hit.plainLyrics || hit.instrumental)) return toLyricsData(hit);
  }
  // 2) Structured search, 3) free-text search — each over every reading.
  for (const r of readings) {
    const list = await attempt<LrclibRecord[]>(`${API}/search?${qs({ track_name: r.title, artist_name: r.artist || undefined })}`);
    const best = list ? pickBestMatch(list, duration) : null;
    if (best) return toLyricsData(best);
  }
  for (const r of readings) {
    const list = await attempt<LrclibRecord[]>(`${API}/search?${qs({ q: `${r.artist} ${r.title}`.trim() })}`);
    const best = list ? pickBestMatch(list, duration) : null;
    if (best) return toLyricsData(best);
  }
  if (!hadNetworkSuccess && lastError) throw lastError;
  return null;
}

// ── Cache (memory + localStorage, bounded) ──────────────────────────────────

const mem = new Map<string, LyricsData>();

function readStore(): Record<string, LyricsData> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, LyricsData>) : {};
  } catch { return {}; }
}

function cacheGet(id: string): LyricsData | null {
  const hit = mem.get(id);
  if (hit) return hit;
  const stored = readStore()[id];
  if (stored) { mem.set(id, stored); return stored; }
  return null;
}

function cachePut(id: string, data: LyricsData) {
  mem.set(id, data);
  try {
    const store = readStore();
    delete store[id];            // re-insert at the end = most recent
    store[id] = data;
    const keys = Object.keys(store);
    for (const k of keys.slice(0, Math.max(0, keys.length - STORAGE_MAX_ENTRIES))) delete store[k];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch { /* storage full/unavailable — memory cache still works */ }
}

// ── React hook ──────────────────────────────────────────────────────────────

export type LyricsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: LyricsData }
  | { status: "none" }
  | { status: "error"; message: string };

/** Loads lyrics for `track` while `enabled` (the Lyrics tab is open). Misses
 *  are NOT cached, so reopening the tab or tapping Retry tries again. */
export function useLyrics(track: GroicTrack | null | undefined, enabled: boolean) {
  const [state, setState] = useState<LyricsState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const trackId = track?.id;
  const trackRef = useRef(track);
  trackRef.current = track;

  useEffect(() => {
    const t = trackRef.current;
    if (!enabled || !t || !trackId) return;
    const cached = cacheGet(trackId);
    if (cached) { setState({ status: "ready", data: cached }); return; }
    const ctl = new AbortController();
    setState({ status: "loading" });
    fetchLyrics(t, ctl.signal)
      .then((data) => {
        if (ctl.signal.aborted) return;
        if (data && (data.synced || data.plain || data.instrumental)) {
          cachePut(trackId, data);
          setState({ status: "ready", data });
        } else {
          setState({ status: "none" });
        }
      })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        setState({ status: "error", message: e instanceof Error ? e.message : "Couldn't reach the lyrics service" });
      });
    return () => ctl.abort();
  }, [enabled, trackId, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { state, retry };
}
