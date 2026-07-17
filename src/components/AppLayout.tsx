import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { useCallback, useEffect } from "react";
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
import { supabase } from "@/integrations/supabase/client";
import { computeDeviceFingerprint, collectDeviceInfo } from "@/lib/deviceFingerprint";

const AppLayout = () => {
  const { isAppLocked, setIsAppLocked, appSettings } = useTheme();
  const { isOnline } = useAppNative(isAppLocked, setIsAppLocked, appSettings.biometricLock);
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();


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

  // Instagram-style new-device alerts: only on real SIGNED_IN, not token refresh or initial session.
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event !== "SIGNED_IN") return;
      (async () => {
        try {
          const fingerprint = await computeDeviceFingerprint();
          const info = collectDeviceInfo();
          await supabase.functions.invoke("notify-signin", {
            body: { fingerprint, ...info },
          });
        } catch (err) {
          logError("AppLayout", "notify-signin failed", err);
        }
      })();
    });
    return () => subscription.unsubscribe();
  }, []);

  return (
    <GroicProvider>
      {/* FIX AUDIT #13: no-overscroll prevents iOS bounce exposing white bar behind notch */}
      <div className="h-[100dvh] bg-background overflow-x-hidden flex flex-col no-overscroll">
        <OfflineBanner isOnline={isOnline} />
        <main
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 84px)" }}
        >
          {/* FIX AUDIT #2: Error boundary per page so one crash doesn't kill the whole app */}
          <ErrorBoundary context="PageContent">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 10, scale: 0.985, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -8, scale: 0.99, filter: "blur(3px)" }}
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
