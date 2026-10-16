import { motion, AnimatePresence } from "framer-motion";
import { MapPin, Navigation, AlertCircle, Layers, Maximize2, Minimize2, Crosshair, WifiOff, X, BatteryFull, BatteryMedium, BatteryLow, BatteryWarning, BatteryCharging, Bell, BellOff, Vibrate, ChevronUp, ChevronLeft, Plus, Minus } from "lucide-react";
import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Capacitor } from "@capacitor/core";
import { useLocationContext } from "@/contexts/LocationContext";
import { useErrorManager } from "@/lib/errors/useErrorManager";
import { gentleSpring, standardTransition, snapTransition } from "@/lib/motion";
import "leaflet/dist/leaflet.css";

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
  /** Present on OUR OWN fix (GPS accuracy radius in metres); the partner's
   *  row in `locations` does not carry it. */
  accuracy?: number;
  /** Partner's fix accuracy (m) from the `locations` row; null on older writers. */
  accuracy_m?: number | null;
}

/** Leaflet is loaded once and cached, so every marker/line/camera update after
 *  the first runs without another async module hop (that hop was a visible
 *  one-frame lag on each location update). */
let leafletCache: any = null;
const loadLeaflet = (): Promise<any> =>
  leafletCache ? Promise.resolve(leafletCache) : import("leaflet").then((m) => (leafletCache = m));

/** Escape text/URLs that are interpolated into Leaflet divIcon HTML. The
 *  partner's display name and avatar URL are user-controlled; before this they
 *  were injected raw into innerHTML. */
const esc = (v: string) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

interface PartnerDeviceStatus {
  battery_level: number | null;
  battery_charging: boolean | null;
  ringer_mode: "normal" | "vibrate" | "silent" | "unknown" | null;
  device_status_updated_at: string | null;
}

const BatteryIcon = ({ level, charging }: { level: number; charging: boolean | null }) => {
  if (charging) return <BatteryCharging className="h-3.5 w-3.5" aria-hidden="true" />;
  if (level <= 15) return <BatteryWarning className="h-3.5 w-3.5" aria-hidden="true" />;
  if (level <= 45) return <BatteryLow className="h-3.5 w-3.5" aria-hidden="true" />;
  if (level <= 80) return <BatteryMedium className="h-3.5 w-3.5" aria-hidden="true" />;
  return <BatteryFull className="h-3.5 w-3.5" aria-hidden="true" />;
};

/**
 * Small pill showing the partner's battery % and ringer state. Deliberately
 * renders nothing (not an "unknown" placeholder) when there's no data yet,
 * and drops the ringer half entirely when ringerMode is 'unknown' — that's
 * always true for iOS partners (no public API for the mute switch there;
 * see native-plugins/device-status/README.md) so their pill just shows
 * battery alone rather than a bell icon that might be lying. Silent and
 * vibrate get visually distinct icons (Vibrate previously just reused
 * BellOff for both, differing only in an invisible aria-label).
 */
