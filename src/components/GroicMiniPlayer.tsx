import { DiagnosticsLink } from "@/components/music/MusicDiagnostics";
import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronUp, X, Minus, Users } from "lucide-react";
import { PlayPauseIcon } from "@/components/music/PlayPauseIcon";
import { SkipButton } from "@/components/music/SkipButton";
import { useGroic, useGroicProgress } from "@/contexts/GroicContext";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { fallbackArt } from "@/lib/music/fallbackArt";
import { SPRING_SHEET, SPRING_POP, COVER_FADE, CONTENT_FADE } from "@/lib/music/motionTokens";
import { onArtError } from "@/lib/music/artOnError";
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
/** Hairline progress along the bottom edge of the bar (Spotify-style). Its own
 *  component so the twice-a-second position tick re-renders only this sliver,
 *  never the whole mini player. */
const MiniProgress = () => {
  const { position, duration } = useGroicProgress();
  const pct = duration > 0 ? Math.min(100, Math.max(0, (position / duration) * 100)) : 0;
  return (
    <div aria-hidden="true" className="absolute left-3 right-3 bottom-0 h-[2px] rounded-full bg-foreground/10 overflow-hidden">
      <div className="h-full bg-primary" style={{ width: `${pct}%` }} />
    </div>
  );
};

