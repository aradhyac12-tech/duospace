/**
 * nativeCallActionBridge — durable delivery for a native call action that
 * can fire before this app's own JS has anywhere to catch it.
 *
 * THE BUG THIS FIXES ("can't pick up the call, stuck on connecting"):
 * both platforms report Accept/Decline/End/Mute actions from the OS's own
 * call UI (Android's full-screen incoming-call notification, iOS CallKit's
 * lock-screen UI) as fire-and-forget:
 *   - Android: MainActivity evaluateJavascript()'s a `window.dispatchEvent`
 *     (see scripts/patch-native-permissions.mjs's handleDuospaceCallIntent)
 *     — a no-op if nothing has called `addEventListener` yet.
 *   - iOS: CallKitManager's CXProviderDelegate callback -> the
 *     DuospaceCallKitBridge plugin's `notifyListeners("callAction", ...)`
 *     — a no-op if nothing has called `addListener("callAction", ...)` yet.
 * Both listeners live in usePushNotifications.ts, which only registers
 * once React has mounted AND useAuth has resolved a user. A cold-start tap
 * on Accept (the OS answers instantly; the WebView/React/auth chain does
 * not) can easily win that race — the action fires into a void, nothing
 * ever actually accepts the call, and the person is left looking at
 * whatever the app happens to render (often nothing, or a stale
 * "Connecting…") with no way to know they need to act again.
 *
 * THE FIX: both native sides now ALSO persist the same action somewhere
 * that survives independently of any JS listener being registered —
 * Android writes it to localStorage (available the instant the WebView has
 * a document, well before React mounts); iOS writes it to UserDefaults
 * (available the instant the native call action fires, independent of the
 * WebView entirely) and exposes it via the DuospaceCallKitBridge plugin's
 * `getPendingCallAction()` method. This module is the one place that reads
 * either, once, on boot — see usePushNotifications.ts for the call site.
 *
 * Single-slot by design, matching this app's whole calling architecture
 * (see callLatency.ts's own doc comment): DuoSpace is 1:1 calling, one call
 * in flight at a time, so there is never more than one pending action worth
 * keeping — a second one always supersedes the first.
 */
import { Capacitor } from "@capacitor/core";
import { DuospaceCallKitBridge } from "duospace-callkit-bridge";

const STORAGE_KEY = "duospace_pending_call_action";
const AUTO_ACCEPT_KEY = "duospace_auto_accept_call_id";

// Generous vs. the 30-45s a call actually stays ringable (see
// IncomingCallOverlay's own 30s auto-decline / 45s cold-start poll
// window) — this just guards against replaying something from a much
// earlier, unrelated app session, not against normal ringing latency.
const MAX_PENDING_AGE_MS = 60_000;

export interface PendingCallAction {
  callId: string;
  action: string;
  isVideo?: boolean;
  wasAnswered?: boolean;
  ts: number;
}

function isFreshEnough(ts: unknown): ts is number {
  return typeof ts === "number" && Date.now() - ts < MAX_PENDING_AGE_MS;
}

/**
 * Reads and clears whatever pending native call action exists for this
 * platform. Best-effort and side-effect-free on failure — per this app's
 * own rule for instrumentation/bridge code (see callLatency.ts), a bug in
 * here must never be able to break a call, so every path returns `null`
 * rather than throwing.
 */
export async function drainPendingCallAction(): Promise<PendingCallAction | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const platform = Capacitor.getPlatform();
    if (platform === "android") {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      window.localStorage.removeItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<PendingCallAction>;
      if (!parsed.callId || !parsed.action || !isFreshEnough(parsed.ts)) return null;
      return parsed as PendingCallAction;
    }
    if (platform === "ios") {
      const result = await DuospaceCallKitBridge.getPendingCallAction();
      if (!result?.callId || !result.action || !isFreshEnough(result.ts)) return null;
      return result as PendingCallAction;
    }
  } catch {
    // Best-effort — see doc comment above.
  }
  return null;
}

/** Drops the durable Android pending-action slot without reading it — for a
 *  live listener that has just handled the same action in memory, so the next
 *  boot's drainPendingCallAction() doesn't replay it. Best-effort. */
export function clearPendingCallAction(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort */
  }
}

/**
 * Signals that `callId` was already answered via a native call action (OS
 * call UI, or the durable replay above) and IncomingCallOverlay should
 * accept it directly instead of waiting for a second in-app tap. A plain
 * sessionStorage flag rather than a module-level variable so it works
 * regardless of which of usePushNotifications.ts / IncomingCallOverlay.tsx
 * happens to run first — see their own call sites for the two orderings
 * this covers (flag set before the call is hydrated, and hydrated before
 * the flag is set).
 */
export function requestAutoAccept(callId: string): void {
  try {
    window.sessionStorage.setItem(AUTO_ACCEPT_KEY, callId);
  } catch {
    // Best-effort.
  }
}

/** Consumes the auto-accept flag above if it matches `callId`. Read-and-
 *  clear so a stale flag from an earlier, already-resolved call can never
 *  auto-accept a later, unrelated one. */
export function consumeAutoAccept(callId: string): boolean {
  try {
    const pending = window.sessionStorage.getItem(AUTO_ACCEPT_KEY);
    if (pending !== callId) return false;
    window.sessionStorage.removeItem(AUTO_ACCEPT_KEY);
    return true;
  } catch {
    return false;
  }
}
