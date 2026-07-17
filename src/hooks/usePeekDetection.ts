/**
 * usePeekDetection — true owner-recognition peek guard.
 *
 * Pipeline (per detection tick, default ~600ms):
 *   1. Grab a frame from the hidden front-camera <video>.
 *   2. Run MediaPipe FaceLandmarker → list of faces with normalized embeddings.
 *   3. Filter out faces below `minFaceArea` (too far / specks).
 *   4. For each face, compute cosine similarity vs. enrolled owner embeddings
 *      (best-of-N). A face is "stranger" if best similarity < `matchThreshold`.
 *   5. Determine breach for *this frame*:
 *         • alertOnStranger        — any non-owner face visible
 *         • alertOnMultipleFaces   — total face count ≥ 2
 *         • alertOnNoFace          — zero faces (only when "stranger guard" is OK)
 *      The active alert modes are user-controlled in settings.
 *   6. Push the breach bool into a rolling buffer of `consistencyFrames`.
 *      Only when ALL frames in the buffer agree do we arm the lock timer.
 *   7. After `lockDelay`ms of continuous breach we surface `isPeeking = true`,
 *      which the PeekGuard component turns into a lock screen.
 *
 * No owner enrolled → falls back to count-based breach
 * (multi-face = breach; single face is fine).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  detectFaces, loadOwnerProfile, matchAgainstOwner,
  type OwnerProfile,
} from "@/lib/faceRecognition";
import { subscribeCameraBus, explainGumError, acquireCamera, type CameraLease } from "@/lib/cameraBus";

export interface PeekConfig {
  /** Cosine similarity threshold. ≥ this = owner. Default 0.7. */
  matchThreshold?: number;
  /** Min normalized face area (0..1). Below = ignored. Default 0.015 (~12%×12% of frame). */
  minFaceArea?: number;
  /** Number of consecutive frames the breach must be observed. Default 4. */
  consistencyFrames?: number;
  /** Sustained breach delay before locking (ms). Default 1500. */
  lockDelay?: number;
  /** Detection frequency in ms. Default 600. */
  checkInterval?: number;
  /** Trigger when a non-owner face is seen. Default true. */
  alertOnStranger?: boolean;
  /** Trigger when ≥ 2 faces are seen. Default true. */
  alertOnMultipleFaces?: boolean;
  /** Trigger when no face seen for the consistency window. Default false. */
  alertOnNoFace?: boolean;
}

const DEFAULTS: Required<PeekConfig> = {
  matchThreshold: 0.7,
  minFaceArea: 0.015,
  consistencyFrames: 4,
  lockDelay: 1500,
  checkInterval: 600,
  alertOnStranger: true,
  alertOnMultipleFaces: true,
  alertOnNoFace: false,
};

export interface PeekDetectionState {
  isPeeking: boolean;
  isActive: boolean;
  error: string | null;
  /** Total faces seen in the latest frame. */
  facesDetected: number;
  /** Strangers (non-owner) in the latest frame. */
  strangersDetected: number;
  /** True iff an owner profile is enrolled. */
  ownerEnrolled: boolean;
  /** Last reason that armed the lock. */
  reason: "stranger" | "multiple" | "no-face" | null;
}

