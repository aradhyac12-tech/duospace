// Edge Function: create-razorpay-order
//
// PHASE 8/11. The client asks for a plan; this function is the ONLY place
// that talks to Razorpay with the account's secret key, and returns only
// what Razorpay Checkout needs client-side (order_id, amount, currency,
// key_id — never the secret).
//
// Uses Razorpay's ORDERS API (one-time payment), not Subscriptions —
// Subscriptions require a Plan ID created in the Razorpay dashboard first
// (REQUIRES RAZORPAY PLAN IDS: commercial_products.razorpay_plan_id is
// still NULL), which doesn't exist yet. Orders work with just an API
// key/secret, so this is what's actually usable today. Each successful
// order grants one billing period (currently: 30 days) rather than
// auto-renewing — recurring billing is a follow-up once a real Plan ID
// exists; swapping this for a Subscriptions call later doesn't change
// anything downstream, since both write to the same payment_transactions
// row shape and go through the same reconcile_entitlement_from_transaction.
//
// Credentials: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET must be set as
// Supabase Edge Function secrets (`supabase secrets set ...`), never
// committed to the repo or placed in any client-reachable env var.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";
import { computeObfuscatedAccountId } from "../_shared/billingAccount.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAZORPAY_KEY_ID = Deno.env.get("RAZORPAY_KEY_ID");
const RAZORPAY_KEY_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET");

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

interface RazorpayOrder {
  id: string; // "order_..."
  amount: number;
  currency: string;
}

async function createRazorpayOrder(amountMinor: number, currency: string, receipt: string): Promise<RazorpayOrder> {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay credentials are not configured");
  }
  // Minimum order amount Razorpay accepts is 100 (paise) — belt-and-braces
  // check even though our own catalog prices are always >= 14900.
  if (amountMinor < 100) {
    throw new Error("amount below Razorpay's minimum (100)");
  }
  const auth = btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`);
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({ amount: amountMinor, currency, receipt }),
  });
  if (res.status === 401) {
    throw Object.assign(new Error("Razorpay authentication failed — check RAZORPAY_KEY_ID/SECRET"), { httpStatus: 401 });
  }
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`Razorpay order creation failed: ${body}`), { httpStatus: 500 });
  }
  return res.json();
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

    const allowed = await consumeRateLimit(user.id, "create_razorpay_order", 10, 3600);
    if (!allowed) {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { plan } = await req.json();
    if (!["PLUS_INDIVIDUAL", "PLUS_COUPLE", "PRO_INDIVIDUAL", "PRO_COUPLE"].includes(plan)) {
      return new Response(JSON.stringify({ error: "invalid_plan" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // PHASE 10/11: amount comes from the catalog, in integer minor units —
    // never a client-supplied amount, never floating point.
    const { data: product, error: productError } = await admin
      .from("commercial_products")
      .select("id, base_price_minor, base_currency")
      .eq("plan", plan)
      .eq("billing_period", "monthly")
      .eq("active", true)
      .single();

    if (productError || !product) {
      return new Response(JSON.stringify({ error: "product_not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
      return new Response(
        JSON.stringify({ error: "razorpay_not_configured", message: "Razorpay credentials are not yet configured." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Only needed for Google Play account binding; Razorpay works without it.
    const obfuscatedAccountId = await computeObfuscatedAccountId(user.id).catch(() => null);
    const receipt = `${user.id.slice(0, 8)}-${plan}-${Date.now()}`;

    let order: RazorpayOrder;
    try {
      order = await createRazorpayOrder(product.base_price_minor, product.base_currency, receipt);
    } catch (e) {
      const status = (e as { httpStatus?: number })?.httpStatus === 401 ? 401 : 500;
      return new Response(JSON.stringify({ error: "razorpay_error", message: String(e instanceof Error ? e.message : e) }), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Recorded as 'pending' now — becomes 'active' only once
    // verify-razorpay-payment independently recomputes and confirms the
    // HMAC signature Razorpay Checkout returns. The client is never
    // trusted to report success on its own.
    await admin.from("payment_transactions").insert({
      user_id: user.id,
      provider: "razorpay",
      provider_transaction_id: order.id,
      product_id: product.id,
      plan,
      billing_period: "monthly",
      amount_minor: product.base_price_minor,
      currency: product.base_currency,
      status: "pending",
      obfuscated_account_id: obfuscatedAccountId,
    });

    return new Response(
      JSON.stringify({
        orderId: order.id,
        keyId: RAZORPAY_KEY_ID, // publishable — safe for Checkout, not a secret
        amountMinor: product.base_price_minor,
        currency: product.base_currency,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[create-razorpay-order] error:", e);
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
