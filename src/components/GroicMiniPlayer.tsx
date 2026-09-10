import { motion, AnimatePresence } from "framer-motion";
import { Play, Pause, SkipForward, ChevronUp, X, Minus, Users, Loader2 } from "lucide-react";
import { useGroic } from "@/contexts/GroicContext";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { useDraggableMiniPlayer } from "@/hooks/useDraggableMiniPlayer";
import { useBottomSurfaceHeight } from "@/contexts/BottomSurfaceContext";

/**
 * GroicMiniPlayer — TWO deliberately different UI states (Phase: Global Glass):
 *
 * STATE A — FULL MINI PLAYER (`!hidden`): a FIXED bar docked above the
 * FloatingDock / composer layer. It is NOT draggable and never was meant to
 * be — dragging the primary transport surface made it feel unstable and let
 * it wander over interactive content. It stays in its designated layout
 * position, shows artwork/title/artist/play-pause/next, and expands into the
 * full player on tap.
 *
 * STATE B — COMPLETELY MINIMIZED ICON (`hidden`): when the user minimizes
 * playback "into the corner", the full bar disappears entirely and a compact
 * floating glass icon appears instead. THIS is the draggable element — it can
 * be moved anywhere within the usable viewport (safe areas, dock clearance,
 * keyboard-aware bottom bound; see useDraggableMiniPlayer), follows the
 * finger frame-synchronously via transform+rAF (no React re-render per
 * frame), keeps its position on release, and snaps horizontally to the
 * nearer edge.
 *
 * The previous build had this exactly backwards: the full BAR carried the
 * drag handlers while the minimized icon was bolted to one fixed coordinate.
 */
