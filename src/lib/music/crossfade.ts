/**
 * Crossfade setting (seconds of overlap between songs; 0 = off).
 *
 * Applied by the NATIVE player (Android) — it runs a second player for the outgoing tail so the overlap
 * keeps working with the screen locked. Stored per device; web / iOS ignore it (no native crossfade there).
 */
import { Capacitor } from "@capacitor/core";
import { nativeEngine } from "@/lib/music/nativeAudioEngine";

const KEY = "groic-crossfade-s";
export const CROSSFADE_OPTIONS = [0, 3, 5, 8, 12] as const;

export const isCrossfadeSupported = (): boolean => Capacitor.getPlatform() === "android";

export function getCrossfadeSeconds(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return (CROSSFADE_OPTIONS as readonly number[]).includes(n) ? n : 0;
  } catch { return 0; }
}

/** Persist + push to the native engine. Never throws. */
export function setCrossfadeSeconds(seconds: number): void {
  const s = (CROSSFADE_OPTIONS as readonly number[]).includes(seconds) ? seconds : 0;
  try { localStorage.setItem(KEY, String(s)); } catch { /* storage blocked */ }
  if (isCrossfadeSupported()) nativeEngine.setCrossfade(s).catch(() => { /* older native build */ });
}

/** Re-send the stored value (engine just started / app relaunched). */
export function applyStoredCrossfade(): void {
  if (!isCrossfadeSupported()) return;
  nativeEngine.setCrossfade(getCrossfadeSeconds()).catch(() => { /* older native build */ });
}
