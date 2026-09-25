import { Toaster } from "@/components/ui/toaster";
import { MotionConfig } from "framer-motion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider, useTheme } from "@/contexts/ThemeContext";
import { CallProvider } from "@/contexts/CallContext";
import { LocationProvider } from "@/contexts/LocationContext";

import AppLayout from "@/components/AppLayout";
import AppLockScreen from "@/components/AppLockScreen";
import Auth from "@/pages/Auth";
import ResetPassword from "@/pages/ResetPassword";
import Onboarding from "@/pages/Onboarding";
import { useState, useEffect, lazy, Suspense } from "react";
import { supabase } from "@/integrations/supabase/appClient";
import storage from "@/lib/storage";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useNotificationSoundSync } from "@/hooks/useNotificationSoundSync";
import { useLaunchPermissions } from "@/hooks/useLaunchPermissions";
import AppBootScreen from "@/components/AppBootScreen";
import LocationAccessGate from "@/components/LocationAccessGate";
import { hasAuthCallback, parseAuthCallbackUrl } from "@/lib/auth-callback";
import SplashScreen from "@/components/SplashScreen";
import { useNativeAuthDeepLink } from "@/hooks/useNativeAuthDeepLink";
import { Loader2 } from "lucide-react";
import PeekGuard from "@/components/PeekGuard";
import { claimPendingQrPartnerLink } from "@/lib/qrPartnerClaim";
import { toast } from "@/hooks/use-toast";

// FIX (DS-UNKNOWN-001 — recurring "Cannot access '<x>' before initialization"
// crash on every app boot, thrown from inside the Suspense boundary around
// PeekGuard, immediately under TooltipProvider/MotionConfig): PeekGuard was
// dynamically imported purely as a bundle-size optimization (see history
// below) — it's rendered unconditionally at the App root on every session
// regardless of whether Peek Guard is even enabled, so the dynamic import()
// bought no real deferral of work, just an extra async chunk boundary. That
// boundary was landing PeekGuard's chunk and lucide-react's per-icon chunks
// in a circular/misordered relationship in Rollup's output — deterministic
// per build, reproducible on every load of an affected bundle — where
// PeekGuard's module executed before a helper it depends on had finished
// initializing. Switching back to a static import removes the async chunk
// boundary entirely, which removes the cross-chunk ordering hazard by
// construction rather than by tuning Rollup's chunking heuristics again.
// (lucide-react is also now pinned to its own manualChunks entry in
// vite.config.ts as defense in depth, but this is the fix that actually
// guarantees the class of bug can't recur for PeekGuard specifically.)
//
// Original bundle-size rationale, kept for context: component +
// usePeekDetection.ts + faceRecognition.ts + faceMath.ts + moodScoring.ts +
// peekEventLog.ts (~2,750 lines combined) were all in the entry chunk for
// every session regardless of whether Peek Guard is even enabled. The
// MediaPipe WASM/model load itself was already correctly deferred inside
// faceRecognition.ts (dynamic import) — only the JS that decides whether to
// call it wasn't. That trade-off is no longer worth the correctness risk.
import {
  routePreload,
  ChatImport,
  GalleryImport,
  CallsImport,
  PlaylistImport,
  ShayariImport,
  MapImport,
  UsImport,
  SettingsImport,
  GroicImport,
  ProfileImport,
  PartnerSettingsImport,
  DevicesSettingsImport,
  SecuritySettingsImport,
  AppearanceSettingsImport,
  DataBackupSettingsImport,
  ImportSettingsImport,
  NotificationsSettingsImport,
  LanguageSettingsImport,
  PrivacyAISettingsImport,
  ReflectionImport,
} from "@/lib/routePreload";

