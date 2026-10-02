// Edge Function: cancel-razorpay-subscription
//
// Lets a user stop auto-renewal of their OWN Razorpay subscription. Access is
// kept until the period they already paid for ends (cancel_at_cycle_end=1);
// the razorpay-webhook then flips the ledger row when Razorpay confirms.
// The subscription id is looked up server-side from the caller's own ledger
// row, never taken from the request, so nobody can cancel someone else's.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY_ID = Deno.env.get("RAZORPAY_KEY_ID");
const KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  try {
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json(401, { error: "unauthorized" });
    if (!(await consumeRateLimit(user.id, "cancel_razorpay_subscription", 10, 3600))) return json(429, { error: "rate_limited" });
    if (!KEY_ID || !KEY_SECRET) return json(503, { error: "razorpay_not_configured" });

    const { data: txn } = await admin
      .from("payment_transactions")
      .select("id, provider_subscription_id, expires_at, metadata")
      .eq("user_id", user.id)
      .eq("provider", "razorpay")
      .eq("status", "active")
      .not("provider_subscription_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!txn) return json(404, { error: "no_active_subscription" });

    const res = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(txn.provider_subscription_id)}/cancel`, {
      method: "POST",
      headers: { Authorization: `Basic ${btoa(`${KEY_ID}:${KEY_SECRET}`)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ cancel_at_cycle_end: 1 }),
    });
    // 400 usually means "already cancelled/completed" — treat as done so the UI can settle.
    if (!res.ok && res.status !== 400) return json(502, { error: "razorpay_error", status: res.status });

    await admin
      .from("payment_transactions")
      .update({ metadata: { ...(txn.metadata ?? {}), cancel_requested_at: new Date().toISOString() } })
      .eq("id", txn.id);

    return json(200, { status: "cancel_scheduled", accessUntil: txn.expires_at });
  } catch (e) {
    console.error("[cancel-razorpay-subscription] error:", e);
    return json(500, { error: "internal_error" });
  }
});
