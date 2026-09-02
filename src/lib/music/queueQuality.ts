/**
 * Pure helpers behind the "up next" queue-quality fix (dedup by song,
 * shuffle for variety) — see Groic.tsx's onPlay for where these are used,
 * and docs/UI_REDESIGN_BUG_REGISTER.md BUG-11 for the full "bad guy
 * everywhere" writeup. Extracted here (rather than kept as Groic.tsx
 * locals) so the actual normalization/shuffle logic is unit-testable.
 */

const NOISE_RE = /[\(\[][^)\]]*(official|video|audio|lyric|lyrics|hd|hq|4k|visualizer|mv|explicit|clean|remaster(ed)?)[^)\]]*[\)\]]/gi;
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
  const tappedKey = songKey(tapped.title);
  const base = pool.filter((x) => idOf(x) !== idOf(tapped) && songKey(x.title) !== tappedKey);
  if (excludeKeys && excludeKeys.size > 0) {
    const withHistory = base.filter((x) => !excludeKeys.has(songKey(x.title)));
    if (withHistory.length > 0) return shuffled(withHistory, random);
    // Fallback: history would exclude everything — fall through to `base`.
  }
  return shuffled(base, random);
}