const GroicMiniPlayer = () => {
  const { current, isPlaying, hidden, toggle, next, expand, hide, show, close, sessionRole, partnerListening, loading, buffering } = useGroic();
  const { nodeRef, dragHandlers } = useDraggableMiniPlayer<HTMLDivElement>();
  // FIX (mini player hidden behind chat composer): on /chat and /calls the
  // old FloatingDock is replaced by DuoSpaceBottomSurface, whose real height
  // varies a lot (multiline composer growth, attach tray, recording UI) —
  // the previous hardcoded 78px clearance assumed the old fixed-height dock
  // and was routinely shorter than the actual shell, so the bar sat UNDER
  // it. surfaceHeight is 0 on every page that isn't wrapped by that shell,
  // so this falls back to the original 78px (FloatingDock) there.
  const surfaceHeight = useBottomSurfaceHeight();
  const bottomClearance = surfaceHeight > 0 ? surfaceHeight + 10 : 78;
  // AUDIT FIX (Phase 7, Music): `loading` (resolving a stream URL) and
  // `buffering` (native engine reports it's stalled waiting on data) were
  // both already tracked in GroicContext but never surfaced anywhere in
  // either player — the play button just sat there mid-toggle-state with
  // no feedback, so tapping a new track gave no sign anything was
  // happening until audio actually started (or, on a slow connection,
  // silence that looked identical to "nothing is loading" and invited a
  // double-tap). Also guards toggle() itself: calling play/pause on a
  // track whose stream URL hasn't resolved yet has nothing to act on.
  const isBusy = loading || buffering;

  return (
    <AnimatePresence>
      {/* ── STATE B: completely minimized, draggable music icon ─────────── */}
      {current && hidden && (
        <motion.div
          key="groic-hidden-icon"
          // Entry/exit animation lives on this WRAPPER so its framer-motion
          // transform never fights the drag hook's direct translate3d writes
          // on the inner node below (two writers on one element's transform
          // would visibly snap during the animation).
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.6, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 28 }}
          className="fixed left-3 right-3 z-[45] pointer-events-none"
          style={{ top: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
        >
          <div className="flex justify-end">
            <div
              ref={nodeRef}
              {...dragHandlers}
              onClick={() => { hapticLight(); show(); }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hapticLight(); show(); } }}
              aria-label={`Music playing in background: ${current.title} by ${current.artist}. Tap to restore the player, or drag to move.`}
              // NOTE: deliberately NO .press class here — its CSS transform
              // transition would smooth/lag the drag hook's per-frame
              // translate3d writes, making the icon trail the finger.
              className={cn(
                "pointer-events-auto select-none cursor-grab active:cursor-grabbing",
                "relative h-14 w-14 rounded-full glass-dock",
                "flex items-center justify-center",
              )}
            >
              {/* Artwork fills the glass circle; glyph shows through when none */}
              {current.thumbnail ? (
                <img
                  src={current.thumbnail}
                  alt=""
                  className="absolute inset-1.5 h-[calc(100%-12px)] w-[calc(100%-12px)] rounded-full object-cover opacity-90"
                  draggable={false}
                  loading="lazy" decoding="async"
                />
              ) : null}
              <span className={cn("relative z-10", current.thumbnail && "drop-shadow-md")}>
                <MusicGlyph />
              </span>
              {/* Small playing indicator — a breathing accent dot on the rim */}
              {isPlaying && (
                <span
                  aria-hidden="true"
                  className="absolute -top-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-primary ring-2 ring-background animate-pulse"
                />
              )}
            </div>
          </div>
        </motion.div>
      )}
      {/* ── STATE A: full mini player — FIXED, not draggable ──────────────── */}
      {current && !hidden && (
        <motion.div
          key="groic-mini"
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: "spring", stiffness: 360, damping: 32 }}
          // FIX: was z-40, the SAME z-index as DuoSpaceBottomSurface — with
          // equal z-index, the element later in AppLayout's DOM (the
          // composer/dock shell) always wins the paint order, so the mini
          // player rendered underneath it regardless of the bottom offset
          // below. Raised above that shell (z-[45] vs its z-40) so it's
          // reliably visible on top on /chat and /calls too.
          className="fixed left-3 right-3 z-[45] pointer-events-none"
          style={{ bottom: `calc(env(safe-area-inset-bottom, 0px) + ${bottomClearance}px)` }}
        >
          <div
            onClick={() => { hapticLight(); expand(true); }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); hapticLight(); expand(true); } }}
            aria-label={`Music player, ${current.title} by ${current.artist}. Tap to open full player.`}
            className={cn(
              "pointer-events-auto select-none",
              "flex items-center gap-2 p-2 pr-2.5 rounded-2xl glass-player",
            )}
          >
            <div className="relative h-10 w-10 rounded-xl overflow-hidden bg-muted shrink-0">
              {current.thumbnail && (
                <img loading="lazy" decoding="async" src={current.thumbnail} alt="" className="h-full w-full object-cover" />
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
              onClick={(e) => { e.stopPropagation(); if (isBusy) return; hapticLight(); toggle(); }}
              aria-label={isBusy ? "Loading" : isPlaying ? "Pause" : "Play"}
              aria-busy={isBusy}
              className="h-11 w-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center active:scale-90 transition-transform shrink-0"
            >
              {isBusy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4 ml-0.5" />
              )}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); hapticLight(); next(); }}
              aria-label="Next"
              className="h-11 w-11 rounded-full text-muted-foreground active:scale-90 shrink-0 flex items-center justify-center"
            >
              <SkipForward className="h-4 w-4" />
            </button>
            <div className="w-px self-stretch bg-border/60 mx-0.5" />
            <button
              onClick={(e) => { e.stopPropagation(); hapticLight(); hide(); }}
              aria-label="Minimize to a small draggable icon (keeps playing)"
              className="h-11 w-11 rounded-full text-muted-foreground active:scale-90 shrink-0 flex items-center justify-center"
            >
              <Minus className="h-4 w-4" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); hapticMedium(); close(); }}
              aria-label="Close player"
              className="h-11 w-11 rounded-full text-muted-foreground active:scale-90 shrink-0 flex items-center justify-center"
            >
              <X className="h-4 w-4" />
            </button>
            <ChevronUp className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

/* Music glyph for the minimized icon — kept as a tiny local component so the
   JSX above reads as state, not icon plumbing. */
function MusicGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 text-primary" fill="none"
      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}

export default GroicMiniPlayer;
