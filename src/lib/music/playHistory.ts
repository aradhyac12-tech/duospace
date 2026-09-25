/**
 * Cross-session "don't suggest this again" memory.
 *
 * FIX (direct request: "one song should not be suggested again"): the
 * existing up-next dedup (songKey/buildUpNextPool in queueQuality.ts) only
 * ever deduped WITHIN the single pool a track was tapped from — the same
 * search run twice, or two different searches that both surface the same
 * song, could still hand back a song the user already played minutes ago.
 * This module is the missing piece: every actually-played track is
 * recorded here (see GroicContext.playTrack), and buildUpNextPool can be
 * asked to also exclude anything in this history, so a song that was
 * already suggested-and-played recently won't be re-suggested until it
 * ages out of the window below.
 *
 * Deliberately NOT "never suggest again forever" — a small rolling window
 * (not a permanent exclusion) so the pool doesn't shrink to nothing over a
 * long listening session, and so a genuinely-loved song can resurface
 * later. Persisted (like RECENT_KEY/LANG_PREF_KEY elsewhere in Groic) so
 * the memory survives a reload, not just the current tab session.
 */
import { songKey } from "./queueQuality";

const PLAY_HISTORY_KEY = "groic-play-history";
/** How many distinct recently-played songs are excluded from future
 *  suggestions. Large enough to stop the same handful of songs from
 *  looping back immediately, small enough that a session doesn't
 *  eventually exclude everything. */
const HISTORY_WINDOW = 40;

function readHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PLAY_HISTORY_KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Records a track as played, most-recent-first, capped to
 *  HISTORY_WINDOW. Call this once per actual play (not per enqueue) —
 *  see GroicContext.playTrack, the single choke point every play path
 *  (YouTube, Audius, downloads, guest-session sync) already funnels
 *  through. */
export function recordPlayed(title: string): void {
  const key = songKey(title);
  if (!key) return;
  try {
    const next = [key, ...readHistory().filter((k) => k !== key)].slice(0, HISTORY_WINDOW);
    localStorage.setItem(PLAY_HISTORY_KEY, JSON.stringify(next));
  } catch { /* private mode / storage full — suggestions just won't get history-aware, not fatal */ }
}

export function getRecentlyPlayedKeys(): Set<string> {
  return new Set(readHistory());
}
