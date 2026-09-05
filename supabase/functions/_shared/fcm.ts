// Builds and sends FCM HTTP v1 messages. No legacy server-key API is used
// anywhere in this file — every request is authenticated with the OAuth2
// bearer token minted in firebaseAuth.ts from the Firebase service account.
import { getAccessToken } from "./firebaseAuth.ts";
import { CALL_TYPES, NotificationContent, PushNotificationType, PushToken, SendPushRequestBody, SendResult } from "./pushTypes.ts";
import {
  CallRingtoneId, DEFAULT_CALL_RINGTONE, DEFAULT_MESSAGE_SOUND, MessageSoundId,
  callChannelId, messageChannelId, normalizeCallRingtone, normalizeMessageSound,
} from "./soundCatalog.ts";

const FCM_ENDPOINT_BASE = "https://fcm.googleapis.com/v1/projects";

// Android notification channels the app must create client-side (see
// scripts/patch-native-permissions.mjs + PUSH_NOTIFICATIONS.md). Using the
// right channel id is what makes calls ring with full-screen/high-importance
// behavior versus a normal muted-by-default message ping.
//
// `messages` and `calls` are resolved per-recipient to one of several
// sound-variant channels (see soundCatalog.ts) rather than a single fixed
// id — Android freezes a channel's sound+vibration at creation time, so
// "multiple selectable sounds" means multiple physical channels, one per
// sound, all created upfront by NotificationChannels.kt. reactions/system
// stay single-channel; they're low-frequency enough not to need it.
const CHANNELS = {
  reactions: "duospace_reactions",
  system: "duospace_system",
} as const;

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

/**
 * Maps a validated request body -> the notification title/body/data/priority
 * to send. `messageSound`/`callRingtone` are the recipient's saved
 * notification_preferences choices (see soundCatalog.ts) — they select which
 * of the pre-created Android channel variants to route through, and are also
 * echoed into `data` so the native side (CallRingingService for calls; the
 * iOS apns.sound field below for messages) can pick the matching bundled
 * asset directly, independent of the Android channel mechanism.
 */
