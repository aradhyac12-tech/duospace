/**
 * Genre page (Spotify genre / Apple Music category). Header with Play +
 * Shuffle, a "Free Music" top-songs list (Jamendo — licensed, plays in the
 * background) and a mainstream rail (SoundCloud search). Either source can
 * fail on its own without blanking the page. Results are cached for 5 min.
 */
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, Play, Shuffle, WifiOff } from "lucide-react";
import type { GroicTrack } from "@/lib/music/types";
import type { Genre } from "@/lib/music/genres";
import { trendingJamendo } from "@/lib/music/jamendoProvider";
import { searchSoundCloud } from "@/lib/music/soundcloudProvider";
import { shuffled } from "@/lib/music/queueQuality";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { Shelf, ScrollRow, PlayableCard, PlayableRow, RowSkeleton, CardSkeleton, pageHeaderClass, ArtworkWash, artOf } from "@/components/music/MusicUI";
import { genreIcon } from "@/lib/music/genreIcons";

function GenreGlyph({ id }: { id: string }) {
  const Icon = genreIcon(id);
  return (
    <span aria-hidden="true" className="pointer-events-none absolute -right-6 -bottom-8 -z-[5] rotate-[14deg] opacity-[0.16]">
      <Icon className="h-44 w-44 text-white" strokeWidth={1.25} />
    </span>
  );
}

interface GenreData { free: GroicTrack[]; hits: GroicTrack[]; freeError: string | null; hitsError: string | null; at: number }
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, GenreData>();

