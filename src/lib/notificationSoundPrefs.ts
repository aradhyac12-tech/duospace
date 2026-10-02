/**
 * Selected message sound + call ringtone — local-first, synced to the server.
 *
 * WHY THIS EXISTS (v3.11.1)
 * -------------------------
 * The picker used to read the choice from Supabase on open, disable every row
 * until that read finished ("can't select" on a slow / offline network — the
 * offline-first client now fails reads fast but a 25 s ceiling still applies to
 * a dead uplink), and write it back with no memory of failure: the row still
 * looked selected after a failed save, then silently reverted next time the
 * page opened. And nothing ever fed the choice to the sounds the app itself
 * plays while it is open — chat pings and the in-app incoming-call ring were
 * hard-coded synth tones, so a chosen sound only "worked" when the app was
 * closed and a push arrived.
 *
 * Model:
 *   - The choice lives on the device first (localStorage, keyed by user id),
 *     so selecting is instant, works offline, and is what in-app playback
 *     reads synchronously.
 *   - `dirty` means "changed here, server hasn't confirmed". A dirty choice is
 *     re-sent on next sign-in / reconnect / app resume until it lands. While
 *     dirty the server value never overwrites the local one.
 *   - The server row (notification_preferences) stays the source of truth for
 *     pushes: send-push reads it to pick the Android channel / iOS sound.
 *   - iOS CallKit's ringtone is a local setting (CXProviderConfiguration), so
 *     the resolved choice is re-applied natively on every sync, not only when
 *     picked in Settings — a fresh install / second device now gets it too.
 */
import { Capacitor } from "@capacitor/core";
import { supabase } from "@/integrations/supabase/appClient";
import storage from "@/lib/storage";
import { logWarn } from "@/lib/telemetry";
import {
  DEFAULT_CALL_RINGTONE, DEFAULT_MESSAGE_SOUND,
  findCallRingtone, findMessageSound,
  type CallRingtoneId, type MessageSoundId,
} from "@/lib/notificationSounds";

export interface SoundPrefs {
  messageSound: MessageSoundId;
  callRingtone: CallRingtoneId;
}

interface StoredPrefs extends SoundPrefs {
  /** Changed on this device and not yet confirmed by the server. */
  dirty: boolean;
}

export type SaveResult = { ok: true } | { ok: false; code?: string; message: string };

const keyFor = (userId: string) => `duo:notif-sounds:v1:${userId}`;

const DEFAULTS: SoundPrefs = { messageSound: DEFAULT_MESSAGE_SOUND, callRingtone: DEFAULT_CALL_RINGTONE };

// ── who is signed in (in-app playback has no user id to hand) ───────────────
let activeUserId: string | null = null;
let activePrefs: SoundPrefs = DEFAULTS;
const listeners = new Set<(p: SoundPrefs, dirty: boolean) => void>();

/** Normalizes anything read from storage/the server to ids that really exist. */
function sanitize(raw: Partial<SoundPrefs> | null | undefined): SoundPrefs {
  return {
    messageSound: findMessageSound(raw?.messageSound).id,
    callRingtone: findCallRingtone(raw?.callRingtone).id,
  };
}

function readStored(userId: string): StoredPrefs | null {
  const raw = storage.getJSON<Partial<StoredPrefs> | null>(keyFor(userId), null);
  if (!raw || typeof raw !== "object") return null;
  return { ...sanitize(raw), dirty: raw.dirty === true };
}

function writeStored(userId: string, next: StoredPrefs): void {
  storage.setJSON(keyFor(userId), next);
  if (userId === activeUserId) {
    activePrefs = { messageSound: next.messageSound, callRingtone: next.callRingtone };
    listeners.forEach((cb) => { try { cb(activePrefs, next.dirty); } catch { /* bad listener must not break the rest */ } });
  }
}

/** Point in-app playback at this user's saved choice (null on sign-out). */
export function setActiveSoundUser(userId: string | null): void {
  activeUserId = userId;
  activePrefs = userId ? sanitize(readStored(userId)) : DEFAULTS;
}

/** Synchronous — used by in-app playback (chat ping, incoming-call ring). */
export function getActiveSoundPrefs(): SoundPrefs {
  return activePrefs;
}

