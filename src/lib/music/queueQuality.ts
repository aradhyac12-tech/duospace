/**
 * Pure helpers behind the "up next" queue-quality fix (dedup by song,
 * shuffle for variety) — see Groic.tsx's onPlay for where these are used,
 * and docs/UI_REDESIGN_BUG_REGISTER.md BUG-11 for the full "bad guy
 * everywhere" writeup. Extracted here (rather than kept as Groic.tsx
 * locals) so the actual normalization/shuffle logic is unit-testable.
 */

const NOISE_RE = /[\(\[][^)\]]*(official|video|audio|lyric|lyrics|hd|hq|4k|visualizer|mv|explicit|clean|remaster(ed)?|remix(ed)?|cover|live|acoustic|version|edit|extended|slowed|reverb|sped up)[^)\]]*[\)\]]/gi;
// "Song - Cover by Someone" / "Song - Live at X": everything after a
// standalone dash is upload/attribution annotation, not the song name.
// Without this, "Bad Guy - Cover by Someone" produced a DIFFERENT key than
// "Bad Guy" and covers still stacked in the up-next queue (see
// musicQueueQuality.test.ts's "core 'bad guy everywhere' fix" case).
const DASH_ATTRIBUTION_RE = /\s+[-–—]\s+.*$/;
const FEAT_RE = /\b(feat\.?|ft\.?|featuring)\b.*/i;
// Apostrophes vanish outright ("Don't" ≡ "dont") instead of becoming the
// space every other punctuation run becomes — they're intra-word, and the
// old behavior made contraction-containing titles unmatchable to their own
// plain-text forms.
const APOSTROPHE_RE = /['\u2019]/g;
const PUNCT_RE = /[^a-z0-9]+/g;

/** Normalizes a title down to "the song, ignoring version/upload noise" —
 *  two different uploads of the literal same song should produce the same
 *  key, so the queue never stacks multiple covers/remixes of one track
 *  back-to-back. */
export const songKey = (title: string): string =>
  title.toLowerCase()
    .replace(NOISE_RE, " ")
    .replace(DASH_ATTRIBUTION_RE, " ")
    .replace(FEAT_RE, " ")
    .replace(APOSTROPHE_RE, "")
    .replace(PUNCT_RE, " ")
    .trim();

/** Identity of a track for de-duplication, safe for EVERY script.
 *
 *  songKey() only keeps a-z0-9, so a title written in Devanagari, Gurmukhi,
 *  Tamil, Arabic, Hangul… normalizes to "" — and every such song then
 *  "equals" every other one. That is what made whole Hindi / Marathi /
 *  Haryanvi / Punjabi rails collapse to a single card (or vanish when one
 *  of their songs was already queued), and made the up-next pool drop
 *  every non-Latin song except the tapped one. Latin titles keep exactly
 *  the songKey() value (so stored play history stays valid); titles with
 *  no Latin letters fall back to the same noise-stripping done on Unicode
 *  letters/digits instead. */
export const trackKey = (title: string): string => {
  const latin = songKey(title);
  if (latin) return latin;
  return (title || "").toLowerCase()
    .replace(NOISE_RE, " ")
    .replace(DASH_ATTRIBUTION_RE, " ")
    .replace(FEAT_RE, " ")
    .replace(APOSTROPHE_RE, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
};

/** Fisher-Yates. Accepts an injectable `random` so tests can assert exact
 *  output for a given deterministic sequence rather than only "the output
 *  is *a* permutation of the input". */
export function shuffled<T>(arr: T[], random: () => number = Math.random): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** The actual "build the up-next pool" step: drop the tapped track and
 *  anything sharing its song key, then shuffle what's left.
 *
 *  FIX ("one song should not be suggested again"): now also accepts an
 *  optional `excludeKeys` set (recently-played song keys — see
 *  playHistory.ts) so a song already played recently doesn't immediately
 *  resurface as an "up next" suggestion just because it happens to be in
 *  the current search pool too. Applied with a graceful fallback: if
 *  excluding history would leave the pool empty (e.g. the user has
 *  played almost everything in a small result set), history exclusion is
 *  dropped rather than handing back an empty "up next" — a stale
 *  suggestion is better than none. */
export function buildUpNextPool<T extends { title: string; id?: string }>(
  pool: T[],
  tapped: T,
  idOf: (t: T) => string,
  random: () => number = Math.random,
  excludeKeys?: Set<string>,
): T[] {
  const tappedKey = trackKey(tapped.title);
  const base = pool.filter((x) => idOf(x) !== idOf(tapped) && trackKey(x.title) !== tappedKey);
  if (excludeKeys && excludeKeys.size > 0) {
    const withHistory = base.filter((x) => !excludeKeys.has(trackKey(x.title)));
    if (withHistory.length > 0) return shuffled(withHistory, random);
    // Fallback: history would exclude everything — fall through to `base`.
  }
  return shuffled(base, random);
}


/** "Same name family": two titles where one is the other plus extra words
 *  ("Payal" vs "Payal Ki Jhankar" vs "Payal (Remix)"). Compares on trackKey()s
 *  and requires the shorter title to appear as a CONTIGUOUS run of whole words
 *  in the longer one. Very short keys (< 4 chars once joined) only match
 *  exactly — "Tum" must not make every "Tum …" song a relative.
 *
 *  This is what stops a search for / song called "payal" from queueing six
 *  more songs called "payal": exact-key dedup (above) only catches identical
 *  titles, not the whole family a title search returns. */
export function sameNameFamily(keyA: string, keyB: string): boolean {
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;
  const a = keyA.split(" ").filter(Boolean);
  const b = keyB.split(" ").filter(Boolean);
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.join("").length < 4) return false;
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((tok, j) => long[i + j] === tok)) return true;
  }
  return false;
}

