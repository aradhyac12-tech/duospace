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
  const mode = resolveEffectsMode(pref, readSignals());
  try {
    const root = document.documentElement;
    if (mode === "lite") root.setAttribute("data-effects", "lite");
    else root.removeAttribute("data-effects");
  } catch { /* no DOM (tests / SSR) */ }
  return mode;
}

export function setEffectsPreference(pref: EffectsPreference): "lite" | "full" {
  if (pref === "auto") storage.remove(KEY);
  else storage.set(KEY, pref);
  return applyEffectsPreference(pref);
}

/** Call once, before the first render, so the first painted frame is already correct. */
export function bootPerfProfile(): void {
  applyEffectsPreference();
}
