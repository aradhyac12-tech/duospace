// Notification sound catalog — Deno-side duplicate of
// src/lib/notificationSounds.ts (an edge function can't import from src/).
// Ids and channel-suffix naming MUST stay in sync with:
//   - src/lib/notificationSounds.ts (client picker)
//   - native/android/NotificationChannels.kt (channel-per-sound-variant ids)
//   - native/android/res_raw/*.ogg + native/ios/Sounds/*.caf (asset filenames)

export type MessageSoundId = "classic" | "chime" | "pop" | "marimba";
export type CallRingtoneId = "classic" | "gentle" | "urgent" | "marimba";

export const MESSAGE_SOUND_IDS: readonly MessageSoundId[] = ["classic", "chime", "pop", "marimba"];
export const CALL_RINGTONE_IDS: readonly CallRingtoneId[] = ["classic", "gentle", "urgent", "marimba"];

export const DEFAULT_MESSAGE_SOUND: MessageSoundId = "classic";
export const DEFAULT_CALL_RINGTONE: CallRingtoneId = "classic";

export function normalizeMessageSound(v: unknown): MessageSoundId {
  return (MESSAGE_SOUND_IDS as readonly string[]).includes(v as string) ? (v as MessageSoundId) : DEFAULT_MESSAGE_SOUND;
}

export function normalizeCallRingtone(v: unknown): CallRingtoneId {
  return (CALL_RINGTONE_IDS as readonly string[]).includes(v as string) ? (v as CallRingtoneId) : DEFAULT_CALL_RINGTONE;
}

/**
 * Android notification channel id for a given (base category, sound variant)
 * pair. One physical channel per sound is required because Android freezes
 * a channel's sound+vibration the moment it's first created — see
 * NotificationChannels.kt for the full explanation. All variant channels are
 * created upfront at app startup, so this is just a naming/lookup function,
 * never a "create on demand" one.
 */
export function messageChannelId(sound: MessageSoundId): string {
  return `duospace_messages_${sound}`;
}
export function callChannelId(ringtone: CallRingtoneId): string {
  return `duospace_incoming_calls_${ringtone}`;
}
