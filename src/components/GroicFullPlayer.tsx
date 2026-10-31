import { motion, AnimatePresence, useMotionValue, useTransform, animate as animateValue } from "framer-motion";
import {
  ChevronDown, Users, UserMinus, Trash2, X,
  Shuffle, Repeat, Repeat1, Sparkles, Download, CheckCircle2, Loader2, Youtube, ListMusic, Heart,
  Disc3, AlignLeft, Info, ChevronUp, ArrowUpDown, GripVertical,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useGroic, useGroicProgress } from "@/contexts/GroicContext";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { useBackHandler } from "@/hooks/useBackHandler";
import GroicLyrics from "@/components/GroicLyrics";
import { DiagnosticsLink } from "@/components/music/MusicDiagnostics";
import { CROSSFADE_OPTIONS, getCrossfadeSeconds, isCrossfadeSupported, setCrossfadeSeconds } from "@/lib/music/crossfade";
import { cn } from "@/lib/utils";
import { fallbackArt } from "@/lib/music/fallbackArt";
import { CONTENT_FADE } from "@/lib/music/motionTokens";
import { nextDragStep } from "@/lib/music/dragReorder";
import { onArtError } from "@/lib/music/artOnError";
import { PULL_ENGAGE_PX, pullProgress, pullRange, releaseVelocity, shouldEngagePull, shouldMinimize, springVelocity, DISMISS_COMMIT } from "@/lib/music/pullToMinimize";
import { pulseMiniBar } from "@/lib/music/miniLanding";
import { PlayPauseIcon } from "@/components/music/PlayPauseIcon";
import { SkipButton } from "@/components/music/SkipButton";
import { useToast } from "@/hooks/use-toast";
import { toggleLiked, useIsLiked } from "@/lib/music/libraryStore";
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
    : provider === "jamendo" ? "Free Music"
    : provider === "local" ? "My Files"
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
              className="ambient-art absolute inset-[-10%] bg-center bg-cover opacity-[0.4] dark:opacity-[0.32] scale-110"
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

/**
 * The only part of the full player that follows playback position. Kept as its own
 * component so the position tick (twice a second) re-renders just this small
 * subtree instead of the whole player — see useGroicProgress in GroicContext.
 */
