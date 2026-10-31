import { motion, useAnimationControls } from "framer-motion";
import { SkipBack, SkipForward } from "lucide-react";

/**
 * Next / Previous button. Tapping gives the glyph a short nudge in the direction of travel (the
 * button visibly "does something" even while the next song is still resolving), on top of the
 * button's own press-scale. The nudge is driven imperatively from onClick: the sheet's
 * onPointerDownCapture stopPropagation would swallow framer's own whileTap on a child.
 */
interface Props {
  dir: "next" | "prev";
  onSkip: () => void;
  className?: string;
  iconClassName?: string;
  filled?: boolean;
  label?: string;
  /** Stop the click reaching a parent that also handles taps (the mini bar expands on tap). */
  stopClick?: boolean;
  onPointerDownCapture?: (e: React.PointerEvent) => void;
}

export function SkipButton({ dir, onSkip, className, iconClassName = "h-5 w-5", filled = false, label, stopClick = false, onPointerDownCapture }: Props) {
  const controls = useAnimationControls();
  const Icon = dir === "next" ? SkipForward : SkipBack;
  const sign = dir === "next" ? 1 : -1;
  return (
    <button
      type="button"
      aria-label={label ?? (dir === "next" ? "Next" : "Previous")}
      onPointerDownCapture={onPointerDownCapture}
      onClick={(e) => {
        if (stopClick) e.stopPropagation();
        void controls.start({
          x: [0, 7 * sign, 0],
          opacity: [1, 0.55, 1],
          transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1], times: [0, 0.4, 1] },
        });
        onSkip();
      }}
      className={className}
    >
      <motion.span animate={controls} className="flex items-center justify-center">
        <Icon className={iconClassName} fill={filled ? "currentColor" : undefined} />
      </motion.span>
    </button>
  );
}

export default SkipButton;
