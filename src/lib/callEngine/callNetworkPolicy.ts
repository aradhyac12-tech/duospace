/**
 * Pure policy for how a live call reacts to network conditions.
 * (Kept free of React/LiveKit so every scenario is unit-testable.)
 */
import type { CallNetworkQuality } from "./audioFirstFallback";

export const RECONNECT_GRACE_ONLINE_MS = 30_000;
/** Device itself has no connectivity (tunnel, lift, airplane toggle, Wi-Fi<->cell handoff): be patient. */
export const RECONNECT_GRACE_OFFLINE_MS = 90_000;

export function reconnectGraceMs(online: boolean): number {
  return online ? RECONNECT_GRACE_ONLINE_MS : RECONNECT_GRACE_OFFLINE_MS;
}

export type NetworkNotice = "offline" | "reconnecting" | "weak-you" | "weak-them" | "signal-down" | null;

/** Call-signalling socket state as reported by the signalling bridge. */
export type SignalingLinkState = "disconnected" | "connecting" | "connected" | "reconnecting";

/** Which single banner (if any) the call screen should show — most severe first. */
export function pickNetworkNotice(i: {
  online: boolean;
  quality: CallNetworkQuality;
  remoteQuality?: CallNetworkQuality;
  /** Omit when signalling isn't configured/used: no notice is ever produced for undefined. */
  signaling?: SignalingLinkState;
}): NetworkNotice {
  if (!i.online) return "offline";
  if (i.quality === "poor") return "reconnecting";
  if (i.quality === "fair") return "weak-you";
  if (i.remoteQuality === "poor" || i.remoteQuality === "fair") return "weak-them";
  // Media (LiveKit) keeps flowing without the signalling socket, but hang-up/end signals may be
  // delayed, so this is the least severe notice. Device online + media fine + socket down.
  if (i.signaling === "disconnected" || i.signaling === "reconnecting") return "signal-down";
  return null;
}

/** Receive-side: ask the SFU for the low layer while OUR link is weak (protects audio), full quality otherwise. */
export function remoteVideoQualityFor(q: CallNetworkQuality): "low" | "high" {
  return q === "fair" || q === "poor" ? "low" : "high";
}

// ---- connection kind (Wi-Fi vs mobile data) ---------------------------------

export type ConnectionKind = "wifi" | "cellular" | "none" | "unknown";

/** Normalise Capacitor Network `connectionType` or the web Network Information `type` into our 4 kinds. */
export function normalizeConnectionKind(type: string | undefined | null, connected = true): ConnectionKind {
  if (!connected) return "none";
  switch ((type ?? "").toLowerCase()) {
    case "wifi": case "ethernet": return "wifi";
    case "cellular": return "cellular";
    case "none": return "none";
    default: return "unknown";
  }
}

/** Short noun for banners ("Your Wi-Fi is weak"); generic "connection" when we can't tell. */
export function connectionNoun(kind: ConnectionKind | undefined): string {
  if (kind === "wifi") return "Wi-Fi";
  if (kind === "cellular") return "mobile data";
  return "connection";
}

// ---- adaptive capture resolution ----------------------------------------------

export type CaptureTier = "full" | "reduced" | "minimal";
export interface CaptureProfile { tier: CaptureTier; width: number; height: number; frameRate: number }

/** What the device camera reports it can do (MediaStreamTrack.getCapabilities()); all optional. */
export interface DeviceVideoCaps { maxWidth?: number; maxHeight?: number; maxFps?: number }

/** Top-tier frame rate from what the device can actually do: 90 if it supports 90, else 60, else 30.
 *  Unknown capability -> ask for 60 (getUserMedia/applyConstraints `ideal` is clamped by the browser, never an error). */
export function pickMaxFps(caps?: DeviceVideoCaps): 30 | 60 | 90 {
  const f = caps?.maxFps;
  if (f === undefined || !Number.isFinite(f)) return 60;
  if (f >= 90) return 90;
  if (f >= 60) return 60;
  return 30;
}

/** What our own camera should capture at for a given tier. Portrait swaps width/height.
 *  "full" = up to 1080p at the device's best of 90/60/30 fps (never above what the camera reports). */
