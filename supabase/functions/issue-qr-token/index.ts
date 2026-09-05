// Edge Function: issue-qr-token
// Called by an authenticated device (Device A). Mints a short-lived, single-use
// pairing token bound to the caller's user_id. Only the SHA-256 hash of the
// token is persisted server-side. The raw token is returned to the caller so it
// can be encoded into a QR code and scanned by Device B, which then hits
// redeem-qr-token to exchange it for a real Supabase session.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Token lifetime = 90s. Kept short so a leaked QR is nearly useless.
const TOKEN_TTL_SECONDS = 90;

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Validate the caller and get their user_id from the JWT.
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Parse optional body: { token_type?: 'device_pairing' | 'signup_invite' }.
    // Default to device_pairing so existing callers are unaffected.
    let tokenType: "device_pairing" | "signup_invite" = "device_pairing";
    try {
      const body = await req.json().catch(() => ({}));
      if (body && typeof body === "object" && typeof (body as Record<string, unknown>).token_type === "string") {
        const t = (body as { token_type: string }).token_type;
        if (t === "device_pairing" || t === "signup_invite") tokenType = t;
      }
    } catch { /* no body is fine */ }

    // Rate-limit issuance per user: 10 tokens per minute is plenty for a
    // legitimate "regenerate QR" loop and shuts down abuse.
    const rlBucket = tokenType === "signup_invite" ? "qr-issue-invite" : "qr-issue";
    const allowed = await consumeRateLimit(user.id, rlBucket, 10, 60);
    if (!allowed) {
      return new Response(
        JSON.stringify({ error: "Too many QR requests. Try again shortly." }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // 32 random bytes → 43-char URL-safe base64 token (~256 bits of entropy).
    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    const token = b64url(raw);
    const tokenHash = await sha256Hex(token);

    const now = new Date();
    // signup_invite lives longer (10 min) since a new user takes longer to
    // complete signup than a same-user device pairing (~90s window).
    const ttlSeconds = tokenType === "signup_invite" ? 600 : TOKEN_TTL_SECONDS;
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const issuerIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? null;
    const issuerUa = req.headers.get("user-agent") ?? null;

    const { error: insertErr } = await admin.from("qr_pairing_tokens").insert({
      user_id: user.id,
      token_hash: tokenHash,
      token_type: tokenType,
      expires_at: expiresAt.toISOString(),
      issuer_ip: issuerIp,
      issuer_ua: issuerUa,
    });
    if (insertErr) {
      console.error("[issue-qr-token] insert error:", insertErr.message);
      return new Response(JSON.stringify({ error: "Failed to issue token" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Opportunistic GC.
    admin.rpc("qr_pairing_tokens_gc").then(() => {}, () => {});

    return new Response(
      JSON.stringify({
        token,
        token_type: tokenType,
        expires_at: expiresAt.toISOString(),
        ttl_seconds: ttlSeconds,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("[issue-qr-token] exception:", e);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
