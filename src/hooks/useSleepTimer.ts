/**
 * Sleep timer with a gentle fade-out.
 *
 * Time-based (an end timestamp, not a countdown), so a throttled/late JS timer
 * while the screen is off still pauses at the right moment as soon as it runs,
 * and on resume. LIMIT: if Android freezes the WebView entirely, the pause
 * happens when it wakes — a fully reliable timer needs the native player
 * service. Fade uses setVolume (native-engine tracks); YouTube tracks just pause.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export const SLEEP_FADE_MS = 20_000;

export function useSleepTimer(opts: { pause: () => void; setVolume: (v: number) => void; isPlaying: boolean }) {
  const { pause, setVolume } = opts;
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const fn = useRef({ pause, setVolume });
  fn.current = { pause, setVolume };
  const fading = useRef(false);

  const cancel = useCallback(() => {
    setEndsAt(null); setRemainingMs(0);
    if (fading.current) { fading.current = false; fn.current.setVolume(1); }
  }, []);
  const start = useCallback((minutes: number) => { setEndsAt(Date.now() + minutes * 60_000); }, []);

  useEffect(() => {
    if (endsAt == null) return;
    const tick = () => {
      const left = endsAt - Date.now();
      if (left <= 0) {
        fn.current.pause();
        fading.current = false;
        fn.current.setVolume(1); // restore for the next play
        setEndsAt(null); setRemainingMs(0);
        return;
      }
      setRemainingMs(left);
      if (left <= SLEEP_FADE_MS) { fading.current = true; fn.current.setVolume(Math.max(0, left / SLEEP_FADE_MS)); }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    const onVis = () => tick();
    document.addEventListener("visibilitychange", onVis);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [endsAt]);

  return { active: endsAt != null, remainingMs, start, cancel };
}

export const formatRemaining = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 1 ? `${m} min` : `${s}s`;
};
