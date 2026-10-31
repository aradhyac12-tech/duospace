// Edge Function: razorpay-webhook
//
// PHASE 9. Razorpay's server calls this directly (never the client) after a
// payment/subscription lifecycle event. Every request is verified against
// RAZORPAY_WEBHOOK_SECRET using HMAC-SHA256 over the raw body, exactly as
// Razorpay's docs specify — this is what makes a forged webhook request
// impossible to fake without that secret, which never leaves Supabase.
//
// STATUS: signature verification, idempotent event storage, and the
// mapping into payment_transactions + reconcile_entitlement_from_transaction
// are fully implemented and don't depend on any external configuration
// beyond the secret itself existing. This is more complete than the Google
// side because Razorpay's webhook payload is self-contained — unlike
// Google Play, there's no separate "call their API to verify" step;
// verifying the signature IS the verification.
//
// REQUIRES: RAZORPAY_WEBHOOK_SECRET (set in Play... no — set in the
// Razorpay Dashboard's webhook config AND as a matching Supabase secret),
// and this function's URL registered as the webhook endpoint in Razorpay's
// dashboard. Until both exist, this endpoint correctly rejects everything
// (401) rather than trusting unverified requests.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function verifySignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!WEBHOOK_SECRET || !signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
  // Constant-time-ish comparison — length-checked first, then compared
  // byte-by-byte rather than with `===`, to avoid a timing side-channel on
  // the one comparison that actually gates trust in this whole endpoint.
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

// Razorpay subscription event -> internal transaction_status. Payment
// (one-off, non-subscription) events are handled separately below since
// they map to different payload shapes.
const SUBSCRIPTION_EVENT_STATUS: Record<string, string> = {
  "subscription.activated": "active",
  "subscription.charged": "active", // renewal
  "subscription.completed": "expired",
  "subscription.cancelled": "cancelled",
  "subscription.paused": "paused",
  "subscription.resumed": "active",
  "subscription.pending": "on_hold",
  "subscription.halted": "on_hold",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();

  try {
    const rawBody = await req.text();
    const signature = req.headers.get("X-Razorpay-Signature");

    const validSignature = await verifySignature(rawBody, signature);
    if (!validSignature) {
      // No audit-log write here on purpose: an unverified request has told
      // us nothing trustworthy, including its own claimed event id, so
      // there is nothing safe to key a dedupe/audit row on. Logging the
      // rejection itself (count/timestamp, not the payload) is a
      // reasonable future addition if abuse monitoring is needed.
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = JSON.parse(rawBody);
    const eventId: string | undefined = payload?.id ?? payload?.event_id;
    const eventType: string = payload?.event;

    if (!eventId || !eventType) {
      return new Response(JSON.stringify({ error: "invalid_payload" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Idempotency (PHASE 9: "handle duplicate webhook deliveries
    // idempotently") — Razorpay, like Google, can and does redeliver.
    // rtdn_events is reused here as a generic "external event we've already
    // processed" dedupe table rather than creating a parallel one, since
    // its shape (message_id unique, processing_status, error_message) is
    // exactly what both providers need.
    const { error: dedupeError } = await admin.from("rtdn_events").insert({
      message_id: `razorpay:${eventId}`,
      notification_type: null,
      processing_status: "received",
    });
    if (dedupeError) {
      return new Response(JSON.stringify({ status: "duplicate" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const subscriptionEntity = payload?.payload?.subscription?.entity;
      const paymentEntity = payload?.payload?.payment?.entity;

      if (subscriptionEntity && SUBSCRIPTION_EVENT_STATUS[eventType]) {
        const razorpaySubscriptionId: string = subscriptionEntity.id;
        const status = SUBSCRIPTION_EVENT_STATUS[eventType];
        const currentEnd: number | undefined = subscriptionEntity.current_end; // epoch seconds

        const { data: txn } = await admin
          .from("payment_transactions")
          .select("id")
          .eq("provider", "razorpay")
          .eq("provider_subscription_id", razorpaySubscriptionId)
          .maybeSingle();

        if (txn) {
          await admin
            .from("payment_transactions")
            .update({
              status,
              provider_transaction_id: paymentEntity?.id ?? undefined,
              expires_at: currentEnd ? new Date(currentEnd * 1000).toISOString() : undefined,
              started_at: status === "active" ? new Date().toISOString() : undefined,
              cancelled_at: status === "cancelled" ? new Date().toISOString() : undefined,
            })
            .eq("id", txn.id);

          await admin.rpc("reconcile_entitlement_from_transaction", { _transaction_id: txn.id });
        }
        // No matching transaction: this subscription wasn't created via
        // create-razorpay-order (shouldn't happen in normal operation) —
        // recorded in rtdn_events for investigation, nothing to reconcile.
      } else if (eventType === "payment.captured" && paymentEntity?.order_id) {
        // One-time Orders backstop (create-razorpay-order flow): if the
        // app was killed right after payment, before it could call
        // verify-razorpay-payment, this is what still grants access —
        // exactly the same role restore-on-launch plays for Google.
        // Idempotent: a transaction already 'active' is left untouched.
        const { data: orderTxn } = await admin
          .from("payment_transactions")
          .select("id, status")
          .eq("provider", "razorpay")
          .eq("provider_transaction_id", paymentEntity.order_id)
          .maybeSingle();
        if (orderTxn && orderTxn.status !== "active") {
          await admin
            .from("payment_transactions")
            .update({
              status: "active",
              started_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
              metadata: { razorpay_payment_id: paymentEntity.id },
            })
            .eq("id", orderTxn.id);
          await admin.rpc("reconcile_entitlement_from_transaction", { _transaction_id: orderTxn.id });
        }
      } else if (eventType === "payment.failed" && paymentEntity) {
        // No entitlement change on a failed payment — nothing was ever
        // granted for it, so there's nothing to revoke either.
      } else if (eventType === "refund.created" || eventType === "refund.processed" || eventType === "payment.refunded") {
        // Refund entities carry the original payment_id; subscription events
        // stored that same id as provider_transaction_id, so we can find the
        // transaction it belongs to. Refunded => access is revoked.
        const refundPaymentId: string | undefined =
          payload?.payload?.refund?.entity?.payment_id ?? paymentEntity?.id;
        if (refundPaymentId) {
          const { data: refundedTxn } = await admin
            .from("payment_transactions")
            .select("id")
            .eq("provider", "razorpay")
            .eq("provider_transaction_id", refundPaymentId)
            .maybeSingle();
          if (refundedTxn) {
            await admin
              .from("payment_transactions")
              .update({ status: "refunded", refunded_at: new Date().toISOString() })
              .eq("id", refundedTxn.id);
            await admin.rpc("reconcile_entitlement_from_transaction", { _transaction_id: refundedTxn.id });
          }
        }
      }

      await admin
        .from("rtdn_events")
        .update({ processing_status: "processed", processed_at: new Date().toISOString() })
        .eq("message_id", `razorpay:${eventId}`);
    } catch (e) {
      await admin
        .from("rtdn_events")
        .update({
          processing_status: "error",
          error_message: String(e instanceof Error ? e.message : e),
          processed_at: new Date().toISOString(),
        })
        .eq("message_id", `razorpay:${eventId}`);
      // Still return 200 — Razorpay's retry-on-non-2xx would just redeliver
      // an identical event that will fail the same way for the same
      // reason; the error is durably recorded for manual/automated retry.
    }

    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[razorpay-webhook] error:", e);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
