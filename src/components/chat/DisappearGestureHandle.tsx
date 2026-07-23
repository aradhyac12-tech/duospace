import { useRef, useState, useCallback, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Timer } from "lucide-react";
import { hapticLight, hapticMedium } from "@/lib/haptics";

export interface DisappearStep { label: string; value: number }

interface Props {
  /** Retained for API compat; the current duration surfaces via `currentMs`. */
  steps: DisappearStep[];
  active: boolean;
  currentMs: number;
  /** Called with 0 to turn OFF, or the current `currentMs` to turn ON. */
  onCommit: (ms: number) => void;
  /** Open the timer picker sheet (tap on the pill while active). */
  onOpenPicker?: () => void;
}

/**
 * Instagram-style Vanish Mode gesture.
 *
 * Grab the pill at the bottom of the composer and *pull up*. As you drag, the
 * whole chat dims — the further you pull, the darker it gets and the more the
 * pill locks in. Release past the threshold to toggle vanish mode; release
 * below to snap back with no change. Tapping the pill while active opens the
 * duration picker (Instagram exposes the timer separately from the gesture).
 *
 * All animation runs on a single Framer `motion.div` with GPU transforms — no
 * per-move React state — so the drag is buttery on low-end phones.
 */
const PULL_THRESHOLD = 56;   // px of upward pull that commits the toggle
const MAX_PULL       = 96;   // clamp so overshoot doesn't feel like a rubber band snap
const ENGAGE_PX      = 6;    // filter accidental taps

const DisappearGestureHandle = ({ active, currentMs, onCommit, onOpenPicker }: Props) => {
  const [pull, setPull] = useState(0);          // 0 … MAX_PULL — drives visuals
  const [holdProgress, setHoldProgress] = useState(0); // 0..1 while long-pressing
  const dragging        = useRef(false);
  const startY          = useRef(0);
  const engaged         = useRef(false);
  const committed       = useRef(false);
  const holdTimer       = useRef<number | null>(null);
  const holdRaf         = useRef<number | null>(null);
  const holdStart       = useRef(0);
  const HOLD_MS         = 3000;

  const progress = Math.min(pull / PULL_THRESHOLD, 1);
  const willCommit = pull >= PULL_THRESHOLD;

  const clearHold = useCallback(() => {
    if (holdTimer.current) { clearTimeout(holdTimer.current); holdTimer.current = null; }
    if (holdRaf.current) { cancelAnimationFrame(holdRaf.current); holdRaf.current = null; }
    setHoldProgress(0);
  }, []);

  const reset = useCallback(() => {
    dragging.current = false;
    engaged.current = false;
    committed.current = false;
    startY.current = 0;
    setPull(0);
    clearHold();
  }, [clearHold]);

  const beginHold = useCallback(() => {
    holdStart.current = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - holdStart.current) / HOLD_MS);
      setHoldProgress(p);
      if (p < 1) holdRaf.current = requestAnimationFrame(tick);
    };
    holdRaf.current = requestAnimationFrame(tick);
    holdTimer.current = window.setTimeout(() => {
      if (!committed.current) {
        committed.current = true;
        hapticMedium();
        onCommit(active ? 0 : currentMs);
      }
      clearHold();
    }, HOLD_MS);
  }, [active, currentMs, onCommit, clearHold]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button && e.button !== 0) return;
    dragging.current = true;
    engaged.current = false;
    committed.current = false;
    startY.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    beginHold();
  }, [beginHold]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dy = startY.current - e.clientY;
    if (dy < ENGAGE_PX) { if (pull !== 0) setPull(0); return; }
    if (!engaged.current) { engaged.current = true; hapticLight(); clearHold(); }
    const next = Math.min(MAX_PULL, dy - ENGAGE_PX);
    const crossedNow = next >= PULL_THRESHOLD;
    const crossedBefore = pull >= PULL_THRESHOLD;
    if (crossedNow && !crossedBefore) hapticMedium();
    setPull(next);
  }, [pull, clearHold]);

  const finish = useCallback(() => {
    if (!dragging.current) return;
    const commit = engaged.current && pull >= PULL_THRESHOLD && !committed.current;
    if (commit) {
      committed.current = true;
      hapticMedium();
      onCommit(active ? 0 : currentMs);
    }
    reset();
  }, [pull, active, currentMs, onCommit, reset]);

  useEffect(() => {
    const cancel = () => reset();
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [reset]);

  const onPillTap = () => {
    if (engaged.current) return;
    if (active && onOpenPicker) onOpenPicker();
  };


  return (
    <>
      {/* Full-viewport dim overlay driven by the drag. Instagram darkens the
          whole screen as vanish mode engages — we do the same with a purely
          opacity-driven layer that sits above the chat but below the composer. */}
      <AnimatePresence>
        {(pull > 0 || active) && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: active ? 0.55 : progress * 0.6 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="pointer-events-none fixed inset-0 z-30 bg-black"
            aria-hidden="true"
          />
        )}
      </AnimatePresence>

      {/* Gesture pill */}
      <div className="relative flex items-center justify-center py-1 select-none z-40">
        <motion.button
          type="button"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          onClick={onPillTap}
          aria-label={active ? "Vanish mode on — pull up to turn off, tap to change timer" : "Pull up to turn on vanish mode"}
          animate={{ y: -pull * 0.35, scale: 1 + progress * 0.15 }}
          transition={ dragging.current
            ? { type: "tween", duration: 0 }              // 1:1 with the finger while dragging
            : { type: "spring", stiffness: 520, damping: 32 } // snappy release
          }
          style={{ touchAction: "none" }}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-colors ${
            active || willCommit
              ? "bg-primary/15"
              : "bg-transparent"
          }`}
        >
          <motion.span
            animate={{
              width: willCommit || active ? 28 : 36,
              backgroundColor: willCommit || active
                ? "hsl(var(--primary))"
                : "hsl(var(--muted-foreground) / 0.35)",
            }}
            transition={{ duration: 0.15 }}
            className="h-1 rounded-full"
          />
          {active && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-primary">
              <Timer className="h-3 w-3" />
              Vanish on
            </span>
          )}
        </motion.button>

        {/* Hint text while dragging */}
        <AnimatePresence>
          {pull > 0 && !active && (
            <motion.span
              key="hint-on"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              className="pointer-events-none absolute -top-6 text-[10px] font-medium text-white/90"
            >
              {willCommit ? "Release to turn on" : "Keep pulling…"}
            </motion.span>
          )}
          {pull > 0 && active && (
            <motion.span
              key="hint-off"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              className="pointer-events-none absolute -top-6 text-[10px] font-medium text-white/90"
            >
              {willCommit ? "Release to turn off" : "Keep pulling…"}
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </>
  );
};

export default DisappearGestureHandle;
