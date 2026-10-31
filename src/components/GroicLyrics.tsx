import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw, Music2, LocateFixed } from "lucide-react";
import { useGroicProgress } from "@/contexts/GroicContext";
import { activeLineIndex, useLyrics, type LyricLine } from "@/lib/music/lyrics";
import type { GroicTrack } from "@/lib/music/types";
import { hapticLight } from "@/lib/haptics";
import { cn } from "@/lib/utils";

/**
 * Lyrics stage of the full player (Lyrics tab).
 *
 *  - Time-synced when LRCLIB has an LRC for the song: the current line is full
 *    brightness, the rest recede (and soften with distance), and the list
 *    follows playback by itself.
 *  - Touching/scrolling the list pauses auto-follow for a few seconds so it
 *    never fights the finger; "Jump to current" brings it straight back.
 *  - Tapping a line seeks to it.
 *  - Falls back to plain scrollable text, or a calm empty/error state.
 *
 * Only this component subscribes to playback position, so the twice-a-second
 * tick re-renders just the lyric list, not the whole player.
 */

const PAUSE_FOLLOW_MS = 4000;

const hideScrollbar = "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
// Edge fades are plain gradient overlays, NOT mask-image/filter: a mask on a
// scrolling container (or a blur filter per line) forces an offscreen
// re-render of the whole list every scroll frame, which janks Android WebViews.
function EdgeFades() {
  return (
    <>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-background/80 to-transparent" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-background/80 to-transparent" />
    </>
  );
}

interface ListProps {
  lines: LyricLine[];
  active: number;
  lineRefs: React.MutableRefObject<Array<HTMLButtonElement | null>>;
  onTap: (t: number) => void;
}
/** Re-renders only when the active line changes — not on every position tick. */
const SyncedList = memo(function SyncedList({ lines, active, lineRefs, onTap }: ListProps) {
  return (
    <>
      {lines.map((line, i) => {
        const d = Math.abs(i - active);
        const isActive = i === active;
        return (
          <button
            key={`${i}-${line.t}`}
            ref={(el) => { lineRefs.current[i] = el; }}
            onClick={() => onTap(line.t)}
            aria-current={isActive ? "true" : undefined}
            className={cn(
              "block w-full text-left py-[7px] text-[24px] leading-[1.25] font-bold tracking-tight",
              "origin-left transition-[opacity,transform,filter] duration-300 ease-out outline-none",
              isActive ? "text-foreground opacity-100 scale-100" : "text-foreground scale-[0.97]",
              !isActive && (d <= 1 ? "opacity-50" : d <= 3 ? "opacity-35" : "opacity-25"),
            )}
            style={!isActive && d >= 1 && d <= 4 ? { filter: `blur(${(d * 0.55).toFixed(2)}px)` } : undefined}
          >
            {line.text}
          </button>
        );
      })}
    </>
  );
});

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="h-full w-full flex flex-col items-center justify-center gap-3 px-8 text-center">{children}</div>;
}

export default function GroicLyrics({ track, seek }: { track: GroicTrack; seek: (sec: number) => void }) {
  const { state, retry } = useLyrics(track, true);
  const { position } = useGroicProgress();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [paused, setPaused] = useState(false);
  const pauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const synced = state.status === "ready" ? state.data.synced : null;
  const active = useMemo(() => (synced ? activeLineIndex(synced, position) : -1), [synced, position]);

  const holdFollow = () => {
    setPaused(true);
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    pauseTimer.current = setTimeout(() => setPaused(false), PAUSE_FOLLOW_MS);
  };
  const resumeFollow = () => {
    if (pauseTimer.current) clearTimeout(pauseTimer.current);
    setPaused(false);
  };
  useEffect(() => () => { if (pauseTimer.current) clearTimeout(pauseTimer.current); }, []);

  // New song → start at the top and follow again.
  useEffect(() => {
    lineRefs.current = [];
    resumeFollow();
    scrollRef.current?.scrollTo({ top: 0 });
  }, [track.id]);

  // Keep the current line roughly 40% down the viewport.
  useEffect(() => {
    if (!synced || paused || active < 0) return;
    const box = scrollRef.current;
    const el = lineRefs.current[active];
    if (!box || !el) return;
    const top = el.offsetTop - box.clientHeight * 0.4 + el.clientHeight / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }, [active, paused, synced]);

  const onTapLine = useCallback((t: number) => { hapticLight(); seek(t); resumeFollow(); }, [seek]); // eslint-disable-line react-hooks/exhaustive-deps

  if (state.status === "idle" || state.status === "loading") {
    return (
      <Centered>
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">Finding lyrics…</p>
      </Centered>
    );
  }

  if (state.status === "error") {
    return (
      <Centered>
        <p className="text-base font-semibold">Couldn't load lyrics</p>
        <p className="text-xs text-muted-foreground max-w-[18rem]">Check your connection and try again. Playback isn't affected.</p>
        <button
          onClick={() => { hapticLight(); retry(); }}
          className="mt-1 inline-flex items-center gap-2 h-11 px-5 rounded-full glass-player text-sm font-semibold active:scale-95 transition-transform"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
        </button>
      </Centered>
    );
  }

  if (state.status === "none" || (state.status === "ready" && state.data.instrumental)) {
    const instrumental = state.status === "ready";
    return (
      <Centered>
        <Music2 className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
        <p className="text-base font-semibold">{instrumental ? "Instrumental" : "No lyrics for this song"}</p>
        <p className="text-xs text-muted-foreground max-w-[18rem]">
          {instrumental ? "Nothing to sing along to here — just enjoy it." : "We couldn't find a match. It may be a new release, a remix, or a rare upload."}
        </p>
        {!instrumental && (
          <button
            onClick={() => { hapticLight(); retry(); }}
            className="mt-1 inline-flex items-center gap-2 h-11 px-5 rounded-full glass-player text-sm font-semibold active:scale-95 transition-transform"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Search again
          </button>
        )}
      </Centered>
    );
  }

  const data = state.data;

  // Plain, un-timed lyrics.
  if (!synced) {
    return (
      <div className="relative h-full">
        <div
          ref={scrollRef}
          data-inner-scroll
          style={{ touchAction: "pan-y" }}
          className={cn("h-full overflow-y-auto overscroll-contain px-6 py-10", hideScrollbar)}
        >
          <p className="whitespace-pre-line text-[19px] leading-[1.55] font-semibold text-foreground/85">{data.plain}</p>
          <p className="mt-8 text-center text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Lyrics · LRCLIB</p>
        </div>
        <EdgeFades />
      </div>
    );
  }

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        data-inner-scroll
        onTouchStart={holdFollow}
        onWheel={holdFollow}
        style={{ touchAction: "pan-y", paddingTop: "34%", paddingBottom: "46%" }}
        className={cn("h-full overflow-y-auto overscroll-contain px-6", hideScrollbar)}
      >
        <SyncedList lines={synced} active={active} lineRefs={lineRefs} onTap={onTapLine} />
        <p className="mt-10 text-center text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Lyrics · LRCLIB</p>
      </div>

      <EdgeFades />
      {paused && active >= 0 && (
        <button
          onClick={() => { hapticLight(); resumeFollow(); }}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 h-9 px-4 rounded-full glass-player text-xs font-semibold active:scale-95 transition-transform"
        >
          <LocateFixed className="h-3.5 w-3.5" aria-hidden="true" /> Jump to current
        </button>
      )}
    </div>
  );
}
