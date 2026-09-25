// /important and /urgent message alerts — the pure (Deno-free, import-free at
// runtime) part of how send-push turns a flagged message into a push that
// rings and vibrates differently from a normal one. Kept out of fcm.ts so it
// can be unit-tested (src/test/messageAlert.test.ts) — fcm.ts pulls in the
// Deno-only OAuth code and can't be imported by vitest.
//
// Two tiers, deliberately different in sound AND feel:
//   important  ⚡  rising three-note bell, three long pulses   (~20 s)
//   urgent     🚨  two-tone siren + rapid beeps, heavy pulses  (until stopped, ≤60 s)
//
// The tier names, channel ids, raw asset names and vibration patterns below
// exist in several places that cannot share an import. Keep them identical:
//   src/lib/messageAlert.ts                    (client: in-app alert + previews)
//   native/android/MessageAlertService.kt      (rings/vibrates; owns the patterns)
//   native/android/NotificationChannels.kt     (channel ids + sounds)
//   native/ios/Sounds/alert_<tier>.caf         (APNs sound; ≤30 s, plays once)
//   public/sounds/alert_<tier>.m4a, native/android/res_raw/alert_<tier>.ogg
// src/test/messageAlert.test.ts fails if any of them drift.
import type { NotificationContent, PushNotificationType } from "./pushTypes.ts";

export type MessageAlertLevel = "important" | "urgent";

/** Android channel per tier. "_v2": the old single `duospace_urgent_message`
 *  channel had its sound/vibration frozen at creation (Android never lets an
 *  app change them afterwards), so new ids are the only way to change them. */
export const ALERT_CHANNELS: Readonly<Record<MessageAlertLevel, string>> = {
  important: "duospace_alert_important_v2",
  urgent: "duospace_alert_urgent_v2",
};

export const ALERT_SOUND_NAMES: Readonly<Record<MessageAlertLevel, string>> = {
  important: "alert_important",
  urgent: "alert_urgent",
};

/** Push types an /important or /urgent flag is meaningful for. A call already
 *  rings; a system/account notification has no urgency dial to turn up. */
export const ALERT_ELIGIBLE_TYPES: ReadonlySet<PushNotificationType> = new Set([
  "chat_message", "image_message", "video_message", "audio_message",
  "file_message", "reply", "mention", "group_message",
]);

/** A push older than this (delivered late after being offline) is shown as a
 *  normal message instead of ringing — an alarm minutes later is worse than
 *  none. Mirrors STALE_ALERT_MS in MessageAlertService.kt. */
export const ALERT_STALE_AFTER_MS = 10 * 60 * 1000;

interface AlertFlags {
  type: PushNotificationType;
  important?: boolean;
  urgent?: boolean;
}

/** null = an ordinary push. urgent wins over important. */
export function resolveAlertLevel(body: AlertFlags): MessageAlertLevel | null {
  if (!ALERT_ELIGIBLE_TYPES.has(body.type)) return null;
  if (body.urgent === true) return "urgent";
  if (body.important === true) return "important";
  return null;
}

export function alertTitle(level: MessageAlertLevel, senderName: string): string {
  return level === "urgent" ? `\u{1F6A8} URGENT \u00B7 ${senderName}` : `\u26A1 Important \u00B7 ${senderName}`;
}

/**
 * Re-routes an already-built notification onto its alert tier. Mutates and
 * returns `content`. Everything native needs travels in `data` (pushes are
 * data-only): alertLevel drives MessageAlertService on Android; `important`
 * / `urgent` are kept for older builds and for the iOS branch in fcm.ts.
 */
export function applyMessageAlert(
  content: NotificationContent,
  level: MessageAlertLevel,
  senderName: string,
): NotificationContent {
  content.channelId = ALERT_CHANNELS[level];
  content.priority = "high";
  content.title = alertTitle(level, senderName);
  content.data.alertLevel = level;
  content.data.important = "true";
  if (level === "urgent") content.data.urgent = "true";
  else delete content.data.urgent;
  content.data.title = content.title;
  return content;
}

export interface IosAlertAps {
  sound: string | { critical: number; name: string; volume: number };
  "interruption-level": "time-sensitive" | "critical";
  "relevance-score": number;
}

/**
 * iOS. Without Apple's Critical Alerts entitlement the strongest available
 * is `time-sensitive`: it breaks through Focus / Do Not Disturb, but it can
 * NOT override the hardware silent switch. Critical alerts (which do bypass
 * both, at full volume) require an entitlement Apple must approve for the
 * app, so they stay off until the operator sets IOS_CRITICAL_ALERTS=true
 * (only do that once the entitlement is in the provisioning profile AND the
 * client requests the .criticalAlert authorization option).
 */
export function iosAlertAps(level: MessageAlertLevel, criticalEnabled: boolean): IosAlertAps {
  const file = `${ALERT_SOUND_NAMES[level]}.caf`;
  if (criticalEnabled) {
    return {
      sound: { critical: 1, name: file, volume: 1.0 },
      "interruption-level": "critical",
      "relevance-score": 1,
    };
  }
  return { sound: file, "interruption-level": "time-sensitive", "relevance-score": level === "urgent" ? 1 : 0.9 };
}
