import { motion, AnimatePresence, useMotionValue, animate as animateValue } from "framer-motion";
import {
  Play, Pause, SkipBack, SkipForward, ChevronDown, ChevronUp, Users, UserMinus, Trash2, X,
  Shuffle, Repeat, Repeat1, Download, CheckCircle2, Loader2, Youtube, ListMusic,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useGroic } from "@/contexts/GroicContext";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { canDownload, isDownloaded as isTrackDownloaded, downloadTrack, removeDownload } from "@/lib/music/offlineDownloads";

const fmt = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

/**
 * Provider indication (Phase: Music Player redesign) — a quiet provenance
 * chip rather than branding everywhere: which engine is actually producing
 * the sound matters to this couple (Audius = background/lock-screen capable;
 * YouTube = IFrame), so it's stated once, where the eye already is.
 */
function ProviderChip({ provider }: { provider: string }) {
  const label =
    provider === "youtube" ? "YouTube"
    : provider === "audius" ? "Audius"
    : provider === "soundcloud" ? "SoundCloud"
    : "Offline copy";
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-foreground/[0.06] border border-border/50 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
      role="note"
      aria-label={`Playing from ${label}`}
    >
      {provider === "youtube" && <Youtube className="h-2.5 w-2.5" aria-hidden="true" />}
      {provider !== "youtube" && (
        <span aria-hidden="true" className={cn(
          "h-1.5 w-1.5 rounded-full",
          provider === "audius" ? "bg-[#ff8800]"
          : provider === "soundcloud" ? "bg-[#ff5500]" // SoundCloud's own brand orange — distinct from Audius's so the two are visually distinguishable, not just by label
          : "bg-success",
        )} />
      )}
      {label}
    </span>
  );
}

/**
 * AmbientBackground — the artwork's own colours, heavily blurred, sitting
 * low-opacity behind the glass surfaces (spec section 8). Deliberately NOT a
 * canvas pixel-sampling palette extractor: most artwork here comes from
 * third-party hosts (YouTube thumbnails, Audius, SoundCloud) that don't send
 * Access-Control-Allow-Origin, so reading pixel data would throw a
 * SecurityError on a tainted canvas for a large fraction of tracks. A
 * blurred copy of the artwork itself is what a palette+wash would produce
 * visually anyway (blur IS a cheap dominant-colour average), and it's pure
 * CSS — GPU-composited, nothing computed on the JS thread per render, so it
 * costs nothing extra per the performance requirements.
 * Crossfades between the previous and next track's art on change instead of
 * cutting abruptly; two-layer AnimatePresence rather than animating a single
 * layer's background-image (which can't be animated smoothly by the
 * browser).
 */
function AmbientBackground({ thumbnail }: { thumbnail: string | null | undefined }) {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden pointer-events-none">
      <AnimatePresence>
        {thumbnail && (
          <motion.div
            key={thumbnail}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeInOut" }}
            className="absolute inset-0"
          >
            <div
              className="absolute inset-[-10%] bg-center bg-cover opacity-[0.32] dark:opacity-[0.28] scale-110"
              style={{ backgroundImage: `url(${thumbnail})`, filter: "blur(60px) saturate(1.4)" }}
            />
          </motion.div>
        )}
      </AnimatePresence>
      {/* Keeps the wash from ever reading brighter than the crisp artwork
          on top of it, and guarantees contrast even before the blur layer
          above finishes loading/crossfading in. */}
      <div className="absolute inset-0 bg-background/55" />
    </div>
  );
}

