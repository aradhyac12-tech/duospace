// SoundCloud edge function — search, and stream-URL resolution, for the
// PRIMARY music provider.
//
// WHY THIS IS UNOFFICIAL: SoundCloud closed public API registration years
// ago — there is no self-serve client_id/secret a new integrator can apply
// for. Every real-world SoundCloud integration outside SoundCloud's own
// first-party apps (Discord music bots, the various "soundcloud-scraper"/
// "soundcloud-downloader" npm packages, hosted scraper services) uses the
// SAME underlying mechanism this file uses: SoundCloud's own soundcloud.com
// web player embeds a `client_id` in its public JS bundle to call
// `api-v2.soundcloud.com` (the same endpoint the website itself uses). This
// function scrapes that `client_id` the same way, caches it, and re-scrapes
// when it stops working. This is the same category of "unofficial, can
// break, mirrors what the real website's own client does" fragility this
// codebase already accepted for YouTube via Piped/Invidious in
// music-search/index.ts — not a new risk profile for this project, just
// applied to a second provider.
//
// WHAT THIS DOES NOT DO: no audio is downloaded or permanently rehosted by
// this app. `resolveStreamUrl` hands back SoundCloud's own short-lived,
// signed CDN URL — the client fetches that URL directly for playback, the
// same integration pattern already established for Audius
// (resolveAudiusStreamUrl / audius-search's own header comment).
//
// DEPLOY NOTE: self-contained like every other function in this project —
// see music-search/index.ts's header for why cross-function relative
// imports don't resolve on this deploy path.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const RL_SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const RL_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const rateLimitAdmin = createClient(RL_SUPABASE_URL, RL_SERVICE_KEY, { auth: { persistSession: false } });

async function consumeRateLimit(userId: string, bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  try {
    const { data, error } = await rateLimitAdmin.rpc("consume_rate_limit", {
      _user_id: userId, _bucket: bucket, _max: max, _window_seconds: windowSeconds,
    });
    if (error) { console.error("[rateLimit] rpc error:", error.message); return true; }
    return data === true;
  } catch (e) {
    console.error("[rateLimit] exception:", e);
    return true;
  }
}

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; DuoSpace/1.0)", ...(init?.headers ?? {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// client_id discovery — scrape it from soundcloud.com's own web bundle,
// exactly like every unofficial integration does. Cached per warm isolate;
// cleared and re-scraped once within the same request on a 401/403 so a
// stale id self-heals immediately instead of failing until the next cold
// start.
// ---------------------------------------------------------------------------
let cachedClientId: string | null = null;
let cachedClientIdAt = 0;
const CLIENT_ID_CACHE_MS = 20 * 60 * 1000; // 20 min — SoundCloud rotates this occasionally, not every request

const SCRIPT_SRC_RE = /<script[^>]+crossorigin[^>]+src="([^"]+)"/g;
const CLIENT_ID_RE = /client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/;

async function scrapeClientId(): Promise<string | null> {
  try {
    const homeRes = await fetchWithTimeout("https://soundcloud.com", 4000);
    if (!homeRes.ok) return null;
    const html = await homeRes.text();
    const scriptUrls = [...html.matchAll(SCRIPT_SRC_RE)].map((m) => m[1]);
    if (scriptUrls.length === 0) return null;

    // The bundle carrying client_id is typically among the last of the
    // crossorigin <script> tags (app/core bundles load after vendor
    // chunks) — check from the end, first match wins, capped so a change
    // in bundle count can't turn this into an unbounded fetch loop.
    for (const src of scriptUrls.slice(-8).reverse()) {
      try {
        const scriptRes = await fetchWithTimeout(src, 3000);
        if (!scriptRes.ok) continue;
        const body = await scriptRes.text();
        const match = body.match(CLIENT_ID_RE);
        if (match) return match[1];
      } catch { /* try next script */ }
    }
    return null;
  } catch (e) {
    console.warn("[soundcloud] client_id scrape failed", e instanceof Error ? e.message : e);
    return null;
  }
}

async function getClientId(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && cachedClientId && Date.now() - cachedClientIdAt < CLIENT_ID_CACHE_MS) {
    return cachedClientId;
  }
  const id = await scrapeClientId();
  if (id) { cachedClientId = id; cachedClientIdAt = Date.now(); }
  return id;
}

// ---------------------------------------------------------------------------
// Track normalization
// ---------------------------------------------------------------------------

interface ScUser { username?: string; full_name?: string; }
interface ScTranscoding { url?: string; format?: { protocol?: string; mime_type?: string } }
interface ScTrack {
  id?: number;
  title?: string;
  user?: ScUser;
  artwork_url?: string | null;
  duration?: number; // ms
  permalink_url?: string;
  streamable?: boolean;
  genre?: string;
  media?: { transcodings?: ScTranscoding[] };
}

export type NormalizedSoundCloudTrack = {
  provider: "soundcloud";
  providerTrackId: string;
  title: string;
  artist: string;
  artwork: string | null;
  duration: number; // seconds
  permalink: string | null;
  isStreamable: boolean;
};

// SoundCloud's artwork_url comes back at "-large" (100x100) by default;
// swap in the higher-res variant the same way the web player itself does.
function upsizeArtwork(url: string | null | undefined): string | null {
  if (!url) return null;
  return url.replace("-large.", "-t500x500.");
}

function normalize(t: ScTrack): NormalizedSoundCloudTrack | null {
  if (!t.id || !t.title) return null;
  return {
    provider: "soundcloud",
    providerTrackId: String(t.id),
    title: t.title,
    artist: t.user?.username ?? t.user?.full_name ?? "Unknown artist",
    artwork: upsizeArtwork(t.artwork_url),
    duration: typeof t.duration === "number" ? Math.round(t.duration / 1000) : 0,
    permalink: t.permalink_url ?? null,
    // SoundCloud marks a track `streamable: false` when the uploader has
    // disabled streaming for it (common for a track offered download-only,
    // or one restricted in some regions) — respect that instead of
    // assuming every search hit is playable, same rule audius-search
    // already applies to Audius's own `is_streamable` flag.
    isStreamable: t.streamable !== false,
  };
}

