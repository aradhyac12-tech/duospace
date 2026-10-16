import { useEffect } from "react";
import { useAuth } from "@/hooks/useAuth";
import { subscribeConnectivity } from "@/lib/connectivity";
import { setActiveSoundUser, syncSoundPrefs } from "@/lib/notificationSoundPrefs";

/**
 * Keeps the selected message sound / call ringtone in step with the server
 * for the whole signed-in session (mounted once, in ProtectedRoutes):
 *   - points in-app playback (chat ping, incoming-call ring) at this user's
 *     saved choice, synchronously, from the first render after sign-in;
 *   - on sign-in, reconnect and app resume: pushes a choice that failed to
 *     save earlier, or adopts a change made on another device;
 *   - re-applies the ringtone to iOS CallKit every time (a fresh install or
 *     second device never opened Settings, so it would otherwise ring default).
 *
 * Keyed on `user?.id`, not the user object — supabase-js hands out a new
 * object on every token refresh and this must not re-run for those.
 */
export function useNotificationSoundSync(): void {
  const { user } = useAuth();
  const userId = user?.id ?? null;

  useEffect(() => {
    setActiveSoundUser(userId);
    if (!userId) return;

    let cancelled = false;
    const run = () => { if (!cancelled) void syncSoundPrefs(userId); };
    run();

    const unsubscribe = subscribeConnectivity((online) => { if (online) run(); });
    const onVisible = () => { if (document.visibilityState === "visible") run(); };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      cancelled = true;
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);
}
