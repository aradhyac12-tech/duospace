import { createContext, useContext, useEffect, useState, useRef, useMemo, ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useLiveLocation, type LiveLocationData, type LiveLocationState, type LiveDebug } from "@/hooks/useLiveLocation";
import { usePublishDeviceStatus } from "@/hooks/useDeviceStatus";
import { DuospaceBackgroundGeolocation, type BackgroundFix } from "duospace-background-geolocation";
import { enqueueLocation } from "@/lib/locationQueue";
import { logInfo, logWarn } from "@/lib/telemetry";

/**
 * LocationContext — moves live-location publishing + partner-location
 * fetch/subscribe out of MapView.tsx and up to app-root, mounted once
 * alongside CallProvider (see App.tsx / ProtectedRoutes).
 *
 * WHY THIS EXISTS (real gap, not a refactor for its own sake): both
 * `useLiveLocation` (publishes MY position) and the partner-location
 * realtime subscription used to live entirely inside MapView.tsx's own
 * `useEffect`s. That meant location sharing was only active while the Map
 * page itself was mounted — the moment you navigated to Chat, or an
 * incoming call came in and pushed you onto the call screen, or the app
 * was simply on any other tab when a push notification arrived, BOTH
 * directions of location sharing silently stopped: you stopped publishing
 * your own position, and you stopped receiving your partner's. The Map
 * page would just show whatever was last fetched until you reopened it.
 *
 * This follows the exact same fix CallContext already applied for
 * `useDailyCall` (see the comment at the top of CallContext.tsx) — create
 * the engine once at a shared root, and let every consumer (currently just
 * MapView, but IncomingCallOverlay/CallContext could read `partnerLocation`
 * too if a future feature wants it) subscribe to the same instance instead
 * of each owning its own.
 *
 * NOTE ON NAMING: the exported hook is `useLocationContext`, not
 * `useLocation` — react-router-dom already exports a `useLocation` hook
 * (current route) that's imported throughout this app (AppLayout,
 * FloatingDock, Settings, etc.); reusing that name here would silently
 * shadow or collide with it wherever both are imported.
 *
 * Mounted inside `<CallProvider>`'s sibling position in ProtectedRoutes —
 * i.e. for the whole authenticated app, not gated by route. Sharing itself
 * is still gated only on being signed in (`sharingActive` below), exactly
 * as Phase 2 established: there is still no user-facing way to pause or
 * disable location/battery/ringer sharing from within this UI.
 *
 * NATIVE BACKGROUND NOTE: mounting this at app-root fixes every
 * *foreground* case (on another in-app screen, ringing-call overlay,
 * notification banner while the app is open). Background coverage (app
 * minimized / screen off, and an immediate fresh fix the instant a call or
 * message push arrives) is handled below via the
 * `duospace-background-geolocation` native plugin — see
 * native/android/DuoSpaceLocationService.kt,
 * native/ios/CallKitManager.swift + BackgroundGeolocationPlugin.swift, and
 * docs/BACKGROUND_LOCATION_NATIVE.md for the full design and its known
 * limitations (it cannot wake the app from a fully OS-killed/never-opened
 * state on an ordinary message push — only a VoIP call push can do that,
 * and only for the call path).
 */

interface PartnerLocation {
  latitude: number;
  longitude: number;
  updated_at: string;
}

interface PartnerDeviceStatus {
  battery_level: number | null;
  battery_charging: boolean | null;
  ringer_mode: "normal" | "vibrate" | "silent" | "unknown" | null;
  device_status_updated_at: string | null;
}

interface PartnerPresence {
  last_seen_at: string | null;
  tracking_state: string | null;
}

/** Watchdog: if no realtime payload in this window, fall back to polling. */
const REALTIME_WATCHDOG_MS = 45_000;
/** Poll interval used while in fallback mode. */
const POLL_INTERVAL_MS = 15_000;
/** Heartbeat considered stale beyond this. */
const HEARTBEAT_STALE_MS = 90_000;
/** Peer location considered "stale" after this many ms. */
const STALE_PEER_MS = 2 * 60_000;
/** Device status considered stale beyond this — same window as location. */
const DEVICE_STATUS_STALE_MS = 5 * 60_000;