/** A hung provider must never leave the page on a spinner: give up after this long and show the retry state. */
const PROVIDER_TIMEOUT_MS = 12_000;
const withTimeout = <T,>(p: Promise<T>, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took too long to respond.`)), PROVIDER_TIMEOUT_MS);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

const dedupe = (list: GroicTrack[]): GroicTrack[] => {
  const seen = new Set<string>();
  return list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
};

export function GenreView({ genre, onBack, current, isPlaying, onPlay, onMore, refreshKey = 0 }: {
  genre: Genre; onBack: () => void; current: GroicTrack | null; isPlaying: boolean; refreshKey?: number; // bump = pull-to-refresh: refetch, ignoring the cache
  onPlay: (t: GroicTrack, pool: GroicTrack[]) => void; onMore: (t: GroicTrack) => void;
}) {
  const hit = cache.get(genre.id);
  const [data, setData] = useState<GenreData | null>(hit && Date.now() - hit.at < CACHE_MS ? hit : null);
  const [retryGen, setRetryGen] = useState(0);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on); window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);

  useEffect(() => {
    const cached = cache.get(genre.id);
    if (retryGen === 0 && refreshKey === 0 && cached && Date.now() - cached.at < CACHE_MS) { setData(cached); return; }
    let cancelled = false;
    setData(null);
    const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
    Promise.all([
      withTimeout(trendingJamendo(genre.jamendoTag), "Free Music").then((t) => ({ t, e: null as string | null })).catch((e) => ({ t: [] as GroicTrack[], e: msg(e, "Free Music is unreachable right now.") })),
      withTimeout(searchSoundCloud(genre.query), "SoundCloud").then((t) => ({ t, e: null as string | null })).catch((e) => ({ t: [] as GroicTrack[], e: msg(e, "SoundCloud is unreachable right now.") })),
    ]).then(([free, hits]) => {
      const next: GenreData = { free: free.t, hits: hits.t, freeError: free.e, hitsError: hits.e, at: Date.now() };
      // Only cache a page that has something on it, so a failed load retries on re-open.
      if (next.free.length || next.hits.length) cache.set(genre.id, next);
      if (!cancelled) setData(next);
    });
    return () => { cancelled = true; };
  }, [genre.id, genre.jamendoTag, genre.query, retryGen, refreshKey]);

  const pool = useMemo(() => dedupe([...(data?.free ?? []), ...(data?.hits ?? [])]), [data]);
  const playAll = (shuffle: boolean) => {
    if (pool.length === 0) return;
    hapticMedium();
    const q = shuffle ? shuffled(pool) : pool;
    onPlay(q[0], q);
  };
  const loading = data === null;
  const nothing = !loading && pool.length === 0;

  return (
    <div className="space-y-6">
      <div className={pageHeaderClass(genre.gradient)}>
        {/* Big tilted glyph watermark (sits between the artwork wash and the text). */}
        <GenreGlyph id={genre.id} />
        <ArtworkWash src={pool.find((t) => artOf(t))?.artwork ?? pool.find((t) => artOf(t))?.thumbnail ?? null} />
        <button onClick={() => { hapticLight(); onBack(); }} aria-label="Back to browse"
          className="h-11 w-11 -ml-3 rounded-full flex items-center justify-center bg-black/20 active:scale-90 transition-transform">
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h2 className="mt-10 text-[34px] font-black tracking-tight leading-none drop-shadow-[0_2px_8px_rgba(0,0,0,0.25)]">{genre.label}</h2>
        <p className="text-[12px] opacity-90 mt-1.5 max-w-[70%]">{genre.blurb}</p>
        <div className="flex gap-2 mt-4">
          <button onClick={() => playAll(false)} disabled={pool.length === 0}
            className="h-12 px-7 rounded-full bg-white text-black text-[14px] font-bold flex items-center gap-2 shadow-[0_10px_24px_-10px_rgba(0,0,0,0.6)] active:scale-95 disabled:opacity-50 transition-transform">
            <Play className="h-4 w-4 fill-current" /> Play
          </button>
          <button onClick={() => playAll(true)} disabled={pool.length === 0}
            className="h-12 px-6 rounded-full bg-black/30 ring-1 ring-white/15 text-white text-[14px] font-bold flex items-center gap-2 active:scale-95 disabled:opacity-50 transition-transform">
            <Shuffle className="h-4 w-4" /> Shuffle
          </button>
        </div>
      </div>

      {loading && (
        <div aria-live="polite" className="space-y-6">
          <CardSkeleton />
          <RowSkeleton rows={5} />
        </div>
      )}

      {nothing && (
        <div role="alert" className="flex flex-col items-center py-8 text-center">
          <div className="h-14 w-14 rounded-full bg-foreground/[0.07] flex items-center justify-center mb-3"><WifiOff className="h-5 w-5 text-muted-foreground" /></div>
          <p className="text-sm font-medium">{online ? `Couldn't load ${genre.label}` : "You're offline"}</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-[280px]">
            {online ? (data?.freeError ?? data?.hitsError ?? "No songs found.") : "Genre pages need a connection. Songs you uploaded or downloaded still play from your library."}
          </p>
          <button onClick={() => { hapticLight(); setRetryGen((g) => g + 1); }}
            disabled={!online}
            className="mt-4 h-11 px-6 rounded-full border border-border/60 bg-card text-xs font-medium active:scale-95 disabled:opacity-50">Try again</button>
        </div>
      )}

      {!!data?.hits.length && (
        <Shelf title={`${genre.label} hits`} subtitle="SoundCloud">
          <ScrollRow>
            {data.hits.slice(0, 20).map((t) => (
              <PlayableCard key={t.id} track={t} pool={data.hits} isCurrent={current?.id === t.id} isPlaying={isPlaying && current?.id === t.id}
                onPlay={onPlay} onMore={onMore} />
            ))}
          </ScrollRow>
        </Shelf>
      )}

      {!!data?.free.length && (
        <Shelf title={`Top ${genre.label} · Free Music`} subtitle="Licensed, plays in the background">
          <div>
            {data.free.slice(0, 15).map((t) => (
              <PlayableRow key={t.id} track={t} pool={data.free} isCurrent={current?.id === t.id} isPlaying={isPlaying && current?.id === t.id}
                onPlay={onPlay} onMore={onMore} />
            ))}
          </div>
        </Shelf>
      )}
    </div>
  );
}