const GroicFullPlayer = () => {
  const {
    current, queue, isPlaying, position, duration, expanded,
    toggle, next, prev, seek, removeFromQueue, expand, playTrack, close,
    sessionRole, partnerListening, startSession, endSession,
    repeatMode, shuffle, setRepeatMode, toggleShuffle, error, loading, buffering,
  } = useGroic();
  const { toast } = useToast();
  // AUDIT FIX (Phase 7, Music) — see GroicMiniPlayer.tsx's matching comment:
  // `loading`/`buffering` existed in GroicContext but were never shown here
  // either, so the big center play button gave no feedback while a track
  // was still resolving.
  const isBusy = loading || buffering;

  // Offline download state for the current track. Re-checked whenever the
  // current track changes (a fresh `downloaded` read, `progress` reset)
  // rather than once — this component doesn't unmount between tracks.
  const [downloaded, setDownloaded] = useState(false);
  const [progress, setProgress] = useState<number | null | "idle">("idle");

  useEffect(() => {
    if (!current) return;
    setDownloaded(isTrackDownloaded(current.id));
    setProgress("idle");
  }, [current?.id]);

  const handleDownloadToggle = async () => {
    if (!current) return;
    if (downloaded) {
      hapticLight();
      await removeDownload(current.id);
      setDownloaded(false);
      toast({ title: "Download removed" });
      return;
    }
    hapticMedium();
    setProgress(null); // indeterminate until the first progress callback, if any
    try {
      await downloadTrack(current, (fraction) => setProgress(fraction));
      setDownloaded(true);
      setProgress("idle");
      toast({ title: "Downloaded for offline playback 🎵" });
    } catch (e) {
      setProgress("idle");
      toast({
        title: "Couldn't download this track",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const downloadEligible = current ? downloaded || canDownload(current) : false;

  // Progress-interaction state: while dragging we show the DRAGGED time and
  // freeze the fill at the dragged value so the thumb never fights the
  // engine's own position updates mid-gesture (committed on release/change).
  // FIX (laggy pull-down-to-minimize gesture): a full-screen backdrop-blur
  // layer recomposites every frame the sheet is translated, which is a
  // known heavy cost on Android WebViews (this app's target). Dropping to a
  // much cheaper blur tier for the duration of the drag — restored the
  // instant it ends — keeps the gesture tracking the finger smoothly
  // without visibly changing how the resting player looks.
  const [isDragging, setIsDragging] = useState(false);

  // FIX (scrolling reads as laggy/flickering, and pull-to-minimize only
  // half-worked): this whole page used to be a single element that was
  // BOTH `overflow-y-auto` (native scroll) AND a Framer `drag="y"` target
  // (the pull-to-dismiss gesture) at the same time, gated on `atTop`.
  // Framer's `drag` claims the touch stream for its whole gesture the
  // instant it starts (it has to decide up front, before direction is
  // known, since that's when touch-action gets fixed) — so from the very
  // top of the page, EVERY vertical touch, including a normal swipe-up to
  // scroll down into the queue, got captured as an elastic drag against
  // dragConstraints of {top:0, bottom:0}. It could only ever rubber-band
  // and snap back — never actually hand off to native scrolling — which is
  // exactly what read as "laggy, flickering" scrolling, and also meant the
  // only way to reliably pull-to-minimize was from a dead stop exactly at
  // the top.
  // Replaced with a small manual gesture (same idea as the Vanish Mode
  // pull handle): native browser scrolling is left completely alone
  // (`touchAction: pan-y`, nothing intercepted) until a touch is BOTH at
  // scrollTop 0 AND moving downward past a tiny slop — only then do we
  // take over for that one gesture and drive the sheet's translateY
  // ourselves via a motion value (imperative — no React re-render per
  // frame, so it stays smooth even mid-scroll). Anything else — scrolling
  // up into the queue, or any touch that isn't at the very top — is never
  // touched, so native scroll momentum/inertia works exactly as it would
  // on a plain page.
  const scrollRef = useRef<HTMLDivElement>(null);
  const sheetY = useMotionValue(0);
  const DISMISS_PULL_PX = 120;   // real finger travel (post-slop) that commits a minimize
  const PULL_ENGAGE_PX  = 8;     // filters accidental taps/jitter before we take over the gesture
  const PULL_VISUAL_RATE = 0.5;  // how much of the finger's motion the sheet visually follows (elastic feel)
  const PULL_VISUAL_CAP  = 160;  // px — keeps overshoot from ever looking unbounded

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    let startY = 0;
    let engaged = false;   // this gesture has been claimed for pull-to-minimize
    let rawPull = 0;       // real (unscaled) finger travel since engaging — what the threshold checks against

    const settle = () => animateValue(sheetY, 0, { type: "spring", stiffness: 420, damping: 38 });

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      engaged = false;
      rawPull = 0;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - startY;
      if (!engaged) {
        // Only claim the gesture once we're already at the top AND the
        // person is clearly pulling down, not scrolling up into content —
        // everything else is left untouched for native scroll to handle.
        if (el.scrollTop > 0 || dy <= PULL_ENGAGE_PX) return;
        engaged = true;
        setIsDragging(true);
        hapticLight();
      }
      // preventDefault only fires once we've committed to the minimize
      // gesture — up to that point native scrolling was never blocked.
      e.preventDefault();
      rawPull = dy - PULL_ENGAGE_PX;
      sheetY.set(Math.min(rawPull * PULL_VISUAL_RATE, PULL_VISUAL_CAP));
    };

    const onTouchEnd = () => {
      if (!engaged) return;
      engaged = false;
      setIsDragging(false);
      if (rawPull > DISMISS_PULL_PX) {
        hapticMedium();
        expand(false);
      }
      settle();
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [expand, sheetY]);
  // FIX (laggy maximize/minimize via TAP, not just the manual pull): the
  // isDragging optimization above only ever fired for a finger actively
  // dragging the sheet — tapping the mini-player to open, or tapping the
  // chevron/back to close, drives the exact same full-screen
  // backdrop-blur-3xl through its entrance/exit spring animation and paid
  // the full recompositing cost every frame of it. Tapping is the more
  // common path (most people don't drag-to-dismiss), so this was the
  // bigger real-world source of the reported lag. Tracks the whole
  // enter/exit animation via framer-motion's own start/complete
  // callbacks and applies the same cheap blur tier for its duration.
  const [isAnimating, setIsAnimating] = useState(true);
  const cheapBlur = isDragging || isAnimating;

  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const shownPosition = scrubbing ?? position;
  const durationSafe = Math.max(duration, 1);
  const fillPct = Math.min(100, Math.max(0, (shownPosition / durationSafe) * 100));

  // Queue expansion (spec §14-15) — purely a local presentation toggle, not
  // player state: collapses the artwork away and lets the queue sheet take
  // over the freed space, then restores on collapse. Closes automatically
  // if the queue empties out from under it (e.g. every upcoming track got
  // removed) so it can't get stuck open on nothing.
  const [queueOpen, setQueueOpen] = useState(false);
  const hasQueue = queue.length > 1;
  useEffect(() => { if (!hasQueue) setQueueOpen(false); }, [hasQueue]);
  const nextInQueue = hasQueue
    ? queue[(queue.findIndex(t => t.id === current?.id) + 1) % queue.length]
    : undefined;

  // Horizontal swipe-on-artwork for next/prev (spec §16). Constrained back
  // to 0,0 so it's a pure gesture recognizer, not a persistent drag — the
  // artwork springs back to center every time, next()/prev() do the actual
  // navigation via the existing controller.
  const SWIPE_THRESHOLD = 70;

  // FIX (queue "Up next" toggle — and, latently, every other button on
  // this screen — not registering taps on real touchscreens): the
  // entire sheet above has drag="y" for pull-to-dismiss, and on a real
  // finger a "tap" is rarely 0px of movement. Framer Motion's drag
  // gesture recognizer can claim that stray pixel or two as the start
  // of a pan before the button's own onClick fires, silently
  // swallowing the tap — worse for small targets, which is exactly
  // why the queue toggle was the one that got reported. Stopping the
  // pointerdown from bubbling up to the drag surface (capture phase,
  // before Framer ever sees it) excludes a control from that gesture
  // entirely without touching dismiss-by-drag anywhere else on the
  // sheet.
  const stopDragCapture = (e: React.PointerEvent) => e.stopPropagation();

  if (!current) return null;

  return (
    <AnimatePresence>
      {expanded && (
        <motion.div
          key="groic-full"
          initial={{ y: "100%", opacity: 0.6, scale: 0.98 }}
          animate={{ y: 0, opacity: 1, scale: 1 }}
          exit={{ y: "100%", opacity: 0.4, scale: 0.99 }}
          transition={{ type: "spring", stiffness: 320, damping: 36 }}
          onAnimationStart={() => setIsAnimating(true)}
          onAnimationComplete={() => setIsAnimating(false)}
          className="fixed inset-0 z-[60] flex flex-col transform-gpu bg-background"
          style={{ willChange: "transform" }}
        >
          {/* Ambient artwork wash (spec §8) — sits behind every glass
              surface, crossfades smoothly on track change. */}
          <AmbientBackground thumbnail={current.thumbnail} />
          {/* Glass overlay so blur reads as premium. Blur tier drops during
              both an active drag and the open/close spring animation (see
              cheapBlur above) — same visual family, far cheaper to
              recomposite while anything is actually moving. */}
          <div className={cn(
            "absolute inset-0 bg-background/40 transition-[backdrop-filter] duration-150",
            cheapBlur ? "backdrop-blur-md" : "backdrop-blur-3xl",
          )} />
          {/* Bottom scrim: keeps controls/typography readable over bright
              artwork without dimming the whole stage uniformly. Raised
              height + opacity (was h-1/2 / 80%-30%) — on brighter/busier
              thumbnails (e.g. a bright YouTube video-song cover) the old
              scrim faded to transparent right around the progress bar,
              leaving it too low-contrast to read against the artwork. */}
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-background/90 via-background/55 to-transparent pointer-events-none" />

          {/* REDESIGN (was: fixed-height non-scrolling column with an
              overflow-y-auto safety net for short screens): now an
              intentionally scrollable page. The section below —
              header/artwork/title/progress/controls — is height-locked to
              the viewport (min-h-[100dvh]) so opening the player still
              shows exactly that, current-song-first, on any screen. The
              queue lives after it in normal document flow and is reached
              by scrolling, which is also what fixes the old
              "art not fully visible" + "cramped queue" complaints at the
              same time: the artwork isn't fighting the queue for a fixed
              pixel budget anymore, so neither has to compromise.
              FIX (scroll vs. pull-to-dismiss fighting each other): native
              scroll and pull-to-minimize used to be the same Framer
              `drag="y"` gesture, gated on scrollTop, which meant Framer
              claimed every vertical touch from the top of the page —
              including a plain scroll down into the queue — before it
              could ever reach native scrolling (see the gesture effect
              above `current` for the full writeup). Now this container is
              a completely normal scrollable element; the pull-to-minimize
              takeover only ever happens for a genuine downward pull that
              starts at scrollTop 0. */}
          <motion.div
            ref={scrollRef}
            style={{ y: sheetY, touchAction: "pan-y" }}
            className="relative z-10 flex flex-col safe-top px-6 pb-10 overflow-y-auto overscroll-contain"
          >
            <div className="flex flex-col min-h-[100dvh]">
            {/* Header — grab affordance + context */}
            <div className="flex items-center justify-between pt-3 pb-5">
              <button onClick={() => { hapticLight(); expand(false); }}
                onPointerDownCapture={stopDragCapture}
                className="h-11 w-11 rounded-full bg-foreground/10 backdrop-blur-md flex items-center justify-center active:scale-95"
                aria-label="Minimize player">
                <ChevronDown className="h-5 w-5" />
              </button>
              <div className="flex flex-col items-center gap-1">
                <p className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                  {sessionRole === "host" ? "Hosting" : sessionRole === "guest" ? "Listening together" : "Now Playing"}
                </p>
                <ProviderChip provider={current.provider} />
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={async () => {
                    hapticMedium();
                    if (sessionRole === "solo") { await startSession(); toast({ title: "Session started 🎶" }); }
                    else { await endSession(); toast({ title: "Session ended" }); }
                  }}
                  onPointerDownCapture={stopDragCapture}
                  className="h-11 w-11 rounded-full bg-foreground/10 backdrop-blur-md flex items-center justify-center active:scale-95"
                  aria-label={sessionRole === "solo" ? "Start shared session" : "End shared session"}
                >
                  {sessionRole === "solo" ? <Users className="h-4 w-4" /> : <UserMinus className="h-4 w-4 text-primary" />}
                </button>
                {/* FIX: the full player had no way to actually stop playback
                    either — ChevronDown only ever minimized to the mini bar. */}
                <button
                  onClick={() => { hapticMedium(); close(); }}
                  onPointerDownCapture={stopDragCapture}
                  className="h-11 w-11 rounded-full bg-foreground/10 backdrop-blur-md flex items-center justify-center active:scale-95"
                  aria-label="Close player"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Artwork — premium glass album area: the sleeve sits INSIDE a
                glass frame (one elevated material, per the app-wide rule:
                content stays clean, only the floating surface is glass),
                breathing gently while playing, with a live equalizer pinned
                to its lower edge so "is something making sound right now?"
                is answerable at a glance.
                FIX (art getting cropped): object-cover was cutting off
                YouTube's landscape 16:9 video-song thumbnails to fit this
                square frame — object-contain shows the complete image,
                letterboxed on the muted frame background for anything
                that isn't already square (Audius/SoundCloud art, which
                mostly is square, fills edge-to-edge exactly as before).
                FIX (laggy queue toggle): this no longer collapses away
                when the queue opens — that AnimatePresence height
                animation running at the same time as the queue's own
                resize, both under a backdrop-blur surface, was a
                meaningful chunk of the reported lag on Android WebViews.
                The queue has its own room via the page scroll below now,
                so the artwork just stays put. */}
            <div className="flex-1 min-h-0 flex items-center justify-center py-2">
              <motion.div
                animate={{ scale: isPlaying ? 1 : 0.94, opacity: isPlaying ? 1 : 0.85 }}
                transition={{ type: "spring", stiffness: 200, damping: 24 }}
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.55}
                dragMomentum={false}
                onDragEnd={(_, info) => {
                  if (info.offset.x <= -SWIPE_THRESHOLD) { hapticLight(); next(); }
                  else if (info.offset.x >= SWIPE_THRESHOLD) { hapticLight(); prev(); }
                }}
                className="relative rounded-panel p-2 glass-player shrink-0 touch-pan-y"
                style={{ width: "min(92vw, 66vh, 560px)", height: "min(92vw, 66vh, 560px)" }}
              >
                <div className="relative h-full w-full rounded-[22px] overflow-hidden bg-muted shadow-[0_24px_60px_-18px_hsl(var(--foreground)/0.45)]">
                  {current.thumbnail
                    ? <img loading="lazy" decoding="async" src={current.thumbnail} alt={current.title} className="h-full w-full object-contain" draggable={false} />
                    : <div className="h-full w-full bg-gradient-to-br from-primary/40 to-accent" />}
                  {isPlaying && (
                    <div aria-hidden="true"
                      className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-end gap-[3px] h-4 px-2 py-1 rounded-full bg-black/35 backdrop-blur-sm">
                      {[0.7, 0.45, 0.9, 0.55].map((d, i) => (
                        <motion.span key={i}
                          className="w-[2.5px] rounded-full bg-white/90"
                          animate={{ height: ["20%", "90%", "35%"] }}
                          transition={{ repeat: Infinity, duration: d, delay: i * 0.09, ease: "easeInOut" }} />
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            </div>

            {/* Title block — left-aligned hierarchy (title dominates,
                artist secondary, status tertiary) instead of three centered
                lines competing with the artwork above. */}
            <div className="mt-5 mb-1 text-center">
              <p className="text-[22px] leading-tight font-bold tracking-tight truncate">{current.title}</p>
              <p className="text-sm text-muted-foreground mt-0.5 truncate">{current.artist}</p>
              {sessionRole !== "solo" && (
                <p className="text-[10px] mt-1.5 text-primary font-medium">
                  {partnerListening ? "● Partner listening live" : "○ Waiting for partner"}
                </p>
              )}
              {/* FIX (requirement: "gracefully skip / display as
                  unavailable" rather than crash or show a false playing
                  state): surfaces GroicContext's last playback error —
                  e.g. an Audius track that failed to resolve a stream URL
                  — right where the person is already looking, instead of
                  only a toast that can be missed. */}
              {error && (
                <p className="text-[11px] mt-1.5 text-destructive">{error}</p>
              )}
            </div>

            {/* Progress — real scrubbing feel: filled track tinted with the
                accent up to the played point (computed inline so no extra
                element tracks it), a thumb that enlarges while grabbed, and
                frozen readout during the gesture. Still a native range input
                underneath — keyboard/screen-reader seek behavior intact. */}
            {/* FIX (timeline reading as "behind" the song artwork): this
                row previously relied only on the bottom scrim's gradient
                for contrast, which faded out right around here on bright
                artwork. A small dedicated backing guarantees the track/
                thumb/timestamps are always legible, independent of
                whatever's behind them, without changing anything else on
                the screen. */}
            <div className="space-y-1.5 mt-2 relative z-10 rounded-2xl bg-background/25 backdrop-blur-sm px-3 py-2 -mx-3">
              <input
                type="range" min={0} max={durationSafe} step={1}
                value={shownPosition}
                onChange={(e) => setScrubbing(Number(e.target.value))}
                onPointerUp={() => { if (scrubbing != null) { seek(scrubbing); setScrubbing(null); } }}
                onKeyUp={() => { if (scrubbing != null) { seek(scrubbing); setScrubbing(null); } }}
                onBlur={() => { if (scrubbing != null) { seek(scrubbing); setScrubbing(null); } }}
                aria-label="Seek"
                aria-valuetext={`${fmt(shownPosition)} of ${fmt(durationSafe)}`}
                className="groic-range w-full"
                style={{ "--fill-pct": `${fillPct}%` } as React.CSSProperties}
              />
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono tabular-nums">
                <span>{fmt(shownPosition)}</span>
                <span>-{fmt(Math.max(durationSafe - shownPosition, 0))}</span>
              </div>
            </div>

            {/* Controls — one clear hierarchy: transport trio owns the row;
                shuffle/repeat/download are quieter satellites beneath, not
                same-weight circles fighting for attention. Play gets the
                only saturated surface on the screen. */}
            <div className="flex items-center justify-center gap-7 mt-3">
              <button onClick={() => { hapticLight(); prev(); }}
                onPointerDownCapture={stopDragCapture}
                className="h-14 w-14 rounded-full bg-foreground/[0.07] backdrop-blur-md flex items-center justify-center active:scale-90 transition-transform"
                aria-label="Previous">
                <SkipBack className="h-5 w-5" fill="currentColor" />
              </button>
              <button onClick={() => { if (isBusy) return; hapticMedium(); toggle(); }}
                onPointerDownCapture={stopDragCapture}
                className="h-[68px] w-[68px] rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-[0_16px_40px_-10px_hsl(var(--primary)/0.55)] active:scale-95 transition-transform"
                aria-label={isBusy ? "Loading" : isPlaying ? "Pause" : "Play"}
                aria-busy={isBusy}>
                {isBusy ? (
                  <Loader2 className="h-7 w-7 animate-spin" aria-hidden="true" />
                ) : isPlaying ? (
                  <Pause className="h-7 w-7" fill="currentColor" />
                ) : (
                  <Play className="h-7 w-7 ml-1" fill="currentColor" />
                )}
              </button>
              <button onClick={() => { hapticLight(); next(); }}
                onPointerDownCapture={stopDragCapture}
                className="h-14 w-14 rounded-full bg-foreground/[0.07] backdrop-blur-md flex items-center justify-center active:scale-90 transition-transform"
                aria-label="Next">
                <SkipForward className="h-5 w-5" fill="currentColor" />
              </button>
            </div>

            {/* Shuffle / repeat — additive, wired straight to
                GroicContext's new repeatMode/shuffle state (see
                docs/MUSIC_NATIVE_PLAYBACK.md for the queue-behavior
                writeup). Repeat cycles off → all → one, matching the
                Spotify/Apple Music convention rather than a checkbox. */}
            <div className="flex items-center justify-center gap-9 mt-2.5">
              <button
                onClick={() => { hapticLight(); toggleShuffle(); }}
                onPointerDownCapture={stopDragCapture}
                aria-pressed={shuffle}
                aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
                className={`h-11 w-11 rounded-full flex items-center justify-center active:scale-90 relative ${shuffle ? "text-primary" : "text-muted-foreground"}`}
              >
                <Shuffle className="h-4 w-4" />
                {shuffle && <span aria-hidden="true" className="absolute bottom-1 h-1 w-1 rounded-full bg-primary" />}
              </button>
              <button
                onClick={() => {
                  hapticLight();
                  setRepeatMode(repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off");
                }}
                onPointerDownCapture={stopDragCapture}
                aria-label={`Repeat: ${repeatMode}`}
                className={`h-11 w-11 rounded-full flex items-center justify-center active:scale-90 relative ${repeatMode !== "off" ? "text-primary" : "text-muted-foreground"}`}
              >
                {repeatMode === "one" ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
                {repeatMode !== "off" && <span aria-hidden="true" className="absolute bottom-1 h-1 w-1 rounded-full bg-primary" />}
              </button>
              {/* Offline download — Audius-only, per canDownload(); never
                  shown for a YouTube track (provider mismatch fails that
                  check immediately, no separate branch needed here). */}
              {downloadEligible && (
                <button
                  onClick={handleDownloadToggle}
                  onPointerDownCapture={stopDragCapture}
                  disabled={progress !== "idle"}
                  aria-label={downloaded ? "Remove downloaded copy" : "Download for offline playback"}
                  className={`h-11 w-11 rounded-full flex items-center justify-center active:scale-90 relative ${downloaded ? "text-primary" : "text-muted-foreground"}`}
                >
                  {progress !== "idle" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : downloaded ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <Download className="h-4 w-4" />
                  )}
                </button>
              )}
            </div>
            {progress !== "idle" && typeof progress === "number" && (
              <p className="text-center text-[10px] text-muted-foreground mt-0.5">
                Downloading… {Math.round(progress * 100)}%
              </p>
            )}
            </div>

            {/* Queue — an elevated glass surface of the SAME material
                family as the album frame (not another competing surface).
                Collapsed, it's a single-row "Up next" bar — a compact
                preview of just the next track. Tapping it (or opening a
                track) expands the list below it; tapping again collapses
                it. A tap toggle rather than an up/down swipe deliberately
                — the outer sheet still owns a vertical drag="y" gesture
                for dismiss-on-pull, and stacking a second vertical swipe
                target directly on top of that one would make both
                unreliable.
                FIX (laggy expand/collapse): this used to be a `layout`-
                animated card resizing between flex-1 and a capped height
                while also fighting the artwork above it for the same
                fixed viewport — two simultaneous large resizes under
                backdrop-blur, which is expensive on Android WebViews. Now
                the card's own footprint barely changes (it's a fixed
                small element in a scrollable page, not a viewport-filling
                one), and only the actual list — a much smaller area —
                animates open/closed. */}
            {hasQueue && (
              <div className="mt-4 rounded-3xl glass-player p-2 flex flex-col">
                <button
                  onClick={() => { hapticLight(); setQueueOpen(v => !v); }}
                  onPointerDownCapture={stopDragCapture}
                  aria-expanded={queueOpen}
                  className="flex items-center gap-3 px-1 py-1 shrink-0 text-left"
                >
                  {queueOpen ? (
                    <span className="flex-1 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-muted-foreground py-1 px-1">
                      <ListMusic className="h-3 w-3" aria-hidden="true" />
                      Up next
                    </span>
                  ) : (
                    <>
                      <img
                        src={nextInQueue?.thumbnail || ""} alt=""
                        className="h-9 w-9 rounded-lg object-cover bg-muted shrink-0"
                        loading="lazy" decoding="async"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">Up next</p>
                        <p className="text-[13px] font-medium truncate leading-tight">{nextInQueue?.title ?? "—"}</p>
                      </div>
                    </>
                  )}
                  <ChevronUp className={cn("h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform", queueOpen && "rotate-180")} aria-hidden="true" />
                </button>
                <AnimatePresence initial={false}>
                  {queueOpen && (
                    <motion.div
                      key="queue-list"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ type: "spring", stiffness: 340, damping: 34 }}
                      className="overflow-hidden"
                    >
                      <div className="mt-1">
                        {queue.filter(t => t.id !== current.id).map(t => (
                          <div key={t.id} className="flex items-center gap-3 px-2 py-2 rounded-2xl active:bg-foreground/5 transition-colors"
                            onClick={() => { playTrack(t); setQueueOpen(false); }}
                            onPointerDownCapture={stopDragCapture}>
                            <img src={t.thumbnail || ""} alt="" className="h-11 w-11 rounded-xl object-cover bg-muted shrink-0" loading="lazy" />
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-medium truncate">{t.title}</p>
                              <p className="text-xs text-muted-foreground truncate">{t.artist}</p>
                            </div>
                            <button onClick={(e) => { e.stopPropagation(); hapticLight(); removeFromQueue(t.id); }}
                              onPointerDownCapture={stopDragCapture}
                              className="h-9 w-9 rounded-full text-muted-foreground active:scale-90 flex items-center justify-center shrink-0" aria-label={`Remove ${t.title} from queue`}>
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
          </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default GroicFullPlayer;
