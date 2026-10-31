/**
 * Cross-rail de-duplication for the Groic home screen.
 *
 * The home state stacks several rails ("Because you searched…", "Made for
 * you", then one Trending rail per language). A song should not repeat
 * between them — but this must NEVER be able to make a rail disappear.
 *
 * BUG THIS REPLACES: the old code also hid every song that was in the live
 * queue / currently playing. Tapping a song loads its whole rail into the
 * queue, so the moment you played anything the rail you tapped it from (and
 * any other rail sharing those songs) filtered itself down to nothing and
 * the row vanished. Playback state is therefore no longer an input here.
 *
 * Guarantees:
 *  - rails keep their order and are only compared with rails ABOVE them;
 *  - duplicates inside one rail are always dropped;
 *  - a rail never drops below `minKeep` items because of other rails — if
 *    it would, songs it shares with a rail above are put back (in their
 *    original order) rather than hiding the row.
 */
import { trackKey } from "./queueQuality";

export interface DedupeRail<T> { id: string; items: readonly T[]; /** Per-rail floor; overrides opts.minKeep. */ minKeep?: number }

export function dedupeRails<T extends { title: string }>(
  rails: readonly DedupeRail<T>[],
  opts: { minKeep?: number } = {},
): Record<string, T[]> {
  const minKeep = opts.minKeep ?? 4;
  const used = new Set<string>();
  const out: Record<string, T[]> = {};

  for (const rail of rails) {
    const inRail = new Set<string>();
    const fresh: T[] = [];
    const sharedWithAbove: T[] = [];
    for (const item of rail.items) {
      const key = trackKey(item.title);
      if (!key || inRail.has(key)) continue; // empty / repeated inside this rail
      inRail.add(key);
      if (used.has(key)) sharedWithAbove.push(item);
      else fresh.push(item);
    }
    let kept = fresh;
    const floor = rail.minKeep ?? minKeep;
    if (kept.length < floor && sharedWithAbove.length > 0) {
      // Put shared songs back in their ORIGINAL order, up to minKeep.
      const need = floor - kept.length;
      const keepShared = new Set(sharedWithAbove.slice(0, need));
      const freshSet = new Set(fresh);
      kept = rail.items.filter((x) => freshSet.has(x) || keepShared.has(x));
      // `rail.items` may repeat a title; re-apply the in-rail guard.
      const seen = new Set<string>();
      kept = kept.filter((x) => { const k = trackKey(x.title); if (seen.has(k)) return false; seen.add(k); return true; });
    }
    for (const item of kept) used.add(trackKey(item.title));
    out[rail.id] = kept;
  }
  return out;
}
