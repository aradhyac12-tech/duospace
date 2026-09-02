// send-push — production FCM HTTP v1 dispatcher for DuoSpace.
//
// Two ways this function is invoked:
//   1. Internally, by Postgres triggers (see the fcm_push_notifications.sql
//      migration) whenever a message/reaction/call/partner_request row
//      changes. These calls carry `Authorization: Bearer <service_role_key>`
//      and `{ internal: true, ... }` in the body — fully trusted, since only
//      the database itself (via Vault-stored secrets) can present that key.
//   2. Directly from an authenticated client (e.g. a future "send a custom
//      notification" admin action). These calls must present a normal user
//      JWT and may only impersonate themselves as `senderId`.
//
// No Firebase credential is ever hardcoded — FIREBASE_PROJECT_ID /
// FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY are read exclusively from
// Supabase secrets inside _shared/firebaseAuth.ts.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, handleOptions } from "../_shared/cors.ts";
import { consumeRateLimit } from "../_shared/rateLimit.ts";
import { FirebaseConfigError, readServiceAccountEnv } from "../_shared/firebaseAuth.ts";
import { buildNotificationContent, sendToToken, ttlSecondsFor } from "../_shared/fcm.ts";
import { normalizeCallRingtone, normalizeMessageSound } from "../_shared/soundCatalog.ts";
import { CALL_TYPES, MESSAGE_LIKE_TYPES, PushToken, SendPushResponse, ValidationError, validateBody } from "../_shared/pushTypes.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = (Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY"))!;

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleOptions();
  if (req.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, 405);
  }

  // Fail fast (and loudly, in logs only) if the Firebase service account
  // secrets aren't configured, instead of doing DB work first and failing
  // per-token later. Error message names the missing env vars, never values.
  try {
    readServiceAccountEnv();
  } catch (e) {
    if (e instanceof FirebaseConfigError) {
      console.error("[send-push] configuration error:", e.message);
      return json({ success: false, error: "Push notifications are not configured on the server." }, 500);
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

  let body;
  try {
    body = validateBody(await req.json().catch(() => ({})));
  } catch (e) {
    if (e instanceof ValidationError) return json({ success: false, error: e.message }, 400);
    return json({ success: false, error: "Invalid request body" }, 400);
  }

  // Non-internal callers may only send as themselves (except pure system
  // broadcasts which have no sender at all).
  if (!isInternalCaller && body.senderId && body.senderId !== callerUserId) {
    return json({ success: false, error: "senderId must match the authenticated user" }, 403);
  }
  if (!isInternalCaller && body.type !== "custom") {
    // Client-invoked, non-custom pushes are rate-limited per sender to stop abuse.
    const allowed = await consumeRateLimit(callerUserId!, "send-push", 60, 60);
    if (!allowed) return json({ success: false, error: "Rate limited" }, 429);
  }

  const recipientIds = Array.from(new Set(body.recipientIds ?? (body.recipientId ? [body.recipientId] : [])));
  if (recipientIds.length === 0) return json({ success: false, error: "No recipient specified" }, 400);

  // FCM v1 requires one call per token, so fan out and aggregate per
  // recipient into a single notification_history row per recipient.
  const responses: SendPushResponse[] = [];
  for (const recipientId of recipientIds) {
    responses.push(await dispatchToRecipient(admin, recipientId, body));
  }

  const anyDelivered = responses.some((r) => r.delivery.status === "sent" || r.delivery.status === "partial");
  const allSkipped = responses.every((r) => r.delivery.status === "skipped");
  const anyHardFailure = responses.some((r) => r.delivery.status === "failed");
  const httpStatus = anyHardFailure && !anyDelivered && !allSkipped ? 502 : 200;

  return json({ success: anyDelivered || allSkipped, recipients: responses }, httpStatus);
});

