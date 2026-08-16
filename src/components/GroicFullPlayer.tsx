import { motion, AnimatePresence } from "framer-motion";
import {
  Play, Pause, SkipBack, SkipForward, ChevronDown, Users, UserMinus, Trash2, X,
} from "lucide-react";
import { useGroic } from "@/contexts/GroicContext";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { useToast } from "@/hooks/use-toast";

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

const GroicFullPlayer = () => {
  const {
    current, queue, isPlaying, position, duration, expanded,
    toggle, next, prev, seek, removeFromQueue, expand, playTrack, close,
    sessionRole, partnerListening, startSession, endSession,
  } = useGroic();
  const { toast } = useToast();

  if (!current) return null;

  return (
    <AnimatePresence>
      {expanded && (
        <motion.div
          key="groic-full"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", stiffness: 320, damping: 36 }}
          drag="y"
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={0.2}
          onDragEnd={(_, info) => { if (info.offset.y > 120) expand(false); }}
          className="fixed inset-0 z-[60] flex flex-col"
          style={{
            background: current.thumbnail
              ? `linear-gradient(180deg, hsl(var(--background)/0.6), hsl(var(--background))), url(${current.thumbnail}) center/cover`
              : "hsl(var(--background))",
          }}
        >
          {/* Glass overlay so blur reads as premium */}
          <div className="absolute inset-0 backdrop-blur-3xl bg-background/40" />

          <div className="relative flex flex-col h-full safe-top px-6 pb-10">
            {/* Header */}
            <div className="flex items-center justify-between pt-3 pb-6">
              <button onClick={() => { hapticLight(); expand(false); }}
                className="h-9 w-9 rounded-full bg-foreground/10 backdrop-blur-md flex items-center justify-center active:scale-95"
                aria-label="Minimize player">
                <ChevronDown className="h-5 w-5" />
              </button>
              <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                {sessionRole === "host" ? "Hosting" : sessionRole === "guest" ? "Listening together" : "Now Playing"}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    hapticMedium();
                    if (sessionRole === "solo") { await startSession(); toast({ title: "Session started 🎶" }); }
                    else { await endSession(); toast({ title: "Session ended" }); }
                  }}
                  className="h-9 w-9 rounded-full bg-foreground/10 backdrop-blur-md flex items-center justify-center active:scale-95"
                  aria-label={sessionRole === "solo" ? "Start shared session" : "End shared session"}
                >
                  {sessionRole === "solo" ? <Users className="h-4 w-4" /> : <UserMinus className="h-4 w-4 text-primary" />}
                </button>
                {/* FIX: the full player had no way to actually stop playback
                    either — ChevronDown only ever minimized to the mini bar. */}
                <button
                  onClick={() => { hapticMedium(); close(); }}
                  className="h-9 w-9 rounded-full bg-foreground/10 backdrop-blur-md flex items-center justify-center active:scale-95"
                  aria-label="Close player"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Artwork.
                FIX: this was a bare flex-1 with only a max-width cap, so on
                shorter screens the aspect-square box (sized off available
                width) could grow taller than the space actually left for it
                once the queue list below needed real room — capped its
                height too so the queue never gets squeezed out. */}
            <div className="flex-1 min-h-0 flex items-center justify-center">
              <motion.div
                animate={{ scale: isPlaying ? 1 : 0.9 }}
                transition={{ type: "spring", stiffness: 200, damping: 22 }}
                className="aspect-square w-full max-w-[280px] max-h-[38vh] rounded-3xl overflow-hidden shadow-[0_30px_80px_-20px_rgba(0,0,0,0.5)] bg-muted"
              >
                {current.thumbnail
                  ? <img src={current.thumbnail} alt={current.title} className="h-full w-full object-cover" />
                  : <div className="h-full w-full bg-gradient-to-br from-primary/40 to-accent" />}
              </motion.div>
            </div>

            {/* Title */}
            <div className="text-center my-4">
              <p className="text-xl font-semibold truncate">{current.title}</p>
              <p className="text-sm text-muted-foreground truncate">{current.artist}</p>
              {sessionRole !== "solo" && (
                <p className="text-[10px] mt-1 text-primary">
                  {partnerListening ? "● Partner connected" : "○ Waiting for partner"}
                </p>
              )}
            </div>

            {/* Progress */}
            <div className="space-y-1">
              <input
                type="range" min={0} max={Math.max(duration, 1)} step={1} value={position}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="Seek"
                className="w-full accent-foreground h-1"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
                <span>{fmt(position)}</span>
                <span>-{fmt(Math.max(duration - position, 0))}</span>
              </div>
            </div>

            {/* Controls */}
            <div className="flex items-center justify-center gap-6 mt-4">
              <button onClick={() => { hapticLight(); prev(); }}
                className="h-12 w-12 rounded-full bg-foreground/10 backdrop-blur-md flex items-center justify-center active:scale-90"
                aria-label="Previous">
                <SkipBack className="h-5 w-5" />
              </button>
              <button onClick={() => { hapticMedium(); toggle(); }}
                className="h-16 w-16 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-xl active:scale-95"
                aria-label={isPlaying ? "Pause" : "Play"}>
                {isPlaying ? <Pause className="h-7 w-7" /> : <Play className="h-7 w-7 ml-1" />}
              </button>
              <button onClick={() => { hapticLight(); next(); }}
                className="h-12 w-12 rounded-full bg-foreground/10 backdrop-blur-md flex items-center justify-center active:scale-90"
                aria-label="Next">
                <SkipForward className="h-5 w-5" />
              </button>
            </div>

            {/* Queue.
                FIX: this was capped at max-h-40 (160px) with 28px thumbnails
                and 10-12px text — on anything but a tall screen it showed
                maybe one and a half rows, so "up next" was effectively
                invisible. Bigger row height/thumbnails, more vertical room,
                and the artwork above is now capped so it can't crowd this
                out on shorter screens. */}
            {queue.length > 1 && (
              <div className="mt-4 max-h-64 overflow-y-auto rounded-2xl bg-card/60 backdrop-blur-md border border-border/60 p-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground px-2 pb-1 sticky top-0 bg-card/60 backdrop-blur-md">Up next</p>
                {queue.filter(t => t.id !== current.id).map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-2 py-2 rounded-xl active:bg-foreground/5"
                    onClick={() => playTrack(t)}>
                    <img src={t.thumbnail || ""} alt="" className="h-11 w-11 rounded-lg object-cover bg-muted shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm truncate">{t.title}</p>
                      <p className="text-xs text-muted-foreground truncate">{t.artist}</p>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); removeFromQueue(t.id); }}
                      className="text-muted-foreground active:scale-90 p-1.5 shrink-0" aria-label="Remove">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default GroicFullPlayer;
