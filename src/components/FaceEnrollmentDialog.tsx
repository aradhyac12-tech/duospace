/**
 * FaceEnrollmentDialog — owner face enrollment for Peek Guard.
 *
 * Camera lifecycle is hardened around a single owner (cameraBus) with an
 * explicit state machine, recovery on track-ended / visibility changes,
 * and strict cleanup so no stream leaks across remounts or route changes.
 *
 * UX: a guided 5-position wizard — center, left, right, up, down. Each
 * position shows an explicit on-screen instruction + directional arrow, and
 * only accepts samples whose head pose actually matches what was asked for
 * (see evaluateStepPose below), so "enrolled" means real, verified pose
 * coverage across the whole range a phone is normally viewed from — not
 * just a handful of near-identical frontal frames. Left/right and up/down
 * are validated as a genuine opposite-side pair relative to the measured
 * center baseline rather than by hardcoding which raw yaw/pitch sign means
 * "left" — the on-screen preview is horizontally mirrored and that mapping
 * isn't consistent across every browser/platform, so asserting an absolute
 * direction from the sign alone could silently be backwards. Each step
 * enforces both a minimum sample count AND a minimum dwell time, which is
 * what makes the whole flow land in the ~30-40s range this was tuned for —
 * enough real coverage that Peek Guard stops misreading "owner glanced down
 * at their phone" as a stranger.
 */

import { useEffect, useRef, useState, useCallback, type ComponentType } from "react";
import {
  Camera, Check, X, RotateCcw, Loader2, Trash2, RefreshCw, ShieldAlert,
  ArrowLeft, ArrowRight, ArrowUp, ArrowDown, ScanFace,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  detectFaces, saveOwnerProfile, clearOwnerProfile, loadOwnerProfile, cosineSim,
  type EnrollmentSample,
} from "@/lib/faceRecognition";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import {
  pauseCameraConsumers, resumeCameraConsumers, explainGumError, acquireCamera, type CameraLease,
} from "@/lib/cameraBus";
import { logInfo, logWarn, logError, newTraceId } from "@/lib/telemetry";

interface Props {
  open: boolean;
  onClose: () => void;
  onEnrolled?: () => void;
}

type StepId = "center" | "left" | "right" | "up" | "down";

interface StepDef {
  id: StepId;
  title: string;
  instruction: string;
  icon: ComponentType<{ className?: string }>;
}

const STEPS: StepDef[] = [
  { id: "center", title: "Center",  instruction: "Look straight at the camera",         icon: ScanFace   },
  { id: "left",   title: "Left",    instruction: "Slowly turn your head to the left",    icon: ArrowLeft  },
  { id: "right",  title: "Right",   instruction: "Now turn your head to the right",      icon: ArrowRight },
  { id: "up",     title: "Up",      instruction: "Tilt your head up a little",           icon: ArrowUp    },
  { id: "down",   title: "Down",    instruction: "Now tilt your head down a little",     icon: ArrowDown  },
];

// Each step needs at least this many verified-pose samples before it can
// advance, and won't advance before MIN_STEP_MS even if that count is hit
// early — the dwell floor is what turns this into a real 30-40s capture
// instead of a flick through five frames. Steps can keep collecting up to
// the per-step max if the person is still mid-turn when the dwell floor is
// reached, giving genuinely "as many images as needed" pose coverage
// without an unbounded, runaway capture.
const MIN_SAMPLES_PER_STEP = 6;
const MAX_SAMPLES_PER_STEP = 8;
const MIN_STEP_MS = 6000;
const MIN_FACE_AREA = 0.05;
const SAMPLE_INTERVAL_MS = 550;
// How far (in computePose's normalized yaw/pitch units) off the center
// baseline a pose has to be to count as a genuine "turned" sample for the
// left/right/up/down steps.
const TURN_THRESHOLD = 0.05;
const CENTER_TOLERANCE = 0.035;
// Reject a candidate sample if it's near-identical to the last accepted one
// for this step — a still head in front of a live feed can otherwise fill
// a whole step with duplicate frames instead of real pose variation.
const DUPLICATE_SIM_THRESHOLD = 0.998;
const TELE = "faceEnrollment";

