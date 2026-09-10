/**
 * Notification sound + haptic catalog.
 *
 * These ids are the single source of truth for "which sound plays" across
 * three independent places that can't share a JS import:
 *   - here (client Settings UI: picker + preview)
 *   - supabase/functions/_shared/soundCatalog.ts (Deno edge function —
 *     duplicated on purpose, same reason CHANNELS is duplicated in fcm.ts:
 *     an edge function can't import from src/)
 *   - native/android/NotificationChannels.kt + CallRingingService.kt, and
 *     native/ios/Sounds/*.caf (bundled asset filenames must match these ids
 *     exactly: "<id>_msg.*" / "<id>_call.*")
 *
 * Changing an id here means changing it in all three places, or a saved
 * preference silently falls back to "classic".
 */

export type MessageSoundId = "classic" | "chime" | "pop" | "marimba";
export type CallRingtoneId = "classic" | "gentle" | "urgent" | "marimba";

export interface SoundOption<Id extends string> {
  id: Id;
  label: string;
  description: string;
  /** Web preview asset (public/sounds/<file>), used only for the in-app "preview" button. */
  previewFile: string;
  /**
   * Haptic pattern for this sound, as a navigator.vibrate-style array
   * ([wait, vibrate, wait, vibrate, ...]). Message patterns play once;
   * call patterns loop from `repeatFrom` while ringing (mirrors the native
   * VibrationEffect.createWaveform(pattern, repeatIndex) used on Android —
   * see CallRingingService.kt).
   */
  pattern: number[];
  repeatFrom?: number;
}

export const MESSAGE_SOUNDS: SoundOption<MessageSoundId>[] = [
  {
    id: "classic",
    label: "Classic",
    description: "A single soft ding",
    previewFile: "/sounds/classic_msg.m4a",
    pattern: [0, 250, 150, 250],
  },
  {
    id: "chime",
    label: "Chime",
    description: "Two gentle ascending notes",
    previewFile: "/sounds/chime_msg.m4a",
    pattern: [0, 120, 80, 120, 80, 200],
  },
  {
    id: "pop",
    label: "Pop",
    description: "A quick bubble pop",
    previewFile: "/sounds/pop_msg.m4a",
    pattern: [0, 60],
  },
  {
    id: "marimba",
    label: "Marimba",
    description: "A short descending arpeggio",
    previewFile: "/sounds/marimba_msg.m4a",
    pattern: [0, 90, 60, 90, 60, 90, 60, 150],
  },
];

export const CALL_RINGTONES: SoundOption<CallRingtoneId>[] = [
  {
    id: "classic",
    label: "Classic",
    description: "Traditional dual-tone ring",
    previewFile: "/sounds/classic_call.m4a",
    pattern: [0, 400, 200, 400, 200],
    repeatFrom: 1,
  },
  {
    id: "gentle",
    label: "Gentle",
    description: "Soft rising pad, low-key wake",
    previewFile: "/sounds/gentle_call.m4a",
    pattern: [0, 200, 800],
    repeatFrom: 1,
  },
  {
    id: "urgent",
    label: "Urgent",
    description: "Fast triple beep, hard to miss",
    previewFile: "/sounds/urgent_call.m4a",
    pattern: [0, 150, 100, 150, 100, 150, 500],
    repeatFrom: 1,
  },
  {
    id: "marimba",
    label: "Marimba",
    description: "Melodic 4-note loop",
    previewFile: "/sounds/marimba_call.m4a",
    pattern: [0, 80, 60, 80, 60, 80, 60, 300],
    repeatFrom: 1,
  },
];

export const DEFAULT_MESSAGE_SOUND: MessageSoundId = "classic";
export const DEFAULT_CALL_RINGTONE: CallRingtoneId = "classic";

export function findMessageSound(id: string | null | undefined): SoundOption<MessageSoundId> {
  return MESSAGE_SOUNDS.find((s) => s.id === id) ?? MESSAGE_SOUNDS[0];
}

export function findCallRingtone(id: string | null | undefined): SoundOption<CallRingtoneId> {
  return CALL_RINGTONES.find((s) => s.id === id) ?? CALL_RINGTONES[0];
}

// ── Preview playback + haptic (Settings UI only — the real notification/
// ringing sound is always played natively, even when the app is closed) ──
let previewAudio: HTMLAudioElement | null = null;

export function previewSound(file: string) {
  try {
    previewAudio?.pause();
    previewAudio = new Audio(file);
    previewAudio.volume = 0.85;
    void previewAudio.play().catch(() => { /* autoplay may be blocked until a user gesture; button tap counts as one */ });
  } catch {
    // Best-effort preview; never throw into the settings UI.
  }
}

export function previewHaptic(pattern: number[]) {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
  } catch {
    // Best-effort; Capacitor's native Haptics plugin doesn't support
    // arbitrary multi-pulse patterns, so preview relies on navigator.vibrate
    // (works in-app on Android WebViews and mobile Chrome; iOS Safari/WKWebView
    // has no vibrate API at all, so the preview is sound-only there — a real
    // platform limitation, not a bug in this picker).
  }
}
