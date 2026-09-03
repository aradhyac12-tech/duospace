import { motion, AnimatePresence } from "framer-motion";
import {
  Play, Pause, SkipBack, SkipForward, ChevronDown, Users, UserMinus, Trash2, X,
  Shuffle, Repeat, Repeat1, Download, CheckCircle2, Loader2, Youtube,
} from "lucide-react";
import { useEffect, useState } from "react";
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
          provider === "audius" ? "bg-[#ff8800]" : "bg-success",
        )} />
      )}
      {label}
    </span>
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
          drag="y"
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={0.2}
          dragMomentum={false}
          onDragStart={() => setIsDragging(true)}
          onDragEnd={(_, info) => {
            setIsDragging(false);
            if (info.offset.y > 120) expand(false);
          }}
          className="fixed inset-0 z-[60] flex flex-col transform-gpu"
          style={{
            background: current.thumbnail
              ? `linear-gradient(180deg, hsl(var(--background)/0.6), hsl(var(--background))), url(${current.thumbnail}) center/cover`
              : "hsl(var(--background))",
            willChange: "transform",
          }}
        >
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

          {/* FIX (buttons unreachable on short screens): everything below
              the artwork (header, title, progress, transport, shuffle/
              repeat/download, queue) is fixed-height in a non-scrolling
              column — only the artwork area shrinks. On a short enough
              viewport (small phone, larger system font scale) the fixed
              elements alone could exceed the screen height, leaving the
              bottom controls genuinely unreachable with no way to scroll
              to them. overflow-y-auto is a safety net for exactly that
              case — invisible on normal screens where everything already
              fits without scrolling.
              Known interaction: the OUTER sheet still has its own
              drag="y" pull-to-dismiss gesture. On the rare screen short
              enough to actually need this scroll fallback, a downward
              scroll gesture inside this column can be read as a dismiss
              drag instead of a scroll. Not a regression — that content
              was completely unreachable before this fix either way — but
              worth a real device pass if it comes up again. */}
          <div className="relative z-10 flex flex-col h-full safe-top px-6 pb-10 overflow-y-auto overscroll-contain">
            {/* Header — grab affordance + context */}
            <div className="flex items-center justify-between pt-3 pb-5">
              <button onClick={() => { hapticLight(); expand(false); }}
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
                  className="h-11 w-11 rounded-full bg-foreground/10 backdrop-blur-md flex items-center justify-center active:scale-95"
                  aria-label={sessionRole === "solo" ? "Start shared session" : "End shared session"}
                >
                  {sessionRole === "solo" ? <Users className="h-4 w-4" /> : <UserMinus className="h-4 w-4 text-primary" />}
                </button>
                {/* FIX: the full player had no way to actually stop playback
                    either — ChevronDown only ever minimized to the mini bar. */}
                <button
                  onClick={() => { hapticMedium(); close(); }}
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
                is answerable at a glance. Height-capped so the queue below
                keeps its room on short screens (previous fix preserved). */}
            <div className="flex-1 min-h-0 overflow-hidden flex items-center justify-center">
              <motion.div
                animate={{ scale: isPlaying ? 1 : 0.94, opacity: isPlaying ? 1 : 0.85 }}
                transition={{ type: "spring", stiffness: 200, damping: 24 }}
                className="relative rounded-panel p-2 glass-sheet shrink-0"
                style={{ width: "min(280px, 38vh, 100%)", height: "min(280px, 38vh, 100%)" }}
              >
                <div className="relative h-full w-full rounded-[22px] overflow-hidden bg-muted shadow-[0_24px_60px_-18px_hsl(var(--foreground)/0.45)]">
                  {current.thumbnail
                    ? <img src={current.thumbnail} alt={current.title} className="h-full w-full object-cover" draggable={false} />
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
                className="h-14 w-14 rounded-full bg-foreground/[0.07] backdrop-blur-md flex items-center justify-center active:scale-90 transition-transform"
                aria-label="Previous">
                <SkipBack className="h-5 w-5" fill="currentColor" />
              </button>
              <button onClick={() => { if (isBusy) return; hapticMedium(); toggle(); }}
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

            {/* Queue — an elevated glass sheet of the SAME material family
                as the album frame (not another competing surface): sticky
                header, current-track context kept implicit by omission, and
                roomier rows than the old 160px strip. */}
            {queue.length > 1 && (
              <div className="mt-4 max-h-64 overflow-y-auto rounded-3xl glass-sheet p-2">
                <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground px-2 pb-1.5 sticky top-0 bg-transparent backdrop-blur-md">Up next</p>
                {queue.filter(t => t.id !== current.id).map(t => (
                  <div key={t.id} className="flex items-center gap-3 px-2 py-2 rounded-2xl active:bg-foreground/5 transition-colors"
                    onClick={() => playTrack(t)}>
                    <img src={t.thumbnail || ""} alt="" className="h-11 w-11 rounded-xl object-cover bg-muted shrink-0" loading="lazy" />
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium truncate">{t.title}</p>
                      <p className="text-xs text-muted-foreground truncate">{t.artist}</p>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); hapticLight(); removeFromQueue(t.id); }}
                      className="h-9 w-9 rounded-full text-muted-foreground active:scale-90 flex items-center justify-center shrink-0" aria-label={`Remove ${t.title} from queue`}>
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
