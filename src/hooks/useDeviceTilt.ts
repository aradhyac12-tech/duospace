import { useEffect, useRef, useState, useCallback } from "react";

/**
 * Gyroscope-driven tilt, normalized to the same [-0.5, 0.5] range
 * SurpriseReveal's pointer-driven rawX/rawY already use — this is a drop-in
 * alternate input source for the same motion values, not a parallel system.
 *
 * WHY THIS EXISTS: pointer-based tilt (onPointerMove) is a desktop-mouse
 * interaction. On the actual target platform for this feature — a phone —
 * a static finger tap doesn't produce continuous pointer movement the way
 * a mouse drag does, so the "hold a physical glass object" feel the
 * pointer tilt was going for barely registers on-device. Tilting the PHONE
 * ITSELF is the real analog of turning a physical object in your hand, and
 * every phone already has the sensor for it — no new native plugin needed,
 * DeviceOrientationEvent is a standard web API Capacitor's WebView exposes
 * out of the box on both platforms.
 *
 * iOS 13+ gates this behind an explicit permission prompt that MUST be
 * triggered from a real user gesture (a tap) — can't be requested on
 * mount. `requestPermission()` below is meant to be called from an
 * existing tap handler already in the component (e.g. the card's own
 * onPointerDown), not from a dedicated prompt, so it stays invisible when
 * granted and only silently no-ops (falls back to pointer tilt) if denied.
 * Android and desktop browsers have no such gate and start listening
 * immediately.
 */
export interface DeviceTiltState {
  x: number; // -0.5..0.5, left/right
  y: number; // -0.5..0.5, front/back
  /** True once real orientation events are actually arriving — until then
   *  (or if the device/browser has no sensor at all), callers should keep
   *  using their pointer-driven fallback instead of this hook's x/y. */
  active: boolean;
  /** Call from an existing tap/pointerdown handler on iOS to request the
   *  permission prompt. No-ops (and is safe to call) everywhere else. */
  requestPermission: () => void;
}

// Empirical comfortable range for a phone held naturally and tilted a
// little — beta/gamma in degrees. Wider than this and small hand tremor
// would pin the card at max tilt permanently, which reads as broken, not
// premium.
const TILT_RANGE_DEG = 20;

export const useDeviceTilt = (enabled: boolean): DeviceTiltState => {
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);
  const [active, setActive] = useState(false);
  const baseline = useRef<{ beta: number; gamma: number } | null>(null);
  const requestedRef = useRef(false);

  const handleOrientation = useCallback((e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    // Baseline on first reading — tilt is relative to how the phone was
    // being held when the surprise opened, not relative to lying flat on
    // a table, since nobody views their phone that way.
    if (!baseline.current) baseline.current = { beta: e.beta, gamma: e.gamma };
    const relBeta = e.beta - baseline.current.beta;
    const relGamma = e.gamma - baseline.current.gamma;
    setY(Math.max(-0.5, Math.min(0.5, relBeta / (TILT_RANGE_DEG * 2))));
    setX(Math.max(-0.5, Math.min(0.5, relGamma / (TILT_RANGE_DEG * 2))));
    if (!active) setActive(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const startListening = useCallback(() => {
    window.addEventListener("deviceorientation", handleOrientation);
  }, [handleOrientation]);

  const requestPermission = useCallback(() => {
    if (requestedRef.current || !enabled) return;
    requestedRef.current = true;
    const DOE = window.DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    };
    if (typeof DOE?.requestPermission === "function") {
      DOE.requestPermission()
        .then((state) => { if (state === "granted") startListening(); })
        .catch(() => { /* denied or unsupported — pointer fallback stays in effect */ });
    } else {
      // Android / desktop: no permission gate, safe to listen directly.
      startListening();
    }
  }, [enabled, startListening]);

  useEffect(() => {
    if (!enabled) return;
    // Android/desktop don't need the gesture-gated request — start right
    // away. iOS will simply never fire events until requestPermission()
    // is called from a real tap, which SurpriseReveal wires to its own
    // pointerdown handler.
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: unknown };
    if (typeof DOE?.requestPermission !== "function") startListening();
    return () => {
      window.removeEventListener("deviceorientation", handleOrientation);
      baseline.current = null;
      requestedRef.current = false;
    };
  }, [enabled, startListening, handleOrientation]);

  return { x, y, active, requestPermission };
};
