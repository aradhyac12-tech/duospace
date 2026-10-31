import { AnimatePresence, motion } from "framer-motion";
import { Play, Pause, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The glyph inside the play / pause button. Swapping Play <-> Pause <-> spinner used to be an instant
 * React swap (a hard blink on every tap). The icons now sit in the same grid cell and cross-fade with
 * a tiny scale, so pause / play / loading all morph into each other without moving the button.
 */
interface Props {
  busy: boolean;
  playing: boolean;
  /** Icon size classes, e.g. "h-4 w-4". */
  className?: string;
  /** Solid icon (full player) vs outline (mini bar). */
  filled?: boolean;
  /** Optical centring for the play triangle, e.g. "ml-0.5". */
  playOffset?: string;
}

const IN = { duration: 0.16, ease: [0.22, 1, 0.36, 1] as const };
const OUT = { duration: 0.1, ease: "easeIn" as const };

export function PlayPauseIcon({ busy, playing, className = "h-4 w-4", filled = false, playOffset = "ml-0.5" }: Props) {
  const state = busy ? "busy" : playing ? "pause" : "play";
  const fill = filled ? "currentColor" : undefined;
  return (
    <span className="grid place-items-center" aria-hidden="true">
      <AnimatePresence initial={false}>
        <motion.span
          key={state}
          style={{ gridArea: "1 / 1" }}
          className="flex items-center justify-center"
          initial={{ opacity: 0, scale: 0.55 }}
          animate={{ opacity: 1, scale: 1, transition: IN }}
          exit={{ opacity: 0, scale: 0.55, transition: OUT }}
        >
          {state === "busy" ? (
            <Loader2 className={cn(className, "animate-spin")} />
          ) : state === "pause" ? (
            <Pause className={className} fill={fill} />
          ) : (
            <Play className={cn(className, playOffset)} fill={fill} />
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export default PlayPauseIcon;
