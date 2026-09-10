import { createContext, useContext, useEffect, useState, useRef, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import type { User } from "@supabase/supabase-js";
import { logError, logInfo, logWarn } from "@/lib/telemetry";
import { notifyCurrentDeviceSignIn } from "@/lib/signinAlert";

// PERF/RELIABILITY FIX (Phase 1 #1): this used to live entirely inside the
// useAuth() hook itself, which meant every call site (33+ across the app)
// mounted its own `supabase.auth.onAuthStateChange()` subscription, its own
// 55-minute proactive-refresh `setInterval`, and its own SIGNED_IN handler —
// so a single sign-in event could fire `notifyCurrentDeviceSignIn()` and the
// refresh timer once per mounted consumer instead of once for the whole app.
// The subscription/timer/state now live exactly once, here, behind a
// context. useAuth() (src/hooks/useAuth.tsx) is now a thin
// `useContext(AuthContext)` — every existing call site is unchanged.
//
// FIX AUDIT #4 (carried over): use only onAuthStateChange; no redundant
// getSession call. onAuthStateChange always fires INITIAL_SESSION
// synchronously from cache, so loading goes false on the first tick after
// mount — this also means there is no race between an initial getSession()
// fetch and the first onAuthStateChange event, because there is only one.
const AUTH_LOADING_TIMEOUT_MS = 8_000;

async function ensureProfile(user: User): Promise<void> {
  const metadata = user.user_metadata ?? {};
  const displayName = String(
    metadata.full_name ??
    metadata.name ??
    metadata.preferred_username ??
    user.email?.split("@")[0] ??
    "DuoSpace user",
  ).trim() || "DuoSpace user";
  const avatarUrl = typeof metadata.avatar_url === "string"
    ? metadata.avatar_url
    : typeof metadata.picture === "string"
      ? metadata.picture
      : null;

  const { error } = await supabase.from("profiles").upsert(
    {
      user_id: user.id,
      display_name: displayName,
      avatar_url: avatarUrl,
    },
    { onConflict: "user_id", ignoreDuplicates: true },
  );

  if (error && error.code !== "23505") throw error;
}

// RELIABILITY FIX (reconnect-storm root cause): Supabase's
// onAuthStateChange hands back a brand-new `session` (and therefore a
// brand-new `session.user` object) on every TOKEN_REFRESHED event — which
// fires silently roughly once an hour (plus once from this app's own
// proactive-refresh timer below) for as long as the app stays open, even
// though nothing about the signed-in user actually changed. Every hook
// app-wide that keys a realtime channel/effect off `user` by object
// identity (useChatRealtimeMessages, useChatTyping, useChatPresence,
// useActiveChatPresence, IncomingCallOverlay's own subscriptions, and any
// call-related effect that takes `user` as a dependency) was tearing down
// and recreating its Supabase channel on every one of these refreshes —
// a real "reconnect storm" (section 6) and, worse, a real missed-message
// window (section 5): any INSERT/UPDATE/broadcast that lands in the gap
// between removeChannel() and the new subscribe() resolving is silently
// lost, because postgres_changes has no backlog replay.
// `updated_at` on the Supabase User reflects the auth.users row's last
// real modification (email/phone/metadata change) — it does NOT change
// on a token refresh — so comparing id+email+phone+updated_at lets us
// tell "just a token rotated" apart from "the user actually changed"
// without needing to know every field a caller might rely on.
function sameUserIdentity(a: User | null, b: User | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.email === b.email && a.phone === b.phone && a.updated_at === b.updated_at;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  refreshFailed: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  // FIX AUDIT #4: track whether the last token refresh failed
  const [refreshFailed, setRefreshFailed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Phase 1 #2: a timeout means "we don't know yet", not "signed out" — it
  // only ever forces `loading` to false so the app doesn't hang on a blank
  // screen. It never touches `user`, so an already-resolved session (or one
  // that resolves a moment later) is never clobbered into a false
  // logged-out state by the safety timer.
  const timedOutRef = useRef(false);

  useEffect(() => {
    // Safety timeout: if INITIAL_SESSION never fires, unblock the app
    // without asserting an auth state we don't actually know.
    timeoutRef.current = setTimeout(() => {
      logWarn("AuthProvider", "auth loading timeout — forcing loading=false");
      timedOutRef.current = true;
      setLoading(false);
    }, AUTH_LOADING_TIMEOUT_MS);

    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      switch (event) {
        case "INITIAL_SESSION":
          if (timeoutRef.current) {
            clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          if (session?.user) {
            void ensureProfile(session.user).catch((error) => {
              logWarn("AuthProvider", "profile bootstrap skipped", { error });
            });
          }
          setUser(session?.user ?? null);
          setLoading(false);
          logInfo("AuthProvider", "initial session resolved", { hasUser: !!session?.user, afterTimeout: timedOutRef.current });
          break;

        case "SIGNED_IN":
          logInfo("AuthProvider", "onAuthStateChange fired: SIGNED_IN", { hasUser: !!session?.user, userId: session?.user?.id ?? null });
          void notifyCurrentDeviceSignIn();
          if (session?.user) {
            void ensureProfile(session.user).catch((error) => {
              logWarn("AuthProvider", "profile bootstrap skipped", { error });
            });
          }
          setUser(session?.user ?? null);
          setRefreshFailed(false);
          break;

        case "TOKEN_REFRESHED":
          // See sameUserIdentity's comment above — keep the existing
          // object reference unless something about the user itself
          // actually changed, so downstream channel-owning effects keyed
          // off `user` don't needlessly resubscribe on every silent
          // refresh.
          setUser(prev => (sameUserIdentity(prev, session?.user ?? null) ? prev : (session?.user ?? null)));
          setRefreshFailed(false);
          break;

        case "USER_UPDATED":
          // This event means the user row itself changed (email/phone/
          // metadata) — always take the new object here.
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
  // and dedupe in-flight refreshes so concurrent calls don't pile up. Now
  // runs exactly once app-wide instead of once per useAuth() consumer.
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
            logError("AuthProvider", "token refresh failed", error);
            setRefreshFailed(true);
          } else {
            setRefreshFailed(false);
          }
        } catch (err) {
          if (!alive) return;
          logError("AuthProvider", "unexpected error during token refresh", err);
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

  return (
    <AuthContext.Provider value={{ user, loading, refreshFailed }}>
      {children}
    </AuthContext.Provider>
  );
};

/** Internal accessor used by the public useAuth() hook. Throws loudly if
 *  AuthProvider isn't mounted above the caller — that's a wiring bug, not a
 *  state to silently fall back from. */
export const useAuthContext = (): AuthContextValue => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth() must be used within <AuthProvider>");
  }
  return ctx;
};
