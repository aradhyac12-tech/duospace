import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { lazy, Suspense, useCallback, useRef } from "react";
import { useSwipeNav } from "@/hooks/useSwipeNav";
import { useDockVisibility } from "@/hooks/useDockVisibility";
import { useDockLayoutReserve } from "@/hooks/useDockLayoutReserve";
import { AnimatePresence, motion } from "framer-motion";
import { DUR_MED, EASE_SMOOTH } from "@/lib/motion";

import FloatingDock from "@/components/FloatingDock";
import ChatCallsShell from "@/components/ChatCallsShell";
import DuoSpaceBottomSurface from "@/components/DuoSpaceBottomSurface";
import { BottomSurfaceProvider } from "@/contexts/BottomSurfaceContext";
// BUNDLE FIX: MoodDetector statically imported @/lib/faceRecognition →
// @mediapipe/tasks-vision (several hundred KB of vision-model wrapper JS)
// into the app's ENTRY chunk via this layout, so every first paint paid
// for code only needed when mood detection actually runs. Lazy-loaded
// below; Suspense fallback is null because MoodDetector renders its own
// floating trigger — nothing to show while its chunk arrives.
const MoodDetector = lazy(() => import("@/components/MoodDetector"));
import EmojiScreenEffect from "@/components/EmojiScreenEffect";
import OfflineBanner from "@/components/OfflineBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { GroicProvider } from "@/contexts/GroicContext";
import GroicMiniPlayer from "@/components/GroicMiniPlayer";
import GroicFullPlayer from "@/components/GroicFullPlayer";
import GroicInviteBanner from "@/components/GroicInviteBanner";
import { useAppNative } from "@/hooks/useAppNative";
import { useTheme } from "@/contexts/ThemeContext";
import { useSessionGuard } from "@/hooks/useSessionGuard";
import { useToast } from "@/hooks/use-toast";
import { logError } from "@/lib/telemetry";

// Phase 5.5 (Unified Bottom Surface + Zero-Flicker Navigation): the two
// primary tabs (Chat, Calls) no longer go through the ordinary
// Outlet + AnimatePresence route-swap below, and no longer get the
// standalone FloatingDock. See ChatCallsShell.tsx (persistent mount, kills
// the route-unmount that caused most of the reported flicker) and
// DuoSpaceBottomSurface.tsx (fuses the composer + nav into one glass shell,
// per the brief's explicit "do NOT render two visually separate pills").
// Every other page (Gallery/Map/Groic/Us/Shayari/Settings/Profile/...) is
// untouched — still the original Outlet/AnimatePresence transition and the
// original standalone FloatingDock, exactly as before this phase.
const PRIMARY_TABS = ["/chat", "/calls"];

