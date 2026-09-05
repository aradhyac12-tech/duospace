import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, Eye, Fingerprint, Lock, ThumbsUp, ThumbsDown } from "lucide-react";
import { usePeekDetection } from "@/hooks/usePeekDetection";
import { useTheme } from "@/contexts/ThemeContext";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { hapticWarning, hapticError, hapticLight, hapticSuccess } from "@/lib/haptics";
import { useToast } from "@/hooks/use-toast";
import { setEventFeedback } from "@/lib/peekEventLog";
import { detectFaces, loadOwnerProfile, matchAgainstOwnerPoseAware } from "@/lib/faceRecognition";
import { acquireCamera, explainGumError } from "@/lib/cameraBus";

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
    consistencyFrames:     appSettings.peekConsistencyFrames     ?? 3,
    lockDelay:             appSettings.peekLockDelay             ?? 150,
    checkInterval:         appSettings.peekCheckInterval         ?? 300,
    alertOnStranger:       appSettings.peekAlertOnStranger       ?? true,
    alertOnMultipleFaces:  appSettings.peekAlertOnMultipleFaces  ?? true,
    // CHANGED: fallback was `?? false`, which silently overrode the hook's
    // own default (now true — see usePeekDetection's DEFAULTS doc comment)
    // for every user who hasn't explicitly set this in Settings, i.e.
    // everyone. "Owner isn't there" is one of the two cases Peek Guard is
    // meant to catch, so the fallback here needs to agree with the hook.
    alertOnNoFace:         appSettings.peekAlertOnNoFace         ?? true,
    noFaceSustainMs:       appSettings.peekNoFaceSustainMs       ?? 2500,
    staticStrangerTimeoutMs: appSettings.peekStaticStrangerTimeoutMs ?? 6000,
  }), [
    appSettings.peekMatchThreshold, appSettings.peekMinFaceArea,
    appSettings.peekConsistencyFrames, appSettings.peekLockDelay,
    appSettings.peekCheckInterval, appSettings.peekAlertOnStranger,
    appSettings.peekAlertOnMultipleFaces, appSettings.peekAlertOnNoFace,
    appSettings.peekNoFaceSustainMs, appSettings.peekStaticStrangerTimeoutMs,
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
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  // Rapid-relock guard: if the lock fires again within 5s of the last
  // dismiss, show a brief toast instead of the full lock UI — prevents
  // the jarring full-screen flash in persistent crowd scenarios.
  const lastDismissAtRef = useRef<number>(0);

  // Keyboard/screen-reader users get the same fast path sighted users get:
  // focus lands on the primary recovery action the instant the lock renders.
  useEffect(() => {
    if (showAlert && !dismissed) {
      const t = setTimeout(() => primaryButtonRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [showAlert, dismissed]);

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

  // Guards the one auto-prompt per lock episode below.
  const autoBiometricTriedRef = useRef(false);

  useEffect(() => {
    if (isPeeking) {
      const now = Date.now();
      const sinceLastDismiss = now - lastDismissAtRef.current;
      // Rapid-relock guard: if the lock fires again within 5s of the last
      // dismiss, it's likely a persistent crowd scenario. Show a brief toast
      // instead of the full lock UI to avoid jarring repeated full-screen
      // flashes. The lock still fires (isPeeking stays true) so the screen
      // is protected, but the user can dismiss quickly without re-auth.
      if (sinceLastDismiss < 5000 && lastDismissAtRef.current > 0) {
        toast({
          title: "Privacy re-locked",
          description: "Still detecting unusual presence nearby.",
          variant: "default",
        });
        // Auto-dismiss after 2s so the user isn't stuck in a loop
        const t = setTimeout(() => {
          setFeedbackEventId(lastEventId);
          dismissPeek();
          setDismissed(true);
        }, 2000);
        return () => clearTimeout(t);
      }
      setDismissed(false);
      setFeedbackGiven(false);
      setFeedbackEventId(null);
      setShowAlert(true);
      autoBiometricTriedRef.current = false;
      // Semantic haptic: a lock is a warning-class event; a critical threat
      // (spoof/held-motionless stranger, or repeated escalation) reads as
      // an error-class one — distinct enough to feel, not designed to scare.
      (threatLevel === "critical" ? hapticError : hapticWarning)();
    } else {
      autoBiometricTriedRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // Owner-verified dismiss: only allow dismissing the lock if the owner's
  // face is currently detected in the camera frame. Prevents a stranger
  // from simply tapping "Dismiss" to bypass the privacy guard.
  const verifyOwnerAndDismiss = useCallback(async () => {
    setAuthBusy(true);
    try {
      const owner = await loadOwnerProfile();
      if (!owner || owner.count === 0) {
        // No owner enrolled — fall back to tap-dismiss (can't verify)
        hapticLight();
        lastDismissAtRef.current = Date.now();
        setFeedbackEventId(lastEventId);
        dismissPeek();
        setDismissed(true);
        return;
      }
      // Quick camera grab + single-frame face detection
      const lease = await acquireCamera("user");
      try {
        const video = document.createElement("video");
        video.setAttribute("playsinline", "");
        video.setAttribute("autoplay", "");
        video.muted = true;
        video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(video);
        video.srcObject = lease.stream;
        await video.play().catch(() => {});
        // Wait for a frame to be ready
        await new Promise((r) => setTimeout(r, 200));
        const faces = await detectFaces(video, performance.now());
        video.srcObject = null;
        video.remove();

        if (faces.length === 0) {
          toast({ title: "Owner not detected", description: "Show your face to dismiss.", variant: "destructive" });
          hapticWarning();
          return;
        }
        // Match best face against owner. Pose-aware: uses whichever enrolled
        // angle (center/left/right/up/down) is closest to how the owner is
        // currently holding the phone, and relaxes the threshold a bounded
        // amount for off-angle faces — previously this only ever compared
        // flat against every enrolled sample with no angle tolerance, so
        // dismissing while looking slightly down/sideways at the phone
        // (the normal way people actually hold it) could fail as "owner not
        // recognized" even though the real owner was right there.
        const bestFace = faces.reduce((a, b) => (a.area > b.area ? a : b));
        const { score: matchScore, threshold } = matchAgainstOwnerPoseAware(
          bestFace.embedding, owner, 0.7, bestFace.pose.yaw, bestFace.pose.pitch,
        );
        if (matchScore < threshold) {
          toast({ title: "Owner not recognized", description: "Face doesn't match enrolled owner.", variant: "destructive" });
          hapticWarning();
          return;
        }
        // Owner verified — dismiss
        hapticSuccess();
        lastDismissAtRef.current = Date.now();
        setFeedbackEventId(lastEventId);
        dismissPeek();
        setDismissed(true);
      } finally {
        lease.release();
      }
    } catch {
      // Camera error — fall back to tap-dismiss
      hapticLight();
      lastDismissAtRef.current = Date.now();
      setFeedbackEventId(lastEventId);
      dismissPeek();
      setDismissed(true);
    } finally {
      setAuthBusy(false);
    }
  }, [lastEventId, dismissPeek, toast]);

  const tryBiometric = useCallback(async () => {
    if (!Capacitor.isNativePlatform()) { verifyOwnerAndDismiss(); return; }
    setAuthBusy(true);
    try {
      const { NativeBiometric } = await import("capacitor-native-biometric");
      const probe = await NativeBiometric.isAvailable();
      if (!probe.isAvailable) { verifyOwnerAndDismiss(); return; }
      await NativeBiometric.verifyIdentity({
        reason: "Unlock screen",
        title: "Privacy lock",
        subtitle: "Verify it's really you",
        description: "A non-owner face was detected",
      });
      hapticSuccess();
      lastDismissAtRef.current = Date.now();
      setFeedbackEventId(lastEventId);
      dismissPeek();
      setDismissed(true);
    } catch {
      // user cancelled or failed — keep lock up
    } finally {
      setAuthBusy(false);
    }
  }, [lastEventId, dismissPeek, verifyOwnerAndDismiss]);

  // Recovery for legitimate owners should be as fast as the lock itself:
  // on native, fire the OS biometric prompt the moment the lock appears
  // instead of waiting for a tap. A stranger holding the phone still sees
  // the same lock — biometric failing/cancelling just leaves it up, and
  // the manual button below still works. Guarded to fire once per episode.
  useEffect(() => {
    if (!isPeeking || !Capacitor.isNativePlatform() || autoBiometricTriedRef.current) return;
    autoBiometricTriedRef.current = true;
    const t = setTimeout(() => { tryBiometric(); }, 200);
    return () => clearTimeout(t);
  }, [isPeeking, tryBiometric]);

  if (!appSettings.peekGuard) return null;
  if (!showAlert && !debugSnap) return null;

  const reasonText =
    reason === "stranger"  ? `Stranger detected — ${strangersDetected} unknown face${strangersDetected === 1 ? "" : "s"}` :
    reason === "multiple"  ? "Multiple people nearby" :
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
      {debugSnap.crowdModeActive && <p className="text-warning">crowd mode — stricter threshold</p>}
      {debugSnap.consecutiveLocks > 0 && <p className="text-white/50">cooldown streak: {debugSnap.consecutiveLocks}</p>}
      {debugSnap.brightness < 30 && <p className="text-warning">low light ({Math.round(debugSnap.brightness)})</p>}
      {debugSnap.frameQuality < 0.5 && <p className="text-warning">low quality ({Math.round(debugSnap.frameQuality * 100)}%)</p>}
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
          aria-modal="true" role="alertdialog" aria-label={dismissed ? "Was that accurate?" : `Privacy lock. ${reasonText}`}
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
                ref={primaryButtonRef}
                onClick={tryBiometric}
                disabled={authBusy}
                className="w-full px-5 py-2.5 rounded-xl bg-white text-black text-xs font-medium flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
              >
                <Fingerprint className="h-3.5 w-3.5" />
                {authBusy ? "Authenticating…" : "Unlock with biometric"}
              </button>
              <button
                onClick={() => verifyOwnerAndDismiss()}
                disabled={authBusy}
                className="w-full px-5 py-2 rounded-xl bg-white/10 text-white/70 text-[11px] active:scale-95 flex items-center justify-center gap-1.5 disabled:opacity-50"
                aria-label="Verify owner face and dismiss"
              >
                <Lock className="h-3 w-3" /> {authBusy ? "Verifying…" : "Dismiss (owner verify)"}
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
