/**
 * Surprise 3.0 §4: "touch should feel physical".
 *
 * A single reusable gesture primitive — idle → contact → compression →
 * resistance → release → rebound — driving one spring-smoothed
 * `compression` MotionValue (1 = resting, dips on press, briefly overshoots
 * past 1 on release before settling) that any surprise surface can apply
 * as a scale transform. Not hardcoded into SurpriseReveal specifically —
 * later preset/scene work (§9/§11) can reuse this same hook for their own
 * tap targets instead of each one growing its own gesture code.
 *
 * Phase meanings:
 *   idle        — nothing touching it.
 *   contact     — pointer just went down; immediate, tiny give.
 *   compression — held past the long-press threshold; deeper, sustained give.
 *   resistance  — pointer moved past the drag threshold; treated as a drag,
 *                 not a tap/long-press, and the "held" timer is cancelled —
 *                 a drag shouldn't also fire a long-press underneath it.
 *   release     — pointer lifted; a brief overshoot past resting size,
 *                 reading as a spring letting go rather than a hard stop.
 *   rebound     — settling back to resting size; then back to idle.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useMotionValue, useSpring, type MotionValue } from "framer-motion";

export type TouchPhase = "idle" | "contact" | "compression" | "resistance" | "release" | "rebound";
export type SwipeDirection = "up" | "down" | "left" | "right";

export interface UseSurpriseTouchOptions {
  onTap?: () => void;
  onDoubleTap?: () => void;
  onLongPress?: () => void;
  onSwipe?: (direction: SwipeDirection) => void;
  onDrag?: (dx: number, dy: number) => void;
  longPressMs?: number;
  doubleTapMs?: number;
  swipeThresholdPx?: number;
  /** Skip the physical response entirely (e.g. prefers-reduced-motion) —
   *  callbacks (tap/long-press/swipe/drag) still fire, only the spring
   *  compression is suppressed, per §17: "preserve meaningful interaction
   *  feedback" even when continuous motion is off. */
  disablePhysicalResponse?: boolean;
}

export interface UseSurpriseTouchResult {
  phase: TouchPhase;
  /** 1 = resting. Apply as a `scale` transform on the tap surface. */
  compression: MotionValue<number>;
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
    onPointerLeave: (e: React.PointerEvent) => void;
  };
}

const DRAG_THRESHOLD_PX = 6;

export function useSurpriseTouch(options: UseSurpriseTouchOptions = {}): UseSurpriseTouchResult {
  const {
    onTap, onDoubleTap, onLongPress, onSwipe, onDrag,
    longPressMs = 450, doubleTapMs = 280, swipeThresholdPx = 40,
    disablePhysicalResponse = false,
  } = options;

  const [phase, setPhase] = useState<TouchPhase>("idle");
  const compressionRaw = useMotionValue(1);
  const compression = useSpring(compressionRaw, { stiffness: 420, damping: 18 });

  const startRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const draggedRef = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTapAtRef = useRef(0);
  const settleTimers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const setCompression = useCallback((v: number) => {
    if (!disablePhysicalResponse) compressionRaw.set(v);
  }, [disablePhysicalResponse, compressionRaw]);

  const clearLongPressTimer = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  const clearSettleTimers = () => {
    settleTimers.current.forEach(clearTimeout);
    settleTimers.current = [];
  };

  useEffect(() => () => {
    clearLongPressTimer();
    clearSettleTimers();
    if (pendingTapTimer.current) clearTimeout(pendingTapTimer.current);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    draggedRef.current = false;
    clearSettleTimers();
    setPhase("contact");
    setCompression(0.97);
    longPressTimer.current = setTimeout(() => {
      setPhase("compression");
      setCompression(0.93);
      onLongPress?.();
    }, longPressMs);
  }, [longPressMs, onLongPress, setCompression]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!startRef.current || draggedRef.current) return;
    const dx = e.clientX - startRef.current.x;
    const dy = e.clientY - startRef.current.y;
    if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
      draggedRef.current = true;
      clearLongPressTimer();
      setPhase("resistance");
    }
    if (draggedRef.current) onDrag?.(dx, dy);
  }, [onDrag]);

  /** Shared release path for pointerup/cancel/leave — always settle the
   *  spring back to resting even when the gesture didn't complete cleanly. */
  const settle = useCallback((fireRelease: boolean) => {
    clearLongPressTimer();
    if (fireRelease) {
      setPhase("release");
      setCompression(1.04);
      const t1 = setTimeout(() => { setCompression(1); setPhase("rebound"); }, 90);
      const t2 = setTimeout(() => setPhase("idle"), 260);
      settleTimers.current.push(t1, t2);
    } else {
      setCompression(1);
      setPhase("idle");
    }
  }, [setCompression]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const start = startRef.current;
    startRef.current = null;
    const wasLongPress = phase === "compression";
    settle(true);
    if (!start) return;

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dist = Math.hypot(dx, dy);
    const elapsedMs = Date.now() - start.t;

    if (dist >= swipeThresholdPx && elapsedMs < 600) {
      const direction: SwipeDirection = Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? "right" : "left")
        : (dy > 0 ? "down" : "up");
      onSwipe?.(direction);
      return;
    }
    // A drag or a long-press already delivered its own callback — don't
    // ALSO read the lift as a tap underneath it.
    if (draggedRef.current || wasLongPress) return;

    const now = Date.now();
    if (now - lastTapAtRef.current < doubleTapMs) {
      if (pendingTapTimer.current) { clearTimeout(pendingTapTimer.current); pendingTapTimer.current = null; }
      lastTapAtRef.current = 0;
      onDoubleTap?.();
    } else {
      lastTapAtRef.current = now;
      pendingTapTimer.current = setTimeout(() => {
        pendingTapTimer.current = null;
        onTap?.();
      }, doubleTapMs);
    }
  }, [phase, swipeThresholdPx, doubleTapMs, settle, onSwipe, onDoubleTap, onTap]);

  const onPointerAbandon = useCallback(() => {
    startRef.current = null;
    settle(false);
  }, [settle]);

  return {
    phase,
    compression,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerAbandon,
      onPointerLeave: onPointerAbandon,
    },
  };
}
