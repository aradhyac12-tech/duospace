/**
 * "Native twin" lookup for YouTube tracks.
 *
 * A YouTube track can't keep playing once the app is backgrounded (the
 * hidden IFrame is suspended by the OS/WebView and YouTube's terms don't
 * allow background play from an embedded player). The app therefore finds
 * the SAME song on a source it can stream natively (SoundCloud / Audius)
 * and hands playback over. This file is the pure matching half of that.
 *
 * Fixes over the old inline matcher in GroicContext:
 *  - songKey() is "" for non-Latin titles (Hindi/Urdu/Arabic/Korean…), so
 *    the old `songKey(a) === songKey(b)` was TRUE for any two such titles
 *    and could hand off to a completely different song. Uses trackKey()'s
 *    raw-title fallback instead.
 *  - requires an artist overlap OR a tight duration match, not just a
 *    similar title (generic titles like "Intro"/"Home" matched anything).
 *  - picks the closest-duration candidate, not the first one.
 */
import type { GroicTrack } from "./types";
import { isNativelyStreamable } from "./types";
import { artistKey, trackKey } from "./autoNext";

const LOOSE_SECONDS = 20;
const TIGHT_SECONDS = 6;

/** Query for "same song, other provider": title without (Official Video)-style
 *  noise + cleaned artist. */
export function buildTwinQuery(cur: Pick<GroicTrack, "title" | "artist">): string {
  const title = cur.title.replace(/[\(\[].*?[\)\]]/g, " ").replace(/\s+/g, " ").trim() || cur.title.trim();
  const artist = artistKey(cur.artist);
  return `${title} ${artist}`.trim();
}

const artistsOverlap = (a: string, b: string): boolean => {
  const x = artistKey(a);
  const y = artistKey(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
};

export function findNativeTwin(
  cur: Pick<GroicTrack, "id" | "title" | "artist" | "duration">,
  candidates: readonly GroicTrack[],
): GroicTrack | null {
  const want = trackKey(cur);
  if (!want) return null;
  let best: { t: GroicTrack; diff: number } | null = null;
  for (const t of candidates) {
    if (!t || t.id === cur.id || !isNativelyStreamable(t)) continue;
    if (trackKey(t) !== want) continue;
    const known = cur.duration > 0 && t.duration > 0;
    const diff = known ? Math.abs(t.duration - cur.duration) : 0;
    if (known && diff > LOOSE_SECONDS) continue;
    const sameArtist = artistsOverlap(cur.artist, t.artist);
    if (!sameArtist && !(known && diff <= TIGHT_SECONDS)) continue;
    if (!best || diff < best.diff) best = { t, diff };
  }
  return best ? best.t : null;
}
