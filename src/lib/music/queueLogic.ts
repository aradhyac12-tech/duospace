/**
 * Pure queue-advancement logic, extracted out of GroicContext so it's
 * actually unit-testable without rendering a React tree — the state
 * machine itself (repeat-one / repeat-all / shuffle / plain sequential /
 * end-of-queue) has no dependency on React, the native engine, or the
 * YouTube IFrame, so it doesn't need to live inside the component to work.
 * GroicContext.tsx's advanceNext()/prev() call into this module rather
 * than reimplementing the same branching inline.
 */
import { RepeatMode } from "./types";

export interface AdvanceResult {
  /** Index into `queue` to play next, or -1 if there's nowhere to go
   *  (empty queue, single-track queue with repeat off, etc.) */
  index: number;
  /** True when the result means "restart the CURRENT track" (repeat-one)
   *  rather than "move to a different index" — index still points at the
   *  current track in this case, callers use this flag to decide whether
   *  to seek-to-zero-and-replay vs. actually load a different track. */
  repeatCurrent: boolean;
}

/** Deterministic when `random` is supplied (tests pass a fixed function);
 *  defaults to Math.random for real playback. */
export function pickNextIndex(
  queueLength: number,
  currentIndex: number,
  shuffle: boolean,
  random: () => number = Math.random,
): number {
  if (queueLength <= 1) return -1;
  if (shuffle) {
    const candidates: number[] = [];
    for (let i = 0; i < queueLength; i++) if (i !== currentIndex) candidates.push(i);
    if (candidates.length === 0) return -1;
    return candidates[Math.floor(random() * candidates.length)];
  }
  return currentIndex + 1 < queueLength ? currentIndex + 1 : -1;
}

/** The full "what happens when a track ends" decision — repeat-one always
 *  wins (restart current track) regardless of queue/shuffle state; then
 *  falls through to pickNextIndex; then wraps around for repeat-all;
 *  otherwise reports "nowhere to go" (index -1) and playback should stop. */
export function resolveAdvance(
  queueLength: number,
  currentIndex: number,
  repeatMode: RepeatMode,
  shuffle: boolean,
  random: () => number = Math.random,
): AdvanceResult {
  if (repeatMode === "one") {
    return { index: currentIndex, repeatCurrent: true };
  }
  let nextIndex = pickNextIndex(queueLength, currentIndex, shuffle, random);
  if (nextIndex === -1 && repeatMode === "all" && queueLength > 0) {
    nextIndex = shuffle ? Math.floor(random() * queueLength) : 0;
  }
  return { index: nextIndex, repeatCurrent: false };
}

// ── Shuffle "bag" ───────────────────────────────────────────────────────────
// pickNextIndex above is memoryless: every pick is uniform over "everything
// but the current track", so a song can repeat after two plays while others
// in the queue are never heard. The functions below add the missing memory:
// a set of already-played ids for the current shuffle cycle. Shuffle only
// picks from tracks NOT yet played this cycle, and a cycle ends when they've
// all been heard (then repeat-all starts a new one; otherwise playback ends
// or auto-next supplies fresh tracks).

export interface ShuffleAdvance extends AdvanceResult {
  /** True when every track had been played and a fresh cycle started
   *  (repeat-all) — the caller should clear its played-set. */
  newCycle: boolean;
}

/** Random index among tracks that are neither current nor already played. */
export function pickUnplayedIndex(
  ids: readonly string[],
  currentId: string | undefined,
  played: ReadonlySet<string>,
  random: () => number = Math.random,
): number {
  const candidates: number[] = [];
  for (let i = 0; i < ids.length; i++) {
    if (ids[i] !== currentId && !played.has(ids[i])) candidates.push(i);
  }
  if (candidates.length === 0) return -1;
  return candidates[Math.floor(random() * candidates.length)];
}

/** Drop-in, shuffle-memory-aware replacement for resolveAdvance. With
 *  shuffle off it is exactly resolveAdvance. */
export function resolveAdvanceWithBag(args: {
  ids: readonly string[];
  currentId: string | undefined;
  repeatMode: RepeatMode;
  shuffle: boolean;
  played: ReadonlySet<string>;
  random?: () => number;
}): ShuffleAdvance {
  const { ids, currentId, repeatMode, shuffle, played } = args;
  const random = args.random ?? Math.random;
  const currentIndex = currentId === undefined ? -1 : ids.indexOf(currentId);

  if (repeatMode === "one") return { index: currentIndex, repeatCurrent: true, newCycle: false };
  if (!shuffle) return { ...resolveAdvance(ids.length, currentIndex, repeatMode, false, random), newCycle: false };

  const unplayed = pickUnplayedIndex(ids, currentId, played, random);
  if (unplayed >= 0) return { index: unplayed, repeatCurrent: false, newCycle: false };

  if (repeatMode === "all" && ids.length > 0) {
    // Everything has been heard: start a new cycle, avoiding an immediate
    // repeat of the track that just finished whenever there's any other.
    const others = ids.map((_, i) => i).filter((i) => i !== currentIndex);
    const index = others.length > 0 ? others[Math.floor(random() * others.length)] : 0;
    return { index, repeatCurrent: false, newCycle: true };
  }
  return { index: -1, repeatCurrent: false, newCycle: false };
}

/** How many tracks are still to come before the queue runs dry — used to
 *  decide when to top the queue up with suggestions. */
export function tracksAhead(
  ids: readonly string[],
  currentId: string | undefined,
  shuffle: boolean,
  played: ReadonlySet<string>,
): number {
  if (shuffle) return ids.filter((id) => id !== currentId && !played.has(id)).length;
  const i = currentId === undefined ? -1 : ids.indexOf(currentId);
  return i < 0 ? ids.length : ids.length - i - 1;
}
