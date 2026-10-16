import { memo, useCallback, useEffect, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Play, MoreHorizontal, Heart, ListPlus, ListEnd, ListMusic, UserSearch, ChevronRight, Library } from "lucide-react";
import type { GroicTrack } from "@/lib/music/types";
import { cn } from "@/lib/utils";
import { hapticLight } from "@/lib/haptics";
import { fallbackArt } from "@/lib/music/fallbackArt";
import { toneFor, WINE_CHIP, WINE_SURFACE } from "@/lib/music/palette";
import { Drawer, DrawerContent, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";

/* ─── Small atoms ─────────────────────────────────────────────────────────── */

const PROVIDER_LABEL: Record<string, string> = { soundcloud: "SoundCloud", youtube: "YouTube", audius: "Audius", jamendo: "Free Music", local: "My Files" };
const PROVIDER_DOT: Record<string, string> = { soundcloud: "bg-[#ff5500]", youtube: "bg-[#ff0033]", audius: "bg-[#cc0fe0]", jamendo: "bg-[#ff0066]", local: "bg-success" };

/** Small "where this track comes from" chip (SoundCloud / YouTube / Audius / Offline). */
export const ProviderBadge = ({ provider, size = "md" }: { provider?: string; size?: "sm" | "md" }) => {
  if (!provider) return null;
  const label = PROVIDER_LABEL[provider] ?? provider;
  const dot = PROVIDER_DOT[provider] ?? "bg-muted-foreground";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-muted/60 text-muted-foreground shrink-0",
        size === "sm" ? "px-1.5 py-[1px] text-[9px]" : "px-2 py-0.5 text-[10px]",
      )}
    >
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
};

export const artOf = (t: Pick<GroicTrack, "artwork" | "thumbnail">): string | null => t.artwork || t.thumbnail || null;

/** Animated "now playing" bars — transform-only (scaleY), no layout work. */
export const Equalizer = ({ className, paused }: { className?: string; paused?: boolean }) => {
  // Reduced-motion: show static bars instead of the looping animation.
  const still = paused || !!useReducedMotion();
  return (
    <span aria-hidden="true" className={cn("inline-flex items-end gap-[2px] h-3.5", className)}>
      {[0.7, 0.45, 0.9].map((d, i) => (
        <motion.span
          key={i}
          className="w-[3px] h-3.5 rounded-full bg-current origin-bottom"
          animate={still ? { scaleY: paused ? 0.3 : 0.7 } : { scaleY: [0.25, 1, 0.4] }}
          transition={still ? { duration: 0.2 } : { repeat: Infinity, duration: d, delay: i * 0.1, ease: "easeInOut" }}
        />
      ))}
    </span>
  );
};

/** Shared keyboard-focus ring for every tappable music element. */
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-primary/70 focus-visible:ring-offset-0";

/** PERF: SoundCloud artwork arrives as a 500x500 image; every card/row here is
 *  <=140px, so decoding 24+ of those per rail was a big part of the scroll
 *  jank. SoundCloud serves a 300x300 variant at the same URL pattern. */
const thumbUrl = (src: string | null): string | null =>
  src && src.includes("sndcdn.com") ? src.replace("-t500x500.", "-t300x300.") : src;

/** Square artwork. Never blank: with a `seed` (title/artist) a missing or broken image is replaced by
 *  generated artwork, so every track always has a cover. */
