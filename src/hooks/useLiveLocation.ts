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
 */

import { useCallback, useEffect, useRef, useState } from "react";
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

export function useLiveLocation({ userId, enabled, active }: Options) {
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

  const watchIdRef    = useRef<number | null>(null);
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
    nav.getBattery().then((b: any) => {
      if (cancelled) return;
      battery = b;
      const sync = () => { batteryRef.current = b.level; };
      sync();
      b.addEventListener?.("levelchange", sync);
    }).catch(() => { /* unsupported */ });
    return () => {
      cancelled = true;
      try { battery?.removeEventListener?.("levelchange", () => {}); } catch { /* ignore */ }
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
  const stopWatcher = useCallback((reason: string) => {
    if (watchIdRef.current !== null) {
      try { navigator.geolocation.clearWatch(watchIdRef.current); } catch { /* ignore */ }
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
      const { error: upErr } = await supabase
        .from("locations")
        .upsert(
          { user_id: userId, latitude: loc.latitude, longitude: loc.longitude },
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

  const startWatcher = useCallback((eco: boolean) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      safe(setError, "Geolocation not supported");
      safe(setState, "failed" as LiveLocationState);
      return;
    }
    stopWatcher("restart");
    ecoRef.current = eco;
    safe(setState, "tracking" as LiveLocationState);
    logInfo(TELE, "tracking_started", { mode: eco ? "eco" : "high" }, traceRef.current);
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
      if (!document.hidden) void flushQueueIfAny();
    };
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVis);
    // Opportunistic flush on mount.
    void flushQueueIfAny();
    return () => {
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [enabled, active, state, startWatcher, flushQueueIfAny]);

  // ── Publish debug snapshot every 5s (cheap, low-rerender) ─────────────────
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
    const id = window.setInterval(tick, 5_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  return { state, location, error, permission, debug, flushQueueIfAny };
}
