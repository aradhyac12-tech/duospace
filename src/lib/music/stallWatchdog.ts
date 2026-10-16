/**
 * Playback-stall helpers (pure, no React/Capacitor).
 *
 * Why: only YouTube tracks had a stall watchdog. Native-engine tracks (SoundCloud / Audius / Jamendo /
 * local files) had none — if ExoPlayer sat buffering forever, or a bridge call never returned, the UI
 * kept showing "playing"/a spinner with no recovery. These helpers let the context detect that and
 * reuse its existing "retry once with a fresh URL, then skip" ladder.
 */

/** Rejects if `p` does not settle within `ms`. The original promise is left to settle on its own. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export interface StallSample {
  trackId: string | null;
  /** The user's/engine's intent is "playing". A deliberate pause must never count as a stall. */
  wantPlaying: boolean;
  /** App backgrounded (JS timers are throttled there — do not judge). */
  hidden: boolean;
  /** Stream URL still being resolved, or a seek just happened: position is allowed to be still. */
  grace: boolean;
  positionSeconds: number;
}

/**
 * Counts consecutive "should be playing but position is frozen" samples. Returns true exactly once per
 * stall episode when the count reaches `thresholdTicks`, then re-arms (so the caller's retry/skip
 * ladder can run again if the stall persists).
 */
export function createStallDetector(thresholdTicks = 7, minAdvanceSeconds = 0.2) {
  let lastId: string | null = null;
  let lastPos = -1;
  let stuck = 0;

  const reset = () => { stuck = 0; };

  return {
    sample(s: StallSample): boolean {
      if (s.trackId !== lastId) { lastId = s.trackId; lastPos = -1; stuck = 0; }
      if (!s.trackId || !s.wantPlaying || s.hidden || s.grace) { stuck = 0; lastPos = s.positionSeconds; return false; }
      if (Math.abs(s.positionSeconds - lastPos) >= minAdvanceSeconds) { stuck = 0; lastPos = s.positionSeconds; return false; }
      lastPos = s.positionSeconds;
      stuck += 1;
      if (stuck < thresholdTicks) return false;
      reset();
      return true;
    },
    reset,
  };
}