export function captureProfileForTier(tier: CaptureTier, portrait: boolean, caps?: DeviceVideoCaps, limit?: PowerLimit | null): CaptureProfile {
  let w: number, h: number, fps: number;
  if (tier === "full") {
    const longSide = Math.max(caps?.maxWidth ?? 0, caps?.maxHeight ?? 0);
    const shortSide = Math.min(caps?.maxWidth ?? Infinity, caps?.maxHeight ?? Infinity);
    w = longSide > 0 ? Math.min(1920, longSide) : 1920;
    h = Number.isFinite(shortSide) && shortSide > 0 ? Math.min(1080, shortSide) : 1080;
    fps = pickMaxFps(caps);
    if (limit?.maxFps && fps > limit.maxFps) fps = limit.maxFps;
    if (limit?.maxShortSide && h > limit.maxShortSide) {
      const scale = limit.maxShortSide / h;
      h = limit.maxShortSide; w = Math.round(w * scale / 2) * 2; // keep even dimensions
    }
  } else if (tier === "reduced") { [w, h, fps] = [640, 360, 20]; }
  else { [w, h, fps] = [320, 180, 15]; }
  return { tier, width: portrait ? h : w, height: portrait ? w : h, frameRate: fps };
}

/** Sender bitrate ceiling for a capture profile (bits/s): ~0.05 bits per pixel per frame, clamped 0.3-8 Mbps.
 *  1080p30 ~ 3.1 Mbps, 1080p60 ~ 6.2 Mbps, 1080p90 ~ 8 Mbps (clamped). */
export function maxBitrateFor(p: { width: number; height: number; frameRate: number }): number {
  const raw = Math.round(p.width * p.height * p.frameRate * 0.05);
  return Math.min(8_000_000, Math.max(300_000, raw));
}

/** Immediate tier for a link quality: weak link -> smaller frames (so the encoder isn't starved), lost -> smallest. */
export function captureTierFor(q: CallNetworkQuality): CaptureTier {
  if (q === "poor") return "minimal";
  if (q === "fair") return "reduced";
  return "full";
}

const TIER_RANK: Record<CaptureTier, number> = { minimal: 0, reduced: 1, full: 2 };

export interface AdaptiveCaptureOptions {
  /** Called ONLY when the tier actually changes (or reapply() is used). */
  apply: (tier: CaptureTier) => void;
  /** A better link must hold this long before capture steps back UP. Down is immediate. */
  upDelayMs?: number;
}
export interface AdaptiveCapture {
  onQuality: (q: CallNetworkQuality) => void;
  /** Re-apply the current tier (e.g. after a camera flip/restart reset the constraints). */
  reapply: () => void;
  current: () => CaptureTier;
  /** Drop timers and reset to "full" without applying (call end / camera off). */
  cancel: () => void;
}

export function createAdaptiveCapture(opts: AdaptiveCaptureOptions): AdaptiveCapture {
  const upDelayMs = opts.upDelayMs ?? 10_000;
  let tier: CaptureTier = "full";
  let upTimer: ReturnType<typeof setTimeout> | null = null;
  let upTarget: CaptureTier | null = null;
  const clearUp = () => { if (upTimer) clearTimeout(upTimer); upTimer = null; upTarget = null; };
  const set = (t: CaptureTier) => { if (t !== tier) { tier = t; opts.apply(t); } };
  return {
    onQuality(q) {
      const want = captureTierFor(q);
      if (TIER_RANK[want] < TIER_RANK[tier]) { clearUp(); set(want); return; } // worse: act now
      if (TIER_RANK[want] === TIER_RANK[tier]) { clearUp(); return; }          // same: nothing pending
      if (upTarget === want) return;                                            // already waiting for this step up
      clearUp();
      upTarget = want;
      upTimer = setTimeout(() => { upTimer = null; upTarget = null; set(want); }, upDelayMs);
    },
    reapply() { opts.apply(tier); },
    current: () => tier,
    cancel() { clearUp(); tier = "full"; },
  };
}

// ---- power / long-call cap (battery proxy; NOT a real thermal reading) -----------

export interface PowerState { level: number | null; charging: boolean | null }
export interface PowerLimit { maxFps?: number; maxShortSide?: number; reason: "low-battery" | "battery-saver" | "long-call" }

export const POWER_LOW_PCT = 15;
export const POWER_SAVER_PCT = 30;
/** Unplugged for this long on a call: 1080p60+ keeps the camera, encoder and radio hot, so drop to 30fps. */
export const LONG_CALL_UNPLUGGED_MS = 20 * 60_000;

/** Cap for the TOP capture tier only. Charging (true) lifts every cap. Unknown battery -> no battery cap (we never guess). */
export function powerLimitFor(p: PowerState, callMs: number): PowerLimit | null {
  if (p.charging === true) return null;
  if (p.level !== null && p.level <= POWER_LOW_PCT) return { maxFps: 30, maxShortSide: 720, reason: "low-battery" };
  if (p.level !== null && p.level <= POWER_SAVER_PCT) return { maxFps: 30, reason: "battery-saver" };
  if (callMs >= LONG_CALL_UNPLUGGED_MS) return { maxFps: 30, reason: "long-call" };
  return null;
}

export function samePowerLimit(a: PowerLimit | null, b: PowerLimit | null): boolean {
  return (a?.reason ?? null) === (b?.reason ?? null);
}
