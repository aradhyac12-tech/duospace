/**
 * Fractional-index ordering for the Couple Playlist.
 *
 * Each row has a `position: number`. The list renders sorted ascending by
 * position. Moving a row only ever needs to write ONE row — its new
 * position is picked to sit strictly between its new neighbors — instead
 * of renumbering the whole list on every drag, which would mean N
 * realtime UPDATE events (and N chances for a race) for a single move.
 *
 * Kept as plain, dependency-free functions so they're unit-testable
 * without React/Supabase in the loop, same pattern as queueLogic.ts.
 */

const GAP = 1000;

/** Position for a brand-new song inserted at the top of the list. */
export function positionForNewTopEntry(existingPositions: number[]): number {
  if (existingPositions.length === 0) return Date.now();
  return Math.min(...existingPositions) - GAP;
}

/**
 * Position for a row moved to `toIndex` (0-based, in the array AFTER the
 * moved row has been removed from its old slot) within `orderedPositions`
 * — the positions of every OTHER row, already sorted ascending.
 *
 * - Moved to the very top: below the current lowest.
 * - Moved to the very bottom: above the current highest.
 * - Moved in between: the midpoint of its new neighbors.
 * - Degenerate case (neighbors collide, e.g. after many inserts at the
 *   exact same spot): falls back to a fresh Date.now()-based value, which
 *   is always higher than any prior GAP-spaced position, so it still
 *   lands correctly on the next sort even though it isn't a true
 *   midpoint. This is a rebalance escape hatch, not the common path.
 */
export function positionForMove(orderedPositions: number[], toIndex: number): number {
  const clamped = Math.max(0, Math.min(toIndex, orderedPositions.length));

  if (orderedPositions.length === 0) return Date.now();
  if (clamped === 0) return orderedPositions[0] - GAP;
  if (clamped >= orderedPositions.length) return orderedPositions[orderedPositions.length - 1] + GAP;

  const before = orderedPositions[clamped - 1];
  const after = orderedPositions[clamped];
  const mid = (before + after) / 2;
  if (mid <= before || mid >= after) return Date.now();
  return mid;
}

/** Sort helper — ascending by position, stable for equal values via id tiebreak. */
export function sortByPosition<T extends { id: string; position: number }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.position - b.position) || a.id.localeCompare(b.id));
}

export interface RealtimeRow {
  id: string;
  updated_at: string;
}

/**
 * Reconciles one incoming realtime INSERT/UPDATE row into a locally-held
 * list, sorted by position afterward.
 *
 * Guards against stale/duplicate/out-of-order delivery — the actual
 * mechanism behind "don't let an older event overwrite a newer local
 * state" (two partners editing the same playlist at once): if the row
 * already present locally has an `updated_at` at or after the incoming
 * row's, the incoming row is a no-op and the list is returned unchanged
 * (same array reference, so a caller doing `prev === next` can tell
 * nothing was applied). Otherwise the row replaces the existing one (or
 * is inserted, if new), and the result is re-sorted by position.
 *
 * Extracted out of Playlist.tsx's realtime handler so this — the one
 * piece of the reordering feature with real race-condition stakes — is
 * unit-testable without a React tree or a Supabase channel in the loop,
 * same reasoning as the rest of this file.
 */
export function reconcileRealtimeRow<T extends RealtimeRow & { id: string; position: number }>(
  prev: T[],
  incoming: T,
): T[] {
  const existing = prev.find((s) => s.id === incoming.id);
  if (existing && new Date(existing.updated_at).getTime() >= new Date(incoming.updated_at).getTime()) {
    return prev;
  }
  const next = existing ? prev.map((s) => (s.id === incoming.id ? incoming : s)) : [incoming, ...prev];
  return sortByPosition(next);
}
