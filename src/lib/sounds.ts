// Web Audio API notification sounds — no external files needed.
// Uses a singleton AudioContext to avoid iOS 6-context limit.

import { detectRingRegion, periodSeconds, ringbackFor, type RingbackPattern } from "./ringback";
import { getActiveSoundPrefs } from "@/lib/notificationSoundPrefs";
import { findCallRingtone, findMessageSound } from "@/lib/notificationSounds";

let _ctx: AudioContext | null = null;
const getCtx = (): AudioContext | null => {
  try {
    if (!_ctx || _ctx.state === "closed") {
      _ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    // Resume if suspended (required after user gesture on iOS)
    if (_ctx.state === "suspended") _ctx.resume();
    return _ctx;
  } catch {
    return null;
  }
};

const tone = (freq: number, startTime: number, duration: number, type: OscillatorType = "sine", gain = 0.15) => {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.connect(g);
    g.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    g.gain.setValueAtTime(gain, startTime);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration);
  } catch { /* AudioContext not available */ }
};

// Synth fallback for the chat ping — used only if the chosen sound's file
// can't be played (blocked autoplay, missing asset, no <audio> support).
const playSynthMessageSound = () => {
  const ctx = getCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  tone(880,  t,        0.08);
  tone(1100, t + 0.08, 0.17);
};

// One <audio> element per message-sound id, reused: the first play pays the
// (tiny, bundled) file load, every later one starts instantly.
const messageAudio = new Map<string, HTMLAudioElement>();

/**
 * Chat ping while the app is open. Plays the sound the user picked in
 * Settings > Notifications (public/sounds/<id>_msg.m4a) — this used to be a
 * hard-coded beep no matter what was selected; the chosen sound only ever
 * played from a push while the app was closed.
 */
export const playMessageSound = () => {
  try {
    const opt = findMessageSound(getActiveSoundPrefs().messageSound);
    let audio = messageAudio.get(opt.id);
    if (!audio) {
      audio = new Audio(opt.previewFile);
      audio.preload = "auto";
      messageAudio.set(opt.id, audio);
    }
    audio.currentTime = 0;
    const played = audio.play();
    if (played) played.catch(() => playSynthMessageSound());
  } catch {
    playSynthMessageSound();
  }
};

export const playCallSound = () => {
  const ctx = getCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  // Two-tone ascending ringtone pattern
  tone(523, t,      0.15);
  tone(659, t + 0.15, 0.15);
  tone(784, t + 0.30, 0.30);
};

// ─── Ringtone loop ("dring... dring...") ───────────────────────────────────
// A phone-style ring pattern, repeated on an interval. Used for BOTH sides
// of a call while it's ringing: the receiver's incoming-call screen, and
// the caller's own "Ringing…" screen (a ringback tone) — a real phone call
// (and WhatsApp) rings audibly on both ends, this used to only ever play a
// single one-shot chime on the receiver's side and nothing at all for the
// caller. Only one loop can run at a time (single shared interval handle),
// which matches how the app is actually used — a device is never both
// ringing-out and ringing-in at once.
//
// Pattern tuned to read as a ring, not a notification beep: WhatsApp's own
// call ring is a soft double-pulse "brr-brr" burst followed by a genuine
// pause before repeating — not a tight, evenly-spaced chirp. Triangle wave
// (warmer/rounder than the message/notification sine tones) plus a short
// pulse-pulse-pulse envelope gets close to that same "brr-brr" texture
// without an actual audio asset, and the ~1s-on/~2.4s-off cadence below
// matches a real ring's rhythm far more than the old flat 2.2s loop of a
// single chime did.
let ringtoneIntervalId: ReturnType<typeof setInterval> | null = null;

