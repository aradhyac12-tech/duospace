/**
 * call-ringing — the callee's phone received the incoming-call push and is
 * ringing (sent natively by CallRingingAck.kt, even with the app killed).
 * Stamps call_history.ringing_at so the caller's app flips "Calling…" -> "Ringing…".
 *
 * Auth: the same single-call HMAC token send-push mints for call-decline
 * (callId + receiverId + short expiry). It can only mark THIS call ringing for
 * THIS receiver, only while it is still in_progress. verify_jwt = false
 * (supabase/config.toml): the native receiver has no user session.
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
  if (!verdict.ok) return json({ error: verdict.reason }, verdict.reason === "bad_request" ? 400 : 403);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin.rpc("mark_call_ringing", { _call_id: body.callId, _receiver_id: body.receiverId });
  if (error) { console.log(JSON.stringify({ event: "ringing_failed", code: error.code })); return json({ error: "update_failed" }, 500); }
  return json({ ringing: data === true });
});
