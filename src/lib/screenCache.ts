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
const DEBOUNCE_MS = 800;

export async function readScreenCache<T>(uid: string | null | undefined, name: string): Promise<T | null> {
  if (!uid || !getOfflinePref("screenData")) return null;
  try {
    return (await collectionStore.read<T>(uid, name))?.value ?? null;
  } catch {
    return null;
  }
}

/** Debounced whole-snapshot write. Later calls for the same screen replace earlier pending ones. */
export function writeScreenCache(uid: string | null | undefined, name: string, value: unknown): void {
  if (!uid || !getOfflinePref("screenData")) return;
  const k = `${uid}|${name}`;
  const prev = timers.get(k);
  if (prev) clearTimeout(prev);
  timers.set(k, setTimeout(() => {
    timers.delete(k);
    // A write that was still waiting when the person signed out must not
    // resurrect their data after the wipe (which also destroyed the key it
    // would be re-encrypted under). No persisted session for this user → drop it.
    if (readPersistedSession()?.user.id !== uid) return;
    void collectionStore.write(uid, name, value).catch(() => { /* cache only */ });
  }, DEBOUNCE_MS));
}

export async function clearScreenCache(uid: string | null | undefined, name: string): Promise<void> {
  if (!uid) return;
  const k = `${uid}|${name}`;
  const t = timers.get(k);
  if (t) { clearTimeout(t); timers.delete(k); }
  try { await collectionStore.remove(uid, name); } catch { /* ignore */ }
}
