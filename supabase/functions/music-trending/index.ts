// Trending songs edge function — powers the Home/Playlist "Trending" rails.
//
// DEPLOY NOTE: self-contained like music-search (see that file's header —
// this deploy path can't resolve cross-function relative imports), so the
// curation logic is intentionally duplicated here rather than shared via an
// import. Keep the two curation passes in sync if either changes.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

async function fetchWithTimeout(url: string, ms: number, headers: Record<string, string> = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { headers: { "User-Agent": "DuoSpace/1.0", ...headers }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Curation (dedup + quality ranking) — mirrors music-search/index.ts ---
const NOISE_RE = /[\(\[][^)\]]*(official|video|audio|lyric|lyrics|hd|hq|4k|visualizer|mv|explicit|clean|prod\.?|remaster(ed)?)[^)\]]*[\)\]]/gi;
const FEAT_RE = /\b(feat\.?|ft\.?|featuring)\b.*/i;
const PUNCT_RE = /[^a-z0-9]+/g;
const JUNK_TITLE_RE = /\b(reaction|karaoke|instrumental|ringtone|type beat|8d audio|sped up|nightcore|slowed(?:\s*(?:\+|and)?\s*reverb)?|full album|mega ?mix|compilation|hour loop|1 hour)\b/i;

function normalizeKey(title: string, artist: string): string {
  let t = title.toLowerCase();
  t = t.replace(NOISE_RE, " ");
  t = t.replace(FEAT_RE, " ");
  t = t.replace(PUNCT_RE, " ").trim();
  const a = artist.toLowerCase().replace(/\s*-\s*topic$/, "").replace(PUNCT_RE, " ").trim();
  return `${t}::${a.split(" ").slice(0, 2).join(" ")}`;
}

function isOfficialChannel(artist: string): boolean {
  const a = artist.toLowerCase();
  return a.endsWith("- topic") || a.includes("vevo") || a.includes("official");
}

function qualityScore(r: MusicResult): number {
  let score = 0;
  if (isOfficialChannel(r.artist)) score += 5;
  if (JUNK_TITLE_RE.test(r.title)) score -= 6;
  if (r.duration >= 60 && r.duration <= 900) score += 2;
  else if (r.duration > 1800 || (r.duration > 0 && r.duration < 30)) score -= 4;
  return score;
}

function curateResults(results: MusicResult[], limit = 12): MusicResult[] {
  const best = new Map<string, { result: MusicResult; score: number }>();
  for (const r of results) {
    const score = qualityScore(r);
    const key = normalizeKey(r.title, r.artist);
    const existing = best.get(key);
    if (!existing || score > existing.score) best.set(key, { result: r, score });
  }
  return Array.from(best.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.result);
}
// --- end shared curation ---

