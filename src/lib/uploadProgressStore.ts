/**
 * Tiny external store for in-flight upload progress, keyed by the optimistic
 * message id.
 *
 * WHY THIS EXISTS (photo/file sends made the whole chat lag): progress used to
 * be written into `messages` state on every percentage tick
 * (`setMessages(prev => prev.map(...))`). Every write produced a new `messages`
 * array, and Chat.tsx re-derives a great deal from that array — the persisted
 * chat cache diff, the search index, the merged/sorted/date-grouped timeline
 * (O(n log n) over the WHOLE conversation), the timeline re-render and the
 * per-bubble prop comparison for every message. A 5 MB photo on a mobile
 * connection emits dozens of ticks, so the entire conversation was being
 * recomputed dozens of times just to move a tiny ring.
 *
 * Progress is now published here and only the <UploadProgressRing> of the
 * specific bubble that is uploading subscribes to it (useSyncExternalStore),
 * so a tick re-renders one small SVG and nothing else. `messages` state is
 * still used for the discrete transitions (sending -> sent / failed).
 */
import { useSyncExternalStore } from "react";

const progressById = new Map<string, number>();
const listenersById = new Map<string, Set<() => void>>();

function notify(id: string) {
  listenersById.get(id)?.forEach((l) => l());
}

/** Publish a new progress value (0-100) for one in-flight upload. */
export function setUploadProgress(id: string, pct: number): void {
  if (progressById.get(id) === pct) return;
  progressById.set(id, pct);
  notify(id);
}

/** Forget an upload's progress once it has finished, failed or been replaced. */
export function clearUploadProgress(id: string): void {
  if (!progressById.has(id)) return;
  progressById.delete(id);
  notify(id);
}

function subscribe(id: string, cb: () => void): () => void {
  let set = listenersById.get(id);
  if (!set) { set = new Set(); listenersById.set(id, set); }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listenersById.delete(id);
  };
}

/** Latest live progress for `id`, or `undefined` if none has been published. */
export function useUploadProgress(id: string): number | undefined {
  return useSyncExternalStore(
    (cb) => subscribe(id, cb),
    () => progressById.get(id),
    () => undefined,
  );
}
