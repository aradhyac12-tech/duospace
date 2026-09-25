/**
 * signaling-ticket — mints a short-lived, single-purpose ticket for
 * opening a WebSocketSignalingEngine connection (remediation P1-7).
 *
 * WHY THIS EXISTS: the previous design passed a client's actual Supabase
 * access token as a `?token=` query param on the signaling WebSocket URL
 * (see WebSocketSignalingEngine's original doc comment). Browsers,
 * reverse proxies, load balancers, and server access logs routinely
 * record full request URLs including query strings — a long-lived
 * session credential simply should not appear there. This function lets
 * the client trade its real (already-verified) session for a ticket
 * that is:
 *   - short-lived (120s — enough to complete a WS handshake, nothing
 *     more)
 *   - single-purpose (carries `purpose: "duospace-signaling"`, which
 *     infrastructure/signaling/src/auth.ts now requires and which a real
 *     Supabase-issued session token never has — so even a leaked Supabase
 *     token couldn't be replayed here, and a leaked ticket is useless
 *     for anything but opening a signaling socket for the next couple of
 *     minutes)
 *   - worthless if logged (reveals only "this user id tried to connect
 *     to signaling around this time" — no different in sensitivity from
 *     an ordinary access-log line)
 *
 * Signed with the same SUPABASE_JWT_SECRET the signaling server already
 * needed to verify real Supabase tokens with (see auth.ts) — reusing it
 * avoids introducing a second secret to provision/rotate/document for
 * what is still fundamentally "prove this request came from an
 * authenticated DuoSpace session", just scoped down.
 *
 * NOT RUNTIME-VERIFIED — same standing limitation as every other edge
 * function and signaling-related piece in this repository.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ROOT-CAUSE FIX: hosted Supabase never provides SUPABASE_JWT_SECRET to Edge
// Functions and rejects any custom secret starting with "SUPABASE_" (reserved
// prefix — supabase.com/docs/guides/functions/secrets). This was therefore
// always undefined in production → every ticket request returned 503 → the
// app could never open its signaling socket (calls stuck on "Connecting…").
// Tickets are DuoSpace's own HS256 tokens, so they use a dedicated shared
// secret, set identically here (Supabase secret) and on the signaling server.
// SUPABASE_JWT_SECRET remains only as a local `supabase functions serve` fallback.
import {
  mintSignalingTicket,
  resolvePublicSignalingUrl,
  resolveTicketSecret,
  TICKET_TTL_SECONDS,
} from "../_shared/signalingTicket.ts";

const TICKET_SECRET = resolveTicketSecret((k) => Deno.env.get(k));
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

  // RUNTIME CONFIG: the public wss:// URL of the signaling server, so builds
  // that were made without VITE_SIGNALING_URL (Vercel / APK) still work.
  // Supabase secret SIGNALING_PUBLIC_URL (not SUPABASE_-prefixed: reserved).
  const signalingUrl = resolvePublicSignalingUrl(Deno.env.get("SIGNALING_PUBLIC_URL"));
  let body: { configOnly?: boolean } = {};
  try { body = await req.json(); } catch { /* no body */ }
  if (body.configOnly) {
    return new Response(JSON.stringify({ signalingUrl }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  if (!TICKET_SECRET) {
    return new Response(
      JSON.stringify({ error: "Signaling is not configured on this server.", code: "signaling_not_configured" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  try {
    const ticket = await mintSignalingTicket(user.id, TICKET_SECRET);
    return new Response(
      JSON.stringify({ ticket, expiresInSeconds: TICKET_TTL_SECONDS, signalingUrl }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch {
    return new Response(JSON.stringify({ error: "Unexpected error generating signaling ticket" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
