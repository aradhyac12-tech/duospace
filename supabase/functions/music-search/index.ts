// Music search edge function — auth required + persistent rate limit.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";

const YT_KEY = Deno.env.get("YOUTUBE_API_KEY");

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

// NOTE: there is deliberately NO curated/mock fallback pool here any more.
// Returning six hardcoded love songs for every failed search made an
// outage look like a working search with bizarre results, which is worse
// than an honest error the client can retry. If every provider fails we
// now return 502 with a real message.


async function searchYouTubeAPI(query: string): Promise<MusicResult[]> {
  if (!YT_KEY) return [];
  const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoCategoryId=10&maxResults=20&q=${encodeURIComponent(query)}&key=${YT_KEY}`;
  const sRes = await fetch(searchUrl);
  if (!sRes.ok) {
    console.error("YouTube search failed", sRes.status, await sRes.text());
    return [];
  }
  const sData = await sRes.json();
  const ids = (sData.items ?? []).map((i: any) => i.id?.videoId).filter(Boolean);
  if (ids.length === 0) return [];
  const dRes = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,snippet&id=${ids.join(",")}&key=${YT_KEY}`);
  const dData = await dRes.json();
  return (dData.items ?? []).map((v: any): MusicResult => ({
    title: v.snippet?.title ?? "Unknown",
    artist: v.snippet?.channelTitle ?? "Unknown",
    videoId: v.id,
    thumbnail: v.snippet?.thumbnails?.high?.url ?? `https://img.youtube.com/vi/${v.id}/mqdefault.jpg`,
    duration: isoDurationToSeconds(v.contentDetails?.duration ?? "PT0S"),
    url: `https://www.youtube.com/watch?v=${v.id}`,
  }));
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
// stage finishes in ~3s worst case, instead of the old sequential
// 2 filters x 5 instances loop that could burn 30s — well past the
// client's 15s budget — and made search look permanently broken.

async function searchPiped(query: string): Promise<MusicResult[]> {
  const instances = [
    "https://pipedapi.adminforge.de",
    "https://api.piped.yt",
    "https://pipedapi.r4fo.com",
    "https://pipedapi.leptons.xyz",
    "https://piped-api.privacy.com.de",
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
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value.length > 0) return result.value;
  }
  for (const result of settled) {
    if (result.status === "rejected") console.warn("piped instance failed", result.reason);
  }
  return [];
}

interface InvidiousItem {
  videoId?: string; title?: string; author?: string;
  lengthSeconds?: number; videoThumbnails?: { url?: string }[];
}

// Second independent provider. Piped mirrors and Invidious mirrors go down
// at different times and for different reasons, so having both makes a
// total search outage far less likely than Piped alone (which is what
// used to push every failed search onto the hardcoded mock pool).
async function searchInvidious(query: string): Promise<MusicResult[]> {
  const instances = [
    "https://inv.nadeko.net",
    "https://invidious.nerdvpn.de",
    "https://yewtu.be",
    "https://invidious.f5.si",
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
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value.length > 0) return result.value;
  }
  for (const result of settled) {
    if (result.status === "rejected") console.warn("invidious instance failed", result.reason);
  }
  return [];
}


serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  // AUDIT FIX #12: Require authenticated caller.
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

    // Provider chain, best first. Each stage is bounded (YouTube is a
    // single API call; the mirror stages race all instances in parallel
    // with a per-request timeout), so the whole chain stays well inside
    // the client's 15s budget even when everything is down.
    let results: MusicResult[] = [];
    let source = "none";

    if (YT_KEY) {
      results = await searchYouTubeAPI(query);
      if (results.length > 0) source = "youtube";
    }
    if (results.length === 0) {
      results = await searchPiped(query);
      if (results.length > 0) source = "piped";
    }
    if (results.length === 0) {
      results = await searchInvidious(query);
      if (results.length > 0) source = "invidious";
    }

    if (results.length === 0) {
      // Honest failure instead of mock songs. 502 = upstream providers are
      // unreachable; the client shows a retry affordance for this.
      console.error("all music providers failed for query", query);
      return new Response(
        JSON.stringify({
          error: "Music providers are unreachable right now. Please try again in a moment.",
          results: [],
          source: "none",
        }),
        { status: 502, headers: jsonHeaders },
      );
    }

    return new Response(JSON.stringify({ results, source }), { headers: jsonHeaders });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Search error:", message);
    return new Response(JSON.stringify({ error: message, results: [] }),
      { status: 500, headers: jsonHeaders });
  }
});