const GroicMiniPlayer = () => {
  const { current, isPlaying, hidden, toggle, retry, next, expand, hide, show, close, sessionRole, partnerListening, loading, buffering, error } = useGroic();
  const { nodeRef, dragHandlers } = useDraggableMiniPlayer<HTMLDivElement>();
  // Swipe UP on the bar opens the full player — the mirror of pulling the full
  // player down to minimise it (the standard now-playing-sheet pair). A tap
  // still opens it too; this only adds the gesture, passive listeners only.
  const swipeRef = useRef<{ x: number; y: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // The bar follows the finger a little while swiping up (rubber-banded, max ~24px) so the gesture
  // answers immediately; on release it either hands over to the full player or glides back.
  const resetBar = (animated: boolean) => {
    const el = barRef.current;
    if (!el) return;
    el.style.transition = animated ? "transform 240ms cubic-bezier(0.22, 1, 0.36, 1)" : "none";
    el.style.transform = "";
  };
  const onBarTouchStart = (e: React.TouchEvent) => {
    swipeRef.current = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  };
  const onBarTouchMove = (e: React.TouchEvent) => {
    const s0 = swipeRef.current;
    const el = barRef.current;
    if (!s0 || !el || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - s0.y;
    const dx = e.touches[0].clientX - s0.x;
    if (dy < -6 && Math.abs(dx) < Math.abs(dy) * 0.8) {
      el.style.transition = "none";
      el.style.transform = `translateY(${Math.max(dy * 0.5, -24)}px)`;
    } else if (el.style.transform) {
      el.style.transform = "";
    }
  };
  const onBarTouchEnd = (e: React.TouchEvent) => {
    const s0 = swipeRef.current;
    swipeRef.current = null;
    if (!s0 || e.changedTouches.length !== 1) { resetBar(true); return; }
    const dy = e.changedTouches[0].clientY - s0.y;
    const dx = e.changedTouches[0].clientX - s0.x;
    if (dy < -28 && Math.abs(dx) < Math.abs(dy) * 0.8) {
      // Snap back instantly: the full player measures this bar's thumbnail to grow out of it, so the
      // bar must already be at rest when it does.
      resetBar(false);
      hapticLight(); expand(true);
    } else {
      resetBar(true);
    }
  };
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
  // UI: a spinner that never ends is the worst state. After 8 s of continuous "busy" the subtitle turns
  // into an explicit, tappable "Taking longer than usual · Retry" so the person is never stuck waiting.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!isBusy) { setSlow(false); return; }
    const t = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(t);
  }, [isBusy, current?.id]);

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
          transition={SPRING_POP}
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
              {current ? (
                <img
                  src={current.thumbnail || fallbackArt(current.title, current.artist)} onError={onArtError(current.title, current.artist)}
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
          // Quick, eased exit (close / minimise-to-icon): the old spring exit kept the bar on screen
          // for ~400ms and visibly overlapped the corner icon popping in.
          exit={{ y: 36, opacity: 0, scale: 0.96, transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }}
          transition={SPRING_SHEET}
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
            ref={barRef}
            data-groic-mini-bar
            onClick={() => { hapticLight(); expand(true); }}
            onTouchStart={onBarTouchStart}
            onTouchMove={onBarTouchMove}
            onTouchEnd={onBarTouchEnd}
            onTouchCancel={() => { swipeRef.current = null; resetBar(true); }}
            // A group, not a button: the bar holds real buttons (play, next, minimize, close, retry), and a
            // button inside role="button" is invalid/announced oddly. Tapping the bar still expands for pointer
            // users; keyboard + screen-reader users get the explicit "Open full player" button at the end.
            role="group"
            aria-label={`Music player, ${current.title} by ${current.artist}`}
            className={cn(
              "pointer-events-auto select-none",
              "relative flex items-center gap-2 p-2 pr-2.5 rounded-[22px] glass-player shadow-[0_14px_34px_-14px_hsl(var(--foreground)/0.5)] ring-1 ring-foreground/10",
            )}
          >
            <MiniProgress />
            <div data-groic-mini-thumb className="relative h-11 w-11 rounded-[14px] shadow-md ring-1 ring-foreground/10 overflow-hidden bg-muted shrink-0">
              {current && (
                <AnimatePresence initial={false}>
                  <motion.img key={current.thumbnail || current.id} decoding="async" src={current.thumbnail || fallbackArt(current.title, current.artist)} onError={onArtError(current.title, current.artist)} alt=""
                    initial={{ opacity: 0, scale: 1.08 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}
                    transition={COVER_FADE}
                    className="absolute inset-0 h-full w-full object-cover" />
                </AnimatePresence>
              )}
              <AnimatePresence initial={false}>
              {isPlaying && (
                <motion.div key="eq" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
                  className="absolute inset-0 bg-foreground/15 flex items-end justify-center gap-0.5 pb-1">
                  {/* PERF: was animating `height` (a layout property) on an
                      Infinity-repeat loop — every frame forced a reflow of
                      this subtree for as long as the mini-player was
                      mounted and playing. `scaleY` is a transform: it's
                      GPU-composited and never touches layout. Fixed height +
                      bottom transform-origin keeps the "growing from the
                      baseline" look the % heights were going for. */}
                  {[0.5, 0.7, 0.4].map((d, i) => (
                    <motion.div key={i} className="w-[2px] h-2.5 bg-background rounded-full origin-bottom"
                      animate={{ scaleY: [0.25, 1, 0.4] }}
                      transition={{ repeat: Infinity, duration: d, delay: i * 0.1 }} />
                  ))}
                </motion.div>
              )}
              </AnimatePresence>
            </div>
            <motion.div key={current.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={CONTENT_FADE} className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">{current.title}</p>
              <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1">
                {sessionRole !== "solo" && (
                  <span className="inline-flex items-center gap-0.5 text-primary">
                    <Users className="h-2.5 w-2.5" /> {partnerListening ? "Together" : sessionRole}
                  </span>
                )}
                {slow ? (
                  <>
                  <button
                    onClick={(e) => { e.stopPropagation(); hapticLight(); retry(); setSlow(false); }}
                    className="truncate text-primary font-medium underline-offset-2 active:underline"
                  >
                    Taking longer than usual · Tap to retry
                  </button>
                  <DiagnosticsLink />
                  </>
                ) : isBusy ? (
                  <span className="truncate">Loading…</span>
                ) : error ? (
                  <button
                    onClick={(e) => { e.stopPropagation(); hapticLight(); retry(); }}
                    className="truncate text-destructive font-medium underline-offset-2 active:underline"
                  >
                    Couldn't play this one · Tap to retry
                  </button>
                ) : (
                  <span className="truncate">{current.artist}{current.twinOfId ? " · Background version" : ""}</span>
                )}
              </p>
            </motion.div>
            <button
              onClick={(e) => { e.stopPropagation(); hapticLight(); toggle(); }}
              aria-label={isBusy ? "Loading" : isPlaying ? "Pause" : "Play"}
              aria-busy={isBusy}
              className="h-11 w-11 rounded-full bg-primary text-primary-foreground flex items-center justify-center active:scale-90 transition-transform shrink-0"
            >
              <PlayPauseIcon busy={isBusy} playing={isPlaying} className="h-4 w-4" playOffset="ml-0.5" />
            </button>
            <SkipButton
              dir="next" label="Next" stopClick iconClassName="h-4 w-4"
              onSkip={() => { hapticLight(); next(); }}
              className="h-11 w-11 rounded-full text-muted-foreground active:scale-90 transition-transform shrink-0 flex items-center justify-center"
            />
            <div className="w-px self-stretch bg-border/60 mx-0.5" />
            <button
              onClick={(e) => { e.stopPropagation(); hapticLight(); hide(); }}
              aria-label="Minimize to a small draggable icon (keeps playing)"
              className="h-11 w-11 rounded-full text-muted-foreground active:scale-90 transition-transform shrink-0 flex items-center justify-center"
            >
              <Minus className="h-4 w-4" />
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); hapticMedium(); close(); }}
              aria-label="Close player"
              className="h-11 w-11 rounded-full text-muted-foreground active:scale-90 transition-transform shrink-0 flex items-center justify-center"
            >
              <X className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); hapticLight(); expand(true); }}
              aria-label="Open full player"
              className="h-11 w-11 rounded-full text-muted-foreground active:scale-90 transition-transform shrink-0 flex items-center justify-center"
            >
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            </button>
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
