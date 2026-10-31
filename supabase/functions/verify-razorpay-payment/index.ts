// Edge Function: verify-razorpay-payment
//
// Called by the client immediately after Razorpay Checkout's success
// handler fires with { razorpay_order_id, razorpay_payment_id,
// razorpay_signature }. This is NOT "trust the client because it says
// success" — the signature is HMAC-SHA256(order_id + "|" + payment_id,
// RAZORPAY_KEY_SECRET), which only Razorpay and this backend can produce.
// Recomputing and comparing it server-side IS a legitimate, authoritative
// verification (same trust model as a webhook signature check) — the
// client cannot forge a signature it doesn't have the secret for.
//
// This does not replace razorpay-webhook: that remains the source of truth
// for events this endpoint never sees (async payment confirmation delays,
// later refunds, disputes). This endpoint exists so a paying user sees Plus
// unlock immediately, without waiting on webhook delivery.
//
// Signature mismatch => 400, entitlement is NOT touched. Missing fields =>
// 400. Cross-account (this transaction belongs to a different user than
// whoever is calling) => rejected, same principle as Google's account
// binding.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();

  try {
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
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

    const { razorpay_order_id, razorpay_subscription_id, razorpay_payment_id, razorpay_signature } = await req.json();
    // Exactly one of order (one-time) or subscription (recurring) is verified.
    const isSubscription = !!razorpay_subscription_id && !razorpay_order_id;
    const referenceId: string | undefined = isSubscription ? razorpay_subscription_id : razorpay_order_id;
    if (!referenceId || !razorpay_payment_id || !razorpay_signature) {
      return new Response(JSON.stringify({ error: "missing_fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!RAZORPAY_KEY_SECRET) {
      return new Response(JSON.stringify({ error: "razorpay_not_configured" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Razorpay signs orders as `order_id|payment_id` but subscriptions as
    // `payment_id|subscription_id` (reverse order).
    const signedMessage = isSubscription
      ? `${razorpay_payment_id}|${referenceId}`
      : `${referenceId}|${razorpay_payment_id}`;
    const expected = await hmacSha256Hex(signedMessage, RAZORPAY_KEY_SECRET);
    if (expected.length !== razorpay_signature.length) {
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ razorpay_signature.charCodeAt(i);
    if (diff !== 0) {
      // Signature mismatch: do NOT mark as paid, do not touch the
      // transaction at all.
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: txn } = await admin
      .from("payment_transactions")
      .select("id, user_id, status")
      .eq("provider", "razorpay")
      .eq(isSubscription ? "provider_subscription_id" : "provider_transaction_id", referenceId)
      .maybeSingle();

    if (!txn) {
      return new Response(JSON.stringify({ error: "transaction_not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    // Account binding: this order must belong to whoever is calling.
    // Prevents user B submitting a valid signature for an order that was
    // actually created (and paid for) under user A's session.
    if (txn.user_id !== user.id) {
      return new Response(JSON.stringify({ error: "account_mismatch" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotent: a duplicate call (double-tap, retry) for an already-active
    // transaction is a no-op success, not an error.
    if (txn.status !== "active") {
      await admin
        .from("payment_transactions")
        .update({
          status: "active",
          started_at: new Date().toISOString(),
          // First period only. For subscriptions the webhook overwrites this
          // with Razorpay's real current_end on every charge/renewal.
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          ...(isSubscription ? { provider_transaction_id: razorpay_payment_id } : {}),
          metadata: { razorpay_payment_id },
        })
        .eq("id", txn.id);

      await admin.rpc("reconcile_entitlement_from_transaction", { _transaction_id: txn.id });
    }

    return new Response(JSON.stringify({ status: "verified" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[verify-razorpay-payment] error:", e);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
