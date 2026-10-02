// Music search edge function — auth required + persistent rate limit.
//
// DEPLOY NOTE: _shared/cors.ts and _shared/rateLimit.ts are inlined below
// instead of imported — this project's own deploy history
// (FIXES.md #19) already established that this deploy path can't resolve
// cross-function relative imports, so every function here ships self-
// contained.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
};

const RL_SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const RL_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const rateLimitAdmin = createClient(RL_SUPABASE_URL, RL_SERVICE_KEY, { auth: { persistSession: false } });

async function consumeRateLimit(userId: string, bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  try {
    const { data, error } = await rateLimitAdmin.rpc("consume_rate_limit", {
      _user_id: userId, _bucket: bucket, _max: max, _window_seconds: windowSeconds,
    });
    if (error) {
      console.error("[rateLimit] rpc error:", error.message);
      // Fail open — never block a legitimate user on infrastructure errors,
      // but log loudly so it's visible.
      return true;
    }
    return data === true;
  } catch (e) {
    console.error("[rateLimit] exception:", e);
    return true;
  }
}

const YT_KEY = Deno.env.get("Youtube_api_key");

type MusicResult = {
  title: string;
  artist: string;
  videoId: string;
  thumbnail: string;
  duration: number;
  url: string;
};

const isoDurationToSeconds = (iso: string): number => {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (Number(m[1] ?? 0) * 3600) + (Number(m[2] ?? 0) * 60) + Number(m[3] ?? 0);
};

// NOTE: there is deliberately NO curated/mock fallback pool here. The
// previously-live version of this function (redeployed over, 2026-08-19)
// fell back to 6 hardcoded songs (Stephen Sanchez, Ed Sheeran, Billie
// Eilish, One Direction, Glass Animals, JVKE) whenever every real provider
// failed, returning them as a normal 200 response — which is exactly why
// search and "Trending" always showed the same unrelated songs no matter
// what was searched. Returning six hardcoded love songs for every failed
// search made an outage look like a working search with bizarre results,
// which is worse than an honest error the client can retry. If every
// provider fails we now return 502 with a real message instead.

async function searchYouTubeAPI(query: string): Promise<{ results: MusicResult[]; debug: string }> {
  if (!YT_KEY) return { results: [], debug: "youtube: no Youtube_api_key secret configured" };
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=20&q=${encodeURIComponent(query)}&key=${YT_KEY}`;
  const sRes = await fetch(searchUrl);
  if (!sRes.ok) {
    const body = await sRes.text();
    console.error("YouTube search failed", sRes.status, body);
    return { results: [], debug: `youtube: HTTP ${sRes.status} — ${body.slice(0, 200)}` };
  }
  const sData = await sRes.json();
  const ids = (sData.items ?? []).map((i: any) => i.id?.videoId).filter(Boolean);
  if (ids.length === 0) return { results: [], debug: "youtube: 0 results for this query" };
  const dRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids.join(",")}&key=${YT_KEY}`);
  const dData = await dRes.json();
  const results = (dData.items ?? []).map((v: any): MusicResult => ({
    title: v.snippet?.title ?? "Unknown",
    artist: v.snippet?.channelTitle ?? "Unknown",
    videoId: v.id,
    thumbnail: v.snippet?.thumbnails?.high?.url ?? `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
    duration: isoDurationToSeconds(v.contentDetails?.duration ?? "PT0S"),
    url: `https://www.youtube.com/watch?v=${v.id}`,
  }));
  return { results, debug: `youtube: ${results.length} results` };
}

interface PipedItem {
  url?: string; title?: string; uploaderName?: string;
  thumbnail?: string; duration?: number;
}

