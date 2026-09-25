import { useState, useRef, useEffect, useCallback } from "react";
import { Play, Pause } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { hapticTick } from "@/lib/haptics";
import { quickSpring, DUR_FAST } from "@/lib/motion";

// ─── VoiceMessagePlayer ───────────────────────────────────────────────────────
// Pure presentational component: takes a src URL + isMine, owns only its own
// playback/waveform UI state. No business/data logic — extracted unchanged
// from pages/Chat.tsx (Phase 3 UI/state decomposition).
const VoiceMessagePlayer = ({ src, isMine }: { src: string; isMine: boolean }) => {
  const [playing, setPlaying]     = useState(false);
  const [progress, setProgress]   = useState(0);
  const [duration, setDuration]   = useState(0);
  const [waveform, setWaveform]   = useState<number[]>(Array(20).fill(0.3));
  const audioRef     = useRef<HTMLAudioElement>(null);
  const analyserRef  = useRef<AnalyserNode | null>(null);
  const audioCtxRef  = useRef<AudioContext | null>(null);
  const srcConnected = useRef(false);
  const animFrameRef = useRef<number>(0);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime   = () => setProgress(a.currentTime);
    const onLoaded = () => setDuration(a.duration);
    const onEnded  = () => { setPlaying(false); setProgress(0); setWaveform(Array(20).fill(0.3)); cancelAnimationFrame(animFrameRef.current); };
    a.addEventListener("timeupdate",    onTime);
    a.addEventListener("loadedmetadata",onLoaded);
    a.addEventListener("ended",         onEnded);
    return () => {
      a.removeEventListener("timeupdate",    onTime);
      a.removeEventListener("loadedmetadata",onLoaded);
      a.removeEventListener("ended",         onEnded);
      cancelAnimationFrame(animFrameRef.current);
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") audioCtxRef.current.close();
    };
  }, []);

  const startVisualizer = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new AudioContext();
        srcConnected.current = false;
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();
      if (!srcConnected.current) {
        const src  = ctx.createMediaElementSource(a);
        const anal = ctx.createAnalyser();
        anal.fftSize = 64;
        src.connect(anal); anal.connect(ctx.destination);
        analyserRef.current  = anal;
        srcConnected.current = true;
      }
      const update = () => {
        if (!analyserRef.current) return;
        const d = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(d);
        setWaveform(Array(20).fill(0).map((_,i) => Math.max(0.15,(d[i]||0)/255)));
        animFrameRef.current = requestAnimationFrame(update);
      };
      update();
    } catch { /* already connected */ }
  }, []);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); cancelAnimationFrame(animFrameRef.current); }
    else          { a.play(); startVisualizer(); }
    setPlaying(!playing);
  };

  const fmt = (s: number) => (!s || !isFinite(s)) ? "0:00" : `${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,"0")}`;

  const seekToClientX = useCallback((clientX: number, rect: DOMRect) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    a.currentTime = ratio * duration;
    setProgress(a.currentTime);
  }, [duration]);

  // One-handed-use: seeking was tap-only (jump to a point) — a natural
  // scrub gesture (press and drag back/forward across the waveform) took
  // several separate taps instead of one continuous motion. Pointer events
  // unify mouse+touch (same reasoning as the composer's hold-to-record
  // button) with capture so the drag tracks correctly even if the finger
  // wanders slightly outside the bar's bounds.
  const isSeekingRef = useRef(false);
  const onSeekPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    isSeekingRef.current = true;
    hapticTick();
    seekToClientX(e.clientX, e.currentTarget.getBoundingClientRect());
  };
  const onSeekPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isSeekingRef.current) return;
    seekToClientX(e.clientX, e.currentTarget.getBoundingClientRect());
  };
  const endSeek = () => { isSeekingRef.current = false; };

  return (
    <div className="flex items-center gap-2.5 min-w-[180px]">
      <audio ref={audioRef} src={src} preload="metadata" crossOrigin="anonymous" />
      {/* MICRO-DETAIL: was a bare CSS active:scale-95 — every other primary
          control in the app (dock tabs, composer send, grid menu items)
          converged on a shared spring-driven press per Phase 2.5's motion
          language; this was the one leftover CSS-only press in Chat. Also
          added a quick crossfade between the Play/Pause glyphs instead of
          an instant swap — matches DUR_FAST (140ms), the token already
          used for icon-swap-scale micro-feedback elsewhere. */}
      <motion.button onClick={() => { toggle(); }} aria-label={playing ? "Pause voice message" : "Play voice message"}
        whileTap={{ scale: 0.94 }} transition={quickSpring}
        className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 transition-colors overflow-hidden ${
          isMine ? "bg-primary-foreground/20 hover:bg-primary-foreground/30" : "bg-accent/15 hover:bg-accent/25"
        }`}>
        <AnimatePresence mode="wait" initial={false}>
          {playing
            ? <motion.span key="pause" initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.7 }} transition={{ duration: DUR_FAST }} className="flex">
                <Pause className={`h-4 w-4 ${isMine?"text-primary-foreground":"text-accent"}`} aria-hidden="true" />
              </motion.span>
            : <motion.span key="play" initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.7 }} transition={{ duration: DUR_FAST }} className="flex">
                <Play className={`h-4 w-4 ml-0.5 ${isMine?"text-primary-foreground":"text-accent"}`} aria-hidden="true" />
              </motion.span>}
        </AnimatePresence>
      </motion.button>
      <div className="flex-1 space-y-1">
        <div className="flex items-end gap-[2px] h-5 cursor-pointer touch-none"
          onPointerDown={onSeekPointerDown} onPointerMove={onSeekPointerMove}
          onPointerUp={endSeek} onPointerCancel={endSeek}
          role="slider" aria-label="Seek voice message" aria-valuemin={0} aria-valuemax={Math.round(duration)||0} aria-valuenow={Math.round(progress)}>
          {waveform.map((h,i) => (
            <div key={i} aria-hidden="true" className={`flex-1 rounded-full transition-all duration-75 ${
              duration && (i/waveform.length)<=(progress/duration)
                ? (isMine?"bg-primary-foreground/70":"bg-accent/70")
                : (isMine?"bg-primary-foreground/25":"bg-foreground/15")
            }`} style={{ height:`${Math.max(15,h*100)}%` }} />
          ))}
        </div>
        <p className={`text-[10px] font-mono ${isMine?"text-primary-foreground/60":"text-muted-foreground"}`}>{fmt(progress>0?progress:duration)}</p>
      </div>
    </div>
  );
};

export default VoiceMessagePlayer;