/** Drop the tapped song's whole name family from a pool (rails: trending,
 *  recents, liked…) — keeps the tapped track itself. */
export function withoutSameName<T extends { title: string }>(pool: T[], tapped: T): T[] {
  const k = trackKey(tapped.title);
  return pool.filter((x) => x === tapped || !sameNameFamily(trackKey(x.title), k));
}

/** Up-next for a track tapped from SEARCH results.
 *
 *  A search pool is "everything matching the query", so queueing it as-is
 *  gives you the same word over and over (search "payal" → every next song
 *  is a "payal"). Here the pool only supplies a few *different* songs: no
 *  title in the tapped song's family, none that merely contains the search
 *  words, at most `maxPerArtist` per artist, `limit` in total. The rest of
 *  the queue comes from taste-based suggestions (autoNext.ts), which top it
 *  up as soon as the track starts. */
export function buildSearchUpNext<T extends { title: string; artist?: string }>(
  pool: T[],
  tapped: T,
  idOf: (t: T) => string,
  query: string,
  opts: { limit?: number; maxPerArtist?: number; random?: () => number; excludeKeys?: Set<string> } = {},
): T[] {
  const limit = opts.limit ?? 4;
  const maxPerArtist = opts.maxPerArtist ?? 2;
  const tappedKey = trackKey(tapped.title);
  const queryKey = trackKey(query);
  const base = pool.filter((x) => {
    if (idOf(x) === idOf(tapped)) return false;
    const k = trackKey(x.title);
    if (!k || sameNameFamily(k, tappedKey) || sameNameFamily(k, queryKey)) return false;
    return !(opts.excludeKeys && opts.excludeKeys.has(k));
  });
  const out: T[] = [];
  const perArtist = new Map<string, number>();
  const seen = new Set<string>();
  for (const x of shuffled(base, opts.random ?? Math.random)) {
    const k = trackKey(x.title);
    const a = (x.artist ?? "").toLowerCase().trim();
    if (seen.has(k) || (a && (perArtist.get(a) ?? 0) >= maxPerArtist)) continue;
    seen.add(k);
    perArtist.set(a, (perArtist.get(a) ?? 0) + 1);
    out.push(x);
    if (out.length >= limit) break;
  }
  return out;
}