export const Cover = ({ src, alt = "", className, rounded = "rounded-xl", seed }: { src: string | null; alt?: string; className?: string; rounded?: string; seed?: { title?: string | null; artist?: string | null } }) => {
  const url = thumbUrl(src);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  const shown = url && !failed ? url : seed ? fallbackArt(seed.title, seed.artist) : null;
  return (
    <div className={cn("relative overflow-hidden bg-gradient-to-br from-primary/35 via-accent/30 to-muted shrink-0", rounded, className)}>
      {shown && <img src={shown} alt={alt} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-cover" />}
    </div>
  );
};

export const ProviderDot = ({ provider }: { provider: string }) => (
  <span aria-label={PROVIDER_LABEL[provider] ?? provider} title={PROVIDER_LABEL[provider] ?? provider}
    className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", PROVIDER_DOT[provider] ?? "bg-muted-foreground")} />
);

/* ─── Section header + horizontal shelf ───────────────────────────────────── */

export const Shelf = ({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode }) => (
  <section aria-label={title} style={{ contentVisibility: "auto", containIntrinsicSize: "auto 230px" }}>
    <div className="flex items-end justify-between gap-3 mb-3">
      <div className="min-w-0">
        <h2 className="text-[24px] leading-tight font-extrabold tracking-[-0.02em] truncate">{title}</h2>
        {subtitle && <p className="text-[12.5px] text-muted-foreground mt-1 truncate">{subtitle}</p>}
      </div>
      {action}
    </div>
    {children}
  </section>
);

export const ScrollRow = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("flex gap-3.5 overflow-x-auto snap-x snap-proximity pb-1 -mx-5 px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
    {children}
  </div>
);

/* ─── Cards / tiles / rows ────────────────────────────────────────────────── */

interface TrackHandlers {
  onPlay: () => void;
  onMore: () => void;
}

/** Rail card — big cover, play FAB, now-playing state, "…" for actions. */
export const CoverCard = memo(({ track, isCurrent, isPlaying, onPlay, onMore }: { track: GroicTrack; isCurrent: boolean; isPlaying: boolean } & TrackHandlers) => (
  <div className="shrink-0 w-[156px] snap-start">
    <div className="relative">
      <button onClick={onPlay} aria-label={`Play ${track.title}`} className={cn("block w-full rounded-[18px] active:scale-[0.96] transition-transform duration-200 ease-out", FOCUS)}>
        <Cover src={artOf(track)} seed={track} className="aspect-square w-full shadow-[0_18px_34px_-14px_hsl(var(--foreground)/0.55),0_2px_6px_-2px_hsl(var(--foreground)/0.25)] ring-1 ring-foreground/10" rounded="rounded-[18px]" />
      </button>
      <span className={cn(
        "pointer-events-none absolute bottom-2 right-2 h-9 w-9 rounded-full flex items-center justify-center shadow-lg",
        isCurrent ? "bg-primary text-primary-foreground" : "bg-background/90 text-foreground",
      )}>
        {isCurrent ? <Equalizer paused={!isPlaying} className="h-3" /> : <Play className="h-4 w-4 ml-0.5" fill="currentColor" />}
      </span>
    </div>
    <div className="mt-2 flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <p className={cn("text-[14px] font-semibold leading-snug tracking-[-0.01em] line-clamp-1", isCurrent && "text-primary")}>{track.title}</p>
        <p className="text-[12.5px] text-muted-foreground truncate mt-0.5 flex items-center gap-1.5">
          <ProviderDot provider={track.provider} /><span className="truncate">{track.artist}</span>
        </p>
      </div>
      <button onClick={onMore} aria-label={`More options for ${track.title}`} className={cn("h-11 w-11 -mr-2.5 -mt-2 rounded-full text-muted-foreground active:scale-90 flex items-center justify-center shrink-0", FOCUS)}>
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </div>
  </div>
));
CoverCard.displayName = "CoverCard";

/** Spotify-style compact quick-pick tile (cover + title, one tap to play). */
export const QuickTile = memo(({ title, cover, icon, isCurrent, onClick }: { title: string; cover?: string | null; icon?: ReactNode; isCurrent?: boolean; onClick: () => void }) => (
  <button onClick={onClick}
    className={cn(
      "flex items-center gap-3 h-16 rounded-2xl overflow-hidden bg-card/90 border border-border/40 shadow-[0_8px_20px_-14px_hsl(var(--foreground)/0.45)] text-left active:scale-[0.98] transition-transform", FOCUS,
      isCurrent && "border-primary/40 bg-primary/10",
    )}>
    {icon
      ? <span className={cn("h-16 w-16 shrink-0 flex items-center justify-center", WINE_CHIP)}>{icon}</span>
      : <Cover src={cover ?? null} seed={{ title }} className="h-16 w-16" rounded="rounded-none" />}
    <span className={cn("text-[13.5px] font-semibold leading-tight line-clamp-2 pr-2 flex-1 min-w-0", isCurrent && "text-primary")}>{title}</span>
    {isCurrent && <Equalizer className="text-primary mr-2.5 h-3" />}
  </button>
));
QuickTile.displayName = "QuickTile";

/** Mood / genre tile — one restrained tonal surface per label (no emoji, no rainbow). */
export const MoodTile = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button onClick={onClick}
    className={cn("relative shrink-0 snap-start w-[132px] h-[76px] rounded-2xl p-3 text-left overflow-hidden active:scale-[0.97] transition-transform text-white border border-white/5", toneFor(label), FOCUS)}>
    <span className="text-[14px] font-semibold leading-tight">{label}</span>
  </button>
);

