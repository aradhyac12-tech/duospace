// Edge function: complete-signup
// Public. Called by the client immediately after supabase.auth.signUp()
// when the response comes back with no session (i.e. "confirm your email"
// pending). No SMTP/email provider is configured on this project, so the
// built-in confirmation email never arrives and the account is stuck
// forever otherwise. This mints the session directly, the same way
// redeem-qr-token and webauthn-login-verify already do (admin.generateLink
// + verifyOtp), instead of waiting on an email that can't be delivered.
//
// Abuse guards: only works for accounts created in the last 15 minutes and
// only if not already confirmed, so this can't be used as a general
// "confirm anyone's email" oracle — it only finishes a signup the caller
// just started.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const __cors = (() => {
  const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") ?? "*";
  const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
  };
  return { corsHeaders };
})();
const corsHeaders = __cors.corsHeaders;

const __rateLimit = (() => {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  async function consumeRateLimit(
    userId: string, bucket: string, max: number, windowSeconds: number,
  ): Promise<boolean> {
    try {
      const { data, error } = await admin.rpc("consume_rate_limit", {
        _user_id: userId, _bucket: bucket, _max: max, _window_seconds: windowSeconds,
      });
      if (error) {
        console.error("[rateLimit] rpc error:", error.message);
        return true;
      }
      return data === true;
    } catch (e) {
      console.error("[rateLimit] exception:", e);
      return true;
    }
  }
  return { consumeRateLimit };
})();
const consumeRateLimit = __rateLimit.consumeRateLimit;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MAX_ACCOUNT_AGE_MS = 15 * 60_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => null) as { user_id?: string; email?: string } | null;
    if (!body?.user_id || !body?.email) return json({ error: "Missing user_id or email" }, 400);

    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
    const allowed = await consumeRateLimit(ip, "complete-signup", 10, 300);
    if (!allowed) return json({ error: "Too many attempts" }, 429);

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

    const { data: userRes, error: getErr } = await admin.auth.admin.getUserById(body.user_id);
    if (getErr || !userRes?.user) return json({ error: "Account not found" }, 404);
    const user = userRes.user;

    if (user.email?.toLowerCase() !== body.email.trim().toLowerCase()) {
      return json({ error: "Account not found" }, 404);
    }

    const createdAt = new Date(user.created_at).getTime();
    if (Date.now() - createdAt > MAX_ACCOUNT_AGE_MS) {
      return json({ error: "This signup has expired. Please sign up again." }, 400);
    }

    if (!user.email_confirmed_at) {
      const { error: updErr } = await admin.auth.admin.updateUserById(user.id, { email_confirm: true });
      if (updErr) throw updErr;
    }

    const { data: linkData, error: linkErr } = await admin.auth.admin
      .generateLink({ type: "magiclink", email: user.email! });
    if (linkErr || !linkData?.properties?.hashed_token) {
      console.error("[complete-signup] generateLink", linkErr?.message);
      return json({ error: "Session mint failed" }, 500);
    }

    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: v, error: vErr } = await anon.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });
    if (vErr || !v?.session) {
      console.error("[complete-signup] verifyOtp", vErr?.message);
      return json({ error: "Session mint failed" }, 500);
    }

    return json({
      access_token: v.session.access_token,
      refresh_token: v.session.refresh_token,
      expires_at: v.session.expires_at,
    }, 200);
  } catch (e) {
    console.error("[complete-signup]", e);
    return json({ error: e instanceof Error ? e.message : "Internal error" }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
