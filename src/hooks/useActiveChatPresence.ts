import { useEffect, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

const HEARTBEAT_MS = 15_000;

/**
 * Keeps `active_chat_presence` fresh while — and ONLY while — the person
 * is genuinely looking at their thread with `partnerId`, so send-push can
 * skip a redundant message push for a conversation that's already on
 * screen (see the "3.5" skip step in supabase/functions/send-push/index.ts
 * and the active_chat_presence migration's doc comment for the full
 * rationale).
 *
 * "Genuinely looking at it" is deliberately stricter than "this component
 * is mounted": Chat.tsx can stay mounted while the OS backgrounds the app
 * (screen locked, app swapped away), and a push absolutely should still
 * fire in that case — someone locking their phone mid-conversation is
 * exactly when they need the notification. Two independent signals gate
 * the heartbeat, matching the dual-signal pattern already used by
 * usePeekDetection for the same "is this screen actually visible" problem:
 *   - document.visibilitychange — covers web and is the primary signal
 *     everywhere Capacitor's plugin isn't available.
 *   - Capacitor's native appStateChange — visibilitychange isn't always
 *     reliable inside a native WebView when the screen locks or another
 *     app takes focus, so this is the more direct native-only signal.
 * Either one reporting "not visible" stops the heartbeat and clears the
 * row immediately (best-effort) rather than waiting for it to go stale —
 * the 20s server-side freshness window in send-push is a safety net for a
 * missed beat or a crashed tab, not the primary way this turns off.
 */
export function useActiveChatPresence(partnerId: string | null) {
  const { user } = useAuth();
  const clearedRef = useRef(true);

  useEffect(() => {
    if (!user || !partnerId) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const beat = async () => {
      clearedRef.current = false;
      try {
        await supabase.from("active_chat_presence").upsert(
          { user_id: user.id, partner_id: partnerId, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        );
      } catch {
        /* best-effort — a missed heartbeat just means a push isn't
           suppressed this one time, never a user-facing failure */
      }
    };

    const clear = () => {
      // Avoid a redundant delete call on every rapid blur/focus flicker —
      // only actually clear once per "became hidden" transition.
      if (clearedRef.current) return;
      clearedRef.current = true;
      supabase
        .from("active_chat_presence")
        .delete()
        .eq("user_id", user.id)
        .then(() => {}, () => {});
    };

    const start = () => {
      if (intervalId) return;
      beat();
      intervalId = setInterval(beat, HEARTBEAT_MS);
    };

    const stop = () => {
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
      clear();
    };

    if (document.visibilityState === "visible") start();

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    let removeAppStateListener: (() => void) | undefined;
    if (Capacitor.isNativePlatform()) {
      (async () => {
        try {
          const { App } = await import("@capacitor/app");
          const sub = await App.addListener("appStateChange", ({ isActive }) => {
            if (!isActive) stop();
            else if (document.visibilityState === "visible") start();
          });
          if (cancelled) { sub.remove(); return; }
          removeAppStateListener = () => sub.remove();
        } catch { /* plugin unavailable — visibilitychange still covers it */ }
      })();
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      removeAppStateListener?.();
      stop();
    };
  }, [user, partnerId]);
}