export function buildNotificationContent(
  body: SendPushRequestBody,
  senderName: string,
  senderAvatar: string | null,
  unreadCount: number,
  messageSound: MessageSoundId = DEFAULT_MESSAGE_SOUND,
  callRingtone: CallRingtoneId = DEFAULT_CALL_RINGTONE,
): NotificationContent {
  const conversationId = body.conversationId ?? undefined;
  const msgSound = normalizeMessageSound(messageSound);
  const callSound = normalizeCallRingtone(callRingtone);
  const MESSAGES = messageChannelId(msgSound);
  const CALLS = callChannelId(callSound);
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
    messageSound: msgSound,
    callRingtone: callSound,
    ...(body.data ?? {}),
  };

  switch (body.type) {
    case "chat_message":
      return { title: senderName, body: truncate(body.preview, 140) || "Sent you a message", data: baseData, channelId: MESSAGES, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "image_message":
      return { title: senderName, body: "\ud83d\udcf7 Sent a photo", data: baseData, channelId: MESSAGES, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "video_message":
      return { title: senderName, body: "\ud83c\udfa5 Sent a video", data: baseData, channelId: MESSAGES, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "audio_message":
      return { title: senderName, body: "\ud83c\udfa4 Sent a voice message", data: baseData, channelId: MESSAGES, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "file_message":
      return { title: senderName, body: `\ud83d\udcce Sent a file${body.fileName ? `: ${truncate(body.fileName, 60)}` : ""}`, data: baseData, channelId: MESSAGES, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "reply":
      return { title: `${senderName} replied`, body: truncate(body.preview, 140) || "Replied to your message", data: baseData, channelId: MESSAGES, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "reaction":
      return { title: senderName, body: `Reacted ${body.emoji ?? "\ud83d\udc4d"} to your message`, data: baseData, channelId: CHANNELS.reactions, priority: "normal", isCallAlert: false, groupKey: conversationId };
    case "mention":
      return { title: `${senderName} mentioned you`, body: truncate(body.preview, 140) || "You were mentioned", data: baseData, channelId: MESSAGES, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "group_message":
      return { title: senderName, body: truncate(body.preview, 140) || "New group message", data: baseData, channelId: MESSAGES, priority: "high", isCallAlert: false, groupKey: conversationId };
    case "group_invitation":
      return { title: "Group invitation", body: `${senderName} invited you to a group`, data: baseData, channelId: CHANNELS.system, priority: "normal", isCallAlert: false };
    case "friend_request":
      return { title: "New partner request", body: `${senderName} wants to connect with you`, data: baseData, channelId: CHANNELS.system, priority: "normal", isCallAlert: false };
    case "friend_accepted":
      return { title: "Request accepted", body: `${senderName} accepted your request`, data: baseData, channelId: CHANNELS.system, priority: "normal", isCallAlert: false };
    case "incoming_audio_call":
      return {
        title: senderName, body: "Incoming voice call", data: baseData, channelId: CALLS,
        priority: "high", isCallAlert: true,
        actions: [{ action: "ACCEPT_CALL", title: "Accept" }, { action: "DECLINE_CALL", title: "Decline" }],
      };
    case "incoming_video_call":
      return {
        title: senderName, body: "Incoming video call", data: baseData, channelId: CALLS,
        priority: "high", isCallAlert: true,
        actions: [{ action: "ACCEPT_CALL", title: "Accept" }, { action: "DECLINE_CALL", title: "Decline" }],
      };
    case "missed_call":
      return { title: "Missed call", body: `You missed a call from ${senderName}`, data: baseData, channelId: CALLS, priority: "high", isCallAlert: false };
    case "call_ended":
      return { title: "Call ended", body: "The call has ended", data: baseData, channelId: CALLS, priority: "normal", isCallAlert: false };
    case "call_rejected":
      return { title: "Call declined", body: `${senderName} declined the call`, data: baseData, channelId: CALLS, priority: "normal", isCallAlert: false };
    case "typing":
      return { title: senderName, body: "is typing\u2026", data: baseData, channelId: MESSAGES, priority: "normal", isCallAlert: false, groupKey: conversationId };
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
    apns?: {
      headers?: Record<string, string>;
      payload: {
        aps: {
          alert?: { title: string; body: string };
          sound?: string | { critical?: number; name: string; volume?: number };
          "content-available"?: number;
          "mutable-content"?: number;
        };
      };
    };
  };
}

function buildFcmMessage(token: string, content: NotificationContent, ttlSeconds: number, platform: PushToken["platform"]): FcmV1Message {
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

  // iOS: real calls ring through the separate direct-APNs VoIP/PushKit path
  // (send-voip-push + CallKitManager.swift), never through this FCM v1
  // message — so `apns` here only ever needs to cover regular message-type
  // alerts, giving them the recipient's chosen custom sound file (must be a
  // bundled .caf matching data.messageSound, e.g. "chime_msg.caf" — see
  // native/ios/Sounds/). This block is a no-op unless the recipient's push
  // token happens to be a genuine FCM-registration token; a raw APNs token
  // saved via @capacitor/push-notifications on iOS would need Firebase's
  // iOS SDK wired in for FCM v1 to reach it at all — that wiring is outside
  // this change and is called out in PUSH_NOTIFICATIONS.md.
  if (platform === "ios" && !content.isCallAlert) {
    msg.message.apns = {
      payload: {
        aps: {
          alert: { title: content.title, body: content.body },
          sound: `${content.data.messageSound ?? "classic"}_msg.caf`,
          "mutable-content": 1,
        },
      },
    };
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
        body: JSON.stringify(buildFcmMessage(pushToken.token, content, ttlSeconds, pushToken.platform)),
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