/** Explicit state machine for the enrollment camera. */
type CamState =
  | "idle"
  | "requesting_permission"
  | "acquiring"
  | "active"
  | "paused"
  | "failed"
  | "released";

type CapturedSample = EnrollmentSample & { step: StepId };

/**
 * Does this frame's pose satisfy the current step's requirement, given the
 * measured center baseline and (for the second half of a left/right or
 * up/down pair) which side the first half of that pair actually used?
 * Returns the signed delta so the caller can lock in `groupSign` the first
 * time a directional step accepts a sample.
 */
const evaluateStepPose = (
  step: StepId,
  pose: { yaw: number; pitch: number },
  baseline: { yaw: number; pitch: number },
  pairedSign: number | undefined,
): { ok: boolean; signedDelta: number } => {
  const dYaw = pose.yaw - baseline.yaw;
  const dPitch = pose.pitch - baseline.pitch;
  switch (step) {
    case "center":
      return { ok: Math.abs(dYaw) < CENTER_TOLERANCE && Math.abs(dPitch) < CENTER_TOLERANCE, signedDelta: 0 };
    case "left":
    case "right": {
      if (Math.abs(dYaw) < TURN_THRESHOLD) return { ok: false, signedDelta: dYaw };
      if (step === "right" && pairedSign !== undefined) {
        return { ok: Math.sign(dYaw) !== pairedSign, signedDelta: dYaw };
      }
      return { ok: true, signedDelta: dYaw };
    }
    case "up":
    case "down": {
      if (Math.abs(dPitch) < TURN_THRESHOLD) return { ok: false, signedDelta: dPitch };
      if (step === "down" && pairedSign !== undefined) {
        return { ok: Math.sign(dPitch) !== pairedSign, signedDelta: dPitch };
      }
      return { ok: true, signedDelta: dPitch };
    }
  }
};

