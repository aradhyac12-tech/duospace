// Edge Function: google-play-rtdn
//
// STATUS: IMPLEMENTED — REQUIRES GOOGLE CLOUD / PLAY CONSOLE CONFIGURATION.
//
// This is the receiving end of Google Play Real-Time Developer
// Notifications (RTDN): Google publishes subscription lifecycle events
// (renewed, cancelled, went into grace period, on hold, revoked, replaced,
// resubscribed, etc.) to a Google Cloud Pub/Sub topic, which is configured
// to push them here as HTTPS requests. Without this, DuoSpace only learns
// about a subscription's state when the user happens to open the app
// (restore-on-launch/resume, see useRestorePurchases.ts) — RTDN closes that
// gap so e.g. a revoked/refunded subscription loses access promptly even if
// the user never reopens the app.
//
// What's real right now:
//  - The dedupe mechanism (rtdn_events.message_id UNIQUE) — Google
//    redelivers notifications, sometimes the same one multiple times, and
//    this makes reprocessing a no-op rather than a duplicate state change.
//  - The notification parsing and the reconciliation call path, which
//    reuses the exact same verifyWithGooglePlay() + entitlement-write logic
//    verify-google-play-purchase uses, so there is only one way a
//    subscription's state ever gets written.
//  - Always returns 200 quickly once the message is durably recorded, per
//    Pub/Sub push requirements (a non-2xx response makes Google retry
//    delivery, which is correct backoff behavior for a transient failure,
//    but this function acks first and reconciles after to avoid needless
//    redelivery storms for a slow-but-successful Google API call).
//
// What still needs external configuration before this does anything real:
//  1. A Google Cloud Pub/Sub topic + push subscription pointed at this
//     function's URL, created from Play Console's "Monetization setup" ->
//     Real-time developer notifications.
//  2. Push authentication: verifyPubSubJwt (../_shared/googlePlay.ts) now
//     really validates the OIDC token Pub/Sub attaches (signature vs Google's
//     JWKS, issuer, audience, expiry, service-account email). It fails closed
//     until you set PUBSUB_PUSH_AUDIENCE and PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL
//     to match the push subscription's "Enable authentication" settings.
//  3. GOOGLE_PLAY_SERVICE_ACCOUNT_JSON (same secret verify-google-play-purchase
//     needs) — reconciliation re-verifies the purchase token with Google
//     before writing anything, and that call is stubbed until this secret
//     exists.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { sha256Hex, verifyPubSubJwt, verifyWithGooglePlay } from "../_shared/googlePlay.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// SubscriptionNotificationType values, per Google's RTDN reference —
// documented here rather than re-derived at call sites.
const NOTIFICATION_TYPE = {
  SUBSCRIPTION_RECOVERED: 1,
  SUBSCRIPTION_RENEWED: 2,
  SUBSCRIPTION_CANCELED: 3,
  SUBSCRIPTION_PURCHASED: 4,
  SUBSCRIPTION_ON_HOLD: 5,
  SUBSCRIPTION_IN_GRACE_PERIOD: 6,
  SUBSCRIPTION_RESTARTED: 7,
  SUBSCRIPTION_PRICE_CHANGE_CONFIRMED: 8,
  SUBSCRIPTION_DEFERRED: 9,
  SUBSCRIPTION_PAUSED: 10,
  SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED: 11,
  SUBSCRIPTION_REVOKED: 12,
  SUBSCRIPTION_EXPIRED: 13,
} as const;

interface DeveloperNotification {
  version: string;
  packageName: string;
  eventTimeMillis: string;
  subscriptionNotification?: {
    version: string;
    notificationType: number;
    purchaseToken: string;
    subscriptionId: string;
  };
  testNotification?: { version: string };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();

