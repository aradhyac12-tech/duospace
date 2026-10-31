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


/**
 * "Play Next" — pure queue insert. Places `t` directly after `cur`. The queue
 * normally contains the current track; when it doesn't (e.g. empty queue) the
 * current track is put in front first so next() still lands on `t`. Any other
 * copy of `t` is removed (no duplicates); inserting the current track is a no-op.
 */
export function insertAfterCurrent<T extends { id: string }>(queue: T[], cur: T | null, t: T): T[] {
  if (cur && cur.id === t.id) return queue;
  const rest = queue.filter((x) => x.id !== t.id);
  const base = cur && !rest.some((x) => x.id === cur.id) ? [cur, ...rest] : rest;
  const i = cur ? base.findIndex((x) => x.id === cur.id) : -1;
  const at = i < 0 ? 0 : i + 1;
  return [...base.slice(0, at), t, ...base.slice(at)];
}


/**
 * Move one UPCOMING track up (delta < 0) or down (delta > 0) — the accessible alternative to dragging.
 * Only tracks after the current one can move, and never to or before the current track's slot, so the
 * playing song is untouched (no restart). Returns the SAME array when nothing changes.
 */
export function moveUpcoming<T extends { id: string }>(queue: T[], currentId: string | undefined, id: string, delta: number): T[] {
  const ci = currentId === undefined ? -1 : queue.findIndex((x) => x.id === currentId);
  const from = queue.findIndex((x) => x.id === id);
  if (!delta || from < 0 || id === currentId || from <= ci) return queue;
  const to = Math.min(queue.length - 1, Math.max(ci + 1, from + delta));
  if (to === from) return queue;
  const next = queue.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** How many tracks ahead of the current one the native player is given.
 *
 *  WHY 5 (was 2): the native player auto-advances through this window with NO help from JS. Once the
 *  screen is locked / the app is backgrounded the WebView is throttled or frozen, so when the window ran
 *  out the end-of-queue event had to wait for JS to wake up, resolve a stream URL over the network and
 *  call load() — the "music stuck on loading until I open the app" bug. A deeper window lets the native
 *  side keep playing for several songs entirely on its own; the foreground re-sync tops it up again. */
export const NATIVE_AHEAD = 5;

/**
 * What to hand the NATIVE player (ExoPlayer/AVPlayer) as its lookahead window.
 *
 * The native engine auto-advances through whatever window it was given and
 * knows nothing about shuffle, repeat or later queue edits (there is no
 * repeat handling on the native side at all). So the window must be built from
 * the SAME decision the app would make, or the song that plays is not the one
 * the queue shows ("next song is out of my queue"):
 *  - repeat-one → only the current track (never auto-advance away from it);
 *  - shuffle    → current + up to NATIVE_AHEAD not-yet-played picks, remembered in
 *                 `shuffleChain` so a resync does not re-roll them (`shuffleNextId`
 *                 is the chain's head, kept for older callers);
 *  - otherwise  → 1 back, current, NATIVE_AHEAD ahead, in queue order.
 */
export function pickNativeWindow<T extends { id: string }>(args: {
  queue: readonly T[];
  currentId: string;
  shuffle: boolean;
  repeatMode: RepeatMode;
  played: ReadonlySet<string>;
  shuffleNextId?: string | null;
  shuffleChain?: readonly string[] | null;
  random?: () => number;
}): { window: T[]; shuffleNextId: string | null; shuffleChain: string[] } {
  const { queue, currentId, shuffle, repeatMode, played } = args;
  const idx = queue.findIndex((x) => x.id === currentId);
  if (idx < 0) return { window: [], shuffleNextId: null, shuffleChain: [] };
  const cur = queue[idx];
  if (repeatMode === "one") return { window: [cur], shuffleNextId: null, shuffleChain: [] };
  if (!shuffle) {
    return { window: queue.slice(Math.max(0, idx - 1), idx + 1 + NATIVE_AHEAD), shuffleNextId: null, shuffleChain: [] };
  }

  const random = args.random ?? Math.random;
  const byId = new Map(queue.map((x) => [x.id, x] as const));
  const chain: T[] = [];
  const taken = new Set<string>([currentId]);
  // Keep the remembered picks that are still valid (still queued, not current, not already heard).
  const remembered = args.shuffleChain ?? (args.shuffleNextId ? [args.shuffleNextId] : []);
  for (const id of remembered) {
    const t = byId.get(id);
    if (t && !taken.has(id) && !played.has(id) && chain.length < NATIVE_AHEAD) { chain.push(t); taken.add(id); }
  }
  // Top up with fresh random unplayed picks.
  while (chain.length < NATIVE_AHEAD) {
    const pool = queue.filter((x) => !taken.has(x.id) && !played.has(x.id));
    if (pool.length === 0) break;
    const t = pool[Math.floor(random() * pool.length)];
    chain.push(t); taken.add(t.id);
  }
  return { window: [cur, ...chain], shuffleNextId: chain[0]?.id ?? null, shuffleChain: chain.map((x) => x.id) };
}
