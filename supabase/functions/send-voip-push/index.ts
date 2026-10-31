// send-voip-push — production APNs HTTP/2 VoIP dispatcher for DuoSpace's
// iOS CallKit/PushKit incoming-call flow.
//
// Deliberately separate from supabase/functions/send-push (FCM HTTP v1):
// VoIP pushes are a different Apple product (PushKit, `.voip` push type,
// `<bundle-id>.voip` topic, no `alert`/`sound`/`badge`) and must go
// directly to Apple's APNs Provider API — FCM cannot deliver them at all.
// Android's existing FCM incoming-call path (supabase/functions/send-push,
// wired from the SAME call_history triggers) is completely untouched by
// this function; the two dispatch independently and a call recipient with
// an Android device and an iOS device would receive both.
//
// Two ways this function is invoked (mirrors send-push's model exactly):
//   1. Internally, by Postgres triggers (see
//      20260808120000_ios_voip_push.sql: notify_voip_on_call_insert /
//      notify_voip_on_call_end) whenever a call_history row starts
//      ringing or stops ringing before being claimed. These calls carry
//      `Authorization: Bearer <service_role_key>` and `{ internal: true,
//      ... }` — fully trusted, since only the database itself (via
//      Vault-stored secrets) can present that key.
//   2. Directly from an authenticated client for manual/testing
//      invocation. These calls must present a normal user JWT and are
//      authorized against the actual call_history row (see
//      authorizeCallEvent below) — never trust caller-supplied
//      caller/recipient ids on their own.
//
// No APNs credential is ever hardcoded — APNS_TEAM_ID / APNS_KEY_ID /
// APNS_PRIVATE_KEY / APNS_BUNDLE_ID / APNS_ENVIRONMENT are read exclusively
// from Supabase secrets inside _shared/apnsAuth.ts.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";
import { ApnsConfigError, readApnsEnv } from "../_shared/apnsAuth.ts";
import { sendVoipPush, VoipPushEvent } from "../_shared/apns.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_EVENTS: ReadonlySet<string> = new Set(["incoming", "cancel", "answered_elsewhere"]);
const VALID_CALL_TYPES: ReadonlySet<string> = new Set(["voice", "video", "audio"]);

class ValidationError extends Error {}

interface RequestBody {
  internal?: boolean;
  event: VoipPushEvent;
  callId: string;
  callerId: string;
  recipientId: string;
  callType?: string | null;
  roomName?: string | null;
  reason?: string | null;
  createdAt?: string | null;
  /** Device that just won claim_call — excluded from fan-out so the
   *  answering device is never sent its own "hang up" push (item 8). */
  excludeDeviceId?: string | null;
}

