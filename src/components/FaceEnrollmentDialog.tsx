/**
 * FaceEnrollmentDialog — owner face enrollment for Peek Guard.
 *
 * Camera lifecycle is hardened around a single owner (cameraBus) with an
 * explicit state machine, recovery on track-ended / visibility changes,
 * and strict cleanup so no stream leaks across remounts or route changes.
 *
 * UX: live front-camera preview, progress ring, automatic capture every
 * ~600ms once a single, well-sized face is in view, "Save" once 5+ samples.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { Camera, Check, X, RotateCcw, Loader2, Trash2, RefreshCw, ShieldAlert } from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  detectFaces, saveOwnerProfile, clearOwnerProfile, loadOwnerProfile,
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

const MIN_SAMPLES = 5;
const MAX_SAMPLES = 10;
const MIN_FACE_AREA = 0.05;
const SAMPLE_INTERVAL_MS = 600;
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

const FaceEnrollmentDialog = ({ open, onClose, onEnrolled }: Props) => {
  const { toast } = useToast();
  const videoRef    = useRef<HTMLVideoElement | null>(null);
  const leaseRef    = useRef<CameraLease | null>(null);
  const captureRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const tsRef       = useRef(0);
  const mountedRef  = useRef(true);
  const traceRef    = useRef<string>("");
  const trackEndedRef = useRef<(() => void) | null>(null);

  const [samples, setSamples]       = useState<Float32Array[]>([]);
  const [camState, setCamState]     = useState<CamState>("idle");
  const [hint, setHint]             = useState("Position your face in the frame");
  const [errorCode, setErrorCode]   = useState<ReturnType<typeof explainGumError>["code"] | null>(null);
  const [existingCount, setExistingCount] = useState(0);
  const [attempt, setAttempt]       = useState(0);
  const [isSaving, setIsSaving]     = useState(false);

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

  // Camera acquire effect — runs on open / explicit retry (`attempt`).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const trace = newTraceId("enroll");
    traceRef.current = trace;

    safeSet(setSamples, [] as Float32Array[]);
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
        safeSet(setHint, "Position your face in the frame");
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
  }, [open, attempt, cleanupCamera, safeSet]);

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

  // Auto-capture loop — only when camera is active.
  useEffect(() => {
    if (camState !== "active" || !open) return;
    if (samples.length >= MAX_SAMPLES) return;

    captureRef.current = setInterval(async () => {
      const v = videoRef.current;
      if (!v || v.readyState < 2 || !mountedRef.current) return;
      let faces;
      try {
        tsRef.current = Math.max(tsRef.current + 1, performance.now());
        faces = await detectFaces(v, tsRef.current);
      } catch { return; }
      if (!mountedRef.current) return;

      if (faces.length === 0)        { safeSet(setHint, "No face detected — center yourself"); return; }
      if (faces.length > 1)          { safeSet(setHint, "Only the owner should be in frame"); return; }
      const f = faces[0];
      if (f.area < MIN_FACE_AREA)    { safeSet(setHint, "Move closer to the camera"); return; }

      hapticLight();
      setSamples((s) => (s.length >= MAX_SAMPLES ? s : [...s, f.embedding]));
    }, SAMPLE_INTERVAL_MS);

    return () => {
      if (captureRef.current) { clearInterval(captureRef.current); captureRef.current = null; }
    };
  }, [camState, open, samples.length, safeSet]);

  // Hint side-effect (kept out of setState updaters)
  useEffect(() => {
    if (camState !== "active") return;
    if (samples.length === 0) return;
    if (samples.length < MIN_SAMPLES) {
      setHint(`Captured ${samples.length}/${MIN_SAMPLES}+ — turn slightly`);
    } else if (samples.length < MAX_SAMPLES) {
      setHint(`Captured ${samples.length}/${MAX_SAMPLES} — looking good`);
    } else {
      setHint("All set — tap Save to enroll");
    }
  }, [samples.length, camState]);

  const reset = useCallback(() => {
    setSamples([]);
    setHint("Position your face in the frame");
  }, []);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  const save = useCallback(async () => {
    if (samples.length < MIN_SAMPLES) {
      toast({ title: `Need at least ${MIN_SAMPLES} samples`, variant: "destructive" });
      return;
    }
    setIsSaving(true);
    try {
      await saveOwnerProfile(samples);
      hapticMedium();
      toast({ title: "Owner face enrolled", description: `${samples.length} samples saved` });
      cleanupCamera("enrollment-success");
      onEnrolled?.();
      onClose();
    } catch (err) {
      logError(TELE, "save_failed", err, traceRef.current);
      toast({ title: "Failed to save profile", variant: "destructive" });
      if (mountedRef.current) setIsSaving(false);
    }
  }, [samples, toast, onEnrolled, onClose, cleanupCamera]);

  const removeProfile = useCallback(async () => {
    await clearOwnerProfile();
    setExistingCount(0);
    setSamples([]);
    toast({ title: "Owner face removed" });
    onEnrolled?.();
  }, [toast, onEnrolled]);

  const handleClose = useCallback(() => {
    cleanupCamera("user-cancel");
    onClose();
  }, [cleanupCamera, onClose]);

  const progress = Math.min(samples.length / MIN_SAMPLES, 1);
  const isStarting = camState === "requesting_permission" || camState === "acquiring";
  const isErrored = camState === "failed";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-sm p-0 overflow-hidden">
        <DialogHeader className="p-5 pb-2">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Camera className="h-4 w-4" /> Enroll your face
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            We capture {MIN_SAMPLES}–{MAX_SAMPLES} angles to recognise only you.
            Photos never leave your device.
          </DialogDescription>
        </DialogHeader>

        <div className="relative mx-5 aspect-square rounded-2xl overflow-hidden bg-black">
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
          <div className="absolute bottom-2 left-0 right-0 text-center">
            <span className="inline-block px-2 py-0.5 rounded-full bg-black/60 text-white text-[10px] backdrop-blur">
              {samples.length}/{MAX_SAMPLES}
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
              <ShieldAlert className="h-6 w-6 text-red-400" />
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
            disabled={samples.length < MIN_SAMPLES || isSaving}
            className={cn(samples.length >= MIN_SAMPLES && "bg-primary")}
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
