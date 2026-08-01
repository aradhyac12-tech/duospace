// Builds and sends FCM HTTP v1 messages. No legacy server-key API is used
// anywhere in this file — every request is authenticated with the OAuth2
// bearer token minted in firebaseAuth.ts from the Firebase service account.
import { getAccessToken } from "./firebaseAuth.ts";
import { CALL_TYPES, NotificationContent, PushNotificationType, PushToken, SendPushRequestBody, SendResult } from "./pushTypes.ts";

const FCM_ENDPOINT_BASE = "https://fcm.googleapis.com/v1/projects";

// Android notification channels the app must create client-side (see
// scripts/patch-native-permissions.mjs + PUSH_NOTIFICATIONS.md). Using the
// right channel id is what makes calls ring with full-screen/high-importance
// behavior versus a normal muted-by-default message ping.
const CHANNELS = {
  messages: "duospace_messages",
  calls: "duospace_incoming_calls",
  reactions: "duospace_reactions",
  system: "duospace_system",
} as const;

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

/** Maps a validated request body -> the notification title/body/data/priority to send. */
export function buildNotificationContent(
  body: SendPushRequestBody,
  senderName: string,
  senderAvatar: string | null,
  unreadCount: number,
): NotificationContent {
  const conversationId = body.conversationId ?? undefined;
  const baseData: Record<string, string> = {
    type: body.type,
    ...(body.senderId ? { senderId: body.senderId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(body.messageId ? { messageId: body.messageId } : {}),
    ...(body.relatedId ? { relatedId: body.relatedId } : {}),
    ...(body.callId ? { callId: body.callId } : {}),
    ...(body.roomName ? { roomName: body.roomName } : {}),
    senderName,
    ...(senderAvatar ? { senderAvatar } : {}),
    unreadCount: String(unreadCount),
    timestamp: body.createdAt ?? new Date().toISOString(),
    ...(body.data ?? {}),
  };

  switch (body.type) {
    case "chat_message":
      return { title: senderName, body: truncate(body.preview, 140) || "Sent you a message", data: baseData, channelId: CHANNELS.messages, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "image_message":
      return { title: senderName, body: "\ud83d\udcf7 Sent a photo", data: baseData, channelId: CHANNELS.messages, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "video_message":
      return { title: senderName, body: "\ud83c\udfa5 Sent a video", data: baseData, channelId: CHANNELS.messages, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "audio_message":
      return { title: senderName, body: "\ud83c\udfa4 Sent a voice message", data: baseData, channelId: CHANNELS.messages, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "file_message":
      return { title: senderName, body: `\ud83d\udcce Sent a file${body.fileName ? `: ${truncate(body.fileName, 60)}` : ""}`, data: baseData, channelId: CHANNELS.messages, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "reply":
      return { title: `${senderName} replied`, body: truncate(body.preview, 140) || "Replied to your message", data: baseData, channelId: CHANNELS.messages, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "reaction":
      return { title: senderName, body: `Reacted ${body.emoji ?? "\ud83d\udc4d"} to your message`, data: baseData, channelId: CHANNELS.reactions, priority: "normal", isCallAlert: false, groupKey: conversationId };
    case "mention":
      return { title: `${senderName} mentioned you`, body: truncate(body.preview, 140) || "You were mentioned", data: baseData, channelId: CHANNELS.messages, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "group_message":
      return { title: senderName, body: truncate(body.preview, 140) || "New group message", data: baseData, channelId: CHANNELS.messages, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "group_invitation":
      return { title: "Group invitation", body: `${senderName} invited you to a group`, data: baseData, channelId: CHANNELS.system, priority: "normal", isCallAlert: false };
    case "friend_request":
      return { title: "New partner request", body: `${senderName} wants to connect with you`, data: baseData, channelId: CHANNELS.system, priority: "normal", isCallAlert: false };
    case "friend_accepted":
      return { title: "Request accepted", body: `${senderName} accepted your request`, data: baseData, channelId: CHANNELS.system, priority: "normal", isCallAlert: false };
    case "incoming_audio_call":
      return {
        title: senderName, body: "Incoming voice call", data: baseData, channelId: CHANNELS.calls,
        priority: "high", isCallAlert: true,
        actions: [{ action: "ACCEPT_CALL", title: "Accept" }, { action: "DECLINE_CALL", title: "Decline" }],
      };
    case "incoming_video_call":
      return {
        title: senderName, body: "Incoming video call", data: baseData, channelId: CHANNELS.calls,
        priority: "high", isCallAlert: true,
        actions: [{ action: "ACCEPT_CALL", title: "Accept" }, { action: "DECLINE_CALL", title: "Decline" }],
      };
    case "missed_call":
      return { title: "Missed call", body: `You missed a call from ${senderName}`, data: baseData, channelId: CHANNELS.calls, priority: "high", isCallAlert: false };
    case "call_ended":
      return { title: "Call ended", body: "The call has ended", data: baseData, channelId: CHANNELS.calls, priority: "normal", isCallAlert: false };
    case "call_rejected":
      return { title: "Call declined", body: `${senderName} declined the call`, data: baseData, channelId: CHANNELS.calls, priority: "normal", isCallAlert: false };
    case "typing":
      return { title: senderName, body: "is typing\u2026", data: baseData, channelId: CHANNELS.messages, priority: "normal", isCallAlert: false, groupKey: conversationId };
    case "custom":
      return { title: body.title ?? "DuoSpace", body: body.body ?? "", data: baseData, channelId: CHANNELS.system, priority: "normal", isCallAlert: false };
    default: {
      const _exhaustive: never = body.type;
      throw new Error(`Unhandled notification type: ${_exhaustive}`);
    }
  }
}

interface FcmV1Message {
  message: {
    token: string;
    data: Record<string, string>;
    notification?: { title: string; body: string };
    android: {
      priority: "HIGH" | "NORMAL";
      ttl?: string;
      collapse_key?: string;
      notification?: {
        channel_id: string;
        tag?: string;
        notification_priority?: string;
        default_sound?: boolean;
        default_vibrate_timings?: boolean;
        visibility?: string;
        sticky?: boolean;
      };
      direct_boot_ok?: boolean;
    };
  };
}

function buildFcmMessage(token: string, content: NotificationContent, ttlSeconds: number): FcmV1Message {
  const isHigh = content.priority === "high" || content.isCallAlert;
  const msg: FcmV1Message = {
    message: {
      token,
      // All values must be strings for FCM's `data` map.
      data: content.data,
      android: {
        priority: isHigh ? "HIGH" : "NORMAL",
        ttl: `${ttlSeconds}s`,
        collapse_key: content.groupKey,
        direct_boot_ok: true,
        notification: {
          channel_id: content.channelId,
          tag: content.groupKey,
          notification_priority: content.isCallAlert ? "PRIORITY_MAX" : (isHigh ? "PRIORITY_HIGH" : "PRIORITY_DEFAULT"),
          default_sound: true,
          default_vibrate_timings: true,
          visibility: "PRIVATE",
          sticky: content.isCallAlert,
        },
      },
    },
  };

  // Calls are sent data-only (no top-level `notification`) so the app's
  // FirebaseMessagingService always receives onMessageReceived — even in
  // the background/killed state — and can build the full-screen-intent
  // ringing UI itself (see android/CallNotificationService.kt). A top-level
  // `notification` block would let the OS auto-display a plain notification
  // when the app is backgrounded, bypassing our custom ringing UI.
  if (!content.isCallAlert) {
    msg.message.notification = { title: content.title, body: content.body };
  } else {
    // Still carry title/body inside `data` so the native service can render them.
    msg.message.data.title = content.title;
    msg.message.data.body = content.body;
  }

  return msg;
}

interface FcmErrorBody {
  error?: {
    status?: string;
    message?: string;
    details?: Array<{ errorCode?: string }>;
  };
}

function classifyFailure(status: number, body: FcmErrorBody): { retryable: boolean; permanent: boolean; reason: string } {
  const fcmErrorCode = body.error?.details?.find((d) => d.errorCode)?.errorCode;
  const statusText = body.error?.status ?? "";

  if (fcmErrorCode === "UNREGISTERED" || statusText === "NOT_FOUND" || status === 404) {
    return { retryable: false, permanent: true, reason: "UNREGISTERED" };
  }
  if (fcmErrorCode === "INVALID_ARGUMENT" || fcmErrorCode === "SENDER_ID_MISMATCH" || statusText === "INVALID_ARGUMENT") {
    return { retryable: false, permanent: true, reason: fcmErrorCode ?? statusText };
  }
  if (status === 429 || statusText === "RESOURCE_EXHAUSTED") {
    return { retryable: true, permanent: false, reason: "RESOURCE_EXHAUSTED" };
  }
  if (status >= 500 || statusText === "UNAVAILABLE" || statusText === "INTERNAL") {
    return { retryable: true, permanent: false, reason: statusText || `HTTP ${status}` };
  }
  return { retryable: false, permanent: false, reason: statusText || `HTTP ${status}` };
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 400;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends a single FCM message with exponential backoff for transient
 * failures (UNAVAILABLE / INTERNAL / RESOURCE_EXHAUSTED, up to
 * MAX_ATTEMPTS). Permanent failures (invalid/unregistered token) are
 * classified so the caller can prune the token from push_tokens.
 */
export async function sendToToken(
  pushToken: PushToken,
  content: NotificationContent,
  ttlSeconds: number,
): Promise<SendResult> {
  let lastError = "Unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { accessToken, projectId } = await getAccessToken();
      const res = await fetch(`${FCM_ENDPOINT_BASE}/${projectId}/messages:send`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; UTF-8",
        },
        body: JSON.stringify(buildFcmMessage(pushToken.token, content, ttlSeconds)),
      });

      if (res.ok) {
        const json = (await res.json()) as { name?: string };
        return { token: pushToken.token, success: true, messageId: json.name };
      }

      const errBody = (await res.json().catch(() => ({}))) as FcmErrorBody;
      const { retryable, permanent, reason } = classifyFailure(res.status, errBody);
      lastError = reason;

      // Never log the token itself alongside secrets; log a truncated
      // fingerprint only, and never log the OAuth bearer token.
      console.warn(`[fcm] send failed (attempt ${attempt}/${MAX_ATTEMPTS}) status=${res.status} reason=${reason} token=${pushToken.token.slice(0, 12)}\u2026`);

      if (permanent) {
        return { token: pushToken.token, success: false, error: reason, shouldInvalidate: true };
      }
      if (!retryable || attempt === MAX_ATTEMPTS) {
        return { token: pushToken.token, success: false, error: reason };
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 100);
    } catch (e) {
      lastError = e instanceof Error ? e.message : "network error";
      console.warn(`[fcm] transport error (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastError}`);
      if (attempt === MAX_ATTEMPTS) {
        return { token: pushToken.token, success: false, error: lastError };
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 100);
    }
  }

  return { token: pushToken.token, success: false, error: lastError };
}

export function ttlSecondsFor(type: PushNotificationType): number {
  // Calls should never be delivered late (ringing after the call ended is
  // worse than not ringing at all); everything else can tolerate an hour.
  return CALL_TYPES.has(type) ? 30 : 3600;
}
