// Edge Function: verify-google-play-purchase
//
// The ONLY place a Google Play purchase becomes an entitlement. The app
// never writes to entitlements/purchase_events directly — there is no
// INSERT/UPDATE policy for `authenticated` on either table. The client
// calls this function with what Google Play Billing gave it; this function
// verifies it against Google's server-to-server API and writes the result
// with the service role.
//
// STATUS: request validation, purchase-state gating, account binding,
// replay protection, idempotent re-verification, linked-token
// reconciliation, and the entitlement/acknowledgement write path are all
// implemented and exercised by src/test/db/monetizationEntitlements.db.test.ts
// (logic that doesn't require Google's live API) plus manual verification
// against the real production schema (see chat/audit report). The actual
// network calls to Google's Play Developer API (subscriptionsv2.get and
// subscriptions.acknowledge) now live in ../_shared/googlePlay.ts. They need
// a Google Cloud service-account JSON key configured as the Supabase secret
// GOOGLE_PLAY_SERVICE_ACCOUNT_JSON, which only the project owner can
// provision from the Play Console (REQUIRES PRODUCTION CREDENTIALS). Until
// that secret exists, every real purchase attempt fails closed (grants
// nothing) rather than silently succeeding.
//
// Never place the service-account key or any Google credential in the
// Android app — it stays server-side only, read from Deno.env here.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";
import { computeObfuscatedAccountId } from "../_shared/billingAccount.ts";
import {
  acknowledgeWithGooglePlay,
  type GooglePlaySubscriptionResult,
  sha256Hex,
  verifyWithGooglePlay,
} from "../_shared/googlePlay.ts";

// Re-exported so existing importers keep working; the implementations live in
// _shared/googlePlay.ts (importing this file from another function would start
// a second Deno.serve).
export { acknowledgeWithGooglePlay, sha256Hex, verifyWithGooglePlay };
export type { GooglePlaySubscriptionResult };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// Maps a verified Google Play product id to the entitlement plan it grants.
// Single source of truth lives in src/lib/monetization/config.ts on the
// client side; kept in sync here manually since Edge Functions don't share
// a bundler with the frontend. If you add a product, update both.
export const PRODUCT_TO_PLAN: Record<string, "PLUS_INDIVIDUAL" | "PLUS_COUPLE" | "PRO_INDIVIDUAL" | "PRO_COUPLE"> = {
  duospace_plus_individual_monthly: "PLUS_INDIVIDUAL",
  duospace_plus_couple_monthly: "PLUS_COUPLE",
  duospace_pro_individual_monthly: "PRO_INDIVIDUAL",
  duospace_pro_couple_monthly: "PRO_COUPLE",
};

