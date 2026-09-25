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
