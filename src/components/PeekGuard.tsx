import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, Eye, Fingerprint, Lock } from "lucide-react";
import { usePeekDetection } from "@/hooks/usePeekDetection";
import { useTheme } from "@/contexts/ThemeContext";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Capacitor } from "@capacitor/core";
import { hapticHeavy, hapticLight } from "@/lib/haptics";
import { useToast } from "@/hooks/use-toast";

/**
 * PeekGuard
 * ─────────
 * Mounts the peek-detection pipeline (camera + MediaPipe owner recognition)
 * and renders a full-screen blur lock when a breach is confirmed. Unlock paths:
 *   1. Native biometric (capacitor-native-biometric) when available.
 *   2. Tap-to-dismiss fallback (web / device without biometric).
 *
 * Privacy: while enabled, the underlying hook holds an *off-screen* video
 * element. We never record or transmit frames — embeddings live in IndexedDB.
 */
const PeekGuard = () => {
  const { appSettings } = useTheme();

  const peekConfig = useMemo(() => ({
    matchThreshold:        appSettings.peekMatchThreshold        ?? 0.7,
    minFaceArea:           appSettings.peekMinFaceArea           ?? 0.015,
    consistencyFrames:     appSettings.peekConsistencyFrames     ?? 4,
    lockDelay:             appSettings.peekLockDelay             ?? 1500,
    checkInterval:         appSettings.peekCheckInterval         ?? 600,
    alertOnStranger:       appSettings.peekAlertOnStranger       ?? true,
    alertOnMultipleFaces:  appSettings.peekAlertOnMultipleFaces  ?? true,
    alertOnNoFace:         appSettings.peekAlertOnNoFace         ?? false,
  }), [
    appSettings.peekMatchThreshold, appSettings.peekMinFaceArea,
    appSettings.peekConsistencyFrames, appSettings.peekLockDelay,
    appSettings.peekCheckInterval, appSettings.peekAlertOnStranger,
    appSettings.peekAlertOnMultipleFaces, appSettings.peekAlertOnNoFace,
  ]);

  const { isPeeking, facesDetected, strangersDetected, ownerEnrolled, reason, error: peekError } =
    usePeekDetection(appSettings.peekGuard ?? false, peekConfig);

  const { toast } = useToast();
  const [dismissed, setDismissed] = useState(false);
  const [showAlert, setShowAlert] = useState(false);
  const [authBusy, setAuthBusy]   = useState(false);

  // Surface camera failures (HTTPS, permission, busy device, etc.) once per change.
  useEffect(() => {
    if (!appSettings.peekGuard || !peekError) return;
    toast({
      title: "Peek Guard camera unavailable",
      description: peekError,
      variant: "destructive",
    });
  }, [peekError, appSettings.peekGuard, toast]);

  // Native privacy screen (separate from the lock overlay)
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    (async () => {
      try {
        const { PrivacyScreen } = await import("@capacitor-community/privacy-screen");
        if (appSettings.peekGuard || appSettings.privacyMode) await PrivacyScreen.enable();
        else await PrivacyScreen.disable();
      } catch { /* plugin missing — silent */ }
    })();
  }, [appSettings.peekGuard, appSettings.privacyMode]);

  useEffect(() => {
    if (isPeeking) {
      setDismissed(false);
      setShowAlert(true);
      hapticHeavy();
    }
  }, [isPeeking]);

  useEffect(() => {
    if (!isPeeking && dismissed) {
      const t = setTimeout(() => setShowAlert(false), 250);
      return () => clearTimeout(t);
    }
  }, [isPeeking, dismissed]);

  const tryBiometric = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) { setDismissed(true); return; }
    setAuthBusy(true);
    try {
      const { NativeBiometric } = await import("capacitor-native-biometric");
      const probe = await NativeBiometric.isAvailable();
      if (!probe.isAvailable) { setDismissed(true); return; }
      await NativeBiometric.verifyIdentity({
        reason: "Unlock screen",
        title: "Privacy lock",
        subtitle: "Verify it's really you",
        description: "A non-owner face was detected",
      });
      hapticLight();
      setDismissed(true);
    } catch {
      // user cancelled or failed — keep lock up
    } finally {
      setAuthBusy(false);
    }
  }, []);

  if (!appSettings.peekGuard || !showAlert) return null;

  const reasonText =
    reason === "stranger"  ? `Stranger detected — ${strangersDetected} unknown face${strangersDetected === 1 ? "" : "s"}` :
    reason === "multiple"  ? `${facesDetected} faces in view` :
    reason === "no-face"   ? "No owner detected" :
                             "Privacy alert";

  return (
    <AnimatePresence>
      {showAlert && !dismissed && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[10000] flex flex-col items-center justify-center"
          style={{
            background: "rgba(0,0,0,0.92)",
            backdropFilter: "blur(40px)",
            WebkitBackdropFilter: "blur(40px)",
          }}
          aria-modal="true" role="alertdialog"
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 460, damping: 32 }}
            className="text-center space-y-5 px-8 max-w-xs"
          >
            <motion.div
              animate={{ scale: [1, 1.06, 1] }}
              transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
              className="mx-auto h-16 w-16 rounded-2xl bg-red-500/10 flex items-center justify-center"
            >
              <ShieldAlert className="h-8 w-8 text-red-500" />
            </motion.div>

            <div className="space-y-1">
              <h2 className="text-base font-semibold text-white tracking-tight">Privacy lock</h2>
              <p className="text-xs text-white/50 leading-relaxed">{reasonText}</p>
              {!ownerEnrolled && (
                <p className="text-[10px] text-yellow-400/80 pt-1">
                  Enroll your face in Settings for stranger detection
                </p>
              )}
            </div>

            <div className="flex items-center justify-center gap-1.5 text-[10px] text-white/30">
              <Eye className="h-3 w-3" /> Monitoring active
            </div>

            <div className="space-y-2 pt-1">
              <button
                onClick={tryBiometric}
                disabled={authBusy}
                className="w-full px-5 py-2.5 rounded-xl bg-white text-black text-xs font-medium flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
              >
                <Fingerprint className="h-3.5 w-3.5" />
                {authBusy ? "Authenticating…" : "Unlock with biometric"}
              </button>
              <button
                onClick={() => setDismissed(true)}
                className="w-full px-5 py-2 rounded-xl bg-white/10 text-white/70 text-[11px] active:scale-95 flex items-center justify-center gap-1.5"
              >
                <Lock className="h-3 w-3" /> Dismiss
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default PeekGuard;
