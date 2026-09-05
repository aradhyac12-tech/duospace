// callBackgroundSupport — keeps an active call alive/controllable when the
// browser tab is backgrounded (minimized, switched away from, screen locked
// on mobile web). Native iOS/Android already have real background call
// handling via CallKit/Telecom + PushKit/FCM (native/ios/CallKitManager.swift,
// native/android/CallBridge.kt+CallRingingService.kt) — this covers the one
// remaining gap, plain browser tabs (desktop Chrome/Safari/Firefox and
// mobile web, e.g. opened outside the installed app).
//
// Two independent browser APIs, both optional/feature-detected since
// support varies (Safari has neither as of this writing on some versions):
//
// 1. Screen Wake Lock — without it, a phone's screen-off timeout can put
//    the browser tab in a more aggressive suspended state mid-call. A wake
//    lock is released automatically by the browser on visibilitychange
//    (tab hidden) and MUST be manually re-acquired on visibilitychange back
//    to visible — that's the main gotcha this module handles.
// 2. Media Session API — surfaces call metadata + a hang-up action on the
//    OS-level lock screen / notification-style media controls on mobile
//    web, and keeps Chrome/Android from treating the tab's audio as
//    background-throttleable "not really playing anything" once it's
//    registered as active playback.
//
// Neither API can force a backgrounded tab to keep running indefinitely —
// that's a browser policy decision DuoSpace can't override — but between
// them a call's actual WebRTC audio (which keeps flowing on its own, same
// as any other active mic/speaker stream) stays reliable and controllable
// while backgrounded, on iOS Safari, Android Chrome, and desktop browsers.

type WakeLockSentinel = { release: () => Promise<void>; addEventListener: (type: string, cb: () => void) => void };
type NavigatorWithWakeLock = Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinel> } };

let wakeLockSentinel: WakeLockSentinel | null = null;
let visibilityHandlerAttached = false;

const requestWakeLock = async () => {
  const nav = navigator as NavigatorWithWakeLock;
  if (!nav.wakeLock) return;
  try {
    wakeLockSentinel = await nav.wakeLock.request("screen");
    wakeLockSentinel.addEventListener("release", () => { wakeLockSentinel = null; });
  } catch {
    // Denied (e.g. low battery, backgrounded tab at request-time) — the
    // call itself is unaffected, this is a best-effort resilience layer.
    wakeLockSentinel = null;
  }
};

const releaseWakeLock = async () => {
  if (!wakeLockSentinel) return;
  try { await wakeLockSentinel.release(); } catch { /* already released */ }
  wakeLockSentinel = null;
};

// Re-acquires the wake lock when the tab regains visibility mid-call
// (browsers release it automatically on hide — this is the required
// counterpart, not optional polish). No-op once `stopCallBackgroundSupport`
// has run for this call.
let activeCallActive = false;
const onVisibilityChange = () => {
  if (activeCallActive && document.visibilityState === "visible" && !wakeLockSentinel) {
    void requestWakeLock();
  }
};

/** Call once a call reaches `callState === "joined"`. */
export const startCallBackgroundSupport = (opts: { callType: "video" | "voice"; onHangup: () => void }) => {
  activeCallActive = true;
  void requestWakeLock();

  if (!visibilityHandlerAttached) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    visibilityHandlerAttached = true;
  }

  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: opts.callType === "video" ? "Video call" : "Voice call",
        artist: "DuoSpace",
      });
      navigator.mediaSession.playbackState = "playing";
      navigator.mediaSession.setActionHandler("hangup", opts.onHangup);
      // Some browsers route the generic "pause" control to hang up a call
      // session rather than showing a disabled/no-op button.
      navigator.mediaSession.setActionHandler("pause", opts.onHangup);
    } catch {
      // Older browsers throw on unsupported action names (e.g. "hangup") —
      // metadata still applies even if setActionHandler partially fails.
    }
  }
};

/** Call once a call ends/leaves — `callState` back to "idle"/"error". */
export const stopCallBackgroundSupport = () => {
  activeCallActive = false;
  void releaseWakeLock();

  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.playbackState = "none";
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.setActionHandler("hangup", null);
      navigator.mediaSession.setActionHandler("pause", null);
    } catch { /* no-op */ }
  }
};
