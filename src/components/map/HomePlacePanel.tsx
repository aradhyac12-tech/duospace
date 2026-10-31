/**
 * HomePlacePanel — set / edit the Home pin on the Map.
 *
 * Two ways to choose the spot, both live on the same screen:
 *   1. search an address (OpenStreetMap), or tap "Use my location"
 *   2. drag the map under the fixed centre pin
 * A radius slider (50 m – 1 km) draws the arrival circle live. Once saved, the
 * database notifies the partner when the user's location enters that circle
 * (see supabase/migrations/20261018120000_home_places_arrival_alerts.sql).
 *
 * Rendered INSIDE the map's relatively-positioned container so the pin overlay
 * and the bottom panel share its coordinate space. Leaflet objects are owned by
 * refs here and cleaned up on close/unmount; nothing re-renders per map frame
 * except the small draft readout.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Home, Loader2, LocateFixed, MapPin, Search, X } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useBackHandler } from "@/hooks/useBackHandler";
import { searchAddress, reverseAddress, type GeoResult } from "@/lib/geocode";
import {
  HOME_DEFAULT_RADIUS_M,
  HOME_MAX_RADIUS_M,
  HOME_MIN_RADIUS_M,
  type HomeDraft,
  type HomePlace,
} from "@/hooks/useHomePlace";

/** Where (as a fraction of the map height) the centre pin's tip sits — above
 *  the bottom panel so the pin is never hidden behind it. */
const PIN_Y = 0.36;
const ACCENT = "hsl(350, 80%, 60%)";
const PRESETS: Array<{ m: number; label: string }> = [
  { m: 100, label: "100 m" },
  { m: 200, label: "200 m" },
  { m: 500, label: "500 m" },
  { m: 1000, label: "1 km" },
];

const HOUSE_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>';

let leafletCache: any = null;
const getLeaflet = (): Promise<any> =>
  leafletCache ? Promise.resolve(leafletCache) : import("leaflet").then((m) => (leafletCache = (m as any).default ?? m));

const fmtRadius = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `${m} m`);

interface Props {
  open: boolean;
  onClose: () => void;
  onOpen: () => void;
  getMap: () => any;
  mapReady: boolean;
  home: HomePlace | null;
  saving: boolean;
  myLocation: { latitude: number; longitude: number } | null;
  /** null when the user has no linked partner (alert toggle is then disabled). */
  partnerName: string | null;
  onSave: (draft: HomeDraft) => Promise<{ ok: boolean; error?: string }>;
  onRemove: () => Promise<{ ok: boolean; error?: string }>;
}

