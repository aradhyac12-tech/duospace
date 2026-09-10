// Sends VoIP pushes via Apple's APNs HTTP/2 Provider API. No FCM anywhere
// in this file — iOS VoIP pushes MUST go through APNs directly; FCM cannot
// deliver a `.voip` push type at all.
import { getApnsProviderToken } from "./apnsAuth.ts";

const APNS_HOST = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
} as const;

export type VoipPushEvent = "incoming" | "cancel" | "answered_elsewhere";

export interface VoipCallPayload {
  event: VoipPushEvent;
  callId: string;
  callerId: string;
  callerName: string;
  callType: "audio" | "video";
  timestamp: string;
}

/**
 * Minimal, secure VoIP payload — deliberately carries only what PushKit
 * needs to identify the call and let CallKit render its native UI. No
 * Daily access token, no Supabase JWT, no other private/long-lived
 * material: the native layer (PushKitManager -> CallKitManager -> JS)
 * fetches those separately, authenticated as the signed-in user, once the
 * call is actually being joined (see supabase/functions/daily-call).
 */
export function buildVoipPayload(p: VoipCallPayload): Record<string, unknown> {
  return {
    aps: {
      // No `alert`/`sound`/`badge` — VoIP pushes never display a system
      // notification; PushKit hands this straight to the app, which is
      // required to report a CallKit call immediately.
    },
    event: p.event,
    callId: p.callId,
    callerId: p.callerId,
    callerName: p.callerName,
    callType: p.callType,
    timestamp: p.timestamp,
  };
}

const MAX_PAYLOAD_BYTES = 5120; // Apple's VoIP payload limit (5KB, same as the general 4-5KB APNs cap)

export interface ApnsSendResult {
  success: boolean;
  apnsId?: string;
  httpStatus?: number;
  error?: string;
  /** Set when the token is permanently invalid and must be removed from push_tokens. */
  shouldInvalidate?: boolean;
}

interface ApnsErrorBody {
  reason?: string;
  timestamp?: number;
}

/**
 * Classifies Apple's documented APNs error `reason` values (see
 * docs/IOS_NATIVE_SETUP.md) into permanent (deactivate the token) vs
 * retryable (transient, bounded backoff) vs neither (log and give up
 * without touching the token — e.g. a config-shaped error that retrying
 * won't fix but isn't the token's fault).
 */
export function classifyApnsFailure(status: number, body: ApnsErrorBody): { retryable: boolean; permanent: boolean; reason: string } {
  const reason = body.reason ?? `HTTP ${status}`;

  switch (reason) {
    case "BadDeviceToken":
    case "DeviceTokenNotForTopic":
    case "Unregistered":
      return { retryable: false, permanent: true, reason };
    case "ExpiredProviderToken":
    case "InvalidProviderToken":
      // Not the token's fault — our provider JWT is stale/wrong. Caller
      // should re-mint (getApnsProviderToken's cache handles this
      // automatically on the next call) and this one attempt can retry.
      return { retryable: true, permanent: false, reason };
    case "BadTopic":
    case "PayloadTooLarge":
      // Configuration/programming error, not transient and not the
      // token's fault — retrying identically will fail identically.
      return { retryable: false, permanent: false, reason };
    case "TooManyRequests":
      return { retryable: true, permanent: false, reason };
    case "InternalServerError":
    case "Shutdown":
      return { retryable: true, permanent: false, reason };
    default:
      // Unknown reason: treat as non-retryable-but-not-permanent so a
      // single unexpected error doesn't silently loop, but also doesn't
      // wrongly nuke a token over an error we don't recognize.
      return { retryable: false, permanent: false, reason };
  }
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sends one VoIP push to one device token, with bounded exponential
 * backoff for transient failures (ExpiredProviderToken / TooManyRequests /
 * InternalServerError / Shutdown / network errors), up to MAX_ATTEMPTS.
 * Never logs the device token itself (only a short fingerprint) or any
 * APNs credential material.
 */
export async function sendVoipPush(
  deviceToken: string,
  payload: VoipCallPayload,
): Promise<ApnsSendResult> {
  const body = JSON.stringify(buildVoipPayload(payload));
  const bodyBytes = new TextEncoder().encode(body).length;
  if (bodyBytes > MAX_PAYLOAD_BYTES) {
    // Should be unreachable given the fixed, minimal payload shape above,
    // but fail loudly rather than let Apple reject it as PayloadTooLarge.
    return { success: false, error: "PayloadTooLarge (client-side check)" };
  }

  let lastError = "Unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { token, env: resolvedEnv } = await getApnsProviderToken();
      const host = APNS_HOST[resolvedEnv.environment];
      // VoIP pushes use the `.voip` topic suffix — a regular remote-notification
      // push to this topic (or a VoIP push to the bare bundle-id topic) is
      // silently dropped by Apple, not just misrouted, so this must never
      // fall back to the bare bundle id.
      const topic = `${resolvedEnv.bundleId}.voip`;

      const res = await fetch(`${host}/3/device/${deviceToken}`, {
        method: "POST",
        headers: {
          "authorization": `bearer ${token}`,
          "apns-topic": topic,
          "apns-push-type": "voip",
          "apns-priority": "10",
          // Calls should never be delivered late — ringing after the call
          // ended/was cancelled is worse than not ringing at all. 0 = do
          // not store for later delivery.
          "apns-expiration": "0",
          "content-type": "application/json",
        },
        body,
      });

      const apnsId = res.headers.get("apns-id") ?? undefined;

      if (res.ok) {
        return { success: true, apnsId, httpStatus: res.status };
      }

      const errBody = (await res.json().catch(() => ({}))) as ApnsErrorBody;
      const { retryable, permanent, reason } = classifyApnsFailure(res.status, errBody);
      lastError = reason;

      console.warn(
        `[apns] send failed (attempt ${attempt}/${MAX_ATTEMPTS}) status=${res.status} reason=${reason} token=${deviceToken.slice(0, 12)}\u2026`,
      );

      if (permanent) {
        return { success: false, error: reason, httpStatus: res.status, apnsId, shouldInvalidate: true };
      }
      if (!retryable || attempt === MAX_ATTEMPTS) {
        return { success: false, error: reason, httpStatus: res.status, apnsId };
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 100);
    } catch (e) {
      lastError = e instanceof Error ? e.message : "network error";
      console.warn(`[apns] transport error (attempt ${attempt}/${MAX_ATTEMPTS}): ${lastError}`);
      if (attempt === MAX_ATTEMPTS) {
        return { success: false, error: lastError };
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 100);
    }
  }

  return { success: false, error: lastError };
}