// Per-request deadline. A dead/slow mirror used to be able to hang this
// whole function past the client's 15s timeout; every outbound mirror
// request now aborts on its own short deadline instead.
async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { headers: { "User-Agent": "DuoSpace/1.0" }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Races every Piped instance in parallel (single filter) so the whole
// stage finishes in ~3s worst case, instead of a sequential loop that
// could burn far past the client's 15s budget.
async function searchPiped(query: string): Promise<{ results: MusicResult[]; debug: string }> {
  // Instance list verified live against this project's own edge function
  // logs (2026-08-19): pipedapi.r4fo.com, api.piped.yt, and
  // piped-api.privacy.com.de were all failing with DNS resolution errors
  // (genuinely unreachable, not a code bug), pipedapi.leptons.xyz was
  // returning 502, and pipedapi.adminforge.de was returning 404 — i.e.
  // every single instance in the old list was failing on every search.
  // Refreshed against TeamPiped's current maintained list
  // (github.com/TeamPiped/Piped/wiki/Instances). pipedapi.kavin.rocks is
  // the flagship official instance (CDN-backed) and the most likely to
  // stay up long-term; api.piped.yt kept since the official list still
  // shows it current (the DNS failure may be transient/regional).
  const instances = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.owo.si",
    "https://api.piped.yt",
    "https://piped-api.codespace.cz",
    "https://pipedapi.ducks.party",
  ];
  const filter = "music_songs";

  const attempts = instances.map(async (inst): Promise<MusicResult[]> => {
    const res = await fetchWithTimeout(
      `${inst}/search?q=${encodeURIComponent(query)}&filter=${filter}`,
      3000,
    );
    if (!res.ok) { await res.text(); throw new Error(`${inst} returned ${res.status}`); }
    const data = await res.json();
    const items = (data.items as PipedItem[] | undefined) ?? [];
    const mapped = items
      .filter((i) => i.url && i.title)
      .slice(0, 20)
      .map((i): MusicResult => {
        const videoId = i.url!.replace("/watch?v=", "");
        return {
          title: i.title ?? "Unknown",
          artist: i.uploaderName ?? "Unknown",
          videoId,
          thumbnail: i.thumbnail ?? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
          duration: i.duration ?? 0,
          url: `https://www.youtube.com/watch?v=${videoId}`,
        };
      });
    if (mapped.length === 0) throw new Error(`${inst} returned no usable items`);
    return mapped;
  });

  const settled = await Promise.allSettled(attempts);
  const failures: string[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value.length > 0) {
      return { results: result.value, debug: `piped: ${result.value.length} results (${settled.filter(s=>s.status==="rejected").length}/${instances.length} instances failed)` };
    }
  }
  for (const result of settled) {
    if (result.status === "rejected") {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn("piped instance failed", msg);
      failures.push(msg);
    }
  }
  return { results: [], debug: `piped: all ${instances.length} instances failed — ${failures.join(" | ")}` };
}

interface InvidiousItem {
  videoId?: string; title?: string; author?: string;
  lengthSeconds?: number; videoThumbnails?: { url?: string }[];
}

// Second independent provider. Piped mirrors and Invidious mirrors go down
// at different times and for different reasons, so having both makes a
// total search outage far less likely than Piped alone — the previously
// live version of this function had ONLY YouTube -> Piped -> a hardcoded
// mock pool, no independent second real provider at all.
async function searchInvidious(query: string): Promise<{ results: MusicResult[]; debug: string }> {
  // Instance list refreshed against docs.invidious.io/instances — yewtu.be
  // is explicitly flagged by multiple independent 2026 sources as
  // unreliable ("sometimes works, sometimes inaccessible").
  const instances = [
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://invidious.tiekoetter.com",
    "https://yt.chocolatemoo53.com",
  ];

  const attempts = instances.map(async (inst): Promise<MusicResult[]> => {
    const res = await fetchWithTimeout(
      `${inst}/api/v1/search?q=${encodeURIComponent(query)}&type=video&sort_by=relevance`,
      3500,
    );
    if (!res.ok) { await res.text(); throw new Error(`${inst} returned ${res.status}`); }
    const data = await res.json();
    const items = (Array.isArray(data) ? data : []) as InvidiousItem[];
    const mapped = items
      .filter((i) => i.videoId && i.title)
      .slice(0, 20)
      .map((i): MusicResult => ({
        title: i.title!,
        artist: i.author ?? "Unknown",
        videoId: i.videoId!,
        thumbnail: i.videoThumbnails?.[0]?.url ?? `https://img.youtube.com/vi/${i.videoId}/mqdefault.jpg`,
        duration: i.lengthSeconds ?? 0,
        url: `https://www.youtube.com/watch?v=${i.videoId}`,
      }));
    if (mapped.length === 0) throw new Error(`${inst} returned no usable items`);
    return mapped;
  });

  const settled = await Promise.allSettled(attempts);
  const failures: string[] = [];
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value.length > 0) {
      return { results: result.value, debug: `invidious: ${result.value.length} results (${settled.filter(s=>s.status==="rejected").length}/${instances.length} instances failed)` };
    }
  }
  for (const result of settled) {
    if (result.status === "rejected") {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn("invidious instance failed", msg);
      failures.push(msg);
    }
  }
  return { results: [], debug: `invidious: all ${instances.length} instances failed — ${failures.join(" | ")}` };
}

// ---------------------------------------------------------------------------
// Result quality: dedup + rank
//
// Root cause of "too much garbage" / "queue has the same song from random
// channels": every provider above is a raw YouTube-adjacent search with no
// notion of "this is the same song" or "this upload is junk". A single
// query like "bad guy" comes back with the official track PLUS slowed+reverb
// edits, 1-hour loops, reaction videos, karaoke/instrumental versions, and
// the same song re-uploaded by five different channels — all of which used
// to be added to search results (and therefore the shared queue) verbatim.
// This pass runs after every provider and before the response is sent, so
// the fix applies no matter which provider answered.
// ---------------------------------------------------------------------------