const PartnerStatusPill = ({ status, stale }: { status: PartnerDeviceStatus | null; stale: boolean }) => {
  if (!status || status.battery_level == null) return null;
  const level = Math.round(status.battery_level);
  const showRinger = status.ringer_mode === "normal" || status.ringer_mode === "silent" || status.ringer_mode === "vibrate";
  return (
    <div className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 glass-sheet ${stale ? "opacity-50" : ""}`}>
      <span className={level <= 15 && !status.battery_charging ? "text-destructive" : "text-foreground/80"}>
        <BatteryIcon level={level} charging={status.battery_charging} />
      </span>
      <span className="text-[11px] font-medium tabular-nums">{level}%</span>
      {showRinger && (
        <>
          <span className="h-3 w-px bg-border" aria-hidden="true" />
          {status.ringer_mode === "silent" ? (
            <BellOff className="h-3.5 w-3.5 text-muted-foreground" aria-label="Phone on silent" />
          ) : status.ringer_mode === "vibrate" ? (
            <Vibrate className="h-3.5 w-3.5 text-muted-foreground" aria-label="Phone on vibrate" />
          ) : (
            <Bell className="h-3.5 w-3.5 text-muted-foreground" aria-label="Ringer on" />
          )}
        </>
      )}
      {/* Explicitly "unknown" (not just no data yet) — most commonly an
          iOS partner, where there's no public API for the mute switch.
          Shown faintly rather than silently omitted, so this reads as a
          real platform limit rather than a missing/broken feature. */}
      {status.ringer_mode === "unknown" && (
        <>
          <span className="h-3 w-px bg-border" aria-hidden="true" />
          <span className="text-[10px] text-muted-foreground/60" title="Ringer status isn't available on their device">n/a</span>
        </>
      )}
    </div>
  );
};

type MapStyle = "street" | "satellite" | "voyager";

interface TileConfig {
  url: string;
  /** Used when the primary provider's tiles fail to load (rate-limited,
   *  blocked, or briefly down) so the map degrades to a different basemap
   *  instead of showing blank/grey squares. */
  fallbackUrl?: string;
  name: string;
  attribution: string;
  /** Highest zoom the provider actually has real imagery for. Leaflet
   *  upscales (interpolates) the last real tile past this point up to the
   *  map's own `maxZoom`, so this is what keeps satellite/voyager honest
   *  about detail without hard-capping how far the user can zoom in. */
  maxNativeZoom: number;
  subdomains?: string;
}

/** Zoom ceiling the map itself allows. Kept above every provider's
 *  maxNativeZoom (see below) so "how far can I zoom in" is never limited by
 *  the thinnest provider — Leaflet just upscales past maxNativeZoom instead
 *  of refusing to zoom further. */
const MAX_ZOOM = 21;

const MAP_TILES: Record<MapStyle, TileConfig> = {
  street: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    name: "Street",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxNativeZoom: 19,
    subdomains: "abc",
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    name: "Satellite",
    attribution: "&copy; Esri, Maxar, Earthstar Geographics",
    // World Imagery's global coverage tops out at z19 (many regions are
    // thinner). Was previously requested at maxZoom:19 with no
    // maxNativeZoom set, which is fine at z19 but gave no signal to Leaflet
    // to upscale gracefully once MAX_ZOOM is raised past that.
    // Lowered to 17: z18-19 are "Map data not yet available" placeholders
    // across most non-metro regions — see tileOptionsFor.
    maxNativeZoom: 17,
  },
  voyager: {
    // FIX (this session — "API KEY REQUIRED" on the map): CARTO's free
    // raster basemap endpoint (basemaps.cartocdn.com) started requiring an
    // API key on 28 Aug 2026 and is being retired outright — see
    // https://docs.carto.com/faqs/carto-basemaps ("these are still
    // available, but they now require an API key and are being retired").
    // Unkeyed requests don't fail or 404 (which is what the `fallbackUrl`
    // mechanism below actually listens for via Leaflet's `tileerror`) —
    // CARTO now returns a normal 200 OK tile image with "API KEY REQUIRED"
    // baked into the pixels as a watermark. Leaflet sees a perfectly valid
    // image load, so the existing fallback never triggered; the watermark
    // just silently became the map. That's the literal bug reported.
    //
    // Fix: stop depending on CARTO's raster basemaps at all — they're
    // being sunset regardless, so patching around the watermark (e.g.
    // detecting it after the fact) would just be delaying a second
    // migration. Voyager now uses the same OpenStreetMap standard tiles as
    // "Street" (real, unlimited-look, zero-signup, not-going-away — this is
    // exactly the fix multiple other projects shipped for this same CARTO
    // change). A pure-CSS warm/pastel filter (applied conditionally, see
    // the `.leaflet-tile-pane` rule below) keeps Voyager visually distinct
    // from Street rather than the style-cycle button showing two identical
    // maps back to back — no second tile provider, no key, no account.
    //
    // If you'd rather have CARTO's actual original Voyager cartography
    // back: get a free key (no account needed, ~1 minute) at
    // https://carto.com/basemaps/apikey and hand it to me — I'll wire it
    // back in as `?key=...` on the original basemaps.cartocdn.com URL.
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    name: "Voyager",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxNativeZoom: 19,
    subdomains: "abc",
  },
};

/** Shared tile-layer options for a given style: retina tiles on high-DPI
 *  phone screens (this app is mostly viewed on-device), the provider's real
 *  detail ceiling, and the map-wide zoom ceiling for graceful upscaling
 *  beyond it. */
// FIX ("Map data not yet available" when zooming in): two causes.
//  1. detectRetina: on a high-DPI phone Leaflet adds +1 to every requested
//     zoom (zoomOffset++) but does NOT lower maxNativeZoom, so at the top
//     it asked for z20 — a level OSM doesn't serve and Esri answers with
//     its grey "Map data not yet available" placeholder (a normal 200 OK
//     image, so no tileerror/fallback fires). maxNativeZoom is now reduced
//     by that same offset on retina screens.
//  2. Esri World Imagery only has real z18/z19 imagery in some cities; in
//     most other regions (incl. South Asia) those levels are the same
//     placeholder. Satellite now caps real tiles at z17 and Leaflet
//     smoothly upscales the last real tile from there — so you can keep
//     zooming to the very last step and always see imagery.
const isRetina = typeof window !== "undefined" && (window.devicePixelRatio || 1) > 1;
const tileOptionsFor = (style: MapStyle) => ({
  maxZoom: MAX_ZOOM,
  maxNativeZoom: MAP_TILES[style].maxNativeZoom - (isRetina ? 1 : 0),
  subdomains: MAP_TILES[style].subdomains ?? "abc",
  detectRetina: true,
  // Smooth + fast panning: keep 4 rings of tiles around the view so a fling
  // never reveals blank squares, and don't fetch/paint tiles mid-pinch (only
  // once the zoom settles) — that is what made pinch-zoom stutter.
  keepBuffer: 4,
  updateWhenIdle: false,
  updateWhenZooming: false,
  updateInterval: 120,
  // Never paint a broken-image icon / grey box for a missing tile.
  errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
});

/** How long after a user pan/zoom before auto-recenter is allowed again. */
const USER_GESTURE_LOCK_MS = 8000;

const MapView = () => {
  const navigate = useNavigate();
  const { capture } = useErrorManager("Map");
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapStyle, setMapStyle] = useState<MapStyle>("street");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [statusSheetOpen, setStatusSheetOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const chipTapRef = useRef<{ count: number; last: number }>({ count: 0, last: 0 });
  /** Section 13: recenter FAB is quiet/small while the map is already
   *  centered on the fitted view, and becomes prominent once the user has
   *  panned/zoomed away from it. Driven off the same gesture handlers that
   *  already suppress auto-recenter (dragstart/zoomstart/movestart), plus
   *  cleared whenever we (re)center programmatically. Purely presentational
   *  — does not change any location/fit logic below. */
  const [mapOffCenter, setMapOffCenter] = useState(false);

  // Section 2: fine-grained, event-driven clock for "Updated X ago" — see
  // the comment on `timeAgo` below for why this exists separately from
  // LocationContext's 30s `now`. Ticks every 1s while this page is visible
  // (document not hidden); no interval at all while hidden (per spec:
  // "Map not visible: slow/no ticker") — visibility regain below forces one
  // immediate recompute instead of ticking blind in the background.
  const [tickNow, setTickNow] = useState(() => Date.now());

  const mapRef         = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<any>(null);
  const tileLayerRef   = useRef<any>(null);
  const attributionRef = useRef<any>(null);
  /** Tracks whether the active tile layer has already fallen back to its
   *  backup URL, so repeated tile errors don't loop between the two. */
  const tileFallbackActiveRef = useRef<boolean>(false);
  const myMarkerRef    = useRef<any>(null);
  const partnerMarkerRef = useRef<any>(null);
  const lineRef        = useRef<any>(null);
  /** Translucent GPS-accuracy circle around OUR marker. */
  const accuracyRef    = useRef<any>(null);
  const partnerAccuracyRef = useRef<any>(null);
  /** Camera fit progress: 0 = nothing fitted yet, 1 = fitted on one person,
   *  2 = fitted on both. A ref (not state) so fitting never re-renders. */
  const fitStageRef    = useRef<0 | 1 | 2>(0);
  /** True while WE move the camera, so Leaflet's movestart/zoomstart events
   *  aren't mistaken for a user gesture (which used to lock auto-fit and
   *  light up the recenter button right after every programmatic move). */
  const programmaticMoveRef = useRef(false);
  const programmaticTimerRef = useRef<number | null>(null);

  // Marker animation state — keyed by ref so they don't trigger rerenders.
  const myAnimRef      = useRef<{ raf: number | null; from: [number, number] | null; to: [number, number] | null; start: number }>({ raf: null, from: null, to: null, start: 0 });
  const partnerAnimRef = useRef<{ raf: number | null; from: [number, number] | null; to: [number, number] | null; start: number }>({ raf: null, from: null, to: null, start: 0 });

  // User-gesture suppression: if the user pans/zooms, do not auto-recenter for a bit.
  const userInteractedAtRef = useRef<number>(0);

  /** Refs mirroring current location state, read by the map's `moveend`
   *  listener below (registered once at map-init time, so it can't close
   *  over fresh state directly). */
  const myLocationRef = useRef<PartnerLocation | null>(null);
  const partnerLocationRef = useRef<PartnerLocation | null>(null);

  // ─── Live location + partner data — sourced from LocationContext, which
  // owns the actual useLiveLocation engine + partner fetch/subscribe/
  // watchdog now (mounted app-wide in App.tsx, not gated by this page being
  // open). See src/contexts/LocationContext.tsx's top comment for why: this
  // is what makes location keep updating while a call is ringing or a
  // notification arrives on another screen — those don't unmount this page
  // anymore because this page was never the thing running the engine.
  //
  // Phase 2's product decision (sharing is unconditionally on while signed
  // in, no user-facing pause/off control) lives in the provider now — this
  // page no longer owns that flag, it just reads the result.
  const ctx = useLocationContext();
  const { partnerId, partnerName, partnerAvatar, partnerLocation, partnerDeviceStatus, partnerStale, deviceStatusStale, realtimeOk, transportMode, partnerPresence, now, online } = ctx;  const myLocation = ctx.myLocation;
  const locationError = ctx.myLocationError;
  const locationErrorKind = ctx.myLocationErrorKind;
  const permissionState = ctx.myLocationPermission;
  // TIMEOUT FIX (2026-09-20): the blocking "Location Access Required"
  // screen used to appear for ANY locationError — including a plain
  // "Location timed out." on a device where permission was already granted,
  // with a "Request Permission" button that couldn't fix anything. Only a
  // real permission denial is a permission problem; timeouts/unavailable
  // are transient GPS conditions and get the non-permission "still looking"
  // treatment below instead. See src/lib/locationErrors.ts.
  const permissionBlocked = permissionState === "denied" || locationErrorKind === "denied";
  /** Shim matching the shape the debug sheet/overlay below was written
   *  against when it read a local `useLiveLocation()` return value
   *  directly — now sourced from context instead. */
  const live = { state: ctx.myLocationState, debug: ctx.myLocationDebug };
  const partnerHbAge = partnerPresence?.last_seen_at ? now - new Date(partnerPresence.last_seen_at).getTime() : Infinity;



  // Route the two Map-specific failure modes into the shared error registry
  // for telemetry/consistency with the rest of the app — purely additive,
  // the existing bespoke inline UI below (already correct) is untouched.
  // Captured once per transition, not on every render.
  const lastCapturedRef = useRef<string | null>(null);
  useEffect(() => {
    const signature = permissionState === "denied" ? "denied" : locationError ? `error:${locationError}` : null;
    if (signature === lastCapturedRef.current) return;
    lastCapturedRef.current = signature;
    if (permissionState === "denied") {
      capture("DS-MAP-001", { component: "MapView", action: "permission" });
    } else if (locationError) {
      capture("DS-MAP-002", { component: "MapView", action: "geolocation", cause: locationError });
    }
  }, [permissionState, locationError, capture]);

  // Distance (memoized)
  const distanceKm = useMemo(() => {
    if (!myLocation || !partnerLocation) return null;
    return haversineKm(myLocation.latitude, myLocation.longitude, partnerLocation.latitude, partnerLocation.longitude);
  }, [myLocation, partnerLocation]);

  // Keep the moveend-listener's refs current (see declaration above).
  useEffect(() => { myLocationRef.current = myLocation; }, [myLocation]);
  useEffect(() => { partnerLocationRef.current = partnerLocation; }, [partnerLocation]);

  // ─── "Updated X ago" clock (section 2) ─────────────────────────────────
  // 1s ticker while visible; none while hidden. Recomputes immediately
  // (rather than waiting for the next tick) on every event the spec calls
  // out: page mount ("Map opened"), a new partner location arriving, and
  // the app/tab regaining visibility ("returns from background"). This
  // never queries Supabase — it only changes which already-fetched
  // `updated_at` gets displayed and how its age is formatted.
  // Adaptive rate: every second only while the partner's fix is under a
  // minute old (the only time second-level text changes); otherwise every 15s.
  // The old fixed 1s tick re-rendered this whole page (and its glass/blur
  // overlays) 60x/min even when nothing visible could change.
  const partnerFixAgeMs = partnerLocation ? tickNow - new Date(partnerLocation.updated_at).getTime() : Infinity;
  const tickEveryMs = partnerFixAgeMs < 60_000 ? 1000 : 15_000;
  useEffect(() => {
    let intervalId: number | null = null;
    const startTicking = () => {
      if (intervalId != null) return;
      intervalId = window.setInterval(() => setTickNow(Date.now()), tickEveryMs);
    };
    const stopTicking = () => {
      if (intervalId != null) { window.clearInterval(intervalId); intervalId = null; }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stopTicking();
      } else {
        setTickNow(Date.now()); // immediate recompute on resume, not next tick
        startTicking();
      }
    };
    // Map opened → immediate recompute (also covers the initial mount case,
    // since state is already initialized to Date.now() above, but this
    // keeps behavior correct even if mount happened while backgrounded).
    setTickNow(Date.now());
    if (!document.hidden) startTicking();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    return () => {
      stopTicking();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
    };
  }, [tickEveryMs]);

  // New partner location received → immediately update displayed timestamp
  // rather than waiting for the next 1s tick.
  useEffect(() => {
    if (partnerLocation) setTickNow(Date.now());
  }, [partnerLocation]);

  // 5-tap on status chip toggles debug overlay.
  const handleChipTap = useCallback(() => {
    const t = chipTapRef.current;
    const now2 = Date.now();
    if (now2 - t.last > 1500) t.count = 0;
    t.count += 1; t.last = now2;
    if (t.count >= 5) { t.count = 0; setDebugOpen((v) => !v); }
  }, []);

  // Keep the context's live-location debug ticker fast (5s) only while this
  // page's debug overlay is actually open; otherwise back to the slower
  // 20s default (see LocationContext/useLiveLocation for why).
  const setLocationDebugEnabled = ctx.setDebugEnabled;
  useEffect(() => {
    setLocationDebugEnabled(debugOpen);
    return () => { setLocationDebugEnabled(false); };
  }, [debugOpen, setLocationDebugEnabled]);


  /** Builds the tile layer for a style with correct maxNativeZoom/retina
   *  options, and wires a `tileerror` fallback: if the primary provider's
   *  tiles start failing (blocked, rate-limited, or briefly down — the
   *  actual "map API" failure mode, since these are free public tile
   *  services with no key/SLA), it swaps once to the style's fallback URL
   *  instead of leaving the user staring at blank grey squares. Also keeps
   *  the single shared attribution control in sync with whichever provider
   *  is actually active, since satellite/voyager are not OSM and crediting
   *  them wrong isn't just cosmetic — it's a tile-provider ToS requirement.
   */
  const buildTileLayer = useCallback((L: any, style: MapStyle, map: any) => {
    tileFallbackActiveRef.current = false;
    const cfg = MAP_TILES[style];
    const layer = L.tileLayer(cfg.url, tileOptionsFor(style));
    layer.on("tileerror", () => {
      if (tileFallbackActiveRef.current || !cfg.fallbackUrl) return;
      tileFallbackActiveRef.current = true;
      try {
        // The fallback source (OSM) has its own subdomain scheme, not the
        // primary style's — must match or ~1/4 of fallback tile requests
        // 404 against a subdomain OSM doesn't have (e.g. "d.tile...").
        layer.options.subdomains = MAP_TILES.street.subdomains ?? "abc";
        layer.setUrl(cfg.fallbackUrl);
        capture("DS-MAP-003", { component: "MapView", action: `tile-fallback:${cfg.name}` });
      } catch { /* layer already torn down */ }
    });
    if (attributionRef.current) {
      attributionRef.current.removeAttribution(MAP_TILES.street.attribution);
      attributionRef.current.removeAttribution(MAP_TILES.satellite.attribution);
      attributionRef.current.removeAttribution(MAP_TILES.voyager.attribution);
      attributionRef.current.addAttribution(cfg.attribution);
    }
    // "Voyager" now shares Street's actual OSM tiles (see MAP_TILES.voyager
    // above for why) — this warm/pastel filter is the entire remaining
    // difference between the two, so the style-cycle button doesn't show
    // the same map twice in a row. Applied to Leaflet's own tile pane
    // rather than a Tailwind class, since the pane is the one DOM node
    // Leaflet guarantees exists and repaints tiles into.
    try {
      const tilePane = map.getPane("tilePane");
      if (tilePane) tilePane.style.filter = style === "voyager" ? "sepia(0.35) saturate(1.35) hue-rotate(-6deg) brightness(1.03)" : "";
    } catch { /* pane not ready yet — next style switch will set it */ }
    return layer;
  }, [capture]);

  /** Run a camera move that WE initiate (fit/recenter), flagging it so the
   *  gesture listeners below ignore the movestart/zoomstart it triggers. */
  const moveCamera = useCallback((fn: () => void) => {
    programmaticMoveRef.current = true;
    if (programmaticTimerRef.current) window.clearTimeout(programmaticTimerRef.current);
    try { fn(); } finally {
      programmaticTimerRef.current = window.setTimeout(() => { programmaticMoveRef.current = false; }, 900);
    }
  }, []);

  // ─── Map init ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapLoaded) return;
    let cancelled = false;
    loadLeaflet().then((L) => {
      if (cancelled || !mapRef.current) return;
      // Open directly on the best known position instead of flashing the
      // whole world and then jumping: our fix, else the partner's, else world.
      const seed = myLocationRef.current ?? partnerLocationRef.current;
      const map = L.map(mapRef.current, {
        zoomControl: false,
        attributionControl: false,
        minZoom: 3,
        maxZoom: MAX_ZOOM,
        // Smooth + fast: canvas vectors (line/accuracy circle) instead of SVG
        // DOM nodes, finer zoom steps for pinch, snappier fling and wheel.
        preferCanvas: true,
        zoomSnap: 0.5,
        zoomDelta: 1,
        wheelDebounceTime: 40,
        wheelPxPerZoomLevel: 90,
        inertiaDeceleration: 3200,
        bounceAtZoomLimits: false,
        tapTolerance: 15,
      }).setView(seed ? [seed.latitude, seed.longitude] : [20, 0], seed ? 15 : 3, { animate: false });

      attributionRef.current = L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);
      tileLayerRef.current = buildTileLayer(L, mapStyle, map).addTo(map);
      // Leaflet's own zoom control sat in the same bottom-right corner as
      // the recenter button and overlapped it. Replaced by custom +/- buttons
      // stacked in one column with recenter (see the bottom row JSX).

      // Suppress auto-recenter for a window after any user interaction, and
      // wake up the recenter FAB immediately for responsiveness (section 13).
      const markGesture = () => {
        if (programmaticMoveRef.current) return; // our own fit/recenter, not the user
        userInteractedAtRef.current = Date.now();
        setMapOffCenter(true);
      };
      map.on("dragstart", markGesture);
      map.on("zoomstart", markGesture);

      // Once a gesture settles, correct the FAB against the ACTUAL distance
      // from the fitted anchor (partner+me midpoint, or just me) rather than
      // trusting the gesture latch forever — e.g. a small drag-and-back
      // should relax the FAB again instead of leaving it stuck prominent.
      const checkOffCenter = () => {
        const m = mapInstanceRef.current;
        const my = myLocationRef.current;
        const partner = partnerLocationRef.current;
        const anchor: [number, number] | null = my && partner
          ? [(my.latitude + partner.latitude) / 2, (my.longitude + partner.longitude) / 2]
          : my ? [my.latitude, my.longitude] : null;
        if (!m || !anchor) return;
        try {
          const centerPt = m.latLngToContainerPoint(m.getCenter());
          const anchorPt = m.latLngToContainerPoint(anchor);
          setMapOffCenter(centerPt.distanceTo(anchorPt) > 48);
        } catch { /* map mid-teardown */ }
      };
      map.on("moveend", checkOffCenter);

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
      if (programmaticTimerRef.current) window.clearTimeout(programmaticTimerRef.current);
      myMarkerRef.current = null;
      partnerMarkerRef.current = null;
      lineRef.current = null;
      accuracyRef.current = null;
      partnerAccuracyRef.current = null;
      tileLayerRef.current = null;
      fitStageRef.current = 0;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Switch tiles — the new layer is added first and the old one removed only
  // once the new one has painted (or after 2.5 s), so changing style never
  // flashes a blank map.
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map || !tileLayerRef.current) return;
    let alive = true;
    loadLeaflet().then((L) => {
      if (!alive || !mapInstanceRef.current) return;
      const old = tileLayerRef.current;
      const next = buildTileLayer(L, mapStyle, map);
      next.setZIndex(2);
      next.addTo(map);
      tileLayerRef.current = next;
      let done = false;
      const dropOld = () => { if (done) return; done = true; try { old?.remove(); } catch { /* already gone */ } };
      next.once("load", dropOld);
      window.setTimeout(dropOld, 2500);
    });
    return () => { alive = false; };
  }, [mapStyle, buildTileLayer]);

  // ─── Markers ─────────────────────────────────────────────────────────────
  // Dot/avatar marker with halo + name pill. Label and avatar URL are escaped
  // (they end up in innerHTML). The icon is only rebuilt when its inputs
  // (name / avatar / stale) change — NOT on every location update — so a fix
  // no longer re-creates DOM + re-downloads the avatar image.
  const createIcon = useCallback((L: any, label: string, color: string, stale = false, avatarUrl?: string | null) => L.divIcon({
    html: `<div style="display:flex;flex-direction:column;align-items:center">
      <div style="position:relative;width:26px;height:26px;${stale ? "opacity:0.55;filter:grayscale(0.4)" : ""}">
        <div style="position:absolute;inset:-7px;border-radius:50%;background:${color};opacity:0.14"></div>
        ${avatarUrl
          ? `<img src="${esc(avatarUrl)}" alt="" decoding="async" draggable="false" style="position:absolute;inset:0;width:100%;height:100%;border-radius:50%;object-fit:cover;border:2.5px solid white;box-shadow:0 1px 6px rgba(0,0,0,0.22)" />`
          : `<div style="position:absolute;inset:2px;border-radius:50%;background:${color};border:2.5px solid white;box-shadow:0 1px 6px rgba(0,0,0,0.22)"></div>`}
      </div>
      <div style="background:white;color:#111;padding:2px 8px;border-radius:8px;margin-top:5px;font-size:11px;font-weight:600;box-shadow:0 1px 4px rgba(0,0,0,0.15);white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis">${esc(label)}${stale ? " · stale" : ""}</div>
    </div>`,
    iconSize: [64, 54],
    iconAnchor: [32, 13],
    className: "ds-map-marker",
  }), []);

  /** Glide a marker to `target`. Tiny moves (<0.5 m, GPS jitter) are ignored,
   *  huge jumps (>3 km, e.g. first fix after a long gap) and hidden-tab
   *  updates snap instantly instead of animating across the map. */
  const animateMarker = useCallback((
    marker: any,
    animState: { raf: number | null; from: [number, number] | null; to: [number, number] | null; start: number },
    target: [number, number],
    durationMs: number,
  ) => {
    if (animState.raf) { cancelAnimationFrame(animState.raf); animState.raf = null; }
    const cur = marker.getLatLng();
    const jumpM = haversineKm(cur.lat, cur.lng, target[0], target[1]) * 1000;
    if (jumpM < 0.5) return;
    if (jumpM > 3000 || document.hidden) { try { marker.setLatLng(target); } catch { /* gone */ } return; }
    animState.from = [cur.lat, cur.lng];
    animState.to = target;
    animState.start = performance.now();

    const tick = (t: number) => {
      const k = Math.min(1, (t - animState.start) / durationMs);
      const ease = 1 - Math.pow(1 - k, 3); // easeOutCubic
      if (!animState.from || !animState.to) return;
      const lat = animState.from[0] + (animState.to[0] - animState.from[0]) * ease;
      const lng = animState.from[1] + (animState.to[1] - animState.from[1]) * ease;
      try { marker.setLatLng([lat, lng]); } catch { /* marker may be gone */ }
      animState.raf = k < 1 ? requestAnimationFrame(tick) : null;
    };
    animState.raf = requestAnimationFrame(tick);
  }, []);

  // My marker + GPS-accuracy circle
  const myLat = myLocation?.latitude;
  const myLng = myLocation?.longitude;
  const myAcc = (myLocation as PartnerLocation | null)?.accuracy;
  useEffect(() => {
    if (!mapLoaded || myLat == null || myLng == null) return;
    let alive = true;
    loadLeaflet().then((L) => {
      const map = mapInstanceRef.current;
      if (!alive || !map) return;
      const target: [number, number] = [myLat, myLng];
      if (!myMarkerRef.current) {
        myMarkerRef.current = L.marker(target, {
          icon: createIcon(L, "You", "hsl(220, 90%, 56%)"),
          keyboard: false,
          zIndexOffset: 500,
        }).addTo(map);
      } else {
        animateMarker(myMarkerRef.current, myAnimRef.current, target, 700);
      }
      // Accuracy circle: only when the fix is genuinely imprecise (20 m–1.5 km),
      // so the user can SEE how much to trust the dot instead of a falsely
      // exact pin. Hidden when the fix is tight or absurdly coarse.
      if (typeof myAcc === "number" && myAcc >= 20 && myAcc <= 1500) {
        if (!accuracyRef.current) {
          accuracyRef.current = L.circle(target, {
            radius: myAcc, interactive: false, weight: 1,
            color: "hsl(220, 90%, 56%)", opacity: 0.35,
            fillColor: "hsl(220, 90%, 56%)", fillOpacity: 0.08,
          }).addTo(map);
        } else {
          accuracyRef.current.setLatLng(target);
          accuracyRef.current.setRadius(myAcc);
        }
      } else if (accuracyRef.current) {
        try { accuracyRef.current.remove(); } catch { /* gone */ }
        accuracyRef.current = null;
      }
    });
    return () => { alive = false; };
  }, [myLat, myLng, myAcc, mapLoaded, createIcon, animateMarker]);

  // Partner marker — icon (name / avatar / stale) …
  const hasPartnerLoc = !!partnerLocation;
  const partnerLat = partnerLocation?.latitude;
  const partnerLng = partnerLocation?.longitude;
  useEffect(() => {
    if (!mapLoaded || partnerLat == null || partnerLng == null) return;
    let alive = true;
    loadLeaflet().then((L) => {
      const map = mapInstanceRef.current;
      if (!alive || !map) return;
      const icon = createIcon(L, partnerName, "hsl(350, 80%, 60%)", partnerStale, partnerAvatar);
      if (!partnerMarkerRef.current) {
        partnerMarkerRef.current = L.marker([partnerLat, partnerLng], { icon, keyboard: false, zIndexOffset: 400 }).addTo(map);
      } else {
        partnerMarkerRef.current.setIcon(icon);
      }
    });
    return () => { alive = false; };
    // Position intentionally excluded: only icon inputs rebuild the icon.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded, hasPartnerLoc, partnerName, partnerAvatar, partnerStale, createIcon]);

  // … and position (glides, never rebuilds the icon).
  useEffect(() => {
    if (!mapLoaded || partnerLat == null || partnerLng == null) return;
    let alive = true;
    loadLeaflet().then((L) => {
      const map = mapInstanceRef.current;
      if (!alive || !map) return;
      const target: [number, number] = [partnerLat, partnerLng];
      if (!partnerMarkerRef.current) {
        partnerMarkerRef.current = L.marker(target, {
          icon: createIcon(L, partnerName, "hsl(350, 80%, 60%)", partnerStale, partnerAvatar),
          keyboard: false, zIndexOffset: 400,
        }).addTo(map);
      } else {
        animateMarker(partnerMarkerRef.current, partnerAnimRef.current, target, 1000);
      }
    });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partnerLat, partnerLng, mapLoaded, animateMarker]);

  // Partner accuracy circle (same rules as ours; hidden while stale because an
  // old fix's radius says nothing about where they are now).
  const partnerAcc = partnerLocation?.accuracy_m;
  useEffect(() => {
    if (!mapLoaded) return;
    let alive = true;
    loadLeaflet().then((L) => {
      const map = mapInstanceRef.current;
      if (!alive || !map) return;
      const show = partnerLat != null && partnerLng != null && !partnerStale
        && typeof partnerAcc === "number" && partnerAcc >= 20 && partnerAcc <= 1500;
      if (!show) {
        if (partnerAccuracyRef.current) { try { partnerAccuracyRef.current.remove(); } catch { /* gone */ } partnerAccuracyRef.current = null; }
        return;
      }
      const at: [number, number] = [partnerLat as number, partnerLng as number];
      if (!partnerAccuracyRef.current) {
        partnerAccuracyRef.current = L.circle(at, {
          radius: partnerAcc, interactive: false, weight: 1,
          color: "hsl(350, 80%, 60%)", opacity: 0.35,
          fillColor: "hsl(350, 80%, 60%)", fillOpacity: 0.08,
        }).addTo(map);
      } else {
        partnerAccuracyRef.current.setLatLng(at);
        partnerAccuracyRef.current.setRadius(partnerAcc);
      }
    });
    return () => { alive = false; };
  }, [partnerLat, partnerLng, partnerAcc, partnerStale, mapLoaded]);

  // Connecting line (one polyline, updated in place) + camera fit.
  // Fit is staged so it is right whichever order the fixes arrive in: a first
  // fit on whoever we have, and ONE more fit on both as soon as the partner
  // shows up — unless the user has already moved the map themselves. (Before,
  // if our fix came first the partner appearing later never re-framed.)
  useEffect(() => {
    if (!mapLoaded) return;
    let alive = true;
    loadLeaflet().then((L) => {
      const map = mapInstanceRef.current;
      if (!alive || !map) return;
      const me: [number, number] | null = myLat != null && myLng != null ? [myLat, myLng] : null;
      const them: [number, number] | null = partnerLat != null && partnerLng != null ? [partnerLat, partnerLng] : null;

      if (me && them) {
        if (!lineRef.current) {
          lineRef.current = L.polyline([me, them], {
            color: "hsl(350, 80%, 60%)", weight: 2, dashArray: "8, 8", opacity: partnerStale ? 0.3 : 0.6, interactive: false,
          }).addTo(map);
        } else {
          lineRef.current.setLatLngs([me, them]);
          lineRef.current.setStyle({ opacity: partnerStale ? 0.3 : 0.6 });
        }
      } else if (lineRef.current) {
        try { lineRef.current.remove(); } catch { /* gone */ }
        lineRef.current = null;
      }

      const stage = fitStageRef.current;
      if (me && them && stage < 2) {
        const userMoved = userInteractedAtRef.current > 0;
        if (!userMoved) {
          moveCamera(() => map.fitBounds(L.latLngBounds([me, them]), { padding: [60, 60], maxZoom: 15, animate: stage > 0 }));
          setMapOffCenter(false);
        }
        fitStageRef.current = 2;
      } else if (stage === 0 && (me || them)) {
        const at = (me ?? them) as [number, number];
        moveCamera(() => map.setView(at, me ? 16 : 15, { animate: false }));
        setMapOffCenter(false);
        fitStageRef.current = 1;
      }
    });
    return () => { alive = false; };
  }, [myLat, myLng, partnerLat, partnerLng, mapLoaded, partnerStale, moveCamera]);

  // Keep the canvas correct when its container changes size for ANY reason
  // (fullscreen, keyboard, dock/sheet animation, rotation) — not just on
  // window resize. rAF-throttled so it never thrashes layout.
  useEffect(() => {
    const el = mapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { try { mapInstanceRef.current?.invalidateSize({ animate: false }); } catch { /* noop */ } });
    });
    ro.observe(el);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);

  // ─── UI helpers ──────────────────────────────────────────────────────────
  const formatDistance = (d: number) => {
    // Honest precision: below 1 km round to 10 m (a "37 m" reading from two
    // phones with ±15 m GPS error each is false precision); under 30 m is
    // simply "Together".
    if (d < 0.03) return "Together";
    if (d < 1) return `${Math.max(10, Math.round((d * 1000) / 10) * 10)} m`;
    if (d > 100) return `${Math.round(d)} km`;
    return `${d.toFixed(1)} km`;
  };

  // Section 2 fix: this used to derive from `now` (LocationContext's 30s
  // ticker, shared with staleness math) — so the displayed age only ever
  // advanced in 30s jumps, and did nothing at all when a fresh location
  // arrived, when this page mounted, or when the app resumed from
  // background until the next 30s boundary happened to land. It now reads
  // `tickNow` (declared below: a ticker — 1s while the partner fix is under a minute old, else 15s — while this page is visible,
  // paused when it isn't, and force-set immediately on the events listed
  // above) and returns second-level granularity for the first minute, per
  // spec. `now` (LocationContext's coarser ticker) is untouched and still
  // drives staleness classification (partnerStale/deviceStatusStale),
  // which doesn't need second-level precision.
  const timeAgo = (date: string) => {
    const ms = tickNow - new Date(date).getTime();
    const secs = Math.floor(ms / 1000);
    if (secs < 10) return "just now";
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  // TIMESTAMP FIX ("Location updated 33 days ago" shown as though the
  // partner had been inactive for 33 days): two DIFFERENT facts were being
  // concatenated into one status line — presence/activity (heartbeat,
  // realtime) and location freshness (how long ago the location ROW last
  // changed). A partner can be perfectly active while their location row is
  // old (background updates only fire on significant movement), which made
  // "Online · 33d ago" read as a false activity claim. These are now
  // reported separately: stale partners show presence-based "Last seen",
  // active partners show "Active now", and an old-but-live location gets
  // its own clearly-scoped "location updated X ago" clause.
  const partnerLocAgeMin = partnerLocation
    ? Math.round((tickNow - new Date(partnerLocation.updated_at).getTime()) / 60000)
    : Infinity;
  const partnerStatusLabel = !partnerId
    ? null
    : !partnerLocation
      ? (partnerStale ? "Offline · waiting for location…" : "Waiting for location…")
      : partnerStale
        ? `Last seen ${timeAgo(partnerPresence?.last_seen_at ?? partnerLocation.updated_at)}`
        : partnerLocAgeMin > 15
          ? `Active now · location updated ${timeAgo(partnerLocation.updated_at)}`
          : "Active now";

  const cycleMapStyle = () => {
    const styles: MapStyle[] = ["street", "satellite", "voyager"];
    const idx = styles.indexOf(mapStyle);
    setMapStyle(styles[(idx + 1) % styles.length]);
  };

  const recenter = useCallback(() => {
    userInteractedAtRef.current = 0;
    setMapOffCenter(false);
    const map = mapInstanceRef.current;
    if (!map) return;
    loadLeaflet().then((L) => {
      const me: [number, number] | null = myLocation ? [myLocation.latitude, myLocation.longitude] : null;
      const them: [number, number] | null = partnerLocation ? [partnerLocation.latitude, partnerLocation.longitude] : null;
      moveCamera(() => {
        if (me && them) map.fitBounds(L.latLngBounds([me, them]), { padding: [60, 60], maxZoom: 16, animate: true, duration: 0.6 });
        else if (me || them) map.flyTo((me ?? them) as [number, number], Math.max(map.getZoom(), 15), { duration: 0.6 });
      });
    });
  }, [myLocation, partnerLocation, moveCamera]);

  // AUDIT FIX (Phase 7, Map): this used to call navigator.geolocation
  // directly, unconditionally — on native that bypasses the Capacitor
  // plugin the rest of the location engine uses (see useLiveLocation.ts's
  // header comment for why), and even when it happened to work, nothing
  // downstream would ever notice the grant and resume tracking. Now routes
  // through LocationContext's retryLocationPermission, which is
  // platform-correct and actually resumes the watcher on a native grant.
  const requestLocationPermission = useCallback(() => {
    void ctx.retryLocationPermission();
  }, [ctx]);

  const toggleFullscreen = useCallback(() => {
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

  // Safe-area is baked into each floating element directly, so it applies
  // identically whether or not fullscreen (which now only hides the bottom
  // status pill/recenter — see below) is active.
  const topInset = "calc(env(safe-area-inset-top) + 12px)";
  const bottomInset = "calc(env(safe-area-inset-bottom) + 12px)";

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col flex-1 min-h-0 overflow-hidden" style={{ height: '100%' }}>
      {/* Phase 3: the map is the hero — no PageHeader/toolbar above it.
          Identity, status, and controls are all floating glass surfaces
          layered directly over an edge-to-edge canvas instead. */}
      <div
        className={
          isFullscreen
            ? "fixed inset-0 z-[60] overflow-hidden bg-background"
            : "flex-1 min-h-0 overflow-hidden relative"
        }
        style={{ minHeight: 0 }}
      >
        <div ref={mapRef} className="absolute inset-0" />

        {/* Top row: back + floating identity pill (left) — controls (right).
            Section 5: compact, translucent, no dashboard, no toolbar feel. */}
        <div className="absolute inset-x-3 z-[1000] flex items-start justify-between gap-2" style={{ top: topInset }}>
          <div className="flex items-start gap-2 min-w-0">
            <button
              onClick={() => { navigate(-1); }}
              aria-label="Back"
              className="h-9 w-9 rounded-full glass-sheet flex items-center justify-center shrink-0 active:scale-95 active:brightness-95 transition-transform"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>

            {/* Display only: the bottom battery/status chip is now the ONE
                way to open the details sheet (was also this header and a
                tap on the partner's marker). */}
            <div
              className="min-w-0 max-w-[68vw] rounded-full glass-sheet pl-1.5 pr-3.5 py-1.5 flex items-center gap-2 text-left"
            >
              <span className="relative h-7 w-7 rounded-full bg-accent-muted flex items-center justify-center shrink-0 overflow-hidden ring-1 ring-border/40">
                {partnerAvatar ? (
                  <img loading="lazy" decoding="async" src={partnerAvatar} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="text-[10px] font-semibold text-primary">{(partnerId ? partnerName : "?").slice(0, 2).toUpperCase()}</span>
                )}
                {partnerId && partnerLocation && !partnerStale && (
                  <span aria-hidden="true" className="absolute bottom-0 right-0 h-2 w-2 rounded-full bg-success ring-2 ring-background" />
                )}
              </span>
              <span className="min-w-0 leading-tight">
                <span className="block text-[12.5px] font-medium text-foreground truncate">
                  {partnerId ? partnerName : "Map"}
                </span>
                <span className="block text-[10.5px] text-foreground-secondary truncate tabular-nums">
                  {!partnerId ? "Link with your partner" : partnerStatusLabel}
                </span>
              </span>
            </div>
          </div>

          {/* Top-right floating controls */}
          <div className="flex flex-col gap-2 items-end shrink-0">
            <button onClick={(e) => { e.stopPropagation(); cycleMapStyle(); }}
              aria-label={`Map style: ${MAP_TILES[mapStyle].name}. Tap to change.`}
              className="h-9 px-3 rounded-full glass-sheet flex items-center gap-1.5 text-[11px] font-medium active:scale-95 active:brightness-95 transition-transform">
              <Layers className="h-3.5 w-3.5" />
              {MAP_TILES[mapStyle].name}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); toggleFullscreen(); }}
              aria-label={isFullscreen ? "Exit full screen" : "Full screen"}
              className="h-9 w-9 rounded-full glass-sheet flex items-center justify-center self-end active:scale-95 active:brightness-95 transition-transform"
            >
              {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>

        {/* Contextual flags — only when something needs attention, sit
            below the identity pill rather than competing with it. */}
        <AnimatePresence>
          {(!online || (!realtimeOk && online) || (partnerStale && partnerLocation)) && (
            <motion.div
              initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={snapTransition}
              className="absolute left-3 z-[999] flex flex-col gap-1.5 items-start"
              style={{ top: "calc(env(safe-area-inset-top) + 56px)" }}
            >
              {!online && (
                <span className="px-2.5 py-1 rounded-full glass-sheet text-[10px] font-medium flex items-center gap-1">
                  <WifiOff className="h-3 w-3" /> Offline
                </span>
              )}
              {!realtimeOk && online && (
                <span className="px-2.5 py-1 rounded-full glass-sheet text-[10px] font-medium">
                  Reconnecting…
                </span>
              )}
              {partnerStale && partnerLocation && (
                <span className="px-2.5 py-1 rounded-full bg-warning/15 text-warning border border-warning/30 text-[10px] font-medium">
                  {partnerName}'s location is stale
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Bottom row: compact status pill (left) — recenter (right).
            Section 9/13: no giant card, recenter goes quiet once centered. */}
        {!isFullscreen && (
          <div className="absolute inset-x-3 z-[1000] flex items-end justify-between gap-2" style={{ bottom: bottomInset }}>
            <button
              type="button"
              onClick={() => setStatusSheetOpen(true)}
              aria-label="Device status — tap for details"
              className="min-w-0 max-w-[70vw] rounded-2xl glass-sheet px-3 py-2 flex items-center gap-2.5 text-left active:scale-[0.98] active:brightness-95 transition-transform"
            >
              {partnerDeviceStatus && partnerDeviceStatus.battery_level != null ? (
                <>
                  <span className={`flex items-center gap-1 shrink-0 text-[13px] font-semibold tabular-nums ${deviceStatusStale ? "opacity-50" : ""} ${Math.round(partnerDeviceStatus.battery_level) <= 15 && !partnerDeviceStatus.battery_charging ? "text-destructive" : "text-foreground"}`}>
                    <BatteryIcon level={Math.round(partnerDeviceStatus.battery_level)} charging={partnerDeviceStatus.battery_charging} />
                    {Math.round(partnerDeviceStatus.battery_level)}%
                  </span>
                  {(partnerDeviceStatus.ringer_mode === "normal" || partnerDeviceStatus.ringer_mode === "silent" || partnerDeviceStatus.ringer_mode === "vibrate") && (
                    <>
                      <span className="h-4 w-px bg-divider shrink-0" aria-hidden="true" />
                      {partnerDeviceStatus.ringer_mode === "normal"
                        ? <Bell className="h-3.5 w-3.5 text-foreground-secondary shrink-0" aria-label="Ringer on" />
                        : partnerDeviceStatus.ringer_mode === "silent"
                          ? <BellOff className="h-3.5 w-3.5 text-foreground-secondary shrink-0" aria-label="Phone on silent" />
                          : <Vibrate className="h-3.5 w-3.5 text-foreground-secondary shrink-0" aria-label="Phone on vibrate" />}
                    </>
                  )}
                  {partnerDeviceStatus.ringer_mode === "unknown" && (
                    <>
                      <span className="h-4 w-px bg-divider shrink-0" aria-hidden="true" />
                      <span className="text-[10px] text-foreground-tertiary shrink-0" title="Ringer status isn't available on their device">n/a</span>
                    </>
                  )}
                  <span className="h-4 w-px bg-divider shrink-0" aria-hidden="true" />
                  <span className="text-[10.5px] text-foreground-secondary truncate tabular-nums">
                    {partnerLocation ? (partnerStale ? "Stale" : `Updated ${timeAgo(partnerLocation.updated_at)}`) : "No location yet"}
                  </span>
                </>
              ) : (
                <span className="text-[11px] text-foreground-secondary truncate">
                  {!partnerId ? "Link with your partner in Settings" : "Waiting for their status…"}
                </span>
              )}
              <ChevronUp className="h-3.5 w-3.5 text-foreground-tertiary shrink-0" aria-hidden="true" />
            </button>

            <div className="shrink-0 flex flex-col items-center gap-2">
              <div className="glass-sheet rounded-2xl flex flex-col overflow-hidden shadow-sm">
                <button type="button" aria-label="Zoom in"
                  onClick={(e) => { e.stopPropagation(); mapInstanceRef.current?.zoomIn(); }}
                  className="h-10 w-10 flex items-center justify-center text-foreground active:bg-foreground/10">
                  <Plus className="h-4 w-4" />
                </button>
                <span className="h-px bg-divider mx-2" aria-hidden="true" />
                <button type="button" aria-label="Zoom out"
                  onClick={(e) => { e.stopPropagation(); mapInstanceRef.current?.zoomOut(); }}
                  className="h-10 w-10 flex items-center justify-center text-foreground active:bg-foreground/10">
                  <Minus className="h-4 w-4" />
                </button>
              </div>
            {myLocation && (
              <motion.button
                onClick={(e) => { e.stopPropagation(); recenter(); }}
                aria-label="Recenter map"
                animate={mapOffCenter ? { scale: 1, opacity: 1 } : { scale: 0.86, opacity: 0.55 }}
                transition={gentleSpring}
                whileTap={{ scale: 0.92 }}
                className={`shrink-0 rounded-full flex items-center justify-center transition-colors ${
                  mapOffCenter ? "h-11 w-11 bg-primary text-primary-foreground shadow-lg" : "h-9 w-9 glass-sheet text-foreground-secondary"
                }`}
              >
                <Crosshair className={mapOffCenter ? "h-5 w-5" : "h-4 w-4"} />
              </motion.button>
            )}
            </div>
          </div>
        )}

        {permissionBlocked && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm z-[1000]">
            <div className="text-center space-y-3 px-6">
              <div className="h-16 w-16 rounded-full bg-destructive/10 mx-auto flex items-center justify-center">
                <AlertCircle className="h-7 w-7 text-destructive" />
              </div>
              <p className="text-sm font-medium">Location Access Required</p>
              <p className="text-xs text-muted-foreground max-w-xs">
                {Capacitor.isNativePlatform() ? "Tap below to grant location access." : "Enable location in your browser settings."}
              </p>
              <button onClick={(e) => { e.stopPropagation(); requestLocationPermission(); }} className="bg-primary text-primary-foreground text-sm px-5 py-2.5 rounded-xl">
                Request Permission
              </button>
            </div>
          </div>
        )}

        {/* Waiting for a first fix. Covers both the plain "getting your
            location" wait AND a transient GPS trouble (timeout / services
            off) — permission is fine in both, so this is never the
            permission screen. Only shown while there is no fix at all; once
            a position exists, later timeouts leave the map alone (the
            status sheet already says "Reconnecting to GPS…"). */}
        {!myLocation && !permissionBlocked && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-sm z-[1000]">
            <div className="text-center space-y-3 px-6">
              <div className="h-16 w-16 rounded-full bg-accent mx-auto flex items-center justify-center animate-pulse">
                <MapPin className="h-7 w-7 text-accent-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                {locationError ? "Still looking for your location…" : "Getting your location..."}
              </p>
              {locationError && (
                <>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    {locationErrorKind === "unavailable" && /turned off/i.test(locationError)
                      ? "Location services look switched off. Turn on location in your device settings, then try again."
                      : "This can take a moment indoors. Moving near a window or outside usually helps."}
                  </p>
                  <button onClick={(e) => { e.stopPropagation(); requestLocationPermission(); }} className="bg-primary text-primary-foreground text-sm px-5 py-2.5 rounded-xl">
                    Try again
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Richer status sheet — distance apart, exact tracking state,
          transport/diagnostics. Everything that was previously always
          visible as stacked cards below the map now lives here instead,
          one tap away, per the brief's "map dominates, no giant cards"
          instruction. No functionality was removed — every field below
          existed before this phase, just relocated. */}
      <Sheet open={statusSheetOpen} onOpenChange={setStatusSheetOpen}>
        <SheetContent side="bottom" className="rounded-t-3xl">
          <div className="space-y-4 pt-1">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] text-foreground-tertiary uppercase tracking-wider">Distance apart</p>
                <p className="text-3xl font-serif mt-1 tabular-nums">{distanceKm !== null ? formatDistance(distanceKm) : "—"}</p>
                {partnerLocation && (
                  <p className="text-[11px] text-foreground-secondary mt-1 tabular-nums">
                    {partnerName} • {timeAgo(partnerLocation.updated_at)}
                    {partnerStale && <span className="ml-1 text-warning">· stale</span>}
                  </p>
                )}
                {!partnerId && <p className="text-[11px] text-foreground-secondary mt-1">Link with partner in Settings</p>}
              </div>
              <button onClick={() => { recenter(); setStatusSheetOpen(false); }} className="h-11 w-11 rounded-xl bg-primary flex items-center justify-center shrink-0" aria-label="Recenter">
                <Navigation className="h-5 w-5 text-primary-foreground" />
              </button>
            </div>

            <div>
              <p className="text-[11px] text-foreground-tertiary uppercase tracking-wider mb-1.5">Their device</p>
              {partnerDeviceStatus && partnerDeviceStatus.battery_level != null ? (
                <PartnerStatusPill status={partnerDeviceStatus} stale={deviceStatusStale} />
              ) : partnerId ? (
                <p className="text-[11px] text-foreground-secondary">
                  {deviceStatusStale ? "Status data is stale" : "Waiting for device status…"}
                </p>
              ) : (
                <p className="text-[11px] text-foreground-secondary">Link with partner in Settings</p>
              )}
            </div>

            {myLocation && (
              <div className="rounded-xl surface-1 p-3 flex items-center gap-3">
                <div className={`h-2 w-2 rounded-full shrink-0 ${live.state === "tracking" ? "bg-primary animate-pulse" : "bg-warning animate-pulse"}`} />
                <p className="text-[11px] text-foreground-secondary tabular-nums">
                  {live.state === "tracking" && `Live • ${myLocation.latitude.toFixed(4)}, ${myLocation.longitude.toFixed(4)}${typeof myAcc === "number" ? ` • ±${Math.round(myAcc)} m` : ""}`}
                  {live.state === "reconnecting" && "Reconnecting to GPS…"}
                  {live.state === "requesting_permission" && "Requesting permission…"}
                  {live.state === "failed" && (locationError ?? "Location unavailable")}
                  {live.state === "idle" && "Idle"}
                </p>
              </div>
            )}

            {/* Transport/diagnostics — 5 taps still opens the same debug
                overlay it always did, just relocated from a floating map
                chip into this sheet. */}
            <button
              onClick={handleChipTap}
              className="w-full flex items-center justify-between text-[11px] text-foreground-tertiary py-1"
            >
              <span>Sync</span>
              <span className="tabular-nums">
                {transportMode === "realtime" ? "Realtime" : "Fallback sync"}
                {live.debug.queueDepth > 0 ? ` · queued ${live.debug.queueDepth}` : ""}
              </span>
            </button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Debug overlay (5-tap on the Sync row in the sheet above) */}
      <AnimatePresence>
        {debugOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={standardTransition}
            className="fixed inset-x-3 z-[1001] rounded-xl bg-card/95 backdrop-blur border border-border p-3 text-[10px] font-mono space-y-0.5"
            style={{ top: "calc(env(safe-area-inset-top) + 60px)" }}
          >
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
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default MapView;
