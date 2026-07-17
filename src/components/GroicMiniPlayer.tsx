import { motion, AnimatePresence } from "framer-motion";
import { Play, Pause, SkipForward, ChevronUp, X, Users } from "lucide-react";
import { useGroic } from "@/contexts/GroicContext";
import { hapticLight } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/**
 * GroicMiniPlayer — sits just above the FloatingDock.
 * Tap to expand into the full player.
 */
const GroicMiniPlayer = () => {
  const { current, isPlaying, toggle, next, expand, sessionRole, partnerListening } = useGroic();

  return (
    <AnimatePresence>
      {current && (
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
              "flex items-center gap-3 p-2 pr-3 rounded-2xl",
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
              className="h-9 w-9 rounded-full bg-foreground text-background flex items-center justify-center active:scale-90 transition-transform"
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); hapticLight(); next(); }}
              aria-label="Next"
              className="h-8 w-8 rounded-full text-muted-foreground active:scale-90"
            >
              <SkipForward className="h-4 w-4" />
            </button>
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default GroicMiniPlayer;
