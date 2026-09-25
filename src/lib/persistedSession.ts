import type { User } from "@supabase/supabase-js";

/**
 * The session supabase-js last persisted on this device, read synchronously —
 * the basis of the offline-first launch (see the OFFLINE-FIRST LAUNCH note in
 * contexts/AuthContext.tsx). Kept in its own file so it is unit-testable
 * without the Supabase client.
 */
export interface PersistedSession {
  user: User;
  hasRefreshToken: boolean;
}

/**
 * The session supabase-js last persisted on this device, read synchronously.
 * supabase-js stores it as JSON under `sb-<project-ref>-auth-token`. Returns
 * null when there isn't one (never signed in, or signed out — signOut() and
 * a server-side rejection both delete this key).
 */
export function readPersistedSession(): PersistedSession | null {
  try {
    if (typeof localStorage === "undefined") return null;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.+-auth-token$/.test(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { user?: User; refresh_token?: unknown; currentSession?: { user?: User; refresh_token?: unknown } };
      const src = parsed?.user ? parsed : parsed?.currentSession;
      const u = src?.user;
      if (u && typeof u.id === "string" && u.id.length > 0) {
        return { user: u, hasRefreshToken: typeof src?.refresh_token === "string" && (src.refresh_token as string).length > 0 };
      }
    }
  } catch {
    /* unreadable / unavailable storage — fall back to waiting for INITIAL_SESSION */
  }
  return null;
}
