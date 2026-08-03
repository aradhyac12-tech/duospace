/**
 * daily-call — creates a Daily.co room + meeting token per call.
 *
 * Key resolution order (per user request):
 *   1. Caller's own key (from user_secrets, when daily_provides_calls = true)
 *   2. Partner's key (via get_partner_daily_key SECURITY DEFINER helper)
 *   3. Platform fallback (DAILY_API_KEY env — optional)
 * If none resolves, returns 402 Payment Required with a clear message.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PLATFORM_FALLBACK = Deno.env.get("DAILY_API_KEY"); // optional platform key
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// In-memory rate limit per user (2 room creations / minute).
const roomCreationLog = new Map<string, number[]>();
const ROOM_MAX_PER_MIN = 2;
const WINDOW_MS = 60_000;
function isRoomRateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (roomCreationLog.get(userId) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= ROOM_MAX_PER_MIN) return true;
  recent.push(now);
  roomCreationLog.set(userId, recent);
  return false;
}

// BUG FIX: translate Daily.co's `{ error: "<code>", info: "<detail>" }`
// error shape into a clear, actionable top-level message. Previously this
// was buried under a `detail` field the client never unwrapped, so e.g.
// "account-missing-payment-method" surfaced as a generic "Daily.co
// rejected the request" toast with no indication of what to actually do.
function formatDailyError(data: unknown, source: "self" | "partner" | "platform", status: number): string {
  const d = (data ?? {}) as { error?: string; info?: string };
  const whose = source === "self" ? "Your" : source === "partner" ? "Your partner's" : "The platform's";
  if (d.error === "account-missing-payment-method") {
    return `${whose} Daily.co account needs a payment method on file before it can be used for calls. Add a card at https://dashboard.daily.co/billing, then try again.`;
  }
  if (typeof d.info === "string" && d.info) return d.info;
  return `Daily.co rejected the request (${d.error ?? status}).`;
}

async function resolveKey(userId: string, authHeader: string): Promise<{ key: string; source: "self" | "partner" | "platform" } | null> {
  const anon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!,
    { global: { headers: { Authorization: authHeader } } },
  );
  // 1. Caller's own key
  const { data: own } = await anon
    .from("user_secrets")
    .select("daily_api_key, daily_provides_calls")
    .eq("user_id", userId)
    .maybeSingle();
  if (own?.daily_api_key && own.daily_provides_calls) {
    return { key: own.daily_api_key, source: "self" };
  }
  // 2. Partner's key (via SECURITY DEFINER helper)
  const { data: partnerKey } = await anon.rpc("get_partner_daily_key", { _user_id: userId });
  if (partnerKey && typeof partnerKey === "string") {
    return { key: partnerKey, source: "partner" };
  }
  // 3. Platform fallback
  if (PLATFORM_FALLBACK) return { key: PLATFORM_FALLBACK, source: "platform" };
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!,
    { global: { headers: { Authorization: authHeader } } },
  );
  const { data: { user }, error: authErr } = await supabase.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const resolved = await resolveKey(user.id, authHeader);
  if (!resolved) {
    return new Response(
      JSON.stringify({
        error: "No Daily.co key available",
        detail: "Add your Daily.co API key in Settings, or ask your partner to add theirs.",
        code: "no_daily_key",
      }),
      { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const DAILY_API_KEY = resolved.key;

  try {
    const { action, roomName } = await req.json();

    if (action === "create-room") {
      if (isRoomRateLimited(user.id)) {
        return new Response(
          JSON.stringify({ error: "Rate limit: max 2 rooms per minute. Please wait before starting another call." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "60" } },
        );
      }

      const res = await fetch("https://api.daily.co/v1/rooms", {
        method: "POST",
        headers: { "Authorization": `Bearer ${DAILY_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: roomName || `duo-${Date.now()}`,
          properties: {
            exp: Math.floor(Date.now() / 1000) + 86400,
            enable_chat: false,
            enable_knocking: false,
            max_participants: 2,
            enable_network_ui: false,
            enable_prejoin_ui: false,
            enable_screenshare: true,
            enable_recording: false,
            start_video_off: false,
            start_audio_off: false,
            sfu_switchover: 0.5,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error("Daily API error:", res.status, data);
        return new Response(
          JSON.stringify({
            error: formatDailyError(data, resolved.source, res.status),
            code: data?.error ?? null,
            detail: data,
            keySource: resolved.source,
          }),
          { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ url: data.url, name: data.name, id: data.id, keySource: resolved.source }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "get-token") {
      const res = await fetch("https://api.daily.co/v1/meeting-tokens", {
        method: "POST",
        headers: { "Authorization": `Bearer ${DAILY_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          properties: {
            room_name: roomName,
            exp: Math.floor(Date.now() / 1000) + 7200,
            is_owner: false,
            enable_screenshare: true,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        console.error("Daily token API error:", res.status, data);
        return new Response(
          JSON.stringify({
            error: formatDailyError(data, resolved.source, res.status),
            code: data?.error ?? null,
            detail: data,
            keySource: resolved.source,
          }),
          { status: res.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ token: data.token }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "delete-room") {
      await fetch(`https://api.daily.co/v1/rooms/${roomName}`, {
        method: "DELETE",
        headers: { "Authorization": `Bearer ${DAILY_API_KEY}` },
      });
      return new Response(JSON.stringify({ deleted: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("daily-call error:", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
