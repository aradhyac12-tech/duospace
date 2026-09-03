// Edge Function: check-qr-token-status
// Called by the DISPLAYING device (Device A) while its QR is on screen, to
// find out whether it's been scanned/redeemed yet.
//
// Why this has to be a function rather than a client-side realtime/select
// subscription: qr_pairing_tokens has explicit deny-all RLS policies for
// BOTH `anon` and `authenticated` (see the table's migration) — even the
// row's own owner cannot SELECT it directly. That's intentional: the raw
// token (which hashes to token_hash) is a bearer credential, and nothing
// about this table should be client-queryable by anyone but the service
// role. So the client sends back the same raw token it already holds in
// memory (from issue-qr-token / qr-anon-issue's response — this doesn't
// expose anything new; that raw token is already visibly encoded in the QR
// image on screen) and this function does the lookup with the service role,
// returning only the minimal { redeemed, kind, linked_partner } the display
// UI needs to react — never the row itself.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";

  try {
    // Client polls this every ~2s while a QR is on screen (see
    // QRSignInDisplay.tsx) — generous enough for that, tight enough to
    // shut down someone hammering it to probe token existence.
    const allowed = await consumeRateLimit(ip, "qr-status-check", 60, 60);
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Too many requests." }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { token } = (await req.json().catch(() => ({}))) as { token?: string };
    if (!token || typeof token !== "string" || token.length < 16 || token.length > 128) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tokenHash = await sha256Hex(token);
    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // Ownership check: if the caller is authenticated, only let them poll a
    // token that belongs to them (mirrors issue-qr-token's own auth model).
    // Unauthenticated callers (the anon_signup issuer, which is itself
    // unauthenticated) are allowed through — same trust model
    // redeem-qr-token already uses: possession of the raw token is the
    // credential, there's no user_id to check against for that case.
    let callerUserId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const { data } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
        callerUserId = data?.user?.id ?? null;
      } catch { /* treat as anon */ }
    }

    const { data: row, error } = await admin
      .from("qr_pairing_tokens")
      .select("user_id, token_type, redeemed_at, pending_partner_for")
      .eq("token_hash", tokenHash)
      .maybeSingle();

    if (error) {
      console.error("[check-qr-token-status] select error:", error.message);
      return new Response(JSON.stringify({ error: "Lookup failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!row) {
      // Token doesn't exist (never issued, or garbage-collected long after
      // expiry) — same shape as "not redeemed" so the client's poll loop
      // doesn't need a third branch; it'll naturally stop once its own
      // expiry countdown re-mints a new token anyway.
      return new Response(JSON.stringify({ redeemed: false }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (callerUserId && row.user_id && row.user_id !== callerUserId) {
      // Not your token — don't leak whether it's redeemed either way.
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(
      JSON.stringify({
        redeemed: !!row.redeemed_at,
        kind: row.token_type,
        linked_partner: row.token_type === "anon_signup" ? !!row.pending_partner_for : undefined,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[check-qr-token-status] exception:", e);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
