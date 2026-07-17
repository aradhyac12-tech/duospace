import PageHeader from "@/components/PageHeader";
import { motion } from "framer-motion";
import { MapPin, Navigation, AlertCircle, Layers, Radio, MousePointerClick, Maximize2, Minimize2, Crosshair, WifiOff, X } from "lucide-react";
import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import { hapticLight } from "@/lib/haptics";
import { useLiveLocation } from "@/hooks/useLiveLocation";
import { logInfo, logWarn } from "@/lib/telemetry";
import "leaflet/dist/leaflet.css";

/** Watchdog: if no realtime payload in this window, fall back to polling. */
const REALTIME_WATCHDOG_MS = 45_000;
/** Poll interval used while in fallback mode. */
const POLL_INTERVAL_MS     = 15_000;
/** Heartbeat considered stale beyond this. */
const HEARTBEAT_STALE_MS   = 90_000;

const haversineKm = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

interface PartnerLocation {
  latitude: number;
  longitude: number;
  updated_at: string;
}

type MapStyle = "street" | "satellite" | "voyager";

const MAP_TILES: Record<MapStyle, { url: string; name: string }> = {
  street:    { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", name: "Street" },
  satellite: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", name: "Satellite" },
  voyager:   { url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", name: "Voyager" },
};

/** How long after a user pan/zoom before auto-recenter is allowed again. */
const USER_GESTURE_LOCK_MS = 8000;
/** Peer location considered "stale" after this many ms. */
const STALE_PEER_MS = 2 * 60_000;

const MapView = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [partnerLocation, setPartnerLocation] = useState<PartnerLocation | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [partnerName, setPartnerName] = useState("Partner");
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapStyle, setMapStyle] = useState<MapStyle>("street");
  const [initialZoomDone, setInitialZoomDone] = useState(false);
  const [locationMode, setLocationMode] = useState<"persistent" | "on_open">("on_open");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [pageVisible, setPageVisible] = useState<boolean>(typeof document === "undefined" ? true : !document.hidden);
  const [online, setOnline] = useState<boolean>(typeof navigator === "undefined" ? true : navigator.onLine);
  const [now, setNow] = useState(Date.now()); // ticker for "X min ago" + stale UI
  const [realtimeOk, setRealtimeOk] = useState(true);
  const [transportMode, setTransportMode] = useState<"realtime" | "polling">("realtime");
  const [partnerPresence, setPartnerPresence] = useState<{ last_seen_at: string | null; tracking_state: string | null } | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const chipTapRef = useRef<{ count: number; last: number }>({ count: 0, last: 0 });

  const mapRef         = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const tileLayerRef   = useRef<any>(null);
  const myMarkerRef    = useRef<any>(null);
  const partnerMarkerRef = useRef<any>(null);
  const lineRef        = useRef<any>(null);
  /** Last time we received any partner payload (realtime or poll). */
  const lastPayloadAtRef = useRef<number>(Date.now());

  // Marker animation state — keyed by ref so they don't trigger rerenders.
  const myAnimRef      = useRef<{ raf: number | null; from: [number, number] | null; to: [number, number] | null; start: number }>({ raf: null, from: null, to: null, start: 0 });
  const partnerAnimRef = useRef<{ raf: number | null; from: [number, number] | null; to: [number, number] | null; start: number }>({ raf: null, from: null, to: null, start: 0 });

  // User-gesture suppression: if the user pans/zooms, do not auto-recenter for a bit.
  const userInteractedAtRef = useRef<number>(0);

  // Tick "X min ago" + stale detector once per 30s.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Page visibility + online/offline tracking.
  useEffect(() => {
    const onVis = () => setPageVisible(!document.hidden);
    const onOnline  = () => setOnline(true);
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

  // ─── Live location engine ────────────────────────────────────────────────
  const sharingActive = locationMode === "persistent" || pageVisible;
  const live = useLiveLocation({
    userId: user?.id ?? null,
    enabled: !!user,
    active: sharingActive,
  });
  const myLocation = live.location;
  const locationError = live.error;
  const permissionState = live.permission;

  // Fetch partner + persisted location mode
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    supabase.from("profiles").select("partner_id, location_mode").eq("user_id", user.id).single()
      .then(({ data }) => {
        if (cancelled || !data) return;
        if (data.partner_id) {
          setPartnerId(data.partner_id);
          supabase.from("profiles").select("display_name").eq("user_id", data.partner_id).single()
            .then(({ data: pp }) => { if (!cancelled && pp) setPartnerName(pp.display_name); });
        }
        if (data.location_mode) setLocationMode(data.location_mode as "persistent" | "on_open");
      });
    return () => { cancelled = true; };
  }, [user]);

  // ─── Partner location: initial fetch + realtime subscription with retry ──
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
        .select("last_seen_at, tracking_state")
        .eq("user_id", partnerId)
        .maybeSingle();
      if (!cancelled && data) setPartnerPresence(data as any);
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

  // Re-fetch partner location + presence when coming back online or tab regains focus.
  useEffect(() => {
    if (!partnerId) return;
    if (!pageVisible || !online) return;
    supabase.from("locations").select("user_id,latitude,longitude,updated_at").eq("user_id", partnerId).maybeSingle()
      .then(({ data }) => {
        if (data) { setPartnerLocation(data as PartnerLocation); lastPayloadAtRef.current = Date.now(); }
      });
    supabase.from("profiles").select("last_seen_at, tracking_state").eq("user_id", partnerId).maybeSingle()
      .then(({ data }) => { if (data) setPartnerPresence(data as any); });
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
          .from("profiles").select("last_seen_at, tracking_state").eq("user_id", partnerId).maybeSingle();
        if (prof) setPartnerPresence(prof as any);
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

  // Distance (memoized)
  const distanceKm = useMemo(() => {
    if (!myLocation || !partnerLocation) return null;
    return haversineKm(myLocation.latitude, myLocation.longitude, partnerLocation.latitude, partnerLocation.longitude);
  }, [myLocation, partnerLocation]);

  // Stale considers BOTH location updated_at and partner heartbeat (last_seen_at).
  const partnerLocAge = partnerLocation ? now - new Date(partnerLocation.updated_at).getTime() : Infinity;
  const partnerHbAge  = partnerPresence?.last_seen_at ? now - new Date(partnerPresence.last_seen_at).getTime() : Infinity;
  const partnerStale  = !!partnerLocation && partnerLocAge > STALE_PEER_MS && partnerHbAge > HEARTBEAT_STALE_MS;
  useEffect(() => {
    if (partnerStale) logWarn("liveLocation", "stale_peer", { loc_ms: partnerLocAge, hb_ms: partnerHbAge });
  }, [partnerStale]); // eslint-disable-line react-hooks/exhaustive-deps

  // 5-tap on status chip toggles debug overlay.
  const handleChipTap = useCallback(() => {
    const t = chipTapRef.current;
    const now2 = Date.now();
    if (now2 - t.last > 1500) t.count = 0;
    t.count += 1; t.last = now2;
    if (t.count >= 5) { t.count = 0; setDebugOpen((v) => !v); hapticLight(); }
  }, []);


  // ─── Map init ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapLoaded) return;
    let cancelled = false;
    import("leaflet").then((L) => {
      if (cancelled || !mapRef.current) return;
      const map = L.map(mapRef.current, {
        zoomControl: false,
        attributionControl: false,
        minZoom: 3,
        maxZoom: 19,
      }).setView([20, 0], 3);

      tileLayerRef.current = L.tileLayer(MAP_TILES[mapStyle].url, { maxZoom: 19 }).addTo(map);
      L.control.attribution({ position: "bottomright", prefix: false }).addAttribution("© OSM").addTo(map);
      L.control.zoom({ position: "bottomright" }).addTo(map);

      // Suppress auto-recenter for a window after any user interaction.
      const markGesture = () => { userInteractedAtRef.current = Date.now(); };
      map.on("dragstart", markGesture);
      map.on("zoomstart", markGesture);
      map.on("movestart", markGesture);

      mapInstanceRef.current = map;
      setMapLoaded(true);
    });
    return () => {
      cancelled = true;
      // Cancel any pending marker animations before disposing the map.
      if (myAnimRef.current.raf) cancelAnimationFrame(myAnimRef.current.raf);
      if (partnerAnimRef.current.raf) cancelAnimationFrame(partnerAnimRef.current.raf);
      try { mapInstanceRef.current?.remove(); } catch { /* ignore */ }
      mapInstanceRef.current = null;
      myMarkerRef.current = null;
      partnerMarkerRef.current = null;
      lineRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Switch tiles
  useEffect(() => {
    if (!mapInstanceRef.current || !tileLayerRef.current) return;
    import("leaflet").then((L) => {
      tileLayerRef.current.remove();
      tileLayerRef.current = L.tileLayer(MAP_TILES[mapStyle].url, { maxZoom: 19 }).addTo(mapInstanceRef.current);
    });
  }, [mapStyle]);

  // ─── Marker create + smooth animation ────────────────────────────────────
  const createIcon = useCallback((L: any, emoji: string, label: string, color: string, stale = false) => L.divIcon({
    html: `<div style="display:flex;flex-direction:column;align-items:center">
      <div style="background:${color};width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;border:3px solid white;box-shadow:0 2px 12px rgba(0,0,0,0.25);${stale ? "opacity:0.55;filter:grayscale(0.4)" : ""}">${emoji}</div>
      <div style="background:white;padding:2px 8px;border-radius:8px;margin-top:4px;font-size:11px;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,0.15);white-space:nowrap">${label}${stale ? " · stale" : ""}</div>
    </div>`,
    iconSize: [60, 60],
    iconAnchor: [30, 20],
    className: "",
  }), []);

  const animateMarker = useCallback((
    marker: any,
    animState: { raf: number | null; from: [number, number] | null; to: [number, number] | null; start: number },
    target: [number, number],
    durationMs: number,
  ) => {
    if (animState.raf) cancelAnimationFrame(animState.raf);
    const start = marker.getLatLng();
    animState.from = [start.lat, start.lng];
    animState.to = target;
    animState.start = performance.now();

    const tick = (t: number) => {
      const elapsed = t - animState.start;
      const k = Math.min(1, elapsed / durationMs);
      const ease = 1 - Math.pow(1 - k, 3); // easeOutCubic
      if (!animState.from || !animState.to) return;
      const lat = animState.from[0] + (animState.to[0] - animState.from[0]) * ease;
      const lng = animState.from[1] + (animState.to[1] - animState.from[1]) * ease;
      try { marker.setLatLng([lat, lng]); } catch { /* marker may be gone */ }
      if (k < 1) {
        animState.raf = requestAnimationFrame(tick);
      } else {
        animState.raf = null;
      }
    };
    animState.raf = requestAnimationFrame(tick);
  }, []);

  // My marker
  useEffect(() => {
    if (!mapInstanceRef.current || !mapLoaded || !myLocation) return;
    let alive = true;
    import("leaflet").then((L) => {
      if (!alive || !mapInstanceRef.current) return;
      const target: [number, number] = [myLocation.latitude, myLocation.longitude];
      if (!myMarkerRef.current) {
        myMarkerRef.current = L.marker(target, {
          icon: createIcon(L, "📍", "You", "hsl(220, 90%, 56%)"),
        }).addTo(mapInstanceRef.current);
      } else {
        animateMarker(myMarkerRef.current, myAnimRef.current, target, 700);
      }
    });
    return () => { alive = false; };
  }, [myLocation, mapLoaded, createIcon, animateMarker]);

  // Partner marker (with stale styling)
  useEffect(() => {
    if (!mapInstanceRef.current || !mapLoaded || !partnerLocation) return;
    let alive = true;
    import("leaflet").then((L) => {
      if (!alive || !mapInstanceRef.current) return;
      const target: [number, number] = [partnerLocation.latitude, partnerLocation.longitude];
      if (!partnerMarkerRef.current) {
        partnerMarkerRef.current = L.marker(target, {
          icon: createIcon(L, "💕", partnerName, "hsl(350, 80%, 60%)", partnerStale),
        }).addTo(mapInstanceRef.current);
      } else {
        partnerMarkerRef.current.setIcon(createIcon(L, "💕", partnerName, "hsl(350, 80%, 60%)", partnerStale));
        animateMarker(partnerMarkerRef.current, partnerAnimRef.current, target, 1000);
      }
    });
    return () => { alive = false; };
  }, [partnerLocation, mapLoaded, partnerName, partnerStale, createIcon, animateMarker]);

  // Connecting line + initial fit
  useEffect(() => {
    if (!mapInstanceRef.current || !mapLoaded) return;
    import("leaflet").then((L) => {
      if (lineRef.current) { try { lineRef.current.remove(); } catch { /* ignore */ } lineRef.current = null; }
      if (myLocation && partnerLocation) {
        lineRef.current = L.polyline(
          [[myLocation.latitude, myLocation.longitude], [partnerLocation.latitude, partnerLocation.longitude]],
          { color: "hsl(350, 80%, 60%)", weight: 2, dashArray: "8, 8", opacity: partnerStale ? 0.3 : 0.6 },
        ).addTo(mapInstanceRef.current);

        if (!initialZoomDone) {
          const bounds = L.latLngBounds([
            [myLocation.latitude, myLocation.longitude],
            [partnerLocation.latitude, partnerLocation.longitude],
          ]);
          mapInstanceRef.current.fitBounds(bounds, { padding: [60, 60], maxZoom: 15 });
          setInitialZoomDone(true);
        }
      } else if (myLocation && !initialZoomDone) {
        mapInstanceRef.current.setView([myLocation.latitude, myLocation.longitude], 16);
        setInitialZoomDone(true);
      }
    });
  }, [myLocation, partnerLocation, mapLoaded, initialZoomDone, partnerStale]);

  // ─── UI helpers ──────────────────────────────────────────────────────────
  const formatDistance = (d: number) => {
    if (d < 1) return `${Math.round(d * 1000)} m`;
    if (d > 100) return `${Math.round(d)} km`;
    return `${d.toFixed(1)} km`;
  };

  const timeAgo = (date: string) => {
    const mins = Math.round((now - new Date(date).getTime()) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const cycleMapStyle = () => {
    const styles: MapStyle[] = ["street", "satellite", "voyager"];
    const idx = styles.indexOf(mapStyle);
    setMapStyle(styles[(idx + 1) % styles.length]);
  };

  const recenter = useCallback(() => {
    hapticLight();
    userInteractedAtRef.current = 0;
    const map = mapInstanceRef.current;
    if (!map) return;
    if (myLocation && partnerLocation) {
      import("leaflet").then((L) => {
        const bounds = L.latLngBounds([
          [myLocation.latitude, myLocation.longitude],
          [partnerLocation.latitude, partnerLocation.longitude],
        ]);
        map.fitBounds(bounds, { padding: [60, 60], maxZoom: 16, animate: true });
      });
    } else if (myLocation) {
      map.setView([myLocation.latitude, myLocation.longitude], Math.max(map.getZoom(), 15), { animate: true });
    }
  }, [myLocation, partnerLocation]);

  const requestLocationPermission = useCallback(() => {
    if (!("geolocation" in navigator)) return;
    // Trigger the prompt via a one-shot read; the watcher will pick up after grant.
    navigator.geolocation.getCurrentPosition(() => {/* prompt accepted */}, () => {/* prompt denied */}, { enableHighAccuracy: true });
  }, []);

  const toggleFullscreen = useCallback(() => {
    hapticLight();
    setIsFullscreen((v) => !v);
  }, []);

  const toggleMapSize = useCallback(() => {
    hapticLight();
    setIsFullscreen((v) => !v);
  }, []);

  // Recompute map size whenever layout changes.
  useEffect(() => {
    if (!mapInstanceRef.current) return;
    const map = mapInstanceRef.current;
    const id = window.setTimeout(() => { try { map.invalidateSize(); } catch { /* noop */ } }, 220);
    return () => window.clearTimeout(id);
  }, [isFullscreen, mapLoaded]);

  // ESC to exit fullscreen + lock body scroll
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setIsFullscreen(false); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [isFullscreen]);

  // Invalidate on resize / orientation
  useEffect(() => {
    const onResize = () => { try { mapInstanceRef.current?.invalidateSize(); } catch { /* noop */ } };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col flex-1 min-h-0">
      <PageHeader title="Map" subtitle="Always close" />

      <div
        className={
          isFullscreen
            ? "fixed inset-0 z-[60] rounded-none border-0 overflow-hidden bg-background"
            : "flex-1 min-h-[55vh] mx-3 mb-3 rounded-2xl border border-border overflow-hidden relative"
        }
        style={isFullscreen ? { paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" } : undefined}
      >
        <div ref={mapRef} className="absolute inset-0" />

        {!isFullscreen && (
          <button
            type="button"
            onClick={toggleMapSize}
            aria-label="Open large map"
            className="absolute inset-0 z-[500] cursor-pointer bg-transparent"
          />
        )}

        {/* Top-right controls */}
        <div
          className="absolute right-3 z-[1000] flex flex-col gap-2"
          style={{ top: isFullscreen ? "calc(env(safe-area-inset-top) + 12px)" : "12px" }}
        >
          <button onClick={(e) => { e.stopPropagation(); cycleMapStyle(); }}
            className="h-10 px-3 rounded-xl bg-card/90 backdrop-blur-sm border border-border shadow-sm flex items-center gap-2 text-xs font-medium">
            <Layers className="h-4 w-4" />
            {MAP_TILES[mapStyle].name}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
            aria-label={isFullscreen ? "Minimize map" : "Expand map"}
            className="h-10 w-10 rounded-xl bg-card/90 backdrop-blur-sm border border-border shadow-sm flex items-center justify-center self-end"
          >
            {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>

        {/* Status chips (top-left) */}
        <div
          className="absolute left-3 z-[1000] flex flex-col gap-2 items-start"
          style={{ top: isFullscreen ? "calc(env(safe-area-inset-top) + 12px)" : "12px" }}
        >
          {!online && (
            <span className="px-2.5 py-1 rounded-full bg-card/90 backdrop-blur-sm border border-border text-[10px] font-medium flex items-center gap-1">
              <WifiOff className="h-3 w-3" /> Offline
            </span>
          )}
          {!realtimeOk && online && (
            <span className="px-2.5 py-1 rounded-full bg-card/90 backdrop-blur-sm border border-border text-[10px] font-medium">
              Reconnecting…
            </span>
          )}
          {partnerStale && partnerLocation && (
            <span className="px-2.5 py-1 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 border border-amber-500/30 text-[10px] font-medium">
              {partnerName}'s location is stale
            </span>
          )}
          <button
            onClick={handleChipTap}
            className="px-2.5 py-1 rounded-full bg-card/90 backdrop-blur-sm border border-border text-[10px] font-medium"
            aria-label="Transport status"
          >
            {transportMode === "realtime" ? "Realtime" : "Fallback sync"}
            {live.debug.queueDepth > 0 ? ` · queued ${live.debug.queueDepth}` : ""}
          </button>
        </div>

        {/* Debug overlay (5-tap on transport chip) */}
        {debugOpen && (
          <div className="absolute inset-x-3 z-[1001] rounded-xl bg-card/95 backdrop-blur border border-border p-3 text-[10px] font-mono space-y-0.5"
               style={{ top: isFullscreen ? "calc(env(safe-area-inset-top) + 60px)" : "60px" }}>
            <div className="flex items-center justify-between mb-1">
              <p className="font-semibold">Live-location debug</p>
              <button onClick={() => setDebugOpen(false)} aria-label="Close debug"><X className="h-3 w-3" /></button>
            </div>
            <div>state: {live.state} · mode: {live.debug.mode} · watcher: {live.debug.watcherActive ? "on" : "off"}</div>
            <div>transport: {transportMode} · realtime: {realtimeOk ? "ok" : "down"} · online: {online ? "yes" : "no"}</div>
            <div>queue: {live.debug.queueDepth} · rejected: {live.debug.rejectedFixCount} · smoothed: {live.debug.smoothingAppliedCount}</div>
            <div>avg acc: {live.debug.avgAccuracy ? `${live.debug.avgAccuracy.toFixed(1)}m` : "—"} · reconnects: {live.debug.reconnectAttempts}</div>
            <div>last hb: {live.debug.lastHeartbeatAt ? `${Math.round((now - live.debug.lastHeartbeatAt)/1000)}s ago` : "—"} · last db write: {live.debug.lastDbWriteAt ? `${Math.round((now - live.debug.lastDbWriteAt)/1000)}s ago` : "—"}</div>
            <div>battery: {live.debug.batteryLevel != null ? `${Math.round(live.debug.batteryLevel * 100)}%` : "n/a"}</div>
            <div>partner hb: {partnerPresence?.last_seen_at ? `${Math.round(partnerHbAge/1000)}s ago` : "—"} · state: {partnerPresence?.tracking_state ?? "—"}</div>
          </div>
        )}

        {/* Recenter FAB — always available when we have a fix */}
        {myLocation && (
          <button
            onClick={(e) => { e.stopPropagation(); recenter(); }}
            aria-label="Recenter map"
            className="absolute right-3 z-[1000] h-12 w-12 rounded-full bg-foreground text-background shadow-lg flex items-center justify-center active:scale-95 transition-transform"
            style={{ bottom: isFullscreen ? "calc(env(safe-area-inset-bottom) + 16px)" : "16px" }}
          >
            <Crosshair className="h-5 w-5" />
          </button>
        )}

        {(locationError || permissionState === "denied") && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm z-[1000]">
            <div className="text-center space-y-3 px-6">
              <div className="h-16 w-16 rounded-full bg-destructive/10 mx-auto flex items-center justify-center">
                <AlertCircle className="h-7 w-7 text-destructive" />
              </div>
              <p className="text-sm font-medium">Location Access Required</p>
              <p className="text-xs text-muted-foreground max-w-xs">{locationError ?? "Enable location in your browser settings."}</p>
              <button onClick={(e) => { e.stopPropagation(); requestLocationPermission(); }} className="bg-foreground text-background text-sm px-5 py-2.5 rounded-xl">
                Request Permission
              </button>
            </div>
          </div>
        )}

        {!myLocation && !locationError && permissionState !== "denied" && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm z-[1000]">
            <div className="text-center space-y-3">
              <div className="h-16 w-16 rounded-full bg-accent mx-auto flex items-center justify-center animate-pulse">
                <MapPin className="h-7 w-7 text-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">Getting your location...</p>
            </div>
          </div>
        )}
      </div>

      <div className="px-5 pb-24 space-y-3">
        {/* Location mode toggle */}
        <div className="bg-card rounded-2xl border border-border p-4 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-xs font-medium">Location Sharing Mode</p>
              <p className="text-[10px] text-muted-foreground">
                {locationMode === "persistent" ? "Always sharing in background" : "Share only when app is open"}
              </p>
            </div>
            <Switch
              checked={locationMode === "persistent"}
              onCheckedChange={(val) => {
                hapticLight();
                const mode = val ? "persistent" : "on_open";
                setLocationMode(mode);
                if (user) {
                  supabase.from("profiles").update({ location_mode: mode } as any).eq("user_id", user.id);
                }
                toast({ title: val ? "Persistent sharing on" : "Sharing only when open" });
              }}
            />
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {locationMode === "persistent" ? <Radio className="h-3 w-3 text-primary" /> : <MousePointerClick className="h-3 w-3" />}
            <span>
              {locationMode === "persistent"
                ? "Background GPS active"
                : sharingActive ? "GPS active while app is open" : "Paused — tab is in the background"}
            </span>
          </div>
        </div>

        <div className="bg-card rounded-2xl border border-border p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Distance apart</p>
              <p className="text-3xl font-serif mt-1">{distanceKm !== null ? formatDistance(distanceKm) : "—"}</p>
              {partnerLocation && (
                <p className="text-[10px] text-muted-foreground mt-1">
                  {partnerName} • {timeAgo(partnerLocation.updated_at)}
                  {partnerStale && <span className="ml-1 text-amber-600 dark:text-amber-400">· stale</span>}
                </p>
              )}
              {!partnerId && <p className="text-[10px] text-muted-foreground mt-1">Link with partner in Settings</p>}
            </div>
            <button onClick={recenter} className="h-11 w-11 rounded-xl bg-foreground flex items-center justify-center" aria-label="Recenter">
              <Navigation className="h-5 w-5 text-background" />
            </button>
          </div>
        </div>

        {myLocation && (
          <div className="bg-card rounded-xl border border-border p-3 flex items-center gap-3">
            <div className={`h-2 w-2 rounded-full ${live.state === "tracking" ? "bg-primary animate-pulse" : live.state === "paused" ? "bg-muted-foreground" : "bg-amber-500 animate-pulse"}`} />
            <p className="text-[11px] text-muted-foreground">
              {live.state === "tracking" && `Live • ${myLocation.latitude.toFixed(4)}, ${myLocation.longitude.toFixed(4)}`}
              {live.state === "paused" && "Paused — sharing only when app is open"}
              {live.state === "reconnecting" && "Reconnecting to GPS…"}
              {live.state === "requesting_permission" && "Requesting permission…"}
              {live.state === "failed" && (locationError ?? "Location unavailable")}
              {live.state === "idle" && "Idle"}
            </p>
          </div>
        )}
      </div>
    </motion.div>
  );
};

export default MapView;
