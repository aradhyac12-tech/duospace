export interface BackgroundFix {
  latitude: number;
  longitude: number;
  /** Meters, when the platform reports it. */
  accuracy: number | null;
  /** Epoch ms. */
  timestamp: number;
  /**
   * 'watch' — from the ongoing background watcher (foreground service on
   * Android / CLLocationManager background updates + significant-change on
   * iOS). 'oneShot' — from requestImmediateFix(), fired specifically when a
   * call or message push just arrived and the app wants a fresh fix right
   * now rather than waiting for the next watcher tick.
   */
  source: 'watch' | 'oneShot';
}

export interface BackgroundLocationError {
  /** 'denied' | 'unavailable' | 'timeout' | 'unknown' — same normalized
   *  shape useLiveLocation.ts's normalizeNativeErr() already produces, so
   *  callers can route both through one error state machine. */
  code: 'denied' | 'unavailable' | 'timeout' | 'unknown';
  message: string;
}

export interface StartOptions {
  /**
   * Desired interval between background fixes, in milliseconds, while the
   * app is not in the foreground. This is a *floor*, not a guarantee —
   * both OSes reserve the right to batch/throttle further to save battery.
   * Default 45000 (45s). Keep this well above the foreground tracker's
   * cadence (useLiveLocation.ts) since this layer only exists to keep
   * *something* flowing while suspended, not to replace foreground
   * accuracy.
   */
  intervalMs?: number;
}

export interface RequestImmediateFixOptions {
  /** Short reason string, surfaced only in native logs — e.g. 'incoming_call',
   *  'incoming_message', 'manual'. Not sent anywhere, purely diagnostic. */
  reason?: string;
  /** Max time to wait for a fix before giving up, in milliseconds. Default 8000. */
  timeoutMs?: number;
}

export interface DuospaceBackgroundGeolocationPlugin {
  /**
   * Starts the platform-appropriate background-capable watcher:
   *  - Android: starts a foreground service (notification channel
   *    "duospace_location", ongoing/low-importance) driving
   *    FusedLocationProviderClient updates that keep running while the app
   *    process is alive but backgrounded/screen-off.
   *  - iOS: enables `allowsBackgroundLocationUpdates` on a CLLocationManager
   *    plus significant-location-change monitoring as an OS-level wake
   *    source, so the app gets a chance to fetch a fresh fix even after
   *    being suspended (not just minimized).
   * No-op resolving immediately on web (use the existing
   * navigator.geolocation.watchPosition path there — see useLiveLocation.ts).
   * Safe to call again with the same or different options; restarts the
   * watcher with the new interval.
   */
  start(options?: StartOptions): Promise<void>;

  /** Stops the background watcher and (Android) tears down the foreground
   *  service + its notification. Call this on sign-out, exactly like
   *  useLiveLocation.ts already does for the foreground watcher. */
  stop(): Promise<void>;

  /**
   * Requests a single fresh, high-accuracy fix right now, independent of
   * the regular watcher cadence — this is what CallNotificationService.kt /
   * CallKitManager.swift call the instant a call push arrives, and what the
   * JS push-notification listener calls for a regular message push. If the
   * background watcher isn't already running, this also starts it (so
   * tracking continues rather than being a single fix then silence).
   * Resolves with the fix once genuinely obtained (never a cached/stale
   * value silently substituted) or rejects with a BackgroundLocationError —
   * callers should treat rejection as "no fix this time," not throw a hard
   * error, since a missed call/message-triggered fix should never break
   * the call/message flow itself.
   */
  requestImmediateFix(options?: RequestImmediateFixOptions): Promise<BackgroundFix>;

  /** True if the background watcher is currently running. */
  isRunning(): Promise<{ running: boolean }>;

  /** Fires for every fix obtained by the background watcher or a one-shot
   *  request — including ones triggered natively (from a call/message push)
   *  before any JS code asked for it. LocationContext forwards these into
   *  the same writeLocation()/offline-queue path the foreground watcher
   *  already uses, so there's one write path regardless of source. */
  addListener(
    eventName: 'locationUpdate',
    listenerFunc: (fix: BackgroundFix) => void,
  ): Promise<{ remove: () => void }>;

  addListener(
    eventName: 'locationError',
    listenerFunc: (error: BackgroundLocationError) => void,
  ): Promise<{ remove: () => void }>;

  removeAllListeners(): Promise<void>;
}
