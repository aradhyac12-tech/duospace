/**
 * livekit-token — mints a short-lived LiveKit room-access token for one
 * call (migration brief STEP 7).
 *
 * NOT RUNTIME-VERIFIED: no live LiveKit deployment or Supabase project
 * exists in this sandbox to actually invoke this against. Structurally
 * mirrors livekit-token/index.ts's auth pattern (verify the caller's
 * Supabase JWT, never trust a client-supplied user id) and
 * call_history's existing authorization model (claim_call/decline_call/
 * cancel_call's own "caller_id or receiver_id" checks).
 *
 * Security boundaries (STEP 16):
 *   - LIVEKIT_API_KEY / LIVEKIT_API_SECRET are read from Deno.env only,
 *     never returned to the client, never logged.
 *   - The token is scoped to exactly one room (DERIVED from the call id
 *     — `duo-call-<callId>` — never the caller-chosen `room_name`
 *     column) and one identity (the authenticated user's id) — not
 *     a general-purpose LiveKit credential.
 *   - Token TTL is short (LIVEKIT_TOKEN_TTL_SECONDS, default 600s / 10
 *     min) — long enough to cover setup + a call, short enough that a
 *     leaked token has a bounded blast radius. This is an access token
 *     for room join, not a session that needs renewal mid-call —
 *     LiveKit's client keeps the WebRTC connection alive independently
 *     of the token's expiry once connected.
 *   - Authorization: the caller must be caller_id or receiver_id on the
 *     call_history row named by `callId` — the same check
 *     claim_call/decline_call already enforce server-side, applied here
 *     too rather than assumed from the client's say-so.
 *
 * PHASE 4: every authorization rule lives in _shared/livekitAuthz.ts
 * (pure, unit-tested): participant, provider=self_hosted, status
 * in_progress, receiver must hold the claim_call() claim, caller may not
 * join once the ring window lapsed, and the room is derived from the call
 * id. The room name is no longer read from call_history.room_name, which
 * the caller chooses at INSERT and which therefore cannot be trusted to
 * name a LiveKit room.
 */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authorizeLiveKitToken } from "../_shared/livekitAuthz.ts";

const LIVEKIT_API_KEY = Deno.env.get("LIVEKIT_API_KEY");
const LIVEKIT_API_SECRET = Deno.env.get("LIVEKIT_API_SECRET");
const LIVEKIT_URL = Deno.env.get("LIVEKIT_URL"); // wss://... — public, safe to return to the client
// Short-lived: the token is only used to JOIN; LiveKit keeps an established
// connection alive past token expiry and re-issues its own refresh tokens.
// Clamped so a misconfigured env can't mint long-lived credentials.
const TOKEN_TTL_SECONDS = Math.min(900, Math.max(60, Number(Deno.env.get("LIVEKIT_TOKEN_TTL_SECONDS") ?? "300") || 300));
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function base64url(bytes: Uint8Array): string {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(sig);
}

/**
 * Builds a LiveKit access token: a standard JWT (HS256) with LiveKit's
 * `video` grant claim. See LiveKit's token spec — this hand-rolls the
 * signing (Web Crypto HMAC, same primitive apnsAuth.ts/firebaseAuth.ts
 * use for their own provider JWTs) rather than pulling in
 * livekit-server-sdk, which is not confirmed Deno-edge-runtime
 * compatible and would be a heavier dependency than this function needs
 * for one claim shape.
 */
async function mintLiveKitToken(opts: {
  apiKey: string;
  apiSecret: string;
  identity: string;
  room: string;
  ttlSeconds: number;
}): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: opts.apiKey,
    sub: opts.identity,
    iat: now,
    nbf: now,
    exp: now + opts.ttlSeconds,
    jti: crypto.randomUUID(),
    video: {
      roomJoin: true,
      room: opts.room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    },
  };
  const encHeader = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const encPayload = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${encHeader}.${encPayload}`;
  const sig = await hmacSha256(opts.apiSecret, signingInput);
  return `${signingInput}.${base64url(sig)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_URL) {
    // Deliberately generic — never hint at which secret is missing.
    return new Response(
      JSON.stringify({ error: "Self-hosted calling is not configured on this server.", code: "livekit_not_configured" }),
      { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

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

  try {
    const { callId } = await req.json();
    if (!callId || typeof callId !== "string") {
      return new Response(JSON.stringify({ error: "callId is required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Authorization: uses the caller's own auth context (RLS-scoped
    // client, not service_role) so this can only ever see a row the
    // "Users can view own calls" policy already permits; the decision
    // itself is the pure authorizeLiveKitToken() (unit-tested).
    if (!/^[0-9a-f-]{36}$/i.test(callId)) {
      return new Response(JSON.stringify({ error: "Invalid callId", code: "room_unavailable" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Authoritative call facts — the SAME service-role RPC the signaling
    // gateway authorizes with (status, claim, decline, session, and a
    // mutual CURRENT partnership check). Identity comes only from the
    // verified JWT above; nothing in the request body is trusted beyond
    // which call is being asked about.
    if (!SERVICE_ROLE_KEY) {
      return new Response(JSON.stringify({ error: "Server misconfigured", code: "authz_unavailable" }), {
        status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: facts, error: factsErr } = await admin.rpc("signaling_get_call_facts", { _call_id: callId });
    if (factsErr) {
      return new Response(JSON.stringify({ error: "Authorization temporarily unavailable", code: "authz_unavailable" }), {
        status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const f = facts as Record<string, unknown> | null;
    const call = f && f.found === true ? {
      id: String(f.id), caller_id: String(f.caller_id), receiver_id: String(f.receiver_id),
      provider: (f.provider as string | null) ?? null, status: String(f.status),
      claimed_by: (f.claimed_by as string | null) ?? null, expires_at: (f.expires_at as string | null) ?? null,
      declined: f.declined === true, are_partners: f.are_partners === true,
    } : null;
    const callErr = null;

    const decision = authorizeLiveKitToken({ userId: user.id, call: callErr ? null : call });
    if (!decision.ok) {
      return new Response(JSON.stringify({ error: decision.error, code: decision.code }), {
        status: decision.httpStatus, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = await mintLiveKitToken({
      apiKey: LIVEKIT_API_KEY,
      apiSecret: LIVEKIT_API_SECRET,
      identity: user.id,
      room: decision.roomName,
      ttlSeconds: TOKEN_TTL_SECONDS,
    });

    return new Response(
      JSON.stringify({ token, url: LIVEKIT_URL, roomName: decision.roomName }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    // Never leak err's raw message here — same discipline as
    // livekit-token/index.ts's formatDailyError: a parse failure or
    // unexpected exception should not risk echoing back anything from
    // the environment (secrets are read from Deno.env, never
    // interpolated into thrown errors above, but this stays defensive).
    return new Response(JSON.stringify({ error: "Unexpected error generating call token" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
