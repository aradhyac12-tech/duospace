/**
 * Tiny address search / reverse lookup for the Home picker, backed by
 * OpenStreetMap Nominatim (the same OSM data the Street map already uses).
 *
 * Usage-policy friendly: callers debounce (>= 450 ms), requests are
 * abortable, results are cached per session, and nothing is sent that
 * identifies the user. Free public service with no SLA — every failure path
 * resolves to an empty result so the picker keeps working by dragging the map.
 */

export interface GeoResult {
  label: string;
  lat: number;
  lng: number;
}

const BASE = "https://nominatim.openstreetmap.org";
const searchCache = new Map<string, GeoResult[]>();
const reverseCache = new Map<string, string | null>();

const lang = () =>
  (typeof navigator !== "undefined" && navigator.language ? navigator.language : "en").split(",")[0];

const shorten = (name: string) => {
  // "12, Some Street, Suburb, City, District, State, 123456, India" -> keep it readable.
  const parts = name.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length > 4 ? [...parts.slice(0, 3), parts[parts.length - 1]].join(", ") : parts.join(", ");
};

export async function searchAddress(query: string, signal?: AbortSignal, near?: { lat: number; lng: number }): Promise<GeoResult[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const key = `${q.toLowerCase()}|${near ? `${near.lat.toFixed(1)},${near.lng.toFixed(1)}` : ""}`;
  const hit = searchCache.get(key);
  if (hit) return hit;
  try {
    const params = new URLSearchParams({ q, format: "jsonv2", limit: "6", addressdetails: "0", "accept-language": lang() });
    if (near) {
      // Soft bias (not a hard filter) toward where the person already is.
      const d = 0.6;
      params.set("viewbox", `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
    }
    const res = await fetch(`${BASE}/search?${params}`, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<{ display_name?: string; lat?: string; lon?: string }>;
    const out: GeoResult[] = [];
    for (const r of rows) {
      const lat = Number(r.lat), lng = Number(r.lon);
      if (!r.display_name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      out.push({ label: shorten(r.display_name), lat, lng });
    }
    searchCache.set(key, out);
    return out;
  } catch {
    return [];
  }
}

export async function reverseAddress(lat: number, lng: number, signal?: AbortSignal): Promise<string | null> {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  if (reverseCache.has(key)) return reverseCache.get(key) ?? null;
  try {
    const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: "jsonv2", zoom: "18", "accept-language": lang() });
    const res = await fetch(`${BASE}/reverse?${params}`, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { display_name?: string };
    const label = j.display_name ? shorten(j.display_name) : null;
    reverseCache.set(key, label);
    return label;
  } catch {
    return null;
  }
}
