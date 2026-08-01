import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, Eye, Fingerprint, Lock, ThumbsUp, ThumbsDown } from "lucide-react";
import { usePeekDetection } from "@/hooks/usePeekDetection";
import { useTheme } from "@/contexts/ThemeContext";
import { useState, useEffect, useCallback, useMemo } from "react";
import { Capacitor } from "@capacitor/core";
import { hapticHeavy, hapticLight } from "@/lib/haptics";
import { useToast } from "@/hooks/use-toast";
import { setEventFeedback } from "@/lib/peekEventLog";

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
    consistencyFrames:     appSettings.peekConsistencyFrames     ?? 2,
    lockDelay:             appSettings.peekLockDelay             ?? 150,
    checkInterval:         appSettings.peekCheckInterval         ?? 300,
    alertOnStranger:       appSettings.peekAlertOnStranger       ?? true,
    alertOnMultipleFaces:  appSettings.peekAlertOnMultipleFaces  ?? true,
    alertOnNoFace:         appSettings.peekAlertOnNoFace         ?? false,
    staticStrangerTimeoutMs: appSettings.peekStaticStrangerTimeoutMs ?? 6000,
  }), [
    appSettings.peekMatchThreshold, appSettings.peekMinFaceArea,
    appSettings.peekConsistencyFrames, appSettings.peekLockDelay,
    appSettings.peekCheckInterval, appSettings.peekAlertOnStranger,
    appSettings.peekAlertOnMultipleFaces, appSettings.peekAlertOnNoFace,
    appSettings.peekStaticStrangerTimeoutMs,
  ]);

  const { isPeeking, facesDetected, strangersDetected, ownerEnrolled, reason, threatScore, threatLevel, lastEventId, dismiss: dismissPeek, getDebugSnapshot, error: peekError } =
    usePeekDetection(appSettings.peekGuard ?? false, peekConfig);

  const { toast } = useToast();
  const [dismissed, setDismissed] = useState(false);
  const [showAlert, setShowAlert] = useState(false);
  const [authBusy, setAuthBusy]   = useState(false);
  // Snapshot of lastEventId at the moment of dismissal, so a feedback
  // click always rates the event that was actually just shown — not
  // whatever the hook's lastEventId happens to be by the time they tap.
  const [feedbackEventId, setFeedbackEventId] = useState<string | null>(null);
  const [feedbackGiven, setFeedbackGiven]     = useState(false);
  const [debugSnap, setDebugSnap] = useState<ReturnType<typeof getDebugSnapshot> | null>(null);

  // Debug HUD polling — only runs at all when the setting is on, so users
  // who never enable it pay zero cost for this.
  useEffect(() => {
    if (!appSettings.peekGuard || !appSettings.peekDebugMode) { setDebugSnap(null); return; }
    setDebugSnap(getDebugSnapshot());
    const t = setInterval(() => setDebugSnap(getDebugSnapshot()), 500);
    return () => clearInterval(t);
  }, [appSettings.peekGuard, appSettings.peekDebugMode, getDebugSnapshot]);

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
      setFeedbackGiven(false);
      setFeedbackEventId(null);
      setShowAlert(true);
      hapticHeavy();
    }
  }, [isPeeking]);

  // On dismissal: if we have an event to rate, hold the overlay open for a
  // brief feedback prompt instead of hiding immediately. No event to rate
  // (shouldn't normally happen) or feedback already given → hide shortly.
  useEffect(() => {
    if (!isPeeking && dismissed) {
      if (feedbackEventId && !feedbackGiven) return; // waiting on the feedback panel
      const t = setTimeout(() => setShowAlert(false), 250);
      return () => clearTimeout(t);
    }
  }, [isPeeking, dismissed, feedbackEventId, feedbackGiven]);

  // Feedback panel auto-dismisses after a while if the person just walks away.
  useEffect(() => {
    if (!dismissed || !feedbackEventId || feedbackGiven) return;
    const t = setTimeout(() => setShowAlert(false), 8000);
    return () => clearTimeout(t);
  }, [dismissed, feedbackEventId, feedbackGiven]);

  const rate = useCallback((verdict: "accurate" | "false_alarm") => {
    if (!feedbackEventId) return;
    setEventFeedback(feedbackEventId, verdict);
    hapticLight();
    setFeedbackGiven(true);
    setTimeout(() => setShowAlert(false), 400);
  }, [feedbackEventId]);

  const tryBiometric = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) { setFeedbackEventId(lastEventId); dismissPeek(); setDismissed(true); return; }
    setAuthBusy(true);
    try {
      const { NativeBiometric } = await import("capacitor-native-biometric");
      const probe = await NativeBiometric.isAvailable();
      if (!probe.isAvailable) { setFeedbackEventId(lastEventId); dismissPeek(); setDismissed(true); return; }
      await NativeBiometric.verifyIdentity({
        reason: "Unlock screen",
        title: "Privacy lock",
        subtitle: "Verify it's really you",
        description: "A non-owner face was detected",
      });
      hapticLight();
      setFeedbackEventId(lastEventId);
      dismissPeek();
      setDismissed(true);
    } catch {
      // user cancelled or failed — keep lock up
    } finally {
      setAuthBusy(false);
    }
  }, [lastEventId, dismissPeek]);

  if (!appSettings.peekGuard) return null;
  if (!showAlert && !debugSnap) return null;

  const reasonText =
    reason === "stranger"  ? `Stranger detected — ${strangersDetected} unknown face${strangersDetected === 1 ? "" : "s"}` :
    reason === "multiple"  ? `${facesDetected} faces in view` :
    reason === "no-face"   ? "No owner detected" :
    reason === "spoof"     ? "Unrecognized face held motionless — possible photo/screen" :
                             "Privacy alert";

  const debugHud = debugSnap && (
    <div
      className="fixed top-2 left-2 z-[9999] rounded-lg bg-black/80 text-white/90 text-[9px] font-mono px-2 py-1.5 space-y-0.5 pointer-events-none select-none safe-top safe-left"
    >
      <p>peek: {isPeeking ? "LOCKED" : "watching"} · threat {threatScore}/100 ({threatLevel})</p>
      <p>faces {facesDetected} · strangers {strangersDetected} · owner {ownerEnrolled ? "✓" : "✗"}</p>
      <p>
        {debugSnap.usingWorker ? "worker" : "main-thread fallback"} ·
        {" "}~{Math.round(1000 / Math.max(1, debugSnap.effectiveIntervalMs))}fps
        {" "}({debugSnap.effectiveIntervalMs}ms)
      </p>
      {debugSnap.cameraCovered && <p className="text-warning">camera covered</p>}
      {debugSnap.tickInFlight && <p className="text-white/50">tick in-flight…</p>}
      {debugSnap.texture && (
        <p className={debugSnap.texture.suspected ? "text-warning" : "text-white/50"}>
          texture: lap {debugSnap.texture.laplacianVar.toFixed(1)} · luma {debugSnap.texture.lumaStdDev.toFixed(1)}
          {debugSnap.texture.suspected ? " (flat!)" : ""}
        </p>
      )}
    </div>
  );

  return (
    <>
      {debugHud}
      <AnimatePresence>
      {showAlert && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[10000] flex flex-col items-center justify-center"
          style={{
            background: "radial-gradient(circle at 50% 42%, rgba(24,22,26,0.90) 0%, rgba(0,0,0,0.97) 72%)",
            backdropFilter: "blur(40px)",
            WebkitBackdropFilter: "blur(40px)",
          }}
          aria-modal="true" role="alertdialog"
        >
          {!dismissed ? (
          <motion.div
            initial={{ scale: 0.94, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 460, damping: 32 }}
            className="text-center space-y-5 px-8 max-w-xs"
          >
            <div className="relative mx-auto h-16 w-16">
              <motion.div
                aria-hidden="true"
                className="absolute inset-[-14px] rounded-full bg-destructive/25 blur-xl"
                animate={{ opacity: [0.4, 0.75, 0.4], scale: [0.92, 1.08, 0.92] }}
                transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
              />
              <motion.div
                animate={{ scale: [1, 1.06, 1] }}
                transition={{ repeat: Infinity, duration: 1.8, ease: "easeInOut" }}
                className="relative h-16 w-16 rounded-2xl bg-destructive/10 flex items-center justify-center"
              >
                <ShieldAlert className="h-8 w-8 text-destructive" />
              </motion.div>
            </div>

            <div className="space-y-1">
              <h2 className="text-base font-semibold text-white tracking-tight">Privacy lock</h2>
              <p className="text-xs text-white/50 leading-relaxed">{reasonText}</p>
              {!ownerEnrolled && (
                <p className="text-[10px] text-warning/90 pt-1">
                  Enroll your face in Settings for stranger detection
                </p>
              )}
              {(threatLevel === "high" || threatLevel === "critical") && (
                <p className="text-[10px] text-destructive/90 pt-1 uppercase tracking-wide">
                  {threatLevel} threat
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
                onClick={() => { setFeedbackEventId(lastEventId); dismissPeek(); setDismissed(true); }}
                className="w-full px-5 py-2 rounded-xl bg-white/10 text-white/70 text-[11px] active:scale-95 flex items-center justify-center gap-1.5"
              >
                <Lock className="h-3 w-3" /> Dismiss
              </button>
            </div>
          </motion.div>
          ) : feedbackEventId && !feedbackGiven ? (
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 460, damping: 32 }}
              className="text-center space-y-4 px-8 max-w-xs"
            >
              <div className="space-y-1">
                <h2 className="text-sm font-semibold text-white tracking-tight">Was that accurate?</h2>
                <p className="text-[11px] text-white/50 leading-relaxed">
                  Helps tune how sensitive Peek Guard is for you.
                </p>
              </div>
              <div className="flex items-center justify-center gap-3 pt-1">
                <button
                  onClick={() => rate("accurate")}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/10 text-white text-[11px] active:scale-95 flex items-center justify-center gap-1.5"
                >
                  <ThumbsUp className="h-3.5 w-3.5" /> Real alert
                </button>
                <button
                  onClick={() => rate("false_alarm")}
                  className="flex-1 px-4 py-2.5 rounded-xl bg-white/10 text-white text-[11px] active:scale-95 flex items-center justify-center gap-1.5"
                >
                  <ThumbsDown className="h-3.5 w-3.5" /> False alarm
                </button>
              </div>
            </motion.div>
          ) : null}
        </motion.div>
      )}
    </AnimatePresence>
    </>
  );
};

export default PeekGuard;