function mapSubscriptionStateToEntitlementStatus(
  state: GooglePlaySubscriptionResult["subscriptionState"],
): "active" | "cancelled" | "expired" | "revoked" {
  switch (state) {
    case "active":
    case "in_grace_period": // PHASE 9: grace period still grants access — Google is still trying to bill
      return "active";
    case "canceled":
    case "on_hold": // access-affecting per Google's guidance, but not a hard revoke — modeled as 'cancelled' (no future renewal assumed) rather than immediately yanking access; refine once real billing data is observed
      return "cancelled";
    case "paused":
    case "expired":
      return "expired";
    case "revoked":
      return "revoked";
    default:
      return "active";
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
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

    const allowed = await consumeRateLimit(user.id, "verify_purchase", 20, 3600);
    if (!allowed) {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { productId, purchaseToken, obfuscatedAccountId } = await req.json();
    if (!productId || !purchaseToken || !PRODUCT_TO_PLAN[productId]) {
      return new Response(JSON.stringify({ error: "invalid_request" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // PHASE 6 account binding, first check: the client must present the
    // SAME obfuscatedAccountId this backend would independently compute for
    // whoever is calling — a mismatch here means either a stale/tampered
    // client value or (more importantly) someone submitting a purchase
    // token that was never launched under their own account. This alone
    // isn't the full guard (a client could in principle recompute the
    // correct value for itself and submit someone else's real token — see
    // the second, stronger check below), but it catches the naive "just
    // send someone else's raw token" attack immediately and cheaply.
    let expectedAccountId: string;
    try {
      expectedAccountId = await computeObfuscatedAccountId(user.id);
    } catch {
      return new Response(
        JSON.stringify({ error: "billing_not_configured" }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    if (obfuscatedAccountId && obfuscatedAccountId !== expectedAccountId) {
      await admin.from("purchase_events").insert({
        user_id: user.id,
        platform: "google_play",
        product_id: productId,
        purchase_token_hash: await sha256Hex(purchaseToken),
        status: "invalid",
        verification_status: "account_binding_mismatch",
      });
      return new Response(JSON.stringify({ status: "invalid", reason: "account_binding_mismatch" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const tokenHash = await sha256Hex(purchaseToken);

    // Idempotency (PHASE 3/13): the DB's UNIQUE(platform, purchase_token_hash)
    // constraint is the hard backstop against a duplicate row ever existing.
    // This lookup lets a repeated call — from a retried request, a restore
    // pass finding a purchase it already verified, or a duplicate RTDN-driven
    // reconciliation — return the SAME successful outcome instead of an
    // error, per "if the purchase is already acknowledged, do not treat
    // that as an error."
    const { data: existing } = await admin
      .from("purchase_events")
      .select("id, status, product_id")
      .eq("platform", "google_play")
      .eq("purchase_token_hash", tokenHash)
      .maybeSingle();

    if (existing) {
      if (existing.status === "verified") {
        return new Response(
          JSON.stringify({ status: "verified", plan: PRODUCT_TO_PLAN[existing.product_id], idempotent: true }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: "duplicate" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let verification: GooglePlaySubscriptionResult;
    try {
      verification = await verifyWithGooglePlay(productId, purchaseToken);
    } catch (e) {
      // Record the attempt even when verification itself can't run yet, so
      // there's an audit trail, and fail closed — never grant on a verify
      // error.
      await admin.from("purchase_events").insert({
        user_id: user.id,
        platform: "google_play",
        product_id: productId,
        purchase_token_hash: tokenHash,
        status: "invalid",
        verification_status: "error",
        raw_metadata: { error: String(e instanceof Error ? e.message : e) },
      });
      return new Response(JSON.stringify({ error: "verification_unavailable" }), {
        status: 503,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!verification.valid) {
      await admin.from("purchase_events").insert({
        user_id: user.id,
        platform: "google_play",
        product_id: productId,
        purchase_token_hash: tokenHash,
        status: "invalid",
        verification_status: "rejected",
      });
      return new Response(JSON.stringify({ status: "invalid" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // PHASE 6 account binding, second and stronger check: compare against
    // what GOOGLE reports the purchase was made under, not what the client
    // sent. This is the check a malicious client cannot spoof, because it
    // never touches the value Google itself recorded at purchase time.
    if (
      verification.obfuscatedExternalAccountId &&
      verification.obfuscatedExternalAccountId !== expectedAccountId
    ) {
      await admin.from("purchase_events").insert({
        user_id: user.id,
        platform: "google_play",
        product_id: productId,
        purchase_token_hash: tokenHash,
        status: "invalid",
        verification_status: "account_binding_mismatch",
      });
      return new Response(JSON.stringify({ status: "invalid", reason: "account_binding_mismatch" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // PHASE 3: only PURCHASED (here: a `valid` verification result at all —
    // verifyWithGooglePlay is responsible for only ever returning
    // valid:true for a genuinely purchased/active-lifecycle subscription;
    // pending/cancelled/errored purchases must never reach this line) may
    // grant an entitlement. See docs/MONETIZATION_ARCHITECTURE.md for the
    // full state table this maps from.
    const expiresAt = verification.expiryTimeMillis
      ? new Date(Number(verification.expiryTimeMillis)).toISOString()
      : null;
    const linkedTokenHash = verification.linkedPurchaseToken
      ? await sha256Hex(verification.linkedPurchaseToken)
      : null;

    const { data: insertedEvent, error: insertEventError } = await admin
      .from("purchase_events")
      .insert({
        user_id: user.id,
        platform: "google_play",
        product_id: productId,
        purchase_token_hash: tokenHash,
        order_id: verification.orderId,
        status: "verified",
        verification_status: "verified",
        purchased_at: new Date().toISOString(),
        expires_at: expiresAt,
        subscription_state: verification.subscriptionState ?? "active",
        linked_purchase_token_hash: linkedTokenHash,
        obfuscated_account_id: expectedAccountId,
        acknowledged: false,
      })
      .select("id")
      .single();

    if (insertEventError || !insertedEvent) {
      // Most likely the UNIQUE(platform, purchase_token_hash) constraint
      // firing on a race (two near-simultaneous calls for the same token) —
      // treat as the idempotent "already handled" case, not a hard error.
      return new Response(JSON.stringify({ status: "duplicate" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // PHASE 8: acknowledge server-side, right after recording the verified
    // purchase, before granting the entitlement — never dependent on the
    // client calling back in to do it.
    try {
      if (verification.acknowledgementState !== "acknowledged") {
        await acknowledgeWithGooglePlay(productId, purchaseToken);
      }
      await admin.from("purchase_events").update({ acknowledged: true }).eq("id", insertedEvent.id);
    } catch {
      // Acknowledgement failing does NOT block granting the entitlement —
      // the purchase is already verified as real. It just means Google
      // might still auto-refund if acknowledgement never succeeds within 3
      // days, which is an operational concern (retry via RTDN/restore
      // path), not a reason to withhold access from someone who paid.
    }

    // PHASE 3/4/10: entitlements are no longer written directly from here.
    // This function's job stops at "is this a real, verified Google
    // purchase" — the commercial record (payment_transactions) and the
    // resulting access (entitlements) are produced by the SAME
    // reconcile_entitlement_from_transaction() path Razorpay's webhook
    // uses, so there is exactly one place either provider's payment
    // becomes access.
    const { data: product } = await admin
      .from("commercial_products")
      .select("id, base_price_minor, base_currency")
      .eq("google_product_id", productId)
      .eq("active", true)
      .single();

    if (!product) {
      // Verified with Google but this product isn't in our catalog (e.g.
      // removed/renamed) — fail safe: recorded in purchase_events above,
      // but no entitlement is granted for a product DuoSpace doesn't sell.
      return new Response(JSON.stringify({ error: "product_not_in_catalog" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Google's subscriptionState -> internal transaction_status. Only
    // spelling differs ("canceled" -> "cancelled"); everything else maps
    // 1:1. "pending"/undefined defaults to "active" here because this
    // branch only runs once verifyWithGooglePlay has already returned
    // valid:true for a PURCHASED transaction (see PRODUCT_TO_PLAN gate
    // above) — a genuinely still-pending purchase never reaches this line.
    const txnStatus =
      verification.subscriptionState === "canceled" ? "cancelled" : (verification.subscriptionState ?? "active");

    const { data: txn, error: txnError } = await admin
      .from("payment_transactions")
      .insert({
        user_id: user.id,
        provider: "google_play",
        provider_transaction_id: verification.orderId,
        provider_purchase_token_hash: tokenHash,
        product_id: product.id,
        plan: PRODUCT_TO_PLAN[productId],
        billing_period: "monthly",
        // subscriptionsv2 doesn't return the charged price, so this records
        // the catalog base price (integer minor units). It can differ from
        // what Google actually charged (regional pricing, tax, offers); treat
        // it as list price for revenue reporting, not a settlement figure.
        amount_minor: product.base_price_minor,
        currency: product.base_currency ?? "INR",
        status: txnStatus,
        started_at: new Date().toISOString(),
        expires_at: expiresAt,
        obfuscated_account_id: expectedAccountId,
      })
      .select("id")
      .single();

    if (txnError || !txn) {
      // UNIQUE(provider, provider_purchase_token_hash) racing with the
      // purchase_events insert above — already handled by that table's own
      // idempotent-duplicate branch further up; this is the same race one
      // layer down, same treatment.
      return new Response(JSON.stringify({ status: "duplicate" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    await admin.rpc("reconcile_entitlement_from_transaction", { _transaction_id: txn.id });

    // PHASE 9 (fixed — see 20260928140000): reconciling the OLD transaction
    // must happen with the NEW transaction's real id and only after that
    // row exists, so replaced_by_transaction_id is set correctly and the
    // old entitlement is revoked through the same ledger-aware path.
    if (linkedTokenHash) {
      await admin.rpc("reconcile_replaced_transaction", {
        _old_purchase_token_hash: linkedTokenHash,
        _new_transaction_id: txn.id,
      });
    }

    return new Response(JSON.stringify({ status: "verified", plan: PRODUCT_TO_PLAN[productId] }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[verify-google-play-purchase] error:", e);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
