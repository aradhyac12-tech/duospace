import { useRef, useState, useCallback, useEffect } from "react";

interface PointerPt { x: number; y: number }

/**
 * Pinch-to-zoom + pan + double-tap-to-zoom for a single <img>.
 *
 * WHY DIRECT DOM WRITES INSTEAD OF REACT STATE: Gallery.tsx's own viewer
 * (see its MediaViewer — root-cause comment on the original lag/flicker
 * bug) already proved the *math* here is right: two-pointer pinch → scale,
 * midpoint → pan, touch-action: none so the browser's native pinch never
 * fights it, and drag disarmed for the entire gesture rather than a
 * discrete double-tap flag. This hook keeps that exact math but moves the
 * per-pointermove update off React state and onto a direct
 * `img.style.transform` write via ref. A real pinch or a fast pan fires
 * pointermove dozens of times a second — routing every one of those
 * through setState + reconciliation is extra work between the finger
 * moving and the pixel moving, which is exactly what reads as "lag" on a
 * mid-range phone. Writing the transform straight to the DOM node lets the
 * browser composite it on the next paint with nothing else in between.
 * React state is only touched at gesture boundaries (crossing the
 * zoomed/not-zoomed line, a pinch starting/ending) — the few moments
 * callers actually need a re-render for, e.g. to disarm their own
 * drag-to-dismiss while the photo is zoomed in.
 *
 * Call `reset()` (or pass a new `resetKey`) whenever the viewer moves to a
 * different photo, so a zoomed-in transform doesn't carry over onto
 * unrelated media.
 */
export function usePinchZoomPan(resetKey?: unknown) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const scale = useRef(1);
  const translate = useRef({ x: 0, y: 0 });
  const activePointers = useRef(new Map<number, PointerPt>());
  const pinchStart = useRef<{ dist: number; scale: number; midX: number; midY: number; tx: number; ty: number } | null>(null);
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const lastTapRef = useRef(0);

  // The only state that actually needs to trigger a re-render: whether the
  // image is currently zoomed/mid-pinch. Callers gate their own
  // drag-to-dismiss on these booleans, not on a per-frame scale number.
  const [isZoomed, setIsZoomed] = useState(false);
  const [isPinching, setIsPinching] = useState(false);

  const dist = (a: PointerPt, b: PointerPt) => Math.hypot(a.x - b.x, a.y - b.y);
  const midpoint = (a: PointerPt, b: PointerPt) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const applyTransform = () => {
    const img = imgRef.current;
    if (!img) return;
    img.style.transform = `translate(${translate.current.x}px, ${translate.current.y}px) scale(${scale.current})`;
  };

  // Keeps a zoomed image from being panned out into empty space. Bounds are
  // deliberately approximate (based on the container's own box, since an
  // object-contain image roughly fills it at scale 1) rather than pixel-
  // exact — good enough to stop the image drifting away, not worth the
  // fragility of measuring the post-transform rendered box mid-gesture.
  const clampTranslate = (s: number, tx: number, ty: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || s <= 1) return { x: 0, y: 0 };
    const maxX = (rect.width * (s - 1)) / 2;
    const maxY = (rect.height * (s - 1)) / 2;
    return { x: Math.max(-maxX, Math.min(maxX, tx)), y: Math.max(-maxY, Math.min(maxY, ty)) };
  };

  const reset = useCallback(() => {
    scale.current = 1;
    translate.current = { x: 0, y: 0 };
    activePointers.current.clear();
    pinchStart.current = null;
    panStart.current = null;
    applyTransform();
    setIsZoomed(false);
    setIsPinching(false);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally re-runs only on resetKey
  useEffect(() => { reset(); }, [resetKey]);

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.current.size === 2) {
      panStart.current = null; // a second finger landed mid-pan — hand off to pinch
      const [a, b] = Array.from(activePointers.current.values());
      const mid = midpoint(a, b);
      pinchStart.current = { dist: dist(a, b), scale: scale.current, midX: mid.x, midY: mid.y, tx: translate.current.x, ty: translate.current.y };
      setIsPinching(true);
    } else if (activePointers.current.size === 1 && scale.current > 1) {
      const [p] = Array.from(activePointers.current.values());
      panStart.current = { x: p.x, y: p.y, tx: translate.current.x, ty: translate.current.y };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!activePointers.current.has(e.pointerId)) return;
    activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointers.current.size === 2 && pinchStart.current) {
      const [a, b] = Array.from(activePointers.current.values());
      const newDist = dist(a, b);
      const mid = midpoint(a, b);
      const nextScale = Math.min(4, Math.max(1, pinchStart.current.scale * (newDist / pinchStart.current.dist)));
      const next = clampTranslate(
        nextScale,
        pinchStart.current.tx + (mid.x - pinchStart.current.midX),
        pinchStart.current.ty + (mid.y - pinchStart.current.midY),
      );
      scale.current = nextScale;
      translate.current = next;
      applyTransform();
    } else if (activePointers.current.size === 1 && panStart.current) {
      const [p] = Array.from(activePointers.current.values());
      translate.current = clampTranslate(scale.current, panStart.current.tx + (p.x - panStart.current.x), panStart.current.ty + (p.y - panStart.current.y));
      applyTransform();
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    activePointers.current.delete(e.pointerId);
    if (activePointers.current.size < 2) {
      pinchStart.current = null;
      setIsPinching(false);
      // A pinch that ends barely above 1x reads as an accidental/settling
      // gesture, not an intentional zoom — snap fully back rather than
      // leaving the image in an awkward almost-zoomed state.
      if (scale.current < 1.05) {
        scale.current = 1;
        translate.current = { x: 0, y: 0 };
        applyTransform();
      }
    }
    if (activePointers.current.size === 1) {
      const [p] = Array.from(activePointers.current.values());
      panStart.current = scale.current > 1 ? { x: p.x, y: p.y, tx: translate.current.x, ty: translate.current.y } : null;
    } else if (activePointers.current.size === 0) {
      panStart.current = null;
    }
    const zoomed = scale.current > 1.001;
    setIsZoomed((prev) => (prev === zoomed ? prev : zoomed));
  };

  // Double-tap-to-zoom: zooms centered on the tap point (standard
  // translate = (center - tapPoint) * (scale - 1) formula). This is the one
  // spot a short CSS transition is added back in — a double-tap is a
  // discrete jump, not a continuous gesture, so animating it doesn't fight
  // anything the way animating a live pinch/pan would.
  const onImageTap = (e: React.MouseEvent<HTMLImageElement>) => {
    const now = Date.now();
    const isDoubleTap = now - lastTapRef.current < 300;
    lastTapRef.current = now;
    if (!isDoubleTap) return;
    const img = imgRef.current;
    if (img) img.style.transition = "transform 0.2s ease-out";
    if (scale.current > 1) {
      scale.current = 1;
      translate.current = { x: 0, y: 0 };
    } else {
      const rect = e.currentTarget.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const targetScale = 2.5;
      scale.current = targetScale;
      translate.current = clampTranslate(targetScale, (cx - e.clientX) * (targetScale - 1), (cy - e.clientY) * (targetScale - 1));
    }
    applyTransform();
    setIsZoomed(scale.current > 1.001);
    window.setTimeout(() => { if (img) img.style.transition = ""; }, 220);
  };

  return {
    containerRef, imgRef, isZoomed, isPinching,
    onPointerDown, onPointerMove, onPointerUp, onImageTap,
    reset,
  };
}
