import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { useCallback, useRef } from "react";
import { useSwipeNav } from "@/hooks/useSwipeNav";
import { useDockVisibility } from "@/hooks/useDockVisibility";
import { AnimatePresence, motion } from "framer-motion";
import { DUR_MED, EASE_SMOOTH } from "@/lib/motion";

import FloatingDock from "@/components/FloatingDock";
import MoodDetector from "@/components/MoodDetector";
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

const AppLayout = () => {
  const { isAppLocked, setIsAppLocked, appSettings } = useTheme();
  const { isOnline } = useAppNative(isAppLocked, setIsAppLocked, appSettings.biometricLock);
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { isVisible: dockVisible, isHidden: dockHidden } = useDockVisibility();

  // Swipe left/right between the main tabs (Chat -> Calls), mirroring the
  // bottom dock order. Direction is tracked so the page transition can slide
  // the correct way for BOTH swipe and tap navigation, not just an instant cut.
  const SWIPE_NAV_ORDER = ["/chat", "/calls"];
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
        {/* BUG FIX ("annoying gap between chat box and the bottom when the
            dock hides"): paddingBottom used to be a constant 84px reserved
            for the floating dock, regardless of whether the dock was
            actually showing. The dock now only hides for a genuine
            full-screen interaction (active call, photo/video viewer,
            camera — see useDockVisibility.ts; it's no longer scroll-driven
            at all), and this padding still needs to collapse in sync with
            it on those occasions so the reserved space doesn't linger as a
            dead gap once the dock's gone.
            The transition below intentionally uses the same --dur-med /
            --ease-smooth tokens the rest of the app's UI motion uses (not
            Tailwind's generic duration-300/ease-out) so this CSS transition
            visually tracks FloatingDock's own spring (see lib/motion.ts's
            gentleSpring) — which settles in ~235ms — instead of drifting
            out of sync with it over a mismatched 300ms curve. */}
        <main
          ref={swipeRef}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
          style={{
            paddingBottom: dockHidden
              ? "env(safe-area-inset-bottom, 0px)"
              : `calc(env(safe-area-inset-bottom, 0px) + ${dockVisible ? "var(--dock-reserve)" : "var(--dock-gap)"})`,
            transition: "padding-bottom var(--dur-med) var(--ease-smooth)",
          }}
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
                {/* FIX: was duration:0.32 with an inline bezier literal
                    duplicating --ease-smooth by hand. Standardized to the
                    shared STANDARD tier (220ms) — the redesign brief's own
                    target for ordinary page navigation is ~180-280ms; 380ms
                    (EMPHASIS) is reserved for hero/feature-launch moments,
                    not routine tab/page switches. */}
                transition={{ duration: DUR_MED, ease: EASE_SMOOTH }}
                className="flex-1 min-h-0 flex flex-col overflow-hidden"
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </ErrorBoundary>
        </main>
        <GroicMiniPlayer />
        <GroicFullPlayer />
        <GroicInviteBanner />
        <FloatingDock isVisible={dockVisible} isHidden={dockHidden} />
        <MoodDetector />
        <EmojiScreenEffect />
      </div>
    </GroicProvider>
  );
};

export default AppLayout;