// English rail: YouTube Music charts trend toward US/UK pop. Hindi rail:
// searched explicitly (rather than just regionCode=IN charts, which mixes
// in Punjabi/Tamil/Telugu/English-in-India content) so the row is reliably
// Hindi film & pop music, matching what the user actually asked for.
async function fetchYouTubeBucket(mode: "english" | "hindi"): Promise<{ results: MusicResult[]; debug: string }> {
  if (!YT_KEY) return { results: [], debug: `youtube(${mode}): no Youtube_api_key secret configured` };

  if (mode === "english") {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&chart=mostPopular&videoCategoryId=10&regionCode=US&maxResults=25&key=${YT_KEY}`;
    const res = await fetch(url);
    if (!res.ok) { const body = await res.text(); return { results: [], debug: `youtube(english): HTTP ${res.status} — ${body.slice(0, 200)}` }; }
    const data = await res.json();
    const results = (data.items ?? []).map((v: any): MusicResult => ({
      title: v.snippet?.title ?? "Unknown",
      artist: v.snippet?.channelTitle ?? "Unknown",
      videoId: v.id,
      thumbnail: v.snippet?.thumbnails?.high?.url ?? `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
      duration: isoDurationToSeconds(v.contentDetails?.duration ?? "PT0S"),
      url: `https://www.youtube.com/watch?v=${v.id}`,
    }));
    return { results, debug: `youtube(english): ${results.length} results` };
  }

  // Hindi: search + relevanceLanguage=hi + regionCode=IN, ordered by view count.
  const q = encodeURIComponent("new hindi songs bollywood");
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&relevanceLanguage=hi&regionCode=IN&order=viewCount&maxResults=25&q=${q}&key=${YT_KEY}`;
  const sRes = await fetch(searchUrl);
  if (!sRes.ok) { const body = await sRes.text(); return { results: [], debug: `youtube(hindi): HTTP ${sRes.status} — ${body.slice(0, 200)}` }; }
  const sData = await sRes.json();
  const ids = (sData.items ?? []).map((i: any) => i.id?.videoId).filter(Boolean);
  if (ids.length === 0) return { results: [], debug: "youtube(hindi): 0 results" };
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
  return { results, debug: `youtube(hindi): ${results.length} results` };
}

// Fallback when no YouTube Data API key is configured: Piped/Invidious both
// expose a trending endpoint. Piped's accepts a region code and a music
// filter; Invidious's "trending?type=Music" is region-aware too.
async function fetchMirrorBucket(mode: "english" | "hindi"): Promise<{ results: MusicResult[]; debug: string }> {
  const region = mode === "english" ? "US" : "IN";
  const pipedInstances = ["https://pipedapi.kavin.rocks", "https://pipedapi.owo.si", "https://api.piped.yt"];

  for (const inst of pipedInstances) {
    try {
      const res = await fetchWithTimeout(`${inst}/trending?region=${region}`, 3000);
      if (!res.ok) { await res.text(); continue; }
      const data = await res.json();
      const items = Array.isArray(data) ? data : [];
      const mapped: MusicResult[] = items
        .filter((i: any) => i.url && i.title)
        .slice(0, 25)
        .map((i: any): MusicResult => {
          const videoId = String(i.url).replace("/watch?v=", "");
          return {
            title: i.title ?? "Unknown",
            artist: i.uploaderName ?? "Unknown",
            videoId,
            thumbnail: i.thumbnail ?? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
            duration: i.duration ?? 0,
            url: `https://www.youtube.com/watch?v=${videoId}`,
          };
        });
      if (mapped.length > 0) return { results: mapped, debug: `piped(${mode}): ${mapped.length} from ${inst}` };
    } catch (e) {
      console.warn(`piped trending ${inst} failed`, e instanceof Error ? e.message : e);
    }
  }

  const invidiousInstances = ["https://inv.nadeko.net", "https://invidious.nerdvpn.de"];
  for (const inst of invidiousInstances) {
    try {
      const res = await fetchWithTimeout(`${inst}/api/v1/trending?type=Music&region=${region}`, 3500);
      if (!res.ok) { await res.text(); continue; }
      const data = await res.json();
      const items = Array.isArray(data) ? data : [];
      const mapped: MusicResult[] = items
        .filter((i: any) => i.videoId && i.title)
        .slice(0, 25)
        .map((i: any): MusicResult => ({
          title: i.title,
          artist: i.author ?? "Unknown",
          videoId: i.videoId,
          thumbnail: i.videoThumbnails?.[0]?.url ?? `https://img.youtube.com/vi/${i.videoId}/mqdefault.jpg`,
          duration: i.lengthSeconds ?? 0,
          url: `https://www.youtube.com/watch?v=${i.videoId}`,
        }));
      if (mapped.length > 0) return { results: mapped, debug: `invidious(${mode}): ${mapped.length} from ${inst}` };
    } catch (e) {
      console.warn(`invidious trending ${inst} failed`, e instanceof Error ? e.message : e);
    }
  }

  return { results: [], debug: `mirrors(${mode}): all instances failed` };
}

async function fetchBucket(mode: "english" | "hindi"): Promise<{ results: MusicResult[]; debug: string[] }> {
  const debug: string[] = [];
  const yt = await fetchYouTubeBucket(mode);
  debug.push(yt.debug);
  if (yt.results.length > 0) return { results: curateResults(yt.results), debug };

  const mirror = await fetchMirrorBucket(mode);
  debug.push(mirror.debug);
  return { results: curateResults(mirror.results), debug };
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
    return new Response(JSON.stringify({ error: "Unauthorized", english: [], hindi: [] }),
      { status: 401, headers: jsonHeaders });
  }

  // Trending changes slowly — cap far below music-search's search rate limit.
  const allowed = await consumeRateLimit(user.id, "music-trending", 10, 60);
  if (!allowed) {
    return new Response(
      JSON.stringify({ error: "Rate limit: try again shortly.", english: [], hindi: [] }),
      { status: 429, headers: { ...jsonHeaders, "Retry-After": "60" } },
    );
  }

  try {
    const [english, hindi] = await Promise.all([fetchBucket("english"), fetchBucket("hindi")]);
    return new Response(
      JSON.stringify({
        english: english.results,
        hindi: hindi.results,
        debug: { english: english.debug, hindi: hindi.debug },
      }),
      { headers: jsonHeaders },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Trending error:", message);
    return new Response(JSON.stringify({ error: message, english: [], hindi: [] }),
      { status: 500, headers: jsonHeaders });
  }
});
