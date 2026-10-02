// admin-user-action: the only admin operations that need the service-role key
// (Supabase Auth admin API). Everything else in the admin console is a
// SECURITY DEFINER RPC called straight from the app.
//
//   block   -> admin_set_blocked(true)  + auth ban   (can't sign in or refresh a session)
//   unblock -> admin_set_blocked(false) + lift ban
//   verify  -> admin_record_action('verify_user') + mark the email confirmed
//
// Authorisation: the caller's own JWT is used to call the RPCs, and those
// re-check "caller is the ADMIN plan" inside Postgres. The service-role
// client is only touched AFTER that check has passed. The key never leaves
// this function.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { corsHeaders } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";

const BodySchema = z.object({
  action: z.enum(["block", "unblock", "verify"]),
  userId: z.string().uuid(),
  reason: z.string().trim().max(300).optional(),
});

const BAN_FOREVER = "876000h"; // ~100 years; "none" lifts it

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: jsonHeaders });

  if (req.method !== "POST") return reply(405, { error: "Method not allowed" });

  const authHeader = req.headers.get("Authorization") ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return reply(401, { error: "Unauthorized" });

  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return reply(400, { error: "Invalid input" });
  const { action, userId, reason } = parsed.data;

  // Cheap abuse guard even though only one account can pass the admin check.
  const allowed = await consumeRateLimit(user.id, "admin-user-action", 60, 60);
  if (!allowed) return reply(429, { error: "Too many requests" });

  // 1) Authorise + record in Postgres as the caller (admin check lives there).
  let rpcError: { message: string } | null = null;
  if (action === "block" || action === "unblock") {
    const { error } = await userClient.rpc("admin_set_blocked", {
      _user_id: userId, _blocked: action === "block", _reason: reason ?? null,
    });
    rpcError = error;
  } else {
    const { error } = await userClient.rpc("admin_record_action", {
      _action: "verify_user", _target: userId, _details: {},
    });
    rpcError = error;
  }
  if (rpcError) {
    const forbidden = /admin only|cannot|unknown user/i.test(rpcError.message);
    return reply(forbidden ? 403 : 500, { error: rpcError.message });
  }

  // 2) Only now use the service role.
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const attrs =
    action === "block" ? { ban_duration: BAN_FOREVER } :
    action === "unblock" ? { ban_duration: "none" } :
    { email_confirm: true };
  const { error: updErr } = await admin.auth.admin.updateUserById(userId, attrs);
  if (updErr) {
    // Roll the moderation row back so the panel never claims a block that the
    // auth layer didn't apply.
    if (action === "block" || action === "unblock") {
      await userClient.rpc("admin_set_blocked", { _user_id: userId, _blocked: action !== "block", _reason: null });
    }
    return reply(502, { error: "Auth update failed" });
  }

  return reply(200, { ok: true, action, userId });
});
