// Web Audio API notification sounds — no external files needed.
// Uses a singleton AudioContext to avoid iOS 6-context limit.

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

export const playMessageSound = () => {
  const ctx = getCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  tone(880,  t,        0.08);
  tone(1100, t + 0.08, 0.17);
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

const pulse = (freq: number, startTime: number, gain = 0.16) => {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.connect(g);
    g.connect(ctx.destination);
    osc.type = "triangle";
    osc.frequency.setValueAtTime(freq, startTime);
    // Fast attack, held briefly, then decays — a "brr" pulse rather than a
    // pure tone with a hard cutoff.
    g.gain.setValueAtTime(0, startTime);
    g.gain.linearRampToValueAtTime(gain, startTime + 0.015);
    g.gain.setValueAtTime(gain, startTime + 0.09);
    g.gain.exponentialRampToValueAtTime(0.001, startTime + 0.18);
    osc.start(startTime);
    osc.stop(startTime + 0.2);
  } catch { /* AudioContext not available */ }
};

const playDringDring = () => {
  const ctx = getCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  // "brr" — a fast triplet of pulses on one note — a short beat of
  // silence — "brr" again, one octave-ish spread apart, mimicking a
  // classic double-ring burst.
  [0, 0.11, 0.22].forEach((offset) => pulse(920, t + offset));
  [0.5, 0.61, 0.72].forEach((offset) => pulse(920, t + offset));
};

export const startRingtoneLoop = () => {
  if (ringtoneIntervalId) return; // already ringing
  playDringDring();
  ringtoneIntervalId = setInterval(playDringDring, 3400);
};

export const stopRingtoneLoop = () => {
  if (ringtoneIntervalId) {
    clearInterval(ringtoneIntervalId);
    ringtoneIntervalId = null;
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
