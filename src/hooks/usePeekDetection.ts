/**
 * usePeekDetection — true owner-recognition peek guard.
 *
 * Pipeline (per detection tick, default ~300ms):
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
 *   8. `isPeeking` stays true until host code calls the returned `dismiss()`
 *      after the user actually authenticates/dismisses — nothing in this
 *      hook clears it on its own. Skipping that call is a real bug, not a
 *      cosmetic one: the lock-arming guard requires `!isPeeking`, so a
 *      forgotten dismiss() means no future breach can ever re-lock the
 *      screen for the rest of the session.
 *
 * No owner enrolled → falls back to count-based breach
 * (multi-face = breach; single face is fine).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  detectFaces, loadOwnerProfile, matchAgainstOwner, getAdaptiveMatchThreshold,
  type OwnerProfile,
} from "@/lib/faceRecognition";
import { detectFacesOffThread, isWorkerSupported, teardownFaceWorker } from "@/lib/faceWorkerClient";
import { subscribeCameraBus, explainGumError, acquireCamera, type CameraLease } from "@/lib/cameraBus";
import { Capacitor } from "@capacitor/core";
import { logPeekEvent } from "@/lib/peekEventLog";

/** requestVideoFrameCallback isn't in lib.dom.d.ts yet in all TS configs. */
type RVFCVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface PeekConfig {
  /** Cosine similarity threshold. ≥ this = owner. Default 0.7. */
  matchThreshold?: number;
  /** Min normalized face area (0..1). Below = ignored. Default 0.015 (~12%×12% of frame). */
  minFaceArea?: number;
  /** Number of consecutive frames the breach must be observed. Default 2.
   *  This is a deliberate anti-flicker gate, not lock latency — it's what
   *  keeps a single bad frame from locking the screen. Lock *speed* is
   *  governed by lockDelay below, not this. */
  consistencyFrames?: number;
  /** Delay after a *confirmed* (consistency-passed) breach before locking
   *  (ms). Default 150 — this is the "decision → blur → lock" leg of the
   *  pipeline, tuned to the ~100-150ms target now that detection itself
   *  runs off the main thread (see faceDetection.worker.ts) and no longer
   *  competes with the lock-screen's own render/animation work. */
  lockDelay?: number;
  /** Detection frequency in ms. Default 300. */
  checkInterval?: number;
  /** Trigger when a non-owner face is seen. Default true. */
  alertOnStranger?: boolean;
  /** Trigger when ≥ 2 faces are seen. Default true. */
  alertOnMultipleFaces?: boolean;
  /** Trigger when no face seen for the consistency window. Default false. */
  alertOnNoFace?: boolean;
  /** If a stranger-classified face shows NEITHER liveness signal (no
   *  blink, no head-pose micro-movement) for this long (ms), lock anyway
   *  with reason "spoof" instead of deferring indefinitely. Balances two
   *  failure modes: too short and a genuinely static background photo/
   *  poster can trigger a false lock; too long and a live stranger who
   *  happens not to blink or move goes undetected for that whole window.
   *  Default 6000. Set to 0 to disable this escalation (revert to the old
   *  defer-forever-without-liveness behavior). */
  staticStrangerTimeoutMs?: number;
}

const DEFAULTS: Required<PeekConfig> = {
  matchThreshold: 0.7,
  minFaceArea: 0.015,
  consistencyFrames: 2,
  lockDelay: 150,
  checkInterval: 300,
  alertOnStranger: true,
  alertOnMultipleFaces: true,
  alertOnNoFace: false,
  staticStrangerTimeoutMs: 6000,
};

/**
 * Rolls the frame's raw signals into a single 0-100 threat score. This is
 * a heuristic weighted sum, not a trained model — the weights are
 * deliberately conservative (a lone stranger frame lands "Medium", not
 * "Critical") since the score is meant for a dashboard/log readout, not
 * as an independent trigger — locking is still driven by the existing
 * breach/consistency/lockDelay pipeline above, this just quantifies it.
 */
