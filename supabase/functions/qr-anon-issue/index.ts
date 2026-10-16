// Edge Function: qr-anon-issue
// Mints an anonymous "anon_signup" pairing token WITHOUT requiring the caller
// to be authenticated. Displayed by a brand-new device on the Auth screen so a
// partner (already signed in) can scan and auto-link once the new user
// completes signup. Rate-limited by IP.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TOKEN_TTL_SECONDS = 600; // 10 minutes: new user needs time to sign up.

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
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? "unknown";
    const ok = await consumeRateLimit(ip, "qr-anon-issue", 6, 60);
    if (!ok) {
      return new Response(
        JSON.stringify({ error: "Too many QR requests. Try again shortly." }),
        { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    const token = b64url(raw);
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    const { error } = await admin.from("qr_pairing_tokens").insert({
      user_id: null,
      token_hash: tokenHash,
      token_type: "anon_signup",
      expires_at: expiresAt.toISOString(),
      issuer_ip: ip,
      issuer_ua: req.headers.get("user-agent") ?? null,
    });
    if (error) {
      console.error("[qr-anon-issue] insert error:", error.message);
      return new Response(JSON.stringify({ error: "Failed to issue token" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    admin.rpc("qr_pairing_tokens_gc").then(() => {}, () => {});

    return new Response(
      JSON.stringify({
        token,
        token_type: "anon_signup",
        expires_at: expiresAt.toISOString(),
        ttl_seconds: TOKEN_TTL_SECONDS,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[qr-anon-issue] exception:", e);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
