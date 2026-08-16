import { useState, useRef, useEffect, useCallback } from "react";
import { Play, Pause } from "lucide-react";
import { hapticTick } from "@/lib/haptics";

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

  const seekTo = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    a.currentTime = ((e.clientX - r.left) / r.width) * duration;
  };

  return (
    <div className="flex items-center gap-2.5 min-w-[180px]">
      <audio ref={audioRef} src={src} preload="metadata" crossOrigin="anonymous" />
      <button onClick={() => { hapticTick(); toggle(); }} aria-label={playing ? "Pause voice message" : "Play voice message"}
        className={`h-9 w-9 rounded-full flex items-center justify-center shrink-0 transition-colors active:scale-95 ${
          isMine ? "bg-primary-foreground/20 hover:bg-primary-foreground/30" : "bg-accent/15 hover:bg-accent/25"
        }`}>
        {playing
          ? <Pause className={`h-4 w-4 ${isMine?"text-primary-foreground":"text-accent"}`} aria-hidden="true" />
          : <Play className={`h-4 w-4 ml-0.5 ${isMine?"text-primary-foreground":"text-accent"}`} aria-hidden="true" />}
      </button>
      <div className="flex-1 space-y-1">
        <div className="flex items-end gap-[2px] h-5 cursor-pointer" onClick={(e) => { hapticTick(); seekTo(e); }}>
          {waveform.map((h,i) => (
            <div key={i} className={`flex-1 rounded-full transition-all duration-75 ${
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
