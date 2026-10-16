/**
 * Best-effort facade over the encrypted collection store for screens that want
 * "paint from the last known data, then let the network correct it".
 *
 *   const cached = await readScreenCache<MyShape>(user.id, "shayari");
 *   …fetch, set state…
 *   writeScreenCache(user.id, "shayari", { …current state… });   // debounced
 *
 * Never throws (storage trouble degrades to "no cache", i.e. the old behaviour),
 * honours the person's "Keep app data on this phone" switch, and never stores
 * for a missing user id. Values must be JSON-serialisable.
 */
import { collectionStore } from "@/lib/localDb";
import { getOfflinePref } from "@/lib/offlineSettings";
import { readPersistedSession } from "@/lib/persistedSession";

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Latest value waiting to be written, per `${uid}|${name}`. */
const pending = new Map<string, { uid: string; name: string; value: unknown }>();
const DEBOUNCE_MS = 800;

export async function readScreenCache<T>(uid: string | null | undefined, name: string): Promise<T | null> {
  if (!uid || !getOfflinePref("screenData")) return null;
  try {
    return (await collectionStore.read<T>(uid, name))?.value ?? null;
  } catch {
    return null;
  }
}

/** Write the pending value for `k` now (if any). Never throws. */
async function commit(k: string): Promise<void> {
  const t = timers.get(k);
  if (t) { clearTimeout(t); timers.delete(k); }
  const p = pending.get(k);
  if (!p) return;
  pending.delete(k);
  // A write that was still waiting when the person signed out must not
  // resurrect their data after the wipe (which also destroyed the key it
  // would be re-encrypted under). No persisted session for this user → drop it.
  if (readPersistedSession()?.user.id !== p.uid) return;
  try { await collectionStore.write(p.uid, p.name, p.value); } catch { /* cache only */ }
}

/** Debounced whole-snapshot write. Later calls for the same screen replace earlier pending ones. */
export function writeScreenCache(uid: string | null | undefined, name: string, value: unknown): void {
  if (!uid || !getOfflinePref("screenData")) return;
  const k = `${uid}|${name}`;
  pending.set(k, { uid, name, value });
  const prev = timers.get(k);
  if (prev) clearTimeout(prev);
  timers.set(k, setTimeout(() => { void commit(k); }, DEBOUNCE_MS));
}

/**
 * Write every snapshot that is still waiting out its debounce, right now.
 *
 * WHY: the 800 ms debounce means the newest data of a screen could be lost if
 * the app was backgrounded or swiped away inside that window — the next offline
 * open then showed an older snapshot. Called automatically when the page is
 * hidden (see the listeners below); also callable directly.
 */
export async function flushScreenCache(): Promise<void> {
  await Promise.allSettled([...pending.keys()].map((k) => commit(k)));
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushScreenCache();
  });
  window.addEventListener("pagehide", () => { void flushScreenCache(); });
}

export async function clearScreenCache(uid: string | null | undefined, name: string): Promise<void> {
  if (!uid) return;
  const k = `${uid}|${name}`;
  const t = timers.get(k);
  if (t) { clearTimeout(t); timers.delete(k); }
  pending.delete(k);
  try { await collectionStore.remove(uid, name); } catch { /* ignore */ }
}