async function scApiGet(path: string, clientId: string): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetchWithTimeout(`https://api-v2.soundcloud.com${path}${sep}client_id=${clientId}`, 6000);
  if (!res.ok) throw Object.assign(new Error(`api-v2 ${path} returned ${res.status}`), { status: res.status });
  return res.json();
}

// Retries once with a freshly re-scraped client_id if the cached one has
// gone stale (401/403) — this is the self-healing behavior referenced in
// getClientId's own doc comment above.
async function scApiGetWithRetry(path: string, clientId: string): Promise<any> {
  try {
    return await scApiGet(path, clientId);
  } catch (e: any) {
    if (e?.status === 401 || e?.status === 403) {
      const fresh = await getClientId(/* forceRefresh */ true);
      if (fresh && fresh !== clientId) return scApiGet(path, fresh);
    }
    throw e;
  }
}

async function search(query: string, clientId: string): Promise<NormalizedSoundCloudTrack[]> {
  const data = await scApiGetWithRetry(
    `/search/tracks?q=${encodeURIComponent(query)}&limit=20`, clientId,
  );
  const items: ScTrack[] = Array.isArray(data?.collection) ? data.collection : [];
  return items.map(normalize).filter((t): t is NormalizedSoundCloudTrack => t !== null && t.isStreamable);
}

// Resolves a track id to an actual playable stream URL. Two hops, both
// required by SoundCloud's own API shape:
//   1. fetch the full track (fresh, not from cached search results) to get
//      its `media.transcodings` list.
//   2. GET the chosen transcoding's own `url` (itself just metadata, not
//      audio) which returns `{ url: <real, short-lived, signed CDN URL> }`.
// Prefers a `progressive` (plain MP3) transcoding when one exists — it
// plays in any `<audio>` element / native player without extra plumbing.
// Falls back to an `hls` transcoding (SoundCloud is phasing progressive
// out in favor of AAC-HLS) — native Android/iOS playback (ExoPlayer/
// AVPlayer) handles HLS natively; the web fallback engine (a plain
// HTMLAudioElement, used outside Safari) does NOT play .m3u8 without an
// HLS.js-style library, which this project does not currently bundle for
// music playback. This is a real, documented limitation of the HLS
// fallback path on non-Safari web, not a bug — see this project's existing
// "Known provider limitations" precedent in docs/MUSIC_NATIVE_PLAYBACK.md.
async function resolveStreamUrl(trackId: string, clientId: string): Promise<string | null> {
  try {
    const track: ScTrack = await scApiGetWithRetry(`/tracks/${encodeURIComponent(trackId)}`, clientId);
    const transcodings = track?.media?.transcodings ?? [];
    if (transcodings.length === 0) return null;

    const progressive = transcodings.find((t) => t.format?.protocol === "progressive");
    const hls = transcodings.find((t) => t.format?.protocol === "hls");
    const chosen = progressive ?? hls;
    if (!chosen?.url) return null;

    const streamMeta = await scApiGetWithRetry(chosen.url.replace("https://api-v2.soundcloud.com", ""), clientId);
    return typeof streamMeta?.url === "string" ? streamMeta.url : null;
  } catch (e) {
    console.warn("[soundcloud] stream resolution failed", trackId, e instanceof Error ? e.message : e);
    return null;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized", results: [] }),
      { status: 401, headers: jsonHeaders });
  }

  // Same 60/min bucket sizing rationale as audius-search: this covers
  // search AND a stream-URL resolution per track play, so a lower number
  // is reachable by ordinary browsing and would render as "no results"
  // (throttling disguised as broken search) rather than an honest 429.
  const allowed = await consumeRateLimit(user.id, "soundcloud-search", 60, 60);
  if (!allowed) {
    return new Response(JSON.stringify({ error: "Rate limit: too many requests. Slow down.", results: [] }),
      { status: 429, headers: { ...jsonHeaders, "Retry-After": "60" } });
  }

  const clientId = await getClientId();
  if (!clientId) {
    return new Response(JSON.stringify({
      error: "SoundCloud is unreachable right now. Please try again in a moment.",
      results: [],
    }), { status: 502, headers: jsonHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const mode = body?.mode === "stream" ? "stream" : "search";

    if (mode === "stream") {
      const trackId = body?.trackId;
      if (!trackId || typeof trackId !== "string") {
        return new Response(JSON.stringify({ error: "Invalid trackId", streamUrl: null }),
          { status: 400, headers: jsonHeaders });
      }
      const streamUrl = await resolveStreamUrl(trackId, clientId);
      if (!streamUrl) {
        return new Response(JSON.stringify({ error: "Track unavailable", streamUrl: null }),
          { status: 404, headers: jsonHeaders });
      }
      return new Response(JSON.stringify({ streamUrl }), { headers: jsonHeaders });
    }

    const query = body?.query;
    if (!query || typeof query !== "string" || query.length > 200) {
      return new Response(JSON.stringify({ error: "Invalid query", results: [] }),
        { status: 400, headers: jsonHeaders });
    }
    const results = await search(query, clientId);
    return new Response(JSON.stringify({ results }), { headers: jsonHeaders });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("SoundCloud error:", message);
    return new Response(JSON.stringify({
      error: "SoundCloud is unreachable right now. Please try again in a moment.",
      results: [],
    }), { status: 502, headers: jsonHeaders });
  }
});