const AppLayout = () => {
  const { isAppLocked, setIsAppLocked, appSettings } = useTheme();
  const { isOnline } = useAppNative(isAppLocked, setIsAppLocked, appSettings.biometricLock);
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { isVisible: dockVisible, isHidden: dockHidden } = useDockVisibility();
  const dockLayoutReserve = useDockLayoutReserve();
  const isPrimaryTab = PRIMARY_TABS.includes(location.pathname);

  // Swipe left/right between the main tabs (Chat -> Calls), mirroring the
  // bottom dock order. Direction is tracked so the page transition can
  // slide the correct way for BOTH swipe and tap navigation, not just an
  // instant cut. Still drives ChatCallsShell's pane direction below, even
  // though the OTHER (non-primary-tab) branch's AnimatePresence no longer
  // needs it for these two routes.
  const SWIPE_NAV_ORDER = PRIMARY_TABS;
  const prevPathname = useRef(location.pathname);
  const direction = useRef(0); // 1 = forward/next, -1 = back/prev, 0 = unrelated nav
  const currentTabIndex = SWIPE_NAV_ORDER.indexOf(location.pathname);

  if (prevPathname.current !== location.pathname) {
    const prevIdx = SWIPE_NAV_ORDER.indexOf(prevPathname.current);
    direction.current = (prevIdx !== -1 && currentTabIndex !== -1) ? (currentTabIndex > prevIdx ? 1 : -1) : 0;
    prevPathname.current = location.pathname;
  }

  const swipeRef = useSwipeNav<HTMLDivElement>({
    enabled: currentTabIndex !== -1,
    onSwipeLeft: () => {
      if (currentTabIndex !== -1 && currentTabIndex < SWIPE_NAV_ORDER.length - 1) {
        navigate(SWIPE_NAV_ORDER[currentTabIndex + 1]);
      }
    },
    onSwipeRight: () => {
      if (currentTabIndex > 0) {
        navigate(SWIPE_NAV_ORDER[currentTabIndex - 1]);
      }
    },
  });


  // FIX AUDIT #4: Session guard handles token expiry, refresh failures, multi-device conflicts
  const handleSessionExpired = useCallback(() => {
    toast({
      title: "Session expired",
      description: "Please sign in again.",
      variant: "destructive",
    });
    navigate("/auth", { replace: true });
  }, [toast, navigate]);

  const handleRefreshFailed = useCallback((err: unknown) => {
    logError("AppLayout", "token refresh failed", err);
    toast({
      title: "Connection issue",
      description: "Couldn't refresh your session. Some features may be unavailable.",
    });
  }, [toast]);

  const handleSessionConflict = useCallback(() => {
    toast({
      title: "Signed in on another device",
      description: "Your session has been updated.",
    });
  }, [toast]);

  // FIX AUDIT #4: mount session guard at layout level so it covers all pages
  useSessionGuard({
    onExpired: handleSessionExpired,
    onRefreshFailed: handleRefreshFailed,
    onSessionConflict: handleSessionConflict,
  });

  // NOTE: new-device sign-in alerts are handled once, centrally, by
  // notifyCurrentDeviceSignIn() (src/lib/signinAlert.ts) from useAuth.tsx's
  // SIGNED_IN handler. A second raw supabase.functions.invoke("notify-signin")
  // used to live here too, so every sign-in fired the edge function twice —
  // once through the hardened, deduped helper and once through this bare
  // call with no retry/timeout handling and no in-flight guard.

  return (
    <GroicProvider>
      <BottomSurfaceProvider>
      {/* FIX AUDIT #13: no-overscroll prevents iOS bounce exposing white bar behind notch */}
      <div className="h-[100dvh] bg-background overflow-x-hidden flex flex-col no-overscroll">
        <OfflineBanner isOnline={isOnline} />
        {isPrimaryTab ? (
          // Chat/Calls: persistent-mount shell, no outer dock-reserve
          // padding (DuoSpaceBottomSurface's own ResizeObserver-fed height
          // is consumed directly by Chat's message list / Calls' content
          // list as scroll-inset — see BottomSurfaceContext.tsx — not as
          // outer layout padding, same "let the real material behind it
          // do the reserving" reasoning useDockLayoutReserve's own comment
          // gives for every other page).
          <main ref={swipeRef} className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <ChatCallsShell active={location.pathname === "/calls" ? "calls" : "chat"} />
          </main>
        ) : (
          <main
            ref={swipeRef}
            className="flex-1 min-h-0 flex flex-col overflow-hidden"
            style={dockLayoutReserve}
          >
            {/* FIX AUDIT #2: Error boundary per page so one crash doesn't kill the whole app */}
            <ErrorBoundary context="PageContent">
              <AnimatePresence mode="wait" initial={false} custom={direction.current}>
                <motion.div
                  key={location.pathname}
                  custom={direction.current}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: DUR_MED, ease: EASE_SMOOTH }}
                  className="flex-1 min-h-0 flex flex-col overflow-hidden"
                >
                  <Outlet />
                </motion.div>
              </AnimatePresence>
            </ErrorBoundary>
          </main>
        )}
        <GroicMiniPlayer />
        <GroicFullPlayer />
        <GroicInviteBanner />
        {isPrimaryTab ? (
          <DuoSpaceBottomSurface composerExpanded={location.pathname === "/chat"} />
        ) : (
          <FloatingDock isVisible={dockVisible} isHidden={dockHidden} />
        )}
        <Suspense fallback={null}>
          <MoodDetector />
        </Suspense>
        <EmojiScreenEffect />
      </div>
      </BottomSurfaceProvider>
    </GroicProvider>
  );
};

export default AppLayout;
