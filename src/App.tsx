import { Toaster } from "@/components/ui/toaster";
import { MotionConfig } from "framer-motion";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { ThemeProvider, useTheme } from "@/contexts/ThemeContext";
import { CallProvider } from "@/contexts/CallContext";

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
import storage from "@/lib/storage";
import { hasAuthCallback, parseAuthCallbackUrl } from "@/lib/auth-callback";
import SplashScreen from "@/components/SplashScreen";

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

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <div className="h-10 w-10 rounded-full bg-muted mx-auto flex items-center justify-center">
            <span className="text-sm font-semibold text-muted-foreground">
              {(storage.get("duo-app-name") || "DS").slice(0, 2).toUpperCase()}
            </span>
          </div>
          <p className="text-xs text-muted-foreground animate-pulse">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  if (needsOnboarding === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <p className="text-xs text-muted-foreground animate-pulse">Setting up...</p>
      </div>
    );
  }

  if (needsOnboarding) {
    return <Onboarding onComplete={() => setNeedsOnboarding(false)} />;
  }

  if (isAppLocked) return <AppLockScreen />;

  return <CallProvider><AppLayout /></CallProvider>;
};

/** Suspense wrapper that shows the right skeleton per route. */
const Lazy = ({ el, variant }: { el: React.ReactNode; variant: "chat" | "grid" | "list" | "map" | "settings" | "default" }) => (
  <Suspense fallback={<PageSkeleton variant={variant} />}>{el}</Suspense>
);

const AuthRoute = () => {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (window.location.pathname === "/auth/callback" && hasAuthCallback()) return <Auth />;
  if (user) {
    const params = new URLSearchParams(window.location.search);
    const callback = hasAuthCallback() ? parseAuthCallbackUrl() : null;
    if (callback?.get("type") === "recovery") return <Navigate to="/reset-password" replace />;
    const pendingInvite = params.get("invite") || sessionStorage.getItem("duo-pending-invite");
    if (pendingInvite) return <Navigate to={`/settings?invite=${encodeURIComponent(pendingInvite)}`} replace />;
    return <Navigate to="/chat" replace />;
  }
  return <Auth />;
};

const App = () => {
  useLaunchPermissions();
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
        <Toaster />
        <Sonner />
        <PeekGuard />
        {showSplash && <SplashScreen onComplete={handleSplashDone} />}
        <BrowserRouter>
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
