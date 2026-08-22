import { motion, AnimatePresence } from "framer-motion";
import { Play, Pause, SkipForward, ChevronUp, X, Minus, Users, Music2 } from "lucide-react";
import { useGroic } from "@/contexts/GroicContext";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/**
 * GroicMiniPlayer — sits just above the FloatingDock.
 * Tap the bar to expand into the full player.
 *
 * FIX: previously had no close button at all (the `X` icon was imported and
 * never used) and no way to keep music playing while getting the bar out of
 * the way — the only "hide" was letting the queue run out. Now has both:
 *  - X  → close(): stops playback and dismisses the player entirely.
 *  - −  → hide(): keeps playing in the background, bar tucks away into a
 *    small restore tab (below) so it's never actually lost.
 */
const GroicMiniPlayer = () => {
  const { current, isPlaying, hidden, toggle, next, expand, hide, show, close, sessionRole, partnerListening } = useGroic();

  return (
    <AnimatePresence>
      {current && hidden && (
        <motion.button
          key="groic-hidden-tab"
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.6, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 28 }}
          onClick={() => { hapticLight(); show(); }}
          aria-label="Show music player"
          className={cn(
            "fixed right-3 z-40 h-11 w-11 rounded-full",
            "bg-card/90 backdrop-blur-2xl border border-border/60",
            "shadow-[0_10px_30px_-12px_hsl(var(--foreground)/0.4)]",
            "flex items-center justify-center active:scale-90 transition-transform",
          )}
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 78px)" }}
        >
          <Music2 className="h-4 w-4 text-primary" />
          {isPlaying && (
            <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-primary animate-pulse" />
          )}
        </motion.button>
      )}
      {current && !hidden && (
        <motion.div
          key="groic-mini"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: "spring", stiffness: 360, damping: 32 }}
          className="fixed left-3 right-3 z-40 pointer-events-none"
          style={{ bottom: "calc(env(safe-area-inset-bottom, 0px) + 78px)" }}
        >
          <div
            onClick={() => { hapticLight(); expand(true); }}
            className={cn(
              "pointer-events-auto cursor-pointer",
              "flex items-center gap-2 p-2 pr-2.5 rounded-2xl",
              "bg-card/80 backdrop-blur-2xl border border-border/60",
              "shadow-[0_10px_40px_-15px_hsl(var(--foreground)/0.35)]",
            )}
          >
            <div className="relative h-10 w-10 rounded-xl overflow-hidden bg-muted shrink-0">
              {current.thumbnail && (
                <img src={current.thumbnail} alt="" className="h-full w-full object-cover" />
              )}
              {isPlaying && (
                <div className="absolute inset-0 bg-foreground/15 flex items-end justify-center gap-0.5 pb-1">
                  {[0.5, 0.7, 0.4].map((d, i) => (
                    <motion.div key={i} className="w-[2px] bg-background rounded-full"
                      animate={{ height: ["20%", "80%", "30%"] }}
                      transition={{ repeat: Infinity, duration: d, delay: i * 0.1 }} />
                  ))}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">{current.title}</p>
              <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
                {sessionRole !== "solo" && (
                  <span className="inline-flex items-center gap-0.5 text-primary">
                    <Users className="h-2.5 w-2.5" /> {partnerListening ? "Together" : sessionRole}
                  </span>
                )}
                <span className="truncate">{current.artist}</span>
              </p>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); hapticLight(); toggle(); }}
              aria-label={isPlaying ? "Pause" : "Play"}
              className="h-9 w-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center active:scale-90 transition-transform shrink-0"
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); hapticLight(); next(); }}
              aria-label="Next"
              className="h-8 w-8 rounded-full text-muted-foreground active:scale-90 shrink-0"
            >
              <SkipForward className="h-4 w-4" />
            </button>
            <div className="w-px self-stretch bg-border/60 mx-0.5" />
            <button
              onClick={(e) => { e.stopPropagation(); hapticLight(); hide(); }}
              aria-label="Hide player (keeps playing)"
              className="h-8 w-8 rounded-full text-muted-foreground active:scale-90 shrink-0 flex items-center justify-center"
            >
              <Minus className="h-4 w-4" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); hapticMedium(); close(); }}
              aria-label="Close player"
              className="h-8 w-8 rounded-full text-muted-foreground active:scale-90 shrink-0 flex items-center justify-center"
            >
              <X className="h-4 w-4" />
            </button>
            <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default GroicMiniPlayer;
