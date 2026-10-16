// Jamendo edge function — search, trending and stream-URL lookup for the
// free, licensed "Free Music" provider.
//
// WHY JAMENDO: it is an official, documented API (api.jamendo.com/v3.0) whose
// tracks are Creative-Commons licensed and come with a direct MP3 stream URL.
// That makes it the one catalog here that can legitimately play in the
// background through the native engine, with no scraped keys involved.
//
// SETUP: needs a free client id from https://devportal.jamendo.com — set it as
// the Supabase secret JAMENDO_CLIENT_ID. Without it every call returns 503.
//
// LICENSE NOTES (read before shipping):
//  - Jamendo's free API tier is for NON-commercial apps. If DuoSpace charges
//    for anything (Razorpay monetization), get Jamendo Licensing / API terms
//    cleared first, or gate this provider accordingly.
//  - Most tracks are CC-BY / CC-BY-SA etc.: show the artist name and link back
//    (we return `permalink` = Jamendo's share URL for that).
//
// DEPLOY NOTE: self-contained like audius-search (no cross-function imports).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

const CLIENT_ID = Deno.env.get("JAMENDO_CLIENT_ID") ?? "";
const rateLimitAdmin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

async function consumeRateLimit(userId: string, bucket: string, max: number, windowSeconds: number): Promise<boolean> {
  try {
    const { data, error } = await rateLimitAdmin.rpc("consume_rate_limit", {
      _user_id: userId, _bucket: bucket, _max: max, _window_seconds: windowSeconds,
    });
    if (error) { console.error("[rateLimit] rpc error:", error.message); return true; }
    return data === true;
  } catch (e) { console.error("[rateLimit] exception:", e); return true; }
}

type JamendoTrack = {
  id: string; name?: string; duration?: number; artist_name?: string;
  album_image?: string; image?: string; audio?: string; shareurl?: string;
  audiodownload_allowed?: boolean;
};

export type NormalizedJamendoTrack = {
  provider: "jamendo";
  providerTrackId: string;
  title: string;
  artist: string;
  artwork: string | null;
  duration: number;
  permalink: string | null;
  isStreamable: boolean;
  streamUrl: string | null;
};

const normalize = (t: JamendoTrack): NormalizedJamendoTrack => ({
  provider: "jamendo",
  providerTrackId: String(t.id),
  title: t.name ?? "Unknown",
  artist: t.artist_name ?? "Unknown artist",
  artwork: t.album_image || t.image || null,
  duration: typeof t.duration === "number" ? t.duration : 0,
  permalink: t.shareurl ?? null,
  isStreamable: Boolean(t.audio),
  streamUrl: t.audio ?? null,
});

async function jamendoGet(params: Record<string, string>): Promise<JamendoTrack[]> {
  const qs = new URLSearchParams({ client_id: CLIENT_ID, format: "json", audioformat: "mp32", imagesize: "300", ...params });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.jamendo.com/v3.0/tracks/?${qs}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Jamendo returned ${res.status}`);
    const data = await res.json();
    if (data?.headers?.status === "failed") throw new Error(data?.headers?.error_message ?? "Jamendo request failed");
    return Array.isArray(data?.results) ? data.results : [];
  } finally { clearTimeout(timer); }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!,
    { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) return new Response(JSON.stringify({ error: "Unauthorized", results: [] }), { status: 401, headers: jsonHeaders });

  if (!CLIENT_ID) {
    return new Response(JSON.stringify({ error: "Free Music isn't configured yet (JAMENDO_CLIENT_ID missing).", results: [] }), { status: 503, headers: jsonHeaders });
  }
  if (!(await consumeRateLimit(user.id, "jamendo-search", 60, 60))) {
    return new Response(JSON.stringify({ error: "Rate limit: too many requests. Slow down.", results: [] }), { status: 429, headers: { ...jsonHeaders, "Retry-After": "60" } });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const mode = body?.mode === "trending" || body?.mode === "stream" ? body.mode : "search";

    if (mode === "stream") {
      const trackId = body?.trackId;
      if (!trackId || typeof trackId !== "string" || !/^\d{1,12}$/.test(trackId)) {
        return new Response(JSON.stringify({ error: "Invalid trackId", streamUrl: null }), { status: 400, headers: jsonHeaders });
      }
      const [t] = await jamendoGet({ id: trackId, limit: "1" });
      if (!t?.audio) return new Response(JSON.stringify({ error: "Track unavailable", streamUrl: null }), { status: 404, headers: jsonHeaders });
      return new Response(JSON.stringify({ streamUrl: t.audio }), { headers: jsonHeaders });
    }

    if (mode === "trending") {
      const tags = typeof body?.tags === "string" && body.tags.length <= 60 ? body.tags : "";
      const items = await jamendoGet({ order: "popularity_week", limit: "30", ...(tags ? { tags } : {}) });
      return new Response(JSON.stringify({ results: items.map(normalize).filter((t) => t.isStreamable) }), { headers: jsonHeaders });
    }

    const query = body?.query;
    if (!query || typeof query !== "string" || query.length > 200) {
      return new Response(JSON.stringify({ error: "Invalid query", results: [] }), { status: 400, headers: jsonHeaders });
    }
    const items = await jamendoGet({ search: query, order: "relevance", limit: "30" });
    return new Response(JSON.stringify({ results: items.map(normalize).filter((t) => t.isStreamable) }), { headers: jsonHeaders });
  } catch (err: unknown) {
    console.error("Jamendo error:", err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: "Free Music is unreachable right now. Please try again in a moment.", results: [] }), { status: 502, headers: jsonHeaders });
  }
});