const SeekBar = ({ seek }: { seek: (sec: number) => void }) => {
  const { position, duration } = useGroicProgress();
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const shownPosition = scrubbing ?? position;
  const durationSafe = Math.max(duration, 1);
  const fillPct = Math.min(100, Math.max(0, (shownPosition / durationSafe) * 100));
  // FIX (seek bar could freeze): the scrub was only committed on pointerup/blur.
  // A touch that the OS cancels (a system gesture, the pull-to-minimize
  // takeover, an incoming notification) fires pointercancel/touchend instead, so
  // `scrubbing` stayed set and the bar stopped following playback until a
  // later tap. Every way a gesture can end now commits it exactly once.
  const commit = () => { if (scrubbing != null) { seek(scrubbing); setScrubbing(null); } };
  return (
    <>
      <input
        type="range" min={0} max={durationSafe} step={1}
        value={shownPosition}
        onChange={(e) => setScrubbing(Number(e.target.value))}
        onPointerUp={commit}
        onPointerCancel={commit}
        onTouchEnd={commit}
        onTouchCancel={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label="Seek"
        aria-valuetext={`${fmt(shownPosition)} of ${fmt(durationSafe)}`}
        className="groic-range w-full"
        style={{ "--fill-pct": `${fillPct}%` } as React.CSSProperties}
      />
      <div className="flex justify-between px-0.5 text-[11px] text-muted-foreground font-mono tabular-nums">
        <span>{fmt(shownPosition)}</span>
        <span>-{fmt(Math.max(durationSafe - shownPosition, 0))}</span>
      </div>
    </>
  );
};

type PlayerTab = "player" | "lyrics" | "queue" | "info";

const GroicFullPlayer = () => {
  const {
    current: liveCurrent, queue, isPlaying, expanded,
    toggle, retry, next, prev, seek, removeFromQueue, moveInQueue, expand, playTrack, close,
    sessionRole, partnerListening, startSession, endSession,
    repeatMode, shuffle, setRepeatMode, toggleShuffle, autoNext, toggleAutoNext, error, loading, buffering, clearQueue,
  } = useGroic();
  // Closing the player (X) clears `current` in the same instant `expanded` goes false. Returning null
  // for a missing track used to unmount the whole sheet on that frame, so Close was a hard cut. Keep
  // rendering the last track until the exit animation has finished.
  const lastCurrentRef = useRef(liveCurrent);
  if (liveCurrent) lastCurrentRef.current = liveCurrent;
  const current = liveCurrent ?? lastCurrentRef.current;
  const liked = useIsLiked(current?.id);
  const { toast } = useToast();
  // Which stage is showing between the header and the controls. The controls
  // (title pill, seek bar, transport) are the same on every tab — only the
  // stage swaps — so nothing ever jumps around.
  const [tab, setTab] = useState<PlayerTab>("player");
  const [reorder, setReorder] = useState(false);
  const dragRef = useRef<{ id: string; lastY: number; acc: number; h: number } | null>(null);
  const [announce, setAnnounce] = useState("");
  // Only non-square art (YouTube 16:9) needs the blurred filler behind it.
  const [artNonSquare, setArtNonSquare] = useState(false);
  const tabRef = useRef<PlayerTab>("player");
  tabRef.current = tab;
  // AUDIT FIX (Phase 7, Music) — see GroicMiniPlayer.tsx's matching comment:
  // `loading`/`buffering` existed in GroicContext but were never shown here
  // either, so the big center play button gave no feedback while a track
  // was still resolving.
  // Close() flips isPlaying/loading to false in the same instant the sheet starts leaving; showing those would
  // flash the play icon and stop the equalizer mid-exit. Freeze them for as long as the track is gone.
  const liveBusy = loading || buffering;
  const frozenRef = useRef({ playing: isPlaying, busy: liveBusy });
  if (liveCurrent) frozenRef.current = { playing: isPlaying, busy: liveBusy };
  const shownPlaying = liveCurrent ? isPlaying : frozenRef.current.playing;
  const isBusy = liveCurrent ? liveBusy : frozenRef.current.busy;
  // After 8 s of continuous loading, say so and offer a one-tap retry instead of an endless spinner.
  const [crossfade, setCrossfade] = useState(getCrossfadeSeconds);
  const [slowLoad, setSlowLoad] = useState(false);
  useEffect(() => {
    if (!isBusy) { setSlowLoad(false); return; }
    const t = window.setTimeout(() => setSlowLoad(true), 8000);
    return () => window.clearTimeout(t);
  }, [isBusy, current?.id]);

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
  // SMOOTHNESS FIX: "is the sheet moving" used to be two React state values
  // (isDragging / isMorphing). Flipping them re-rendered this whole 800-line
  // component — queue rows, lyrics, tab bar — on the exact frame a pull began
  // or an open/close animation started, which is the hitch you feel at the
  // START of the gesture. It is now a data attribute written straight to the
  // sheet element (no React render at all); index.css reads it to switch the
  // expensive backdrop blurs off for the duration of the motion.
  const sheetRef = useRef<HTMLDivElement>(null);
  const setMorphing = useCallback((on: boolean) => {
    const el = sheetRef.current;
    if (!el) return;
    if (on) el.setAttribute("data-morphing", "1"); else el.removeAttribute("data-morphing");
  }, []);

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
  // Excludes a control from any parent gesture (kept from the old drag-sheet
  // days: capturing the pointerdown means a slightly-moving fingertip can't
  // be mistaken for the start of a drag and swallow the tap).
  const stopDragCapture = (e: React.PointerEvent) => e.stopPropagation();
  // sheetY now translates the WHOLE sheet (background included), not just the
  // scroll content. Before, only the content moved while the opaque
  // background stayed put, then the sheet's own exit slide started a second
  // animation on top — which is why the pull looked like it "half worked".
  // ── Artwork → mini-player morph ────────────────────────────────────────
  // ONE progress value drives everything: 0 = player fully open, 1 = collapsed
  // into the mini bar's thumbnail. Pulling down on the artwork (or tapping the
  // chevron / system back) shrinks the artwork along a straight path onto the
  // REAL thumbnail of the mini bar underneath (measured, so safe areas and the
  // chat composer offset are exact), while the background and controls fade
  // away. Opening runs the same animation backwards, so tapping the mini bar
  // grows the artwork out of it. Pure transforms/opacity on motion values — no
  // React render per frame.
  const prog = useMotionValue(1);
  const tx = useMotionValue(0);
  const ty = useMotionValue(0);
  const ts = useMotionValue(0.12);
  const artX = useTransform([prog, tx], ([p, x]) => (p as number) * (x as number));
  const artY = useTransform([prog, ty], ([p, y]) => (p as number) * (y as number));
  const artScale = useTransform([prog, ts], ([p, k]) => 1 + ((k as number) - 1) * (p as number));
  // Keep the on-screen corner radius smooth: the frame is scaled down, so the
  // radius must grow by 1/scale to still read as the mini thumbnail's 12px.
  const artRadius = useTransform([prog, ts], ([p, k]) => {
    const r0 = 30, r1 = 12 / Math.max(k as number, 0.05);
    return r0 + (r1 - r0) * (p as number);
  });
  const artOpacity = useTransform(prog, [0, 0.9, 1], [1, 1, 0]);
  const artClip = useTransform(prog, (p) => (p > 0.001 ? "hidden" : "visible"));
  const bgOpacity = useTransform(prog, [0, 0.75], [1, 0], { clamp: true });
  const contentOpacity = useTransform(prog, [0, 0.4], [1, 0], { clamp: true });
  const contentY = useTransform(prog, [0, 1], [0, 70]);
  const fadeStyle = { opacity: contentOpacity, y: contentY, willChange: "transform, opacity" } as const;
  const artRef = useRef<HTMLDivElement>(null);
  const morphAnim = useRef<ReturnType<typeof animateValue> | null>(null);
  const closingRef = useRef(false);

  /** Measures where the artwork rests and where the mini thumbnail is. Must
   *  see the artwork WITHOUT its morph transform, hence the temporary reset. */
  const measureMorph = useCallback(() => {
    const el = artRef.current;
    if (!el) return false;
    const prevT = el.style.transform;
    el.style.transform = "none";
    const r = el.getBoundingClientRect();
    el.style.transform = prevT;
    if (!r.width) return false;
    const thumb = document.querySelector("[data-groic-mini-thumb]") as HTMLElement | null;
    let cx: number, cy: number, size: number;
    if (thumb) {
      const t = thumb.getBoundingClientRect();
      cx = t.left + t.width / 2; cy = t.top + t.height / 2; size = t.width || 40;
    } else {
      // Mini bar not on screen (minimized to the corner icon): fall back to
      // the bottom-left where the bar docks.
      size = 40; cx = 12 + 8 + 20; cy = window.innerHeight - 96;
    }
    tx.set(cx - (r.left + r.width / 2));
    ty.set(cy - (r.top + r.height / 2));
    ts.set(Math.min(1, Math.max(0.04, size / r.width)));
    return true;
  }, [tx, ty, ts]);

  /** Animate the morph to the mini bar, then actually minimize. */
  const collapse = useCallback((velocity = 0) => {
    if (closingRef.current) return;
    closingRef.current = true;
    morphAnim.current?.stop();
    // Artwork not on screen (Lyrics / Queue / Details tab): there is nothing to
    // fly, but the sheet should still glide away (content + background fade on
    // the same progress value) instead of snapping shut mid-pull.
    measureMorph();
    setMorphing(true);
    // Damping ~= 2*sqrt(stiffness): critically damped, so the artwork lands on the thumbnail without
    // overshooting past it (prog > 1 would scale it below the thumbnail and snap back).
    morphAnim.current = animateValue(prog, 1, {
      type: "spring", stiffness: 330, damping: 36.5, velocity, restDelta: 0.004, restSpeed: 0.05,
      onComplete: () => { closingRef.current = false; pulseMiniBar(); expand(false); },
    });
  }, [expand, measureMorph, prog]);

  // Hardware/gesture back minimizes the player to the mini bar.
  useBackHandler(expanded, () => { if (tabRef.current !== "player") setTab("player"); else collapse(); });

  // A fresh open always starts at rest (the previous pull may have flung the
  // sheet off screen).
  // Opening: start collapsed onto the mini thumbnail and grow out of it. Runs
  // in a layout effect so the first painted frame is already the collapsed one.
  useLayoutEffect(() => {
    if (!expanded) return;
    closingRef.current = false;
    morphAnim.current?.stop();
    const ok = measureMorph();
    if (!ok) { prog.jump(0); return; }
    prog.jump(1);
    setMorphing(true);
    morphAnim.current = animateValue(prog, 0, {
      type: "spring", stiffness: 300, damping: 34, restDelta: 0.002,
      onComplete: () => setMorphing(false),
    });
    return () => { morphAnim.current?.stop(); };
  }, [expanded, measureMorph, prog]);

  // ROOT-CAUSE FIX (pull-down-to-minimise never worked): this effect used to
  // have deps [collapse, measureMorph, prog, ty] — all stable for the life of
  // the component. The sheet's scroll container only exists while `expanded`
  // (it is rendered inside `{expanded && …}`), so on the first and ONLY run the
  // player was closed, `scrollRef.current` was null, the effect returned early
  // and never ran again: no touch listeners were ever attached. It now also
  // depends on whether the sheet is mounted, so the listeners attach every time
  // the player opens and are removed when it closes.
  const sheetMounted = expanded && !!current;
  useEffect(() => {
    if (!sheetMounted) return;
    const el = scrollRef.current;
    if (!el) return;

    let startY = 0;
    let startX = 0;
    let engaged = false;   // this gesture has been claimed for pull-to-minimize
    let ignored = false;   // gesture began on a control that owns its own drag (seek bar)
    let inner: HTMLElement | null = null; // a list inside the stage (lyrics/queue/details) that scrolls on its own
    let rawPull = 0;       // real finger travel since engaging
    let samples: Array<{ t: number; y: number }> = [];
    let pastLine = false;

    let range = 300;       // finger travel that equals a full collapse
    const settle = (velocity = 0) => {
      morphAnim.current?.stop();
      morphAnim.current = animateValue(prog, 0, { type: "spring", stiffness: 420, damping: 40, velocity, restDelta: 0.002, onComplete: () => setMorphing(false) });
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
      engaged = false;
      rawPull = 0;
      pastLine = false;
      samples = [];
      // The seek slider (and anything marked data-no-pull) handles its own
      // touches — a slightly downward scrub must never minimize the player.
      ignored = !!(e.target as HTMLElement | null)?.closest?.('input[type="range"], [data-no-pull]');
      inner = (e.target as HTMLElement | null)?.closest?.("[data-inner-scroll]") as HTMLElement | null;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1 || ignored) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (!engaged) {
        // Scrolling a list inside the stage: that list owns the touch until it
        // is back at its very top. Keep re-basing the origin so the pull
        // starts from where the list actually bottomed out, not from where
        // the finger first landed.
        if (inner && inner.scrollTop > 0) {
          startY = e.touches[0].clientY;
          startX = e.touches[0].clientX;
          return;
        }
        // Claim the gesture only when already at the top AND clearly pulling
        // DOWN (more vertical than horizontal, so the artwork's left/right
        // track-swipe is never stolen). Everything else is native scrolling.
        if (!shouldEngagePull(dx, dy, el.scrollTop)) return;
        if (closingRef.current) return;
        engaged = true;
        setMorphing(true);
        morphAnim.current?.stop();
        measureMorph();
        // The artwork has a long way to travel; scale the pull distance to it so
        // the thumbnail stays roughly under the finger instead of racing ahead.
        range = pullRange(ty.get());
        hapticLight();
      }
      if (e.cancelable) e.preventDefault();
      rawPull = dy - PULL_ENGAGE_PX;
      prog.set(pullProgress(rawPull, range));
      const now = performance.now();
      samples.push({ t: now, y: e.touches[0].clientY });
      while (samples.length > 1 && now - samples[0].t > 100) samples.shift();
      // Tick once when the pull crosses the commit line, again if you go back.
      const over = rawPull / range > DISMISS_COMMIT;
      if (over !== pastLine) { pastLine = over; hapticLight(); }
    };

    // A cancelled touch (system gesture, palm rejection, incoming call UI) must never commit a minimise
    // from whatever half-way point it was at — it glides back open instead.
    const onTouchCancel = () => {
      if (!engaged) return;
      engaged = false;
      settle(0);
    };

    const onTouchEnd = () => {
      if (!engaged) return;
      engaged = false;
      // Release velocity over the last ~100ms, px/ms (positive = downward).
      const v = releaseVelocity(samples);
      const commit = shouldMinimize(rawPull, range, v);
      // Carry the finger's momentum into the spring-back (signed: a release
      // that is still moving down keeps that motion for a beat before settling,
      // instead of the old reversed sign that jerked the artwork backwards).
      if (!commit) { settle(springVelocity(v, range)); return; }

      hapticMedium();
      // Carry the finger's own speed on into the mini bar, then minimize.
      collapse(Math.max(0, springVelocity(v, range)));
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchCancel);
    };
  }, [sheetMounted, collapse, measureMorph, prog, ty]);
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

  // Queue — derived lists. "Up next" = tracks AFTER the current one; tracks
  // before it are history, shown separately so already-played songs are never
  // mislabelled as upcoming. (Not found in the queue -> everything is upcoming.)
  const curIdx = current ? queue.findIndex((t) => t.id === current.id) : -1;
  const upcoming = curIdx >= 0 ? queue.slice(curIdx + 1) : queue.filter((t) => t.id !== current?.id);
  const earlier = curIdx > 0 ? queue.slice(0, curIdx) : [];
  const MAX_QUEUE_ROWS = 50; // bounded DOM: a 500-song queue must not mount 500 rows
  // Reorder = move up/down buttons (accessible alternative to dragging). Hidden while shuffle is on: then the play
  // order is the shuffle chain, not the list order, so moving rows would not change what plays.
  const reorderOn = reorder && !shuffle && upcoming.length > 1;
  const renderQueueRow = (t: (typeof queue)[number], dim: boolean) => {
    const ui = dim ? -1 : upcoming.findIndex((x) => x.id === t.id);
    const showMove = reorderOn && !dim && ui >= 0;
    return (
    <div key={t.id} data-queue-row className={cn("flex items-center gap-1 pl-2 pr-0.5 rounded-2xl active:bg-foreground/5 transition-colors", dim && "opacity-60")}>
      <button
        onClick={() => { hapticLight(); playTrack(t); setTab("player"); }}
        onPointerDownCapture={stopDragCapture}
        aria-label={`Play ${t.title}`}
        className="flex items-center gap-3 flex-1 min-w-0 py-2 text-left rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
      >
        <img src={t.thumbnail || t.artwork || fallbackArt(t.title, t.artist)} onError={onArtError(t.title, t.artist)} alt="" className="h-11 w-11 rounded-xl object-cover bg-muted shrink-0" loading="lazy" decoding="async" />
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-medium truncate">{t.title}</span>
          <span className="block text-xs text-muted-foreground truncate">{t.artist}</span>
        </span>
      </button>
      {showMove ? (
        <>
          {/* Pointer-only drag handle (keyboard / screen-reader users use the move buttons beside it). data-no-pull +
              touch-action:none keep the sheet's pull-to-minimise and the list scroll from claiming the drag. */}
          <div
            data-no-pull aria-hidden="true"
            style={{ touchAction: "none" }}
            onPointerDownCapture={stopDragCapture}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              const row = e.currentTarget.closest("[data-queue-row]") as HTMLElement | null;
              dragRef.current = { id: t.id, lastY: e.clientY, acc: 0, h: row?.offsetHeight || 56 };
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d || d.id !== t.id) return;
              d.acc += e.clientY - d.lastY;
              d.lastY = e.clientY;
              const { step, rest } = nextDragStep(d.acc, d.h);
              if (step !== 0) { d.acc = rest; hapticLight(); moveInQueue(t.id, step); }
            }}
            onPointerUp={() => { if (dragRef.current?.id === t.id) { dragRef.current = null; setAnnounce(`Moved ${t.title}`); } }}
            onPointerCancel={() => { dragRef.current = null; }}
            className="h-11 w-8 flex items-center justify-center text-muted-foreground/70 cursor-grab active:cursor-grabbing shrink-0"
          >
            <GripVertical className="h-4 w-4" />
          </div>
          <button disabled={ui === 0}
            onClick={(e) => { e.stopPropagation(); hapticLight(); moveInQueue(t.id, -1); setAnnounce(`Moved ${t.title} up to position ${Math.max(ui, 1)} of ${upcoming.length}`); }}
            onPointerDownCapture={stopDragCapture}
            className="h-11 w-11 rounded-full text-muted-foreground active:scale-90 disabled:opacity-30 flex items-center justify-center shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            aria-label={`Move ${t.title} up`}>
            <ChevronUp className="h-4 w-4" />
          </button>
          <button disabled={ui === upcoming.length - 1}
            onClick={(e) => { e.stopPropagation(); hapticLight(); moveInQueue(t.id, 1); setAnnounce(`Moved ${t.title} down to position ${Math.min(ui + 2, upcoming.length)} of ${upcoming.length}`); }}
            onPointerDownCapture={stopDragCapture}
            className="h-11 w-11 rounded-full text-muted-foreground active:scale-90 disabled:opacity-30 flex items-center justify-center shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
            aria-label={`Move ${t.title} down`}>
            <ChevronDown className="h-4 w-4" />
          </button>
        </>
      ) : (
      <button onClick={(e) => { e.stopPropagation(); hapticLight(); removeFromQueue(t.id); }}
        onPointerDownCapture={stopDragCapture}
        className="h-11 w-11 rounded-full text-muted-foreground active:scale-90 flex items-center justify-center shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
        aria-label={`Remove ${t.title} from queue`}>
        <Trash2 className="h-4 w-4" />
      </button>
      )}
    </div>
    );
  };

  // Horizontal swipe-on-artwork for next/prev. Constrained back to 0,0 so it's
  // a pure gesture recognizer; next()/prev() do the real navigation.
  const SWIPE_THRESHOLD = 70;

  const hideScrollbar = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
  const roundBtn = "h-11 w-11 rounded-full bg-foreground/[0.08] backdrop-blur-md flex items-center justify-center active:scale-95 transition-transform";
  const tabs: Array<{ id: PlayerTab; label: string; Icon: typeof Disc3 }> = [
    { id: "player", label: "Player", Icon: Disc3 },
    { id: "lyrics", label: "Lyrics", Icon: AlignLeft },
    { id: "queue", label: "Queue", Icon: ListMusic },
    { id: "info", label: "Details", Icon: Info },
  ];
  const headerLabel =
    tab === "lyrics" ? "Lyrics" : tab === "queue" ? "Queue" : tab === "info" ? "Details"
    : sessionRole === "host" ? "Hosting" : sessionRole === "guest" ? "Listening together" : "Now Playing";

  if (!current) return null;

  const artSize = "clamp(200px, min(calc(100vw - 40px), calc(100dvh - 450px)), 540px)";

  return (
    <AnimatePresence onExitComplete={() => { prog.jump(1); setTab("player"); }}>
      {expanded && (
        <motion.div
          key="groic-full"
          initial={false}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, y: 28, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }}
          className="fixed inset-0 z-[60]"
        >
          <motion.div ref={sheetRef} data-groic-sheet className="absolute inset-0 flex flex-col overflow-hidden">
          {/* Sheet background: opaque base + the artwork's own colours washed
              behind everything, fading out as the artwork folds into the mini bar. */}
          <motion.div aria-hidden="true" className="absolute inset-0 bg-background pointer-events-none" style={{ opacity: bgOpacity, willChange: "opacity" }}>
          <AmbientBackground thumbnail={current.thumbnail || fallbackArt(current.title, current.artist)} />
          {/* Frosted glass over the artwork wash; the blur is dialled down
              while dragging/morphing so the gesture stays smooth. */}
          {/* No backdrop-filter here any more: AmbientBackground is ALREADY the
              artwork blurred 60px, so a 3xl backdrop blur on top of it added
              nothing visible — but it is re-evaluated every frame the sheet
              fades and was the single biggest cost of the pull/open/close. */}
          <div className="absolute inset-0 bg-background/30" />
          <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-background/80 via-background/35 to-transparent pointer-events-none" />
          </motion.div>

          <motion.div
            ref={scrollRef}
            style={{ touchAction: "pan-y" }}
            className="relative z-10 flex-1 min-h-0 flex flex-col safe-top px-5 overflow-y-auto overscroll-contain"
          >
            <div className="flex flex-col min-h-[100dvh]">
            {/* Grabber: the universal "this sheet pulls down" affordance. A tap
                minimises too (for mouse/keyboard users); a touch-drag starting
                here is picked up by the sheet's pull gesture like any other. */}
            <motion.div style={fadeStyle} className="flex justify-center pt-1.5 -mb-1.5">
              <button
                onClick={() => { hapticLight(); collapse(); }}
                aria-label="Minimize player"
                className="h-6 w-20 flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-primary/70 rounded-full"
              >
                <span aria-hidden="true" className="h-1 w-10 rounded-full bg-foreground/25" />
              </button>
            </motion.div>
            {/* Header */}
            <motion.div style={fadeStyle} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 pt-3 pb-3">
              <button onClick={() => { hapticLight(); collapse(); }}
                onPointerDownCapture={stopDragCapture}
                className={roundBtn}
                aria-label="Minimize player">
                <ChevronDown className="h-5 w-5" />
              </button>
              <div className="flex flex-col items-center gap-1 min-w-0">
                <p className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">{headerLabel}</p>
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
                  className={roundBtn}
                  aria-label={sessionRole === "solo" ? "Start shared session" : "End shared session"}
                >
                  {sessionRole === "solo" ? <Users className="h-4 w-4" /> : <UserMinus className="h-4 w-4 text-primary" />}
                </button>
                <button
                  onClick={() => { hapticMedium(); close(); }}
                  onPointerDownCapture={stopDragCapture}
                  className={roundBtn}
                  aria-label="Close player"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </motion.div>

            {/* Stage — swaps with the tab bar below */}
            <div className="relative flex-1 min-h-0 py-1">
              <AnimatePresence initial={false}>
              {tab === "player" && (
                <motion.div key="stage-player" className="absolute inset-0 flex items-center justify-center" style={{ willChange: "transform, opacity" }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }} exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeOut" }, transitionEnd: { pointerEvents: "none" } }}>
                {/* Morph wrapper: owns the fly-to-mini-bar transform. touch-action
                   none makes a vertical drag here always ours, while the inner
                   element keeps its own left/right track-swipe. */}
                <motion.div
                  ref={artRef}
                  data-groic-art
                  className="shrink-0"
                  style={{ x: artX, y: artY, scale: artScale, borderRadius: artRadius, opacity: artOpacity, overflow: artClip, touchAction: "none", transformOrigin: "50% 50%", willChange: "transform" }}
                >
                  <motion.div
                    animate={{ scale: shownPlaying ? 1 : 0.94, opacity: shownPlaying ? 1 : 0.88 }}
                    transition={{ type: "spring", stiffness: 200, damping: 24 }}
                    drag="x"
                    dragConstraints={{ left: 0, right: 0 }}
                    dragElastic={0.55}
                    dragMomentum={false}
                    onDragEnd={(_, info) => {
                      if (info.offset.x <= -SWIPE_THRESHOLD) { hapticLight(); next(); }
                      else if (info.offset.x >= SWIPE_THRESHOLD) { hapticLight(); prev(); }
                    }}
                    className="relative shrink-0 touch-pan-y"
                    style={{ width: artSize, height: artSize }}
                  >
                    <div className="relative h-full w-full rounded-[30px] overflow-hidden bg-muted shadow-[0_28px_70px_-20px_hsl(var(--foreground)/0.5)] ring-1 ring-foreground/10">
                      {/* Non-square art (YouTube's 16:9 thumbnails) is shown whole,
                          never cropped; its own blurred copy fills the rest. */}
                      {artNonSquare && (
                        <img aria-hidden="true" src={current.thumbnail || fallbackArt(current.title, current.artist)} onError={onArtError(current.title, current.artist)} alt="" className="absolute inset-0 h-full w-full object-cover scale-125 blur-xl opacity-80" draggable={false} />
                      )}
                      {/* Song change: the old cover stays and fades out while the new one eases in with a
                          soft settle (scale 1.06 → 1). Same overlap idea as the audio crossfade, and the
                          duration follows the crossfade setting so picture and sound arrive together. */}
                      <AnimatePresence initial={false}>
                        <motion.img
                          key={current.thumbnail || current.id}
                          decoding="async"
                          src={current.thumbnail || fallbackArt(current.title, current.artist)} onError={onArtError(current.title, current.artist)}
                          alt={current.title}
                          onLoad={(e) => { const i = e.currentTarget; setArtNonSquare(Math.abs(i.naturalWidth - i.naturalHeight) > 4); }}
                          initial={{ opacity: 0, scale: 1.06 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: crossfade > 0 ? Math.min(1.2, 0.5 + crossfade * 0.1) : 0.45, ease: [0.22, 1, 0.36, 1] }}
                          className="absolute inset-0 h-full w-full object-contain will-change-[opacity,transform]" draggable={false} />
                      </AnimatePresence>
                      <AnimatePresence initial={false}>
                        {shownPlaying && (
                          <div aria-hidden="true" className="absolute inset-x-0 bottom-3 flex justify-center pointer-events-none">
                            <motion.div
                              initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}
                              transition={{ duration: 0.2 }}
                              className="flex items-end gap-[3px] h-5 px-2.5 py-1 rounded-full bg-black/35 backdrop-blur-sm">
                              {[0.7, 0.45, 0.9, 0.55].map((d, i) => (
                                <motion.span key={i}
                                  className="w-[2.5px] h-3.5 rounded-full bg-white/90 origin-bottom"
                                  animate={{ scaleY: [0.2, 0.9, 0.35] }}
                                  transition={{ repeat: Infinity, duration: d, delay: i * 0.09, ease: "easeInOut" }} />
                              ))}
                            </motion.div>
                          </div>
                        )}
                      </AnimatePresence>
                    </div>
                  </motion.div>
                </motion.div>
                </motion.div>
              )}

              {tab === "lyrics" && (
                <motion.div key="stage-lyrics" className="absolute inset-0 flex items-center justify-center" style={{ willChange: "transform, opacity" }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }} exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeOut" }, transitionEnd: { pointerEvents: "none" } }}>
                <motion.div key="lyrics" style={fadeStyle} className="h-full w-full min-h-[240px] -mx-1">
                  <GroicLyrics track={current} seek={seek} />
                </motion.div>
                </motion.div>
              )}

              {tab === "queue" && (
                <motion.div key="stage-queue" className="absolute inset-0 flex items-center justify-center" style={{ willChange: "transform, opacity" }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }} exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeOut" }, transitionEnd: { pointerEvents: "none" } }}>
                <motion.div key="queue" style={fadeStyle} className="h-full w-full min-h-[240px]">
                  <motion.div className="h-full rounded-[28px] glass-player p-2 flex flex-col">
                    <div className="flex items-center gap-2 px-3 pt-2 pb-1 shrink-0">
                      <ListMusic className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                      <span className="flex-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                        Up next{upcoming.length > 0 ? ` · ${upcoming.length}` : ""}
                      </span>
                      {upcoming.length > 1 && !shuffle && (
                        <button onClick={() => { hapticLight(); setReorder((v) => !v); setAnnounce(""); }}
                          onPointerDownCapture={stopDragCapture}
                          aria-pressed={reorderOn}
                          aria-label={reorderOn ? "Done reordering the queue" : "Reorder the queue"}
                          className="h-11 px-3 -my-2 rounded-full text-[12px] font-semibold text-primary active:scale-95 flex items-center gap-1.5 outline-none focus-visible:ring-2 focus-visible:ring-primary/70">
                          <ArrowUpDown className="h-3.5 w-3.5" aria-hidden="true" /> {reorderOn ? "Done" : "Reorder"}
                        </button>
                      )}
                      <p role="status" aria-live="polite" className="sr-only">{announce}</p>
                    </div>
                    <div data-inner-scroll style={{ touchAction: "pan-y" }} className={cn("flex-1 min-h-0 overflow-y-auto overscroll-contain", hideScrollbar)}>
                      {upcoming.length === 0 && (
                        <p className="px-3 py-4 text-[12px] text-muted-foreground">Nothing queued after this song.{autoNext ? " Auto-next will add more." : ""}</p>
                      )}
                      {upcoming.slice(0, MAX_QUEUE_ROWS).map((t) => renderQueueRow(t, false))}
                      {upcoming.length > MAX_QUEUE_ROWS && (
                        <p className="px-3 py-2 text-[11px] text-muted-foreground">+{upcoming.length - MAX_QUEUE_ROWS} more in the queue</p>
                      )}
                      {earlier.length > 0 && (
                        <>
                          <p className="px-3 pt-3 pb-1 text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Played earlier</p>
                          {earlier.slice(-MAX_QUEUE_ROWS).map((t) => renderQueueRow(t, true))}
                        </>
                      )}
                    </div>
                    {queue.length > 1 && (
                      <button
                        onClick={() => { hapticLight(); clearQueue(); setTab("player"); }}
                        onPointerDownCapture={stopDragCapture}
                        className="w-full h-11 mt-1 shrink-0 rounded-2xl text-[12px] font-semibold text-muted-foreground active:bg-foreground/5"
                      >
                        Clear queue
                      </button>
                    )}
                  </motion.div>
                </motion.div>
                </motion.div>
              )}

              {tab === "info" && (
                <motion.div key="stage-info" className="absolute inset-0 flex items-center justify-center" style={{ willChange: "transform, opacity" }} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } }} exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeOut" }, transitionEnd: { pointerEvents: "none" } }}>
                <motion.div key="info" style={fadeStyle} className="h-full w-full min-h-[240px]">
                  <motion.div data-inner-scroll style={{ touchAction: "pan-y" }} className={cn("h-full rounded-[28px] glass-player p-5 overflow-y-auto overscroll-contain", hideScrollbar)}>
                    <div className="flex items-center gap-4">
                      <img src={current.thumbnail || fallbackArt(current.title, current.artist)} onError={onArtError(current.title, current.artist)} alt="" className="h-20 w-20 rounded-2xl object-cover bg-muted shrink-0" decoding="async" />
                      <div className="min-w-0">
                        <p className="text-lg font-bold leading-tight line-clamp-2">{current.title}</p>
                        <p className="text-sm text-muted-foreground truncate">{current.artist}</p>
                      </div>
                    </div>
                    <dl className="mt-5 divide-y divide-border/50 text-sm">
                      <div className="flex justify-between py-3"><dt className="text-muted-foreground">Source</dt><dd><ProviderChip provider={current.provider} /></dd></div>
                      {current.album && <div className="flex justify-between gap-4 py-3"><dt className="text-muted-foreground">Album</dt><dd className="truncate">{current.album}</dd></div>}
                      {current.duration > 0 && <div className="flex justify-between py-3"><dt className="text-muted-foreground">Length</dt><dd className="font-mono tabular-nums">{fmt(current.duration)}</dd></div>}
                      <div className="flex justify-between py-3"><dt className="text-muted-foreground">Session</dt><dd>{sessionRole === "solo" ? "Listening solo" : partnerListening ? "Partner listening live" : "Waiting for partner"}</dd></div>
                      {isCrossfadeSupported() && (
                        <div className="py-3">
                          <div className="flex justify-between"><dt className="text-muted-foreground">Crossfade</dt><dd className="font-mono tabular-nums">{crossfade === 0 ? "Off" : `${crossfade}s`}</dd></div>
                          <div role="radiogroup" aria-label="Crossfade length" className="mt-2.5 grid grid-cols-5 gap-1.5">
                            {CROSSFADE_OPTIONS.map((sec) => (
                              <button key={sec} role="radio" aria-checked={crossfade === sec}
                                onClick={() => { hapticLight(); setCrossfade(sec); setCrossfadeSeconds(sec); }}
                                className={cn("h-9 rounded-full text-xs font-semibold transition-colors active:scale-95", crossfade === sec ? "bg-primary text-primary-foreground" : "bg-foreground/[0.08] text-muted-foreground")}>
                                {sec === 0 ? "Off" : `${sec}s`}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {downloadEligible && <div className="flex justify-between py-3"><dt className="text-muted-foreground">Offline</dt><dd>{downloaded ? "Downloaded" : "Not downloaded"}</dd></div>}
                    </dl>
                  </motion.div>
                </motion.div>
                </motion.div>
              )}
              </AnimatePresence>
            </div>

            {/* Title pill — title/artist left, quick actions right */}
            <motion.div style={fadeStyle} className="mt-4 rounded-[28px] glass-player p-3 pl-4 flex items-center gap-3">
              <motion.div key={current.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={CONTENT_FADE} className="min-w-0 flex-1">
                <p className="text-[17px] leading-tight font-bold tracking-tight truncate">{current.title}</p>
                <p className="text-[13px] text-muted-foreground truncate">{current.artist}</p>
                {current.twinOfId && (
                  // The YouTube entry could not keep playing in the background, so a matching SoundCloud/Audius upload is
                  // playing instead — a different recording than the one queued; say so rather than pass it off as identical.
                  <p className="text-[11px] mt-0.5 text-muted-foreground">Background version · {current.provider === "audius" ? "Audius" : "SoundCloud"}</p>
                )}
                {sessionRole !== "solo" && (
                  <p className="text-[10px] mt-1 text-primary font-medium">
                    {partnerListening ? "● Partner listening live" : "○ Waiting for partner"}
                  </p>
                )}
                {error && <p className="text-[11px] mt-1 text-destructive">{error}</p>}
                {progress !== "idle" && typeof progress === "number" && (
                  <p className="text-[10px] mt-1 text-muted-foreground">Downloading… {Math.round(progress * 100)}%</p>
                )}
              </motion.div>
              <div className="flex items-center gap-1.5 shrink-0">
                {/* Auto-next keeps the queue topped up from what you actually play. */}
                <button
                  onClick={() => { hapticLight(); toggleAutoNext(); toast({ title: autoNext ? "Auto-next off" : "Auto-next on", description: autoNext ? "Playback stops at the end of the queue." : "Songs you'll like keep playing after the queue." }); }}
                  onPointerDownCapture={stopDragCapture}
                  aria-pressed={autoNext}
                  aria-label={autoNext ? "Turn off auto-next" : "Turn on auto-next"}
                  className={cn(roundBtn, "h-10 w-10", autoNext ? "text-primary" : "text-muted-foreground")}
                >
                  <Sparkles className="h-[18px] w-[18px]" />
                </button>
                {downloadEligible && (
                  <button
                    onClick={handleDownloadToggle}
                    onPointerDownCapture={stopDragCapture}
                    disabled={progress !== "idle"}
                    aria-label={downloaded ? "Remove downloaded copy" : "Download for offline playback"}
                    className={cn(roundBtn, "h-10 w-10", downloaded ? "text-primary" : "text-muted-foreground")}
                  >
                    {progress !== "idle" ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : downloaded ? <CheckCircle2 className="h-[18px] w-[18px]" /> : <Download className="h-[18px] w-[18px]" />}
                  </button>
                )}
                <button
                  onClick={() => { hapticMedium(); const on = toggleLiked(current); toast({ title: on ? "Added to Liked Songs" : "Removed from Liked Songs" }); }}
                  onPointerDownCapture={stopDragCapture}
                  aria-pressed={liked}
                  aria-label={liked ? "Remove from Liked Songs" : "Add to Liked Songs"}
                  className={cn(roundBtn, "h-10 w-10", liked ? "text-primary" : "text-muted-foreground")}
                >
                  <Heart className="h-[18px] w-[18px]" fill={liked ? "currentColor" : "none"} />
                </button>
              </div>
            </motion.div>

            {/* Progress */}
            <motion.div style={fadeStyle} className="space-y-1 mt-3 px-1">
              <SeekBar seek={seek} />
            </motion.div>

            {/* Transport: shuffle · prev · play · next · repeat */}
            <motion.div style={fadeStyle} className="flex items-center justify-between px-1 mt-2">
              <button
                onClick={() => { hapticLight(); toggleShuffle(); }}
                onPointerDownCapture={stopDragCapture}
                aria-pressed={shuffle}
                aria-label={shuffle ? "Disable shuffle" : "Enable shuffle"}
                className={cn("h-11 w-11 rounded-full flex items-center justify-center active:scale-90 transition-transform relative", shuffle ? "text-primary" : "text-muted-foreground")}
              >
                <Shuffle className="h-[18px] w-[18px]" />
                {shuffle && <span aria-hidden="true" className="absolute bottom-1 h-1 w-1 rounded-full bg-primary" />}
              </button>
              <SkipButton
                dir="prev" label="Previous" filled iconClassName="h-5 w-5"
                onSkip={() => { hapticLight(); prev(); }}
                onPointerDownCapture={stopDragCapture}
                className="h-14 w-14 rounded-full bg-foreground/[0.08] backdrop-blur-md flex items-center justify-center active:scale-90 transition-transform"
              />
              <button onClick={() => { hapticMedium(); toggle(); }}
                onPointerDownCapture={stopDragCapture}
                className="h-[72px] w-[72px] rounded-full bg-foreground/[0.14] backdrop-blur-xl ring-1 ring-foreground/10 shadow-[0_14px_36px_-12px_hsl(var(--foreground)/0.5)] flex items-center justify-center active:scale-95 transition-transform"
                aria-label={isBusy ? "Loading" : shownPlaying ? "Pause" : "Play"}
                aria-busy={isBusy}>
                <PlayPauseIcon busy={isBusy} playing={shownPlaying} filled className="h-7 w-7" playOffset="ml-1" />
              </button>
              <SkipButton
                dir="next" label="Next" filled iconClassName="h-5 w-5"
                onSkip={() => { hapticLight(); next(); }}
                onPointerDownCapture={stopDragCapture}
                className="h-14 w-14 rounded-full bg-foreground/[0.08] backdrop-blur-md flex items-center justify-center active:scale-90 transition-transform"
              />
              <button
                onClick={() => { hapticLight(); setRepeatMode(repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off"); }}
                onPointerDownCapture={stopDragCapture}
                aria-label={`Repeat: ${repeatMode}`}
                className={cn("h-11 w-11 rounded-full flex items-center justify-center active:scale-90 transition-transform relative", repeatMode !== "off" ? "text-primary" : "text-muted-foreground")}
              >
                {repeatMode === "one" ? <Repeat1 className="h-[18px] w-[18px]" /> : <Repeat className="h-[18px] w-[18px]" />}
                {repeatMode !== "off" && <span aria-hidden="true" className="absolute bottom-1 h-1 w-1 rounded-full bg-primary" />}
              </button>
            </motion.div>

            {(isBusy || error) && (
              <div className="mt-3 flex min-h-[20px] items-center justify-center" role="status" aria-live="polite">
                {slowLoad ? (
                  <>
                  <button
                    onClick={() => { hapticLight(); retry(); setSlowLoad(false); }}
                    onPointerDownCapture={stopDragCapture}
                    className="rounded-full bg-foreground/[0.08] px-3.5 py-1.5 text-xs font-medium text-primary backdrop-blur-md active:scale-95 transition-transform"
                  >
                    Taking longer than usual · Tap to retry
                  </button>
                    <DiagnosticsLink />
                  </>
                ) : isBusy ? (
                  <span className="text-xs text-muted-foreground">Loading…</span>
                ) : (
                  <span className="text-xs text-destructive">{error}</span>
                )}
              </div>
            )}

            {/* Floating tab pill */}
            <motion.div style={fadeStyle} className="mt-4 flex justify-center pb-[max(env(safe-area-inset-bottom),14px)]">
              <div role="tablist" aria-label="Player view" className="glass-player rounded-full p-1.5 flex items-center gap-1">
                {tabs.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={tab === id}
                    aria-label={label}
                    onClick={() => { hapticLight(); setTab(id); }}
                    onPointerDownCapture={stopDragCapture}
                    className={cn(
                      "h-10 w-16 rounded-full flex items-center justify-center transition-colors active:scale-95",
                      tab === id ? "bg-foreground/[0.14] text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <Icon className="h-[18px] w-[18px]" />
                  </button>
                ))}
              </div>
            </motion.div>
            </div>
          </motion.div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default GroicFullPlayer;