// Title noise to strip before comparing two results for "is this the same
// song" — bracketed/parenthetical tags, feat./ft. credits, quality tags.
const NOISE_RE = /[\(\[][^)\]]*(official|video|audio|lyric|lyrics|hd|hq|4k|visualizer|mv|explicit|clean|prod\.?|remaster(ed)?)[^)\]]*[\)\]]/gi;
const FEAT_RE = /\b(feat\.?|ft\.?|featuring)\b.*/i;
const PUNCT_RE = /[^a-z0-9]+/g;

function normalizeKey(title: string, artist: string): string {
  let t = title.toLowerCase();
  t = t.replace(NOISE_RE, " ");
  t = t.replace(FEAT_RE, " ");
  t = t.replace(PUNCT_RE, " ").trim();
  // Strip a "- Topic" suffix (auto-generated official audio channels) so it
  // doesn't get treated as a distinguishing part of the artist name.
  const a = artist.toLowerCase().replace(/\s*-\s*topic$/, "").replace(PUNCT_RE, " ").trim();
  return `${t}::${a.split(" ").slice(0, 2).join(" ")}`;
}

// Titles containing these are near-never what someone searching for a song
// wants surfaced as a top result — unless they explicitly searched for that
// variant (checked against the raw query before filtering).
const JUNK_TITLE_RE = /\b(reaction|karaoke|instrumental|ringtone|type beat|8d audio|sped up|nightcore|slowed(?:\s*(?:\+|and)?\s*reverb)?|full album|mega ?mix|compilation|hour loop|1 hour)\b/i;

function isOfficialChannel(artist: string): boolean {
  const a = artist.toLowerCase();
  return a.endsWith("- topic") || a.includes("vevo") || a.includes("official");
}

function qualityScore(r: MusicResult, rawQuery: string): number {
  let score = 0;
  if (isOfficialChannel(r.artist)) score += 5;
  const queryAllowsJunkTerm = JUNK_TITLE_RE.test(rawQuery);
  if (!queryAllowsJunkTerm && JUNK_TITLE_RE.test(r.title)) score -= 6;
  // Typical song length; penalize obvious mixes/loops or fragment clips.
  if (r.duration >= 60 && r.duration <= 900) score += 2;
  else if (r.duration > 1800 || (r.duration > 0 && r.duration < 30)) score -= 4;
  // Reward a title that actually contains the searched words (cheap
  // relevance signal all three providers already partially apply, but Piped
  // "music_songs" filter and Invidious relevance sort are inconsistent).
  const qWords = rawQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const titleLower = r.title.toLowerCase();
  const matched = qWords.filter((w) => titleLower.includes(w)).length;
  score += matched;
  return score;
}

// Dedups same-song-different-upload results (keeping the best-scored copy)
// and ranks the rest so genuine, official-sounding results land first. Caps
// to a "top results" set instead of returning every raw hit.
function curateResults(results: MusicResult[], rawQuery: string, limit = 15): MusicResult[] {
  const best = new Map<string, { result: MusicResult; score: number }>();
  for (const r of results) {
    const score = qualityScore(r, rawQuery);
    const key = normalizeKey(r.title, r.artist);
    const existing = best.get(key);
    if (!existing || score > existing.score) best.set(key, { result: r, score });
  }
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.result);
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

  // Persistent rate limit: 30 searches per minute per user.
  const allowed = await consumeRateLimit(user.id, "music-search", 30, 60);
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: "Rate limit: too many searches. Slow down.", results: [] }),
      { status: 429, headers: { ...jsonHeaders, "Retry-After": "60" } },
    );
  }

  try {
    const { query } = await req.json();
    if (!query || typeof query !== "string" || query.length > 200) {
      return new Response(JSON.stringify({ error: "Invalid query", results: [] }),
        { status: 400, headers: jsonHeaders });
    }

    let results: MusicResult[] = [];
    let source = "none";
    const debugTrail: string[] = [];

    const yt = await searchYouTubeAPI(query);
    debugTrail.push(yt.debug);
    if (yt.results.length > 0) { results = yt.results; source = "youtube"; }

    if (results.length === 0) {
      const piped = await searchPiped(query);
      debugTrail.push(piped.debug);
      if (piped.results.length > 0) { results = piped.results; source = "piped"; }
    }
    if (results.length === 0) {
      const invidious = await searchInvidious(query);
      debugTrail.push(invidious.debug);
      if (invidious.results.length > 0) { results = invidious.results; source = "invidious"; }
    }

    if (results.length === 0) {
      console.error("all music providers failed for query", query, debugTrail);
      return new Response(
        JSON.stringify({
          error: "Music providers are unreachable right now. Please try again in a moment.",
          results: [],
          source: "none",
          debug: debugTrail,
        }),
        { status: 502, headers: jsonHeaders },
      );
    }

    const curated = curateResults(results, query);
    return new Response(JSON.stringify({ results: curated, source, debug: debugTrail }), { headers: jsonHeaders });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Search error:", message);
    return new Response(JSON.stringify({ error: message, results: [] }),
      { status: 500, headers: jsonHeaders });
  }
});
