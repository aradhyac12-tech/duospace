import { createContext, useContext, useEffect, useMemo, useState, useRef, ReactNode } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import type { User } from "@supabase/supabase-js";
import { logError, logInfo, logWarn } from "@/lib/telemetry";
import { notifyCurrentDeviceSignIn } from "@/lib/signinAlert";
import { isOnlineNow, subscribeConnectivity } from "@/lib/connectivity";
import { readPersistedSession } from "@/lib/persistedSession";

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

// ─── OFFLINE-FIRST LAUNCH (2026-09-21) ───────────────────────────────────────
//
// ROOT CAUSE of "the app has zero offline support / reloads everything on
// every launch": supabase-js decides INITIAL_SESSION by calling getSession(),
// and when the stored ACCESS token is expired (it lasts ~1 hour — i.e. on
// almost every real launch) getSession() first tries to REFRESH it over the
// network. Offline (or on a captive/dead network) that refresh fails after a
// long retry/backoff, getSession() returns an error, and supabase-js then
// emits INITIAL_SESSION with `null`. This provider used to read that `null` as
// "signed out", so a signed-in person opening the app without a connection
// saw the boot screen for up to 8s and then the LOGIN screen. Even with a
// connection, nothing could render until the refresh round trip finished.
//
// The fix separates two questions that were conflated:
//   1. "Who is this device signed in as?"  — answerable INSTANTLY and offline,
//      from the session supabase-js already persisted on this device.
//   2. "Is that session still accepted by the server?" — answered in the
//      background; only a real server rejection (refresh token revoked/invalid)
//      ends the session, and supabase-js announces that with SIGNED_OUT.
//
// So the user is now seeded synchronously from the persisted session, the app
// renders immediately from local data, and a `null` INITIAL_SESSION only means
// "signed out" when NO persisted session remains. If one does remain, the
// refresh merely couldn't complete — we stay signed in ("offline session")
// and re-validate as soon as connectivity returns.
//
// SECURITY NOTE: this does not weaken auth — nothing here mints or extends a
// token, and every server call still needs a valid one (they fail until the
// background refresh succeeds). It only stops the UI from pretending the
// person is signed out when the device simply can't reach the server. The app
// lock (biometric/PIN) is unchanged and still gates the UI.

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
  /**
   * True while we are treating this device as signed in on the strength of the
   * locally persisted session because the server could not be reached to
   * re-validate it (offline launch). Clears itself the moment a refresh
   * succeeds; a real rejection signs the user out instead.
   */
  offlineSession: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  // Seeded synchronously from the persisted session (see the OFFLINE-FIRST
  // LAUNCH note above): a returning user renders on the very first frame
  // instead of waiting on a token-refresh round trip.
  const [persisted] = useState(readPersistedSession);
  const [user, setUser] = useState<User | null>(() => persisted?.user ?? null);
  const [loading, setLoading] = useState(() => !persisted);
  const [offlineSession, setOfflineSession] = useState(false);
  const offlineSessionRef = useRef(false);
  offlineSessionRef.current = offlineSession;
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
            // Same person as the persisted snapshot we already rendered with →
            // keep that object so every effect keyed off `user` doesn't re-run
            // (and re-subscribe its realtime channel) a second time at launch.
            const fresh = session.user;
            setUser(prev => (sameUserIdentity(prev, fresh) ? prev : fresh));
            setOfflineSession(false);
          } else {
            // `null` means "signed out" ONLY if nothing is persisted any more.
            // If a session is still on disk, supabase-js simply couldn't
            // refresh it (offline / dead network / server hiccup) — a real
            // rejection deletes the stored session before this fires.
            const stillPersisted = readPersistedSession();
            if (stillPersisted?.hasRefreshToken) {
              setUser(prev => prev ?? stillPersisted.user);
              setOfflineSession(true);
              logWarn("AuthProvider", "session could not be re-validated — staying signed in locally until the network returns");
            } else {
              setUser(null);
              setOfflineSession(false);
            }
          }
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
          // supabase-js re-emits SIGNED_IN on every app resume; keep the same
          // object when it's the same person (see sameUserIdentity above) so a
          // resume doesn't tear down and rebuild every realtime channel.
          setUser(prev => (sameUserIdentity(prev, session?.user ?? null) ? prev : (session?.user ?? null)));
          setRefreshFailed(false);
          setOfflineSession(false);
          break;

        case "TOKEN_REFRESHED":
          // See sameUserIdentity's comment above — keep the existing
          // object reference unless something about the user itself
          // actually changed, so downstream channel-owning effects keyed
          // off `user` don't needlessly resubscribe on every silent
          // refresh.
          setUser(prev => (sameUserIdentity(prev, session?.user ?? null) ? prev : (session?.user ?? null)));
          setRefreshFailed(false);
          setOfflineSession(false);
          break;

        case "USER_UPDATED":
          // This event means the user row itself changed (email/phone/
          // metadata) — always take the new object here.
          setUser(session?.user ?? null);
          setRefreshFailed(false);
          break;

        case "SIGNED_OUT":
          setUser(null);
          setOfflineSession(false);
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

  // OFFLINE SESSION RE-VALIDATION: while we are signed in only locally, ask
  // supabase-js to re-validate the moment connectivity returns or the app comes
  // back to the foreground (its own 30s auto-refresh tick would get there too;
  // this just removes the wait). Outcomes arrive through the normal events
  // above: TOKEN_REFRESHED/SIGNED_IN clear the flag, SIGNED_OUT (a genuine
  // server rejection) signs the person out.
  useEffect(() => {
    const revalidate = () => {
      if (!offlineSessionRef.current || !isOnlineNow()) return;
      void supabase.auth.getSession().catch((error: unknown) => {
        logWarn("AuthProvider", "offline-session re-validation failed", { error });
      });
    };
    const unsubscribe = subscribeConnectivity((online) => { if (online) revalidate(); });
    const onVisible = () => { if (document.visibilityState === "visible") revalidate(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
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
      // Nothing to refresh against while offline — and a failed attempt here
      // would only set `refreshFailed`, which is meant to signal a real
      // problem, not "the phone has no signal".
      if (!isOnlineNow()) return;
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

  // PERF: a fresh object literal here made every useAuth() consumer (30+ call sites)
  // re-render whenever this provider re-rendered for any reason, even when user /
  // loading / refreshFailed were unchanged.
  const value = useMemo(() => ({ user, loading, refreshFailed, offlineSession }), [user, loading, refreshFailed, offlineSession]);

  return (
    <AuthContext.Provider value={value}>
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
