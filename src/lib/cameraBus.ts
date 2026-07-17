/**
 * cameraBus — single source of truth for the front (and back) camera stream.
 *
 * Why: PeekGuard, MoodDetector, FaceEnrollmentDialog and any other module
 * that wants `facingMode:"user"` would otherwise each call getUserMedia,
 * triggering "NotReadableError: Could not start video source" the moment
 * a second consumer mounts. This module:
 *
 *   • Holds at most ONE MediaStream per facing mode.
 *   • Refcounts subscribers (acquire / release).
 *   • Auto-stops tracks 5s after the last release (grace period — avoids
 *     thrashing during route transitions).
 *   • Pauses + resumes on `visibilitychange` / `pagehide` / `freeze`.
 *   • Recovers from `NotReadableError` / `OverconstrainedError` with one
 *     retry at lower constraints.
 *   • Keeps legacy `pauseCameraConsumers` / `resumeCameraConsumers` for
 *     code paths that still own their own MediaStream (Calls, Chat audio,
 *     CameraWithFilters which flips facing modes mid-session).
 *
 * IMPORTANT: any module doing `facingMode:"user"` for *processing* (not a
 * WebRTC peer connection or an audio recorder) MUST go through `acquireCamera`.
 */

const STOP_GRACE_MS = 5000;

type Facing = "user" | "environment";

interface PoolEntry {
  facing: Facing;
  stream: MediaStream | null;
  refcount: number;
  /** Pending stop timer when refcount fell to 0. */
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** Resolve queue while a single getUserMedia is in flight. */
  pending: Promise<MediaStream> | null;
}

const pool: Record<Facing, PoolEntry> = {
  user:        { facing: "user",        stream: null, refcount: 0, stopTimer: null, pending: null },
  environment: { facing: "environment", stream: null, refcount: 0, stopTimer: null, pending: null },
};

// ─── legacy pause/resume API (kept for non-bus consumers) ────────────────────
type Listener = (paused: boolean) => void;
const listeners = new Set<Listener>();
let paused = false;

export const isCameraPaused = () => paused;

export const pauseCameraConsumers = (reason = "manual") => {
  paused = true;
  listeners.forEach((l) => l(true));
  // Bus-managed streams: stop now (don't wait grace) so the requesting
  // flow (e.g. enrollment) can immediately reopen the device.
  (Object.keys(pool) as Facing[]).forEach((f) => hardStop(pool[f]));
  if (typeof window !== "undefined") console.debug("[cameraBus] paused:", reason);
};

export const resumeCameraConsumers = (reason = "manual") => {
  paused = false;
  listeners.forEach((l) => l(false));
  if (typeof window !== "undefined") console.debug("[cameraBus] resumed:", reason);
};

export const subscribeCameraBus = (l: Listener): (() => void) => {
  listeners.add(l);
  l(paused);
  return () => listeners.delete(l);
};

// ─── error mapping ───────────────────────────────────────────────────────────
export const explainGumError = (err: unknown): {
  code: "insecure" | "denied" | "notfound" | "busy" | "unsupported" | "unknown";
  message: string;
} => {
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return { code: "insecure", message: "Camera requires a secure (HTTPS) connection." };
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return { code: "unsupported", message: "This browser does not support camera access." };
  }
  const e = err as { name?: string; message?: string } | undefined;
  switch (e?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return { code: "denied", message: "Camera permission was denied. Enable it in your browser/site settings and retry." };
    case "NotFoundError":
      return { code: "notfound", message: "No camera was found on this device." };
    case "OverconstrainedError":
      return { code: "notfound", message: "Camera doesn't support the requested resolution." };
    case "NotReadableError":
    case "AbortError":
      return { code: "busy", message: "Camera is in use by another app or tab. Close it and retry." };
    default:
      return { code: "unknown", message: e?.message || "Could not start the camera." };
  }
};

