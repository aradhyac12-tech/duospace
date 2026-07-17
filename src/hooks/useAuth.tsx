import { useEffect, useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { User } from "@supabase/supabase-js";
import { logError, logInfo, logWarn } from "@/lib/telemetry";

// FIX AUDIT #4: Race condition fixed — use only onAuthStateChange; drop redundant
// getSession call. onAuthStateChange always fires INITIAL_SESSION synchronously
// from cache, so loading goes false on the first tick after mount.
//
// FIX AUDIT #4: Added loading timeout — if auth state hasn't resolved within
// 8 seconds, force loading=false so the app doesn't hang on a blank screen
// (e.g. Supabase client misconfigured, offline on first load).
const AUTH_LOADING_TIMEOUT_MS = 8_000;

export const useAuth = () => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // FIX AUDIT #4: track whether the last token refresh failed
  const [refreshFailed, setRefreshFailed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Safety timeout: if INITIAL_SESSION never fires, unblock the app
    timeoutRef.current = setTimeout(() => {
      logWarn("useAuth", "auth loading timeout — forcing loading=false");
      setLoading(false);
    }, AUTH_LOADING_TIMEOUT_MS);

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      switch (event) {
        case "INITIAL_SESSION":
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          setUser(session?.user ?? null);
          setLoading(false);
          logInfo("useAuth", "initial session resolved", { hasUser: !!session?.user });
          break;

        case "SIGNED_IN":
        case "TOKEN_REFRESHED":
        case "USER_UPDATED":
          setUser(session?.user ?? null);
          setRefreshFailed(false);
          break;

        case "SIGNED_OUT":
          setUser(null);
          break;

        default:
          break;
      }
    });

    return () => {
      subscription.unsubscribe();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // FIX AUDIT #4: Proactive token refresh — attempt to refresh before expiry.
  // FAIL-PATH FIX: guard async setState with a mounted flag (StrictMode-safe)
  // and dedupe in-flight refreshes so concurrent calls don't pile up.
  useEffect(() => {
    if (!user) return;
    let alive = true;
    let inFlight: Promise<void> | null = null;

    const attemptRefresh = async () => {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const { error } = await supabase.auth.refreshSession();
          if (!alive) return;
          if (error) {
            logError("useAuth", "token refresh failed", error);
            setRefreshFailed(true);
          } else {
            setRefreshFailed(false);
          }
        } catch (err) {
          if (!alive) return;
          logError("useAuth", "unexpected error during token refresh", err);
          setRefreshFailed(true);
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    };

    const REFRESH_INTERVAL_MS = 55 * 60 * 1000;
    const id = setInterval(attemptRefresh, REFRESH_INTERVAL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [user]);

  return { user, loading, refreshFailed };
};
