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

// FIX (SoundCloud not playing): soundcloud.com serves a stripped page (no
// player bundles, hence no client_id) to obvious bot user-agents like the old
// "compatible; DuoSpace/1.0", so the client_id scrape failed and EVERY call
// came back as "SoundCloud is unreachable". Send an ordinary browser UA.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9", ...(init?.headers ?? {}) },
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

// Any <script src> on SoundCloud's asset CDN (the old regex also required a
// `crossorigin` attribute, which silently stopped matching when the markup changed).
const SCRIPT_SRC_RES = [
  /<script[^>]+crossorigin[^>]+src="([^"]+)"/g,
  /<script[^>]+src="(https:\/\/[^"]*sndcdn\.com\/assets\/[^"]+\.js)"/g,
];
const CLIENT_ID_RES = [
  /client_id\s*[:=]\s*"([a-zA-Z0-9]{32})"/,
  /"client_id"\s*:\s*"([a-zA-Z0-9]{32})"/,
  /[?&]client_id=([a-zA-Z0-9]{32})/,
];
// Optional hard fallback: set SOUNDCLOUD_CLIENT_ID as an edge-function secret
// to keep music working even if scraping is blocked from the datacenter IP.
const ENV_CLIENT_ID = Deno.env.get("SOUNDCLOUD_CLIENT_ID") || null;

/** Resolves with the first non-null result, or null once every task settled empty. */
function firstNonNull<T>(tasks: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = tasks.length;
    if (pending === 0) { resolve(null); return; }
    for (const t of tasks) {
      t.then((v) => { if (v !== null) resolve(v); }, () => { /* ignore */ })
        .finally(() => { if (--pending === 0) resolve(null); });
    }
  });
}

async function scrapeClientId(): Promise<string | null> {
  try {
    const homeRes = await fetchWithTimeout("https://soundcloud.com", 4000);
    if (!homeRes.ok) return null;
    const html = await homeRes.text();
    const urls = new Set<string>();
    for (const re of SCRIPT_SRC_RES) for (const m of html.matchAll(re)) urls.add(m[1]);
    if (urls.size === 0) return null;

    // SPEED FIX: the bundles used to be fetched one after another (up to
    // 8 x 3s on a cold isolate). Fetch the last few in PARALLEL and take the
    // first one that carries a client_id.
    const candidates = [...urls].slice(-10).reverse();
    return await firstNonNull(candidates.map(async (src) => {
      const r = await fetchWithTimeout(src, 4000);
      if (!r.ok) return null;
      const body = await r.text();
      for (const re of CLIENT_ID_RES) { const m = body.match(re); if (m) return m[1]; }
      return null;
    }));
  } catch (e) {
    console.warn("[soundcloud] client_id scrape failed", e instanceof Error ? e.message : e);
    return null;
  }
}

let clientIdInflight: Promise<string | null> | null = null;
async function getClientId(forceRefresh = false): Promise<string | null> {
  if (!forceRefresh && cachedClientId && Date.now() - cachedClientIdAt < CLIENT_ID_CACHE_MS) {
    return cachedClientId;
  }
  // One scrape at a time, shared by every concurrent caller.
  if (!clientIdInflight) {
    clientIdInflight = scrapeClientId().finally(() => { clientIdInflight = null; });
  }
  const id = (await clientIdInflight) ?? (forceRefresh ? null : cachedClientId) ?? ENV_CLIENT_ID;
  if (id) { cachedClientId = id; cachedClientIdAt = Date.now(); }
  return id;
}

// ---------------------------------------------------------------------------
// Track normalization
// ---------------------------------------------------------------------------

interface ScUser { username?: string; full_name?: string; }
interface ScTranscoding { url?: string; preset?: string; format?: { protocol?: string; mime_type?: string } }
interface ScTrack {
  id?: number;
  title?: string;
  user?: ScUser;
  artwork_url?: string | null;
  duration?: number; // ms
  permalink_url?: string;
  streamable?: boolean;
  genre?: string;
  policy?: string; // ALLOW | MONETIZE | SNIP (30s preview) | BLOCK (not playable here)
  media?: { transcodings?: ScTranscoding[] };
  track_authorization?: string;
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
    // FIX: SNIP = 30-second Go+ preview, BLOCK = not playable for us at all.
    // Both used to be listed as normal songs and then "played" a 30s clip or failed.
    isStreamable: t.streamable !== false && t.policy !== "BLOCK" && t.policy !== "SNIP" && hasPlayableTranscoding(t),
  };
}