// ─── core open/close ─────────────────────────────────────────────────────────
const baseConstraints = (facing: Facing): MediaStreamConstraints => ({
  video: {
    facingMode: facing,
    width:  { ideal: 480 },
    height: { ideal: 360 },
    frameRate: { ideal: 15, max: 24 },
  },
  audio: false,
});

const fallbackConstraints = (facing: Facing): MediaStreamConstraints => ({
  video: { facingMode: facing }, // let UA pick
  audio: false,
});

async function openStream(facing: Facing): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error("getUserMedia unsupported"), { name: "NotSupportedError" });
  }
  try {
    return await navigator.mediaDevices.getUserMedia(baseConstraints(facing));
  } catch (err) {
    const e = err as { name?: string };
    if (e?.name === "OverconstrainedError" || e?.name === "NotReadableError") {
      // One retry at relaxed constraints. Helps on Android midrange + busy device.
      await new Promise((r) => setTimeout(r, 200));
      return await navigator.mediaDevices.getUserMedia(fallbackConstraints(facing));
    }
    throw err;
  }
}

function hardStop(entry: PoolEntry) {
  if (entry.stopTimer) { clearTimeout(entry.stopTimer); entry.stopTimer = null; }
  if (entry.stream) {
    entry.stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
    entry.stream = null;
  }
  entry.refcount = 0;
  entry.pending = null;
}

function scheduleStop(entry: PoolEntry) {
  if (entry.stopTimer) clearTimeout(entry.stopTimer);
  entry.stopTimer = setTimeout(() => {
    if (entry.refcount === 0) hardStop(entry);
  }, STOP_GRACE_MS);
}

export interface CameraLease {
  stream: MediaStream;
  release: () => void;
}

/**
 * Acquire a shared MediaStream for the requested facing mode.
 * Multiple callers receive the SAME stream; the underlying tracks are
 * stopped only after the last caller releases AND the grace period
 * elapses without a new acquire.
 */
export async function acquireCamera(facing: Facing = "user"): Promise<CameraLease> {
  if (paused) {
    throw Object.assign(new Error("Camera bus is paused"), { name: "AbortError" });
  }
  const entry = pool[facing];
  if (entry.stopTimer) { clearTimeout(entry.stopTimer); entry.stopTimer = null; }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    entry.refcount = Math.max(0, entry.refcount - 1);
    if (entry.refcount === 0) scheduleStop(entry);
  };

  // Fast path — stream already alive.
  if (entry.stream && entry.stream.getVideoTracks().some((t) => t.readyState === "live")) {
    entry.refcount += 1;
    return { stream: entry.stream, release };
  }

  // Coalesce concurrent acquires while one getUserMedia is in flight.
  if (!entry.pending) {
    entry.pending = openStream(facing).then((s) => {
      entry.stream = s;
      // If the OS ends the track (privacy indicator off, app switch), drop it.
      s.getVideoTracks().forEach((t) => {
        t.addEventListener("ended", () => {
          if (entry.stream === s) {
            entry.stream = null;
            // Surviving consumers will re-acquire on next request.
          }
        });
      });
      return s;
    }).finally(() => { entry.pending = null; });
  }

  try {
    const stream = await entry.pending;
    entry.refcount += 1;
    return { stream, release };
  } catch (err) {
    released = true; // never acquired
    throw err;
  }
}

// ─── visibility / lifecycle ──────────────────────────────────────────────────
if (typeof document !== "undefined") {
  const onHidden = () => {
    // Hard-stop streams when the tab is fully hidden — they'll be re-opened on resume.
    (Object.keys(pool) as Facing[]).forEach((f) => {
      if (pool[f].refcount === 0) hardStop(pool[f]);
    });
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) onHidden();
  });
  window.addEventListener("pagehide", () => {
    (Object.keys(pool) as Facing[]).forEach((f) => hardStop(pool[f]));
  });
}

// ─── debug helper (used by dev tools, not UI) ────────────────────────────────
export const _debugCameraBus = () => ({
  user: { refcount: pool.user.refcount, alive: !!pool.user.stream },
  environment: { refcount: pool.environment.refcount, alive: !!pool.environment.stream },
  paused,
});
