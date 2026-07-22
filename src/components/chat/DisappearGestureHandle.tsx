import { useRef, useState, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Timer } from "lucide-react";
import { hapticLight, hapticMedium } from "@/lib/haptics";

export interface DisappearStep { label: string; value: number } // value in ms; 0 = Off

interface Props {
  steps: DisappearStep[]; // ordered shortest -> longest (Off is added internally)
  active: boolean;
  currentMs: number;
  onCommit: (ms: number) => void; // 0 = turn off
}

const ENGAGE_PX = 18;   // upward drag distance before the scale engages
const PX_PER_STEP = 38; // drag distance per scale step once engaged

/**
 * Swipe up + hold, drag to pick a duration, release to commit — modeled on
 * Instagram's Vanish Mode gesture (swipe up from near the input to turn on,
 * same swipe to turn off; dark overlay signals the mode is live) crossed
 * with Signal's multi-step duration picker (Off through a real time scale,
 * rather than a binary on/off).
 */
const DisappearGestureHandle = ({ steps, active, currentMs, onCommit }: Props) => {
  const fullScale = [{ label: "Off", value: 0 }, ...steps];
  const [dragging, setDragging] = useState(false);
  const [engaged, setEngaged] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const startY = useRef(0);
  const pointerId = useRef<number | null>(null);

  const currentStepIndex = () => {
    const i = fullScale.findIndex(s => s.value === currentMs);
    return i === -1 ? 0 : i;
  };

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    startY.current = e.clientY;
    pointerId.current = e.pointerId;
    setDragging(true);
    setEngaged(false);
    setStepIndex(active ? currentStepIndex() : 0);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [active, currentMs]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging) return;
    const deltaY = startY.current - e.clientY; // positive = dragged up
    if (!engaged && deltaY > ENGAGE_PX) {
      setEngaged(true);
      hapticLight();
    }
    if (deltaY > ENGAGE_PX) {
      // Already-active mode: any engaged swipe just means "turn off" (mirrors
      // Instagram's re-swipe-to-disable) — no need to browse the scale.
      if (active) return;
      const idx = Math.min(fullScale.length - 1, Math.floor((deltaY - ENGAGE_PX) / PX_PER_STEP));
      if (idx !== stepIndex) hapticLight();
      setStepIndex(idx);
    }
  }, [dragging, engaged, active, stepIndex, fullScale.length]);

  const finish = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    if (engaged) {
      hapticMedium();
      if (active) {
        onCommit(0); // any engaged swipe while already active = turn off
      } else {
        onCommit(fullScale[stepIndex].value);
      }
    }
    setEngaged(false);
  }, [dragging, engaged, active, stepIndex, fullScale, onCommit]);

  return (
    <div className="relative">
      <AnimatePresence>
        {engaged && !active && (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-card border border-border rounded-2xl shadow-xl p-1.5 flex flex-col-reverse gap-0.5 z-30"
          >
            {fullScale.map((s, i) => (
              <div key={s.label}
                className={`px-4 py-1.5 rounded-xl text-xs text-center transition-all ${
                  i === stepIndex ? "bg-primary text-primary-foreground font-semibold scale-105" : "text-muted-foreground"
                }`}>
                {s.label}
              </div>
            ))}
          </motion.div>
        )}
        {engaged && active && (
          <motion.div
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-card border border-border rounded-2xl shadow-xl px-4 py-2 z-30"
          >
            <span className="text-xs font-medium text-muted-foreground">Release to turn off</span>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        style={{ touchAction: "none" }}
        className="flex items-center justify-center py-1 cursor-grab active:cursor-grabbing select-none"
        aria-label="Swipe up and hold to set disappearing messages"
        role="button"
      >
        <div className={`h-1 w-9 rounded-full transition-colors ${
          engaged ? "bg-primary" : active ? "bg-primary/50" : "bg-muted-foreground/25"
        }`} />
        {active && !engaged && <Timer className="h-3 w-3 text-primary/70 ml-1.5" />}
      </div>
    </div>
  );
};

export default DisappearGestureHandle;