const HomePlacePanel = ({ open, onClose, onOpen, getMap, mapReady, home, saving, myLocation, partnerName, onSave, onRemove }: Props) => {
  const { toast } = useToast();

  // ── Draft (what the sheet is editing) ───────────────────────────────────
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [radius, setRadius] = useState(HOME_DEFAULT_RADIUS_M);
  const [label, setLabel] = useState("Home");
  const [notify, setNotify] = useState(true);
  const [notifyLeave, setNotifyLeave] = useState(false);
  const [address, setAddress] = useState<string | null>(null);
  const [lifted, setLifted] = useState(false);

  // ── Search ──────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);

  const draftCircleRef = useRef<any>(null);
  const savedMarkerRef = useRef<any>(null);
  const savedCircleRef = useRef<any>(null);
  const radiusRef = useRef(radius);
  const skipReverseRef = useRef(false);
  const myLocRef = useRef(myLocation);
  const draftRef = useRef<{ lat: number | null; lng: number | null }>({ lat: null, lng: null });
  const onOpenRef = useRef(onOpen);
  useEffect(() => { radiusRef.current = radius; }, [radius]);
  useEffect(() => { myLocRef.current = myLocation; }, [myLocation]);
  useEffect(() => { draftRef.current = { lat, lng }; }, [lat, lng]);
  useEffect(() => { onOpenRef.current = onOpen; }, [onOpen]);

  useBackHandler(open, onClose);

  /** Puts a coordinate under the centre pin (the map centre sits lower than
   *  the pin, so shift it by the difference). */
  const centerOn = useCallback((L: any, map: any, la: number, ln: number, zoom?: number, animate = true) => {
    const z = zoom ?? map.getZoom();
    const size = map.getSize();
    const target = map.project([la, ln], z).add([0, (0.5 - PIN_Y) * size.y]);
    skipReverseRef.current = true;
    map.setView(map.unproject(target, z), z, { animate });
  }, []);

  const zoomForRadius = useCallback((L: any, map: any, la: number, ln: number, r: number) => {
    const b = L.circle([la, ln], { radius: r }).getBounds().pad(0.9);
    const z = map.getBoundsZoom(b, false);
    return Math.max(14, Math.min(19, z));
  }, []);

  // ── Open: seed the draft, draw the circle, follow the map ───────────────
  useEffect(() => {
    if (!open || !mapReady) return;
    const map = getMap();
    if (!map) return;
    let dead = false;
    let raf = 0;
    let reverseTimer = 0;
    let reverseAbort: AbortController | null = null;
    let cleanup = () => {};

    void getLeaflet().then((L) => {
      if (dead) return;
      const startLat = home?.latitude ?? myLocRef.current?.latitude ?? map.getCenter().lat;
      const startLng = home?.longitude ?? myLocRef.current?.longitude ?? map.getCenter().lng;
      const startRadius = home?.radius_m ?? HOME_DEFAULT_RADIUS_M;

      setLat(startLat); setLng(startLng);
      setRadius(startRadius);
      setLabel(home?.label ?? "Home");
      setNotify(home?.notify_partner ?? true);
      setNotifyLeave(home?.notify_leave ?? false);
      setAddress(home?.address ?? null);
      setQuery(""); setResults([]);

      const circle = L.circle([startLat, startLng], {
        radius: startRadius, color: ACCENT, weight: 2, fillColor: ACCENT, fillOpacity: 0.16, interactive: false,
      }).addTo(map);
      draftCircleRef.current = circle;
      centerOn(L, map, startLat, startLng, zoomForRadius(L, map, startLat, startLng, startRadius));

      const pinPoint = () => {
        const size = map.getSize();
        return map.containerPointToLatLng(L.point(size.x / 2, size.y * PIN_Y));
      };
      const onMove = () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const p = pinPoint();
          circle.setLatLng(p);
          setLat(p.lat); setLng(p.lng);
        });
      };
      const onStart = () => setLifted(true);
      const onEnd = () => {
        setLifted(false);
        onMove();
        if (skipReverseRef.current) { skipReverseRef.current = false; return; }
        window.clearTimeout(reverseTimer);
        reverseTimer = window.setTimeout(async () => {
          reverseAbort?.abort();
          reverseAbort = new AbortController();
          const p = pinPoint();
          const a = await reverseAddress(p.lat, p.lng, reverseAbort.signal);
          if (!dead && a) setAddress(a);
        }, 650);
      };
      // A real finger drag always wants a fresh address, even if a programmatic
      // move earlier left the skip flag set (setView to the same spot fires no moveend).
      const onDragStart = () => { skipReverseRef.current = false; };
      map.on("move", onMove);
      map.on("movestart", onStart);
      map.on("dragstart", onDragStart);
      map.on("moveend", onEnd);

      cleanup = () => {
        map.off("move", onMove);
        map.off("movestart", onStart);
        map.off("dragstart", onDragStart);
        map.off("moveend", onEnd);
        try { circle.remove(); } catch { /* map already gone */ }
        draftCircleRef.current = null;
      };
    });

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      window.clearTimeout(reverseTimer);
      reverseAbort?.abort();
      cleanup();
      setLifted(false);
    };
    // Re-seed only when the sheet opens/closes (or the map becomes ready), never
    // while editing — `home` is read once at open time on purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mapReady]);

  // Live circle radius.
  useEffect(() => { draftCircleRef.current?.setRadius(radius); }, [radius]);

  // ── Saved-home overlay (marker + faint circle) while the sheet is closed ─
  useEffect(() => {
    if (!mapReady || open || !home) return;
    const map = getMap();
    if (!map) return;
    let dead = false;
    void getLeaflet().then((L) => {
      if (dead) return;
      savedCircleRef.current = L.circle([home.latitude, home.longitude], {
        radius: home.radius_m, color: ACCENT, weight: 1.5, dashArray: "6 6", fillColor: ACCENT, fillOpacity: 0.07, interactive: false,
      }).addTo(map);
      const icon = L.divIcon({
        className: "",
        html: `<div style="width:34px;height:34px;border-radius:50%;background:${ACCENT};display:flex;align-items:center;justify-content:center;border:2px solid #fff;box-shadow:0 4px 14px rgba(0,0,0,.35)">${HOUSE_SVG}</div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });
      const marker = L.marker([home.latitude, home.longitude], { icon, keyboard: false, title: home.label }).addTo(map);
      marker.on("click", () => onOpenRef.current());
      savedMarkerRef.current = marker;
    });
    return () => {
      dead = true;
      try { savedMarkerRef.current?.remove(); } catch { /* gone */ }
      try { savedCircleRef.current?.remove(); } catch { /* gone */ }
      savedMarkerRef.current = null;
      savedCircleRef.current = null;
    };
  }, [mapReady, open, home, getMap]);

  // ── Address search (debounced, abortable) ───────────────────────────────
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 3) { setResults([]); setSearching(false); return; }
    const ctl = new AbortController();
    setSearching(true);
    const t = window.setTimeout(async () => {
      const near = draftRef.current.lat != null && draftRef.current.lng != null
        ? { lat: draftRef.current.lat, lng: draftRef.current.lng }
        : myLocRef.current ? { lat: myLocRef.current.latitude, lng: myLocRef.current.longitude } : undefined;
      const r = await searchAddress(q, ctl.signal, near);
      if (!ctl.signal.aborted) { setResults(r.slice(0, 5)); setSearching(false); }
    }, 450);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [query, open]);

  const goTo = useCallback((la: number, ln: number, addr: string | null) => {
    const map = getMap();
    if (!map) return;
    void getLeaflet().then((L) => {
      setAddress(addr);
      setLat(la); setLng(ln);
      draftCircleRef.current?.setLatLng([la, ln]);
      centerOn(L, map, la, ln, zoomForRadius(L, map, la, ln, radiusRef.current));
    });
  }, [getMap, centerOn, zoomForRadius]);

  const pickResult = (r: GeoResult) => {
    setResults([]); setQuery("");
    goTo(r.lat, r.lng, r.label);
  };

  const useMyLocation = () => {
    const me = myLocRef.current;
    if (!me) {
      toast({ title: "Waiting for your location", description: "Your GPS position isn't available yet — search an address or drag the map instead." });
      return;
    }
    setResults([]); setQuery("");
    goTo(me.latitude, me.longitude, null);
    void reverseAddress(me.latitude, me.longitude).then((a) => { if (a) setAddress(a); });
  };

  const refit = (r: number) => {
    const map = getMap();
    if (!map || lat == null || lng == null) return;
    void getLeaflet().then((L) => centerOn(L, map, lat, lng, zoomForRadius(L, map, lat, lng, r)));
  };

  const handleSave = async () => {
    if (lat == null || lng == null) return;
    const res = await onSave({ label, address, latitude: lat, longitude: lng, radius_m: radius, notify_partner: !!partnerName && notify, notify_leave: !!partnerName && notify && notifyLeave });
    if (res.ok) {
      toast({ title: "Home saved", description: partnerName && notify ? `${partnerName} will be notified when you get home.` : "Saved." });
      onClose();
    } else {
      toast({ title: "Couldn't save Home", description: res.error ?? "Please try again.", variant: "destructive" });
    }
  };

  const handleRemove = async () => {
    const res = await onRemove();
    if (res.ok) { toast({ title: "Home removed" }); onClose(); }
    else toast({ title: "Couldn't remove Home", description: res.error ?? "Please try again.", variant: "destructive" });
  };

  const coordText = useMemo(() => (lat != null && lng != null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : ""), [lat, lng]);

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Fixed centre pin — the map moves under it. */}
          <motion.div
            key="home-pin"
            aria-hidden="true"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="absolute inset-0 z-[1050] pointer-events-none"
          >
            <div className="absolute left-1/2" style={{ top: `${PIN_Y * 100}%` }}>
              <div
                className="absolute h-2 w-5 rounded-full bg-black/30 blur-[2px] transition-all duration-150"
                style={{ left: -10, top: -4, opacity: lifted ? 0.35 : 0.6, transform: `scale(${lifted ? 0.7 : 1})` }}
              />
              <div
                className="absolute transition-transform duration-150 ease-out"
                style={{ left: -20, top: -44, transform: `translateY(${lifted ? -10 : 0}px)` }}
              >
                <MapPin className="h-10 w-10 drop-shadow-lg" style={{ color: ACCENT, fill: ACCENT, stroke: "#fff", strokeWidth: 1.5 }} />
                <Home className="absolute h-3.5 w-3.5 text-white" style={{ left: 13, top: 9 }} strokeWidth={2.6} />
              </div>
            </div>
          </motion.div>

          <motion.div
            key="home-panel"
            role="dialog"
            aria-label="Set home"
            initial={{ y: "100%" }} animate={{ y: 0 }} exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 38 }}
            className="absolute inset-x-0 bottom-0 z-[1100] max-h-[58%] overflow-y-auto overscroll-contain rounded-t-3xl glass-sheet px-4 pt-3 pb-[max(env(safe-area-inset-bottom),16px)] space-y-3"
          >
            <div className="flex items-center gap-2">
              <span className="h-8 w-8 rounded-full flex items-center justify-center shrink-0" style={{ background: ACCENT }}>
                <Home className="h-4 w-4 text-white" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-semibold leading-tight">{home ? "Edit Home" : "Set Home"}</p>
                <p className="text-[11px] text-foreground-secondary truncate">Search an address, or drag the map to place the pin</p>
              </div>
              <button onClick={onClose} aria-label="Close" className="h-8 w-8 rounded-full bg-foreground/[0.08] flex items-center justify-center active:scale-95 transition-transform">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Search + use-my-location */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" aria-hidden="true" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search address or place"
                  aria-label="Search address"
                  className="pl-9 h-10"
                  autoComplete="off"
                  enterKeyHint="search"
                />
                {searching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
              </div>
              <button
                onClick={useMyLocation}
                aria-label="Use my current location"
                className="h-10 w-10 shrink-0 rounded-full bg-foreground/[0.08] flex items-center justify-center active:scale-95 transition-transform"
              >
                <LocateFixed className="h-4 w-4" />
              </button>
            </div>

            {results.length > 0 && (
              <ul className="rounded-2xl bg-foreground/[0.05] divide-y divide-border/40 overflow-hidden" role="listbox" aria-label="Address results">
                {results.map((r, i) => (
                  <li key={`${r.lat},${r.lng},${i}`}>
                    <button onClick={() => pickResult(r)} className="w-full text-left px-3 py-2.5 flex items-start gap-2 active:bg-foreground/10">
                      <MapPin className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="text-[12.5px] leading-snug">{r.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!searching && query.trim().length >= 3 && results.length === 0 && (
              <p className="text-[11.5px] text-muted-foreground px-1">No matches — try a nearby landmark, or drag the map to the spot.</p>
            )}

            {/* Chosen spot */}
            <div className="rounded-2xl bg-foreground/[0.05] px-3 py-2.5">
              <p className="text-[12.5px] leading-snug">{address ?? "Pin dropped on the map"}</p>
              <p className="text-[10.5px] text-muted-foreground tabular-nums mt-0.5">{coordText}</p>
            </div>

            {/* Radius */}
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-[12px] font-medium">Arrival radius</span>
                <span className="text-[13px] font-semibold tabular-nums">{fmtRadius(radius)}</span>
              </div>
              <Slider
                min={HOME_MIN_RADIUS_M}
                max={HOME_MAX_RADIUS_M}
                step={10}
                value={[radius]}
                onValueChange={(v) => setRadius(v[0])}
                onValueCommit={(v) => refit(v[0])}
                aria-label="Arrival radius in metres"
              />
              <div className="flex gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.m}
                    onClick={() => { setRadius(p.m); refit(p.m); }}
                    aria-pressed={radius === p.m}
                    className={`h-8 flex-1 rounded-full text-[11.5px] font-medium active:scale-95 transition ${radius === p.m ? "bg-primary text-primary-foreground" : "bg-foreground/[0.08]"}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <p className="text-[10.5px] text-muted-foreground leading-snug">
                Smaller is more precise; bigger catches you earlier (good for a gated society or a big building). GPS can wobble ~20–50 m indoors.
              </p>
            </div>

            {/* Name + notify */}
            <div className="flex items-center gap-2">
              <Input value={label} onChange={(e) => setLabel(e.target.value.slice(0, 40))} aria-label="Place name" placeholder="Home" className="h-10 flex-1" maxLength={40} />
            </div>
            <label className="flex items-center gap-3 rounded-2xl bg-foreground/[0.05] px-3 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{partnerName ? `Tell ${partnerName} when I get home` : "Notify my partner"}</span>
                <span className="block text-[10.5px] text-muted-foreground leading-snug">
                  {partnerName
                    ? "They only see “reached home” — never the address or pin."
                    : "Link with your partner to turn this on."}
                </span>
              </span>
              <Switch checked={!!partnerName && notify} disabled={!partnerName} onCheckedChange={setNotify} aria-label="Notify partner when I reach home" />
            </label>

            {partnerName && notify && (
              <label className="flex items-center gap-3 rounded-2xl bg-foreground/[0.05] px-3 py-2.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium">{`Also tell ${partnerName} when I leave`}</span>
                  <span className="block text-[10.5px] text-muted-foreground leading-snug">Optional. Off by default.</span>
                </span>
                <Switch checked={notifyLeave} onCheckedChange={setNotifyLeave} aria-label="Notify partner when I leave home" />
              </label>
            )}

            <div className="flex items-center gap-2 pt-1">
              {home && (
                <Button type="button" variant="ghost" onClick={handleRemove} disabled={saving} className="text-destructive shrink-0">
                  Remove
                </Button>
              )}
              <Button type="button" onClick={handleSave} disabled={saving || lat == null} className="flex-1 h-11 rounded-full">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : home ? "Save changes" : "Save Home"}
              </Button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};

export default HomePlacePanel;
