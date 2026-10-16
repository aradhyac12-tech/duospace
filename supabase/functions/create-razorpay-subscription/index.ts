// Edge Function: create-razorpay-subscription
//
// Auto-renewing Razorpay billing (Subscriptions API), the recurring
// counterpart of create-razorpay-order (one-time 30-day pass). No dashboard
// work is needed: if commercial_products.razorpay_plan_id is empty, this
// function creates the Razorpay Plan itself from the catalog price and stores
// the id, so prices still come only from our database.
//
// Flow: this function -> Razorpay Checkout (subscription_id) ->
// verify-razorpay-payment (recomputes payment_id|subscription_id HMAC) ->
// razorpay-webhook keeps it current (charged / cancelled / halted / ...).
//
// Requires: RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET (server secrets) and, on the
// Razorpay account, Subscriptions enabled (UPI AutoPay / e-mandate for India).
// Everything fails closed: nothing is granted until the signature verifies.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";
import { computeObfuscatedAccountId } from "../_shared/billingAccount.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY_ID = Deno.env.get("RAZORPAY_KEY_ID");
const KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Razorpay requires a finite total_count; 120 monthly cycles = 10 years, and
// the user can cancel any time.
const TOTAL_COUNT = 120;
const PLANS = ["PLUS_INDIVIDUAL", "PLUS_COUPLE", "PRO_INDIVIDUAL", "PRO_COUPLE"];
const LABEL: Record<string, string> = {
  PLUS_INDIVIDUAL: "DuoSpace Plus (just me)", PLUS_COUPLE: "DuoSpace Plus (both of us)",
  PRO_INDIVIDUAL: "DuoSpace Pro (just me)", PRO_COUPLE: "DuoSpace Pro (both of us)",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

async function rzp(path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.razorpay.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${KEY_ID}:${KEY_SECRET}`)}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw Object.assign(new Error(`Razorpay ${path} failed (${res.status}): ${await res.text()}`), { httpStatus: res.status });
  return res.json();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  try {
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json(401, { error: "unauthorized" });
    if (!(await consumeRateLimit(user.id, "create_razorpay_subscription", 10, 3600))) return json(429, { error: "rate_limited" });

    const { plan } = await req.json();
    if (!PLANS.includes(plan)) return json(400, { error: "invalid_plan" });
    if (!KEY_ID || !KEY_SECRET) return json(503, { error: "razorpay_not_configured" });

    const { data: product } = await admin
      .from("commercial_products")
      .select("id, base_price_minor, base_currency, razorpay_plan_id")
      .eq("plan", plan).eq("billing_period", "monthly").eq("active", true).single();
    if (!product) return json(404, { error: "product_not_found" });

    // Lazily create the Razorpay Plan from the catalog price. If two requests
    // race, the loser's plan is simply unused; the stored id is whichever wrote last.
    let planId: string | null = product.razorpay_plan_id;
    if (!planId) {
      const created = await rzp("plans", {
        period: "monthly",
        interval: 1,
        item: { name: LABEL[plan], amount: product.base_price_minor, currency: product.base_currency },
      });
      planId = created.id as string;
      await admin.from("commercial_products").update({ razorpay_plan_id: planId }).eq("id", product.id);
    }

    const sub = await rzp("subscriptions", {
      plan_id: planId,
      total_count: TOTAL_COUNT,
      customer_notify: 1,
      notes: { user_id: user.id, plan },
    });

    const obfuscatedAccountId = await computeObfuscatedAccountId(user.id).catch(() => null);
    const { error: insertError } = await admin.from("payment_transactions").insert({
      user_id: user.id,
      provider: "razorpay",
      provider_subscription_id: sub.id,
      product_id: product.id,
      plan,
      billing_period: "monthly",
      amount_minor: product.base_price_minor,
      currency: product.base_currency,
      status: "pending",
      obfuscated_account_id: obfuscatedAccountId,
    });
    if (insertError) return json(500, { error: "ledger_write_failed" });

    return json(200, { subscriptionId: sub.id, keyId: KEY_ID });
  } catch (e) {
    console.error("[create-razorpay-subscription] error:", e);
    const status = (e as { httpStatus?: number })?.httpStatus === 401 ? 401 : 500;
    return json(status, { error: "razorpay_error", message: String(e instanceof Error ? e.message : e) });
  }
});
