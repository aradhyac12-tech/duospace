/**
 * Per-user cache for the small pieces of account data the Settings screens
 * show (username, partner display name, notification sounds, …).
 *
 * WHY: those screens used to fetch on every open and treat a failed fetch as
 * an answer — offline, the Settings hub read "Not connected yet" and the
 * Partner screen offered the "link a partner" flow to someone who IS linked.
 * A stale-but-real value beats a wrong-looking default; the screens now paint
 * from here first and let the network correct it.
 *
 * Scope is deliberately narrow: display-level profile facts only (the same
 * class of data partnerCache.ts already keeps in plain storage). Nothing
 * secret, no message content. Keyed by user id and removed on sign-out.
 */
import storage from "@/lib/storage";

const PREFIX = "duo-settings-cache-v1-";
const keyFor = (uid: string, name: string) => `${PREFIX}${uid}::${name}`;

export function readSettingsCache<T>(uid: string | undefined | null, name: string): T | null {
  if (!uid) return null;
  return storage.getJSON<T | null>(keyFor(uid, name), null);
}

export function writeSettingsCache(uid: string | undefined | null, name: string, value: unknown): void {
  if (!uid) return;
  storage.setJSON(keyFor(uid, name), value);
}

/** Remove every cached settings value for this user (sign-out). */
export function clearSettingsCache(uid: string): void {
  try {
    const prefix = `${PREFIX}${uid}::`;
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) doomed.push(k);
    }
    doomed.forEach((k) => storage.remove(k));
  } catch { /* storage unavailable — nothing to clear */ }
}