// Which transcoding can the NATIVE player (ExoPlayer) actually play?
//   progressive MP3        -> plays everywhere, starts fastest      (rank 0)
//   HLS AAC (audio/mp4)    -> ExoPlayer HLS handles it              (rank 1)
//   HLS MP3 (audio/mpeg)   -> ExoPlayer HLS handles it              (rank 2)
//   HLS Opus (audio/ogg)   -> Ogg segments are NOT supported by ExoPlayer's HLS (excluded)
// FIX (SoundCloud not playing): the old code took "the first hls", which is
// very often the Opus/Ogg variant — a URL that resolves fine and then never plays.
function transcodingRank(t: ScTranscoding): number {
  const proto = t.format?.protocol;
  const mime = (t.format?.mime_type ?? "").toLowerCase();
  const preset = (t.preset ?? "").toLowerCase();
  if (!t.url) return -1;
  if (mime.includes("ogg") || mime.includes("opus") || preset.startsWith("opus")) return -1;
  if (proto === "progressive") return 0;
  if (proto === "hls") return mime.includes("mp4") || mime.includes("aac") || preset.startsWith("aac") ? 1 : 2;
  return -1;
}
// Progressive streams are being phased out by SoundCloud: the production logs
// show /stream/progressive answering 404 for most tracks. When that happens we
// remember it for a while and try HLS FIRST, so those tracks don't pay a failed
// request on every play.
let progressiveBadUntil = 0;
const progressiveLooksBroken = () => Date.now() < progressiveBadUntil;