const computeThreatScore = (input: {
  strangerCount: number;
  totalFaces: number;
  spoofSuspected: boolean;
  sustainedBreach: boolean;
  /** Weak pixel-texture heuristic — see faceMath.ts. Given a much smaller
   *  weight than spoofSuspected on purpose: unvalidated thresholds. */
  flatTextureSuspected?: boolean;
}): number => {
  let score = 0;
  if (input.strangerCount > 0) score += 40 + Math.min(20, (input.strangerCount - 1) * 10);
  if (input.totalFaces >= 2) score += Math.min(25, (input.totalFaces - 1) * 12);
  if (input.spoofSuspected) score += 30;
  if (input.sustainedBreach) score += 15;
  if (input.flatTextureSuspected) score += 10;
  return Math.max(0, Math.min(100, score));
};

const threatLevelFromScore = (score: number): PeekDetectionState["threatLevel"] =>
  score >= 80 ? "critical" : score >= 60 ? "high" : score >= 40 ? "medium" : score >= 20 ? "low" : "safe";

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
  reason: "stranger" | "multiple" | "no-face" | "spoof" | null;
  /** 0-100 rolling threat score — see computeThreatScore() below for inputs. */
  threatScore: number;
  /** Banded readout of threatScore, for UI/dashboard use. */
  threatLevel: "safe" | "low" | "medium" | "high" | "critical";
  /** id of the most recently logged event in lib/peekEventLog.ts, for
   *  attaching user feedback (accurate / false alarm) after the fact. */
  lastEventId: string | null;
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
  const [threatScore, setThreatScore]           = useState(0);
  const [threatLevel, setThreatLevel]           = useState<PeekDetectionState["threatLevel"]>("safe");
  const [lastEventId, setLastEventId]           = useState<string | null>(null);

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
  // Second, independent liveness channel: head-pose micro-movement. A
  // printed photo / phone-screen replay held in front of the camera has
  // near-zero pose variance even over several seconds; a real person
  // holding a phone naturally drifts a small amount continuously — this
  // fires far more often than blinks (~every 4s on average), so it closes
  // the gap where a live stranger who simply doesn't blink in time would
  // otherwise go undetected. See usePeekDetection's spoof-timeout comment
  // below for how the two channels combine.
  const poseHistoryRef = useRef<{ ts: number; yaw: number; pitch: number }[]>([]);
  // When a stranger has been visible with NEITHER liveness channel firing,
  // timestamp when that streak started — null while not in that state.
  const strangerNoLivenessSinceRef = useRef<number | null>(null);
  // Cooldown after a confirmed peek event so the screen doesn't immediately re-trigger.
  const cooldownUntilRef = useRef<number>(0);
  // Timestamp when the lock timer was armed — used to log the *actual*
  // elapsed decision→lock time (can drift from the configured lockDelay
  // under real device load), not just the configured value verbatim.
  const lockArmedAtRef = useRef<number>(0);
  // requestVideoFrameCallback handle, when supported — replaces setInterval
  // polling so detection is scheduled off an actual decoded frame instead
  // of an arbitrary timer tick.
  const rvfcHandleRef = useRef<number | null>(null);
  const lastDetectAtRef = useRef<number>(0);
  const usingWorkerRef = useRef<boolean>(isWorkerSupported());
  const tickInFlightRef = useRef(false);
  // Dynamic FPS: the interval scheduleLoop() actually throttles to, derived
  // fresh each tick from current signals (see the tail of tick() below).
  // Starts at the user's configured checkInterval ("normal" tier) and
  // widens/narrows from there — never overridden to something the user
  // didn't effectively ask for, just adapted around their baseline.
  const dynamicIntervalRef = useRef<number>(DEFAULTS.checkInterval);
  // Camera-covered detection: a tiny offscreen canvas samples average
  // frame brightness each tick. Near-total darkness sustained for a few
  // consecutive ticks means the lens is very likely physically covered
  // (finger, case, sticker) — skip the expensive detection call entirely
  // until it clears. This is a coarse heuristic (a dark room can trigger
  // it too), not a precise "object over camera" classifier.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasCtxRef = useRef<CanvasRenderingContext2D | null>(null);
  const coveredStreakRef = useRef(0);
  const cameraCoveredRef = useRef(false);
  // Latest texture-score reading (see faceMath.ts's textureScoreFromGrayscale
  // doc comment for what this actually is/isn't) — stored in a ref purely
  // for the debug HUD; the per-tick decision uses a local computed fresh
  // each tick, not this ref.
  const lastTextureRef = useRef<{ laplacianVar: number; lumaStdDev: number; suspected: boolean } | null>(null);

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
    if (rvfcHandleRef.current != null && videoRef.current) {
      (videoRef.current as RVFCVideo).cancelVideoFrameCallback?.(rvfcHandleRef.current);
    }
    rvfcHandleRef.current = null;
    tickInFlightRef.current = false;
    if (lockTimerRef.current) { clearTimeout(lockTimerRef.current); lockTimerRef.current = null; }
    if (leaseRef.current) { leaseRef.current.release(); leaseRef.current = null; }
    if (videoRef.current) { videoRef.current.srcObject = null; videoRef.current.remove(); videoRef.current = null; }
    breachBuf.current = [];
    reasonBuf.current = [];
    earHistoryRef.current = [];
    poseHistoryRef.current = [];
    strangerNoLivenessSinceRef.current = null;
    coveredStreakRef.current = 0;
    cameraCoveredRef.current = false;
    lastTextureRef.current = null;
    canvasRef.current = null;
    canvasCtxRef.current = null;
    dynamicIntervalRef.current = cfgRef.current.checkInterval;
    setIsActive(false);
    setThreatScore(0);
    setThreatLevel("safe");
  }, []);

  const tick = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;

    // Cooldown after a recent confirmed peek event — avoid re-triggering immediately.
    if (Date.now() < cooldownUntilRef.current) return;

    // ── Camera-covered check (cheap, runs every tick) ──────────────────────
    // 8x8 downsample is sub-millisecond and lets us skip the ~15-30ms
    // MediaPipe call entirely while the lens is covered — the single
    // biggest per-tick cost, and the one most worth avoiding for battery.
    const canvas = canvasRef.current, ctx = canvasCtxRef.current;
    if (canvas && ctx) {
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
        const brightness = sum / (data.length / 4); // 0-255
        if (brightness < 6) {
          coveredStreakRef.current++;
          if (coveredStreakRef.current >= 3) cameraCoveredRef.current = true;
        } else {
          coveredStreakRef.current = 0;
          cameraCoveredRef.current = false;
        }
      } catch { /* transient — treat as not covered */ }
    }
    if (cameraCoveredRef.current) {
      setFacesDetected(0);
      setStrangersDetected(0);
      // Idle-tier polling while covered — just keep sampling brightness
      // cheaply until it clears, don't touch breach state at all (a
      // covered lens isn't itself a breach signal).
      dynamicIntervalRef.current = Math.max(cfgRef.current.checkInterval * 3, 800);
      return;
    }

    let faces;
    try {
      if (usingWorkerRef.current) {
        // Off-thread: capture + inference happen in faceDetection.worker.ts,
        // so this never blocks React's render loop or the lock-screen's
        // own blur/fade animation.
        faces = await detectFacesOffThread(video);
      } else {
        tsRef.current = Math.max(tsRef.current + 1, performance.now());
        faces = await detectFaces(video, tsRef.current);
      }
    } catch {
      // One bad frame (e.g. worker hiccup) shouldn't permanently disable
      // the pipeline — fall back to main-thread detection for future ticks.
      usingWorkerRef.current = false;
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
    let primary: (typeof significant)[number] | undefined;
    if (significant.length > 0) {
      primary = significant.reduce((a, b) => (a.area > b.area ? a : b));
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

      // Second liveness channel: head-pose micro-movement over a 3s window.
      // Real people holding a phone drift continuously; a printed photo or
      // screen replay propped in front of the camera stays essentially
      // fixed. Threshold is deliberately small — this is meant to catch
      // "basically zero movement at all", not require a real head turn.
      poseHistoryRef.current.push({ ts: now, yaw: primary.pose.yaw, pitch: primary.pose.pitch });
      while (poseHistoryRef.current.length && now - poseHistoryRef.current[0].ts > 3000) {
        poseHistoryRef.current.shift();
      }
      const poseHist = poseHistoryRef.current;
      if (poseHist.length >= 5) {
        const yaws = poseHist.map((p) => p.yaw);
        const pitches = poseHist.map((p) => p.pitch);
        const yawRange = Math.max(...yaws) - Math.min(...yaws);
        const pitchRange = Math.max(...pitches) - Math.min(...pitches);
        if (yawRange > 0.006 || pitchRange > 0.006) lastLivenessOkRef.current = now;
      }
    }
    const livenessOk = now - lastLivenessOkRef.current < 4000;

    // ── Texture heuristic (weak, unvalidated — see faceMath.ts's
    // textureScoreFromGrayscale doc comment before trusting this) ─────────
    // Deliberately conservative placeholder thresholds, and deliberately
    // requires BOTH signals flat (not either alone) to reduce false
    // positives from ordinary blurry/dark frames. Feeds only into the
    // threat score below, never gates a lock directly — not confident
    // enough in these unvalidated numbers to let it lock someone's screen
    // on its own.
    let flatTextureSuspected = false;
    if (primary?.textureScore) {
      const { laplacianVar, lumaStdDev } = primary.textureScore;
      flatTextureSuspected = laplacianVar < 15 && lumaStdDev < 8;
      lastTextureRef.current = { laplacianVar, lumaStdDev, suspected: flatTextureSuspected };
    } else {
      lastTextureRef.current = null;
    }

    let strangerCount = 0;
    if (ownerRef.current) {
      const effectiveThreshold = getAdaptiveMatchThreshold(ownerRef.current, c.matchThreshold);
      for (const f of significant) {
        const sim = matchAgainstOwner(f.embedding, ownerRef.current);
        if (sim < effectiveThreshold) strangerCount++;
      }
    }
    setStrangersDetected(strangerCount);

    let breach = false;
    let why: NonNullable<PeekDetectionState["reason"]> | null = null;
    let spoofSuspected = false;

    if (c.alertOnStranger && ownerRef.current && strangerCount > 0) {
      if (livenessOk) {
        breach = true; why = "stranger";
        strangerNoLivenessSinceRef.current = null;
      } else if (earHistoryRef.current.length < 6) {
        // Not enough history yet to judge liveness either way — same
        // permissive default the original code used, just for a shorter
        // window now that pose is a second, faster-firing channel.
        breach = true; why = "stranger";
        strangerNoLivenessSinceRef.current = null;
      } else {
        // Stranger present, neither liveness channel has fired. Defer the
        // breach as a possible static photo/poster — but only up to
        // staticStrangerTimeoutMs, past which persistent zero-movement
        // presence is itself suspicious enough to lock on, distinct from a
        // confirmed live stranger.
        spoofSuspected = true;
        if (strangerNoLivenessSinceRef.current == null) strangerNoLivenessSinceRef.current = now;
        const elapsed = now - strangerNoLivenessSinceRef.current;
        if (c.staticStrangerTimeoutMs > 0 && elapsed >= c.staticStrangerTimeoutMs) {
          breach = true; why = "spoof";
        }
      }
    } else {
      strangerNoLivenessSinceRef.current = null;
      if (c.alertOnMultipleFaces && significant.length >= 2) {
        breach = true; why = "multiple";
      } else if (c.alertOnNoFace && significant.length === 0) {
        breach = true; why = "no-face";
      }
    }

    breachBuf.current.push(breach);
    if (why) reasonBuf.current.push(why);
    if (breachBuf.current.length > c.consistencyFrames) breachBuf.current.shift();
    if (reasonBuf.current.length > c.consistencyFrames) reasonBuf.current.shift();

    const allBreach = breachBuf.current.length === c.consistencyFrames &&
                      breachBuf.current.every(Boolean);

    const score = computeThreatScore({
      strangerCount, totalFaces: significant.length, spoofSuspected, sustainedBreach: allBreach,
      flatTextureSuspected,
    });
    setThreatScore(score);
    setThreatLevel(threatLevelFromScore(score));

    // ── Dynamic FPS ──────────────────────────────────────────────────────
    // Tiers scale off the user's own configured checkInterval (their
    // chosen "normal" baseline) rather than hardcoded absolutes, so a
    // battery-conscious user's slower setting stays slower across every
    // tier, not just the normal one. Floors keep the fast tiers from
    // trying to poll faster than a worker round-trip can actually finish.
    const baseline = c.checkInterval;
    if (score >= 60 || why === "spoof") {
      // Threat — confirm/lock as fast as reasonably possible.
      dynamicIntervalRef.current = Math.max(80, Math.round(baseline * 0.25));
    } else if (strangerCount > 0 || significant.length >= 2 || spoofSuspected) {
      // Movement / uncertain — something's actively changing, poll faster
      // to resolve it (confirm real breach or clear the flicker) sooner.
      dynamicIntervalRef.current = Math.max(100, Math.round(baseline * 0.5));
    } else if (significant.length === 0) {
      // Idle — nobody in frame at all.
      dynamicIntervalRef.current = Math.round(baseline * 2.5);
    } else {
      // Normal — owner steadily present, nothing ambiguous.
      dynamicIntervalRef.current = baseline;
    }

    if (allBreach) {
      const r = reasonBuf.current[reasonBuf.current.length - 1] ?? "stranger";
      if (!lockTimerRef.current && !isPeeking) {
        lockArmedAtRef.current = Date.now();
        lockTimerRef.current = setTimeout(() => {
          setReason(r);
          setIsPeeking(true);
          const id = logPeekEvent({
            reason: r,
            threatScore: score,
            timeToLockMs: Date.now() - lockArmedAtRef.current,
          });
          setLastEventId(id);
          // 8s cooldown after triggering — host code can clear isPeeking sooner.
          cooldownUntilRef.current = Date.now() + 8000;
        }, c.lockDelay);
      }
    } else if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current);
      lockTimerRef.current = null;
    }
  }, [isPeeking]);

  const stopLoop = useCallback(() => {
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    if (rvfcHandleRef.current != null && videoRef.current) {
      (videoRef.current as RVFCVideo).cancelVideoFrameCallback?.(rvfcHandleRef.current);
    }
    rvfcHandleRef.current = null;
  }, []);

  /**
   * Drives detection off requestVideoFrameCallback (fires exactly when a new
   * decoded frame is presented) instead of a free-running setInterval, so
   * we're never racing a frame that hasn't actually updated yet. Throttled
   * to `dynamicIntervalRef` — a battery-aware interval recomputed at the
   * end of every tick() from that tick's own signals (idle/normal/
   * movement/threat — see the "Dynamic FPS" block in tick()). Falls back
   * to a fixed setInterval at the user's configured checkInterval on
   * WebViews that don't support rVFC — the dynamic tiering only applies
   * to the rVFC path since a plain setInterval's delay is fixed at
   * creation and can't cheaply be re-armed every tick.
   */
  const scheduleLoop = useCallback(() => {
    stopLoop();
    const video = videoRef.current as RVFCVideo | null;
    if (!video) return;

    if (typeof video.requestVideoFrameCallback === "function") {
      const onFrame = () => {
        const now = performance.now();
        if (!tickInFlightRef.current && now - lastDetectAtRef.current >= dynamicIntervalRef.current) {
          lastDetectAtRef.current = now;
          tickInFlightRef.current = true;
          Promise.resolve(tick()).finally(() => { tickInFlightRef.current = false; });
        }
        rvfcHandleRef.current = video.requestVideoFrameCallback!(onFrame);
      };
      rvfcHandleRef.current = video.requestVideoFrameCallback(onFrame);
    } else {
      intervalRef.current = setInterval(tick, cfgRef.current.checkInterval);
    }
  }, [stopLoop, tick]);

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

      const canvas = document.createElement("canvas");
      canvas.width = 8;
      canvas.height = 8;
      canvasRef.current = canvas;
      canvasCtxRef.current = canvas.getContext("2d", { willReadFrequently: true });
      coveredStreakRef.current = 0;
      cameraCoveredRef.current = false;
      dynamicIntervalRef.current = cfgRef.current.checkInterval;

      const lease = await acquireCamera("user");
      leaseRef.current = lease;
      video.srcObject = lease.stream;
      await video.play().catch(() => { /* autoplay restrictions handled below by readyState gate */ });

      // Warm up whichever pipeline will actually serve detection, so the
      // first real tick isn't ~1s slow waiting on model load.
      usingWorkerRef.current = isWorkerSupported();
      try {
        if (usingWorkerRef.current) {
          await detectFacesOffThread(video).catch(() => { /* model still loading, first real tick will retry */ });
        } else {
          await (await import("@/lib/faceRecognition")).getLandmarker();
        }
      } catch { /* network */ }

      tsRef.current = 0;
      lastDetectAtRef.current = 0;
      scheduleLoop();
      setIsActive(true);
    } catch (err) {
      const exp = explainGumError(err);
      setError(exp.message);
      teardown();
    }
  }, [isActive, scheduleLoop, teardown]);

  // enable/disable lifecycle
  useEffect(() => {
    if (enabled) {
      start();
    } else {
      teardown();
      // Only free the ~3MB model + worker thread on a real disable, not on
      // the transient teardowns used for camera-bus handoff or tab-hide —
      // those resume quickly and would otherwise pay the reload cost.
      teardownFaceWorker();
    }
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

  // Re-arm the frame loop if checkInterval changes (throttle is read live
  // from cfgRef inside the rVFC callback, but the setInterval fallback path
  // needs re-arming since its delay is fixed at creation time).
  useEffect(() => {
    if (!isActive) return;
    scheduleLoop();
    return () => stopLoop();
  }, [cfg.checkInterval, isActive, scheduleLoop, stopLoop]);

  // Pause work when tab hidden — stop scheduling frames/detections entirely
  // rather than just skipping their result, so the worker and camera both
  // go fully idle in the background.
  useEffect(() => {
    if (!enabled) return;
    const onVis = () => {
      if (document.hidden) {
        stopLoop();
      } else if (isActive && !intervalRef.current && rvfcHandleRef.current == null) {
        scheduleLoop();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [enabled, isActive, scheduleLoop, stopLoop]);

  // Native (Capacitor) app backgrounding — `visibilitychange` isn't always
  // reliable inside a native WebView when the screen locks or the app is
  // swapped away, so this is a second, more direct signal on native
  // platforms specifically. Web builds rely on visibilitychange alone.
  useEffect(() => {
    if (!enabled || !Capacitor.isNativePlatform()) return;
    let remove: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const sub = await App.addListener("appStateChange", ({ isActive: appIsActive }) => {
          if (!appIsActive) {
            stopLoop();
          } else if (isActive && !intervalRef.current && rvfcHandleRef.current == null) {
            scheduleLoop();
          }
        });
        if (cancelled) { sub.remove(); return; }
        remove = () => sub.remove();
      } catch { /* plugin unavailable — visibilitychange still covers it */ }
    })();
    return () => { cancelled = true; remove?.(); };
  }, [enabled, isActive, scheduleLoop, stopLoop]);

  /**
   * Clears the current peek state so a future breach can re-arm. This was
   * a real gap: nothing in this hook ever called setIsPeeking(false), and
   * the lock-arming guard (`!lockTimerRef.current && !isPeeking`) meant
   * once a single lock had ever fired, isPeeking stayed true for the rest
   * of the session and no subsequent breach — however real — could ever
   * lock the screen again. Host code (PeekGuard) must call this once the
   * user has actually dismissed/authenticated past a lock.
   */
  const dismiss = useCallback(() => {
    setIsPeeking(false);
    setReason(null);
    breachBuf.current = [];
    reasonBuf.current = [];
    if (lockTimerRef.current) { clearTimeout(lockTimerRef.current); lockTimerRef.current = null; }
    cooldownUntilRef.current = Date.now() + 1000;
  }, []);

  /**
   * Snapshot of live internals for an opt-in debug HUD (PeekGuard renders
   * one when appSettings.peekDebugMode is on). Deliberately a plain
   * function returning a fresh object rather than React state — polling
   * refs on a timer only when the debug HUD is actually mounted means
   * users who never enable it pay zero extra re-render cost for this.
   */
  const getDebugSnapshot = useCallback(() => ({
    usingWorker: usingWorkerRef.current,
    effectiveIntervalMs: dynamicIntervalRef.current,
    cameraCovered: cameraCoveredRef.current,
    tickInFlight: tickInFlightRef.current,
    texture: lastTextureRef.current,
  }), []);

  return {
    isPeeking, isActive, error,
    facesDetected, strangersDetected, ownerEnrolled, reason,
    threatScore, threatLevel, lastEventId, dismiss, getDebugSnapshot,
  };
};
