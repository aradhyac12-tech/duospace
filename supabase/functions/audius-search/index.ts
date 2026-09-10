// Audius edge function — search, trending, and stream-URL resolution for
// the native-background-playback music provider.
//
// WHY AUDIUS: it's the one provider in this app whose API actually hands
// back a resolvable, directly-playable audio stream URL — which is what
// makes true background/lock-screen playback possible at all without
// touching YouTube's audio (see docs/MUSIC_NATIVE_PLAYBACK.md for the
// full architecture). YouTube stays on the IFrame player for discovery —
// this function is deliberately separate from music-search/music-trending
// rather than folded into them, so the "this provider streams natively"
// vs "this provider needs the YouTube player" line stays a hard boundary
// in the code, not just a runtime flag.
//
// COST: Audius's public API requires no paid plan and no secret credential
// for the read operations used here (search, trending, stream-URL
// resolution) — only an `app_name` identifier string, which is not a
// secret (Audius's own docs use exactly this pattern for browser-side
// calls). This function still proxies through Supabase rather than being
// called directly from the client, for the same reasons music-search is
// proxied: consistent auth + rate-limiting architecture, and one place to
// swap discovery-node hosts if one goes down, mirroring the
// Piped/Invidious multi-instance fallback already established for
// YouTube. There is no secret to protect here, so this is about
// consistency and resilience, not credential hiding.
//
// DEPLOY NOTE: self-contained like music-search/music-trending (see
// music-search/index.ts's header — this deploy path can't resolve
// cross-function relative imports).
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

// `app_name` is a plain identifier Audius asks integrators to send so they
// can see aggregate usage per app in their own dashboards — explicitly NOT
// a secret per Audius's own API docs, unlike a real API key/bearer token.
// Still read from an env var (not hard-coded) so it's one place to change,
// consistent with this project's "never hard-code identifiers that might
// need to change per environment" convention even when something isn't
// sensitive.
const AUDIUS_APP_NAME = Deno.env.get("AUDIUS_APP_NAME") ?? "DuoSpace";

type AudiusTrack = {
  id: string;
  title: string;
  user?: { name?: string; handle?: string };
  artwork?: { "150x150"?: string; "480x480"?: string; "1000x1000"?: string };
  duration?: number;
  permalink?: string;
  is_streamable?: boolean;
  downloadable?: boolean;
  genre?: string;
};

export type NormalizedAudiusTrack = {
  provider: "audius";
  providerTrackId: string;
  title: string;
  artist: string;
  artwork: string | null;
  duration: number;
  permalink: string | null;
  isStreamable: boolean;
  isDownloadable: boolean;
};

function normalize(t: AudiusTrack): NormalizedAudiusTrack {
  return {
    provider: "audius",
    providerTrackId: t.id,
    title: t.title ?? "Unknown",
    artist: t.user?.name ?? t.user?.handle ?? "Unknown artist",
    artwork: t.artwork?.["480x480"] ?? t.artwork?.["1000x1000"] ?? t.artwork?.["150x150"] ?? null,
    duration: typeof t.duration === "number" ? t.duration : 0,
    permalink: t.permalink ?? null,
    // Audius marks a track `is_streamable: false` when the uploader has
    // disabled streaming, or the track is otherwise restricted — respect
    // that instead of assuming every returned track is playable. Missing
    // the field entirely (older API responses) is treated as streamable,
    // matching Audius's own default.
    isStreamable: t.is_streamable !== false,
    isDownloadable: Boolean(t.downloadable),
  };
}

// Discovery-node host list — fetched fresh per cold start (Deno edge
// functions are re-invoked per isolate, not long-lived processes, so a
// short in-memory cache still meaningfully cuts down on repeat lookups
// within a warm isolate without needing external storage for it).
//
// ROOT-CAUSE FIX ("Audius always shows no results"): api.audius.co's
// discovery response changed shape over time and now returns just
// ["https://api.audius.co"] — itself. Taking that array verbatim gave
// this function a ONE-host list with zero redundancy: any single bad
// response from that host (cold-start slowness, datacenter-IP throttling,
// a 5xx blip) exhausted the retry loop immediately and surfaced to the
// client as an empty search, i.e. "No Audius results", while the hardcoded
// discoveryprovider fallbacks below sat unused because the lookup itself
// had technically "succeeded". Fixed by MERGING whatever the discovery
// endpoint returns with the known-stable discovery nodes (deduped,
// dynamic hosts first) so there are always multiple independent hosts
// to fall through, and by timing out the discovery fetch itself so a
// hung lookup can't stall the whole request.
let cachedHosts: string[] | null = null;
let cachedHostsAt = 0;
const HOST_CACHE_MS = 10 * 60 * 1000;

// Known-stable Audius discovery nodes. Always merged into the host list
// (after whatever the discovery endpoint returned, deduped) so the
// per-request loop always has real fallbacks even when the discovery
// endpoint answers with a degenerate list like [api.audius.co].
const KNOWN_HOSTS = [
  "https://discoveryprovider.audius.co",
  "https://discoveryprovider2.audius.co",
  "https://discoveryprovider3.audius.co",
];

