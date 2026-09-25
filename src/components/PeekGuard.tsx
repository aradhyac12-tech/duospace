import { motion, AnimatePresence } from "framer-motion";
import { ShieldAlert, Eye, Fingerprint, Lock } from "lucide-react";
import { usePeekDetection } from "@/hooks/usePeekDetection";
import { useTheme } from "@/contexts/ThemeContext";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Capacitor } from "@capacitor/core";
import { hapticWarning, hapticError, hapticLight, hapticSuccess, hapticTick } from "@/lib/haptics";
import { useToast } from "@/hooks/use-toast";
import { detectFaces, loadOwnerProfile, matchAgainstOwnerPoseAware, isAttentive, maybeAdaptOwnerProfile } from "@/lib/faceRecognition";
import { acquireCamera, explainGumError } from "@/lib/cameraBus";
import storage from "@/lib/storage";
import { verifyPin } from "@/lib/crypto";

// Must match AppLockScreen.tsx's STORED_PIN_KEY — same PIN, same credential,
// just a second place it can be entered when biometric fails here.
const STORED_PIN_KEY = "duo-lock-pin";
const PIN_LENGTH = 6;

/**
 * PeekGuard
 * ─────────
 * Mounts the peek-detection pipeline (camera + MediaPipe owner recognition)
 * and renders a full-screen blur lock when a breach is confirmed.
 *
 * Unlock paths (in priority order — fastest first):
 *   0. Auto-unlock (the hook's own pipeline, see usePeekDetection.ts): the
 *      instant the owner alone is confidently recognized in frame again,
 *      isPeeking clears itself — no tap here at all. Everything below is
 *      the fallback for when that can't confirm (low light, bad angle, no
 *      camera, or the setting is off).
 *   1. Auto biometric (fires the instant a stranger/crowd lock appears, no tap)
 *   2. Manual biometric button (retry)
 *   3. Camera-based owner face verify (Dismiss button)
 *   4. PIN fallback (shown if biometric actually fails)
 *
 * Feedback removed: the post-lock "was that accurate?" panel is gone. It
 * introduced a noticeable delay between dismissing and the screen clearing,
 * and the event log (peekEventLog.ts) still records every lock with its
 * reason + threat score for offline analysis — we just no longer interrupt
 * the owner's recovery flow to ask for it in the moment.
 *
 * Privacy: the underlying hook holds an *off-screen* video element while
 * enabled. We never record or transmit frames — embeddings live in IndexedDB.
 */
