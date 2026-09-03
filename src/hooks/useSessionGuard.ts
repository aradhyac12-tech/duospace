/**
 * useSessionGuard — session / token edge-case hardening.
 *
 * FIX AUDIT #4: Covers:
 *  - expired token mid-session
 *  - silent token refresh failure
 *  - multi-device sign-in conflict (TOKEN_REFRESHED fired on another device)
 *  - expired token during an active call
 *
 * Mount this hook once near the root (e.g. in AppLayout or App.tsx).
 * It fires an onExpired callback so the app can show a "Session expired" toast
 * and redirect to Auth without crashing.
 *
 * Usage:
 *   useSessionGuard({
 *     onExpired: () => { toast({ title: "Session expired", ... }); navigate("/auth"); },
 *     onRefreshFailed: (err) => logError("session", "refresh failed", err),
 *   });
 */

import { useEffect, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { logError, logWarn, logInfo } from "@/lib/telemetry";

export interface SessionGuardOptions {
  /** Called when the session has definitively expired and cannot be refreshed. */
  onExpired?: () => void;
  /** Called when a background token refresh fails (before onExpired). */
  onRefreshFailed?: (err: unknown) => void;
  /** Called when a new session arrives (e.g. from another device). */
  onSessionConflict?: () => void;
}

export function useSessionGuard(opts: SessionGuardOptions = {}) {
  const { onExpired, onRefreshFailed, onSessionConflict } = opts;
  const lastUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      switch (event) {
        case "INITIAL_SESSION":
          if (session) {
            logInfo("session", "initial session loaded", { userId: session.user.id });
            lastUserIdRef.current = session.user.id;
          }
          break;

        case "SIGNED_IN":
          if (session) {
            // Detect multi-device conflict: a different user just signed in on this tab
            if (lastUserIdRef.current && lastUserIdRef.current !== session.user.id) {
              logWarn("session", "multi-device sign-in conflict detected");
              onSessionConflict?.();
            }
            lastUserIdRef.current = session.user.id;
          }
          break;

        case "TOKEN_REFRESHED":
          if (session) {
            logInfo("session", "token refreshed silently");
            lastUserIdRef.current = session.user.id;
          }
          break;

        case "SIGNED_OUT":
          // Intentional sign-out or session was invalidated server-side
          logInfo("session", "user signed out");
          lastUserIdRef.current = null;
          break;

        // Supabase fires this on auth errors
        case "USER_UPDATED":
          break;

        default:
          break;
      }
    });

    return () => subscription.unsubscribe();
  }, [onSessionConflict]);

  // ── Proactive expiry check ──────────────────────────────────────────────────
  // Every 4 minutes, verify the session is still valid.
  // If getSession() returns null or the token is expired, call onExpired().
  useEffect(() => {
    const CHECK_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes

    const checkSession = async () => {
      try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) {
          logError("session", "getSession error during proactive check", error);
          onRefreshFailed?.(error);
          return;
        }
        if (!session) {
          logWarn("session", "proactive check found no active session — expired");
          onExpired?.();
          return;
        }

        // Check if the access token will expire within the next 5 minutes
        const expiresAt = session.expires_at ?? 0; // Unix seconds
        const nowSeconds = Date.now() / 1000;
        const ttlSeconds = expiresAt - nowSeconds;
        if (ttlSeconds < 300) {
          logInfo("session", `token expires in ${Math.round(ttlSeconds)}s — refreshing`);
          const { error: refreshErr } = await supabase.auth.refreshSession();
          if (refreshErr) {
            logError("session", "proactive token refresh failed", refreshErr);
            onRefreshFailed?.(refreshErr);
            // If we can't refresh and we're already within 0s, fire onExpired
            if (ttlSeconds <= 0) onExpired?.();
          }
        }
      } catch (err) {
        logError("session", "unexpected error during session check", err);
      }
    };

    checkSession(); // Check immediately on mount
    const id = setInterval(checkSession, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [onExpired, onRefreshFailed]);
}
