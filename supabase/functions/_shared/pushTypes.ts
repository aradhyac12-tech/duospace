// Shared types for the send-push Edge Function.
//
// NOTE ON SCOPE: DuoSpace's schema is a 1:1 "couple" app (profiles.partner_id)
// with no conversations/groups/friends/mentions tables. The notification
// `type` enum below still includes group_message / group_invitation / mention
// / typing so the API surface is ready the day those features exist, but only
// the types with a real DB trigger (see the fcm_push_notifications.sql
// migration) are dispatched automatically today. See PUSH_NOTIFICATIONS.md.

export type PushNotificationType =
  | "chat_message"
  | "image_message"
  | "video_message"
  | "audio_message"
  | "file_message"
  | "reaction"
  | "reply"
  | "mention"
  | "friend_request"
  | "friend_accepted"
  | "group_invitation"
  | "group_message"
  | "missed_call"
  | "incoming_audio_call"
  | "incoming_video_call"
  | "call_ended"
  | "call_rejected"
  | "typing"
  | "custom";

export const CALL_TYPES: ReadonlySet<PushNotificationType> = new Set([
  "missed_call",
  "incoming_audio_call",
  "incoming_video_call",
  "call_ended",
  "call_rejected",
]);

export const MESSAGE_LIKE_TYPES: ReadonlySet<PushNotificationType> = new Set([
  "chat_message",
  "image_message",
  "video_message",
  "audio_message",
  "file_message",
  "reaction",
  "reply",
  "mention",
  "group_message",
]);

export interface SendPushRequestBody {
  /** true only when the caller authenticated with the service-role key (DB trigger). Never trust this flag on its own. */
  internal?: boolean;
  type: PushNotificationType;
  /** Required for every type except broadcast-style "custom" pushes. */
  senderId?: string | null;
  recipientId?: string;
  recipientIds?: string[];
  conversationId?: string | null;
  relatedId?: string | null;
  messageId?: string | null;
  replyToId?: string | null;
  callId?: string | null;
  callType?: "audio" | "video" | "voice" | null;
  roomName?: string | null;
  preview?: string | null;
  fileName?: string | null;
  emoji?: string | null;
  durationSeconds?: number | null;
  createdAt?: string | null;
  /** Overrides for `custom` notifications. */
  title?: string | null;
  body?: string | null;
  data?: Record<string, string> | null;
}

export interface PushToken {
  token: string;
  platform: "android" | "ios" | "web";
}

export interface NotificationContent {
  title: string;
  body: string;
  /** Extra key/value payload merged into the FCM `data` block (all values must be strings for FCM). */
  data: Record<string, string>;
  /** Android notification channel id to route through. */
  channelId: string;
  /** "high" -> AndroidConfig priority HIGH + urgent delivery; "normal" otherwise. */
  priority: "high" | "normal";
  /** True for ringing calls: full-screen intent + wake device + ongoing. */
  isCallAlert: boolean;
  /** Grouping key for Android notification stacking (conversation thread). */
  groupKey?: string;
  /** Android notification actions (Accept/Decline, etc). */
  actions?: Array<{ action: string; title: string }>;
}

export interface SendResult {
  token: string;
  success: boolean;
  messageId?: string;
  error?: string;
  /** Set when the token should be deleted from push_tokens (permanent failure). */
  shouldInvalidate?: boolean;
}

export interface SendPushResponse {
  success: boolean;
  notificationHistoryId?: string;
  delivery: {
    status: "sent" | "partial" | "failed" | "skipped";
    reason?: string;
    attempted: number;
    succeeded: number;
    results: SendResult[];
  };
  error?: string;
}

const VALID_TYPES: ReadonlySet<string> = new Set([
  "chat_message", "image_message", "video_message", "audio_message", "file_message",
  "reaction", "reply", "mention", "friend_request", "friend_accepted",
  "group_invitation", "group_message", "missed_call", "incoming_audio_call",
  "incoming_video_call", "call_ended", "call_rejected", "typing", "custom",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ValidationError extends Error {}

/**
 * Hand-rolled validation (no external zod dependency needed for this single
 * function) that mirrors the strictness of a zod schema: required fields per
 * type, string length caps, and UUID shape checks.
 */
export function validateBody(raw: unknown): SendPushRequestBody {
  if (typeof raw !== "object" || raw === null) {
    throw new ValidationError("Request body must be a JSON object");
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.type !== "string" || !VALID_TYPES.has(b.type)) {
    throw new ValidationError(`"type" must be one of: ${Array.from(VALID_TYPES).join(", ")}`);
  }
  const type = b.type as PushNotificationType;

  const recipientId = typeof b.recipientId === "string" ? b.recipientId : undefined;
  const recipientIds = Array.isArray(b.recipientIds)
    ? b.recipientIds.filter((x): x is string => typeof x === "string")
    : undefined;

  if (!recipientId && (!recipientIds || recipientIds.length === 0)) {
    throw new ValidationError('"recipientId" or "recipientIds" is required');
  }
  for (const id of [recipientId, ...(recipientIds ?? [])]) {
    if (id && !UUID_RE.test(id)) throw new ValidationError(`Invalid recipient id: ${id}`);
  }

  if (type !== "custom" && b.senderId !== undefined && b.senderId !== null) {
    if (typeof b.senderId !== "string" || !UUID_RE.test(b.senderId)) {
      throw new ValidationError("Invalid senderId");
    }
  }

  if (type === "custom") {
    if (typeof b.title !== "string" || b.title.trim().length === 0) {
      throw new ValidationError('"title" is required for custom notifications');
    }
    if (typeof b.body !== "string" || b.body.trim().length === 0) {
      throw new ValidationError('"body" is required for custom notifications');
    }
  }

  const str = (v: unknown, max = 4000): string | null =>
    typeof v === "string" ? v.slice(0, max) : null;

  return {
    internal: b.internal === true,
    type,
    senderId: str(b.senderId, 100),
    recipientId,
    recipientIds,
    conversationId: str(b.conversationId, 200),
    relatedId: str(b.relatedId, 100),
    messageId: str(b.messageId, 100),
    replyToId: str(b.replyToId, 100),
    callId: str(b.callId, 100),
    callType: (b.callType === "audio" || b.callType === "video" || b.callType === "voice") ? b.callType : null,
    roomName: str(b.roomName, 500),
    preview: str(b.preview, 500),
    fileName: str(b.fileName, 300),
    emoji: str(b.emoji, 32),
    durationSeconds: typeof b.durationSeconds === "number" ? b.durationSeconds : null,
    createdAt: str(b.createdAt, 64),
    title: str(b.title, 200),
    body: str(b.body, 1000),
    data: (typeof b.data === "object" && b.data !== null) ? (b.data as Record<string, string>) : null,
  };
}