const Chat = lazy(ChatImport);
const Gallery = lazy(GalleryImport);
const Calls = lazy(CallsImport);
const Playlist = lazy(PlaylistImport);
const Shayari = lazy(ShayariImport);
const MapView = lazy(MapImport);
const Us = lazy(UsImport);
const Settings = lazy(SettingsImport);
const Groic = lazy(GroicImport);
const Profile = lazy(ProfileImport);
const PartnerSettings = lazy(PartnerSettingsImport);
const DevicesSettings = lazy(DevicesSettingsImport);
const SecuritySettings = lazy(SecuritySettingsImport);
const AppearanceSettings = lazy(AppearanceSettingsImport);
const DataBackupSettings = lazy(DataBackupSettingsImport);
const ImportSettings = lazy(ImportSettingsImport);
const NotificationsSettings = lazy(NotificationsSettingsImport);
const LanguageSettings = lazy(LanguageSettingsImport);
const PrivacyAISettings = lazy(PrivacyAISettingsImport);
const Reflection = lazy(ReflectionImport);
const NotFound = lazy(() => import("@/pages/NotFound"));

// routePreload itself now lives in "@/lib/routePreload" (re-exported below
// for any code that still does `import { routePreload } from "@/App"`),
// so components in lazily-loaded chunks never need to import this module.
export { routePreload } from "@/lib/routePreload";

import { PageSkeleton } from "@/components/skeletons/PageSkeleton";

const PageFallback = ({ variant = "default" as const }) => <PageSkeleton variant={variant} />;


// Dedicated deep-link form: /surprise/:id folds into the chat query-param form
// so there is only ONE place (ChatSurpriseHost) that actually resolves it.
const SurpriseDeepLink = () => {
  const { id } = useParams();
  return <Navigate to={`/chat?surprise=${encodeURIComponent(id ?? "")}`} replace />;
};

const queryClient = new QueryClient();

// FIX ("Setting up..." on every launch): whether this account has finished
// onboarding is a property that essentially never changes after the first
// time, but it used to be re-derived from a network round trip on EVERY
// launch, with a full-screen "Setting up..." blocker until it returned (up to
// 8s on a slow connection). Remember the confirmed answer per user so a
// returning user goes straight into the app; the check below still runs in
// the background and corrects course if the server disagrees.
const onboardedKey = (userId: string) => `duo-onboarded-${userId}`;

// SECOND FIX ("Setting up..." still appearing): the remembered flag above only
// exists after ONE successful check has completed on this install — so the
// first launch after an update/reinstall, a cleared WebView storage, or any
// launch where the profile request times out (slow/blocked network) all still
// blocked on "Setting up...". An account that is more than a day old is, in
// practice, always one that finished onboarding, so those launches now go
// straight into the app too; the background check still runs and sends the
// person to onboarding if the server says they genuinely haven't finished.
// Brand-new accounts (< 24h) keep the blocking check, since they're the ones
// who may really still be mid-onboarding.
const ESTABLISHED_ACCOUNT_MS = 24 * 60 * 60 * 1000;
const isEstablishedAccount = (createdAt: string | undefined): boolean => {
  const t = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(t) && Date.now() - t > ESTABLISHED_ACCOUNT_MS;
};

