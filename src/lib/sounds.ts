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

export const playNotificationSound = () => {
  const ctx = getCtx();
  if (!ctx) return;
  const t = ctx.currentTime;
  tone(600, t,       0.10, "triangle", 0.12);
  tone(800, t + 0.10, 0.10, "triangle", 0.12);
  tone(600, t + 0.20, 0.10, "triangle", 0.12);
};
