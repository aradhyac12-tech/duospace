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
  /** Always 0 now -- live values are delivered through the `onTilt` callback
   *  (no per-event React state). Kept only so the shape stays compatible. */
  x: number;
  y: number;
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

/**
 * PERF/FREEZE FIX: this hook used to keep x/y in React state and call
 * setX/setY on EVERY deviceorientation event (60-200 Hz on Android). That
 * re-rendered the whole SurpriseReveal tree (dozens of framer-motion nodes,
 * the iframe wrapper, the particle layer) at sensor rate on top of the spring
 * physics, the WebGL scene and the surprise's own iframe -- the main thread
 * never got a breather, so the app felt stuck/laggy while a surprise was open.
 *
 * Now readings are pushed straight into the caller's `onTilt` callback (the
 * caller writes them into MotionValues, which update the DOM without React),
 * coalesced to at most one write per animation frame, and tiny jitter is
 * dropped. React state only changes ONCE (`active` false -> true).
 *
 * `enabled` and the callback are read through refs, so the sensor listener is
 * attached exactly once per enable and never re-created by a re-render.
 */
const MIN_DELTA = 0.004; // ignore sub-pixel hand tremor

export const useDeviceTilt = (
  enabled: boolean,
  onTilt?: (x: number, y: number) => void,
): DeviceTiltState => {
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);
  const baseline = useRef<{ beta: number; gamma: number } | null>(null);
  const requestedRef = useRef(false);
  const listeningRef = useRef(false);
  const onTiltRef = useRef(onTilt);
  onTiltRef.current = onTilt;
  const latest = useRef({ x: 0, y: 0 });
  const lastSent = useRef({ x: 0, y: 0 });
  const rafRef = useRef(0);

  // Stable for the lifetime of the component: reads everything via refs.
  const handleOrientation = useRef((e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    // Baseline on first reading -- tilt is relative to how the phone was held
    // when the surprise opened, not relative to lying flat on a table.
    if (!baseline.current) baseline.current = { beta: e.beta, gamma: e.gamma };
    const relBeta = e.beta - baseline.current.beta;
    const relGamma = e.gamma - baseline.current.gamma;
    latest.current.y = Math.max(-0.5, Math.min(0.5, relBeta / (TILT_RANGE_DEG * 2)));
    latest.current.x = Math.max(-0.5, Math.min(0.5, relGamma / (TILT_RANGE_DEG * 2)));
    if (!activeRef.current) {
      activeRef.current = true;
      setActive(true); // the only React state change this hook ever makes
    }
    if (rafRef.current) return; // one write per frame, however many events arrived
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      const { x, y } = latest.current;
      if (Math.abs(x - lastSent.current.x) < MIN_DELTA && Math.abs(y - lastSent.current.y) < MIN_DELTA) return;
      lastSent.current = { x, y };
      onTiltRef.current?.(x, y);
    });
  }).current;

  const startListening = useCallback(() => {
    if (listeningRef.current) return; // never attach twice
    listeningRef.current = true;
    window.addEventListener("deviceorientation", handleOrientation);
  }, [handleOrientation]);

  const stopListening = useCallback(() => {
    if (!listeningRef.current) return;
    listeningRef.current = false;
    window.removeEventListener("deviceorientation", handleOrientation);
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
        .catch(() => { /* denied or unsupported -- pointer fallback stays in effect */ });
    } else {
      // Android / desktop: no permission gate, safe to listen directly.
      startListening();
    }
  }, [enabled, startListening]);

  useEffect(() => {
    if (!enabled) return;
    // Android/desktop don't need the gesture-gated request -- start right
    // away. iOS will simply never fire events until requestPermission() is
    // called from a real tap, which SurpriseReveal wires to its pointerdown.
    const DOE = window.DeviceOrientationEvent as unknown as { requestPermission?: unknown };
    if (typeof DOE?.requestPermission !== "function") startListening();
    return () => {
      stopListening();
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
      baseline.current = null;
      requestedRef.current = false;
      activeRef.current = false;
      lastSent.current = { x: 0, y: 0 };
      latest.current = { x: 0, y: 0 };
      setActive(false);
    };
  }, [enabled, startListening, stopListening]);

  // x/y are no longer React state (see above). Kept on the result so the type
  // stays compatible; read live values through `onTilt`.
  return { x: 0, y: 0, active, requestPermission };
};
