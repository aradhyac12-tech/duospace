import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { ShieldAlert, ScanFace, Fingerprint, KeyRound, Moon, Eye, RefreshCw, Check } from "lucide-react";
import { usePeekDetection } from "@/hooks/usePeekDetection";
import { useTheme } from "@/contexts/ThemeContext";
import { useState, useEffect, useCallback, useMemo, useRef, type CSSProperties } from "react";
import { Capacitor } from "@capacitor/core";
import { hapticWarning, hapticError, hapticLight, hapticSuccess, hapticTick } from "@/lib/haptics";
import { useToast } from "@/hooks/use-toast";
import { detectFaces, loadOwnerProfile, matchAgainstOwnerPoseAware, isAttentive, maybeAdaptOwnerProfile } from "@/lib/faceRecognition";
import { acquireCamera } from "@/lib/cameraBus";
import storage from "@/lib/storage";
import { verifyPin } from "@/lib/crypto";

// Must match AppLockScreen.tsx's STORED_PIN_KEY — same PIN, same credential,
// just a second place it can be entered when biometric fails here.
const STORED_PIN_KEY = "duo-lock-pin";
/** Face ID parity: face alone isn't trusted forever. After this long without a
 *  stronger factor (device biometric or PIN) the automatic face unlock is
 *  paused until you confirm once. (Apple: passcode after ~6.5 days.) */
const LAST_STRONG_AUTH_KEY = "duo-peek-last-strong-auth";
const STRONG_AUTH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const readStrongStamp = (): number => {
  const raw = Number(storage.get(LAST_STRONG_AUTH_KEY));
  if (Number.isFinite(raw) && raw > 0) return raw;
  const now = Date.now(); // first run: start the clock instead of locking you out
  storage.set(LAST_STRONG_AUTH_KEY, String(now));
  return now;
};
const PIN_LENGTH = 6;

/** How long the automatic face scan gets to confirm you before the OS
 *  biometric prompt opens by itself (when the lock wasn't caused by a
 *  stranger — a stranger lock prompts almost immediately, see below). */
const FACE_GRACE_MS = 1800;
/** If the face scan is visibly mid-confirmation, give it this long to finish
 *  before interrupting with a system dialog. */
const SCAN_DEFER_MS = 700;
const MAX_SCAN_DEFERS = 3;
/** Phone-style lockout: this many failed manual face scans disables the manual
 *  face button for a while (biometric/PIN still work), so a stranger can't
 *  hammer it. Resets on any successful unlock. */
const MAX_FACE_FAILURES = 5;
const FACE_LOCKOUT_MS = 30_000;
/** Hard cap on the AUTOMATIC recovery attempts (face scan + OS biometric
 *  prompt) per lock. After this the lock stays up and everything is manual:
 *  tap "Unlock with biometric" / "Scan my face" / "Use PIN". */
const AUTO_WINDOW_MS = 25_000;
/** How long we wait on the OS biometric prompt before giving up on it
 *  (automatic one / one the person opened themselves). */
const AUTO_BIO_MAX_MS = 25_000;
const MANUAL_BIO_MAX_MS = 30_000;
/** Without biometric hardware, auto-reveal the PIN pad after this long. */
const PIN_AUTO_REVEAL_MS = 2500;

const SUPPORTS_BLUR =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" &&
  (CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)"));

type CoverStyle = "frost" | "aurora" | "decoy" | "classic";

/**
 * PeekGuard
 * ─────────
 * Mounts the peek-detection pipeline (camera + MediaPipe owner recognition)
 * and renders a full-screen privacy cover when a breach is confirmed.
 *
 * Recovery paths, all running together so nobody has to hunt for a button:
 *   1. AUTO FACE: the hook keeps tracking faces while locked and clears the
 *      lock the moment the owner alone is confidently back (usePeekDetection.ts).
 *      Works in dim/dark rooms too (low-light boost) and no longer waits out
 *      the post-lock cooldown. The ring on screen shows its progress.
 *   2. AUTO BIOMETRIC: if the face scan hasn't confirmed within a short grace
 *      window (immediately for stranger locks, almost immediately in the dark)
 *      the OS fingerprint/face prompt opens by itself.
 *   3. AUTO PIN: with no biometric hardware, the PIN pad slides up on its own.
 *   4. MANUAL: "Scan my face", "Biometric" and "PIN" buttons are always there.
 *
 * Cover: no longer a flat black screen. Pick frosted glass (default), aurora,
 * decoy clock, or the classic dark blur in Peek Guard settings. Every style
 * fully hides what's underneath.
 *
 * Privacy: the underlying hook holds an *off-screen* video element while
 * enabled. We never record or transmit frames — embeddings live in IndexedDB.
 */