async function getDiscoveryHosts(): Promise<string[]> {
  if (cachedHosts && Date.now() - cachedHostsAt < HOST_CACHE_MS) return cachedHosts;
  let discovered: string[] = [];
  try {
    // 2s cap on discovery itself — it must never be the reason a search
    // stalls or fails; KNOWN_HOSTS below is an acceptable answer.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch("https://api.audius.co", { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`api.audius.co returned ${res.status}`);
    const data = await res.json();
    discovered = Array.isArray(data?.data) ? data.data.filter((h: unknown) => typeof h === "string") : [];
  } catch (e) {
    console.warn("[audius] host discovery failed, using known hosts", e instanceof Error ? e.message : e);
  }
  // Dynamic hosts first (they're what Audius currently recommends), then
  // the known-stable nodes we've verified respond — deduped.
  const merged = [...new Set([...discovered, ...KNOWN_HOSTS])].filter(Boolean);
  if (merged.length > 0) {
    cachedHosts = merged;
    cachedHostsAt = Date.now();
    return merged;
  }
  return KNOWN_HOSTS;
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { headers: { "User-Agent": "DuoSpace/1.0" }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Tries each discovery host in turn (not in parallel, unlike Piped/
// Invidious search) — Audius's hosts are generally reliable and this
// avoids fanning out N simultaneous requests for what's normally a
// first-host success; falls through to the next host only on failure.
async function audiusGet(path: string): Promise<any> {
  const hosts = await getDiscoveryHosts();
  let lastError: unknown = null;
  for (const host of hosts.slice(0, 5)) {
    try {
      const sep = path.includes("?") ? "&" : "?";
      // 8s (was 4s): a cold discovery node behind a cold CDN can easily
      // take >4s to first byte; timing out a healthy-but-slow host made
      // searches fail spuriously even when the very next host answered.
      const res = await fetchWithTimeout(`${host}${path}${sep}app_name=${encodeURIComponent(AUDIUS_APP_NAME)}`, 8000);
      if (!res.ok) { lastError = new Error(`${host} returned ${res.status}`); continue; }
      return await res.json();
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All Audius discovery hosts failed");
}

async function search(query: string): Promise<NormalizedAudiusTrack[]> {
  const data = await audiusGet(`/v1/tracks/search?query=${encodeURIComponent(query)}`);
  const items: AudiusTrack[] = Array.isArray(data?.data) ? data.data : [];
  return items.map(normalize).filter((t) => t.isStreamable);
}

async function trending(genre?: string): Promise<NormalizedAudiusTrack[]> {
  const genreParam = genre ? `&genre=${encodeURIComponent(genre)}` : "";
  const data = await audiusGet(`/v1/tracks/trending?${genreParam.slice(1)}`);
  const items: AudiusTrack[] = Array.isArray(data?.data) ? data.data : [];
  return items.map(normalize).filter((t) => t.isStreamable);
}

// Resolves a track id to the actual streamable URL. Audius's own
// /v1/tracks/{id}/stream endpoint 302-redirects to the real audio file —
// this returns that redirect target rather than proxying the audio bytes
// through this function (which would burn edge-function compute/egress
// for no reason and add a hop of latency for every second of every song).
// The native player fetches the returned URL directly, exactly like it
// would fetch any other direct media URL.
async function resolveStreamUrl(trackId: string): Promise<string | null> {
  const hosts = await getDiscoveryHosts();
  for (const host of hosts.slice(0, 5)) {
    try {
      const url = `${host}/v1/tracks/${encodeURIComponent(trackId)}/stream?app_name=${encodeURIComponent(AUDIUS_APP_NAME)}`;
      const res = await fetchWithTimeout(url, 4000);
      // `redirect: "manual"` isn't available via the plain fetch() redirect
      // option in every runtime the same way — simplest reliable approach:
      // a HEAD-like GET here would download the whole file, so instead we
      // hand back the resolvable URL itself. Audius's stream endpoint is
      // designed to be used directly as a <source>/player URL (that's the
      // documented integration pattern), so returning `url` unmodified is
      // correct — the native player performs the actual GET (and follows
      // the redirect) when it starts playback, not this function.
      if (res.ok || res.status === 302 || res.status === 301) return url;
    } catch { /* try next host */ }
  }
  return null;
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

  // 60/min (was 30): this one bucket covers search AND trending AND a
  // stream-URL resolution per track play, so 30 was reachable by ordinary
  // browsing — and the resulting 429 rendered client-side as "no results",
  // reading as broken search rather than throttling.
  const allowed = await consumeRateLimit(user.id, "audius-search", 60, 60);
  if (!allowed) {
    return new Response(JSON.stringify({ error: "Rate limit: too many requests. Slow down.", results: [] }),
      { status: 429, headers: { ...jsonHeaders, "Retry-After": "60" } });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const mode = body?.mode === "trending" || body?.mode === "stream" ? body.mode : "search";

    if (mode === "stream") {
      const trackId = body?.trackId;
      if (!trackId || typeof trackId !== "string") {
        return new Response(JSON.stringify({ error: "Invalid trackId", streamUrl: null }),
          { status: 400, headers: jsonHeaders });
      }
      const streamUrl = await resolveStreamUrl(trackId);
      if (!streamUrl) {
        return new Response(JSON.stringify({ error: "Track unavailable", streamUrl: null }),
          { status: 404, headers: jsonHeaders });
      }
      return new Response(JSON.stringify({ streamUrl }), { headers: jsonHeaders });
    }

    if (mode === "trending") {
      const results = await trending(typeof body?.genre === "string" ? body.genre : undefined);
      return new Response(JSON.stringify({ results }), { headers: jsonHeaders });
    }

    const query = body?.query;
    if (!query || typeof query !== "string" || query.length > 200) {
      return new Response(JSON.stringify({ error: "Invalid query", results: [] }),
        { status: 400, headers: jsonHeaders });
    }
    const results = await search(query);
    return new Response(JSON.stringify({ results }), { headers: jsonHeaders });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Audius error:", message);
    return new Response(JSON.stringify({
      error: "Audius is unreachable right now. Please try again in a moment.",
      results: [],
    }), { status: 502, headers: jsonHeaders });
  }
});