interface LocationContextValue {
  partnerId: string | null;
  partnerName: string;
  partnerAvatar: string | null;
  partnerLocation: PartnerLocation | null;
  partnerPresence: PartnerPresence | null;
  partnerDeviceStatus: PartnerDeviceStatus | null;
  partnerStale: boolean;
  deviceStatusStale: boolean;
  realtimeOk: boolean;
  transportMode: "realtime" | "polling";
  now: number;
  online: boolean;
  // (partnerPresence is declared once above — a duplicate declaration here
  // used to make this whole interface fail to compile.)
  /** My own device's live-location engine — same shape useLiveLocation returns. */
  myLocation: LiveLocationData | null;
  myLocationState: LiveLocationState;
  myLocationError: string | null;
  myLocationPermission: "unknown" | "prompt" | "granted" | "denied";
  myLocationDebug: LiveDebug;
  flushLocationQueue: () => Promise<void>;
  /** AUDIT FIX (Phase 7, Map): re-checks/re-requests permission (native) or
   *  re-triggers the browser prompt (web), and resumes the watcher on a
   *  native grant — see retryPermission's own doc comment in
   *  useLiveLocation.ts. Exposed here so MapView's "permission denied"
   *  retry button uses the same platform-correct path the engine itself
   *  does, instead of calling navigator.geolocation directly. */
  retryLocationPermission: () => Promise<void>;
  /** Speeds up the debug-snapshot ticker (5s vs 20s) while the Map's debug
   *  overlay is open — same behavior the old page-local `debugOpen` state
   *  used to drive directly against its own `useLiveLocation()` call. */
  setDebugEnabled: (v: boolean) => void;
}

const LocationContext = createContext<LocationContextValue | null>(null);