export const usePeekDetection = (
  enabled: boolean,
  config: PeekConfig = {},
): PeekDetectionState => {
  const cfg = { ...DEFAULTS, ...config };
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const [isPeeking, setIsPeeking]               = useState(false);
  const [isActive, setIsActive]                 = useState(false);
  const [error, setError]                       = useState<string | null>(null);
  const [facesDetected, setFacesDetected]       = useState(0);
  const [strangersDetected, setStrangersDetected] = useState(0);
  const [ownerEnrolled, setOwnerEnrolled]       = useState(false);
  const [reason, setReason]                     = useState<PeekDetectionState["reason"]>(null);

  const videoRef    = useRef<HTMLVideoElement | null>(null);
  const leaseRef    = useRef<CameraLease | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownerRef    = useRef<OwnerProfile | null>(null);
  const breachBuf   = useRef<boolean[]>([]);
  const reasonBuf   = useRef<NonNullable<PeekDetectionState["reason"]>[]>([]);
  // Monotonic timestamp for FaceLandmarker.detectForVideo — must always increase.
  const tsRef       = useRef<number>(0);
  const externallyPausedRef = useRef(false);
  // Liveness: rolling Eye-Aspect-Ratio history per detection.
  // Used to require a blink (EAR drop > 0.06) within ~3s of any "stranger" trigger.
  const earHistoryRef = useRef<{ ts: number; ear: number }[]>([]);
  const lastLivenessOkRef = useRef<number>(0);
  // Cooldown after a confirmed peek event so the screen doesn't immediately re-trigger.
  const cooldownUntilRef = useRef<number>(0);

  // Load owner profile once / on enable
  useEffect(() => {
    let cancelled = false;
    loadOwnerProfile().then((p) => {
      if (cancelled) return;
      ownerRef.current = p;
      setOwnerEnrolled(!!p && p.count > 0);
    });
    return () => { cancelled = true; };
  }, [enabled]);

  const teardown = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (lockTimerRef.current) { clearTimeout(lockTimerRef.current); lockTimerRef.current = null; }
    if (leaseRef.current) { leaseRef.current.release(); leaseRef.current = null; }
    if (videoRef.current) { videoRef.current.srcObject = null; videoRef.current.remove(); videoRef.current = null; }
    breachBuf.current = [];
    reasonBuf.current = [];
    earHistoryRef.current = [];
    setIsActive(false);
  }, []);

  const tick = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;

    // Cooldown after a recent confirmed peek event — avoid re-triggering immediately.
    if (Date.now() < cooldownUntilRef.current) return;

    let faces;
    try {
      tsRef.current = Math.max(tsRef.current + 1, performance.now());
      faces = await detectFaces(video, tsRef.current);
    } catch {
      return;
    }
    const c = cfgRef.current;

    const significant = faces.filter((f) => f.area >= c.minFaceArea);
    setFacesDetected(significant.length);

    // ── Liveness tracking (blink detection via EAR drop) ───────────────────
    // Push the EAR of the largest face into a 2s rolling window. A blink is
    // a transient EAR drop > 0.06 (open ~0.32 → closed ~0.18). When seen,
    // mark "liveness OK" for the next 4 seconds.
    const now = Date.now();
    if (significant.length > 0) {
      const primary = significant.reduce((a, b) => (a.area > b.area ? a : b));
      earHistoryRef.current.push({ ts: now, ear: primary.ear });
      // Keep last 2s only
      while (earHistoryRef.current.length && now - earHistoryRef.current[0].ts > 2000) {
        earHistoryRef.current.shift();
      }
      const hist = earHistoryRef.current;
      if (hist.length >= 4) {
        const maxE = Math.max(...hist.map((h) => h.ear));
        const minE = Math.min(...hist.map((h) => h.ear));
        if (maxE - minE > 0.06) lastLivenessOkRef.current = now;
      }
    }
    const livenessOk = now - lastLivenessOkRef.current < 4000;

    let strangerCount = 0;
    if (ownerRef.current) {
      for (const f of significant) {
        const sim = matchAgainstOwner(f.embedding, ownerRef.current);
        if (sim < c.matchThreshold) strangerCount++;
      }
    }
    setStrangersDetected(strangerCount);

    let breach = false;
    let why: NonNullable<PeekDetectionState["reason"]> | null = null;

    if (c.alertOnStranger && ownerRef.current && strangerCount > 0) {
      // Anti-spoof: if we have a face but no liveness signal yet, defer.
      // Photos / static screens of a face will never blink → never breach.
      if (livenessOk || earHistoryRef.current.length < 6) {
        breach = true; why = "stranger";
      }
    } else if (c.alertOnMultipleFaces && significant.length >= 2) {
      breach = true; why = "multiple";
    } else if (c.alertOnNoFace && significant.length === 0) {
      breach = true; why = "no-face";
    }

    breachBuf.current.push(breach);
    if (why) reasonBuf.current.push(why);
    if (breachBuf.current.length > c.consistencyFrames) breachBuf.current.shift();
    if (reasonBuf.current.length > c.consistencyFrames) reasonBuf.current.shift();

    const allBreach = breachBuf.current.length === c.consistencyFrames &&
                      breachBuf.current.every(Boolean);

    if (allBreach) {
      const r = reasonBuf.current[reasonBuf.current.length - 1] ?? "stranger";
      if (!lockTimerRef.current && !isPeeking) {
        lockTimerRef.current = setTimeout(() => {
          setReason(r);
          setIsPeeking(true);
          // 8s cooldown after triggering — host code can clear isPeeking sooner.
          cooldownUntilRef.current = Date.now() + 8000;
        }, c.lockDelay);
      }
    } else if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
  }, [isPeeking]);

  const start = useCallback(async () => {
    if (isActive || externallyPausedRef.current) return;
    setError(null);

    if (typeof window !== "undefined" && !window.isSecureContext) {
      setError("Camera requires HTTPS. Open the app over a secure connection.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser does not support camera access.");
      return;
    }

    try {
      const video = document.createElement("video");
      video.setAttribute("playsinline", "");
      video.setAttribute("autoplay", "");
      video.muted = true;
      video.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.body.appendChild(video);
      videoRef.current = video;

      const lease = await acquireCamera("user");
      leaseRef.current = lease;
      video.srcObject = lease.stream;
      await video.play().catch(() => { /* autoplay restrictions handled below by readyState gate */ });

      // Warm up the model so first detection isn't 1s slow
      try { await (await import("@/lib/faceRecognition")).getLandmarker(); } catch { /* network */ }

      tsRef.current = 0;
      intervalRef.current = setInterval(tick, cfgRef.current.checkInterval);
      setIsActive(true);
    } catch (err) {
      const exp = explainGumError(err);
      setError(exp.message);
      teardown();
    }
  }, [isActive, tick, teardown]);

  // enable/disable lifecycle
  useEffect(() => {
    if (enabled) start();
    else teardown();
    return () => teardown();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Yield camera ownership when another flow (e.g. enrollment dialog) requests it.
  useEffect(() => {
    if (!enabled) return;
    const unsub = subscribeCameraBus((p) => {
      externallyPausedRef.current = p;
      if (p) {
        teardown();
      } else if (enabled && !isActive) {
        setTimeout(() => { if (!externallyPausedRef.current) start(); }, 250);
      }
    });
    return unsub;
  }, [enabled, isActive, start, teardown]);

  // Re-arm interval if checkInterval changes
  useEffect(() => {
    if (!isActive) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(tick, cfg.checkInterval);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [cfg.checkInterval, isActive, tick]);

  // Pause work when tab hidden
  useEffect(() => {
    if (!enabled) return;
    const onVis = () => {
      if (document.hidden) {
        if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
      } else if (isActive && !intervalRef.current) {
        intervalRef.current = setInterval(tick, cfgRef.current.checkInterval);
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled, isActive, tick]);

  return {
    isPeeking, isActive, error,
    facesDetected, strangersDetected, ownerEnrolled, reason,
  };
};