/** Playable transcodings, best first (progressive demoted while it looks broken). */
function rankedTranscodings(list: ScTranscoding[] | undefined): ScTranscoding[] {
  const demote = progressiveLooksBroken();
  return (list ?? [])
    .map((t) => ({ t, r: transcodingRank(t) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => (demote ? (a.r === 0 ? 3 : a.r) - (b.r === 0 ? 3 : b.r) : a.r - b.r))
    .map((x) => x.t);
}
function pickTranscoding(list: ScTranscoding[] | undefined): ScTranscoding | null {
  return rankedTranscodings(list)[0] ?? null;
}
// Search results that DO carry media info must have something we can play;
// results with no media block at all are kept (resolved later via /tracks/:id).
function hasPlayableTranscoding(t: ScTrack): boolean {
  const list = t.media?.transcodings;
  if (!Array.isArray(list) || list.length === 0) return !t.media;
  return pickTranscoding(list) !== null;
}

// SPEED FIX: search results already contain each track's transcodings and
// track_authorization — the exact data the first of the two resolve hops
// fetches again. Remember it (per warm isolate) so tapping a search result
// costs ONE SoundCloud request instead of two.
const HINT_TTL_MS = 25 * 60 * 1000;
const HINT_MAX = 600;
const mediaHints = new Map<string, { transcodings: ScTranscoding[]; auth?: string; at: number }>();
function rememberHint(t: ScTrack) {
  if (!t.id || !t.media?.transcodings?.length) return;
  mediaHints.set(String(t.id), { transcodings: t.media.transcodings, auth: t.track_authorization, at: Date.now() });
  if (mediaHints.size > HINT_MAX) mediaHints.delete(mediaHints.keys().next().value as string);
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
    `/search/tracks?q=${encodeURIComponent(query)}&limit=30`, clientId,
  );
  const items: ScTrack[] = Array.isArray(data?.collection) ? data.collection : [];
  items.forEach(rememberHint);
  return items.map(normalize).filter((t): t is NormalizedSoundCloudTrack => t !== null && t.isStreamable && !isDead(t.providerTrackId));
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
// RELIABILITY: a track whose every playable variant failed is remembered as
// dead for a few minutes, per warm isolate. Production logs showed the same few
// dead tracks being re-resolved 14x in a minute (client retries + prefetch), each
// costing 2-4 SoundCloud requests and a rate-limit unit. Dead tracks now answer
// instantly, and are hidden from search results so they never reach the queue.
const DEAD_TTL_MS = 5 * 60 * 1000;
const DEAD_MAX = 400;
const deadTracks = new Map<string, number>();
const isDead = (id: string): boolean => {
  const at = deadTracks.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > DEAD_TTL_MS) { deadTracks.delete(id); return false; }
  return true;
};
const markDead = (id: string) => {
  deadTracks.set(id, Date.now());
  if (deadTracks.size > DEAD_MAX) deadTracks.delete(deadTracks.keys().next().value as string);
};

async function streamFromTranscodings(transcodings: ScTranscoding[], auth: string | undefined, clientId: string, failures: string[] = []): Promise<string | null> {
  // FIX (many songs "don't play" and get skipped): the old code resolved ONE
  // transcoding (progressive first) and gave up when that endpoint 404'd. Now
  // every playable transcoding is tried in order (progressive -> HLS AAC ->
  // HLS MP3) until one hands back a real URL.
  for (const chosen of rankedTranscodings(transcodings)) {
    if (!chosen.url) continue;
    // The stream endpoint wants the per-track `track_authorization` token that
    // comes back on the track object; without it some tracks 401. Harmless when absent.
    let path = chosen.url.replace("https://api-v2.soundcloud.com", "");
    if (auth) path += `${path.includes("?") ? "&" : "?"}track_authorization=${encodeURIComponent(auth)}`;
    try {
      const streamMeta = await scApiGetWithRetry(path, clientId);
      if (typeof streamMeta?.url === "string") return streamMeta.url;
      failures.push(`${chosen.format?.protocol}:no-url`);
    } catch (e: any) {
      if (chosen.format?.protocol === "progressive" && e?.status === 404) progressiveBadUntil = Date.now() + 10 * 60 * 1000;
      // 404/401/403 on this variant: try the next one. Anything else (timeout, 5xx) too.
      failures.push(`${chosen.format?.protocol}:${e?.status ?? (e?.name === "AbortError" ? "timeout" : "err")}`);
    }
  }
  return null;
}

async function resolveStreamUrlUncached(trackId: string, clientId: string): Promise<string | null> {
  if (isDead(trackId)) return null; // failed moments ago — don't burn requests re-trying it
  const failures: string[] = [];
  // Fast path: transcodings remembered from the search that listed this track (1 hop).
  const hint = mediaHints.get(trackId);
  if (hint && Date.now() - hint.at < HINT_TTL_MS) {
    try {
      const url = await streamFromTranscodings(hint.transcodings, hint.auth, clientId, failures);
      if (url) return url;
    } catch { /* hint stale (expired authorization etc.) — fall through to a fresh track fetch */ }
    mediaHints.delete(trackId);
  }
  try {
    const track: ScTrack = await scApiGetWithRetry(`/tracks/${encodeURIComponent(trackId)}`, clientId);
    if (track?.policy === "BLOCK") { markDead(trackId); return null; }
    const url = await streamFromTranscodings(track?.media?.transcodings ?? [], track?.track_authorization, clientId, failures);
    if (!url) {
      // Now says WHY (per-variant HTTP status), not just which formats exist.
      console.warn("[soundcloud] no transcoding resolved", trackId, "policy=" + (track?.policy ?? "?"), "failures=" + failures.join("|"));
      // Only a DEFINITIVE answer (401/403/404/410 / no URL) marks the track dead; a run of
      // timeouts / 5xx is transient and must stay retryable.
      if (failures.length === 0 || failures.some((f) => /:(401|403|404|410|no-url)$/.test(f))) markDead(trackId);
    }
    return url;
  } catch (e) {
    console.warn("[soundcloud] stream resolution failed", trackId, e instanceof Error ? e.message : e);
    return null;
  }
}

// SPEED FIX: every play/next/previous used to pay two sequential SoundCloud
// API round-trips (+ auth + rate-limit + client_id) even for a track resolved
// seconds earlier (e.g. skipping back, or the client prefetching it). Keep
// resolved URLs per warm isolate for a few minutes and share one in-flight
// request between concurrent callers. The signed CDN URLs are short-lived, so
// the TTL is deliberately conservative; the client also re-resolves on a
// playback error (see GroicContext retryCurrent).
const STREAM_CACHE_TTL_MS = 4 * 60 * 1000;
const STREAM_CACHE_MAX = 300;
const streamCache = new Map<string, { url: string; at: number }>();
const streamInflight = new Map<string, Promise<string | null>>();

async function resolveStreamUrl(trackId: string, clientId: string, bypassCache = false): Promise<string | null> {
  if (bypassCache) deadTracks.delete(trackId); // an explicit fresh retry always gets one real attempt
  const hit = streamCache.get(trackId);
  if (!bypassCache && hit && Date.now() - hit.at < STREAM_CACHE_TTL_MS) return hit.url;
  const inflight = streamInflight.get(trackId);
  if (inflight) return inflight;
  const p = resolveStreamUrlUncached(trackId, clientId)
    .then((url) => {
      if (url) {
        streamCache.set(trackId, { url, at: Date.now() });
        if (streamCache.size > STREAM_CACHE_MAX) streamCache.delete(streamCache.keys().next().value as string);
      } else {
        streamCache.delete(trackId);
      }
      return url;
    })
    .finally(() => { streamInflight.delete(trackId); });
  streamInflight.set(trackId, p);
  return p;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  // SPEED FIX: everything independent of each other starts NOW and overlaps:
  // the client_id lookup (a slow scrape on a cold isolate), reading the body,
  // and the auth check. They used to run one after another.
  const clientIdPromise = getClientId().catch(() => null);
  const bodyPromise: Promise<any> = req.json().catch(() => ({}));

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
  // SPEED FIX: the rate-limit RPC (a database round-trip) now runs IN PARALLEL
  // with the SoundCloud work instead of before it; if the limit turns out to be
  // exceeded the work is simply discarded.
  const rateLimitPromise = consumeRateLimit(user.id, "soundcloud-search", 60, 60);
  const tooMany = () => new Response(JSON.stringify({ error: "Rate limit: too many requests. Slow down.", results: [] }),
    { status: 429, headers: { ...jsonHeaders, "Retry-After": "60" } });

  try {
    const body = await bodyPromise;
    const mode = body?.mode === "stream" ? "stream" : body?.mode === "streams" ? "streams" : "search";

    const clientId = await clientIdPromise;
    if (!clientId) {
      if (!(await rateLimitPromise)) return tooMany();
      return new Response(JSON.stringify({
        error: "SoundCloud is unreachable right now. Please try again in a moment.",
        results: [],
      }), { status: 502, headers: jsonHeaders });
    }

    if (mode === "streams") {
      // Batch resolve (prefetch of the next/previous few tracks): ONE request,
      // ONE rate-limit unit, resolved in parallel server-side. Per-track
      // failures come back as null so one dead track never fails the batch.
      const ids: unknown = body?.trackIds;
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 6 || !ids.every((x) => typeof x === "string" && x.length > 0 && x.length < 40)) {
        return new Response(JSON.stringify({ error: "Invalid trackIds", streams: {} }), { status: 400, headers: jsonHeaders });
      }
      const unique = [...new Set(ids as string[])];
      const work = Promise.all(unique.map(async (id) => [id, await resolveStreamUrl(id, clientId)] as const));
      if (!(await rateLimitPromise)) { work.catch(() => {}); return tooMany(); }
      const entries = await work;
      return new Response(JSON.stringify({ streams: Object.fromEntries(entries) }), { headers: jsonHeaders });
    }

    if (mode === "stream") {
      const trackId = body?.trackId;
      if (!trackId || typeof trackId !== "string") {
        return new Response(JSON.stringify({ error: "Invalid trackId", streamUrl: null }),
          { status: 400, headers: jsonHeaders });
      }
      // `fresh: true` = the client's playback of a previously resolved URL
      // failed (expired signature): skip the cache and re-resolve.
      const work = resolveStreamUrl(trackId, clientId, body?.fresh === true);
      if (!(await rateLimitPromise)) { work.catch(() => {}); return tooMany(); }
      const streamUrl = await work;
      if (!streamUrl) {
        return new Response(JSON.stringify({ error: "Track unavailable", streamUrl: null }),
          { status: 404, headers: jsonHeaders });
      }
      return new Response(JSON.stringify({ streamUrl }), { headers: jsonHeaders });
    }

    if (!(await rateLimitPromise)) return tooMany();
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
