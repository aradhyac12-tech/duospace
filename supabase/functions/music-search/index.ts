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

const fallbackResults = (query: string): MusicResult[] => {
  const pool = [
    { title: "Until I Found You", artist: "Stephen Sanchez", videoId: "GxldQ9eX2wo", duration: 177 },
    { title: "Perfect", artist: "Ed Sheeran", videoId: "2Vv-BfVoq4g", duration: 263 },
    { title: "lovely", artist: "Billie Eilish, Khalid", videoId: "V1Pl8CzNzCw", duration: 200 },
    { title: "Night Changes", artist: "One Direction", videoId: "syFZfO_wfMQ", duration: 240 },
    { title: "Heat Waves", artist: "Glass Animals", videoId: "mRD0-GxqHVo", duration: 238 },
    { title: "Golden Hour", artist: "JVKE", videoId: "PEM0Vs8jf1w", duration: 209 },
  ];
  const needle = query.toLowerCase();
  const ranked = [...pool].sort((a, b) => Number(b.title.toLowerCase().includes(needle)) - Number(a.title.toLowerCase().includes(needle)));
  return ranked.map((v) => ({
    ...v,
    thumbnail: `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`,
    url: `https://www.youtube.com/watch?v=${v.videoId}`,
  }));
};

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

async function searchPiped(query: string): Promise<MusicResult[]> {
  const instances = [
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.adminforge.de",
    "https://api.piped.yt",
    "https://pipedapi.r4fo.com",
    "https://pipedapi.leptons.xyz",
  ];
  const filters = ["music_songs", "videos"];
  for (const filter of filters) {
    for (const inst of instances) {
      try {
        const res = await fetch(
          `${inst}/search?q=${encodeURIComponent(query)}&filter=${filter}`,
          { headers: { "User-Agent": "DuoSpace/1.0" } },
        );
        if (!res.ok) { await res.text(); continue; }
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
        if (mapped.length > 0) return mapped;
      } catch (err) {
        console.warn("piped instance failed", inst, err);
      }
    }
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

    let results: MusicResult[] = [];
    let source = "none";
    if (YT_KEY) {
      results = await searchYouTubeAPI(query);
      source = "youtube";
    }
    if (results.length === 0) {
      results = await searchPiped(query);
      source = results.length ? "piped" : source;
    }

    if (results.length === 0) {
      results = fallbackResults(query);
      source = "fallback";
    }

    return new Response(JSON.stringify({ results, source }), { headers: jsonHeaders });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Search error:", message);
    return new Response(JSON.stringify({ error: message, results: [] }),
      { status: 500, headers: jsonHeaders });
  }
});
