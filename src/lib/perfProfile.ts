/**
 * "Smooth mode" — reduced visual effects for devices that struggle with them.
 *
 * The app's glass surfaces (dock, headers, sheets, player) all use
 * `backdrop-filter: blur(...)`. On a modern phone that's free; on a low-end
 * Android WebView every frame of scrolling has to re-blur whatever is behind the
 * always-visible dock and header, which is a common source of dropped frames.
 *
 * Preference (stored in `duo-effects`):
 *   "auto"  (default) — turn effects down only when the device looks low-end.
 *   "lite"            — always use the cheap flat surfaces.
 *   "full"            — always use the full glass look.
 *
 * The result is a single attribute on <html> (`data-effects="lite"`), which
 * index.css keys off. Nothing else in the app needs to know about it.
 */
import storage from "@/lib/storage";

export type EffectsPreference = "auto" | "lite" | "full";

const KEY = "duo-effects";
/** Set once the adaptive monitor (below) has seen sustained dropped frames on THIS device in "auto" mode. */
const AUTO_LITE_KEY = "duo-effects-auto-lite";

export interface DeviceSignals {
  deviceMemory?: number;         // GB, navigator.deviceMemory (Chromium/WebView only)
  hardwareConcurrency?: number;  // logical cores
  saveData?: boolean;            // navigator.connection.saveData
}

/** Pure — exported for tests. Any single strong signal of a weak device is enough. */
export function isLowEndDevice(s: DeviceSignals): boolean {
  if (typeof s.deviceMemory === "number" && s.deviceMemory > 0 && s.deviceMemory <= 3) return true;
  if (typeof s.hardwareConcurrency === "number" && s.hardwareConcurrency > 0 && s.hardwareConcurrency <= 4) return true;
  if (s.saveData === true) return true;
  return false;
}

/** Pure — exported for tests. */
export function resolveEffectsMode(pref: EffectsPreference, signals: DeviceSignals): "lite" | "full" {
  if (pref === "lite") return "lite";
  if (pref === "full") return "full";
  return isLowEndDevice(signals) ? "lite" : "full";
}

function readSignals(): DeviceSignals {
  try {
    const nav = navigator as Navigator & {
      deviceMemory?: number;
      connection?: { saveData?: boolean };
    };
    return {
      deviceMemory: nav.deviceMemory,
      hardwareConcurrency: nav.hardwareConcurrency,
      saveData: nav.connection?.saveData,
    };
  } catch {
    return {};
  }
}

export function getEffectsPreference(): EffectsPreference {
  const v = storage.get(KEY);
  return v === "lite" || v === "full" ? v : "auto";
}

export function applyEffectsPreference(pref: EffectsPreference = getEffectsPreference()): "lite" | "full" {
  let mode = resolveEffectsMode(pref, readSignals());
  // "Auto" on a phone that LOOKS fast (e.g. flagship Galaxy) but measurably drops frames → stay lite.
  if (pref === "auto" && mode === "full" && storage.get(AUTO_LITE_KEY) === "1") mode = "lite";
  try {
    const root = document.documentElement;
    if (mode === "lite") root.setAttribute("data-effects", "lite");
    else root.removeAttribute("data-effects");
  } catch { /* no DOM (tests / SSR) */ }
  return mode;
}

export function setEffectsPreference(pref: EffectsPreference): "lite" | "full" {
  if (pref === "auto") { storage.remove(KEY); storage.remove(AUTO_LITE_KEY); } // re-evaluate from scratch
  else storage.set(KEY, pref);
  return applyEffectsPreference(pref);
}

/** Pure — exported for tests. Is this window of frames bad enough to count as "laggy"? */
export function isJankyWindow(frames: number, janky: number): boolean {
  return frames >= 100 && janky / frames > 0.2;
}

/**
 * Adaptive "Smooth mode" for "Auto": device specs can't tell you a Galaxy S24 Ultra is dropping frames
 * under a stack of blurred glass layers, but a frame-time probe can. While the person is actually
 * scrolling/touching (never idle, never in the background) we count frames slower than ~40 fps. Two bad
 * windows (~2.5 s of real scrolling each) switch effects to lite and remember it; eight clean windows
 * mean the device is fine and the monitor stops for good. Only runs in "auto" and only while still "full".
 */
export function startAdaptiveEffects(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined" || typeof requestAnimationFrame !== "function") return () => {};
  const root = document.documentElement;
  if (getEffectsPreference() !== "auto" || root.getAttribute("data-effects") === "lite") return () => {};

  let stopped = false, running = false, raf = 0;
  let lastTouch = 0, last = 0, frames = 0, janky = 0, bad = 0, clean = 0;

  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("touchmove", bump, true);
    window.removeEventListener("scroll", bump, true);
    window.removeEventListener("wheel", bump, true);
  };
  const loop = (t: number) => {
    if (stopped) return;
    if (document.hidden || performance.now() - lastTouch > 600) { running = false; last = 0; return; }
    if (last) {
      const dt = t - last;
      if (dt < 250) { frames += 1; if (dt > 25) janky += 1; } // gaps > 250 ms = tab switch / OS pause, not jank
    }
    last = t;
    if (frames >= 150) {
      if (isJankyWindow(frames, janky)) { bad += 1; } else { clean += 1; bad = Math.max(0, bad - 1); }
      frames = 0; janky = 0;
      if (bad >= 2) {
        storage.set(AUTO_LITE_KEY, "1");
        root.setAttribute("data-effects", "lite");
        stop();
        return;
      }
      if (clean >= 8) { stop(); return; }
    }
    raf = requestAnimationFrame(loop);
  };
  function bump() {
    lastTouch = performance.now();
    if (!running && !stopped) { running = true; last = 0; raf = requestAnimationFrame(loop); }
  }
  window.addEventListener("touchmove", bump, { capture: true, passive: true });
  window.addEventListener("scroll", bump, { capture: true, passive: true });
  window.addEventListener("wheel", bump, { capture: true, passive: true });
  return stop;
}

/** Call once, before the first render, so the first painted frame is already correct. */
export function bootPerfProfile(): void {
  applyEffectsPreference();
  // Give startup (route chunk, first data) time to settle before judging smoothness.
  if (typeof window !== "undefined") window.setTimeout(() => { startAdaptiveEffects(); }, 6000);
}
