import { useCallback, useEffect, useRef } from "react";
import { useKeyboardOpen } from "@/hooks/useKeyboardOpen";

/**
 * Real pointer-drag for the Groic mini-player.
 *
 * MANDATORY per the Phase 4 Music brief: the mini-player must be genuinely
 * draggable, not just animate into place. This hook owns that — the
 * component stays a normal React tree; this hook talks to the DOM node
 * directly via refs + requestAnimationFrame so a finger drag never triggers
 * a React re-render (only mount/unmount-worthy state, like isDragging for
 * disabling child button taps mid-drag, goes through useState/useRef reads
 * where a render is actually needed).
 *
 * Movement is applied as a CSS transform (translate3d) on top of the
 * existing layout position (the bar's normal `left-3 right-3` / `bottom:`
 * placement from GroicMiniPlayer.tsx), so this is purely additive — an
 * offset, not a replacement positioning system.
 *
 * Bounds respected on every move and clamp:
 *  - safe-area insets (top status bar, bottom home indicator)
 *  - the floating dock's own footprint (never let the bar sit under it)
 *  - the on-screen keyboard (via useKeyboardOpen — while it's open the
 *    bottom bound tightens to the current visualViewport height)
 *  - current viewport size (recomputed on resize/orientation change; an
 *    offset from a previous, larger viewport gets clamped back in, not
 *    left to hang off-screen)
 *
 * On release, the bar snaps to whichever horizontal edge (left/right) it's
 * closer to — the one bit of "smart" behavior beyond raw finger-tracking,
 * matching the iOS PiP / Messenger chat-head convention this pattern is
 * drawn from. Vertical position is left exactly where the finger dropped
 * it (clamped), not snapped, since there's no equivalent "which edge"
 * question on that axis.
 *
 * Session persistence: last released offset is written to
 * `sessionStorage` (not `localStorage` — this is meant to survive a route
 * change within the session, not outlive the app being force-quit; a
 * stale saved position from a very different viewport would be jarring on
 * a fresh cold start) and restored + re-clamped on mount.
 *
 * A11y requirement from the brief: dragging can never be the *only* way to
 * move/open the bar. This hook only adds an offset on top of the existing
 * tap-to-expand handler in GroicMiniPlayer.tsx — it doesn't replace or
 * gate it. A drag is distinguished from a tap purely by movement distance
 * (see DRAG_THRESHOLD_PX below), so a plain tap still reaches the
 * existing onClick unimpeded.
 */

const STORAGE_KEY = "groic-mini-pos";
const DRAG_THRESHOLD_PX = 6; // below this, treat pointer down+up as a tap, not a drag
const EDGE_MARGIN_PX = 12; // matches the bar's own left-3/right-3 (0.75rem) inset
const DOCK_CLEARANCE_PX = 72; // approx floating dock height + its own margin

interface Offset {
  x: number;
  y: number;
}

function readSavedOffset(): Offset | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.x === "number" && typeof parsed?.y === "number") return parsed;
  } catch {
    // sessionStorage unavailable (private mode, etc.) — fall through to default
  }
  return null;
}

function saveOffset(offset: Offset) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(offset));
  } catch {
    // best-effort only — a failed save just means no persistence this session
  }
}

/**
 * Clamp an (x, y) offset so the bar's actual layout rect stays fully
 * within the usable screen area — safe areas, dock clearance, and the
 * keyboard when it's open.
 */
function clampOffset(el: HTMLElement, offset: Offset, keyboardOpen: boolean): Offset {
  const rect = el.getBoundingClientRect();
  // rect already reflects any currently-applied transform, so subtract the
  // live offset back out to get the bar's untransformed base position.
  const baseLeft = rect.left - offset.x;
  const baseTop = rect.top - offset.y;
  const width = rect.width;
  const height = rect.height;

  const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;

  const safeTop =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sat") || "0") || 0;

  const minX = EDGE_MARGIN_PX - baseLeft;
  const maxX = viewportWidth - EDGE_MARGIN_PX - width - baseLeft;
  const minY = safeTop - baseTop;
  const bottomClearance = (keyboardOpen ? 8 : DOCK_CLEARANCE_PX) - baseTop;
  const maxY = viewportHeight - height - bottomClearance;

  return {
    x: Math.min(Math.max(offset.x, Math.min(minX, maxX)), Math.max(minX, maxX)),
    y: Math.min(Math.max(offset.y, Math.min(minY, maxY)), Math.max(minY, maxY)),
  };
}

