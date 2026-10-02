// Edge Function: get-billing-account-token
//
// PHASE 6 (account binding). Returns a deterministic, privacy-preserving
// identifier the app passes to Google Play Billing as
// BillingFlowParams.setObfuscatedAccountId() when launching a purchase.
//
// WHY THIS EXISTS: without it, verify-google-play-purchase has no way to
// confirm a purchase token actually belongs to the account submitting it —
// it would have to trust "this token was sent by user A, so credit user A",
// which is exactly the "arbitrary valid purchase token" attack the spec
// calls out. Google Play's obfuscated account/profile identifier mechanism
// exists precisely to let a backend recompute and compare this value
// independently of anything the client claims.
//
// HOW THE IDENTIFIER IS GENERATED (document this — do not change silently):
//   obfuscatedAccountId = hex( HMAC-SHA256(secret = BILLING_ACCOUNT_HMAC_SECRET, message = user.id) )
// - `user.id` is the Supabase auth UUID for the caller, taken from their
//   verified JWT — never client-supplied.
// - `BILLING_ACCOUNT_HMAC_SECRET` is a Supabase Edge Function secret, never
//   sent to the client, never the same as any other secret in this project.
// - The result is deterministic (same user always gets the same value, so
//   verification can recompute and compare it later) but reveals nothing
//   about the user's identity, email, or Supabase UUID to Google or to
//   anyone inspecting the value — it's a one-way HMAC, not an encoding.
//
// HOW IT'S VALIDATED: verify-google-play-purchase recomputes this same HMAC
// for whoever is CALLING the verify endpoint (their own authenticated
// user.id) and rejects the request if it doesn't match the
// obfuscatedAccountId the client says the purchase was made under. Once
// GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is configured, it additionally compares
// against Google's own externalAccountIdentifiers.obfuscatedExternalAccountId
// from the verified SubscriptionPurchaseV2 response — the strongest check,
// since it can't be spoofed by the client at all.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { computeObfuscatedAccountId } from "../_shared/billingAccount.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const HMAC_SECRET = Deno.env.get("BILLING_ACCOUNT_HMAC_SECRET");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();

  try {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const {
      data: { user },
    } = await userClient.auth.getUser();

    if (!user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!HMAC_SECRET) {
      return new Response(
        JSON.stringify({ error: "billing_not_configured", message: "BILLING_ACCOUNT_HMAC_SECRET secret is not set" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const obfuscatedAccountId = await computeObfuscatedAccountId(user.id);
    return new Response(JSON.stringify({ obfuscatedAccountId }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[get-billing-account-token] error:", e);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
