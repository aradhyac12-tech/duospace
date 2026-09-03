import { Toaster } from "@/components/ui/toaster";
import { MotionConfig } from "framer-motion";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { ThemeProvider, useTheme } from "@/contexts/ThemeContext";
import { CallProvider } from "@/contexts/CallContext";
import { LocationProvider } from "@/contexts/LocationContext";

import AppLayout from "@/components/AppLayout";
import AppLockScreen from "@/components/AppLockScreen";
import PeekGuard from "@/components/PeekGuard";
import Auth from "@/pages/Auth";
import ResetPassword from "@/pages/ResetPassword";
import Onboarding from "@/pages/Onboarding";
import { useState, useEffect, lazy, Suspense } from "react";
import { supabase } from "@/integrations/supabase/client";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useLaunchPermissions } from "@/hooks/useLaunchPermissions";
import AppBootScreen from "@/components/AppBootScreen";
import { hasAuthCallback, parseAuthCallbackUrl } from "@/lib/auth-callback";
import SplashScreen from "@/components/SplashScreen";
import { useNativeAuthDeepLink } from "@/hooks/useNativeAuthDeepLink";
import { Loader2 } from "lucide-react";

// Lazy chunks with preload handles so we can warm them on app mount / nav hover.
const ChatImport = () => import("@/pages/Chat");
const GalleryImport = () => import("@/pages/Gallery");
const CallsImport = () => import("@/pages/Calls");
const PlaylistImport = () => import("@/pages/Playlist");
const ShayariImport = () => import("@/pages/Shayari");
const MapImport = () => import("@/pages/MapView");
const UsImport = () => import("@/pages/Us");
const SettingsImport = () => import("@/pages/Settings");
const GroicImport = () => import("@/pages/Groic");
const ProfileImport = () => import("@/pages/Profile");
const PartnerSettingsImport = () => import("@/pages/settings/PartnerSettings");
const DevicesSettingsImport = () => import("@/pages/settings/DevicesSettings");
const SecuritySettingsImport = () => import("@/pages/settings/SecuritySettings");
const AppearanceSettingsImport = () => import("@/pages/settings/AppearanceSettings");
const DataBackupSettingsImport = () => import("@/pages/settings/DataBackupSettings");
const ImportSettingsImport = () => import("@/pages/settings/ImportSettings");
const NotificationsSettingsImport = () => import("@/pages/settings/NotificationsSettings");
const LanguageSettingsImport = () => import("@/pages/settings/LanguageSettings");

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
const NotFound = lazy(() => import("@/pages/NotFound"));

// Expose preloaders so FloatingDock can warm a chunk on touchstart/hover.
export const routePreload: Record<string, () => Promise<unknown>> = {
  "/chat": ChatImport,
  "/gallery": GalleryImport,
  "/calls": CallsImport,
  "/playlist": PlaylistImport,
  "/shayari": ShayariImport,
  "/map": MapImport,
  "/us": UsImport,
  "/settings": SettingsImport,
  "/groic": GroicImport,
  "/profile": ProfileImport,
  "/settings/partner": PartnerSettingsImport,
  "/settings/devices": DevicesSettingsImport,
  "/settings/security": SecuritySettingsImport,
  "/settings/appearance": AppearanceSettingsImport,
  "/settings/data": DataBackupSettingsImport,
  "/settings/import": ImportSettingsImport,
  "/settings/notifications": NotificationsSettingsImport,
  "/settings/language": LanguageSettingsImport,
};

import { PageSkeleton } from "@/components/skeletons/PageSkeleton";

const PageFallback = ({ variant = "default" as const }) => <PageSkeleton variant={variant} />;


// Dedicated deep-link form: /surprise/:id folds into the chat query-param form
// so there is only ONE place (ChatSurpriseHost) that actually resolves it.
const SurpriseDeepLink = () => {
  const { id } = useParams();
  return <Navigate to={`/chat?surprise=${encodeURIComponent(id ?? "")}`} replace />;
};

const queryClient = new QueryClient();

const ProtectedRoutes = () => {
  const { user, loading } = useAuth();
  const { isAppLocked } = useTheme();
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
  usePushNotifications();

  useEffect(() => {
    if (!user) {
      setNeedsOnboarding(null);
      return;
    }
    let cancelled = false;
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
        const { data } = result;
        setNeedsOnboarding(!data?.gender);
      } catch {
        if (!cancelled) setNeedsOnboarding(false);
      }
    };
    checkProfile();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Preload all route chunks during idle time so first tab tap is instant.
  useEffect(() => {
    if (!user) return;
    const idle = (cb: () => void) =>
      (window as any).requestIdleCallback?.(cb, { timeout: 1500 }) ?? setTimeout(cb, 600);
    const handle = idle(() => {
      Object.values(routePreload).forEach((p) => { p().catch(() => {}); });
    });
    return () => {
      (window as any).cancelIdleCallback?.(handle);
      clearTimeout(handle as any);
    };
  }, [user]);

  if (loading) return <AppBootScreen />;

  if (!user) return <Navigate to="/auth" replace />;

  if (needsOnboarding === null) {
    return <AppBootScreen label="Setting up..." showBadge={false} />;
  }

  if (needsOnboarding) {
    return <Onboarding onComplete={() => setNeedsOnboarding(false)} />;
  }

  if (isAppLocked) return <AppLockScreen />;

  return <LocationProvider><CallProvider><AppLayout /></CallProvider></LocationProvider>;
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

const App = () => {
  useLaunchPermissions();
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
  <QueryClientProvider client={queryClient}>
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
        <BrowserRouter>
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
              <Route path="/profile" element={<Lazy variant="default" el={<Profile />} />} />
              <Route path="/groic" element={<Lazy variant="list" el={<Groic />} />} />
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
        </BrowserRouter>
      </TooltipProvider>
      </MotionConfig>
    </ThemeProvider>
  </QueryClientProvider>
  );
};

export default App;
