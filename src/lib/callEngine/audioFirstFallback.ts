/**
 * Pure helpers for video-call network adaptation (extracted from the call
 * engine adapter so they can be unit-tested without a LiveKit room).
 */
export type CallNetworkQuality = "excellent" | "good" | "fair" | "poor";

/** LiveKit ConnectionQuality -> our 4 levels (LK "poor" = fair, LK "lost" = poor). */
export function mapConnectionQuality(q: string): CallNetworkQuality {
  switch (q) {
    case "excellent": return "excellent";
    case "good": return "good";
    case "poor": return "fair";
    case "lost": return "poor";
    default: return "good"; // "unknown": don't alarm the user
  }
}

export interface AudioFirstFallbackOptions {
  /** Link must stay "poor" this long with the camera on before the camera is paused. */
  lostMs?: number;
  /** Link must stay fair-or-better this long before an auto-paused camera resumes. */
  recoverMs?: number;
  isCameraOn: () => boolean;
  pause: () => void;
  resume: () => void;
}

export interface AudioFirstFallback {
  onQuality: (q: CallNetworkQuality) => void;
  /** Drop timers and forget any auto-pause (call on manual toggle / call end). */
  cancel: () => void;
  isAutoPaused: () => boolean;
}

export function createAudioFirstFallback(opts: AudioFirstFallbackOptions): AudioFirstFallback {
  const lostMs = opts.lostMs ?? 8000;
  const recoverMs = opts.recoverMs ?? 10000;
  let lostTimer: ReturnType<typeof setTimeout> | null = null;
  let recoverTimer: ReturnType<typeof setTimeout> | null = null;
  let autoPaused = false;

  const clearLost = () => { if (lostTimer) { clearTimeout(lostTimer); lostTimer = null; } };
  const clearRecover = () => { if (recoverTimer) { clearTimeout(recoverTimer); recoverTimer = null; } };

  return {
    onQuality(q) {
      if (q === "fair" || q === "poor") {
        clearRecover();
        if (q === "poor" && !lostTimer && !autoPaused && opts.isCameraOn()) {
          lostTimer = setTimeout(() => {
            lostTimer = null;
            if (!opts.isCameraOn()) return;
            autoPaused = true;
            opts.pause();
          }, lostMs);
        }
      } else {
        clearLost();
        if (autoPaused && !recoverTimer) {
          recoverTimer = setTimeout(() => {
            recoverTimer = null;
            if (!autoPaused) return;
            autoPaused = false;
            opts.resume();
          }, recoverMs);
        }
      }
    },
    cancel() { clearLost(); clearRecover(); autoPaused = false; },
    isAutoPaused: () => autoPaused,
  };
}