const PeekGuard = () => {
  const { appSettings } = useTheme();

  const peekConfig = useMemo(() => ({
    matchThreshold:          appSettings.peekMatchThreshold          ?? 0.7,
    minFaceArea:             appSettings.peekMinFaceArea             ?? 0.015,
    consistencyFrames:       appSettings.peekConsistencyFrames       ?? 1,
    lockDelay:               appSettings.peekLockDelay               ?? 30,
    checkInterval:           appSettings.peekCheckInterval           ?? 300,
    alertOnStranger:         appSettings.peekAlertOnStranger         ?? true,
    alertOnMultipleFaces:    appSettings.peekAlertOnMultipleFaces    ?? true,
    alertOnNoFace:           appSettings.peekAlertOnNoFace           ?? false,
    noFaceSustainMs:         appSettings.peekNoFaceSustainMs         ?? 2500,
    staticStrangerTimeoutMs: appSettings.peekStaticStrangerTimeoutMs ?? 6000,
    autoUnlockOnOwner:           appSettings.peekAutoUnlockOnOwner           ?? true,
    autoUnlockConsistencyFrames: appSettings.peekAutoUnlockConsistencyFrames ?? 1,
    autoUnlockDelay:              appSettings.peekAutoUnlockDelay             ?? 15,
  }), [
    appSettings.peekMatchThreshold, appSettings.peekMinFaceArea,
    appSettings.peekConsistencyFrames, appSettings.peekLockDelay,
    appSettings.peekCheckInterval, appSettings.peekAlertOnStranger,
    appSettings.peekAlertOnMultipleFaces, appSettings.peekAlertOnNoFace,
    appSettings.peekNoFaceSustainMs, appSettings.peekStaticStrangerTimeoutMs,
    appSettings.peekAutoUnlockOnOwner, appSettings.peekAutoUnlockConsistencyFrames,
    appSettings.peekAutoUnlockDelay,
  ]);

  const {
    isPeeking, facesDetected, strangersDetected, ownerEnrolled,
    reason, threatScore, threatLevel, dismiss: dismissPeek,
    getDebugSnapshot, error: peekError,
  } = usePeekDetection(appSettings.peekGuard ?? false, peekConfig);

  const { toast } = useToast();
  const [showAlert, setShowAlert]         = useState(false);
  const [authBusy,  setAuthBusy]          = useState(false);
  const [debugSnap, setDebugSnap]         = useState<ReturnType<typeof getDebugSnapshot> | null>(null);
  // PIN fallback: shown after native biometric genuinely fails/cancels.
  const [showPinFallback, setShowPinFallback] = useState(false);
  const [pinValue, setPinValue]           = useState("");
  const [pinError, setPinError]           = useState(false);
  const [pinBusy,  setPinBusy]            = useState(false);

  const primaryButtonRef   = useRef<HTMLButtonElement>(null);
  // Guards the once-per-episode auto-biometric prompt.
  const autoBiometricTriedRef = useRef(false);
  // Rapid-relock guard: if locked again within 5s of last dismiss, show a
  // brief toast instead of the full lock UI — prevents jarring full-screen
  // flashes in persistent crowd scenarios while still protecting the screen.
  const lastDismissAtRef = useRef<number>(0);

  // Focus the primary recovery button as soon as the lock renders so keyboard
  // and screen-reader users don't have to tab to it.
  useEffect(() => {
    if (showAlert) {
      const t = setTimeout(() => primaryButtonRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [showAlert]);

  // Debug HUD polling — zero cost unless the setting is on.
  useEffect(() => {
    if (!appSettings.peekGuard || !appSettings.peekDebugMode) { setDebugSnap(null); return; }
    setDebugSnap(getDebugSnapshot());
    const t = setInterval(() => setDebugSnap(getDebugSnapshot()), 500);
    return () => clearInterval(t);
  }, [appSettings.peekGuard, appSettings.peekDebugMode, getDebugSnapshot]);

  // Surface camera failures once per change.
  useEffect(() => {
    if (!appSettings.peekGuard || !peekError) return;
    toast({ title: "Peek Guard camera unavailable", description: peekError, variant: "destructive" });
  }, [peekError, appSettings.peekGuard, toast]);

  // Native privacy screen.
  // ANDROID: always on — FLAG_SECURE blocks screenshots + blanks recents.
  // iOS: follows the two settings.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const alwaysSecure = Capacitor.getPlatform() === "android";
    (async () => {
      try {
        const { PrivacyScreen } = await import("@capacitor-community/privacy-screen");
        if (alwaysSecure || appSettings.peekGuard || appSettings.privacyMode) await PrivacyScreen.enable();
        else await PrivacyScreen.disable();
      } catch { /* plugin missing — FLAG_SECURE in MainActivity still applies on Android */ }
    })();
  }, [appSettings.peekGuard, appSettings.privacyMode]);

  useEffect(() => {
    if (isPeeking) {
      const now = Date.now();
      const sinceLastDismiss = now - lastDismissAtRef.current;
      // Rapid-relock: persistent crowd scenario — brief toast, 2s auto-dismiss,
      // no jarring repeated full-screen flash.
      if (sinceLastDismiss < 5000 && lastDismissAtRef.current > 0) {
        toast({
          title: "Privacy re-locked",
          description: "Still detecting unusual presence nearby.",
          variant: "default",
        });
        const t = setTimeout(() => {
          dismissPeek();
          lastDismissAtRef.current = Date.now();
        }, 2000);
        return () => clearTimeout(t);
      }
      setShowPinFallback(false);
      setPinValue("");
      setPinError(false);
      autoBiometricTriedRef.current = false;
      setShowAlert(true);
      (threatLevel === "critical" ? hapticError : hapticWarning)();
    } else {
      autoBiometricTriedRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPeeking]);

  // Hide the overlay immediately on dismiss — no post-dismiss feedback panel.
  useEffect(() => {
    if (!isPeeking) {
      const t = setTimeout(() => setShowAlert(false), 200);
      return () => clearTimeout(t);
    }
  }, [isPeeking]);

  // Owner-verified dismiss: requires the real owner's face in frame.
  // Prevents a stranger from tapping "Dismiss" to bypass the guard.
  const verifyOwnerAndDismiss = useCallback(async () => {
    setAuthBusy(true);
    try {
      const owner = await loadOwnerProfile();
      if (!owner || owner.count === 0) {
        // No owner enrolled — fall back to tap-dismiss.
        hapticLight();
        dismissPeek();
        lastDismissAtRef.current = Date.now();
        return;
      }
      const lease = await acquireCamera("user", "PEEK_GUARD");
      try {
        const video = document.createElement("video");
        video.setAttribute("playsinline", "");
        video.setAttribute("autoplay", "");
        video.muted = true;
        video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(video);
        video.srcObject = lease.stream;
        await video.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 200));
        const faces = await detectFaces(video, performance.now());
        video.srcObject = null;
        video.remove();

        if (faces.length === 0) {
          toast({ title: "Owner not detected", description: "Show your face to dismiss.", variant: "destructive" });
          hapticWarning();
          return;
        }
        const bestFace = faces.reduce((a, b) => (a.area > b.area ? a : b));
        const { score: matchScore, threshold } = matchAgainstOwnerPoseAware(
          bestFace.embedding, owner, 0.7, bestFace.pose.yaw, bestFace.pose.pitch,
        );
        if (matchScore < threshold) {
          toast({ title: "Owner not recognized", description: "Face doesn't match enrolled owner.", variant: "destructive" });
          hapticWarning();
          return;
        }
        // Face-ID-style attention check (opt-out in settings for low-light/glasses).
        if (appSettings.peekRequireAttention ?? true) {
          const { attentive } = isAttentive(bestFace);
          if (!attentive) {
            toast({ title: "Look at the screen to unlock", description: "Eyes open, facing the camera.", variant: "destructive" });
            hapticWarning();
            return;
          }
        }
        hapticSuccess();
        dismissPeek();
        lastDismissAtRef.current = Date.now();
        // Quiet continuous template adaptation — same as Face ID after unlock.
        void maybeAdaptOwnerProfile(bestFace, owner, matchScore, threshold);
      } finally {
        lease.release();
      }
    } catch {
      // Camera error — fall back to tap-dismiss.
      hapticLight();
      dismissPeek();
      lastDismissAtRef.current = Date.now();
    } finally {
      setAuthBusy(false);
    }
  }, [dismissPeek, toast, appSettings.peekRequireAttention]);

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
      dismissPeek();
      lastDismissAtRef.current = Date.now();
    } catch {
      // Biometric failed/cancelled — offer PIN if one is set rather than
      // stranding the owner with no recourse in low light or with gloves.
      hapticError();
      if (storage.get(STORED_PIN_KEY)) {
        setPinValue("");
        setPinError(false);
        setShowPinFallback(true);
      }
    } finally {
      setAuthBusy(false);
    }
  }, [dismissPeek, verifyOwnerAndDismiss]);

  const submitPinDigit = useCallback((digit: string) => {
    setPinValue((prev) => {
      const next = (prev + digit).slice(0, PIN_LENGTH);
      if (next.length === PIN_LENGTH) {
        const stored = storage.get(STORED_PIN_KEY);
        if (!stored) return next;
        setPinBusy(true);
        verifyPin(next, stored).then((ok) => {
          setPinBusy(false);
          if (ok) {
            hapticSuccess();
            dismissPeek();
            lastDismissAtRef.current = Date.now();
            setShowPinFallback(false);
          } else {
            hapticWarning();
            setPinError(true);
            setTimeout(() => { setPinValue(""); setPinError(false); }, 500);
          }
        });
      }
      return next;
    });
  }, [dismissPeek]);

  const pinBackspace = useCallback(() => setPinValue((p) => p.slice(0, -1)), []);

  // "stranger/spoof/multiple" reason → auto-fire biometric the instant the
  // lock appears (once per episode). A stranger being there is exactly the
  // scenario biometric proves against. "no-face" (owner just not there) gets
  // no auto-prompt — no impersonation to rule out, just friction.
  const strangerReason = reason === "stranger" || reason === "spoof" || reason === "multiple";

  useEffect(() => {
    if (!isPeeking || !Capacitor.isNativePlatform() || !strangerReason || autoBiometricTriedRef.current) return;
    autoBiometricTriedRef.current = true;
    const t = setTimeout(() => tryBiometric(), 200);
    return () => clearTimeout(t);
  }, [isPeeking, strangerReason, tryBiometric]);

  if (!appSettings.peekGuard) return null;
  if (!showAlert && !debugSnap) return null;

  const reasonText =
    reason === "stranger"  ? `Stranger detected — ${strangersDetected} unknown face${strangersDetected === 1 ? "" : "s"}` :
    reason === "multiple"  ? "Multiple people nearby" :
    reason === "no-face"   ? "No owner detected" :
    reason === "spoof"     ? "Unrecognized face held motionless — possible photo/screen" :
                             "Privacy alert";

  const debugHud = debugSnap && (
    <div className="fixed top-2 left-2 z-[9999] rounded-lg bg-black/80 text-white/90 text-[9px] font-mono px-2 py-1.5 space-y-0.5 pointer-events-none select-none safe-top safe-left">
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
            transition={{ duration: 0.12 }}
            className="fixed inset-0 z-[10000] flex flex-col items-center justify-center"
            style={{
              background: "radial-gradient(circle at 50% 42%, rgba(24,22,26,0.90) 0%, rgba(0,0,0,0.97) 72%)",
              backdropFilter: "blur(40px)",
              WebkitBackdropFilter: "blur(40px)",
            }}
            aria-modal="true" role="alertdialog"
            aria-label={showPinFallback ? "Enter PIN to unlock" : `Privacy lock. ${reasonText}`}
          >
            {showPinFallback ? (
              // ── PIN fallback panel ──────────────────────────────────────────
              <motion.div
                initial={{ scale: 0.94, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 460, damping: 32 }}
                className="text-center space-y-6 px-8 max-w-xs w-full"
              >
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold text-white tracking-tight">Enter PIN</h2>
                  <p className="text-[11px] text-white/50 leading-relaxed">
                    Biometric didn't go through — use your PIN instead.
                  </p>
                </div>
                <div className="flex gap-3 justify-center">
                  {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                    <motion.div key={i}
                      animate={pinError ? { x: [0, -6, 6, -6, 6, 0] } : {}}
                      transition={{ duration: 0.3 }}
                      className={`h-3.5 w-3.5 rounded-full border-2 transition-all ${
                        pinValue.length > i ? "bg-white border-white" : "bg-transparent border-white/30"
                      } ${pinError ? "border-destructive" : ""}`}
                    />
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-3 w-full max-w-[240px] mx-auto">
                  {["1","2","3","4","5","6","7","8","9","","0","⌫"].map((d, i) => (
                    <button key={i}
                      disabled={pinBusy}
                      onClick={() => { hapticTick(); if (d === "⌫") pinBackspace(); else if (d) submitPinDigit(d); }}
                      aria-label={d === "⌫" ? "Backspace" : d ? `Digit ${d}` : undefined}
                      className={`h-14 rounded-2xl flex items-center justify-center text-lg font-medium transition-all active:scale-90 disabled:opacity-50 ${
                        d ? "bg-white/10 text-white hover:bg-white/15" : "invisible"
                      } ${d === "⌫" ? "text-white/60 text-sm" : ""}`}>
                      {d}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => { setShowPinFallback(false); setPinValue(""); setPinError(false); }}
                  disabled={pinBusy}
                  className="text-[11px] text-white/50 underline disabled:opacity-50"
                >
                  Back
                </button>
              </motion.div>
            ) : (
              // ── Main lock panel ─────────────────────────────────────────────
              <motion.div
                initial={{ scale: 0.94, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 460, damping: 32 }}
                className="text-center space-y-5 px-8 max-w-xs"
              >
                {/* Animated shield icon */}
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

                {/* Recovery buttons — biometric first (fastest), owner-verify second */}
                <div className="space-y-2 pt-1">
                  {strangerReason && (
                    <button
                      ref={primaryButtonRef}
                      onClick={tryBiometric}
                      disabled={authBusy}
                      className="w-full px-5 py-2.5 rounded-xl bg-white text-black text-xs font-medium flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
                    >
                      <Fingerprint className="h-3.5 w-3.5" />
                      {authBusy ? "Authenticating…" : "Unlock with biometric"}
                    </button>
                  )}
                  <button
                    ref={strangerReason ? undefined : primaryButtonRef}
                    onClick={() => verifyOwnerAndDismiss()}
                    disabled={authBusy}
                    className={strangerReason
                      ? "w-full px-5 py-2 rounded-xl bg-white/10 text-white/70 text-[11px] active:scale-95 flex items-center justify-center gap-1.5 disabled:opacity-50"
                      : "w-full px-5 py-2.5 rounded-xl bg-white text-black text-xs font-medium flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"}
                    aria-label="Verify owner face and dismiss"
                  >
                    <Lock className={strangerReason ? "h-3 w-3" : "h-3.5 w-3.5"} />
                    {authBusy ? "Verifying…" : "Dismiss (owner verify)"}
                  </button>
                </div>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default PeekGuard;