const ProtectedRoutes = () => {
  const { user, loading } = useAuth();
  const { isAppLocked } = useTheme();
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  usePushNotifications();
  useNotificationSoundSync();

  useEffect(() => {
    if (!user) {
      setNeedsOnboarding(null);
      return;
    }
    let cancelled = false;
    const cacheKey = onboardedKey(user.id);
    const cachedOnboarded = storage.get(cacheKey) === "1" || isEstablishedAccount(user.created_at);
    const checkProfile = async () => {
      try {
        const query = supabase
          .from("profiles")
          .select("gender, display_name")
          .eq("user_id", user.id)
          .single();
        // Post-auth (esp. right after a native OAuth handoff, where the app
        // was just backgrounded for the system browser) this request can
        // stall indefinitely on some devices instead of erroring — that
        // left needsOnboarding stuck at null forever, i.e. the "Setting
        // up..." screen that never resolves even though sign-in itself
        // already succeeded. Race it against a timeout so this screen can
        // never hang the app: on timeout, err on the side of NOT forcing
        // onboarding (treat as returning user) so we don't wrongly show
        // the onboarding flow to an already-onboarded user with flaky network.
        const timeout = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 8000),
        );
        const result = await Promise.race([query, timeout]);
        if (cancelled) return;
        if (result === "timeout") {
          setNeedsOnboarding(false);
          return;
        }
        const { data, error } = result;
        // A failed request (offline, flaky network) says nothing about
        // onboarding. If we already know this account finished it, trust
        // that instead of letting an error be read as "no profile yet".
        if (error && cachedOnboarded) return;
        const needs = !data?.gender;
        if (needs) storage.remove(cacheKey);
        else storage.set(cacheKey, "1");
        setNeedsOnboarding(needs);
      } catch {
        if (!cancelled) setNeedsOnboarding(false);
      }
    };
    checkProfile();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // PERF FIX (Phase 1 #3): this used to warm every authenticated route's
  // lazy chunk (all 18, including rarely-opened screens like every
  // individual Settings subpage) on idle right after login — defeating
  // most of the point of lazy-loading Chat/Gallery/Calls/Playlist/Shayari/
  // Map/Us/Settings/Groic/Profile/etc. as separate chunks in the first
  // place, since authenticated startup ended up downloading essentially
  // the whole app anyway.
  //
  // Chat and Calls are already warmed instantly via onPointerDown on the
  // dock tabs themselves (DockNavRow.tsx) the moment a finger/cursor
  // touches down — before the tap even completes — so they don't need an
  // idle warm here too. What's left to guess at ahead of time is only the
  // two "frequent" tier hub destinations (DUO_HUB_ITEMS in
  // duoHubItems.ts — Gallery and Groic/Music, the two most-opened
  // non-dock screens by product design), since the sparkle Hub has no
  // pointerdown-level warning before its own tap-through navigation.
  // Every other route (Playlist, Shayari, Map, Us, Settings and its many
  // subpages, Profile) stays purely lazy — fetched only when actually
  // navigated to, same as before this fix existed.
  useEffect(() => {
    if (!user) return;
    const idle = (cb: () => void) =>
      (window as any).requestIdleCallback?.(cb, { timeout: 1500 }) ?? setTimeout(cb, 600);
    // FLICKER FIX: previously only /gallery and /groic were warmed, so the
    // first visit to any other page unmounted the current screen and flashed
    // its skeleton while the chunk downloaded. Now EVERY page chunk is warmed
    // after the first render — the likely-next ones first, then the rest —
    // ONE chunk per idle slot so warm-up never competes with scrolling or an
    // animation. Chunks are small and cached; a fetch failure is harmless
    // (the page just loads on demand as before).
    const ORDER = ["/gallery", "/groic", ...Object.keys(routePreload).filter((p) => p !== "/gallery" && p !== "/groic")];
    let cancelled = false;
    let handle: unknown;
    const next = (i: number) => {
      if (cancelled || i >= ORDER.length) return;
      handle = idle(() => {
        if (cancelled) return;
        routePreload[ORDER[i]]?.().catch(() => {}).finally(() => next(i + 1));
      });
    };
    next(0);
    return () => {
      cancelled = true;
      (window as any).cancelIdleCallback?.(handle);
      clearTimeout(handle as any);
    };
  }, [user]);

  // Finish a QR partner link that was started while this device had no account
  // (either it showed a QR while signed out, or it scanned a partner's invite QR
  // from the sign-up screen). A no-op when nothing is pending. See
  // lib/qrPartnerClaim.ts for why this can't happen at sign-up time.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void claimPendingQrPartnerLink(user.id).then((outcome) => {
      if (cancelled) return;
      if (outcome.status === "linked") {
        toast({ title: "Linked ✓", description: "You're now partners." });
      } else if (outcome.status === "failed") {
        toast({ title: "Couldn't finish linking", description: outcome.reason, variant: "destructive" });
      }
    });
    return () => { cancelled = true; };
  }, [user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <AppBootScreen />;

  if (!user) return <Navigate to="/auth" replace />;

  // Known-onboarded accounts skip the blocking "Setting up..." screen — see
  // onboardedKey above. Only a first-ever check (nothing remembered) waits.
  const knownOnboarded =
    storage.get(onboardedKey(user.id)) === "1" || isEstablishedAccount(user.created_at);
  const effectiveNeedsOnboarding = needsOnboarding ?? (knownOnboarded ? false : null);

  if (effectiveNeedsOnboarding === null) {
    return <AppBootScreen label="Setting up..." showBadge={false} />;
  }

  if (effectiveNeedsOnboarding) {
    return (
      <Onboarding
        onComplete={() => {
          storage.set(onboardedKey(user.id), "1");
          setNeedsOnboarding(false);
        }}
      />
    );
  }

  if (isAppLocked) return <AppLockScreen />;

  // MANDATORY LOCATION (launch gate): LocationProvider mounts first so its
  // permission-request lifecycle (see LocationContext.tsx) is already
  // in-flight, then LocationAccessGate blocks everything under it — Chat,
  // Calls, the whole shell — until that permission is actually granted.
  // See LocationAccessGate.tsx's header comment for why this is a hard
  // gate rather than a dismissible sheet like the other media permissions.
  return (
    <LocationProvider>
      <LocationAccessGate>
        <CallProvider><AppLayout /></CallProvider>
      </LocationAccessGate>
    </LocationProvider>
  );
};

