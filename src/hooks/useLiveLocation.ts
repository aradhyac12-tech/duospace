/**
 * useLiveLocation — production-grade live-location engine.
 *
 * Lifecycle: idle → requesting_permission → tracking ⇄ paused ⇄ reconnecting → failed
 *
 * Hardened with:
 *   • Single watcher (no duplicates across StrictMode/remount).
 *   • Adaptive accuracy (high while moving, eco while stationary on smoothed coords).
 *   • GPS smoothing + noise rejection (accuracy/speed/delta gates).
 *   • Distance + time throttle on Supabase writes.
 *   • Offline write queue + replay on `online`/visibility/realtime resume.
 *   • Coordinate validation (NaN / out-of-range).
 *   • Presence heartbeat into `profiles` (last_seen_at, tracking_state, app_visibility, device_platform).
 *   • Debug snapshot for in-app overlay.
 *
 * GPS SOURCE (native vs web): on native platforms this watches position via
 * the official `@capacitor/geolocation` plugin (already a dependency, was
 * previously only used for the upfront permission prime in
 * `useLaunchPermissions.ts` — nothing actually watched position through it).
 * `Geolocation.watchPosition` talks to the OS location APIs directly
 * through Capacitor's native bridge, rather than going through the
 * WebView's own `navigator.geolocation`, which is really just Chromium/
 * WebKit's implementation running inside the WebView's JS engine. The
 * practical difference: a WebView-hosted `watchPosition` call can go quiet
 * whenever the WebView surface itself isn't the thing on screen — e.g. a
 * native full-screen call UI (this app's CallKit/Telecom bridge, see
 * native-plugins/callkit-bridge) covering the app while the process is
 * still very much in the foreground — because some OEM WebView
 * implementations throttle/suspend a detached or obscured WebView's JS
 * timers independently of whether the *app* is foregrounded. A listener
 * registered through the native plugin isn't tied to the WebView's paint
 * state the same way, so it keeps collecting fixes through exactly that
 * window. On web (no Capacitor), falls back to `navigator.geolocation`
 * unchanged — same as before.
 *
 * This does NOT by itself add true background tracking for a minimized/
 * screen-off app — that needs a background-location + foreground-service
 * plugin (e.g. `@capacitor-community/background-geolocation`), which is a
 * separate, larger native change. See docs/DUOSPACE-LOCATION-CONTEXT.md.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Geolocation, type PositionOptions as CapPositionOptions } from "@capacitor/geolocation";
import { supabase } from "@/integrations/supabase/client";
import { logInfo, logWarn, logError, newTraceId } from "@/lib/telemetry";
import {
  enqueueLocation,
  flushQueuedLocations,
  getQueueDepth,
} from "@/lib/locationQueue";

export type LiveLocationState =
  | "idle"
  | "requesting_permission"
  | "tracking"
  | "paused"
  | "reconnecting"
  | "failed";

export type TrackingState = "tracking" | "paused" | "reconnecting" | "offline";

export interface LiveLocationData {
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number | null;
  speed?: number | null;
  updated_at: string;
}

export interface LiveDebug {
  mode: "high" | "eco";
  watcherActive: boolean;
  queueDepth: number;
  lastHeartbeatAt: number | null;
  avgAccuracy: number | null;
  rejectedFixCount: number;
  smoothingAppliedCount: number;
  reconnectAttempts: number;
  lastDbWriteAt: number | null;
  batteryLevel: number | null;
}

interface Options {
  userId: string | null;
  /** Master enable: false = idle, no watcher. */
  enabled: boolean;
  /** Active session: false → paused (e.g. on_open mode + page hidden). */
  active: boolean;
  /**
   * Whether anything is actually reading `debug`. When false (the default —
   * the debug overlay is hidden behind a 5-tap gesture and off in normal
   * use), the 5s debug-snapshot ticker below is skipped entirely, so the
   * consuming screen doesn't re-render every 5 seconds for a panel nobody
   * is looking at.
   */
  debugEnabled?: boolean;
}

const TELE = "liveLocation";

