import { useRef, useState, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Ghost } from "lucide-react";
import { hapticLight, hapticMedium } from "@/lib/haptics";

interface Props {
  active: boolean;
  /** Called once when a pull past the threshold commits — parent decides on vs off from `active`. */
  onToggle: () => void;
}

/**
 * Instagram-style Vanish Mode gesture.
 *
 * Grab the pill at the bottom of the composer and *pull up*. As you drag, the
 * whole chat dims — the further you pull, the darker it gets and the more the
 * pill locks in. Release past the threshold to toggle vanish mode; release
 * below to snap back with no change.
 *
 * Vanish Mode redesign: this used to also expose a duration picker (tap the
 * pill while active). There's no duration anymore — messages stay visible
 * for as long as the mode itself is on, full stop — so the pill is now a
 * pure two-state toggle with nothing to tap into.
 *
 * All animation runs on a single Framer `motion.div` with GPU transforms — no
 * per-move React state — so the drag is buttery on low-end phones.
 *
 * HINT-TEXT CLIPPING FIX: the "Release to turn on/off" hint used to be an
 * `absolute -top-6` span inside this component's own row — which pokes above
 * the row's own box. That row lives inside DuoSpaceBottomSurface's composer
 * slot (`overflow: hidden`, required for its own height-open/close
 * animation) nested inside the shell's own `overflow-hidden` glass-dock —
 * so the hint was being silently clipped by an ancestor before it could
 * ever be seen, same root cause GridMenu's Hub-position bug had. Fixed the
 * same way that was: measure the pill's real screen rect and portal the
 * hint straight to `document.body` as `position: fixed`, so no ancestor's
 * overflow can clip it regardless of where this component is ever mounted.
 */
const PULL_THRESHOLD = 56;   // px of upward pull that commits the toggle
const MAX_PULL       = 96;   // clamp so overshoot doesn't feel like a rubber band snap
const ENGAGE_PX      = 6;    // filter accidental taps

const DisappearGestureHandle = ({ active, onToggle }: Props) => {
  const [pull, setPull] = useState(0);          // 0 … MAX_PULL — drives visuals
  const dragging        = useRef(false);
  const startY          = useRef(0);
  const engaged          = useRef(false);
  const committed        = useRef(false);
  const rowRef          = useRef<HTMLDivElement>(null);
  // Screen-space rect of the pill row, remeasured whenever the hint is
  // about to show — cheap (one layout read) and only happens on drag
  // start/pull change, never on every render.
  const [anchorRect, setAnchorRect] = useState<{ left: number; top: number; width: number } | null>(null);

  const progress = Math.min(pull / PULL_THRESHOLD, 1);
  const willCommit = pull >= PULL_THRESHOLD;

  const reset = useCallback(() => {
    dragging.current = false;
    engaged.current = false;
    committed.current = false;
    startY.current = 0;
    setPull(0);
  }, []);

  // Measure the pill's screen rect any time the hint is about to become
  // visible (drag just started), and keep it current while dragging in
  // case the whole bottom surface shifts under it (keyboard opening mid-
  // gesture). Not measured while idle — no work happens when nothing's
  // shown.
  useEffect(() => {
    if (pull <= 0) return;
    const measure = () => {
      const r = rowRef.current?.getBoundingClientRect();
      if (r) setAnchorRect({ left: r.left, top: r.top, width: r.width });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [pull]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Ignore multi-touch and non-primary buttons.
    if (e.button && e.button !== 0) return;
    dragging.current = true;
    engaged.current = false;
    committed.current = false;
    startY.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dy = startY.current - e.clientY;
    if (dy < ENGAGE_PX) { if (pull !== 0) setPull(0); return; }
    if (!engaged.current) { engaged.current = true; hapticLight(); }
    const next = Math.min(MAX_PULL, dy - ENGAGE_PX);
    const crossedNow = next >= PULL_THRESHOLD;
    const crossedBefore = pull >= PULL_THRESHOLD;
    if (crossedNow && !crossedBefore) hapticMedium();
    setPull(next);
  }, [pull]);

  const finish = useCallback(() => {
    if (!dragging.current) return;
    const commit = engaged.current && pull >= PULL_THRESHOLD && !committed.current;
    if (commit) {
      committed.current = true;
      hapticMedium();
      onToggle();
    }
    reset();
  }, [pull, onToggle, reset]);

  // Safety: if the pointer stream is interrupted (e.g. context menu, native
  // gesture), always snap back.
  useEffect(() => {
    const cancel = () => reset();
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [reset]);

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
      <div ref={rowRef} className="relative flex items-center justify-center py-1 select-none z-40">
        <motion.button
          type="button"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finish}
          aria-label={active ? "Vanish mode on — pull up to turn off" : "Pull up to turn on vanish mode"}
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
              <Ghost className="h-3 w-3" />
              Vanish on
            </span>
          )}
        </motion.button>

        {/* Hint text while dragging — portalled (see header comment):
            fixed to the viewport at the pill's measured x-center, just
            above its top edge, so it renders above every ancestor's
            overflow-hidden instead of being clipped by them. */}
      </div>

      {typeof document !== "undefined" && anchorRect && createPortal(
        <AnimatePresence>
          {pull > 0 && (
            <motion.span
              key={active ? "hint-off" : "hint-on"}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              style={{
                position: "fixed",
                left: anchorRect.left + anchorRect.width / 2,
                // ALIGNMENT FIX: anchorRect is measured off rowRef, which
                // never moves — the pill itself is what animates upward
                // (`y: -pull * 0.35` on the motion.button below), so the
                // hint was pinned 24px above the pill's *resting* spot and
                // fell further and further out of place as the pull grew,
                // instead of staying locked exactly above the pill as it
                // rose. Subtract that same offset here so the text tracks
                // the pill 1:1 while dragging.
                top: anchorRect.top - 24 - pull * 0.35,
                transform: "translateX(-50%)",
              }}
              className="pointer-events-none z-[60] whitespace-nowrap text-[10px] font-medium text-white/90 drop-shadow-sm"
            >
              {active
                ? (willCommit ? "Release to turn off" : "Keep pulling…")
                : (willCommit ? "Release to turn on" : "Keep pulling…")}
            </motion.span>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
};

export default DisappearGestureHandle;