/** Suspense wrapper that shows the right skeleton per route. */
const Lazy = ({ el, variant }: { el: React.ReactNode; variant: "chat" | "grid" | "list" | "map" | "settings" | "default" }) => (
  <Suspense fallback={<PageSkeleton variant={variant} />}>{el}</Suspense>
);

const AuthRoute = () => {
  const { user, loading } = useAuth();
  // FIX: this used to `return null` while loading — invisible on its own,
  // but only actually blank in practice once the splash (which now waits
  // on this same `loading` flag, see App.tsx) isn't covering it: a page
  // reload skips the splash entirely (sessionStorage guard) and lands
  // straight here, so a null return was a real blank screen on reload too,
  // not just a splash-timing edge case. Match ProtectedRoutes' loading UI
  // instead of showing nothing.
  if (loading) return <AppBootScreen />;
  if (window.location.pathname === "/auth/callback" && hasAuthCallback()) return <Auth />;
  if (user) {
    const params = new URLSearchParams(window.location.search);
    const callback = hasAuthCallback() ? parseAuthCallbackUrl() : null;
    if (callback?.get("type") === "recovery") return <Navigate to="/reset-password" replace />;
    const pendingInvite = params.get("invite") || sessionStorage.getItem("duo-pending-invite");
    if (pendingInvite) return <Navigate to={`/settings/partner?invite=${encodeURIComponent(pendingInvite)}`} replace />;
    return <Navigate to="/chat" replace />;
  }
  return <Auth />;
};

/** Mounted once, always, inside the Router — regardless of current route or
 *  auth state. See useNativeAuthDeepLink's header comment for exactly why
 *  this can't live inside Auth.tsx alone (it used to, and that was the bug:
 *  "nothing listens for the deep link that returns from the browser"
 *  whenever Auth.tsx wasn't the currently-mounted screen). Renders a
 *  lightweight blocking overlay while a deep link is actively being
 *  processed — deliberately minimal (not Auth.tsx's fuller AmbientGlow
 *  treatment) since this can now interrupt ANY screen, not just the auth
 *  one, and needs to look reasonable doing so everywhere.
 */
const GlobalDeepLinkListener = () => {
  const { processing } = useNativeAuthDeepLink();
  if (!processing) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-7 w-7 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Completing sign in…</p>
      </div>
    </div>
  );
};

