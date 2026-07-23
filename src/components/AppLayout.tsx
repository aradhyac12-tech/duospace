import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { useCallback, useRef } from "react";
import { useSwipeNav } from "@/hooks/useSwipeNav";
import { AnimatePresence, motion } from "framer-motion";

import FloatingDock from "@/components/FloatingDock";
import SurpriseOverlay from "@/components/SurpriseOverlay";
import MoodDetector from "@/components/MoodDetector";
import EmojiScreenEffect from "@/components/EmojiScreenEffect";
import OfflineBanner from "@/components/OfflineBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { GroicProvider } from "@/contexts/GroicContext";
import GroicMiniPlayer from "@/components/GroicMiniPlayer";
import GroicFullPlayer from "@/components/GroicFullPlayer";
import { useAppNative } from "@/hooks/useAppNative";
import { useTheme } from "@/contexts/ThemeContext";
import { useSessionGuard } from "@/hooks/useSessionGuard";
import { useToast } from "@/hooks/use-toast";
import { logError } from "@/lib/telemetry";

const AppLayout = () => {
  const { isAppLocked, setIsAppLocked, appSettings } = useTheme();
  const { isOnline } = useAppNative(isAppLocked, setIsAppLocked, appSettings.biometricLock);
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();

  // Swipe left/right between the main tabs (Chat -> Calls -> Settings),
  // mirroring the bottom nav order. Direction is tracked so the page
  // transition can slide the correct way for BOTH swipe and tap navigation,
  // not just an instant cut.
  const SWIPE_NAV_ORDER = ["/chat", "/calls", "/settings"];
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
      {/* FIX AUDIT #13: no-overscroll prevents iOS bounce exposing white bar behind notch */}
      <div className="h-[100dvh] bg-background overflow-x-hidden flex flex-col no-overscroll">
        <OfflineBanner isOnline={isOnline} />
        <main
          ref={swipeRef}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 84px)" }}
        >
          {/* FIX AUDIT #2: Error boundary per page so one crash doesn't kill the whole app */}
          <ErrorBoundary context="PageContent">
            <AnimatePresence mode="wait" initial={false} custom={direction.current}>
              <motion.div
                key={location.pathname}
                custom={direction.current}
                initial={direction.current !== 0
                  ? { opacity: 0, x: direction.current * 36 }
                  : { opacity: 0, y: 10, scale: 0.985, filter: "blur(4px)" }}
                animate={direction.current !== 0
                  ? { opacity: 1, x: 0 }
                  : { opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                exit={direction.current !== 0
                  ? { opacity: 0, x: direction.current * -36 }
                  : { opacity: 0, y: -8, scale: 0.99, filter: "blur(3px)" }}
                transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
                className="flex-1 min-h-0 flex flex-col overflow-hidden"
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </ErrorBoundary>
        </main>
        <GroicMiniPlayer />
        <GroicFullPlayer />
        <FloatingDock />
        <SurpriseOverlay />
        <MoodDetector />
        <EmojiScreenEffect />
      </div>
    </GroicProvider>
  );
};

export default AppLayout;