const PeekGuard = () => {
  const { appSettings } = useTheme();

  const [strongStamp, setStrongStamp]   = useState<number>(() => readStrongStamp());
  const [bioAvailable, setBioAvailable] = useState(false);
  // Android "face authentication" is often a Class-2 (weak) biometric that a
  // photo can fool (Android CDD / source.android.com biometric docs).
  const [faceOnlyBiometric, setFaceOnlyBiometric] = useState(false);
  const hasPin = !!storage.get(STORED_PIN_KEY);
  // Only enforce staleness when there IS a stronger factor to fall back on.
  const faceUnlockStale = (hasPin || bioAvailable) && Date.now() - strongStamp > STRONG_AUTH_MAX_AGE_MS;
  // The automatic recovery attempts only run for AUTO_WINDOW_MS after a lock;
  // afterwards the person drives it manually. `windowEpoch` restarts the window.
  const [autoWindowOpen, setAutoWindowOpen] = useState(true);
  const [windowEpoch, setWindowEpoch] = useState(0);

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
    autoUnlockOnOwner:           (appSettings.peekAutoUnlockOnOwner ?? true) && !faceUnlockStale && autoWindowOpen,
    autoUnlockConsistencyFrames: appSettings.peekAutoUnlockConsistencyFrames ?? 1,
    autoUnlockDelay:              appSettings.peekAutoUnlockDelay             ?? 15,
    lowLightBoost:                true, // always on: automatic, not a user setting
    requireAttention:             appSettings.peekRequireAttention            ?? true,
  }), [
    appSettings.peekMatchThreshold, appSettings.peekMinFaceArea,
    appSettings.peekConsistencyFrames, appSettings.peekLockDelay,
    appSettings.peekCheckInterval, appSettings.peekAlertOnStranger,
    appSettings.peekAlertOnMultipleFaces, appSettings.peekAlertOnNoFace,
    appSettings.peekNoFaceSustainMs, appSettings.peekStaticStrangerTimeoutMs,
    appSettings.peekAutoUnlockOnOwner, faceUnlockStale, autoWindowOpen, appSettings.peekAutoUnlockConsistencyFrames,
    appSettings.peekAutoUnlockDelay, appSettings.peekRequireAttention,
  ]);

  const {
    isPeeking, facesDetected, strangersDetected, ownerEnrolled,
    reason, threatScore, threatLevel, dismiss: dismissPeek,
    getDebugSnapshot, error: peekError,
    lightLevel, unlockProgress, ownerInFrame, recheck, getUnlockCandidate,
  } = usePeekDetection(appSettings.peekGuard ?? false, peekConfig);

  const { toast } = useToast();
  const [showAlert, setShowAlert]         = useState(false);
  const [authBusy,  setAuthBusy]          = useState(false);
  const [debugSnap, setDebugSnap]         = useState<ReturnType<typeof getDebugSnapshot> | null>(null);
  // PIN fallback: revealed by the user, by a failed biometric, or automatically.
  const [showPinFallback, setShowPinFallback] = useState(false);
  const [pinValue, setPinValue]           = useState("");
  const [pinError, setPinError]           = useState(false);
  const [pinBusy,  setPinBusy]            = useState(false);
  // Decoy cover keeps controls tucked away until asked for.
  const [optionsOpen, setOptionsOpen]     = useState(false);
  const [clock, setClock]                 = useState(() => new Date());
  const [faceLockoutUntil, setFaceLockoutUntil] = useState(0);
  // Brief "welcome back" state between unlock and the cover leaving, so the
  // lock doesn't just vanish (reduced-motion users get a near-instant exit).
  const [unlocked, setUnlocked]           = useState(false);
  const reduceMotion = useReducedMotion();
  const faceFailuresRef = useRef(0);
  const faceLockoutUntilRef = useRef(0);
  faceLockoutUntilRef.current = faceLockoutUntil;
  const faceStaleRef = useRef(false);
  faceStaleRef.current = faceUnlockStale;
  const faceLockedOut = Date.now() < faceLockoutUntil;
  const faceBlocked = faceLockedOut || faceUnlockStale;

  // Fixed, automatic behaviour — deliberately not user settings.
  const coverStyle = "frost" as CoverStyle;
  const autoBiometric = true;
  const isNative = Capacitor.isNativePlatform();

  const primaryButtonRef   = useRef<HTMLButtonElement>(null);
  // Guards the once-per-episode auto-biometric prompt.
  const autoBiometricTriedRef = useRef(false);
  const biometricInFlightRef = useRef(false);
  // Latest values read from timers (so timers don't restart on every change).
  const unlockProgressRef = useRef(0);
  const lightLevelRef = useRef(lightLevel);
  unlockProgressRef.current = unlockProgress;
  lightLevelRef.current = lightLevel;
  // Time of the last owner-verified dismiss (used only to soften haptics on a quick re-lock).
  const lastDismissAtRef = useRef<number>(0);

  // Probe biometric hardware once (native only).
  useEffect(() => {
    if (!isNative || !appSettings.peekGuard) return;
    let cancelled = false;
    (async () => {
      try {
        const { NativeBiometric, BiometryType } = await import("capacitor-native-biometric");
        const probe = await NativeBiometric.isAvailable();
        if (!cancelled) {
          setBioAvailable(!!probe.isAvailable);
          setFaceOnlyBiometric(
            Capacitor.getPlatform() === "android" && probe.biometryType === BiometryType.FACE_AUTHENTICATION,
          );
        }
      } catch { if (!cancelled) setBioAvailable(false); }
    })();
    return () => { cancelled = true; };
  }, [isNative, appSettings.peekGuard]);

  // Focus the primary recovery button as soon as the lock renders so keyboard
  // and screen-reader users don't have to tab to it.
  useEffect(() => {
    if (showAlert) {
      const t = setTimeout(() => primaryButtonRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [showAlert]);

  // Decoy clock tick — only while the decoy is actually showing.
  useEffect(() => {
    if (!showAlert || coverStyle !== "decoy") return;
    setClock(new Date());
    const t = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(t);
  }, [showAlert, coverStyle]);

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
      // Re-locking soon after an unlock (persistent crowd, flapping detection)
      // used to show only a toast and auto-dismiss after 2s — i.e. the screen
      // was NOT covered, which a stranger could exploit. The cover is now
      // always shown; a quick re-lock just gets a gentler haptic, and the
      // hook's escalating cooldown + auto face unlock keep it from being
      // annoying for the real owner.
      const quickRelock = Date.now() - lastDismissAtRef.current < 5000 && lastDismissAtRef.current > 0;
      setShowPinFallback(false);
      setPinValue("");
      setPinError(false);
      setOptionsOpen(false);
      autoBiometricTriedRef.current = false;
      setShowAlert(true);
      (quickRelock ? hapticLight : threatLevel === "critical" ? hapticError : hapticWarning)();
    } else {
      autoBiometricTriedRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPeeking]);

  // Close the automatic-recovery window AUTO_WINDOW_MS after a lock starts
  // (or after the person taps "Try automatic scan again").
  useEffect(() => {
    if (!isPeeking) { setAutoWindowOpen(true); return; }
    setAutoWindowOpen(true);
    const t = setTimeout(() => setAutoWindowOpen(false), AUTO_WINDOW_MS);
    return () => clearTimeout(t);
  }, [isPeeking, windowEpoch]);

  // Hide the overlay immediately on dismiss — no post-dismiss feedback panel.
  useEffect(() => {
    if (!isPeeking) {
      if (showAlert) setUnlocked(true);
      const t = setTimeout(() => { setShowAlert(false); setUnlocked(false); }, reduceMotion ? 120 : 520);
      return () => clearTimeout(t);
    }
    setUnlocked(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPeeking]);

  const finishUnlock = useCallback((via: "face" | "biometric" | "pin" = "face") => {
    faceFailuresRef.current = 0;
    if (via !== "face") {
      // A stronger factor just vouched for you: restart the freshness clock, and
      // (Face ID's second learning path) learn from the near-miss face we saw
      // while locked so the same lighting/look matches next time.
      const t = Date.now();
      storage.set(LAST_STRONG_AUTH_KEY, String(t));
      setStrongStamp(t);
      const cand = getUnlockCandidate();
      if (cand) {
        void loadOwnerProfile().then((o) => {
          if (o) return maybeAdaptOwnerProfile(cand.face, o, cand.score, cand.threshold, { strongAuth: true });
        }).catch(() => { /* learning is best-effort */ });
      }
    }
    hapticSuccess();
    dismissPeek();
    lastDismissAtRef.current = Date.now();
    setShowPinFallback(false);
  }, [dismissPeek, getUnlockCandidate]);

  // Owner-verified dismiss ("Scan my face"): requires the real owner's face in
  // frame. Prevents a stranger from tapping the button to bypass the guard.
  // Tries a few frames — the first one off a freshly-opened stream is often
  // dark/unfocused, which used to make the very first tap fail for no reason.
  const verifyOwnerAndDismiss = useCallback(async () => {
    if (Date.now() < faceLockoutUntilRef.current || faceStaleRef.current) return;
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
      let video: HTMLVideoElement | null = null;
      try {
        video = document.createElement("video");
        video.setAttribute("playsinline", "");
        video.setAttribute("autoplay", "");
        video.muted = true;
        video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
        document.body.appendChild(video);
        video.srcObject = lease.stream;
        await video.play().catch(() => {});
        await new Promise((r) => setTimeout(r, 200));

        let failure: { title: string; description: string } | null = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 260));
          const faces = await detectFaces(video, performance.now());
          if (faces.length === 0) {
            failure = { title: "Owner not detected", description: "Show your face to unlock." };
            continue;
          }
          const bestFace = faces.reduce((a, b) => (a.area > b.area ? a : b));
          const { score: matchScore, threshold } = matchAgainstOwnerPoseAware(
            bestFace.embedding, owner, 0.7, bestFace.pose.yaw, bestFace.pose.pitch,
          );
          if (matchScore < threshold) {
            failure = { title: "Owner not recognized", description: "Face doesn't match enrolled owner." };
            continue;
          }
          // Face-ID-style attention check (opt-out in settings for low-light/glasses).
          if ((appSettings.peekRequireAttention ?? true) && lightLevelRef.current === "bright") {
            const { attentive } = isAttentive(bestFace);
            if (!attentive) {
              failure = { title: "Look at the screen to unlock", description: "Eyes open, facing the camera." };
              continue;
            }
          }
          failure = null;
          finishUnlock();
          // Quiet continuous template adaptation — same as Face ID after unlock.
          void maybeAdaptOwnerProfile(bestFace, owner, matchScore, threshold);
          return;
        }
        if (failure) {
          faceFailuresRef.current += 1;
          if (faceFailuresRef.current >= MAX_FACE_FAILURES) {
            faceFailuresRef.current = 0;
            setFaceLockoutUntil(Date.now() + FACE_LOCKOUT_MS);
            setTimeout(() => setFaceLockoutUntil(0), FACE_LOCKOUT_MS + 50);
            toast({ title: "Face scan paused", description: "Too many attempts — use biometric or PIN.", variant: "destructive" });
          } else {
            toast({ ...failure, variant: "destructive" });
          }
          hapticWarning();
        }
      } finally {
        if (video) { video.srcObject = null; video.remove(); }
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
  }, [dismissPeek, finishUnlock, toast, appSettings.peekRequireAttention]);

  const tryBiometric = useCallback(async (opts: { auto?: boolean } = {}) => {
    if (biometricInFlightRef.current) return;
    if (!Capacitor.isNativePlatform()) {
      if (!opts.auto) verifyOwnerAndDismiss();
      return;
    }
    biometricInFlightRef.current = true;
    setAuthBusy(true);
    try {
      const { NativeBiometric } = await import("capacitor-native-biometric");
      const probe = await NativeBiometric.isAvailable();
      if (!probe.isAvailable) {
        if (opts.auto) { if (storage.get(STORED_PIN_KEY)) setShowPinFallback(true); }
        else verifyOwnerAndDismiss();
        return;
      }
      const verify = NativeBiometric.verifyIdentity({
        reason: "Unlock screen",
        title: "Privacy lock",
        subtitle: "Verify it's really you",
        description: "Confirm it's you to continue",
        negativeButtonText: storage.get(STORED_PIN_KEY) ? "Use PIN" : "Cancel",
      });
      // Don't wait on the OS prompt forever. If it's still open after the
      // limit we stop tracking it (UI becomes usable again, manual buttons
      // work); a late successful scan on a lingering dialog still unlocks.
      let timedOut = false;
      const limit = opts.auto ? AUTO_BIO_MAX_MS : MANUAL_BIO_MAX_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error("biometric-timeout")); }, limit);
      });
      verify.then(() => { if (timedOut) finishUnlock("biometric"); }, () => { /* handled below */ });
      try {
        await Promise.race([verify, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      finishUnlock("biometric");
    } catch {
      // Biometric failed/cancelled/timed out — offer PIN if one is set rather
      // than stranding the owner with no recourse in low light or with gloves.
      hapticError();
      if (storage.get(STORED_PIN_KEY)) {
        setPinValue("");
        setPinError(false);
        setShowPinFallback(true);
      }
    } finally {
      biometricInFlightRef.current = false;
      setAuthBusy(false);
    }
  }, [finishUnlock, verifyOwnerAndDismiss]);

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
            finishUnlock("pin");
          } else {
            hapticWarning();
            setPinError(true);
            setTimeout(() => { setPinValue(""); setPinError(false); }, 500);
          }
        });
      }
      return next;
    });
  }, [finishUnlock]);

  const pinBackspace = useCallback(() => setPinValue((p) => p.slice(0, -1)), []);

  // "stranger/spoof/multiple" reason → someone else may be holding the phone.
  // Face auto-unlock can't (and shouldn't) fire until they're gone, so the
  // biometric prompt goes up almost immediately. "no-face" (owner just not
  // there) gets the face scan a short head start first.
  const strangerReason = reason === "stranger" || reason === "spoof" || reason === "multiple";

  // AUTO BIOMETRIC: once per lock episode.
  //   stranger lock → ~200ms        dark room → ~400ms        otherwise → after
  //   the face-scan grace window. If the face scan is visibly mid-confirmation
  //   the prompt is deferred a little (so it doesn't interrupt a success).
  useEffect(() => {
    if (!isPeeking || !isNative || !autoBiometric || !bioAvailable) return;
    if (autoBiometricTriedRef.current) return;
    // Weak (photo-spoofable) Android face biometric must not be the thing that
    // clears a stranger/spoof lock — leave that to PIN / fingerprint.
    if (strangerReason && faceOnlyBiometric) return;
    // Phase 1 (AUTO_WINDOW_MS): the automatic face scan and the on-screen
    // options (PIN / manual buttons) try on their own. Phase 2: the system
    // biometric screen opens by itself. Face unlock paused (stale) → there is
    // nothing to wait for, so the biometric screen opens right away.
    const delay = faceUnlockStale ? 200 : AUTO_WINDOW_MS;
    let defers = 0;
    let timer: ReturnType<typeof setTimeout>;
    const fire = () => {
      if (autoBiometricTriedRef.current) return;
      if (!strangerReason && unlockProgressRef.current >= 0.3 && defers < MAX_SCAN_DEFERS) {
        defers++;
        timer = setTimeout(fire, SCAN_DEFER_MS);
        return;
      }
      autoBiometricTriedRef.current = true;
      void tryBiometric({ auto: true });
    };
    timer = setTimeout(fire, delay);
    return () => clearTimeout(timer);
  }, [isPeeking, isNative, autoBiometric, bioAvailable, strangerReason, tryBiometric, faceOnlyBiometric, faceUnlockStale, windowEpoch]);

  // AUTO PIN: no biometric hardware (or auto-biometric off) → don't leave the
  // owner hunting for a button. Only when a PIN actually exists.
  useEffect(() => {
    if (!isPeeking || !hasPin) return;
    const biometricWillHandleIt = isNative && autoBiometric && bioAvailable && !(strangerReason && faceOnlyBiometric);
    if (biometricWillHandleIt) return;
    const t = setTimeout(() => {
      if (unlockProgressRef.current < 0.3) setShowPinFallback(true);
    }, PIN_AUTO_REVEAL_MS);
    return () => clearTimeout(t);
  }, [isPeeking, hasPin, isNative, autoBiometric, bioAvailable, strangerReason, faceOnlyBiometric]);

  if (!appSettings.peekGuard) return null;
  if (!showAlert && !debugSnap) return null;

  // ── Copy ───────────────────────────────────────────────────────────────
  const reasonText =
    reason === "stranger"  ? `Stranger detected — ${strangersDetected} unknown face${strangersDetected === 1 ? "" : "s"}` :
    reason === "multiple"  ? "Multiple people nearby" :
    reason === "no-face"   ? "You stepped away" :
    reason === "spoof"     ? "Unrecognized face held motionless — possible photo/screen" :
                             "Privacy alert";

  const scanning = ownerEnrolled && !strangerReason;
  const statusText =
    faceUnlockStale ? "Confirm with biometric or PIN to turn face unlock back on" :
    !autoWindowOpen ? "Auto scan finished — verify with biometric or PIN" :
    ownerInFrame && unlockProgress > 0 ? "Recognizing you…" :
    lightLevel === "dark" ? "Low light — scanning with night boost" :
    strangerReason ? reasonText :
    ownerEnrolled ? "Looking for you…" :
    "Locked";

  // ── Theme-aware palette (classic stays fixed dark) ───────────────────
  const classic = coverStyle === "classic";
  const fg        = classic ? "text-white"        : "text-foreground";
  const fgMuted   = classic ? "text-white/55"     : "text-muted-foreground";
  const fgFaint   = classic ? "text-white/35"     : "text-muted-foreground/70";
  const btnMain   = classic ? "bg-white text-black" : "bg-foreground text-background";
  const btnQuiet  = classic ? "bg-white/10 text-white/80" : "bg-foreground/10 text-foreground";
  const pinKey    = classic ? "bg-white/10 text-white hover:bg-white/15" : "bg-foreground/10 text-foreground hover:bg-foreground/15";
  const pinDotOn  = classic ? "bg-white border-white" : "bg-foreground border-foreground";
  const pinDotOff = classic ? "bg-transparent border-white/30" : "bg-transparent border-foreground/30";
  const ringTrack = classic ? "rgba(255,255,255,0.15)" : "hsl(var(--foreground) / 0.15)";
  const ringFill  = unlocked ? "#22c55e" : strangerReason ? "hsl(var(--destructive))" : "hsl(var(--primary))";

  // ── Cover background ───────────────────────────────────────────────────
  // Every variant hides the content underneath; if the WebView can't do
  // backdrop-filter we fall back to a near-opaque tint rather than leaking.
  const coverBackground: CSSProperties =
    classic ? {
      background: "radial-gradient(circle at 50% 42%, rgba(24,22,26,0.90) 0%, rgba(0,0,0,0.97) 72%)",
      ...(SUPPORTS_BLUR ? { backdropFilter: "blur(40px)", WebkitBackdropFilter: "blur(40px)" } : {}),
    } :
    coverStyle === "decoy" ? {
      background: "linear-gradient(165deg, hsl(var(--background)) 0%, hsl(var(--primary) / 0.28) 100%)",
    } : {
      background: SUPPORTS_BLUR ? "hsl(var(--background) / 0.52)" : "hsl(var(--background) / 0.96)",
      ...(SUPPORTS_BLUR ? { backdropFilter: "blur(30px) saturate(1.35)", WebkitBackdropFilter: "blur(30px) saturate(1.35)" } : {}),
    };

  const RING_R = 34;
  const RING_C = 2 * Math.PI * RING_R;
  const controlsVisible = coverStyle !== "decoy" || optionsOpen || showPinFallback;

  const debugHud = debugSnap && (
    <div className="fixed top-2 left-2 z-[9999] rounded-lg bg-black/80 text-white/90 text-[9px] font-mono px-2 py-1.5 space-y-0.5 pointer-events-none select-none safe-top safe-left">
      <p>peek: {isPeeking ? "LOCKED" : "watching"} · threat {threatScore}/100 ({threatLevel})</p>
      <p>faces {facesDetected} · strangers {strangersDetected} · owner {ownerEnrolled ? "✓" : "✗"} · tracks {debugSnap.tracks}</p>
      <p>
        {debugSnap.usingWorker ? "worker" : "main-thread fallback"} ·
        {" "}~{Math.round(1000 / Math.max(1, debugSnap.effectiveIntervalMs))}fps
        {" "}({debugSnap.effectiveIntervalMs}ms)
      </p>
      <p>light {debugSnap.lightLevel}{debugSnap.enhanced ? " · boosted" : ""} ({Math.round(debugSnap.brightness)})</p>
      {isPeeking && <p>auto-unlock {Math.round(unlockProgress * 100)}%{ownerInFrame ? " · owner in frame" : ""}</p>}
      {debugSnap.cameraCovered && <p className="text-warning">camera covered</p>}
      {debugSnap.crowdModeActive && <p className="text-warning">crowd mode — stricter threshold</p>}
      {debugSnap.consecutiveLocks > 0 && <p className="text-white/50">cooldown streak: {debugSnap.consecutiveLocks}</p>}
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
            transition={{ duration: unlocked && !reduceMotion ? 0.3 : 0.12 }}
            className="fixed inset-0 z-[10000] flex flex-col items-center justify-center overflow-hidden"
            style={coverBackground}
            aria-modal="true" role="alertdialog"
            aria-label={showPinFallback ? "Enter PIN to unlock" : `Privacy lock. ${statusText}`}
          >
            {/* Aurora glow — theme-coloured, purely decorative */}
            {coverStyle === "aurora" && (
              <div aria-hidden="true" className="absolute inset-0 pointer-events-none">
                <motion.div
                  className="absolute -top-24 -left-20 h-80 w-80 rounded-full blur-3xl"
                  style={{ background: "radial-gradient(circle, hsl(var(--primary) / 0.55), transparent 70%)" }}
                  animate={{ x: [0, 50, 0], y: [0, 30, 0], opacity: [0.6, 0.9, 0.6] }}
                  transition={{ repeat: Infinity, duration: 9, ease: "easeInOut" }}
                />
                <motion.div
                  className="absolute -bottom-28 -right-16 h-96 w-96 rounded-full blur-3xl"
                  style={{ background: "radial-gradient(circle, hsl(var(--primary) / 0.45), transparent 70%)", filter: "hue-rotate(50deg)" }}
                  animate={{ x: [0, -40, 0], y: [0, -40, 0], opacity: [0.5, 0.85, 0.5] }}
                  transition={{ repeat: Infinity, duration: 11, ease: "easeInOut" }}
                />
              </div>
            )}

            {/* Decoy clock — looks like an idle wallpaper, says nothing about privacy */}
            {coverStyle === "decoy" && !showPinFallback && (
              <div className="absolute top-[18%] inset-x-0 text-center select-none pointer-events-none" aria-hidden="true">
                <p className="text-6xl font-light tracking-tight text-foreground/85 tabular-nums">
                  {clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </p>
                <p className="text-sm text-foreground/50 mt-1">
                  {clock.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
                </p>
              </div>
            )}

            <div className="relative z-10 flex flex-col items-center justify-center w-full">
            {showPinFallback ? (
              // ── PIN fallback panel ──────────────────────────────────────────
              <motion.div
                initial={{ scale: 0.94, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 460, damping: 32 }}
                className="text-center space-y-6 px-8 max-w-xs w-full"
              >
                <div className="space-y-1">
                  <h2 className={`text-sm font-semibold tracking-tight ${fg}`}>Enter PIN</h2>
                  <p className={`text-[11px] leading-relaxed ${fgMuted}`}>
                    {lightLevel === "dark" ? "It's too dark to scan your face — use your PIN." : "Use your PIN to unlock."}
                  </p>
                </div>
                <div className="flex gap-3 justify-center">
                  {Array.from({ length: PIN_LENGTH }).map((_, i) => (
                    <motion.div key={i}
                      animate={pinError ? { x: [0, -6, 6, -6, 6, 0] } : {}}
                      transition={{ duration: 0.3 }}
                      className={`h-3.5 w-3.5 rounded-full border-2 transition-all ${
                        pinValue.length > i ? pinDotOn : pinDotOff
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
                        d ? pinKey : "invisible"
                      } ${d === "⌫" ? "text-sm" : ""}`}>
                      {d}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => { setShowPinFallback(false); setPinValue(""); setPinError(false); }}
                  disabled={pinBusy}
                  className={`text-[11px] underline disabled:opacity-50 ${fgMuted}`}
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
                className={`text-center space-y-5 px-8 max-w-xs ${coverStyle === "decoy" ? "mt-[38vh]" : ""}`}
              >
                {/* Scan ring: fills as the automatic face unlock gains confidence */}
                <div className="relative mx-auto h-[84px] w-[84px] flex items-center justify-center">
                  <motion.div
                    aria-hidden="true"
                    className="absolute inset-0 rounded-full blur-xl"
                    style={{ background: ringFill, opacity: 0.25 }}
                    animate={{ opacity: [0.15, 0.35, 0.15], scale: [0.92, 1.06, 0.92] }}
                    transition={{ repeat: Infinity, duration: 2.2, ease: "easeInOut" }}
                  />
                  <svg className="absolute inset-0 -rotate-90" viewBox="0 0 84 84" aria-hidden="true">
                    <circle cx="42" cy="42" r={RING_R} fill="none" stroke={ringTrack} strokeWidth="3" />
                    <circle cx="42" cy="42" r={RING_R} fill="none" stroke={ringFill} strokeWidth="3" strokeLinecap="round"
                      strokeDasharray={RING_C}
                      strokeDashoffset={RING_C * (1 - (unlocked ? 1 : Math.max(0.04, unlockProgress)))}
                      style={{ transition: "stroke-dashoffset 220ms ease-out" }} />
                  </svg>
                  {unlocked
                    ? <motion.div initial={reduceMotion ? false : { scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 500, damping: 22 }} className="relative">
                        <Check className="h-9 w-9 text-green-500" />
                      </motion.div>
                    : scanning
                    ? <ScanFace className={`relative h-8 w-8 ${fg}`} />
                    : <ShieldAlert className="relative h-8 w-8 text-destructive" />}
                </div>

                <div className="space-y-1" aria-live="polite">
                  <h2 className={`text-base font-semibold tracking-tight ${coverStyle === "decoy" ? "sr-only" : fg}`}>Privacy lock</h2>
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.p key={unlocked ? "welcome" : statusText}
                      initial={reduceMotion ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }}
                      exit={reduceMotion ? undefined : { opacity: 0, y: -3 }} transition={{ duration: 0.14 }}
                      className={`text-xs leading-relaxed ${fgMuted}`}>
                      {unlocked ? "Welcome back" : statusText}
                    </motion.p>
                  </AnimatePresence>
                  {lightLevel === "dark" && (
                    <p className={`text-[10px] pt-0.5 flex items-center justify-center gap-1 ${fgFaint}`}>
                      <Moon className="h-3 w-3" /> Fingerprint or PIN is fastest in the dark
                    </p>
                  )}
                  {!ownerEnrolled && (
                    <p className="text-[10px] text-warning/90 pt-1">
                      Enroll your face in Settings for stranger detection
                    </p>
                  )}
                  {(threatLevel === "high" || threatLevel === "critical") && coverStyle !== "decoy" && (
                    <p className="text-[10px] text-destructive/90 pt-1 uppercase tracking-wide">
                      {threatLevel} threat
                    </p>
                  )}
                </div>

                {coverStyle !== "decoy" && (
                  <div className={`flex items-center justify-center gap-1.5 text-[10px] ${fgFaint}`}>
                    <Eye className="h-3 w-3" /> Monitoring active
                  </div>
                )}

                {/* Manual options — always available alongside the automatic paths */}
                {unlocked ? null : controlsVisible ? (
                  <div className="space-y-2 pt-1">
                    {faceLockedOut && !faceUnlockStale && (
                      <p className={`text-[10px] ${fgMuted}`}>Face scan paused for a moment — use biometric or PIN.</p>
                    )}
                    {(bioAvailable || (!isNative && !faceBlocked)) && (
                      <button
                        ref={primaryButtonRef}
                        onClick={() => (isNative ? tryBiometric() : verifyOwnerAndDismiss())}
                        disabled={authBusy}
                        className={`w-full px-5 py-2.5 rounded-xl text-xs font-medium flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50 ${btnMain}`}
                      >
                        {isNative ? <Fingerprint className="h-3.5 w-3.5" /> : <ScanFace className="h-3.5 w-3.5" />}
                        {authBusy ? "Authenticating…" : isNative ? "Unlock with biometric" : "Scan my face"}
                      </button>
                    )}
                    <div className="flex gap-2">
                      {isNative && !faceBlocked && (
                        <button
                          ref={bioAvailable ? undefined : primaryButtonRef}
                          onClick={() => verifyOwnerAndDismiss()}
                          disabled={authBusy}
                          className={`flex-1 px-3 py-2 rounded-xl text-[11px] active:scale-95 flex items-center justify-center gap-1.5 disabled:opacity-50 ${bioAvailable ? btnQuiet : btnMain}`}
                          aria-label="Scan my face to unlock"
                        >
                          <ScanFace className="h-3 w-3" /> Scan my face
                        </button>
                      )}
                      {hasPin && (
                        <button
                          onClick={() => { hapticLight(); setPinValue(""); setPinError(false); setShowPinFallback(true); }}
                          disabled={authBusy}
                          className={`flex-1 px-3 py-2 rounded-xl text-[11px] active:scale-95 flex items-center justify-center gap-1.5 disabled:opacity-50 ${btnQuiet}`}
                        >
                          <KeyRound className="h-3 w-3" /> Use PIN
                        </button>
                      )}
                    </div>
                    {ownerEnrolled && !strangerReason && !faceUnlockStale && (!autoWindowOpen || unlockProgress === 0) && (
                      <button
                        onClick={() => { hapticLight(); recheck(); autoBiometricTriedRef.current = false; setWindowEpoch((n) => n + 1); }}
                        className={`text-[10px] inline-flex items-center gap-1 pt-1 ${fgFaint}`}
                      >
                        <RefreshCw className="h-3 w-3" /> Try automatic scan again
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    ref={primaryButtonRef}
                    onClick={() => { hapticLight(); setOptionsOpen(true); }}
                    className={`mx-auto px-5 py-2 rounded-full text-[11px] active:scale-95 ${btnQuiet}`}
                  >
                    Unlock
                  </button>
                )}
              </motion.div>
            )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default PeekGuard;
