/**
 * Full-page track list (Spotify "Liked Songs" / Apple Music library page):
 * gradient header with Play + Shuffle, an in-page filter box, and EVERY track
 * (the home shelves only show a handful). Used for Liked Songs and My Files.
 */
import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, Play, Shuffle, Search, Trash2 } from "lucide-react";
import type { GroicTrack } from "@/lib/music/types";
import { shuffled } from "@/lib/music/queueQuality";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { TrackRow } from "@/components/music/MusicUI";

export function TrackListView({ title, subtitle, icon, gradient, tracks, current, isPlaying, onBack, onPlay, onMore, onRemove, headerAction, emptyText }: {
  title: string; subtitle?: string; icon: ReactNode; gradient: string;
  tracks: GroicTrack[]; current: GroicTrack | null; isPlaying: boolean;
  onBack: () => void; onPlay: (t: GroicTrack, pool: GroicTrack[]) => void; onMore: (t: GroicTrack) => void;
  onRemove?: (t: GroicTrack) => void; headerAction?: ReactNode; emptyText: string;
}) {
  const [filter, setFilter] = useState("");
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? tracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q)) : tracks;
  }, [tracks, filter]);

  const playAll = (shuffle: boolean) => {
    if (tracks.length === 0) return;
    hapticMedium();
    const q = shuffle ? shuffled(tracks) : tracks;
    onPlay(q[0], q);
  };

  return (
    <div className="space-y-5">
      <div className={cn("relative rounded-3xl p-5 pt-4 overflow-hidden text-white shadow-lg", gradient)}>
        <div className="flex items-center justify-between">
          <button onClick={() => { hapticLight(); onBack(); }} aria-label="Back"
            className="h-9 w-9 -ml-2 rounded-full flex items-center justify-center bg-black/20 active:scale-90 transition-transform">
            <ChevronLeft className="h-5 w-5" />
          </button>
          {headerAction}
        </div>
        <span aria-hidden="true" className="absolute right-4 top-10 opacity-25 [&>svg]:h-24 [&>svg]:w-24">{icon}</span>
        <h2 className="mt-7 text-[30px] font-extrabold tracking-tight leading-none">{title}</h2>
        <p className="text-[12px] opacity-90 mt-1.5">{subtitle ?? `${tracks.length} ${tracks.length === 1 ? "song" : "songs"}`}</p>
        <div className="flex gap-2 mt-4">
          <button onClick={() => playAll(false)} disabled={tracks.length === 0}
            className="h-10 px-5 rounded-full bg-white text-black text-[13px] font-bold flex items-center gap-1.5 active:scale-95 disabled:opacity-50 transition-transform">
            <Play className="h-4 w-4 fill-current" /> Play
          </button>
          <button onClick={() => playAll(true)} disabled={tracks.length === 0}
            className="h-10 px-5 rounded-full bg-black/25 text-white text-[13px] font-bold flex items-center gap-1.5 active:scale-95 disabled:opacity-50 transition-transform">
            <Shuffle className="h-4 w-4" /> Shuffle
          </button>
        </div>
      </div>

      {tracks.length > 8 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Search ${title}`} aria-label={`Search ${title}`}
            className="w-full h-10 rounded-full bg-foreground/[0.06] pl-9 pr-4 text-sm outline-none focus:ring-2 focus:ring-primary/40" />
        </div>
      )}

      {tracks.length === 0 && <p className="text-xs text-muted-foreground text-center py-10">{emptyText}</p>}
      {tracks.length > 0 && shown.length === 0 && <p className="text-xs text-muted-foreground text-center py-8">No matches for “{filter}”.</p>}

      <div>
        {shown.map((t) => (
          <div key={t.id} className="flex items-center" style={{ contentVisibility: "auto", containIntrinsicSize: "auto 64px" }}>
            <div className="flex-1 min-w-0">
              <TrackRow track={t} isCurrent={current?.id === t.id} isPlaying={isPlaying && current?.id === t.id}
                onPlay={() => onPlay(t, shown)} onMore={() => onMore(t)} />
            </div>
            {onRemove && (
              <button onClick={() => { hapticLight(); onRemove(t); }} aria-label={`Remove ${t.title}`}
                className="shrink-0 h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground active:scale-90">
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