export const LocationProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const [partnerLocation, setPartnerLocation] = useState<PartnerLocation | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [partnerName, setPartnerName] = useState("Partner");
  const [partnerAvatar, setPartnerAvatar] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [realtimeOk, setRealtimeOk] = useState(true);
  const [transportMode, setTransportMode] = useState<"realtime" | "polling">("realtime");
  const [partnerPresence, setPartnerPresence] = useState<PartnerPresence | null>(null);
  const [partnerDeviceStatus, setPartnerDeviceStatus] = useState<PartnerDeviceStatus | null>(null);
  const [pageVisible, setPageVisible] = useState<boolean>(typeof document === "undefined" ? true : !document.hidden);
  const [online, setOnline] = useState<boolean>(typeof navigator === "undefined" ? true : navigator.onLine);
  const [debugEnabled, setDebugEnabled] = useState(false);
  const lastPayloadAtRef = useRef<number>(Date.now());

  // Ticker for "X min ago" + stale detection — unchanged cadence from the
  // original MapView implementation.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Page visibility + online/offline tracking (app-wide now, not per-page).
  useEffect(() => {
    const onVis = () => setPageVisible(!document.hidden);
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // ─── My own live location + device status — unconditionally on while
  // signed in (Phase 2 decision, preserved verbatim: no user-facing way to
  // pause/disable sharing exists in this UI). Previously gated on MapView
  // being mounted; now runs for the whole authenticated session instead —
  // this is the actual fix for "location should update even during a
  // ringing call / while a notification arrives on another screen."
  const sharingActive = true;
  const live = useLiveLocation({
    userId: user?.id ?? null,
    enabled: !!user,
    active: sharingActive,
    debugEnabled,
  });
  usePublishDeviceStatus(user?.id ?? null, !!user && sharingActive);

  // ─── Native background watcher (duospace-background-geolocation) ──────
  // Foreground tracking above (`useLiveLocation`) already covers every case
  // where the WebView surface is still what's rendering — including a
  // ringing call or a notification banner while the app is open (that's
  // what this whole context was created to fix, see the header comment).
  // This is the layer underneath it: a native foreground service
  // (Android) / CLLocationManager background mode (iOS) that keeps
  // producing fixes once the OS has actually suspended the WebView, and
  // that CallNotificationService.kt / CallKitManager.swift can also kick
  // directly — independent of this effect ever having run — the instant a
  // call or message push arrives, even before this provider has mounted.
  //
  // Every fix (from the ongoing watcher OR a native-triggered one-shot,
  // `source` distinguishes them) is written through the exact same
  // Supabase upsert + offline-queue fallback useLiveLocation.ts's own
  // writeLocation() uses — not routed through that hook, since its
  // internal writeLocation isn't exported, but built from the same
  // exported pieces (`supabase`, `enqueueLocation`) so there's one queue
  // and one upsert shape regardless of which layer produced the fix.
  const userIdRef = useRef<string | null>(null);
  useEffect(() => { userIdRef.current = user?.id ?? null; }, [user?.id]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return; // web: navigator.geolocation already covers background well enough, no native layer to start
    if (!user || !sharingActive) {
      void DuospaceBackgroundGeolocation.stop().catch(() => { /* best-effort */ });
      return;
    }

    const writeFix = async (fix: BackgroundFix) => {
      const userId = userIdRef.current;
      if (!userId) return;
      if (!Number.isFinite(fix.latitude) || !Number.isFinite(fix.longitude)) {
        logWarn("backgroundLocation", "invalid_coord_skip", { lat: fix.latitude, lon: fix.longitude });
        return;
      }
      try {
        // `fix.timestamp` (epoch ms, from FusedLocationProviderClient /
        // CoreLocation) is the on-device capture time — send it as
        // `captured_at` so a delayed/cached native fix can never overwrite a
        // fresher foreground fix. See locations_monotonic_write_guard_trg.
        const { error } = await supabase
          .from("locations")
          .upsert(
            { user_id: userId, latitude: fix.latitude, longitude: fix.longitude, captured_at: new Date(fix.timestamp).toISOString() },
            { onConflict: "user_id" },
          );
        if (error) throw error;
        logInfo("backgroundLocation", "native_fix_written", { source: fix.source });
      } catch (err) {
        logWarn("backgroundLocation", "native_fix_write_failed_enqueue", err);
        await enqueueLocation({
          user_id: userId,
          latitude: fix.latitude,
          longitude: fix.longitude,
          captured_at: fix.timestamp,
        });
      }
    };

    const fixSub = DuospaceBackgroundGeolocation.addListener("locationUpdate", (fix) => { void writeFix(fix); });
    const errSub = DuospaceBackgroundGeolocation.addListener("locationError", (err) => {
      logWarn("backgroundLocation", "native_error", err);
    });

    DuospaceBackgroundGeolocation.start().catch((err) => {
      // Best-effort — the foreground `useLiveLocation` engine above keeps
      // running regardless, so a failure to start the background layer
      // (e.g. permission not yet granted) degrades to "foreground-only
      // reliability, same as before this plugin existed" rather than
      // breaking location entirely.
      logWarn("backgroundLocation", "native_start_failed", err);
    });

    return () => {
      void fixSub.then((h) => h.remove()).catch(() => {});
      void errSub.then((h) => h.remove()).catch(() => {});
      // Deliberately NOT calling stop() here on every unmount — this
      // effect's cleanup runs on every user?.id/sharingActive change, not
      // just sign-out, and tearing down the native watcher on every such
      // change (e.g. a partnerId refetch elsewhere re-rendering this
      // provider) would defeat the point of a *background* watcher. It's
      // stopped explicitly above when `!user || !sharingActive`.
    };
  }, [user?.id, sharingActive]);

  // Fetch partner id/name/avatar once signed in.
  useEffect(() => {
    if (!user) { setPartnerId(null); return; }
    let cancelled = false;
    supabase.from("profiles").select("partner_id").eq("user_id", user.id).single()
      .then(({ data }) => {
        if (cancelled || !data) return;
        if (data.partner_id) {
          setPartnerId(data.partner_id);
          supabase.from("profiles").select("display_name,avatar_url").eq("user_id", data.partner_id).single()
            .then(({ data: pp }) => {
              if (cancelled || !pp) return;
              setPartnerName(pp.display_name);
              setPartnerAvatar(pp.avatar_url || null);
            });
        }
      });
    return () => { cancelled = true; };
  }, [user]);

  // ─── Partner location: initial fetch + realtime subscription with retry.
  // Byte-for-byte the same logic MapView.tsx used to own — only the
  // location (this provider, mounted app-wide) changed.
  useEffect(() => {
    if (!partnerId) return;

    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1500;

    const fetchInitial = async () => {
      const { data } = await supabase
        .from("locations")
        .select("user_id,latitude,longitude,updated_at")
        .eq("user_id", partnerId)
        .maybeSingle();
      if (!cancelled && data) {
        setPartnerLocation(data as PartnerLocation);
        lastPayloadAtRef.current = Date.now();
      }
    };

    const fetchPresence = async () => {
      const { data } = await supabase
        .from("profiles")
        .select("last_seen_at, tracking_state, battery_level, battery_charging, ringer_mode, device_status_updated_at")
        .eq("user_id", partnerId)
        .maybeSingle();
      if (!cancelled && data) {
        setPartnerPresence(data as any);
        setPartnerDeviceStatus(data as any);
      }
    };

    const subscribe = () => {
      if (cancelled) return;
      channel = supabase.channel(`partner-location-${partnerId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "locations", filter: `user_id=eq.${partnerId}` },
          (payload) => {
            if (payload.new && (payload.new as any).user_id === partnerId) {
              setPartnerLocation(payload.new as PartnerLocation);
              lastPayloadAtRef.current = Date.now();
              setTransportMode("realtime");
            }
          },
        )
        .on(
          "postgres_changes",
          { event: "UPDATE", schema: "public", table: "profiles", filter: `user_id=eq.${partnerId}` },
          (payload) => {
            const row = payload.new as any;
            if (!row || row.user_id !== partnerId) return;
            setPartnerPresence({ last_seen_at: row.last_seen_at, tracking_state: row.tracking_state });
            setPartnerDeviceStatus({
              battery_level: row.battery_level,
              battery_charging: row.battery_charging,
              ringer_mode: row.ringer_mode,
              device_status_updated_at: row.device_status_updated_at,
            });
            // REALTIME TRANSPORT HEALTH FIX: this used to only be bumped by
            // a `locations` row change (below), which conflated "is the
            // realtime transport alive" with "did the partner's location
            // change" — a stationary partner (no location write for
            // minutes, since writes are distance-gated — see
            // useLiveLocation.ts's MIN_MOVE_DB_M) would incorrectly trip the
            // REALTIME_WATCHDOG_MS fallback and show "Reconnecting…" even
            // though realtime was working fine. The 30s presence heartbeat
            // (useLiveLocation.ts's HEARTBEAT_MS) touches `profiles` on a
            // steady cadence regardless of movement, so counting these
            // payloads too gives a transport-health signal that's actually
            // independent of location freshness — the correct separation
            // section 3 of the brief asks for.
            lastPayloadAtRef.current = Date.now();
          },
        )
        .subscribe((status) => {
          if (cancelled) return;
          if (status === "SUBSCRIBED") {
            setRealtimeOk(true);
            retryDelay = 1500;
            logInfo("liveLocation", "realtime_subscribed");
            void fetchInitial();
            void fetchPresence();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            setRealtimeOk(false);
            logWarn("liveLocation", "realtime_dropped", { status });
            if (channel) { try { supabase.removeChannel(channel); } catch { /* ignore */ } channel = null; }
            retryTimer = setTimeout(subscribe, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30_000);
          }
        });
    };

    void fetchInitial();
    void fetchPresence();
    subscribe();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (channel) { try { supabase.removeChannel(channel); } catch { /* ignore */ } }
    };
  }, [partnerId]);

  // Re-fetch partner location + presence when coming back online or the
  // app regains foreground focus — this is what actually covers "a call
  // rang" or "a notification arrived": the app was foregrounded again
  // (visibilitychange fires) and this refreshes immediately rather than
  // waiting on the realtime channel or the next watchdog cycle.
  useEffect(() => {
    if (!partnerId) return;
    if (!pageVisible || !online) return;
    supabase.from("locations").select("user_id,latitude,longitude,updated_at").eq("user_id", partnerId).maybeSingle()
      .then(({ data }) => {
        if (data) { setPartnerLocation(data as PartnerLocation); lastPayloadAtRef.current = Date.now(); }
      });
    supabase.from("profiles").select("last_seen_at, tracking_state, battery_level, battery_charging, ringer_mode, device_status_updated_at").eq("user_id", partnerId).maybeSingle()
      .then(({ data }) => {
        if (data) {
          setPartnerPresence(data as any);
          setPartnerDeviceStatus(data as any);
        }
      });
  }, [partnerId, pageVisible, online]);

  // ─── Watchdog: realtime ↔ polling fallback ──────────────────────────────
  useEffect(() => {
    if (!partnerId) return;
    let pollTimer: ReturnType<typeof setInterval> | null = null;

    const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
    const startPolling = () => {
      if (pollTimer) return;
      pollTimer = setInterval(async () => {
        const { data } = await supabase
          .from("locations")
          .select("user_id,latitude,longitude,updated_at")
          .eq("user_id", partnerId)
          .maybeSingle();
        if (data) { setPartnerLocation(data as PartnerLocation); lastPayloadAtRef.current = Date.now(); }
        const { data: prof } = await supabase
          .from("profiles").select("last_seen_at, tracking_state, battery_level, battery_charging, ringer_mode, device_status_updated_at").eq("user_id", partnerId).maybeSingle();
        if (prof) {
          setPartnerPresence(prof as any);
          setPartnerDeviceStatus(prof as any);
        }
      }, POLL_INTERVAL_MS);
    };

    const watchdog = setInterval(() => {
      const since = Date.now() - lastPayloadAtRef.current;
      if (since > REALTIME_WATCHDOG_MS && online) {
        if (transportMode !== "polling") {
          setTransportMode("polling");
          logWarn("liveLocation", "watchdog_fallback", { since });
        }
        startPolling();
      } else if (since <= REALTIME_WATCHDOG_MS && transportMode === "polling") {
        setTransportMode("realtime");
        stopPolling();
      }
    }, 5_000);

    return () => { clearInterval(watchdog); stopPolling(); };
  }, [partnerId, online, transportMode]);

  // Stale considers BOTH location updated_at and partner heartbeat (last_seen_at).
  const partnerLocAge = partnerLocation ? now - new Date(partnerLocation.updated_at).getTime() : Infinity;
  const partnerHbAge = partnerPresence?.last_seen_at ? now - new Date(partnerPresence.last_seen_at).getTime() : Infinity;
  const partnerStale = !!partnerLocation && partnerLocAge > STALE_PEER_MS && partnerHbAge > HEARTBEAT_STALE_MS;
  const deviceStatusAge = partnerDeviceStatus?.device_status_updated_at
    ? now - new Date(partnerDeviceStatus.device_status_updated_at).getTime() : Infinity;
  const deviceStatusStale = deviceStatusAge > DEVICE_STATUS_STALE_MS;

  useEffect(() => {
    if (partnerStale) logWarn("liveLocation", "stale_peer", { loc_ms: partnerLocAge, hb_ms: partnerHbAge });
  }, [partnerStale]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo<LocationContextValue>(() => ({
    partnerId,
    partnerName,
    partnerAvatar,
    partnerLocation,
    partnerPresence,
    partnerDeviceStatus,
    partnerStale,
    deviceStatusStale,
    realtimeOk,
    transportMode,
    now,
    online,
    myLocation: live.location,
    myLocationState: live.state,
    myLocationError: live.error,
    myLocationPermission: live.permission,
    myLocationDebug: live.debug,
    flushLocationQueue: live.flushQueueIfAny,
    retryLocationPermission: live.retryPermission,
    setDebugEnabled,
  }), [
    partnerId, partnerName, partnerAvatar, partnerLocation, partnerPresence,
    partnerDeviceStatus, partnerStale, deviceStatusStale, realtimeOk,
    transportMode, now, online, live.location, live.state, live.error, live.permission,
    live.debug, live.flushQueueIfAny, live.retryPermission,
  ]);

  return <LocationContext.Provider value={value}>{children}</LocationContext.Provider>;
};

export const useLocationContext = (): LocationContextValue => {
  const ctx = useContext(LocationContext);
  if (!ctx) throw new Error("useLocationContext must be used within a LocationProvider");
  return ctx;
};