// Movement / write thresholds
const MIN_MOVE_DB_M       = 8;     // skip Supabase write if moved < 8m
const MIN_WRITE_INTERVAL  = 4000;  // and < 4s since last write
const LOCAL_UPDATE_MIN_M  = 3;     // local marker updates only when moved > 3m
const STATIONARY_MS       = 30_000;// switch to eco after 30s stationary

// Noise gates
const ACCURACY_HARD_REJECT_M = 250;  // discard fixes worse than 250m unconditionally
const ACCURACY_SOFT_M        = 120;  // soft cap when movement is small
const SMALL_MOVEMENT_M       = 25;   // movement considered "small" for soft cap
const MAX_SPEED_KMH          = 150;  // implied speed cap (above = noise)

// Smoothing
const SMOOTH_ALPHA_PREV = 0.7;
const SMOOTH_ALPHA_NEXT = 0.3;

// Presence heartbeat
const HEARTBEAT_MS = 30_000;
const MODE_CHECK_INTERVAL = 15_000;

const HIGH_OPTS: PositionOptions = { enableHighAccuracy: true,  maximumAge: 5_000,  timeout: 20_000 };
const ECO_OPTS:  PositionOptions = { enableHighAccuracy: false, maximumAge: 30_000, timeout: 30_000 };