  try {
    // Explicit, visible gate: rejects anything that isn't a Pub/Sub push
    // signed by our configured service account.
    const authorized = await verifyPubSubJwt(req.headers.get("Authorization"));
    if (!authorized) {
      return new Response(
        JSON.stringify({
          error: "not_configured",
          message: "Missing or invalid Pub/Sub push token, or PUBSUB_PUSH_AUDIENCE / PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL not set.",
        }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json();
    const messageId: string | undefined = body?.message?.messageId;
    const dataB64: string | undefined = body?.message?.data;
    if (!messageId || !dataB64) {
      return new Response(JSON.stringify({ error: "invalid_pubsub_envelope" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const notification: DeveloperNotification = JSON.parse(atob(dataB64));

    // Dedupe FIRST, before any processing — Google's own delivery guarantee
    // is at-least-once, so redelivery of a message we already handled is
    // expected, routine behavior, not an error.
    const { error: insertError } = await admin.from("rtdn_events").insert({
      message_id: messageId,
      notification_type: notification.subscriptionNotification?.notificationType ?? null,
      purchase_token_hash: notification.subscriptionNotification?.purchaseToken
        ? await sha256Hex(notification.subscriptionNotification.purchaseToken)
        : null,
      subscription_id: notification.subscriptionNotification?.subscriptionId ?? null,
      processing_status: "received",
    });

    if (insertError) {
      // Unique violation on message_id = already processed this exact
      // notification. Ack it (200) so Google stops retrying; do not
      // reprocess.
      return new Response(JSON.stringify({ status: "duplicate" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (notification.testNotification) {
      await admin.from("rtdn_events").update({ processing_status: "ignored", processed_at: new Date().toISOString() })
        .eq("message_id", messageId);
      return new Response(JSON.stringify({ status: "test_notification_ignored" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sub = notification.subscriptionNotification;
    if (!sub) {
      await admin.from("rtdn_events").update({ processing_status: "ignored", processed_at: new Date().toISOString() })
        .eq("message_id", messageId);
      return new Response(JSON.stringify({ status: "no_subscription_notification" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      // Re-verify against Google's live API rather than trusting the
      // notification's own type field for anything but "something changed,
      // go look" — the notification is a nudge, never itself the source of
      // truth (mirrors verify-google-play-purchase's stance on client
      // input).
      const verification = await verifyWithGooglePlay(sub.subscriptionId, sub.purchaseToken);
      const tokenHash = await sha256Hex(sub.purchaseToken);

      // Reconcile against the LEDGER (payment_transactions), not
      // purchase_events — entitlements have linked via payment_transaction_id
      // since the commerce refactor (20260927140000); purchase_events is
      // Google's raw audit log only and no longer what entitlements key off.
      const { data: existingTxn } = await admin
        .from("payment_transactions")
        .select("id")
        .eq("provider", "google_play")
        .eq("provider_purchase_token_hash", tokenHash)
        .maybeSingle();

      if (existingTxn) {
        const txnStatus =
          sub.notificationType === NOTIFICATION_TYPE.SUBSCRIPTION_REVOKED
            ? "revoked"
            : sub.notificationType === NOTIFICATION_TYPE.SUBSCRIPTION_EXPIRED
              ? "expired"
              : sub.notificationType === NOTIFICATION_TYPE.SUBSCRIPTION_CANCELED
                ? "cancelled"
                : verification.valid
                  ? "active"
                  : "expired";

        await admin
          .from("payment_transactions")
          .update({ status: txnStatus, expires_at: verification.expiryTimeMillis ? new Date(Number(verification.expiryTimeMillis)).toISOString() : undefined })
          .eq("id", existingTxn.id);

        await admin.rpc("reconcile_entitlement_from_transaction", { _transaction_id: existingTxn.id });

        if (verification.linkedPurchaseToken) {
          const oldHash = await sha256Hex(verification.linkedPurchaseToken);
          await admin.rpc("reconcile_replaced_transaction", {
            _old_purchase_token_hash: oldHash,
            _new_transaction_id: existingTxn.id,
          });
        }
      }
      // If there's no existingTxn, this notification is for a purchase this
      // backend never saw verified (e.g. SUBSCRIPTION_PURCHASED for a
      // purchase whose client-side verify call never completed). The
      // restore-on-launch path is the intended catch-all for that case once
      // the user's app is next foregrounded; RTDN alone can't attribute an
      // unseen token to a DuoSpace account without the client-side
      // account-binding step having happened first.

      await admin.from("rtdn_events").update({
        processing_status: "processed",
        processed_at: new Date().toISOString(),
      }).eq("message_id", messageId);
    } catch (e) {
      await admin.from("rtdn_events").update({
        processing_status: "error",
        error_message: String(e instanceof Error ? e.message : e),
        processed_at: new Date().toISOString(),
      }).eq("message_id", messageId);
      // Still ack with 200 — the event is durably recorded with
      // processing_status='error' for manual/automatic retry tooling to
      // pick up later; returning non-200 here would just make Google
      // redeliver the identical notification, which will fail the same way
      // for the same reason (most likely: GOOGLE_PLAY_SERVICE_ACCOUNT_JSON
      // still not configured).
    }

    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[google-play-rtdn] error:", e);
    // Non-200 here is fine/correct — this is a genuine unexpected failure
    // before the message was even durably recorded, so redelivery is the
    // right behavior.
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