function validateBody(raw: unknown): RequestBody {
  if (typeof raw !== "object" || raw === null) throw new ValidationError("Request body must be a JSON object");
  const b = raw as Record<string, unknown>;

  if (typeof b.event !== "string" || !VALID_EVENTS.has(b.event)) {
    throw new ValidationError('"event" must be "incoming", "cancel", or "answered_elsewhere"');
  }
  if (typeof b.callId !== "string" || !UUID_RE.test(b.callId)) throw new ValidationError("Invalid callId");
  if (typeof b.callerId !== "string" || !UUID_RE.test(b.callerId)) throw new ValidationError("Invalid callerId");
  if (typeof b.recipientId !== "string" || !UUID_RE.test(b.recipientId)) throw new ValidationError("Invalid recipientId");

  return {
    internal: b.internal === true,
    event: b.event as VoipPushEvent,
    callId: b.callId,
    callerId: b.callerId,
    recipientId: b.recipientId,
    callType: typeof b.callType === "string" ? b.callType.slice(0, 20) : null,
    roomName: typeof b.roomName === "string" ? b.roomName.slice(0, 500) : null,
    reason: typeof b.reason === "string" ? b.reason.slice(0, 100) : null,
    createdAt: typeof b.createdAt === "string" ? b.createdAt.slice(0, 64) : null,
    excludeDeviceId: typeof b.excludeDeviceId === "string" ? b.excludeDeviceId.slice(0, 200) : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  if (req.method !== "POST") return json({ success: false, error: "Method not allowed" }, 405);

  // Fail fast if APNs credentials aren't configured, before any DB work.
  // Error message names the missing secrets, never values.
  try {
    readApnsEnv();
  } catch (e) {
    if (e instanceof ApnsConfigError) {
      console.error("[send-voip-push] configuration error:", e.message);
      return json({ success: false, error: "VoIP push is not configured on the server." }, 500);
    }
    throw e;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const authHeader = req.headers.get("Authorization") ?? "";
  const presentedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  const isInternalCaller = presentedToken.length > 0 && presentedToken === SERVICE_ROLE_KEY;

  let callerUserId: string | null = null;
  if (!isInternalCaller) {
    if (!authHeader) return json({ success: false, error: "Unauthorized" }, 401);
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return json({ success: false, error: "Unauthorized" }, 401);
    callerUserId = user.id;
  }

  let body: RequestBody;
  try {
    body = validateBody(await req.json().catch(() => ({})));
  } catch (e) {
    if (e instanceof ValidationError) return json({ success: false, error: e.message }, 400);
    return json({ success: false, error: "Invalid request body" }, 400);
  }

  // SECURITY: server-side authorization against the actual call_history
  // row, never trusting the request body's caller/recipient/callId on
  // their own. Prevents spoofed caller IDs, unauthorized call pushes,
  // calling arbitrary users, and replaying a stale/reused call id for a
  // call that has since ended or was never that pairing to begin with.
  const authz = await authorizeCallEvent(admin, body, isInternalCaller, callerUserId);
  if (!authz.ok) return json({ success: false, error: authz.error }, authz.status);

  if (!isInternalCaller) {
    // Client-invoked calls are rate-limited per caller to stop abuse (e.g.
    // a compromised client hammering arbitrary call ids to enumerate
    // tokens or exhaust APNs quota).
    const allowed = await consumeRateLimit(callerUserId!, "send-voip-push", 30, 60);
    if (!allowed) return json({ success: false, error: "Rate limited" }, 429);
  }

  const result = await dispatchVoipPush(admin, body);
  const httpStatus = result.delivery.status === "failed" ? 502 : 200;
  return json(result, httpStatus);
});

/**
 * Confirms the call actually exists, that callerId/recipientId in the
 * request match the row's real caller_id/receiver_id, and that the event
 * type is consistent with the row's current state — so a client (or a
 * replayed/forged internal-looking request) can't push a "call from
 * anyone to anyone" or resurrect a long-dead call id.
 */
async function authorizeCallEvent(
  admin: SupabaseClient,
  body: RequestBody,
  isInternalCaller: boolean,
  callerUserId: string | null,
): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const { data: call, error } = await admin
    .from("call_history")
    .select("id, caller_id, receiver_id, status, call_type, started_at")
    .eq("id", body.callId)
    .maybeSingle();

  if (error || !call) return { ok: false, error: "Call not found", status: 404 };
  if (call.caller_id !== body.callerId || call.receiver_id !== body.recipientId) {
    return { ok: false, error: "callerId/recipientId do not match call record", status: 403 };
  }
  if (!isInternalCaller) {
    // A non-internal (user-JWT) request may only trigger events for a
    // call it is actually the caller of.
    if (callerUserId !== call.caller_id) return { ok: false, error: "Not authorized for this call", status: 403 };
  }

  // Replay protection: refuse to (re-)ring a call whose ringing window has
  // clearly passed (VoIP pushes are meant to be near-instant; a much older
  // "incoming" event is either a replay or a bug upstream).
  const ageMs = Date.now() - new Date(call.started_at).getTime();
  if (body.event === "incoming" && ageMs > 45_000) {
    return { ok: false, error: "Call is too old to ring (stale/replayed event)", status: 409 };
  }

  // "answered_elsewhere" only ever makes sense as an internal, trigger-fired
  // event (it fires directly off claimed_by transitioning in the DB — see
  // notify_voip_on_call_claim) — a client has no legitimate reason to ever
  // request it directly, so it's rejected outright for non-internal callers
  // rather than merely rate-limited.
  if (body.event === "answered_elsewhere" && !isInternalCaller) {
    return { ok: false, error: "answered_elsewhere may only be dispatched internally", status: 403 };
  }

  return { ok: true };
}

interface VoipDeliveryResult {
  success: boolean;
  delivery: {
    status: "sent" | "partial" | "failed" | "skipped";
    reason?: string;
    attempted: number;
    succeeded: number;
    results: Array<{ deviceId: string | null; success: boolean; error?: string }>;
  };
}

async function dispatchVoipPush(admin: SupabaseClient, body: RequestBody): Promise<VoipDeliveryResult> {
  const skip = (reason: string): VoipDeliveryResult => ({
    success: true,
    delivery: { status: "skipped", reason, attempted: 0, succeeded: 0, results: [] },
  });

  // Resolve every active VoIP token for this recipient (multi-device: an
  // iPhone and an iPad both registered would both ring, exactly like
  // Android's multi-device FCM fan-out in send-push).
  const { data: tokenRows } = await admin
    .from("push_tokens")
    .select("id, token, device_id")
    .eq("user_id", body.recipientId)
    .eq("token_type", "apns_voip")
    .eq("is_valid", true);

  if (!tokenRows || tokenRows.length === 0) return skip("no_voip_token");

  // Item 8 (answered elsewhere): never send a "hang up" event to the
  // device that just won the claim — see notify_voip_on_call_claim /
  // notify_voip_on_call_end in 20260808150000_call_hardening.sql, which is
  // what populates excludeDeviceId in the first place.
  const targetTokens = body.excludeDeviceId
    ? tokenRows.filter((r: { device_id: string | null }) => r.device_id !== body.excludeDeviceId)
    : tokenRows;
  if (targetTokens.length === 0) return skip("only_target_was_excluded_device");

  let callerName = "DuoSpace";
  const { data: callerProfile } = await admin
    .from("profiles")
    .select("display_name, pet_name")
    .eq("user_id", body.callerId)
    .maybeSingle();
  if (callerProfile) callerName = callerProfile.pet_name || callerProfile.display_name || "DuoSpace";

  const callType: "audio" | "video" = body.callType === "video" ? "video" : "audio";
  const timestamp = body.createdAt ?? new Date().toISOString();

  const results = await Promise.all(
    targetTokens.map((row: { id: string; token: string; device_id: string | null }) =>
      dispatchToDevice(admin, body, row, callerName, callType, timestamp)
    ),
  );

  const succeeded = results.filter((r) => r.success).length;
  const status: "sent" | "partial" | "failed" =
    succeeded === 0 ? "failed" : succeeded === results.length ? "sent" : "partial";

  return {
    success: succeeded > 0,
    delivery: { status, attempted: results.length, succeeded, results },
  };
}