function distanceMeters(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) {
  const R = 6_371_000;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.latitude * Math.PI) / 180) *
      Math.cos((b.latitude * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function isValidCoord(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function detectPlatform(): string {
  if (typeof navigator === "undefined") return "unknown";
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Android/i.test(ua))           return "Android";
  if (/Windows/i.test(ua))           return "Windows";
  if (/Macintosh|Mac OS X/i.test(ua))return "macOS";
  if (/Linux/i.test(ua))             return "Linux";
  return "Web";
}

export function useLiveLocation({ userId, enabled, active, debugEnabled = false }: Options) {
  const [state, setState]           = useState<LiveLocationState>("idle");
  const [location, setLocation]     = useState<LiveLocationData | null>(null);
  const [error, setError]           = useState<string | null>(null);
  const [permission, setPermission] = useState<"unknown" | "prompt" | "granted" | "denied">("unknown");
  const [debug, setDebug] = useState<LiveDebug>({
    mode: "high",
    watcherActive: false,
    queueDepth: 0,
    lastHeartbeatAt: null,
    avgAccuracy: null,
    rejectedFixCount: 0,
    smoothingAppliedCount: 0,
    reconnectAttempts: 0,
    lastDbWriteAt: null,
    batteryLevel: null,
  });

  const watchIdRef    = useRef<number | string | null>(null);
  /** Incremented on every `startWatcher` call; guards against the
   *  Capacitor plugin's async `watchPosition` resolving its id AFTER a
   *  newer `startWatcher`/`stopWatcher` call has already superseded it
   *  (e.g. the eco/high mode-switch restart) — without this, a stale
   *  resolve could stomp `watchIdRef` with an id nothing intends to keep
   *  running, leaking an orphaned native watcher. */
  const watchGenerationRef = useRef(0);
  const ecoRef        = useRef(false);
  const lastWriteRef  = useRef<{ ts: number; lat: number; lon: number } | null>(null);
  /** Smoothed last fix (used for movement decisions, marker, and stationary detection). */
  const lastFixRef    = useRef<LiveLocationData | null>(null);
  /** Raw last fix with timestamp — for implied-speed check. */
  const lastRawRef    = useRef<{ lat: number; lon: number; ts: number } | null>(null);
  const lastMoveTsRef = useRef<number>(Date.now());
  const traceRef      = useRef<string>("");
  const mountedRef    = useRef(true);
  const heartbeatTimerRef = useRef<number | null>(null);
  const lastPresenceRef = useRef<{ state: TrackingState; visibility: string; ts: number } | null>(null);

  // Debug counters live in refs so fix processing never triggers a rerender;
  // we publish a snapshot to state on a slow cadence.
  const accSamplesRef    = useRef<number[]>([]);
  const rejectedRef      = useRef(0);
  const smoothedRef      = useRef(0);
  const reconnectRef     = useRef(0);
  const lastDbWriteRef   = useRef<number | null>(null);
  const lastHeartbeatRef = useRef<number | null>(null);
  const batteryRef       = useRef<number | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const safe = <T,>(setter: (v: T) => void, v: T) => { if (mountedRef.current) setter(v); };

  // ── Battery probe (best-effort; not all browsers expose it) ────────────────
  useEffect(() => {
    const nav = navigator as any;
    if (!nav?.getBattery) return;
    let battery: any = null;
    let cancelled = false;
    // Declared here (not inside the .then()) so the cleanup below closes over
    // the exact same function reference passed to addEventListener — passing
    // a fresh `() => {}` to removeEventListener, as this previously did, is a
    // no-op: it doesn't match the listener that was actually added, so the
    // listener is never removed and accumulates across mount/unmount cycles.
    const sync = () => { if (battery) batteryRef.current = battery.level; };
    nav.getBattery().then((b: any) => {
      if (cancelled) return;
      battery = b;
      sync();
      b.addEventListener?.("levelchange", sync);
    }).catch(() => { /* unsupported */ });
    return () => {
      cancelled = true;
      try { battery?.removeEventListener?.("levelchange", sync); } catch { /* ignore */ }
    };
  }, []);

  // ── Presence heartbeat ─────────────────────────────────────────────────────
  const updatePresence = useCallback(async (trackingState: TrackingState, force = false) => {
    if (!userId) return;
    const visibility = (typeof document !== "undefined" && document.hidden) ? "hidden" : "visible";
    const last = lastPresenceRef.current;
    const now  = Date.now();
    // Debounce identical writes within 5s.
    if (!force && last && last.state === trackingState && last.visibility === visibility && now - last.ts < 5000) {
      return;
    }
    lastPresenceRef.current = { state: trackingState, visibility, ts: now };
    lastHeartbeatRef.current = now;
    try {
      const { error: upErr } = await supabase
        .from("profiles")
        .update({
          last_seen_at: new Date(now).toISOString(),
          tracking_state: trackingState,
          app_visibility: visibility,
          device_platform: detectPlatform(),
        } as any)
        .eq("user_id", userId);
      if (upErr) throw upErr;
    } catch (err) {
      logWarn(TELE, "presence_write_failed", err, traceRef.current);
    }
  }, [userId]);

  // Map our internal lifecycle state → presence enum.
  useEffect(() => {
    if (!userId) return;
    const map: Record<LiveLocationState, TrackingState> = {
      idle:                  "offline",
      requesting_permission: "tracking",
      tracking:              "tracking",
      paused:                "paused",
      reconnecting:          "reconnecting",
      failed:                "offline",
    };
    void updatePresence(map[state]);
  }, [state, userId, updatePresence]);

  // Tab-visibility presence flips even if state doesn't change.
  useEffect(() => {
    const onVis = () => {
      if (!userId) return;
      // Re-emit current state so app_visibility is refreshed.
      const last = lastPresenceRef.current?.state ?? "tracking";
      void updatePresence(last as TrackingState, true);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [userId, updatePresence]);

  // 30s heartbeat while enabled.
  useEffect(() => {
    if (!userId || !enabled) {
      if (heartbeatTimerRef.current) { window.clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
      return;
    }
    heartbeatTimerRef.current = window.setInterval(() => {
      const last = lastPresenceRef.current?.state ?? "tracking";
      void updatePresence(last as TrackingState, true);
    }, HEARTBEAT_MS);
    return () => {
      if (heartbeatTimerRef.current) { window.clearInterval(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
    };
  }, [userId, enabled, updatePresence]);

  // Best-effort offline marker on unload.
  useEffect(() => {
    if (!userId) return;
    const onUnload = () => { void updatePresence("offline", true); };
    window.addEventListener("pagehide", onUnload);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [userId, updatePresence]);

  // ── Watcher control ────────────────────────────────────────────────────────
  // `watchIdRef` holds either a `number` (web `navigator.geolocation`
  // watch id) or a `string` (native `@capacitor/geolocation` callback id)
  // depending on platform — see the header comment for why native uses a
  // different underlying API.
  const stopWatcher = useCallback((reason: string) => {
    watchGenerationRef.current++;
    const id = watchIdRef.current;
    if (id !== null) {
      if (typeof id === "string") {
        void Geolocation.clearWatch({ id }).catch(() => { /* ignore */ });
      } else {
        try { navigator.geolocation.clearWatch(id); } catch { /* ignore */ }
      }
      watchIdRef.current = null;
      logInfo(TELE, "tracking_stopped", { reason }, traceRef.current);
    }
  }, []);

  // ── Write path with offline queue ──────────────────────────────────────────
  const writeLocation = useCallback(async (loc: LiveLocationData) => {
    if (!userId) return;
    if (!isValidCoord(loc.latitude, loc.longitude)) {
      logWarn(TELE, "invalid_coord_skip", { lat: loc.latitude, lon: loc.longitude }, traceRef.current);
      return;
    }
    try {
      // `captured_at` (the actual on-device fix time, distinct from the
      // server-assigned `updated_at`) is what
      // `locations_monotonic_write_guard_trg` compares against to reject an
      // out-of-order write — see that migration for why this can't just be
      // client-side throttling. Every write path (this one, the offline
      // queue flush, and LocationContext's native-fix write) must send it.
      const { error: upErr } = await supabase
        .from("locations")
        .upsert(
          { user_id: userId, latitude: loc.latitude, longitude: loc.longitude, captured_at: loc.updated_at },
          { onConflict: "user_id" },
        );
      if (upErr) throw upErr;
      lastDbWriteRef.current = Date.now();
    } catch (err) {
      logWarn(TELE, "write_failed_enqueue", err, traceRef.current);
      await enqueueLocation({
        user_id:     userId,
        latitude:    loc.latitude,
        longitude:   loc.longitude,
        captured_at: Date.parse(loc.updated_at) || Date.now(),
      });
    }
  }, [userId]);

  // Replay queued writes whenever connectivity / focus returns.
  const flushQueueIfAny = useCallback(async () => {
    try {
      const depth = await getQueueDepth();
      if (depth === 0) return;
      const result = await flushQueuedLocations();
      logInfo(TELE, "queue_flushed", result, traceRef.current);
    } catch (err) {
      logWarn(TELE, "queue_flush_failed", err, traceRef.current);
    }
  }, []);

  // ── Position handler with smoothing + noise rejection ──────────────────────
  const onPos = useCallback((pos: GeolocationPosition) => {
    if (!mountedRef.current) return;

    const rawLat = pos.coords.latitude;
    const rawLon = pos.coords.longitude;
    const acc    = pos.coords.accuracy;
    const tsMs   = pos.timestamp || Date.now();

    // 1. Validate coordinates.
    if (!isValidCoord(rawLat, rawLon)) {
      rejectedRef.current++;
      logWarn(TELE, "invalid_coord_reject", { rawLat, rawLon }, traceRef.current);
      return;
    }

    safe(setError, null as string | null);
    safe(setPermission, "granted" as const);
    safe(setState, "tracking" as LiveLocationState);

    // 2. Hard accuracy reject.
    if (acc && acc > ACCURACY_HARD_REJECT_M) {
      rejectedRef.current++;
      logWarn(TELE, "low_accuracy_skip", { acc }, traceRef.current);
      return;
    }

    const prevSmoothed = lastFixRef.current;
    const prevRaw      = lastRawRef.current;
    const rawMovedM    = prevSmoothed ? distanceMeters(prevSmoothed, { latitude: rawLat, longitude: rawLon }) : Infinity;

    // 3. Soft accuracy reject when movement is also small (drift suppression).
    if (acc && acc > ACCURACY_SOFT_M && rawMovedM < SMALL_MOVEMENT_M && prevSmoothed) {
      rejectedRef.current++;
      logWarn(TELE, "soft_drift_reject", { acc, rawMovedM }, traceRef.current);
      return;
    }

    // 4. Implied-speed sanity (impossible jump for elapsed time).
    if (prevRaw) {
      const dtSec = Math.max(0.001, (tsMs - prevRaw.ts) / 1000);
      const distM = distanceMeters({ latitude: prevRaw.lat, longitude: prevRaw.lon }, { latitude: rawLat, longitude: rawLon });
      const kmh   = (distM / 1000) / (dtSec / 3600);
      if (kmh > MAX_SPEED_KMH) {
        rejectedRef.current++;
        logWarn(TELE, "speed_jump_reject", { kmh: Math.round(kmh), distM, dtSec }, traceRef.current);
        return;
      }
    }
    lastRawRef.current = { lat: rawLat, lon: rawLon, ts: tsMs };

    // 5. Smoothing: blend with previous smoothed fix.
    let smLat = rawLat;
    let smLon = rawLon;
    if (prevSmoothed) {
      smLat = prevSmoothed.latitude  * SMOOTH_ALPHA_PREV + rawLat * SMOOTH_ALPHA_NEXT;
      smLon = prevSmoothed.longitude * SMOOTH_ALPHA_PREV + rawLon * SMOOTH_ALPHA_NEXT;
      smoothedRef.current++;
    }

    if (typeof acc === "number") {
      accSamplesRef.current.push(acc);
      if (accSamplesRef.current.length > 50) accSamplesRef.current.shift();
    }

    const next: LiveLocationData = {
      latitude:   smLat,
      longitude:  smLon,
      accuracy:   acc,
      heading:    pos.coords.heading,
      speed:      pos.coords.speed,
      updated_at: new Date(tsMs).toISOString(),
    };

    const movedSmM = prevSmoothed ? distanceMeters(prevSmoothed, next) : Infinity;
    const now = Date.now();

    // Local state update (drives marker animation).
    if (!prevSmoothed || movedSmM > LOCAL_UPDATE_MIN_M) {
      lastFixRef.current = next;
      setLocation(next);
      if (movedSmM > MIN_MOVE_DB_M) lastMoveTsRef.current = now;
    }

    // DB write throttle (distance OR initial OR long idle).
    const last = lastWriteRef.current;
    const dueTime = !last || (now - last.ts >= MIN_WRITE_INTERVAL);
    const dueDist = !last || movedSmM >= MIN_MOVE_DB_M;
    if (dueTime && dueDist) {
      lastWriteRef.current = { ts: now, lat: next.latitude, lon: next.longitude };
      void writeLocation(next);
    }
  }, [writeLocation]);

  const onErr = useCallback((err: GeolocationPositionError) => {
    if (!mountedRef.current) return;
    if (err.code === 1) {
      safe(setPermission, "denied" as const);
      safe(setError, "Location access denied.");
      safe(setState, "failed" as LiveLocationState);
      logError(TELE, "permission_denied", err, traceRef.current);
    } else if (err.code === 2) {
      reconnectRef.current++;
      safe(setError, "Location unavailable.");
      safe(setState, "reconnecting" as LiveLocationState);
      logWarn(TELE, "position_unavailable", err, traceRef.current);
    } else {
      reconnectRef.current++;
      safe(setError, "Location timed out.");
      safe(setState, "reconnecting" as LiveLocationState);
      logWarn(TELE, "position_timeout", err, traceRef.current);
    }
  }, []);

  /**
   * `@capacitor/geolocation`'s native error shape doesn't carry the web
   * API's numeric `.code` (1 = denied / 2 = unavailable / 3 = timeout) — it
   * gives a `{ message }` string instead. Best-effort map back onto the
   * same shape `onErr` already handles, by matching the (small, stable)
   * set of messages the plugin actually produces, so both platforms share
   * one error-handling path instead of forking the whole state machine.
   */
  const normalizeNativeErr = (err: unknown): GeolocationPositionError => {
    const message = (err as { message?: string })?.message?.toLowerCase() ?? "";
    const code = message.includes("denied") || message.includes("permission") ? 1
      : message.includes("unavailable") || message.includes("disabled") ? 2
      : 3;
    return { code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError;
  };

  const startWatcher = useCallback((eco: boolean) => {
    stopWatcher("restart");
    ecoRef.current = eco;
    const generation = ++watchGenerationRef.current;
    safe(setState, "tracking" as LiveLocationState);
    logInfo(TELE, "tracking_started", { mode: eco ? "eco" : "high" }, traceRef.current);

    if (Capacitor.isNativePlatform()) {
      // Native path — see the header comment for why this uses the
      // Capacitor plugin instead of navigator.geolocation on-device.
      const opts: CapPositionOptions = eco ? ECO_OPTS : HIGH_OPTS;
      Geolocation.watchPosition(opts, (position, err) => {
        if (err) { onErr(normalizeNativeErr(err)); return; }
        if (position) onPos(position as unknown as GeolocationPosition);
      })
        .then((id) => {
          if (watchGenerationRef.current !== generation) {
            // Superseded before this resolved — clear it immediately
            // rather than leaving an orphaned native watcher running.
            void Geolocation.clearWatch({ id }).catch(() => { /* ignore */ });
            return;
          }
          watchIdRef.current = id;
        })
        .catch((err) => {
          logError(TELE, "watcher_start_threw", err, traceRef.current);
          safe(setState, "failed" as LiveLocationState);
        });
      return;
    }

    // Web fallback — unchanged from before.
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      safe(setError, "Geolocation not supported");
      safe(setState, "failed" as LiveLocationState);
      return;
    }
    try {
      watchIdRef.current = navigator.geolocation.watchPosition(
        onPos, onErr, eco ? ECO_OPTS : HIGH_OPTS,
      );
    } catch (err) {
      logError(TELE, "watcher_start_threw", err, traceRef.current);
      safe(setState, "failed" as LiveLocationState);
    }
  }, [onPos, onErr, stopWatcher]);

  // ── Permissions probe (and reactive revocation) ────────────────────────────
  useEffect(() => {
    // Native: no live "onchange" push API like the web Permissions API
    // below, so this checks once up front — actual revocation mid-session
    // still surfaces correctly via onErr's permission-denied path the next
    // time a fix/error comes through the watcher.
    if (Capacitor.isNativePlatform()) {
      let cancelled = false;
      Geolocation.checkPermissions()
        .then((status) => { if (!cancelled) setPermission(status.location as typeof permission); })
        .catch(() => { /* unsupported, not fatal */ });
      return () => { cancelled = true; };
    }
    if (typeof navigator === "undefined" || !("permissions" in navigator)) return;
    let cancelled = false;
    let status: PermissionStatus | null = null;
    (async () => {
      try {
        status = await navigator.permissions.query({ name: "geolocation" as PermissionName });
        if (cancelled || !status) return;
        setPermission(status.state as typeof permission);
        status.onchange = () => {
          if (!status || !mountedRef.current) return;
          setPermission(status.state as typeof permission);
          if (status.state === "denied") {
            stopWatcher("permission_revoked");
            setState("failed");
            setError("Location access denied.");
          }
        };
      } catch { /* unsupported, not fatal */ }
    })();
    return () => {
      cancelled = true;
      if (status) status.onchange = null;
    };
  }, [stopWatcher, permission]);

  // ── Main lifecycle ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!userId || !enabled) {
      stopWatcher("disabled");
      safe(setState, "idle" as LiveLocationState);
      return;
    }
    if (!active) {
      stopWatcher("paused");
      safe(setState, "paused" as LiveLocationState);
      return;
    }
    if (!traceRef.current) traceRef.current = newTraceId("loc");
    safe(setState, "requesting_permission" as LiveLocationState);
    startWatcher(false);
    return () => stopWatcher("effect-cleanup");
  }, [userId, enabled, active, startWatcher, stopWatcher]);

  // ── Adaptive accuracy switch (uses smoothed coords via lastMoveTsRef) ──────
  useEffect(() => {
    if (state !== "tracking") return;
    const id = window.setInterval(() => {
      const idle = Date.now() - lastMoveTsRef.current;
      if (idle > STATIONARY_MS && !ecoRef.current) {
        logInfo(TELE, "watcher_restarted", { mode: "eco" }, traceRef.current);
        startWatcher(true);
      } else if (idle <= STATIONARY_MS && ecoRef.current) {
        logInfo(TELE, "watcher_restarted", { mode: "high" }, traceRef.current);
        startWatcher(false);
      }
    }, MODE_CHECK_INTERVAL);
    return () => window.clearInterval(id);
  }, [state, startWatcher]);

  // AUDIT FIX (Phase 7, Map): MapView's own "permission denied" retry
  // button was calling raw `navigator.geolocation.getCurrentPosition`
  // directly — bypassing the Capacitor plugin this hook uses everywhere
  // else on native (see the header comment for why that split exists at
  // all: WebView's own navigator.geolocation doesn't reliably bridge to
  // the OS permission dialog/runtime permission the way the plugin does).
  // Beyond just calling the wrong API, there was no path back to
  // "tracking" even if permission WAS granted afterward — native has no
  // reactive permission-change push (see the probe effect above), and the
  // existing online/visibility-recovery effect below only retries the
  // watcher on a network `online` event, never on permission having
  // changed. So a person who granted location in system Settings and came
  // back to the app stayed stuck on the denied screen until they happened
  // to lose and regain network. This function is the actual fix — used
  // both by the explicit retry button (via LocationContext) and by the
  // visibility-regain handler below, since "switched to Settings and back"
  // IS a visibility change and is exactly when a grant would have happened.
  const retryPermission = useCallback(async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        const status = await Geolocation.checkPermissions();
        const granted = status.location === "granted";
        const next = granted ? status : await Geolocation.requestPermissions();
        setPermission(next.location as typeof permission);
        if (next.location === "granted" && mountedRef.current) startWatcher(ecoRef.current);
      } catch { /* unsupported, not fatal — matches the probe effect's own handling */ }
      return;
    }
    // Web: same one-shot prompt-trigger the old button used, kept as-is —
    // the web Permissions API's own `onchange` listener (probe effect
    // above) already handles resuming the watcher once granted, so no
    // explicit startWatcher call is needed on this branch.
    if (!("geolocation" in navigator)) return;
    navigator.geolocation.getCurrentPosition(() => {}, () => {}, { enableHighAccuracy: true });
  }, [startWatcher]);

  // ── Online + visibility recovery (resume watcher + flush queue) ────────────
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onOnline = () => {
      if (!mountedRef.current) return;
      logInfo(TELE, "online_reconnect", undefined, traceRef.current);
      if (enabled && active && state !== "tracking") startWatcher(ecoRef.current);
      void flushQueueIfAny();
    };
    const onVis = () => {
      if (document.hidden) return;
      void flushQueueIfAny();
      // Native only — see retryPermission's comment above for why this is
      // the natural place to self-heal a Settings-granted permission
      // without requiring the person to also tap the retry button.
      if (Capacitor.isNativePlatform() && (state === "failed" || permission === "denied")) {
        void retryPermission();
      }
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVis);
    // Opportunistic flush on mount.
    void flushQueueIfAny();
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, active, state, permission, startWatcher, flushQueueIfAny, retryPermission]);

  // ── Publish debug snapshot periodically. live.debug.queueDepth also feeds
  // an always-visible "queued N" chip (not just the hidden debug overlay),
  // so this can't be skipped outright — but ticking every 5s regardless of
  // whether anyone's looking at the full debug panel was causing the
  // consuming screen (a Leaflet map + a lot of JSX) to re-render every 5s
  // during ordinary use, which is exactly the kind of background churn that
  // shows up as "laggy" on lower-end devices. Slow the cadence when the
  // debug overlay is closed; speed back up while it's open for live
  // diagnostics. ──────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      if (cancelled || !mountedRef.current) return;
      const depth = await getQueueDepth();
      const samples = accSamplesRef.current;
      const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
      setDebug({
        mode: ecoRef.current ? "eco" : "high",
        watcherActive: watchIdRef.current !== null,
        queueDepth: depth,
        lastHeartbeatAt: lastHeartbeatRef.current,
        avgAccuracy: avg,
        rejectedFixCount: rejectedRef.current,
        smoothingAppliedCount: smoothedRef.current,
        reconnectAttempts: reconnectRef.current,
        lastDbWriteAt: lastDbWriteRef.current,
        batteryLevel: batteryRef.current,
      });
    };
    void tick();
    const id = window.setInterval(tick, debugEnabled ? 5_000 : 20_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [debugEnabled]);

  return { state, location, error, permission, debug, flushQueueIfAny, retryPermission };
}