const FaceEnrollmentDialog = ({ open, onClose, onEnrolled }: Props) => {
  const { toast } = useToast();
  const videoRef    = useRef<HTMLVideoElement | null>(null);
  const leaseRef    = useRef<CameraLease | null>(null);
  const captureRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const tsRef       = useRef(0);
  const mountedRef  = useRef(true);
  const traceRef    = useRef<string>("");
  const trackEndedRef = useRef<(() => void) | null>(null);

  const [samples, setSamples]       = useState<CapturedSample[]>([]);
  const [stepIndex, setStepIndex]   = useState(0); // index into STEPS; === STEPS.length once all done
  const [camState, setCamState]     = useState<CamState>("idle");
  const [hint, setHint]             = useState("Position your face in the frame");
  const [errorCode, setErrorCode]   = useState<ReturnType<typeof explainGumError>["code"] | null>(null);
  const [existingCount, setExistingCount] = useState(0);
  const [attempt, setAttempt]       = useState(0);
  const [isSaving, setIsSaving]     = useState(false);
  const [elapsedMs, setElapsedMs]   = useState(0);

  // Enrollment bookkeeping that doesn't need to be React state — read fresh
  // inside the capture interval closure via refs.
  const centerBaselineRef = useRef<{ yaw: number; pitch: number } | null>(null);
  const horizontalSignRef = useRef<number | undefined>(undefined); // sign 'left' locked in, for 'right' to oppose
  const verticalSignRef   = useRef<number | undefined>(undefined); // sign 'up' locked in, for 'down' to oppose
  const stepStartedAtRef  = useRef<number>(0);
  const lastAcceptedEmbeddingRef = useRef<Float32Array | null>(null);
  const sessionStartedAtRef = useRef<number | null>(null);

  // Safe setState — never run after unmount.
  const safeSet = useCallback(<T,>(setter: (v: T) => void, value: T) => {
    if (mountedRef.current) setter(value);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Load existing profile count on open
  useEffect(() => {
    if (!open) return;
    loadOwnerProfile()
      .then((p) => mountedRef.current && setExistingCount(p?.count ?? 0))
      .catch(() => {/* non-fatal */});
  }, [open]);

  /** Centralized cleanup: stop tracks, clear timers, release lease, blank video. */
  const cleanupCamera = useCallback((reason: string) => {
    if (captureRef.current) { clearInterval(captureRef.current); captureRef.current = null; }
    if (trackEndedRef.current) { trackEndedRef.current(); trackEndedRef.current = null; }
    if (leaseRef.current) {
      try { leaseRef.current.release(); } catch { /* ignore */ }
      leaseRef.current = null;
    }
    const v = videoRef.current;
    if (v) {
      try { v.pause(); } catch { /* ignore */ }
      try { v.srcObject = null; } catch { /* ignore */ }
    }
    logInfo(TELE, "cleanup", { reason }, traceRef.current);
  }, []);

  /** Reset the whole wizard back to step 0 — used on open, explicit Reset,
   *  and after a successful/aborted save. */
  const resetWizard = useCallback(() => {
    setSamples([]);
    setStepIndex(0);
    centerBaselineRef.current = null;
    horizontalSignRef.current = undefined;
    verticalSignRef.current = undefined;
    stepStartedAtRef.current = 0;
    lastAcceptedEmbeddingRef.current = null;
    sessionStartedAtRef.current = null;
    setElapsedMs(0);
    setHint("Position your face in the frame");
  }, []);

  // Camera acquire effect — runs on open / explicit retry (`attempt`).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const trace = newTraceId("enroll");
    traceRef.current = trace;

    resetWizard();
    safeSet(setErrorCode, null as ReturnType<typeof explainGumError>["code"] | null);
    safeSet(setHint, "Starting camera…");
    safeSet(setCamState, "requesting_permission" as CamState);

    // Yield the bus from PeekGuard / MoodDetector consumers.
    pauseCameraConsumers("face-enrollment");

    (async () => {
      // Pre-flight checks.
      if (typeof window !== "undefined" && !window.isSecureContext) {
        if (cancelled) return;
        safeSet(setCamState, "failed" as CamState);
        safeSet(setErrorCode, "insecure" as ReturnType<typeof explainGumError>["code"]);
        safeSet(setHint, "Camera requires HTTPS. Open this app over a secure connection.");
        logError(TELE, "insecure_context", undefined, trace);
        return;
      }
      if (typeof navigator === "undefined" || !navigator.mediaDevices) {
        if (cancelled) return;
        safeSet(setCamState, "failed" as CamState);
        safeSet(setErrorCode, "unsupported" as ReturnType<typeof explainGumError>["code"]);
        safeSet(setHint, "This browser does not support camera access.");
        logError(TELE, "unsupported_browser", undefined, trace);
        return;
      }

      logInfo(TELE, "acquire_start", { attempt }, trace);
      safeSet(setCamState, "acquiring" as CamState);

      // Small delay so any previous owner releases the device.
      await new Promise((r) => setTimeout(r, 150));
      if (cancelled) return;

      try {
        const lease = await acquireCamera("user");
        if (cancelled || !mountedRef.current) {
          try { lease.release(); } catch { /* ignore */ }
          logInfo(TELE, "acquire_aborted_after_success", undefined, trace);
          return;
        }
        leaseRef.current = lease;

        // Wire track-ended recovery (OS killed track, app was backgrounded, etc.)
        const tracks = lease.stream.getVideoTracks();
        const onEnded = () => {
          logWarn(TELE, "track_ended_unexpected", undefined, trace);
          if (!mountedRef.current) return;
          // Mark paused; pageshow/visibility handler will re-acquire.
          safeSet(setCamState, "paused" as CamState);
          safeSet(setHint, "Camera paused — tap retry");
        };
        tracks.forEach((t) => t.addEventListener("ended", onEnded));
        trackEndedRef.current = () => {
          tracks.forEach((t) => {
            try { t.removeEventListener("ended", onEnded); } catch { /* ignore */ }
          });
        };

        const v = videoRef.current;
        if (v) {
          v.srcObject = lease.stream;
          try {
            await v.play();
          } catch (playErr) {
            // Autoplay can be blocked; try muted + replay (we're already muted).
            logWarn(TELE, "video_play_failed", playErr, trace);
          }
        }

        if (cancelled || !mountedRef.current) return;
        safeSet(setCamState, "active" as CamState);
        safeSet(setHint, STEPS[0].instruction);
        stepStartedAtRef.current = Date.now();
        sessionStartedAtRef.current = Date.now();
        logInfo(TELE, "acquire_success", undefined, trace);
      } catch (err) {
        if (cancelled || !mountedRef.current) return;
        const exp = explainGumError(err);
        logError(TELE, "acquire_fail", { code: exp.code, err }, trace);

        // One automatic retry for transient Android errors. cameraBus already
        // downgrades constraints internally; we additionally back off and retry
        // the whole acquire once if this was the first attempt.
        const transient = exp.code === "busy" || exp.code === "unknown";
        if (transient && attempt === 0) {
          logInfo(TELE, "retry_triggered", { code: exp.code }, trace);
          await new Promise((r) => setTimeout(r, 500));
          if (cancelled || !mountedRef.current) return;
          safeSet(setAttempt, 1);
          return;
        }

        safeSet(setCamState, "failed" as CamState);
        safeSet(setErrorCode, exp.code);
        safeSet(setHint, exp.message);
      }
    })();

    return () => {
      cancelled = true;
      cleanupCamera(open ? "effect-rerun" : "dialog-closed");
      // Resume bus consumers (PeekGuard etc.) when we're done.
      resumeCameraConsumers("face-enrollment-closed");
      safeSet(setCamState, "released" as CamState);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, attempt, cleanupCamera, resetWizard, safeSet]);

  // Page lifecycle: pause/release on background, re-acquire on foreground.
  useEffect(() => {
    if (!open) return;

    const onHide = () => {
      if (!mountedRef.current) return;
      logInfo(TELE, "page_hidden", undefined, traceRef.current);
      // Stop tracks NOW — mobile browsers will end them anyway.
      cleanupCamera("page-hidden");
      safeSet(setCamState, "paused" as CamState);
    };
    const onShow = () => {
      if (!mountedRef.current || !open) return;
      logInfo(TELE, "page_visible", undefined, traceRef.current);
      // Trigger a fresh acquire by bumping attempt.
      setAttempt((a) => a + 1);
    };
    const onVis = () => {
      if (document.hidden) onHide();
      else onShow();
    };

    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    window.addEventListener("pageshow", onShow);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onHide);
      window.removeEventListener("pageshow", onShow);
    };
  }, [open, cleanupCamera, safeSet]);

  // Live elapsed-time readout while the camera is active — purely cosmetic
  // (drives the "~Xs" readout so the 30-40s pacing is visible, not a gate).
  useEffect(() => {
    if (camState !== "active" || stepIndex >= STEPS.length) return;
    const t = setInterval(() => {
      if (sessionStartedAtRef.current == null) return;
      safeSet(setElapsedMs, Date.now() - sessionStartedAtRef.current);
    }, 250);
    return () => clearInterval(t);
  }, [camState, stepIndex, safeSet]);

  // Auto-capture loop — only when camera is active and the wizard isn't done.
  useEffect(() => {
    if (camState !== "active" || !open) return;
    if (stepIndex >= STEPS.length) return;

    captureRef.current = setInterval(async () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || !mountedRef.current) return;
      let faces;
      try {
        tsRef.current = Math.max(tsRef.current + 1, performance.now());
        faces = await detectFaces(v, tsRef.current);
      } catch { return; }
      if (!mountedRef.current) return;

      const step = STEPS[stepIndex];

      if (faces.length === 0)        { safeSet(setHint, "No face detected — center yourself"); return; }
      if (faces.length > 1)          { safeSet(setHint, "Only the owner should be in frame"); return; }
      const f = faces[0];
      if (f.area < MIN_FACE_AREA)    { safeSet(setHint, "Move closer to the camera"); return; }

      // The center step establishes the baseline every other step measures
      // against — accept its samples unconditionally (near-frontal, by
      // definition) and average them into the baseline as they land so
      // later steps aren't thrown off by a single noisy first frame.
      if (step.id === "center") {
        const lastEmb = lastAcceptedEmbeddingRef.current;
        if (lastEmb && cosineSim(lastEmb, f.embedding) > DUPLICATE_SIM_THRESHOLD) return;
        // Validate against true zero (computePose already returns ~0 yaw/
        // pitch for a dead-on-camera face) — NOT against this same pose,
        // which would trivially always pass and defeat the whole point of
        // a "look straight" gate.
        const evalRes = evaluateStepPose("center", f.pose, { yaw: 0, pitch: 0 }, undefined);
        if (!evalRes.ok) { safeSet(setHint, "Look straight at the camera"); return; }
        lastAcceptedEmbeddingRef.current = f.embedding;
        hapticLight();
        setSamples((s) => {
          const stepSamples = s.filter((x) => x.step === "center");
          if (stepSamples.length >= MAX_SAMPLES_PER_STEP) return s;
          const next = [...s, { embedding: f.embedding, pose: f.pose, step: "center" as StepId }];
          const centerOnly = next.filter((x) => x.step === "center");
          const avgYaw = centerOnly.reduce((a, x) => a + x.pose.yaw, 0) / centerOnly.length;
          const avgPitch = centerOnly.reduce((a, x) => a + x.pose.pitch, 0) / centerOnly.length;
          centerBaselineRef.current = { yaw: avgYaw, pitch: avgPitch };
          return next;
        });
        return;
      }

      const baseline = centerBaselineRef.current;
      if (!baseline) { safeSet(setHint, "Look straight at the camera first"); return; }

      const pairedSign = step.id === "right" ? horizontalSignRef.current
        : step.id === "down" ? verticalSignRef.current
        : undefined;
      const { ok, signedDelta } = evaluateStepPose(step.id, f.pose, baseline, pairedSign);

      if (!ok) {
        if (step.id === "right" && horizontalSignRef.current !== undefined && Math.abs(signedDelta) >= TURN_THRESHOLD) {
          safeSet(setHint, "That's the same side as before — turn the other way");
        } else if (step.id === "down" && verticalSignRef.current !== undefined && Math.abs(signedDelta) >= TURN_THRESHOLD) {
          safeSet(setHint, "That's the same direction as before — tilt the other way");
        } else {
          safeSet(setHint, step.instruction);
        }
        return;
      }

      const lastEmb = lastAcceptedEmbeddingRef.current;
      if (lastEmb && cosineSim(lastEmb, f.embedding) > DUPLICATE_SIM_THRESHOLD) return;

      // Lock in which side/direction this step used, so its opposite-facing
      // partner step can require the true opposite rather than guessing.
      if (step.id === "left") horizontalSignRef.current = Math.sign(signedDelta);
      if (step.id === "up") verticalSignRef.current = Math.sign(signedDelta);

      lastAcceptedEmbeddingRef.current = f.embedding;
      hapticLight();
      setSamples((s) => {
        const stepSamples = s.filter((x) => x.step === step.id);
        if (stepSamples.length >= MAX_SAMPLES_PER_STEP) return s;
        return [...s, { embedding: f.embedding, pose: f.pose, step: step.id }];
      });
    }, SAMPLE_INTERVAL_MS);

    return () => {
      if (captureRef.current) { clearInterval(captureRef.current); captureRef.current = null; }
    };
  }, [camState, open, stepIndex, safeSet]);

  // Step-advance effect: once the current step has enough samples AND has
  // been on-screen for at least MIN_STEP_MS, move to the next one. Kept
  // separate from the capture interval so it reacts immediately to
  // samples.length changing rather than waiting for the next 550ms tick.
  useEffect(() => {
    if (camState !== "active" || stepIndex >= STEPS.length) return;
    const step = STEPS[stepIndex];
    const count = samples.filter((s) => s.step === step.id).length;
    if (count < MIN_SAMPLES_PER_STEP) return;

    const elapsedOnStep = Date.now() - stepStartedAtRef.current;
    const remaining = MIN_STEP_MS - elapsedOnStep;
    if (remaining <= 0) {
      const next = stepIndex + 1;
      setStepIndex(next);
      stepStartedAtRef.current = Date.now();
      lastAcceptedEmbeddingRef.current = null;
      if (next < STEPS.length) {
        hapticMedium();
        setHint(STEPS[next].instruction);
      } else {
        hapticMedium();
        setHint("All set — tap Save to enroll");
      }
      return;
    }
    const t = setTimeout(() => {
      if (!mountedRef.current) return;
      // Re-check on the timer edge in case more samples arrived meanwhile.
      const c = samples.filter((s) => s.step === step.id).length;
      if (c >= MIN_SAMPLES_PER_STEP) {
        const next = stepIndex + 1;
        setStepIndex(next);
        stepStartedAtRef.current = Date.now();
        lastAcceptedEmbeddingRef.current = null;
        if (next < STEPS.length) {
          hapticMedium();
          setHint(STEPS[next].instruction);
        } else {
          hapticMedium();
          setHint("All set — tap Save to enroll");
        }
      }
    }, remaining + 30);
    return () => clearTimeout(t);
  }, [samples, stepIndex, camState]);

  const currentStep = stepIndex < STEPS.length ? STEPS[stepIndex] : null;
  const currentStepCount = currentStep
    ? samples.filter((s) => s.step === currentStep.id).length
    : 0;
  const allStepsDone = stepIndex >= STEPS.length;
  const totalTarget = STEPS.length * MIN_SAMPLES_PER_STEP;

  const reset = useCallback(() => {
    resetWizard();
    stepStartedAtRef.current = Date.now();
    sessionStartedAtRef.current = Date.now();
  }, [resetWizard]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const save = useCallback(async () => {
    if (!allStepsDone || samples.length < totalTarget) {
      toast({ title: "Finish all 5 positions first", variant: "destructive" });
      return;
    }
    setIsSaving(true);
    try {
      await saveOwnerProfile(samples.map((s) => ({ embedding: s.embedding, pose: s.pose })));
      hapticMedium();
      toast({ title: "Owner face enrolled", description: `${samples.length} samples across 5 positions saved` });
      cleanupCamera("enrollment-success");
      onEnrolled?.();
      onClose();
    } catch (err) {
      logError(TELE, "save_failed", err, traceRef.current);
      toast({ title: "Failed to save profile", variant: "destructive" });
      if (mountedRef.current) setIsSaving(false);
    }
  }, [allStepsDone, samples, totalTarget, toast, onEnrolled, onClose, cleanupCamera]);

  const removeProfile = useCallback(async () => {
    await clearOwnerProfile();
    setExistingCount(0);
    resetWizard();
    stepStartedAtRef.current = Date.now();
    sessionStartedAtRef.current = Date.now();
    toast({ title: "Owner face removed" });
    onEnrolled?.();
  }, [toast, onEnrolled, resetWizard]);

  const handleClose = useCallback(() => {
    cleanupCamera("user-cancel");
    onClose();
  }, [cleanupCamera, onClose]);

  const progress = allStepsDone ? 1 : (stepIndex + currentStepCount / MIN_SAMPLES_PER_STEP) / STEPS.length;
  const isStarting = camState === "requesting_permission" || camState === "acquiring";
  const isErrored = camState === "failed";
  const elapsedS = Math.round(elapsedMs / 1000);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-sm p-0 overflow-hidden">
        <DialogHeader className="p-5 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Camera className="h-4 w-4" /> Enroll your face
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            A guided ~30-40s scan — center, left, right, up, down — so Peek
            Guard recognises you from any angle you actually hold your
            phone at. Photos never leave your device.
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="px-5 flex items-center justify-center gap-2">
          {STEPS.map((s, i) => {
            const StepIcon = s.icon;
            const done = i < stepIndex || allStepsDone;
            const active = i === stepIndex && !allStepsDone;
            return (
              <div
                key={s.id}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-full border text-[10px] transition-colors",
                  done && "bg-primary border-primary text-primary-foreground",
                  active && "border-primary text-primary",
                  !done && !active && "border-muted-foreground/30 text-muted-foreground/50",
                )}
                title={s.title}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : <StepIcon className="h-3.5 w-3.5" />}
              </div>
            );
          })}
        </div>

        <div className="relative mx-5 mt-3 aspect-square rounded-2xl overflow-hidden bg-black">
          <video
            ref={videoRef}
            playsInline muted autoPlay
            className="h-full w-full object-cover scale-x-[-1]"
          />
          <svg viewBox="0 0 100 100" className="absolute inset-0 pointer-events-none">
            <circle cx="50" cy="50" r="46" fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth="2" />
            <circle
              cx="50" cy="50" r="46" fill="none" stroke="white" strokeWidth="3"
              strokeDasharray={`${progress * 289} 289`}
              strokeLinecap="round"
              transform="rotate(-90 50 50)"
              style={{ transition: "stroke-dasharray 0.3s ease" }}
            />
          </svg>
          {/* Current-step directional cue, overlaid on the preview */}
          {currentStep && !isStarting && camState === "active" && (
            <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/60 text-white text-[11px] backdrop-blur">
              <currentStep.icon className="h-3.5 w-3.5" />
              {currentStep.title}
            </div>
          )}
          <div className="absolute bottom-2 left-0 right-0 flex justify-center gap-2">
            <span className="inline-block px-2 py-0.5 rounded-full bg-black/60 text-white text-[10px] backdrop-blur">
              {allStepsDone ? samples.length : `${currentStepCount}/${MIN_SAMPLES_PER_STEP}`}
            </span>
            <span className="inline-block px-2 py-0.5 rounded-full bg-black/60 text-white text-[10px] backdrop-blur">
              {elapsedS}s
            </span>
          </div>
          {isStarting && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white text-xs gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> Starting camera…
            </div>
          )}
          {camState === "paused" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white text-xs">
              <p>{hint}</p>
              <Button size="sm" variant="secondary" onClick={retry}>
                <RefreshCw className="h-3.5 w-3.5 mr-1" /> Resume
              </Button>
            </div>
          )}
          {isErrored && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/85 text-white text-xs px-5 text-center">
              <ShieldAlert className="h-6 w-6 text-destructive" />
              <p className="leading-relaxed">{hint}</p>
              {errorCode === "denied" && (
                <p className="text-[10px] text-white/60">
                  Tap the camera icon in your browser's address bar → Allow.
                </p>
              )}
              {errorCode === "busy" && (
                <p className="text-[10px] text-white/60">
                  Close other apps/tabs using the camera, then retry.
                </p>
              )}
              <Button size="sm" variant="secondary" onClick={retry}>
                <RefreshCw className="h-3.5 w-3.5 mr-1" /> Retry
              </Button>
            </div>
          )}
        </div>

        <p className="px-5 pt-3 text-center text-[11px] text-muted-foreground">{hint}</p>

        <div className="p-5 pt-3 flex gap-2">
          {existingCount > 0 && samples.length === 0 && (
            <Button
              variant="ghost" size="sm"
              onClick={removeProfile}
              className="text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Remove
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={reset} disabled={samples.length === 0}>
            <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
          </Button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={handleClose}>
            <X className="h-3.5 w-3.5 mr-1" /> Cancel
          </Button>
          <Button
            size="sm"
            onClick={save}
            disabled={!allStepsDone || isSaving}
            className={cn(allStepsDone && "bg-primary")}
          >
            {isSaving
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <><Check className="h-3.5 w-3.5 mr-1" /> Save</>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default FaceEnrollmentDialog;