async function dispatchToDevice(
  admin: SupabaseClient,
  body: RequestBody,
  tokenRow: { id: string; token: string; device_id: string | null },
  callerName: string,
  callType: "audio" | "video",
  timestamp: string,
): Promise<{ deviceId: string | null; success: boolean; error?: string }> {
  // IDEMPOTENCY (item 6/9): the same logical call event reaching the same
  // device must never produce two CallKit experiences, even if this
  // function is invoked twice for the same call/device/event (trigger
  // re-fire, manual re-dispatch, a crashed prior attempt). The
  // UNIQUE(call_id, push_token_id, event_type) constraint on
  // apns_push_log is the actual guard, but a first attempt that
  // ultimately FAILED must remain retryable — merely having logged an
  // attempt can't permanently block a legitimate later delivery, or a
  // transient APNs outage would silently and permanently break calling
  // for the rest of that call's lifetime. So: try to insert; on conflict,
  // look at the existing row — a 'sent' row means truly done (skip), but
  // a 'pending' (crashed mid-flight) or 'failed' row is reclaimed via a
  // second atomic CAS (`WHERE status <> 'sent'`) before retrying, so two
  // concurrent retriers can't both re-send either.
  const { data: claimed, error: claimErr } = await admin
    .from("apns_push_log")
    .insert({ call_id: body.callId, push_token_id: tokenRow.id, event_type: body.event, status: "pending" })
    .select("id")
    .maybeSingle();

  let logRowId: string | null = claimed?.id ?? null;

  if (claimErr || !logRowId) {
    const { data: existing } = await admin
      .from("apns_push_log")
      .select("id, status")
      .eq("call_id", body.callId)
      .eq("push_token_id", tokenRow.id)
      .eq("event_type", body.event)
      .maybeSingle();

    if (!existing) {
      // Insert failed for some other reason (not the unique constraint) —
      // log and give up on this device rather than send un-tracked.
      return { deviceId: tokenRow.device_id, success: false, error: "push_log_insert_failed" };
    }
    if (existing.status === "sent") {
      return { deviceId: tokenRow.device_id, success: true, error: "already_dispatched" };
    }
    // Reclaim a 'pending' or 'failed' row for retry — atomic CAS so a
    // second concurrent caller that also lost the initial insert race
    // can't ALSO reclaim it and double-send.
    const { data: reclaimed } = await admin
      .from("apns_push_log")
      .update({ status: "pending" })
      .eq("id", existing.id)
      .neq("status", "sent")
      .select("id")
      .maybeSingle();
    if (!reclaimed) {
      // Someone else reclaimed it first (or it flipped to 'sent' in the
      // interim) — treat as already handled rather than racing them.
      return { deviceId: tokenRow.device_id, success: true, error: "already_dispatched" };
    }
    logRowId = reclaimed.id;
  }

  const result = await sendVoipPush(tokenRow.token, {
    event: body.event,
    callId: body.callId,
    callerId: body.callerId,
    callerName,
    callType,
    timestamp,
  });

  await admin
    .from("apns_push_log")
    .update({
      status: result.success ? "sent" : "failed",
      apns_id: result.apnsId ?? null,
      http_status: result.httpStatus ?? null,
      error_detail: result.error ?? null,
    })
    .eq("id", logRowId);

  if (result.shouldInvalidate) {
    // Permanently invalid VoIP token (BadDeviceToken / DeviceTokenNotForTopic
    // / Unregistered) — deactivate so future calls stop trying it. The
    // device will re-register (PushKitManager.onTokenUpdated) if/when it
    // reinstalls or the token genuinely rotates.
    await admin.from("push_tokens").update({ is_valid: false, invalidated_reason: "apns_permanent_failure" }).eq("id", tokenRow.id);
  }

  if (!result.success) {
    console.error(`[send-voip-push] delivery failed device=${tokenRow.device_id ?? "unknown"} event=${body.event} reason=${result.error}`);
  }

  return { deviceId: tokenRow.device_id, success: result.success, error: result.error };
}