export function useDraggableMiniPlayer<T extends HTMLElement>() {
  const nodeRef = useRef<T | null>(null);
  const offsetRef = useRef<Offset>({ x: 0, y: 0 });
  const pointerStartRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const draggedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<Offset | null>(null);
  const keyboardOpen = useKeyboardOpen();

  const applyTransform = useCallback((offset: Offset) => {
    const el = nodeRef.current;
    if (!el) return;
    el.style.transform = `translate3d(${offset.x}px, ${offset.y}px, 0)`;
  }, []);

  const flush = useCallback(() => {
    rafRef.current = null;
    if (pendingRef.current) applyTransform(pendingRef.current);
  }, [applyTransform]);

  const scheduleTransform = useCallback(
    (offset: Offset) => {
      pendingRef.current = offset;
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  // Restore + clamp a saved position on mount.
  useEffect(() => {
    const el = nodeRef.current;
    if (!el) return;
    const saved = readSavedOffset();
    if (saved) {
      const clamped = clampOffset(el, saved, keyboardOpen);
      offsetRef.current = clamped;
      applyTransform(clamped);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-clamp on resize/orientation change/keyboard toggle so a bar
  // positioned in a larger viewport never ends up stranded off-screen.
  useEffect(() => {
    const reclamp = () => {
      const el = nodeRef.current;
      if (!el) return;
      const clamped = clampOffset(el, offsetRef.current, keyboardOpen);
      offsetRef.current = clamped;
      applyTransform(clamped);
    };
    reclamp();
    window.addEventListener("resize", reclamp);
    window.visualViewport?.addEventListener("resize", reclamp);
    return () => {
      window.removeEventListener("resize", reclamp);
      window.visualViewport?.removeEventListener("resize", reclamp);
    };
  }, [keyboardOpen, applyTransform]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Ignore secondary buttons / multi-touch beyond the first pointer.
    if (e.button !== undefined && e.button !== 0) return;
    const el = nodeRef.current;
    if (!el) return;
    draggedRef.current = false;
    pointerStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      offsetX: offsetRef.current.x,
      offsetY: offsetRef.current.y,
    };
    el.setPointerCapture?.(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const start = pointerStartRef.current;
      const el = nodeRef.current;
      if (!start || !el) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!draggedRef.current && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      draggedRef.current = true;
      const next = clampOffset(el, { x: start.offsetX + dx, y: start.offsetY + dy }, keyboardOpen);
      offsetRef.current = next;
      scheduleTransform(next);
    },
    [keyboardOpen, scheduleTransform],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const el = nodeRef.current;
      pointerStartRef.current = null;
      if (!el) return;
      el.releasePointerCapture?.(e.pointerId);
      if (!draggedRef.current) return; // was a tap — let the existing onClick handle it

      // Edge-snap horizontally to whichever side is closer.
      const rect = el.getBoundingClientRect();
      const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
      const distLeft = rect.left;
      const distRight = viewportWidth - rect.right;
      const snapDeltaX = distLeft <= distRight ? -distLeft + EDGE_MARGIN_PX : distRight - EDGE_MARGIN_PX;
      const snapped = clampOffset(
        el,
        { x: offsetRef.current.x + snapDeltaX, y: offsetRef.current.y },
        keyboardOpen,
      );
      offsetRef.current = snapped;
      applyTransform(snapped);
      saveOffset(snapped);

      // Swallow the click that would otherwise fire right after a drag
      // release (browsers dispatch a click after pointerup on the same
      // target) — without this, dragging the bar would also expand it.
      const suppressNextClick = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      el.addEventListener("click", suppressNextClick, { capture: true, once: true });
      // Safety net in case no click follows (some pointer/touch paths
      // don't emit one) — don't leave the listener attached forever.
      setTimeout(() => el.removeEventListener("click", suppressNextClick, { capture: true } as EventListenerOptions), 400);
    },
    [applyTransform, keyboardOpen],
  );

  return {
    nodeRef,
    dragHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      style: { touchAction: "none" as const },
    },
  };
}