// ── Caller ringback, by location (see src/lib/ringback.ts) ──────────────────
// Soft sine tones like a phone earpiece — deliberately unlike the message
// sound (an audio file) and the incoming ringtone (the user's chosen file).
const playRingbackPeriod = (p: RingbackPattern) => {
  const ctx = getCtx();
  if (!ctx) return;
  const freqs = p.amHz ? p.freqs.flatMap((f) => [f - p.amHz, f + p.amHz]) : p.freqs; // AM ≡ two side tones
  const gain = 0.09 / freqs.length;
  let t = ctx.currentTime + 0.02;
  p.cadence.forEach((dur, i) => {
    if (i % 2 === 0) {
      for (const f of freqs) {
        try {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.connect(g); g.connect(ctx.destination);
          osc.type = "sine";
          osc.frequency.setValueAtTime(f, t);
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(gain, t + 0.02);
          g.gain.setValueAtTime(gain, t + Math.max(0.03, dur - 0.03));
          g.gain.linearRampToValueAtTime(0, t + dur);
          osc.start(t);
          osc.stop(t + dur + 0.02);
        } catch { /* AudioContext not available */ }
      }
    }
    t += dur;
  });
};

// A bundled ringtone file looping via <audio loop> (the chosen ringtone), as
// opposed to the synth "dring" above. Never both at once.
let ringAudio: HTMLAudioElement | null = null;
// Pending "does the OS already ring?" check from startIncomingRingtone().
let pendingNativeCheck: ReturnType<typeof setTimeout> | null = null;
let pendingToken: object | null = null;

const startSynthRing = () => {
  if (ringtoneIntervalId) return;
  const p = ringbackFor(detectRingRegion());
  playRingbackPeriod(p);
  ringtoneIntervalId = setInterval(() => playRingbackPeriod(p), periodSeconds(p) * 1000);
};

/**
 * Starts ringing. With no id: the synth "dring" — the CALLER's ringback
 * ("Ringing…" on the outgoing screen), which is deliberately not the
 * receiver's ringtone. With a ringtone id: that bundled ringtone, looping
 * (falls back to the synth ring if the file can't play).
 */
export const startRingtoneLoop = (ringtoneId?: string) => {
  if (ringtoneIntervalId || ringAudio) return; // already ringing
  if (!ringtoneId) { startSynthRing(); return; }
  try {
    const audio = new Audio(findCallRingtone(ringtoneId).previewFile);
    audio.loop = true;
    ringAudio = audio;
    const played = audio.play();
    if (played) {
      played.catch(() => {
        // Blocked / unplayable. Only fall back if this ring is still wanted.
        if (ringAudio === audio) { ringAudio = null; startSynthRing(); }
      });
    }
  } catch {
    ringAudio = null;
    startSynthRing();
  }
};

/**
 * Receiver-side ring for an incoming call: the ringtone the user picked.
 * If `nativeIsRinging` is given, waits a moment and asks it whether the OS is
 * already ringing (Android's ringing service / iOS CallKit play the same
 * ringtone natively); if so, stays silent rather than layering a second copy.
 * "Unknown" (null / throws) rings in-app. stopRingtoneLoop() cancels a pending
 * check, so a call answered inside the wait never starts ringing afterwards.
 */
export const startIncomingRingtone = (
  ringtoneId: string,
  nativeIsRinging?: () => Promise<boolean | null>,
) => {
  if (ringtoneIntervalId || ringAudio || pendingNativeCheck) return;
  if (!nativeIsRinging) { startRingtoneLoop(ringtoneId); return; }
  const token = {};
  pendingToken = token;
  pendingNativeCheck = setTimeout(async () => {
    pendingNativeCheck = null;
    let native: boolean | null = null;
    try { native = await nativeIsRinging(); } catch { native = null; }
    if (pendingToken !== token) return; // stopped while checking
    pendingToken = null;
    if (native === true) return; // the OS is already playing it
    startRingtoneLoop(ringtoneId);
  }, 900);
};

export const stopRingtoneLoop = () => {
  if (pendingNativeCheck) { clearTimeout(pendingNativeCheck); pendingNativeCheck = null; }
  pendingToken = null;
  if (ringtoneIntervalId) {
    clearInterval(ringtoneIntervalId);
    ringtoneIntervalId = null;
  }
  if (ringAudio) {
    const audio = ringAudio;
    ringAudio = null;
    try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch { /* best-effort */ }
  }
};

export const playNotificationSound = () => {
  const ctx = getCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  tone(600, t,       0.10, "triangle", 0.12);
  tone(800, t + 0.10, 0.10, "triangle", 0.12);
  tone(600, t + 0.20, 0.10, "triangle", 0.12);
};