/** What the picker shows on first paint; never waits on the network. */
export function getLocalSoundPrefs(userId: string): StoredPrefs {
  return readStored(userId) ?? { ...DEFAULTS, dirty: false };
}

export function subscribeSoundPrefs(cb: (p: SoundPrefs, dirty: boolean) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

// ── server ──────────────────────────────────────────────────────────────────
// One flush at a time, and each reads the LATEST local value when it starts,
// so a rapid second pick can't be overwritten by an older request landing late.
let flushChain: Promise<SaveResult> = Promise.resolve({ ok: true });

function flushNow(userId: string): Promise<SaveResult> {
  const run = async (): Promise<SaveResult> => {
    const snap = readStored(userId);
    if (!snap?.dirty) return { ok: true };
    try {
      const { error } = await supabase
        .from("notification_preferences")
        .upsert(
          { user_id: userId, message_sound: snap.messageSound, call_ringtone: snap.callRingtone },
          { onConflict: "user_id" },
        );
      if (error) {
        logWarn("notificationSoundPrefs", "server save failed", { code: error.code, message: error.message });
        return { ok: false, code: error.code, message: String(error.message ?? "save failed") };
      }
    } catch (e) {
      // Offline fast-fail (client.ts) surfaces as a thrown TypeError.
      return { ok: false, message: e instanceof Error ? e.message : "network error" };
    }
    const now = readStored(userId);
    // Only clear `dirty` if nothing changed while the request was in flight.
    if (now && now.messageSound === snap.messageSound && now.callRingtone === snap.callRingtone) {
      writeStored(userId, { ...now, dirty: false });
    }
    return { ok: true };
  };
  flushChain = flushChain.then(run, run);
  return flushChain;
}

/**
 * Records a choice on this device immediately and tries to push it to the
 * server. The local choice sticks even when the push fails (`ok: false`); it
 * is retried by `syncSoundPrefs`.
 */
export async function saveSoundPrefs(userId: string, patch: Partial<SoundPrefs>): Promise<SaveResult> {
  if (activeUserId !== userId) setActiveSoundUser(userId);
  const cur = readStored(userId) ?? { ...DEFAULTS, dirty: false };
  const next = sanitize({ ...cur, ...patch });
  writeStored(userId, { ...next, dirty: true });
  if (patch.callRingtone) void applyNativeRingtone(next.callRingtone);
  return flushNow(userId);
}

/**
 * Reconciles device and server. Dirty local choice → push it. Otherwise adopt
 * whatever the server has (another device may have changed it). Always ends by
 * re-applying the ringtone to iOS CallKit. Never throws.
 */
export async function syncSoundPrefs(userId: string): Promise<SoundPrefs> {
  try {
    const local = readStored(userId);
    if (local?.dirty) {
      await flushNow(userId);
    } else {
      const { data, error } = await supabase
        .from("notification_preferences")
        .select("message_sound, call_ringtone")
        .eq("user_id", userId)
        .maybeSingle();
      if (!error && data) {
        const remote = sanitize({ messageSound: data.message_sound, callRingtone: data.call_ringtone });
        // Re-read: the user may have picked something while this was in flight.
        const again = readStored(userId);
        if (!again?.dirty) writeStored(userId, { ...remote, dirty: false });
      }
    }
  } catch {
    /* offline / transient — the local choice is still what plays */
  }
  const resolved = readStored(userId) ?? { ...DEFAULTS, dirty: false };
  void applyNativeRingtone(resolved.callRingtone);
  return { messageSound: resolved.messageSound, callRingtone: resolved.callRingtone };
}

// ── iOS CallKit ─────────────────────────────────────────────────────────────
/** iOS only (CallKit ringtones are local, see CallKitManager.applyRingtonePreference). No-op elsewhere. */
export async function applyNativeRingtone(soundId: CallRingtoneId): Promise<void> {
  if (Capacitor.getPlatform() !== "ios") return;
  try {
    const { DuospaceCallKitBridge } = await import("duospace-callkit-bridge");
    await DuospaceCallKitBridge.setRingtone({ soundId });
  } catch {
    // Best-effort — CallKit falls back to its default/last-applied sound.
  }
}
