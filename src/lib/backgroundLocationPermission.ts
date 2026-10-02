/**
 * Android "Allow all the time" location (KI-12 gap 1).
 *
 * A push that arrives while the app is backgrounded triggers a one-shot
 * location fix (DuoSpaceLocationService). On Android 10+ that fix returns
 * nothing unless background location is granted — and nothing in the app used
 * to ask for it. This module is the JS side of the ask; the prompt UI is
 * components/BackgroundLocationPrompt.tsx.
 *
 * iOS is not handled here: its plugin already requests "Always" itself.
 * UNVERIFIED on a device — see .ai/KNOWN_ISSUES.md KI-12.
 */
import { Capacitor } from "@capacitor/core";
import { DuospaceBackgroundGeolocation, type BackgroundPermissionStatus } from "duospace-background-geolocation";
import storage from "@/lib/storage";

/**
 * Kill switch for the "Allow all the time" explainer dialog. Set to false to
 * stop it appearing at all (no other code depends on it) — e.g. if you want to
 * verify the rest of a build first, or hold it until the dialog copy is final.
 */
export const BACKGROUND_LOCATION_PROMPT_ENABLED = true;

const DISMISSED_AT_KEY = "duo-bg-location-prompt-dismissed-at";
/** After "Not now", don't ask again for this long. */
const REASK_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export type BackgroundLocationStatus = BackgroundPermissionStatus | "unsupported";

export function isBackgroundPromptPlatform(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
}

/** Never prompts. "unsupported" = not Android native (nothing to ask). Errors read as "unsupported" so a plugin hiccup can never block the app. */
export async function getBackgroundLocationStatus(): Promise<BackgroundLocationStatus> {
  if (!isBackgroundPromptPlatform()) return "unsupported";
  try {
    const { status } = await DuospaceBackgroundGeolocation.checkBackgroundPermission();
    return status;
  } catch {
    return "unsupported";
  }
}

/** Triggers the OS flow. Returns the re-read real state; "denied" on any failure. */
export async function requestBackgroundLocation(): Promise<BackgroundLocationStatus> {
  if (!isBackgroundPromptPlatform()) return "unsupported";
  try {
    const { status } = await DuospaceBackgroundGeolocation.requestBackgroundPermission();
    return status;
  } catch {
    return "denied";
  }
}

export function recordBackgroundPromptDismissed(): void {
  storage.set(DISMISSED_AT_KEY, String(Date.now()));
}

/** True if the person said "Not now" recently enough that we shouldn't ask again yet. */
export function backgroundPromptRecentlyDismissed(now: number = Date.now()): boolean {
  const raw = storage.get(DISMISSED_AT_KEY);
  const at = raw ? Number(raw) : NaN;
  return Number.isFinite(at) && now - at < REASK_AFTER_MS;
}