async function dispatchToRecipient(
  admin: SupabaseClient,
  recipientId: string,
  body: ReturnType<typeof validateBody>,
): Promise<SendPushResponse> {
  const skip = async (reason: string): Promise<SendPushResponse> => {
    const { data } = await admin.from("notification_history").insert({
      recipient_id: recipientId,
      sender_id: body.senderId ?? null,
      notification_type: body.type,
      conversation_id: body.conversationId ?? null,
      related_id: body.messageId ?? body.callId ?? body.relatedId ?? null,
      delivery_status: "skipped",
      skip_reason: reason,
      data: body.data ?? {},
    }).select("id").maybeSingle();
    return { success: true, notificationHistoryId: data?.id, delivery: { status: "skipped", reason, attempted: 0, succeeded: 0, results: [] } };
  };

  // 1. Recipient must exist and not have deleted their account.
  const { data: recipientProfile } = await admin
    .from("profiles")
    .select("user_id, push_token, push_platform")
    .eq("user_id", recipientId)
    .maybeSingle();
  if (!recipientProfile) return skip("recipient_not_found");

  // 2. Blocked-sender check.
  if (body.senderId) {
    const { data: blocked } = await admin
      .from("blocked_users")
      .select("id")
      .eq("user_id", recipientId)
      .eq("blocked_user_id", body.senderId)
      .maybeSingle();
    if (blocked) return skip("sender_blocked");
  }

  // 3. Notification preferences: per-type opt-out, do-not-disturb, mute.
  const { data: prefs } = await admin
    .from("notification_preferences")
    .select("*")
    .eq("user_id", recipientId)
    .maybeSingle();
  if (prefs) {
    if (prefs.do_not_disturb && !CALL_TYPES.has(body.type)) return skip("do_not_disturb");
    if (prefs.muted_until && new Date(prefs.muted_until).getTime() > Date.now()) return skip("muted");
    if (MESSAGE_LIKE_TYPES.has(body.type) && prefs.messages_enabled === false && body.type !== "reaction" && body.type !== "mention") {
      return skip("messages_disabled");
    }
    if (body.type === "reaction" && prefs.reactions_enabled === false) return skip("reactions_disabled");
    if (body.type === "mention" && prefs.mentions_enabled === false) return skip("mentions_disabled");
    if (CALL_TYPES.has(body.type) && prefs.calls_enabled === false) return skip("calls_disabled");
    if ((body.type === "friend_request" || body.type === "friend_accepted") && prefs.friend_requests_enabled === false) {
      return skip("friend_requests_disabled");
    }
    if ((body.type === "group_message" || body.type === "group_invitation") && prefs.group_enabled === false) {
      return skip("group_disabled");
    }
  }

  // 3.5. Active-chat suppression: recipient is already looking at this
  // exact thread right now, so a push would just be a redundant/annoying
  // duplicate of what's already on their screen. Deliberately scoped to
  // direct 1:1 message-like types with a known sender — group_message has
  // no equivalent presence signal (no per-group screen heartbat exists),
  // and this must never suppress a call or friend-request push (those are
  // real events regardless of what screen someone's on).
  const DIRECT_MESSAGE_TYPES = new Set([
    "chat_message", "image_message", "video_message", "audio_message",
    "file_message", "reply", "reaction", "mention",
  ]);
  if (DIRECT_MESSAGE_TYPES.has(body.type) && body.senderId) {
    const { data: heartbeat } = await admin
      .from("active_chat_presence")
      .select("updated_at")
      .eq("user_id", recipientId)
      .eq("partner_id", body.senderId)
      .maybeSingle();
    // 20s window: client heartbeats every 15s while the thread is visible
    // (see useActiveChatPresence.ts), so 20s tolerates one missed beat
    // (a slow network tick) without letting a truly stale row (app was
    // closed, phone locked) suppress a push it shouldn't.
    if (heartbeat && Date.now() - new Date(heartbeat.updated_at).getTime() < 20_000) {
      return skip("recipient_viewing_chat");
    }
  }

  // 4. Resolve every valid device token for this recipient (multi-device).
  const { data: tokenRows } = await admin
    .from("push_tokens")
    .select("token, platform")
    .eq("user_id", recipientId)
    .eq("is_valid", true);

  let tokens: PushToken[] = (tokenRows ?? []).map((t: { token: string; platform: string }) => ({
    token: t.token,
    platform: t.platform as PushToken["platform"],
  }));
  if (tokens.length === 0 && recipientProfile.push_token) {
    // Fallback for accounts that predate push_tokens/the sync trigger.
    tokens = [{ token: recipientProfile.push_token, platform: (recipientProfile.push_platform as PushToken["platform"]) ?? "android" }];
  }
  if (tokens.length === 0) return skip("no_push_token");

  // 5. Sender display name/avatar for the notification body (best-effort).
  let senderName = "DuoSpace";
  let senderAvatar: string | null = null;
  if (body.senderId) {
    const { data: senderProfile } = await admin
      .from("profiles")
      .select("display_name, pet_name, avatar_url")
      .eq("user_id", body.senderId)
      .maybeSingle();
    if (senderProfile) {
      senderName = senderProfile.pet_name || senderProfile.display_name || "DuoSpace";
      senderAvatar = senderProfile.avatar_url ?? null;
    }
  }

  // 6. Unread count for message-like notifications (badge + grouping context).
  let unreadCount = 0;
  if (MESSAGE_LIKE_TYPES.has(body.type) && body.senderId) {
    const { count } = await admin
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("sender_id", body.senderId)
      .eq("receiver_id", recipientId)
      .eq("is_read", false);
    unreadCount = count ?? 0;
  }

  // Recipient's chosen notification sound + call ringtone (prefs was already
  // fetched with select("*") above, so the new columns come along for free).
  const messageSound = normalizeMessageSound(prefs?.message_sound);
  const callRingtone = normalizeCallRingtone(prefs?.call_ringtone);

  let content;
  try {
    content = buildNotificationContent(body, senderName, senderAvatar, unreadCount, messageSound, callRingtone);
  } catch (e) {
    console.error("[send-push] failed building notification content", e);
    return skip("content_build_failed");
  }

  const ttl = ttlSecondsFor(body.type);
  const results = await Promise.all(tokens.map((t) => sendToToken(t, content, ttl)));

  const succeeded = results.filter((r) => r.success).length;
  const invalidTokens = results.filter((r) => r.shouldInvalidate).map((r) => r.token);
  if (invalidTokens.length > 0) {
    // Requirement: automatically remove invalid/expired tokens after
    // permanent failures (UNREGISTERED / INVALID_ARGUMENT / SENDER_ID_MISMATCH).
    await admin.from("push_tokens")
      .update({ is_valid: false, invalidated_reason: "fcm_permanent_failure" })
      .in("token", invalidTokens);
    // Also clear the single-slot convenience column if it matches, so the
    // client's next registration cleanly re-populates it.
    if (recipientProfile.push_token && invalidTokens.includes(recipientProfile.push_token)) {
      await admin.from("profiles").update({ push_token: null }).eq("user_id", recipientId);
    }
  }

  const status: "sent" | "partial" | "failed" = succeeded === 0 ? "failed" : (succeeded === results.length ? "sent" : "partial");
  const { data: historyRow } = await admin.from("notification_history").insert({
    recipient_id: recipientId,
    sender_id: body.senderId ?? null,
    notification_type: body.type,
    title: content.title,
    body: content.body,
    data: content.data,
    conversation_id: body.conversationId ?? null,
    related_id: body.messageId ?? body.callId ?? body.relatedId ?? null,
    delivery_status: status,
    fcm_message_ids: results.filter((r) => r.messageId).map((r) => r.messageId as string),
    error_detail: results.find((r) => !r.success)?.error ?? null,
    tokens_attempted: results.length,
    tokens_succeeded: succeeded,
  }).select("id").maybeSingle();

  if (status === "failed") {
    console.error(`[send-push] all sends failed for recipient=${recipientId} type=${body.type}`, results.map((r) => r.error));
  }

  return {
    success: succeeded > 0,
    notificationHistoryId: historyRow?.id,
    delivery: { status, attempted: results.length, succeeded, results },
  };
}
