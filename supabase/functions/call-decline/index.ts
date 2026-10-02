/**
 * call-decline — instant Decline from the Android incoming-call notification,
 * without launching the app.
 *
 * Auth: a decline token minted by send-push into the incoming-call push
 * (callActionToken.ts), bound to callId + receiverId + a short expiry. It can
 * ONLY move this call to declined, and ONLY under decline_call()'s exact
 * rules: receiver matches, status in_progress, not yet claimed. Setting
 * declined_at fires the existing DB trigger that pushes 'call_rejected' to
 * the caller, and the caller's recovery path sees the row change — so the
 * caller stops ringing with no callee app/socket involved.
 *
 * verify_jwt = false (supabase/config.toml): the native receiver has no user
 * session; the HMAC token is the authorization. Logs contain no ids in full.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyDeclineToken } from "../_shared/callActionToken.ts";

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const secret = Deno.env.get("CALL_ACTION_SECRET");
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret || !url || !serviceKey) return json({ error: "not_configured" }, 503);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const verdict = await verifyDeclineToken(secret, body);
  if (!verdict.ok) {
    console.log(JSON.stringify({ event: "decline_rejected", reason: verdict.reason }));
    return json({ error: verdict.reason }, verdict.reason === "bad_request" ? 400 : 403);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const now = new Date().toISOString();
  const { data, error } = await admin.from("call_history")
    .update({ status: "missed", ended_at: now, declined_at: now })
    .eq("id", body.callId as string)
    .eq("receiver_id", body.receiverId as string)
    .eq("status", "in_progress")
    .is("claimed_by", null)
    .select("id");
  if (error) {
    console.log(JSON.stringify({ event: "decline_failed", code: error.code }));
    return json({ error: "update_failed" }, 500);
  }
  const declined = (data?.length ?? 0) > 0;
  console.log(JSON.stringify({ event: "decline_applied", declined, call: String(body.callId).slice(0, 8) }));
  // declined=false = already answered/ended elsewhere: nothing to do (not an error).
  return json({ declined });
});
