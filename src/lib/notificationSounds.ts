/**
 * Notification sound + haptic catalog.
 *
 * These ids are the single source of truth for "which sound plays" across
 * independent places that can't share a JS import:
 *   - here (client Settings UI: picker + preview + in-app playback)
 *   - supabase/functions/_shared/soundCatalog.ts (Deno edge function —
 *     duplicated on purpose, same reason CHANNELS is duplicated in fcm.ts:
 *     an edge function can't import from src/)
 *   - native/android/NotificationChannels.kt + CallRingingService.kt, and
 *     native/ios/CallKitManager.swift (VALID_RINGTONE_IDS)
 *   - bundled assets: public/sounds/<id>_msg|call.m4a,
 *     native/android/res_raw/*.ogg, native/ios/Sounds/*.caf — filenames must
 *     match these ids exactly ("<id>_msg.*" / "<id>_call.*")
 *   - supabase/migrations/*notification_sound* (CHECK on notification_preferences)
 *
 * Changing or adding an id means changing ALL of them, or a saved preference
 * silently falls back to "classic". src/test/notificationSoundCatalog.test.ts
 * fails if any of these drift; scripts/generate-notification-sounds.py renders
 * the three asset formats for a new id.
 */

export type MessageSoundId =
  | "classic" | "chime" | "pop" | "marimba"
  | "bell" | "droplet" | "crystal" | "harp" | "sparkle" | "tick" | "whistle" | "glass";
export type CallRingtoneId =
  | "classic" | "gentle" | "urgent" | "marimba"
  | "retro" | "digital" | "melody" | "bells" | "pulse" | "sunrise" | "waltz" | "groove";

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
  {
    id: "bell",
    label: "Bell",
    description: "One clear, ringing bell",
    previewFile: "/sounds/bell_msg.m4a",
    pattern: [0, 200],
  },
  {
    id: "droplet",
    label: "Droplet",
    description: "Two soft water drops",
    previewFile: "/sounds/droplet_msg.m4a",
    pattern: [0, 40, 60, 40],
  },
  {
    id: "crystal",
    label: "Crystal",
    description: "Shimmering high notes",
    previewFile: "/sounds/crystal_msg.m4a",
    pattern: [0, 70, 50, 70],
  },
  {
    id: "harp",
    label: "Harp",
    description: "A plucked rising triad",
    previewFile: "/sounds/harp_msg.m4a",
    pattern: [0, 60, 50, 60, 50, 90],
  },
  {
    id: "sparkle",
    label: "Sparkle",
    description: "A quick twinkling run",
    previewFile: "/sounds/sparkle_msg.m4a",
    pattern: [0, 40, 40, 40, 40, 40, 40, 60],
  },
  {
    id: "tick",
    label: "Tick",
    description: "A tiny wooden tap",
    previewFile: "/sounds/tick_msg.m4a",
    pattern: [0, 30],
  },
  {
    id: "whistle",
    label: "Whistle",
    description: "A bright bird-like chirp",
    previewFile: "/sounds/whistle_msg.m4a",
    pattern: [0, 300],
  },
  {
    id: "glass",
    label: "Glass",
    description: "A light glass clink",
    previewFile: "/sounds/glass_msg.m4a",
    pattern: [0, 100, 80, 60],
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
  {
    id: "retro",
    label: "Retro",
    description: "Old-fashioned telephone bell",
    previewFile: "/sounds/retro_call.m4a",
    pattern: [0, 650, 300, 650, 1400],
    repeatFrom: 1,
  },
  {
    id: "digital",
    label: "Digital",
    description: "Crisp electronic beep groups",
    previewFile: "/sounds/digital_call.m4a",
    pattern: [0, 110, 50, 110, 50, 110, 50, 110, 470, 110, 50, 110, 50, 110, 50, 110, 860],
    repeatFrom: 1,
  },
  {
    id: "melody",
    label: "Melody",
    description: "A friendly rising piano phrase",
    previewFile: "/sounds/melody_call.m4a",
    pattern: [0, 200, 100, 200, 100, 400, 1900],
    repeatFrom: 1,
  },
  {
    id: "bells",
    label: "Bells",
    description: "Three slow, descending bell strikes",
    previewFile: "/sounds/bells_call.m4a",
    pattern: [0, 500, 250, 500, 250, 500, 1400],
    repeatFrom: 1,
  },
  {
    id: "pulse",
    label: "Pulse",
    description: "Calm sonar-style double pulse",
    previewFile: "/sounds/pulse_call.m4a",
    pattern: [0, 300, 120, 300, 1680],
    repeatFrom: 1,
  },
  {
    id: "sunrise",
    label: "Sunrise",
    description: "A rising run over a warm pad",
    previewFile: "/sounds/sunrise_call.m4a",
    pattern: [0, 120, 80, 160, 80, 200, 80, 260, 2220],
    repeatFrom: 1,
  },
  {
    id: "waltz",
    label: "Waltz",
    description: "Music-box waltz in three-four time",
    previewFile: "/sounds/waltz_call.m4a",
    pattern: [0, 180, 140, 90, 140, 90, 2360],
    repeatFrom: 1,
  },
  {
    id: "groove",
    label: "Groove",
    description: "Plucked, syncopated bass riff",
    previewFile: "/sounds/groove_call.m4a",
    pattern: [0, 120, 180, 120, 300, 120, 300, 120, 1340],
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

export function previewSound(file: string, onEnd?: () => void) {
  try {
    previewAudio?.pause();
    const audio = new Audio(file);
    previewAudio = audio;
    audio.volume = 0.85;
    // onEnd fires when the clip finishes OR can't play, so a UI "playing"
    // state never gets stuck. Replacing the preview (pause above) does not
    // fire it — the caller that started the new one owns the state now.
    audio.addEventListener("ended", () => { if (previewAudio === audio) previewAudio = null; onEnd?.(); });
    void audio.play().catch(() => { if (previewAudio === audio) previewAudio = null; onEnd?.(); });
  } catch {
    onEnd?.();
    // Best-effort preview; never throw into the settings UI.
  }
}

/** Stops a preview that is still playing (call ringtones are 2–3 s long). */
export function stopPreviewSound() {
  try {
    previewAudio?.pause();
    previewAudio = null;
  } catch {
    // Best-effort.
  }
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(0);
  } catch {
    // Best-effort.
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