/** List row — used for search results, playlists, downloads, liked songs. */
export const TrackRow = memo(({ track, isCurrent, isPlaying, subtitle, onPlay, onMore, right }: {
  track: GroicTrack; isCurrent: boolean; isPlaying: boolean; subtitle?: string; right?: ReactNode;
} & TrackHandlers) => (
  <div className={cn("flex items-center gap-3.5 py-2 px-2 -mx-2 rounded-2xl transition-colors duration-150", isCurrent ? "bg-primary/[0.07]" : "active:bg-foreground/5")}>
    <button onClick={onPlay} aria-label={`Play ${track.title}`} className={cn("flex items-center gap-3 flex-1 min-w-0 text-left rounded-xl", FOCUS)}>
      <div className="relative">
        <Cover src={artOf(track)} seed={track} className="h-14 w-14 shadow-[0_6px_14px_-8px_hsl(var(--foreground)/0.5)] ring-1 ring-foreground/10" rounded="rounded-xl" />
        {isCurrent && (
          <span className="absolute inset-0 rounded-xl bg-black/45 flex items-center justify-center text-white">
            <Equalizer paused={!isPlaying} className="h-3" />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className={cn("text-[15.5px] font-semibold tracking-[-0.01em] truncate", isCurrent && "text-primary")}>{track.title}</p>
        <p className="text-[13px] text-muted-foreground truncate flex items-center gap-1.5">
          <ProviderDot provider={track.provider} />
          <span className="truncate">{subtitle ?? track.artist}</span>
        </p>
      </div>
    </button>
    {right}
    <button onClick={onMore} aria-label={`More options for ${track.title}`} className={cn("h-11 w-11 rounded-full text-muted-foreground active:scale-90 flex items-center justify-center shrink-0", FOCUS)}>
      <MoreHorizontal className="h-5 w-5" />
    </button>
  </div>
));
TrackRow.displayName = "TrackRow";

/** Big "Top result" card for the search screen. */
export const TopResult = ({ track, isCurrent, isPlaying, onPlay, onMore }: { track: GroicTrack; isCurrent: boolean; isPlaying: boolean } & TrackHandlers) => (
  <div className="relative rounded-[28px] overflow-hidden border border-border/40 bg-card/80 p-5 shadow-[0_24px_50px_-28px_hsl(var(--foreground)/0.55)]">
    <div aria-hidden="true" className="absolute inset-0 bg-gradient-to-br from-[hsl(350_48%_28%)]/25 to-transparent" />
    <div className="relative flex items-center gap-4">
      <div className="relative shrink-0">
        <Cover src={artOf(track)} seed={track} className="h-28 w-28 shadow-[0_20px_40px_-16px_hsl(var(--foreground)/0.65)] ring-1 ring-foreground/10" rounded="rounded-[20px]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Top result</p>
        <p className={cn("text-[19px] leading-tight font-bold line-clamp-2 mt-0.5", isCurrent && "text-primary")}>{track.title}</p>
        <p className="text-[12px] text-muted-foreground truncate flex items-center gap-1.5 mt-0.5"><ProviderDot provider={track.provider} />{track.artist}</p>
      </div>
    </div>
    <div className="relative flex items-center gap-2 mt-3">
      <button onClick={onPlay} className={cn("h-11 px-6 rounded-full bg-primary text-primary-foreground text-sm font-semibold flex items-center gap-2 active:scale-95 transition-transform", FOCUS)}>
        {isCurrent ? <Equalizer paused={!isPlaying} className="h-3" /> : <Play className="h-4 w-4" fill="currentColor" />}
        {isCurrent ? "Playing" : "Play"}
      </button>
      <button onClick={onMore} aria-label="More options" className={cn("h-11 w-11 rounded-full bg-foreground/[0.07] flex items-center justify-center active:scale-90", FOCUS)}>
        <MoreHorizontal className="h-5 w-5" />
      </button>
    </div>
  </div>
);

/* ─── Track actions sheet (Apple-Music-style "…" menu) ────────────────────── */

export interface TrackActionsProps {
  onAddToMyPlaylist?: (t: GroicTrack) => void;
  track: GroicTrack | null;
  liked: boolean;
  onClose: () => void;
  onPlay: (t: GroicTrack) => void;
  onPlayNext: (t: GroicTrack) => void;
  onAddToQueue: (t: GroicTrack) => void;
  onToggleLike: (t: GroicTrack) => void;
  onAddToPlaylist: (t: GroicTrack) => void;
  onMoreByArtist: (t: GroicTrack) => void;
}

const ActionRow = ({ icon, label, onClick, active }: { icon: ReactNode; label: string; onClick: () => void; active?: boolean }) => (
  <button onClick={() => { hapticLight(); onClick(); }}
    className={cn("w-full flex items-center gap-4 px-5 h-14 text-left active:bg-foreground/5 transition-colors", FOCUS)}>
    <span className={cn("h-5 w-5 flex items-center justify-center", active ? "text-primary" : "text-foreground/80")}>{icon}</span>
    <span className="text-[15px] font-medium flex-1">{label}</span>
    <ChevronRight className="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />
  </button>
);

export const TrackActionsSheet = ({ track, liked, onClose, onPlay, onPlayNext, onAddToQueue, onToggleLike, onAddToPlaylist, onAddToMyPlaylist, onMoreByArtist }: TrackActionsProps) => {
  const run = (fn: (t: GroicTrack) => void) => () => { if (track) { fn(track); onClose(); } };
  return (
    <Drawer open={!!track} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DrawerContent className="rounded-t-3xl pb-2">
        {track && (
          <>
            <div className="flex items-center gap-3 px-5 pt-4 pb-3 border-b border-border/50">
              <Cover src={artOf(track)} seed={track} className="h-14 w-14" rounded="rounded-xl" />
              <div className="min-w-0 flex-1">
                <DrawerTitle className="text-[15px] font-bold truncate text-left">{track.title}</DrawerTitle>
                <DrawerDescription className="text-[12px] truncate text-left flex items-center gap-1.5"><ProviderDot provider={track.provider} /><span className="truncate">{track.artist}</span></DrawerDescription>
              </div>
            </div>
            <div className="py-1">
              <ActionRow icon={<Play className="h-5 w-5" />} label="Play now" onClick={run(onPlay)} />
              <ActionRow icon={<ListPlus className="h-5 w-5" />} label="Play next" onClick={run(onPlayNext)} />
              <ActionRow icon={<ListEnd className="h-5 w-5" />} label="Add to queue" onClick={run(onAddToQueue)} />
              <ActionRow icon={<Heart className="h-5 w-5" fill={liked ? "currentColor" : "none"} />} label={liked ? "Remove from Liked Songs" : "Add to Liked Songs"} active={liked} onClick={run(onToggleLike)} />
              {onAddToMyPlaylist && <ActionRow icon={<Library className="h-5 w-5" />} label="Add to my playlist" onClick={run(onAddToMyPlaylist)} />}
              <ActionRow icon={<ListMusic className="h-5 w-5" />} label="Add to Our Playlist" onClick={run(onAddToPlaylist)} />
              <ActionRow icon={<UserSearch className="h-5 w-5" />} label={`More by ${track.artist}`} onClick={run(onMoreByArtist)} />
            </div>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
};

/* ─── Stable-callback wrappers (keep memo() effective when a parent passes (track, pool) handlers) ─── */

type PlayFn = (t: GroicTrack, pool: GroicTrack[]) => void;
type PlayableProps = { track: GroicTrack; pool: GroicTrack[]; isCurrent: boolean; isPlaying: boolean; onPlay: PlayFn; onMore: (t: GroicTrack) => void };

export const PlayableCard = memo(({ track, pool, isCurrent, isPlaying, onPlay, onMore }: PlayableProps) => {
  const play = useCallback(() => onPlay(track, pool), [onPlay, track, pool]);
  const more = useCallback(() => onMore(track), [onMore, track]);
  return <CoverCard track={track} isCurrent={isCurrent} isPlaying={isPlaying} onPlay={play} onMore={more} />;
});
PlayableCard.displayName = "PlayableCard";

export const PlayableRow = memo(({ track, pool, isCurrent, isPlaying, onPlay, onMore }: PlayableProps) => {
  const play = useCallback(() => onPlay(track, pool), [onPlay, track, pool]);
  const more = useCallback(() => onMore(track), [onMore, track]);
  return <TrackRow track={track} isCurrent={isCurrent} isPlaying={isPlaying} onPlay={play} onMore={more} />;
});
PlayableRow.displayName = "PlayableRow";

/* ─── Loading skeletons (static pulse; disabled under reduced motion via Tailwind's motion-reduce) ─── */

export const RowSkeleton = ({ rows = 6 }: { rows?: number }) => (
  <div aria-busy="true" aria-label="Loading" className="space-y-3">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="flex items-center gap-3 animate-pulse motion-reduce:animate-none">
        <div className="h-12 w-12 rounded-xl bg-foreground/10 shrink-0" />
        <div className="flex-1 space-y-2"><div className="h-3 w-3/5 rounded bg-foreground/10" /><div className="h-2.5 w-2/5 rounded bg-foreground/[0.07]" /></div>
      </div>
    ))}
  </div>
);

export const CardSkeleton = ({ count = 4 }: { count?: number }) => (
  <ScrollRow>
    {Array.from({ length: count }, (_, i) => (
      <div key={i} aria-hidden="true" className="shrink-0 w-[140px] animate-pulse motion-reduce:animate-none">
        <div className="aspect-square w-full rounded-2xl bg-foreground/10" />
        <div className="h-3 w-4/5 rounded bg-foreground/10 mt-2" /><div className="h-2.5 w-3/5 rounded bg-foreground/[0.07] mt-1.5" />
      </div>
    ))}
  </ScrollRow>
);

/** Shared page header surface (Genre / Liked / Playlists pages). */
export const pageHeaderClass = (tone?: string) => cn("relative rounded-3xl p-5 pt-4 overflow-hidden text-white", tone ?? WINE_SURFACE);