// PERF/RELIABILITY FIX (Phase 1 #1): split out from App() so that
// useAuth() is called from a component mounted *inside* <AuthProvider>
// rather than the component that renders <AuthProvider> itself — same
// render tree and behavior as before, just wired through the singleton
// context instead of App() owning its own auth subscription.
const AppContent = () => {
  // FIX: splash previously handed off on a fixed timer regardless of
  // whether auth state had resolved yet. When it hadn't (cold native
  // launch, slow secure-storage read), AuthRoute/ProtectedRoutes render
  // nothing while their own `loading` is true — splash would disappear
  // into a blank screen for however much longer auth took. Gate the
  // splash's minimum-hold exit on this same loading flag so the handoff
  // never lands on a blank frame; see SplashScreen's `ready` prop.
  const { loading: authLoading } = useAuth();
  // Cinematic splash plays once per cold boot. sessionStorage (not a React
  // state default) so a page reload mid-session doesn't replay it, but a
  // genuinely fresh app launch (new session) always does.
  const [showSplash, setShowSplash] = useState(() => !sessionStorage.getItem("duo-splash-shown"));
  const handleSplashDone = () => {
    sessionStorage.setItem("duo-splash-shown", "1");
    setShowSplash(false);
  };
  return (
    <ThemeProvider>
      {/* reducedMotion="user": every motion.* component in the app checks
          prefers-reduced-motion automatically from here down. This is the
          real fix for motion-sensitivity accessibility — the existing CSS
          transition-duration override in index.css only ever caught plain
          CSS transitions/animations, not Framer Motion's JS/RAF-driven
          animations, which is what the vast majority of this app's motion
          (chat bubbles, theme studio, gesture handles, splash) actually is. */}
      <MotionConfig reducedMotion="user">
      <TooltipProvider>
        {/* Sonner's <Toaster/> was mounted here previously but every call
            site in the app uses the shadcn useToast()/<Toaster/> pair
            (src/hooks/use-toast.ts) — `toast()` from the "sonner" package
            itself is never imported anywhere. That left two overlapping
            toast viewports mounted at once. Removed the unused one
            (src/components/ui/sonner.tsx is kept in the tree, just no
            longer rendered, in case a future feature wants Sonner's
            promise/stacked-toast API specifically). */}
        <Toaster />
        <PeekGuard />
        {showSplash && <SplashScreen onComplete={handleSplashDone} ready={!authLoading} />}
        {/* v7_startTransition: navigations run as React transitions, so a page
            that is still loading keeps the current screen visible instead of
            flashing a fallback. */}
        <BrowserRouter future={{ v7_startTransition: true }}>
          <GlobalDeepLinkListener />
          <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/auth" element={<AuthRoute />} />
            <Route path="/auth/callback" element={<AuthRoute />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/index" element={<Navigate to="/chat" replace />} />
            <Route path="/surprise/:id" element={<SurpriseDeepLink />} />
            <Route element={<ProtectedRoutes />}>
              <Route path="/chat" element={<Lazy variant="chat" el={<Chat />} />} />
              <Route path="/gallery" element={<Lazy variant="grid" el={<Gallery />} />} />
              <Route path="/calls" element={<Lazy variant="list" el={<Calls />} />} />
              <Route path="/playlist" element={<Lazy variant="list" el={<Playlist />} />} />
              <Route path="/shayari" element={<Lazy variant="list" el={<Shayari />} />} />
              <Route path="/map" element={<Lazy variant="map" el={<MapView />} />} />
              <Route path="/us" element={<Lazy variant="list" el={<Us />} />} />
              <Route path="/settings" element={<Lazy variant="settings" el={<Settings />} />} />
              <Route path="/settings/partner" element={<Lazy variant="default" el={<PartnerSettings />} />} />
              <Route path="/settings/devices" element={<Lazy variant="default" el={<DevicesSettings />} />} />
              <Route path="/settings/security" element={<Lazy variant="default" el={<SecuritySettings />} />} />
              <Route path="/settings/appearance" element={<Lazy variant="default" el={<AppearanceSettings />} />} />
              <Route path="/settings/data" element={<Lazy variant="default" el={<DataBackupSettings />} />} />
              <Route path="/settings/import" element={<Lazy variant="default" el={<ImportSettings />} />} />
              <Route path="/settings/notifications" element={<Lazy variant="default" el={<NotificationsSettings />} />} />
              <Route path="/settings/language" element={<Lazy variant="default" el={<LanguageSettings />} />} />
              <Route path="/settings/privacy-ai" element={<Lazy variant="default" el={<PrivacyAISettings />} />} />
              <Route path="/profile" element={<Lazy variant="default" el={<Profile />} />} />
              <Route path="/groic" element={<Lazy variant="list" el={<Groic />} />} />
              <Route path="/reflection" element={<Lazy variant="list" el={<Reflection />} />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  );
};

const App = () => {
  useLaunchPermissions();
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </QueryClientProvider>
  );
};

export default App;
