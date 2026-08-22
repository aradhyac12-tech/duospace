/**
 * Registers concrete recovery handlers with `@/lib/errors/recovery` using
 * DuoSpace's existing primitives. Kept as a separate module (rather than
 * editing useAuth/ThemeContext/resumableUpload directly) so wiring the
 * error system can't change the behavior of those modules — it only
 * *adds* an auto-recovery path on top of what they already expose.
 *
 * Call once at boot, after the modules being wired are importable
 * (supabase client has no init order dependency, so this is safe to call
 * from main.tsx immediately after `errorManager.init()`).
 *
 * Extension point: feature modules that own a more specific retry (a
 * particular upload, a particular socket) should call
 * `registerRecovery(...)` themselves near that logic instead of adding
 * more cases here — this file only covers the handlers with no natural
 * "owning" module.
 */
import { supabase } from "@/integrations/supabase/client";
import { logInfo, logWarn } from "@/lib/telemetry";
import { registerRecovery } from "./recovery";

export function registerAppRecoveries(): void {
  // DS-AUTH-002 (session expired) → try a real Supabase session refresh.
  registerRecovery("refresh-session", async () => {
    try {
      const { data, error } = await supabase.auth.refreshSession();
      if (error || !data.session) {
        logWarn("errors/recovery", "refresh-session failed", { error: error?.message });
        return false;
      }
      logInfo("errors/recovery", "refresh-session succeeded");
      return true;
    } catch {
      return false;
    }
  });

  // DS-CHAT-002 / DS-SYNC-* (Supabase transient failures) → a lightweight
  // reachability probe. Callers should still re-run their own specific
  // query/mutation; this only tells the manager whether Supabase is back.
  registerRecovery("retry-supabase", async () => {
    try {
      const { error } = await supabase.from("profiles").select("id").limit(1);
      return !error;
    } catch {
      return false;
    }
  });

  // "resume-upload" and "reconnect-socket" and "restore-previous-theme"
  // are intentionally left unregistered here — they need state that only
  // the owning module has (the in-flight upload handle, the socket
  // instance, the last-known-good theme). Falls back to a no-op until a
  // feature module calls `registerRecovery(...)` itself. See resumableUpload.ts,
  // useDailyCall.ts, and ThemeContext.tsx for natural call sites.
}
