import { useEffect, useState, useCallback, useRef, useMemo, memo } from "react";
import { motion } from "framer-motion";
import { Search, Loader2, Plus, Play, Sparkles, Users, ChevronLeft, WifiOff, Trash2, ListMusic, ExternalLink, Check, RefreshCw, X, Heart, Shuffle, History, Upload, Moon, Smartphone, Pencil, Library } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useGroic, GroicTrack } from "@/contexts/GroicContext";
import { youtubeResultToTrack, YouTubeSearchResult } from "@/lib/music/youtubeProvider";
import { searchAudius } from "@/lib/music/audiusProvider";
import { cachedSearch } from "@/lib/music/searchCache";
import { searchSoundCloud } from "@/lib/music/soundcloudProvider";
import { searchJamendo, trendingJamendo } from "@/lib/music/jamendoProvider";
import { useBackHandler } from "@/hooks/useBackHandler";
import { usePullToRefresh } from "@/hooks/usePullToRefresh";
import { toneFor, WINE_SURFACE, WINE_CHIP } from "@/lib/music/palette";
import { useSleepTimer, formatRemaining } from "@/hooks/useSleepTimer";
import { usePlaylists, createPlaylist, renamePlaylist, deletePlaylist, addToPlaylist, removeFromPlaylist, resolvePlaylistTracks, PLAYLIST_NAME_MAX } from "@/lib/music/playlists";
import { Drawer, DrawerContent, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { GENRES, type Genre } from "@/lib/music/genres";
import { genreIcon } from "@/lib/music/genreIcons";
import { GenreView } from "@/components/music/GenreView";
import { TrackListView } from "@/components/music/TrackListView";
import { useLocalTracks, importLocalFiles, removeLocalTrack } from "@/lib/music/localLibrary";
import { isDeviceScanSupported, scanDeviceMusic, loadDeviceArt } from "@/lib/music/deviceMusic";
import { listDownloads, removeDownload, isOfflineDownloadSupported, DownloadedTrack } from "@/lib/music/offlineDownloads";
import { buildUpNextPool, buildSearchUpNext, withoutSameName, shuffled } from "@/lib/music/queueQuality";
import { useLikedTracks, useRecentTracks, toggleLiked, unslim, clearRecentTracks } from "@/lib/music/libraryStore";
import {
  Shelf, ScrollRow, CoverCard, QuickTile, MoodTile, TrackRow, TopResult, TrackActionsSheet, Cover, Equalizer, artOf, ArtworkWash, GenreTile } from "@/components/music/MusicUI";
import { dedupeRails } from "@/lib/music/railDedupe";
import { fetchAutoNext } from "@/lib/music/autoNext";
import { TRENDING_LANGUAGES, getTrendingRail } from "@/lib/music/trendingMix";
import { getRecentlyPlayedKeys, getMusicPrefs, setMusicPrefs, setMusicProfileScope, subscribeProfileLoaded } from "@/lib/music/playHistory";
import { useAuth } from "@/hooks/useAuth";
import { useOurPlaylist, AddSongInput, OurPlaylistSong } from "@/hooks/useOurPlaylist";
import { invokeEdgeFunction, EdgeFunctionError } from "@/lib/edgeFunction";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticMedium, hapticWarning } from "@/lib/haptics";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/skeletons/Shimmer";
import { useErrorManager } from "@/lib/errors/useErrorManager";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

// SearchResult is the raw YouTube shape returned by the music-search/
// music-trending edge functions — kept as a local alias of
// YouTubeSearchResult (src/lib/music/youtubeProvider.ts) so every existing
// `SearchResult` reference in this file (SongRail, the results grid,
// trending state, history rail) keeps working unchanged; only the actual
// GroicTrack construction (toTrack, below) needed to change.
type SearchResult = YouTubeSearchResult;

const MOODS = [
  { id: "romantic",  label: "Romantic",   q: "romantic love songs"   },
  { id: "chill",     label: "Chill",      q: "chill lofi beats"      },
  { id: "workout",   label: "Workout",    q: "workout hype playlist" },
  { id: "latenight", label: "Late Night", q: "late night vibes"      },
  { id: "happy",     label: "Happy",      q: "feel good hits"        },
  { id: "focus",     label: "Focus",      q: "focus instrumental"    },
];

const SEARCH_DEBOUNCE_MS = 350;

// ─── Language preference + trending rails ───────────────────────────────────
// FIX ("main page should have trending Marathi/Hindi/English/Haryanvi, and
// ask the user which languages they want"): persisted just like RECENT_KEY
// above — no account-level sync yet, matching every other lightweight
// preference this app already keeps client-side only.
const LANG_OPTIONS = TRENDING_LANGUAGES;
type TrendingBuckets = Record<string, GroicTrack[]>;

// ─── "Up next" queue quality — dedup + shuffle ──────────────────────────────
// FIX ("search 'bad guy' and it's bad guy everywhere — the queue/play next
// has zero randomness, YouTube does actual suggestions"): onPlay used to
// build the queue as "literally every other result from this exact
// search" — for a direct song search that's mostly more uploads of the
// SAME song (different covers, remixes, lyric-video re-uploads), not a
// real "up next", and fully deterministic: the same search always
// produced the identical queue in the identical order every time.
// There's no true ML "related videos" endpoint available from the
// YouTube Data API to fully replicate what YouTube Music's own queue
// does (see music-search/index.ts's notes on this same constraint) — but
// within what a keyword-search API can give us, this fixes the two
// concrete symptoms: (1) dedup by song title alone (not title+artist) so
// we never stack multiple versions of the literal same song back to
// back, and (2) shuffle what's left, so replaying the same search
// doesn't always hand back the identical "up next" order.
// `songKey`/`shuffled` now live in src/lib/music/queueQuality.ts (imported
// above) so they're unit-testable and shared with GroicContext rather than
// duplicated here.


// REMOVED: the "rotating discovery query" system that used to live here
// (DISCOVERY_QUERIES / hashSeed / pickDiscoveryQuery) was the mechanism
// behind the old fake "Trending" section — it ran a hidden generic search
// (e.g. "feel good morning playlist") and displayed those results labeled
// "Trending", which is also how a literal song search's results could end
// up looking like they were "trending" everywhere. Superseded entirely by
// the real per-language trending rails below (see the `trending` state
// and music-trending edge function) — nothing else in this file called
// this, so it's deleted rather than left as dead code.

// ─── Shared shelf / list helpers (premium music UI) ─────────────────────────
const ShelfSkeleton = ({ label }: { label: string }) => (
  <ScrollRow>
    <div className="flex gap-3.5" aria-busy="true" aria-label={label}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="shrink-0 w-[140px]">
          <Shimmer className="aspect-square rounded-2xl" />
          <Shimmer className="h-3 w-24 rounded mt-2" />
          <Shimmer className="h-2.5 w-16 rounded mt-1.5" />
        </div>
      ))}
    </div>
  </ScrollRow>
);

// PERF: CoverCard/TrackRow are memo()'d, but the shelves used to hand each one
// brand-new `() => onPlay(t, items)` closures on EVERY render of this 1,300-line
// page, so memo never hit and every card in every rail re-rendered on each
// keystroke / buffering flip / play-pause. These wrappers build the callbacks
// once per (track, pool), and only the CURRENT card receives isPlaying — so a
// play/pause now re-renders two cards instead of ~100.
type PlayFn = (t: GroicTrack, pool: GroicTrack[]) => void;
const ShelfCard = memo(({ track, pool, isCurrent, isPlaying, onPlay, onMore }: {
  track: GroicTrack; pool: GroicTrack[]; isCurrent: boolean; isPlaying: boolean; onPlay: PlayFn; onMore: (t: GroicTrack) => void;
}) => {
  const play = useCallback(() => onPlay(track, pool), [onPlay, track, pool]);
  const more = useCallback(() => onMore(track), [onMore, track]);
  return <CoverCard track={track} isCurrent={isCurrent} isPlaying={isPlaying} onPlay={play} onMore={more} />;
});
ShelfCard.displayName = "ShelfCard";
const ListRow = memo(({ track, pool, isCurrent, isPlaying, onPlay, onMore }: {
  track: GroicTrack; pool: GroicTrack[]; isCurrent: boolean; isPlaying: boolean; onPlay: PlayFn; onMore: (t: GroicTrack) => void;
}) => {
  const play = useCallback(() => onPlay(track, pool), [onPlay, track, pool]);
  const more = useCallback(() => onMore(track), [onMore, track]);
  return <TrackRow track={track} isCurrent={isCurrent} isPlaying={isPlaying} onPlay={play} onMore={more} />;
});
ListRow.displayName = "ListRow";

const TrackShelf = ({
  title, subtitle, items, current, isPlaying, onPlay, onMore, action,
}: {
  title: string; subtitle?: string; items: GroicTrack[]; current: GroicTrack | null; isPlaying: boolean;
  onPlay: (t: GroicTrack, pool: GroicTrack[]) => void; onMore: (t: GroicTrack) => void; action?: React.ReactNode;
}) => {
  if (items.length === 0) return null;
  return (
    <Shelf title={title} subtitle={subtitle} action={action}>
      <ScrollRow>
        {items.map((t) => (
          <ShelfCard key={t.id} track={t} pool={items} isCurrent={current?.id === t.id}
            isPlaying={isPlaying && current?.id === t.id} onPlay={onPlay} onMore={onMore} />
        ))}
      </ScrollRow>
    </Shelf>
  );
};

/** Language rails: fetch/show up to SIZE songs, and never let cross-rail
 *  de-duplication shrink a rail below MIN (shared songs are put back). */
const TREND_RAIL_SIZE = 24;
const TREND_RAIL_MIN = 15;
const NO_TRACKS: GroicTrack[] = [];

/** One provider's search results as Spotify-style rows, with "Show all". */
const ResultList = ({
  title, tracks, loading, error, onRetry, emptyText, current, isPlaying, onPlay, onMore, limit = 6,
}: {
  title: string; tracks: GroicTrack[]; loading: boolean; error: string | null; onRetry: () => void; emptyText: string;
  current: GroicTrack | null; isPlaying: boolean; onPlay: (t: GroicTrack, pool: GroicTrack[]) => void; onMore: (t: GroicTrack) => void; limit?: number;
}) => {
  const [all, setAll] = useState(false);
  const shown = all ? tracks : tracks.slice(0, limit);
  return (
    <Shelf title={title} subtitle={tracks.length ? `${tracks.length} songs` : undefined}>
      {loading && tracks.length === 0 ? (
        <div className="space-y-2" aria-busy="true" aria-label={`Loading ${title}`}>
          {Array.from({ length: 3 }).map((_, i) => <Shimmer key={i} className="h-14 rounded-2xl" />)}
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 py-2">
          <p className="text-xs text-warning flex-1 min-w-0 truncate">{error}</p>
          <button onClick={onRetry} aria-label={`Retry ${title}`}
            className="shrink-0 h-8 px-3 rounded-full bg-card border border-border/60 text-[11px] font-medium active:scale-95 transition-transform">Retry</button>
        </div>
      ) : tracks.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">{loading ? "" : emptyText}</p>
      ) : (
        <>
          <div>
            {shown.map((t) => (
              <ListRow key={t.id} track={t} pool={tracks} isCurrent={current?.id === t.id}
                isPlaying={isPlaying && current?.id === t.id} onPlay={onPlay} onMore={onMore} />
            ))}
          </div>
          {tracks.length > limit && (
            <button onClick={() => setAll(v => !v)} className="mt-1 h-9 px-4 rounded-full bg-foreground/[0.06] text-[12px] font-semibold active:scale-95">
              {all ? "Show less" : `Show all ${tracks.length}`}
            </button>
          )}
        </>
      )}
    </Shelf>
  );
};


/** Immutable add/remove on a Set held in React state (returns the same
 *  reference when nothing changes, so no needless re-render). */
const setIn = (set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> => {
  if (set.has(id) === on) return set;
  const n = new Set(set); if (on) n.add(id); else n.delete(id); return n;
};

const Groic = () => {
  const { playTrack, enqueue, playNext, sessionRole, partnerListening, startSession, endSession, current, isPlaying, warmStreams, pause, setVolume } = useGroic();
  const sleep = useSleepTimer({ pause, setVolume, isPlaying });
  const [sleepOpen, setSleepOpen] = useState(false);
  const { toast } = useToast();
  const navigate = useNavigate();
  const { capture } = useErrorManager("Groic & Playlist");
  const ourPlaylist = useOurPlaylist();
  const [confirmRemovePlaylistSong, setConfirmRemovePlaylistSong] = useState<OurPlaylistSong | null>(null);
  const [showAddPlaylistLink, setShowAddPlaylistLink] = useState(false);
  const [newPlaylistLink, setNewPlaylistLink] = useState({ title: "", artist: "", url: "" });

  const [query, setQuery]     = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  /** Human-readable failure for the last search, or null. Never a raw
   *  provider/HTTP string — invokeEdgeFunction already maps those. */
  const [error, setError]     = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState("");
  // Per-account (playHistory.ts): recent searches + language rails follow the
  // signed-in account, not the phone. The scope is set here too because child
  // effects run before the provider's own, and the first render must already
  // read the right account's data.
  const { user: authUser } = useAuth();
  const acctId = authUser?.id ?? null;
  if (acctId) setMusicProfileScope(acctId);
  const [recent, setRecent]   = useState<string[]>(() => getMusicPrefs().recent);

  // Offline Downloads section (home state only) — a local index read, not
  // a fetch, so a plain useState + refresh-on-mutation is enough; no
  // separate loading state needed.
  const [downloads, setDownloads] = useState<DownloadedTrack[]>(() => listDownloads());
  const playDownload = (d: DownloadedTrack) => {
    playTrack({
      id: d.id,
      provider: "audius",
      providerTrackId: d.providerTrackId,
      videoId: d.providerTrackId,
      title: d.title,
      artist: d.artist,
      thumbnail: d.thumbnail,
      duration: d.duration,
      isStreamable: true,
      isDownloadable: true,
    });
  };
  const removeDownloadedTrack = async (d: DownloadedTrack) => {
    hapticLight();
    await removeDownload(d.id);
    setDownloads(listDownloads());
    toast({ title: "Download removed" });
  };

  // Language preference — which trending rails to show on the home state,
  // and in what order. Defaults to Hindi+English (the two this app already
  // had trending data for); Marathi/Haryanvi are opt-in via the chips below
  // rather than assumed, since not everyone wants those rails.
  const readLangPrefs = (): string[] => {
    const saved = getMusicPrefs().langs;
    return saved ? saved.filter((x: string) => LANG_OPTIONS.some(l => l.id === x)) : ["hindi", "english"];
  };
  const [langPrefs, setLangPrefs] = useState<string[]>(readLangPrefs);
  const langPrefsRef = useRef(langPrefs);
  langPrefsRef.current = langPrefs;
  // Tap = select, tap again = deselect (any chip, including the last).
  // FIX: persistence used to run INSIDE the setState updater (an impure
  // updater — React may call it twice and it raced rapid taps). The next
  // value is now computed from a ref and persisted once, outside it.
  const toggleLangPref = useCallback((id: string) => {
    const prev = langPrefsRef.current;
    const next = prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id];
    langPrefsRef.current = next;
    setLangPrefs(next);
    setMusicPrefs({ langs: next });
  }, []);

  // Real per-language trending rails (home state only). Each language is
  // loaded, cached and failed INDEPENDENTLY. FIX ("when I select a language
  // the whole row disappears"): this used to be one all-or-nothing request
  // for every selected language that flipped a single `trendingLoading`
  // flag, which swapped the ENTIRE home (every rail) for a shimmer on each
  // chip tap and replaced all rails with the new response. Now a tap only
  // fetches the language that is actually missing; rails already on screen
  // stay put, and only the new language shows its own placeholder.
  const [trending, setTrending] = useState<TrendingBuckets>({});
  const [loadingLangs, setLoadingLangs] = useState<ReadonlySet<string>>(() => new Set());
  const [failedLangs, setFailedLangs] = useState<ReadonlySet<string>>(() => new Set());
  const trendingRef = useRef(trending);
  trendingRef.current = trending;
  const langGenRef = useRef<Record<string, number>>({});
  const langInflightRef = useRef<Set<string>>(new Set());
  const loadLang = useCallback((id: string, force = false) => {
    if (!force && langInflightRef.current.has(id)) return;
    const gen = (langGenRef.current[id] = (langGenRef.current[id] ?? 0) + 1);
    langInflightRef.current.add(id);
    setLoadingLangs(s => setIn(s, id, true));
    setFailedLangs(s => setIn(s, id, false));
    getTrendingRail(id, TREND_RAIL_SIZE, force)
      .then((rail) => {
        if (gen !== langGenRef.current[id]) return;
        // Keep what is on screen if a refresh comes back empty.
        if (rail.length > 0) setTrending(prev => ({ ...prev, [id]: rail }));
        else if (!(trendingRef.current[id]?.length)) setFailedLangs(s => setIn(s, id, true));
      })
      .catch((err) => {
        if (gen !== langGenRef.current[id]) return;
        if (!(trendingRef.current[id]?.length)) setFailedLangs(s => setIn(s, id, true));
        capture("DS-GROIC-002", { component: "Groic", action: "trending", cause: err });
      })
      .finally(() => {
        if (gen !== langGenRef.current[id]) return;
        langInflightRef.current.delete(id);
        setLoadingLangs(s => setIn(s, id, false));
      });
  }, [capture]);
  /** Fetch only languages that have nothing yet (or force-refresh them all). */
  const loadTrending = useCallback((force = false) => {
    for (const id of langPrefsRef.current) {
      if (force || !(trendingRef.current[id]?.length)) loadLang(id, force);
    }
  }, [loadLang]);
  const trendingLoading = loadingLangs.size > 0;
  const trendingError = langPrefs.length > 0
    && langPrefs.every(id => failedLangs.has(id) && !(trending[id]?.length));

  // "Because you searched…" — a real personalization rail driven by the
  // user's own search history (per the direct request to use search
  // behavior to inform the home screen, not just time-of-day discovery
  // buckets). One extra lightweight search for the single most recent
  // distinct query, not the whole history, to keep this cheap.
  const [historyRail, setHistoryRail] = useState<{ term: string; results: SearchResult[] } | null>(null);

  // "Made for you" — suggestions derived from what you actually play (the
  // taste profile in autoNext.ts: recency-weighted artists, early skips
  // count against). No fixed queries; empty until there's listening
  // history, and then the rail simply doesn't render.
  const [forYou, setForYou] = useState<GroicTrack[]>([]);
  // Re-runs when the account changes or its server profile finishes loading
  // (a fresh phone gets its suggestions once the synced history arrives).
  const [profileVersion, setProfileVersion] = useState(0);
  useEffect(() => subscribeProfileLoaded(() => {
    setRecent(getMusicPrefs().recent);
    setLangPrefs(readLangPrefs());
    setProfileVersion((v) => v + 1);
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setRecent(getMusicPrefs().recent);
    setLangPrefs(readLangPrefs());
  }, [acctId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    setForYou([]);
    fetchAutoNext({ current: null, queue: [], limit: 12 })
      .then((tracks) => { if (!cancelled) setForYou(tracks); })
      .catch(() => { /* best effort — home shouldn't error over this */ });
    return () => { cancelled = true; };
  }, [acctId, profileVersion]);

  // RACE FIX: every search bumps a generation counter and only the newest
  // generation is allowed to write state. Previously a slow first request
  // could resolve *after* a faster second one and overwrite fresh results
  // with stale ones (the "results randomly disappear / show the wrong
  // song" symptom while typing quickly).
  const genRef = useRef(0);
  const recentRef = useRef(recent);
  recentRef.current = recent;

  const rememberQuery = useCallback((q: string) => {
    const next = [q, ...recentRef.current.filter(x => x !== q)].slice(0, 8);
    setRecent(next);
    setMusicPrefs({ recent: next });
  }, []);

  const search = useCallback(async (raw: string, opts?: { remember?: boolean }) => {
    const q = raw.trim();
    const gen = ++genRef.current;
    if (!q) {
      // Clearing the box must clear everything immediately — no in-flight
      // response is allowed to repopulate it afterwards (gen guard above).
      setLoading(false);
      setError(null);
      setResults([]);
      return;
    }
    setLastQuery(q);
    setLoading(true);
    setError(null);
    try {
      const data = await invokeEdgeFunction<{ results?: SearchResult[]; error?: string; debug?: string[] }>(
        "music-search", { body: { query: q } },
      );
      if (gen !== genRef.current) return; // superseded by a newer search
      const list = Array.isArray(data?.results) ? data.results.filter(r => r && r.videoId && r.title) : [];
      setResults(list);
      if (list.length > 0 && opts?.remember !== false) rememberQuery(q);
    } catch (err) {
      if (gen !== genRef.current) return;
      // FIX: this used to only ever surface a generic message ("Search is
      // unavailable right now") with zero indication of which provider
      // failed or why — every live failure meant re-pulling Supabase edge
      // function logs from scratch to find out. edgeFunction.ts's
      // EdgeFunctionError now carries the per-provider `debug` trail the
      // edge function computes (see music-search/index.ts), when present.
      const debugInfo = err instanceof EdgeFunctionError ? err.debug : undefined;
      const message = err instanceof Error && err.message ? err.message : "Search is unavailable right now.";
      setResults([]);
      setError(debugInfo?.length ? `${message}\n${debugInfo.join(" · ")}` : message);
      capture("DS-GROIC-001", { component: "Groic", action: "search", cause: err });
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [capture, rememberQuery]);

  // Debounced type-to-search. A newer keystroke cancels the pending run,
  // and the generation guard inside `search` discards any response that
  // arrives out of order.
  useEffect(() => {
    const q = query.trim();
    if (!q) { search(""); return; }
    const t = window.setTimeout(() => search(q), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [query, search]);

  // Fetch whichever selected languages have no rail yet (first mount and
  // every chip tap). Languages already loaded are NOT refetched.
  useEffect(() => { loadTrending(); }, [langPrefs, loadTrending]);

  // "Because you searched…" — one lightweight extra search for the user's
  // single most recent distinct query, per the direct request to have the
  // home screen reflect actual search behavior rather than only
  // time-of-day discovery buckets. Re-runs whenever the most recent term
  // changes (i.e. after a new search), not on every render.
  const mostRecentTerm = recent[0];
  useEffect(() => {
    if (!mostRecentTerm) { setHistoryRail(null); return; }
    let cancelled = false;
    invokeEdgeFunction<{ results?: SearchResult[] }>("music-search", { body: { query: mostRecentTerm } })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data?.results) ? data.results.filter(r => r && r.videoId && r.title) : [];
        setHistoryRail(list.length > 0 ? { term: mostRecentTerm, results: list } : null);
      })
      .catch(() => { if (!cancelled) setHistoryRail(null); }); // best-effort — home page shouldn't error over this
    return () => { cancelled = true; };
  }, [mostRecentTerm]);


  // FIX (Groic.tsx's GroicTrack construction predates the provider
  // abstraction — see src/lib/music/types.ts): now delegates to
  // youtubeResultToTrack so every play/enqueue path in this file produces
  // a properly provider-tagged track (provider: "youtube",
  // isStreamable: false) instead of an untagged object that happened to
  // satisfy the old, YouTube-only shape.

  // Simple platform sniff for a pasted link — same heuristic Playlist.tsx
  // already used, kept consistent so a song added from either surface
  // gets the same `platform` value.
  const detectLinkPlatform = (url: string): string => {
    if (url.includes("spotify")) return "spotify";
    if (url.includes("youtube") || url.includes("youtu.be")) return "youtube";
    if (url.includes("soundcloud")) return "soundcloud";
    if (url.includes("apple")) return "apple-music";
    return "other";
  };

  const addPastedLinkToPlaylist = async () => {
    if (!newPlaylistLink.url.trim()) return;
    hapticLight();
    const platform = detectLinkPlatform(newPlaylistLink.url.trim());
    const { error: addError } = await ourPlaylist.addSong({
      title: newPlaylistLink.title.trim() || "Untitled",
      artist: newPlaylistLink.artist.trim() || "Unknown artist",
      song_url: newPlaylistLink.url.trim(),
      platform,
      thumbnail_url: null,
    });
    if (addError) { capture("DS-GROIC-PLAYLIST-ADD", { component: "Groic", action: "addSong", cause: addError }); toast({ title: "Couldn't add to playlist", description: addError, variant: "destructive" }); }
    else { toast({ title: "Added to Our Playlist" }); setShowAddPlaylistLink(false); setNewPlaylistLink({ title: "", artist: "", url: "" }); }
  };

  // ── "Our Playlist" — add + play, from any existing source card ──────────
  // FIX (direct request: shared couple playlist inside Groic itself, with
  // attribution). Every card in this file (results grid, SongRail,
  // Audius rail) already renders a "+" queue-add button — these mirror
  // that exact pattern for "add to Our Playlist" instead, so it needed no
  // new visual language, just a second small icon.
  const YOUTUBE_URL_ID_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/;

  const addYouTubeToPlaylist = async (r: SearchResult) => {
    hapticLight();
    const { error: addError } = await ourPlaylist.addSong({
      title: r.title,
      artist: r.artist,
      song_url: `https://www.youtube.com/watch?v=${r.videoId}`,
      platform: "youtube",
      thumbnail_url: r.thumbnail,
    });
    if (addError) { capture("DS-GROIC-PLAYLIST-ADD", { component: "Groic", action: "addSong", cause: addError }); toast({ title: "Couldn't add to playlist", description: addError, variant: "destructive" }); }
    else toast({ title: "Added to Our Playlist" });
  };

  const addAudiusToPlaylist = async (t: GroicTrack) => {
    hapticLight();
    const { error: addError } = await ourPlaylist.addSong({
      title: t.title,
      artist: t.artist,
      // No universal external URL for every Audius track — permalink is
      // used when the provider gave us one (also useful as an "open in
      // Audius" link), otherwise a synthetic identifier this file itself
      // knows how to parse back on playback (see playOurPlaylistSong).
      song_url: t.permalink || `audius:${t.providerTrackId}`,
      platform: "audius",
      thumbnail_url: t.thumbnail,
    });
    if (addError) { capture("DS-GROIC-PLAYLIST-ADD", { component: "Groic", action: "addSong", cause: addError }); toast({ title: "Couldn't add to playlist", description: addError, variant: "destructive" }); }
    else toast({ title: "Added to Our Playlist" });
  };

  const addJamendoToPlaylist = async (t: GroicTrack) => {
    hapticLight();
    // Synthetic jamendo:<id> scheme (Jamendo's share URL is not parseable back to a track id).
    const { error: addError } = await ourPlaylist.addSong({
      title: t.title, artist: t.artist, song_url: `jamendo:${t.providerTrackId}`, platform: "jamendo", thumbnail_url: t.thumbnail,
    });
    if (addError) { capture("DS-GROIC-PLAYLIST-ADD", { component: "Groic", action: "addSong", cause: addError }); toast({ title: "Couldn't add to playlist", description: addError, variant: "destructive" }); }
    else toast({ title: "Added to Our Playlist" });
  };

  const addSoundCloudToPlaylist = async (t: GroicTrack) => {
    hapticLight();
    const { error: addError } = await ourPlaylist.addSong({
      title: t.title,
      artist: t.artist,
      // Same synthetic-identifier fallback pattern as addAudiusToPlaylist
      // above — permalink when SoundCloud gave us one (also useful as an
      // "open in SoundCloud" link), otherwise a scheme this file's own
      // playOurPlaylistSong knows how to parse back on playback.
      song_url: t.permalink || `soundcloud:${t.providerTrackId}`,
      platform: "soundcloud",
      thumbnail_url: t.thumbnail,
    });
    if (addError) { capture("DS-GROIC-PLAYLIST-ADD", { component: "Groic", action: "addSong", cause: addError }); toast({ title: "Couldn't add to playlist", description: addError, variant: "destructive" }); }
    else toast({ title: "Added to Our Playlist" });
  };

  // Plays a playlist row using the same single player every other source
  // in this file goes through (GroicContext.playTrack) — never a second,
  // parallel player like the old orphaned Playlist.tsx page had. Anything
  // that isn't YouTube/Audius (a pasted Spotify/SoundCloud/Apple Music
  // link) can't actually be played inside this app — same honest boundary
  // Playlist.tsx already drew — so those rows open externally instead.
  const playOurPlaylistSong = (song: OurPlaylistSong) => {
    hapticMedium();
    if (song.platform === "youtube") {
      const match = song.song_url.match(YOUTUBE_URL_ID_RE);
      if (!match) { toast({ title: "Couldn't play this song", description: "Its link looks invalid.", variant: "destructive" }); return; }
      playTrack(youtubeResultToTrack({ videoId: match[1], title: song.title, artist: song.artist, thumbnail: song.thumbnail_url || "", duration: 0 } as YouTubeSearchResult));
    } else if (song.platform === "audius") {
      const providerTrackId = song.song_url.startsWith("audius:") ? song.song_url.slice("audius:".length) : song.song_url;
      playTrack({
        id: `audius:${providerTrackId}`,
        provider: "audius",
        providerTrackId,
        videoId: providerTrackId,
        title: song.title,
        artist: song.artist,
        thumbnail: song.thumbnail_url,
        duration: 0,
        isStreamable: true,
        isDownloadable: false,
      });
    } else if (song.platform === "soundcloud" && song.song_url.startsWith("soundcloud:")) {
      // Only the synthetic soundcloud:<id> scheme this file itself wrote
      // (via addSoundCloudToPlaylist) is playable in-app — a raw pasted
      // soundcloud.com URL (from "Add link") has no resolvable track id
      // without an extra /resolve round trip this pass doesn't add, so it
      // falls through to the same "open externally" behavior as any other
      // pasted link below.
      const providerTrackId = song.song_url.slice("soundcloud:".length);
      playTrack({
        id: `soundcloud:${providerTrackId}`,
        provider: "soundcloud",
        providerTrackId,
        videoId: providerTrackId,
        title: song.title,
        artist: song.artist,
        thumbnail: song.thumbnail_url,
        duration: 0,
        isStreamable: true,
        isDownloadable: false,
      });
    } else if (song.platform === "jamendo" && song.song_url.startsWith("jamendo:")) {
      const providerTrackId = song.song_url.slice("jamendo:".length);
      playTrack({
        id: `jamendo:${providerTrackId}`, provider: "jamendo", providerTrackId, videoId: providerTrackId,
        title: song.title, artist: song.artist, thumbnail: song.thumbnail_url, duration: 0,
        isStreamable: true, isDownloadable: false,
      });
    } else {
      window.open(song.song_url, "_blank", "noopener,noreferrer");
    }
  };

  // ─── Audius search (native-streamable provider) ─────────────────────────
  // FIX (direct request: "search should let users search YouTube, Audius,
  // or both — a good default is All Music, results normalize into the
  // same track card format"): a separate results list from the YouTube
  // `results` state above, rather than trying to force both providers'
  // raw shapes into one array — SearchResult (YouTube) and GroicTrack
  // (Audius, already fully normalized) are different shapes, and forcing
  // them into one would mean converting YouTube results to GroicTrack
  // *before* they're played, which the rest of this file (SongRail,
  // toTrack, onPlay's pool-based queue building) isn't set up for. Two
  // lists rendered as two labeled sections is simpler and no less
  // "normalized" from the user's perspective — both render through the
  // same card treatment either way.
  const [providerFilter, setProviderFilter] = useState<"all" | "youtube" | "audius" | "soundcloud" | "jamendo" | "local">("all");
  // Section visibility/fetch-gating for each provider — "all" shows every
  // section; any specific filter shows only that one. Named booleans
  // instead of repeating the `!== "x" && !== "y"` chain at every call
  // site below.
  const showYouTube = providerFilter === "all" || providerFilter === "youtube";
  const showAudius = providerFilter === "all" || providerFilter === "audius";
  const showSoundCloud = providerFilter === "all" || providerFilter === "soundcloud";
  const showJamendo = providerFilter === "all" || providerFilter === "jamendo";
  const showLocal = providerFilter === "all" || providerFilter === "local";
  const [audiusResults, setAudiusResults] = useState<GroicTrack[]>([]);
  const [audiusLoading, setAudiusLoading] = useState(false);
  // FIX ("Audius no result found"): every failure — 429 throttle, 502
  // unreachable host, expired session — used to land in the same
  // `.catch(() => setAudiusResults([]))` and render as "No Audius results
  // for this search", which reads exactly like broken search. Errors are
  // now tracked separately so the section can say WHY it's empty and offer
  // a retry instead of a false "no matches".
  const [audiusError, setAudiusError] = useState<string | null>(null);
  // Bump to re-run the fetch from the retry button without touching `query`.
  const [audiusRetryGen, setAudiusRetryGen] = useState(0);
  useEffect(() => {
    const q = query.trim();
    if (!q || !showAudius) {
      setAudiusResults([]);
      setAudiusError(null);
      return;
    }
    let cancelled = false;
    setAudiusLoading(true);
    setAudiusError(null);
    const t = window.setTimeout(() => {
      cachedSearch("audius", q, () => searchAudius(q))
        .then((tracks) => { if (!cancelled) setAudiusResults(tracks); })
        .catch((err) => {
          if (cancelled) return;
          setAudiusResults([]);
          setAudiusError(err instanceof Error && err.message ? err.message : "Audius is unreachable right now.");
        })
        .finally(() => { if (!cancelled) setAudiusLoading(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [query, showAudius, audiusRetryGen]);

  // ─── SoundCloud search (PRIMARY provider) ────────────────────────────────
  // Same shape as the Audius block above — a separate results list rather
  // than forcing SearchResult (YouTube) / GroicTrack (SoundCloud, already
  // normalized) into one array, for the same reasons documented on the
  // Audius block. SoundCloud is the primary source, so its section renders
  // first in the results JSX below, ahead of Audius and YouTube.
  const [soundcloudResults, setSoundcloudResults] = useState<GroicTrack[]>([]);
  const [soundcloudLoading, setSoundcloudLoading] = useState(false);
  const [soundcloudError, setSoundcloudError] = useState<string | null>(null);
  const [soundcloudRetryGen, setSoundcloudRetryGen] = useState(0);
  useEffect(() => {
    const q = query.trim();
    if (!q || !showSoundCloud) {
      setSoundcloudResults([]);
      setSoundcloudError(null);
      return;
    }
    let cancelled = false;
    setSoundcloudLoading(true);
    setSoundcloudError(null);
    const t = window.setTimeout(() => {
      cachedSearch("soundcloud", q, () => searchSoundCloud(q))
        .then((tracks) => { if (!cancelled) setSoundcloudResults(tracks); })
        .catch((err) => {
          if (cancelled) return;
          setSoundcloudResults([]);
          setSoundcloudError(err instanceof Error && err.message ? err.message : "SoundCloud is unreachable right now.");
        })
        .finally(() => { if (!cancelled) setSoundcloudLoading(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [query, showSoundCloud, soundcloudRetryGen]);

  // ─── Jamendo ("Free Music") search — official API, licensed, background-capable ──
  const [jamendoResults, setJamendoResults] = useState<GroicTrack[]>([]);
  const [jamendoLoading, setJamendoLoading] = useState(false);
  const [jamendoError, setJamendoError] = useState<string | null>(null);
  const [jamendoRetryGen, setJamendoRetryGen] = useState(0);
  useEffect(() => {
    const q = query.trim();
    if (!q || !showJamendo) { setJamendoResults([]); setJamendoError(null); return; }
    let cancelled = false;
    setJamendoLoading(true);
    setJamendoError(null);
    const t = window.setTimeout(() => {
      cachedSearch("jamendo", q, () => searchJamendo(q))
        .then((tracks) => { if (!cancelled) setJamendoResults(tracks); })
        .catch((err) => {
          if (cancelled) return;
          setJamendoResults([]);
          setJamendoError(err instanceof Error && err.message ? err.message : "Free Music is unreachable right now.");
        })
        .finally(() => { if (!cancelled) setJamendoLoading(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [query, showJamendo, jamendoRetryGen]);

  // Home rail: what's popular on Free Music this week. Loaded once, fails silently
  // (the rail simply stays hidden) so a missing JAMENDO_CLIENT_ID never breaks home.
  const [freeRail, setFreeRail] = useState<GroicTrack[]>(NO_TRACKS);
  useEffect(() => {
    let cancelled = false;
    trendingJamendo().then((t) => { if (!cancelled) setFreeRail(t.slice(0, 20)); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // ─── My Files — songs imported from this phone ─────────────────────────────
  const localTracks = useLocalTracks();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  // Offline mode: when the phone has no connection, lead with what plays offline.
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  const onPickFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-picking the same file
    if (files.length === 0) return;
    setImporting(true);
    try {
      const { added, skipped } = await importLocalFiles(files);
      if (added.length) toast({ title: `Added ${added.length} ${added.length === 1 ? "song" : "songs"} to My Files` });
      if (skipped.length) toast({ title: `${skipped.length} ${skipped.length === 1 ? "file" : "files"} couldn't be added`, description: skipped.slice(0, 3).join(", "), variant: "destructive" });
    } finally { setImporting(false); }
  };
  const [scanning, setScanning] = useState(false);
  useEffect(() => { void loadDeviceArt(); }, []); // finish album art for songs scanned earlier
  const onScanPhone = async () => {
    if (scanning) return;
    hapticLight(); setScanning(true);
    try {
      const r = await scanDeviceMusic();
      if (r.ok) toast({ title: r.found === 0 ? "No music found on this phone" : `Found ${r.found} songs on this phone`, description: r.added || r.removed ? `${r.added} added${r.removed ? `, ${r.removed} removed` : ""}` : "Library already up to date" });
      else if (r.reason === "denied") toast({ title: "Music permission needed", description: "Allow \"Music and audio\" for DuoSpace in Android Settings → Apps → Permissions, then scan again.", variant: "destructive" });
      else toast({ title: "Couldn't scan this phone", description: r.reason === "unsupported" ? "Scanning is only available in the Android app." : "Update to the latest app build and try again.", variant: "destructive" });
    } finally { setScanning(false); }
  };
  const searchLocal = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? localTracks.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q)) : [];
  }, [localTracks, query]);

  // FIX ("the fixed songs on home should not also be there [in] trending"):
  // one song should not repeat between the stacked home rails. Playback
  // state (current track / queue) is deliberately NOT an input any more:
  // playing a song loads its whole rail into the queue, and filtering on
  // the queue made the rail you just tapped (and any rail sharing its
  // songs) empty itself — "the whole row disappears". See railDedupe.ts.
  const dedupedHome = useMemo(() => {
    const order = langPrefs;
    const byId = dedupeRails<{ title: string }>([
      { id: "history", items: historyRail?.results ?? [] },
      { id: "forYou", items: forYou },
      ...order.map((id) => ({ id: `lang:${id}`, items: trending[id] ?? [], minKeep: TREND_RAIL_MIN })),
    ]);
    const trendingByLang: TrendingBuckets = {};
    for (const id of order) trendingByLang[id] = (byId[`lang:${id}`] ?? []) as GroicTrack[];
    return {
      history: historyRail ? { term: historyRail.term, results: (byId.history ?? []) as SearchResult[] } : null,
      forYou: (byId.forYou ?? []) as GroicTrack[],
      trendingByLang,
      order,
    };
  }, [historyRail, forYou, trending, langPrefs]);

  // ═══ Premium music UI — state + handlers ════════════════════════════════
  // Everything below is presentation glue over the existing data logic above
  // (search, trending, playlist, downloads are unchanged). All provider shapes
  // are normalised to GroicTrack here so one card/row/sheet serves every source.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [activeGenre, setActiveGenre] = useState<Genre | null>(null);
  // Android hardware Back closes the genre page instead of leaving Music.
  useBackHandler(!!activeGenre, () => { setActiveGenre(null); });
  // Full-page lists (Liked Songs / My Files), same Back behaviour.
  const [listView, setListView] = useState<string | null>(null); // "liked" | "files" | `pl:<playlistId>`
  useBackHandler(!!listView, () => { setListView(null); });
  // ─── My playlists (personal, this device) ─────────────────────────────────
  const myPlaylists = usePlaylists();
  const localById = useMemo(() => new Map(localTracks.map((t) => [t.providerTrackId, t])), [localTracks]);
  const activePl = listView?.startsWith("pl:") ? myPlaylists.find((p) => `pl:${p.id}` === listView) ?? null : null;
  const activePlTracks = useMemo(() => (activePl ? resolvePlaylistTracks(activePl, localById) : []), [activePl, localById]);
  useEffect(() => { if (listView?.startsWith("pl:") && !activePl) setListView(null); }, [listView, activePl]); // deleted while open
  const [pickTrack, setPickTrack] = useState<GroicTrack | null>(null);
  const [nameSheet, setNameSheet] = useState<{ mode: "new" | "rename"; id?: string; seed?: GroicTrack | null; value: string } | null>(null);
  const [confirmDeletePl, setConfirmDeletePl] = useState<string | null>(null);
  const saveName = () => {
    if (!nameSheet) return;
    if (nameSheet.mode === "rename" && nameSheet.id) {
      if (!renamePlaylist(nameSheet.id, nameSheet.value)) { toast({ title: "Enter a name", variant: "destructive" }); return; }
    } else {
      const id = createPlaylist(nameSheet.value, nameSheet.seed ?? undefined);
      if (!id) { toast({ title: "Couldn't create playlist", description: nameSheet.value.trim() ? "Playlist limit reached." : "Enter a name first.", variant: "destructive" }); return; }
      toast({ title: nameSheet.seed ? `Added to “${nameSheet.value.trim()}”` : "Playlist created" });
    }
    setNameSheet(null);
  };
  const pickPlaylist = (id: string, name: string) => {
    if (!pickTrack) return;
    const r = addToPlaylist(id, pickTrack);
    toast({ title: r === "added" ? `Added to “${name}”` : r === "duplicate" ? `Already in “${name}”` : "Couldn't add to playlist", variant: r === "full" || r === "missing" ? "destructive" : undefined });
    setPickTrack(null);
  };

  const likedTracks = useLikedTracks();
  const recentTracks = useRecentTracks();
  const [actionTrack, setActionTrack] = useState<GroicTrack | null>(null);
  const actionLiked = !!actionTrack && likedTracks.some((t) => t.id === actionTrack.id);
  const searching = query.trim().length > 0;

  // ─── Back = step out of the current music layer, never straight out of Music ─────────────────────
  // BUG FIX: after searching, Back (the header chevron AND the Android back button) left the page — landing in chat —
  // because search is just a text query, not a route, so nothing owned that Back press. Now Back clears the search
  // first (returning to Music home); only a Back from home itself leaves the page.
  const clearSearch = useCallback(() => {
    setQuery("");
    (document.activeElement as HTMLElement | null)?.blur?.();
    scrollRef.current?.scrollTo({ top: 0 });
  }, []);
  useBackHandler(searching, () => { clearSearch(); });
  const goBackInMusic = (): boolean => {
    if (searching) { clearSearch(); return true; }
    if (activeGenre) { setActiveGenre(null); return true; }
    if (listView) { setListView(null); return true; }
    return false;
  };

  // ─── Pull to refresh ─────────────────────────────────────────────────────────────────────────────
  const ptrContentRef = useRef<HTMLDivElement>(null);
  const ptrIndicatorRef = useRef<HTMLDivElement>(null);
  const [genreRefreshKey, setGenreRefreshKey] = useState(0);
  const refreshMusic = async () => {
    hapticMedium();
    if (searching) { await search(query, { remember: false }); return; }   // re-run the current search
    if (activeGenre) { setGenreRefreshKey((k) => k + 1); return; }          // genre page refetches, ignoring its cache
    setDownloads(listDownloads());
    if (listView) return;                                                    // library lists are local — nothing to fetch
    loadTrending(true);                                                      // trending rails (existing rails stay until new ones land)
    try {                                                                    // "Made for you" from the current taste profile
      const fresh = await fetchAutoNext({ current: null, queue: [], limit: 12 });
      if (fresh.length > 0) setForYou(fresh);
    } catch { /* best effort — keep what is on screen */ }
  };
  const refreshMusicRef = useRef(refreshMusic);
  refreshMusicRef.current = refreshMusic;
  const onPullRefresh = useCallback(() => refreshMusicRef.current(), []);
  usePullToRefresh(scrollRef, ptrContentRef, ptrIndicatorRef, { onRefresh: onPullRefresh, onThreshold: hapticLight });

  const greeting = useMemo(() => {
    const h = new Date().getHours();
    return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  }, []);

  /** Play `t` with an up-next pool built from `pool` (deduped, shuffled,
   *  minus recently played) — same behaviour every rail used before. */
  const playFrom = useCallback((t: GroicTrack, pool: GroicTrack[]) => {
    hapticMedium();
    // withoutSameName: never queue "Payal (Remix)" / "Payal Ki Jhankar" behind "Payal".
    const rest = buildUpNextPool(withoutSameName(pool, t), t, (x) => x.id, Math.random, getRecentlyPlayedKeys());
    playTrack(t, [t, ...rest]);
  }, [playTrack]);

  /** Tapped from SEARCH results: the pool is "everything matching the query",
   *  so only a few different songs come from it; the rest of the queue is
   *  taste-based suggestions (autoNext) that top up the moment the song starts.
   *  Before this, searching "payal" queued only "payal" songs. */
  // Read the query through a ref so this handler stays referentially stable while typing.
  const queryRef = useRef(query);
  queryRef.current = query;
  const playFromSearch = useCallback((t: GroicTrack, pool: GroicTrack[]) => {
    hapticMedium();
    const rest = buildSearchUpNext(pool, t, (x) => x.id, queryRef.current, { excludeKeys: getRecentlyPlayedKeys() });
    playTrack(t, [t, ...rest]);
  }, [playTrack]);

  const ytTracks = useMemo(() => results.map(youtubeResultToTrack), [results]);
  const historyTracks = useMemo(
    () => (dedupedHome.history?.results ?? []).map(youtubeResultToTrack),
    [dedupedHome.history],
  );
  const recentList = useMemo(() => recentTracks.map(unslim), [recentTracks]);
  const recentShelf = useMemo(() => recentList.slice(0, 15), [recentList]);
  const historyShelf = useMemo(() => historyTracks.slice(0, 10), [historyTracks]);
  const trendingRails = useMemo(() => {
    const out: Record<string, GroicTrack[]> = {};
    for (const id of dedupedHome.order) out[id] = (dedupedHome.trendingByLang[id] ?? []).slice(0, TREND_RAIL_SIZE);
    return out;
  }, [dedupedHome]);
  const likedList = useMemo(() => likedTracks.map(unslim), [likedTracks]);

  const addTrackToPlaylist = (t: GroicTrack) => {
    if (t.provider === "youtube") {
      return addYouTubeToPlaylist({ videoId: t.videoId, title: t.title, artist: t.artist, thumbnail: t.thumbnail ?? "", duration: t.duration, url: `https://www.youtube.com/watch?v=${t.videoId}` });
    }
    if (t.provider === "audius") return addAudiusToPlaylist(t);
    if (t.provider === "soundcloud") return addSoundCloudToPlaylist(t);
    if (t.provider === "jamendo") return addJamendoToPlaylist(t);
    if (t.provider === "local") { toast({ title: "Files on your phone can't go in Our Playlist", description: "Your partner doesn't have them.", variant: "destructive" }); return; }
    toast({ title: "Can't add this track to the playlist", variant: "destructive" });
  };
  const onMore = useCallback((t: GroicTrack) => { hapticLight(); setActionTrack(t); }, []);

  // ANDROID BACK: the back stack is LIFO and only falls back to Radix layers (drawers/dialogs) when
  // it is EMPTY — so with a track menu open over a genre/list page, Back used to close the PAGE
  // behind the menu and leave the menu up. Registering the open overlay here puts it above the
  // genre/list handlers (they were pushed earlier), so Back dismisses the topmost layer first.
  const overlayOpen = !!(actionTrack || pickTrack || nameSheet || confirmDeletePl || confirmRemovePlaylistSong || showAddPlaylistLink);
  useBackHandler(overlayOpen, () => {
    if (confirmDeletePl) { setConfirmDeletePl(null); return true; }
    if (confirmRemovePlaylistSong) { setConfirmRemovePlaylistSong(null); return true; }
    if (nameSheet) { setNameSheet(null); return true; }
    if (pickTrack) { setPickTrack(null); return true; }
    if (showAddPlaylistLink) { setShowAddPlaylistLink(false); return true; }
    if (actionTrack) { setActionTrack(null); return true; }
    return false;
  });
  const queueAdd = (t: GroicTrack) => { hapticLight(); enqueue(t); toast({ title: "Added to queue" }); };
  const queueNext = (t: GroicTrack) => { hapticLight(); playNext(t); toast({ title: "Playing next" }); };
  const likeToggle = (t: GroicTrack) => {
    hapticMedium();
    const on = toggleLiked(t);
    toast({ title: on ? "Added to Liked Songs" : "Removed from Liked Songs" });
  };
  const moreByArtist = (t: GroicTrack) => {
    hapticLight();
    setQuery(t.artist);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };
  const playSolo = (t: GroicTrack) => { hapticMedium(); playTrack(t, [t]); };

  const playLiked = (shuffle: boolean) => {
    if (likedList.length === 0) return;
    const q = shuffle ? shuffled(likedList) : likedList;
    hapticMedium();
    playTrack(q[0], q);
  };

  // "Your mix" hero: suggestions from your taste profile, else the first
  // trending rail that has loaded. Hidden until there is something to play.
  const mixPool = useMemo(
    () => dedupedHome.forYou.length > 0
      ? dedupedHome.forYou
      : (dedupedHome.order.map((id) => dedupedHome.trendingByLang[id] ?? []).find((r) => r.length > 0) ?? []),
    [dedupedHome],
  );
  const playMix = () => {
    if (mixPool.length === 0) return;
    const pool = shuffled(mixPool);
    playFrom(pool[0], pool);
  };

  // Our Playlist rows → playable tracks (for "Play all" / "Shuffle").
  const songToTrack = (song: OurPlaylistSong): GroicTrack | null => {
    if (song.platform === "youtube") {
      const mt = song.song_url.match(YOUTUBE_URL_ID_RE);
      return mt ? youtubeResultToTrack({ videoId: mt[1], title: song.title, artist: song.artist, thumbnail: song.thumbnail_url || "", duration: 0, url: song.song_url }) : null;
    }
    if (song.platform === "audius" || (song.platform === "soundcloud" && song.song_url.startsWith("soundcloud:")) || (song.platform === "jamendo" && song.song_url.startsWith("jamendo:"))) {
      const provider = song.platform as "audius" | "soundcloud" | "jamendo";
      const prefix = `${provider}:`;
      const providerTrackId = song.song_url.startsWith(prefix) ? song.song_url.slice(prefix.length) : song.song_url;
      return {
        id: `${provider}:${providerTrackId}`, provider, providerTrackId, videoId: providerTrackId,
        title: song.title, artist: song.artist, thumbnail: song.thumbnail_url, duration: 0,
        isStreamable: true, isDownloadable: false,
      };
    }
    return null;
  };
  const playAllPlaylist = (shuffle: boolean) => {
    const list = ourPlaylist.songs.map(songToTrack).filter((x): x is GroicTrack => !!x);
    if (list.length === 0) { toast({ title: "Nothing playable in-app yet", description: "Pasted Spotify/Apple links open externally." }); return; }
    const q = shuffle ? shuffled(list) : list;
    hapticMedium();
    playTrack(q[0], q);
  };

  const downloadToTrack = (d: DownloadedTrack): GroicTrack => ({
    id: d.id, provider: "audius", providerTrackId: d.providerTrackId, videoId: d.providerTrackId,
    title: d.title, artist: d.artist, thumbnail: d.thumbnail, duration: d.duration, isStreamable: true, isDownloadable: true,
  });

  // Top result for the search screen: SoundCloud is the primary provider.
  const topResult: GroicTrack | null = searching
    ? ((showLocal ? searchLocal[0] : undefined)
      ?? (showSoundCloud ? soundcloudResults[0] : undefined)
      ?? (showJamendo ? jamendoResults[0] : undefined)
      ?? (showAudius ? audiusResults[0] : undefined)
      ?? (showYouTube ? ytTracks[0] : undefined)
      ?? null)
    : null;
  const topPool = !topResult ? [] : topResult.provider === "local" ? searchLocal : topResult.provider === "soundcloud" ? soundcloudResults : topResult.provider === "jamendo" ? jamendoResults : topResult.provider === "audius" ? audiusResults : ytTracks;

  // SPEED: resolve stream URLs for the songs a person is most likely to tap
  // (top search hits, or recents + the first rail on home) in ONE batched
  // request, so tapping play doesn't wait on the network. Debounced; skipped
  // for anything already cached; never blocks or throws.
  const firstRail = dedupedHome.forYou.length > 0 ? dedupedHome.forYou : (trendingRails[dedupedHome.order[0]] ?? NO_TRACKS);
  // Returning from the background (>4 min) leaves the cached stream URLs stale; re-warm the visible songs.
  const [fgTick, setFgTick] = useState(0);
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "visible") setFgTick((n) => n + 1); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (searching) warmStreams?.([...soundcloudResults.slice(0, 4), ...audiusResults.slice(0, 2), ...jamendoResults.slice(0, 2)]);
      else warmStreams?.(recentList.slice(0, 6).concat(firstRail.slice(0, 6)));
    }, searching ? 250 : 1200);
    return () => window.clearTimeout(t);
  }, [searching, soundcloudResults, audiusResults, jamendoResults, recentList, firstRail, warmStreams, fgTick]);

  // Quick picks (Spotify's six-tile "familiar" grid): Liked Songs + what you
  // played most recently. No placeholder tiles — hidden when there's no history.
  const quickRecents = recentList.slice(0, likedList.length > 0 ? 5 : 6);
  const hasQuickPicks = likedList.length > 0 || quickRecents.length > 0;

  return (
    <motion.div
      ref={scrollRef}
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-40"
      style={{ WebkitOverflowScrolling: "touch" as any }}
    >
      <header className="safe-top px-5 pt-3 pb-3 sticky top-0 z-20 bg-background/95">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={() => { if (!goBackInMusic()) navigate(-1); }}
            className="h-10 w-10 rounded-full bg-foreground/[0.07] flex items-center justify-center active:scale-95" aria-label="Back">
            <ChevronLeft className="h-5 w-5" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-[22px] font-extrabold tracking-tight leading-none flex items-center gap-1.5">
              Groic <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
            </h1>
            <p className="text-[10px] text-muted-foreground mt-1 truncate">Listen together · low-latency sync</p>
          </div>
          <button onClick={() => { hapticLight(); fileInputRef.current?.click(); }} disabled={importing}
            className="h-9 w-9 rounded-full bg-foreground/[0.07] flex items-center justify-center active:scale-95 disabled:opacity-50" aria-label="Upload songs from this phone">
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          </button>
          <button
            onClick={async () => {
              if (sessionRole === "solo") { await startSession(); toast({ title: "Session started 🎶" }); }
              else { await endSession(); toast({ title: "Session ended" }); }
            }}
            className={cn(
              "h-9 px-3.5 rounded-full text-[12px] font-semibold flex items-center gap-1.5 active:scale-95 transition-colors",
              sessionRole !== "solo" ? "bg-primary text-primary-foreground" : "bg-foreground/[0.07] text-foreground",
            )}
          >
            <Users className="h-3.5 w-3.5" /> {sessionRole === "solo" ? "Together" : partnerListening ? "Connected" : sessionRole}
            {sessionRole !== "solo" && partnerListening && (
              <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" />
            )}
          </button>
        </div>
        {(isPlaying || sleep.active) && (
          <div className="mb-2 flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button onClick={() => { hapticLight(); setSleepOpen(o => !o); }} aria-expanded={sleepOpen} aria-label="Sleep timer"
              className={cn("shrink-0 h-8 px-3 rounded-full text-[12px] font-semibold flex items-center gap-1.5 active:scale-95", sleep.active ? "bg-primary text-primary-foreground" : "bg-foreground/[0.07]")}>
              <Moon className="h-3.5 w-3.5" /> {sleep.active ? `Sleep in ${formatRemaining(sleep.remainingMs)}` : "Sleep timer"}
            </button>
            {sleepOpen && (
              <>
                {[15, 30, 45, 60].map(m => (
                  <button key={m} onClick={() => { hapticLight(); sleep.start(m); setSleepOpen(false); toast({ title: `Music will fade out in ${m} min` }); }}
                    className="shrink-0 h-8 px-3 rounded-full bg-foreground/[0.07] text-[12px] font-semibold active:scale-95">{m} min</button>
                ))}
                {sleep.active && (
                  <button onClick={() => { hapticLight(); sleep.cancel(); setSleepOpen(false); }}
                    className="shrink-0 h-8 px-3 rounded-full bg-foreground/[0.07] text-[12px] font-semibold text-destructive active:scale-95">Cancel</button>
                )}
              </>
            )}
          </div>
        )}
        <div className="relative">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && search(query)}
            placeholder="What do you want to listen to?"
            enterKeyHint="search"
            className="h-12 pl-11 pr-12 rounded-full bg-foreground/[0.07] border-transparent text-[15px] focus-visible:ring-primary/40"
            aria-label="Search music"
          />
          {loading ? (
            <Loader2 className="absolute right-4 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
          ) : query && (
            <button onClick={() => { hapticLight(); setQuery(""); }} aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-9 w-9 rounded-full flex items-center justify-center text-muted-foreground active:scale-90">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {/* Pull-to-refresh strip: zero-height anchor at the content's top edge; the hook grows it to the pull distance. */}
      <div className="relative h-0 z-10" aria-hidden="true">
        <div ref={ptrIndicatorRef} className="absolute left-0 right-0 top-0 flex items-center justify-center overflow-hidden pointer-events-none opacity-0" style={{ height: 0 }}>
          <span className="h-9 w-9 rounded-full bg-card ring-1 ring-border shadow-md flex items-center justify-center text-primary">
            <RefreshCw data-ptr-icon className="h-4 w-4" />
          </span>
        </div>
      </div>
      <div ref={ptrContentRef} className="px-5 pt-3 space-y-8">
        {!searching && activeGenre && (
          <GenreView genre={activeGenre} refreshKey={genreRefreshKey} onBack={() => setActiveGenre(null)} current={current} isPlaying={isPlaying}
            onPlay={playFrom} onMore={onMore} />
        )}

        {/* Always mounted so Import works from the home shelf AND the My Files page. */}
        <input ref={fileInputRef} type="file" accept="audio/*,.mp3,.m4a,.aac,.wav,.flac,.ogg,.opus" multiple className="hidden" onChange={onPickFiles} aria-label="Import songs from this phone" />

        {!searching && !activeGenre && listView === "liked" && (
          <TrackListView title="Liked Songs" icon={<Heart fill="currentColor" />} gradient={WINE_SURFACE}
            tracks={likedList} current={current} isPlaying={isPlaying} onBack={() => setListView(null)} onPlay={playFrom} onMore={onMore}
            emptyText="Tap the heart on any song to save it here." />
        )}
        {!searching && !activeGenre && listView === "playlists" && (
          <div className="space-y-5">
            <div className={cn("relative rounded-3xl p-5 pt-4 overflow-hidden text-white", WINE_SURFACE)}>
              <div className="flex items-center justify-between">
                <button onClick={() => { hapticLight(); setListView(null); }} aria-label="Back"
                  className="h-9 w-9 -ml-2 rounded-full flex items-center justify-center bg-black/20 active:scale-90 transition-transform"><ChevronLeft className="h-5 w-5" /></button>
                <button onClick={() => { hapticLight(); setNameSheet({ mode: "new", value: "" }); }}
                  className="h-9 px-3 rounded-full bg-black/25 text-[12px] font-semibold flex items-center gap-1 active:scale-95"><Plus className="h-3.5 w-3.5" /> New playlist</button>
              </div>
              <span aria-hidden="true" className="absolute right-4 top-10 opacity-25 [&>svg]:h-24 [&>svg]:w-24"><Library /></span>
              <h2 className="mt-7 text-[30px] font-extrabold tracking-tight leading-none">Playlists</h2>
              <p className="text-[12px] opacity-90 mt-1.5">{myPlaylists.length} {myPlaylists.length === 1 ? "playlist" : "playlists"} on this phone</p>
            </div>
            {myPlaylists.length === 0 && <p className="text-xs text-muted-foreground text-center py-10">Create a playlist, then add songs from the ⋯ menu on any song.</p>}
            <div>
              {myPlaylists.map((p, i) => (
                <button key={p.id} onClick={() => { hapticLight(); setListView(`pl:${p.id}`); }}
                  className="w-full flex items-center gap-3 py-2 px-1.5 -mx-1.5 rounded-2xl text-left active:bg-foreground/5">
                  <span className={cn("h-12 w-12 shrink-0 rounded-xl flex items-center justify-center", toneFor(p.id))}><Library className="h-5 w-5 text-white" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold truncate">{p.name}</span>
                    <span className="block text-xs text-muted-foreground">{p.tracks.length} {p.tracks.length === 1 ? "song" : "songs"}</span>
                  </span>
                  <ChevronLeft className="h-4 w-4 rotate-180 text-muted-foreground" aria-hidden="true" />
                </button>
              ))}
            </div>
          </div>
        )}
        {!searching && !activeGenre && activePl && (
          <TrackListView title={activePl.name} icon={<Library />} gradient={toneFor(activePl.id)}
            tracks={activePlTracks} current={current} isPlaying={isPlaying} onBack={() => setListView(null)} onPlay={playFrom} onMore={onMore}
            onRemove={(t) => { hapticWarning(); removeFromPlaylist(activePl.id, t.id); }}
            headerAction={<div className="flex items-center gap-1.5">
              <button onClick={() => { hapticLight(); setNameSheet({ mode: "rename", id: activePl.id, value: activePl.name }); }} aria-label="Rename playlist"
                className="h-9 w-9 rounded-full bg-black/25 flex items-center justify-center active:scale-90"><Pencil className="h-4 w-4" /></button>
              <button onClick={() => { hapticWarning(); setConfirmDeletePl(activePl.id); }} aria-label="Delete playlist"
                className="h-9 w-9 rounded-full bg-black/25 flex items-center justify-center active:scale-90"><Trash2 className="h-4 w-4" /></button>
            </div>}
            emptyText="Empty for now — tap ⋯ on any song and choose “Add to my playlist”." />
        )}
        {!searching && !activeGenre && listView === "files" && (
          <TrackListView title="My Files" icon={<ListMusic />} gradient={toneFor("files")}
            tracks={localTracks} current={current} isPlaying={isPlaying} onBack={() => setListView(null)} onPlay={playFrom} onMore={onMore}
            onRemove={(t) => { hapticWarning(); void removeLocalTrack(t.providerTrackId); }}
            headerAction={<div className="flex items-center gap-1.5">
              {isDeviceScanSupported() && (
                <button onClick={onScanPhone} disabled={scanning}
                  className="h-9 px-3 rounded-full bg-black/25 text-[12px] font-semibold flex items-center gap-1 active:scale-95 disabled:opacity-50">
                  {scanning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Smartphone className="h-3.5 w-3.5" />} Scan phone
                </button>
              )}
              <button onClick={() => { hapticLight(); fileInputRef.current?.click(); }} disabled={importing}
                className="h-9 px-3 rounded-full bg-black/25 text-[12px] font-semibold flex items-center gap-1 active:scale-95 disabled:opacity-50">
                {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Upload
              </button>
            </div>}
            emptyText="Import songs from your phone — they play offline, even with the screen off." />
        )}

        {!searching && !activeGenre && !listView && (
          <>
            {!online && (
              <section aria-label="Offline" className="rounded-2xl border border-border/60 bg-card p-3.5 flex items-center gap-3">
                <WifiOff className="h-5 w-5 text-muted-foreground shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">You're offline</p>
                  <p className="text-xs text-muted-foreground">{localTracks.length + downloads.length > 0 ? `${localTracks.length} uploaded + ${downloads.length} downloaded songs still play.` : "Upload songs from your phone to play them without internet."}</p>
                </div>
                {localTracks.length > 0 ? (
                  <button onClick={() => { hapticMedium(); const q = shuffled(localTracks); playFrom(q[0], q); }}
                    className="h-9 px-3 rounded-full bg-primary text-primary-foreground text-[12px] font-semibold flex items-center gap-1 active:scale-95"><Shuffle className="h-3.5 w-3.5" /> Play</button>
                ) : (
                  <button onClick={() => { hapticLight(); fileInputRef.current?.click(); }}
                    className="h-9 px-3 rounded-full bg-primary text-primary-foreground text-[12px] font-semibold flex items-center gap-1 active:scale-95"><Upload className="h-3.5 w-3.5" /> Upload</button>
                )}
              </section>
            )}
            {/* Greeting + Spotify-style quick picks */}
            <section aria-label="Quick picks" className="space-y-3">
              <div>
                <h2 className="text-[28px] font-extrabold tracking-[-0.025em] leading-[1.1]">{greeting}</h2>
                <p className="text-[14px] text-muted-foreground mt-1.5">
                  {sessionRole !== "solo" && partnerListening ? "You're listening together right now" : "Pick up where you left off"}
                </p>
              </div>
              {hasQuickPicks && (
                <div className="grid grid-cols-2 gap-2.5">
                  {likedList.length > 0 && (
                    <QuickTile title="Liked Songs" icon={<Heart className="h-5 w-5" fill="currentColor" />} onClick={() => playLiked(false)} />
                  )}
                  {quickRecents.map((t) => (
                    <QuickTile key={t.id} title={t.title} cover={artOf(t)} isCurrent={current?.id === t.id}
                      onClick={() => playFrom(t, recentList)} />
                  ))}
                </div>
              )}
            </section>

            {/* "Your mix" hero */}
            {mixPool.length > 0 && (
              <button onClick={() => { hapticMedium(); playMix(); }}
                className="relative isolate w-full overflow-hidden rounded-[28px] p-5 text-left text-white active:scale-[0.985] transition-transform shadow-[0_16px_36px_-24px_hsl(350_60%_20%/0.8)] bg-gradient-to-br from-[hsl(350_48%_28%)] to-[hsl(350_28%_11%)] border border-white/5">
                <ArtworkWash src={artOf(mixPool[0])} />
                <p className="text-[10px] uppercase tracking-[0.22em] opacity-70">Made for you</p>
                <p className="text-[28px] font-extrabold tracking-[-0.025em] leading-none mt-2">Your mix</p>
                <p className="text-[13.5px] opacity-85 mt-2 max-w-[200px] leading-snug">Fresh songs picked from what you actually play.</p>
                <span className="mt-5 inline-flex h-12 px-6 rounded-full bg-white text-black text-[15px] font-bold items-center gap-2 shadow-[0_10px_24px_-8px_rgba(0,0,0,0.6)]">
                  <Play className="h-4 w-4" fill="currentColor" /> Play mix
                </span>
                <div aria-hidden="true" className="absolute right-4 bottom-4 flex -space-x-5">
                  {mixPool.slice(0, 3).map((t, i) => (
                    <Cover key={t.id} src={artOf(t)} seed={t} rounded="rounded-xl" className={cn("h-20 w-20 ring-2 ring-white/30 shadow-2xl", i === 0 && "-rotate-6", i === 2 && "rotate-6")} />
                  ))}
                </div>
              </button>
            )}

            <TrackShelf title="Recently played" items={recentShelf} current={current} isPlaying={isPlaying}
              onPlay={playFrom} onMore={onMore}
              action={<button onClick={() => { hapticLight(); clearRecentTracks(); }} className="text-[12px] font-semibold text-muted-foreground active:scale-95">Clear</button>} />

            {/* Your library — one tidy hub instead of three long shelves; each tile opens its full page */}
            <section aria-label="Your library" className="space-y-3">
              <h2 className="text-[17px] leading-tight font-bold tracking-[-0.01em]">Your library</h2>
              <div className="grid grid-cols-2 gap-2.5">
                {([
                  { key: "liked", unit: undefined as string[] | undefined, label: "Liked Songs", count: likedList.length, icon: <Heart className="h-5 w-5" fill="currentColor" />, grad: "from-violet-500 to-indigo-700", go: () => setListView("liked") },
                  { key: "files", label: "My Files", count: localTracks.length, icon: <ListMusic className="h-5 w-5" />, grad: "from-emerald-500 to-teal-700", go: () => setListView("files") },
                  { key: "playlists", label: "Playlists", unit: ["playlist", "playlists"], count: myPlaylists.length, icon: <Library className="h-5 w-5" />, grad: "from-rose-500 to-orange-700", go: () => setListView("playlists") },
                  { key: "ours", label: "Our Playlist", count: ourPlaylist.songs?.length ?? 0, icon: <Users className="h-5 w-5" />, grad: "from-sky-500 to-blue-700", go: () => document.getElementById("groic-our-playlist")?.scrollIntoView({ behavior: "smooth", block: "start" }) },
                ]).map((t) => (
                  <button key={t.key} onClick={() => { hapticLight(); t.go(); if (t.key !== "ours") scrollRef.current?.scrollTo({ top: 0 }); }}
                    className="flex items-center gap-3 p-3 pr-3.5 rounded-[20px] bg-card border border-border/40 text-left active:scale-[0.97] transition-transform outline-none focus-visible:ring-2 focus-visible:ring-primary/70">
                    <span className={cn("h-11 w-11 shrink-0 rounded-xl flex items-center justify-center", WINE_CHIP)}>{t.icon}</span>
                    <span className="min-w-0">
                      <span className="block text-[14.5px] font-semibold leading-tight truncate">{t.label}</span>
                      <span className="block text-[11px] text-muted-foreground mt-0.5">{t.count} {t.count === 1 ? (t.unit?.[0] ?? "song") : (t.unit?.[1] ?? "songs")}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <TrackShelf title="Made for you" subtitle="Based on what you play" items={dedupedHome.forYou} current={current} isPlaying={isPlaying}
              onPlay={playFrom} onMore={onMore} />

            <TrackShelf title={dedupedHome.history ? `Because you searched “${dedupedHome.history.term}”` : ""}
              items={historyShelf} current={current} isPlaying={isPlaying} onPlay={playFrom} onMore={onMore} />

            <div id="groic-our-playlist" className="scroll-mt-24">
            {/* Our Playlist — shared couple playlist, attribution on every row */}
            <Shelf title="Our Playlist" subtitle="Shared with your partner"
              action={
                <div className="flex items-center gap-1.5">
                  {ourPlaylist.songs.length > 0 && (
                    <>
                      <button onClick={() => playAllPlaylist(true)} aria-label="Shuffle Our Playlist"
                        className="h-9 w-9 rounded-full bg-foreground/[0.07] flex items-center justify-center active:scale-90"><Shuffle className="h-4 w-4" /></button>
                      <button onClick={() => playAllPlaylist(false)} aria-label="Play Our Playlist"
                        className="h-9 w-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center active:scale-90"><Play className="h-4 w-4 ml-0.5" fill="currentColor" /></button>
                    </>
                  )}
                  <button onClick={() => setShowAddPlaylistLink(true)} aria-label="Add a song by link"
                    className="h-9 w-9 rounded-full bg-foreground/[0.07] flex items-center justify-center active:scale-90"><Plus className="h-4 w-4" /></button>
                </div>
              }>
              {ourPlaylist.loading ? (
                <div className="space-y-2" aria-busy="true" aria-label="Loading playlist">
                  {Array.from({ length: 2 }).map((_, i) => <Shimmer key={i} className="h-14 rounded-2xl" />)}
                </div>
              ) : ourPlaylist.error ? (
                <p className="text-xs text-muted-foreground py-2">Couldn't load your playlist right now.</p>
              ) : ourPlaylist.songs.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border/70 p-5 text-center">
                  <ListMusic className="h-6 w-6 mx-auto text-muted-foreground" aria-hidden="true" />
                  <p className="text-sm font-semibold mt-2">Start your playlist</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Tap “…” on any song and choose Add to Our Playlist, or paste a link with +.</p>
                </div>
              ) : (
                <div>
                  {ourPlaylist.songs.map((song) => {
                    const isCurrent = !!current && (
                      (song.platform === "youtube" && current.videoId === song.song_url.match(YOUTUBE_URL_ID_RE)?.[1]) ||
                      (song.platform === "audius" && current.provider === "audius" && current.providerTrackId === (song.song_url.startsWith("audius:") ? song.song_url.slice(7) : song.song_url)) ||
                      (song.platform === "soundcloud" && current.provider === "soundcloud" && song.song_url.startsWith("soundcloud:") && current.providerTrackId === song.song_url.slice(11)) ||
                      (song.platform === "jamendo" && current.provider === "jamendo" && song.song_url.startsWith("jamendo:") && current.providerTrackId === song.song_url.slice(8))
                    );
                    const playable = !!songToTrack(song);
                    return (
                      <div key={song.id} className={cn("flex items-center gap-3 py-1.5 px-1.5 -mx-1.5 rounded-2xl transition-colors", isCurrent ? "bg-primary/[0.07]" : "active:bg-foreground/5")}>
                        <button onClick={() => playOurPlaylistSong(song)} className="flex items-center gap-3 flex-1 min-w-0 text-left" aria-label={playable ? `Play ${song.title}` : `Open ${song.title}`}>
                          <div className="relative">
                            <Cover src={song.thumbnail_url} seed={{ title: song.title, artist: song.artist }} className="h-12 w-12" />
                            {isCurrent && <span className="absolute inset-0 rounded-xl bg-black/45 flex items-center justify-center text-white"><Equalizer paused={!isPlaying} className="h-3" /></span>}
                            {!playable && <span className="absolute -bottom-1 -right-1 h-5 w-5 rounded-full bg-background border border-border flex items-center justify-center"><ExternalLink className="h-2.5 w-2.5" /></span>}
                          </div>
                          <div className="min-w-0">
                            <p className={cn("text-[14px] font-semibold truncate", isCurrent && "text-primary")}>{song.title}</p>
                            <p className="text-[12px] text-muted-foreground truncate">{song.artist}</p>
                            <p className="text-[10px] text-muted-foreground/80 truncate">Added by {ourPlaylist.attributionFor(song.added_by)}</p>
                          </div>
                        </button>
                        <button onClick={() => { hapticWarning(); setConfirmRemovePlaylistSong(song); }}
                          aria-label={`Remove ${song.title} from Our Playlist`}
                          className="h-10 w-10 rounded-full flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors shrink-0">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </Shelf>

            </div>

            {recent.length > 0 && (
              <Shelf title="Recent searches">
                <div className="flex gap-2 overflow-x-auto pb-1 -mx-5 px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {recent.map(r => (
                    <button key={r} onClick={() => { hapticLight(); setQuery(r); }}
                      className="shrink-0 h-9 pl-3 pr-4 rounded-full bg-foreground/[0.07] text-[13px] flex items-center gap-1.5 active:scale-95">
                      <History className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" /> {r}
                    </button>
                  ))}
                </div>
              </Shelf>
            )}

            {/* Downloads — native only, hidden when empty */}
            {isOfflineDownloadSupported() && downloads.length > 0 && (
              <Shelf title="Downloads" subtitle="Available offline">
                <div>
                  {downloads.map((d) => {
                    const t = downloadToTrack(d);
                    return (
                      <TrackRow key={d.id} track={t} isCurrent={current?.id === t.id} isPlaying={isPlaying}
                        onPlay={() => playDownload(d)} onMore={() => onMore(t)}
                        right={
                          <button onClick={() => removeDownloadedTrack(d)} aria-label={`Remove downloaded ${d.title}`}
                            className="h-10 w-10 rounded-full text-muted-foreground active:scale-90 flex items-center justify-center shrink-0">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        } />
                    );
                  })}
                </div>
              </Shelf>
            )}

            <p className="-mb-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">Discover</p>
            {/* Language picker + per-language trending */}
            <section>
              <div className="flex items-end justify-between mb-3">
                <div>
                  <h2 className="text-[19px] leading-tight font-bold tracking-tight">Trending</h2>
                  <p className="text-[11px] text-muted-foreground mt-0.5">Languages{langPrefs.length ? ` · ${langPrefs.length}` : ""}</p>
                </div>
                <button onClick={() => { hapticLight(); loadTrending(true); }}
                  className="text-[12px] font-semibold text-muted-foreground flex items-center gap-1 active:scale-95" aria-label="Shuffle trending">
                  <RefreshCw className={cn("h-3.5 w-3.5", trendingLoading && "animate-spin")} /> Shuffle
                </button>
              </div>
            {/* One scrollable bar. Tap = select, tap again = deselect. */}
            <div role="group" aria-label="Trending languages"
              className="flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-1 -mx-1 rounded-2xl bg-muted/40 border border-border/50">
              {LANG_OPTIONS.map(l => {
                const active = langPrefs.includes(l.id);
                return (
                  <button key={l.id}
                    onClick={() => { hapticLight(); toggleLangPref(l.id); }}
                    aria-pressed={active}
                    className={cn(
                      "shrink-0 h-10 pl-2.5 pr-3 rounded-xl flex items-center gap-1.5 transition-all active:scale-95",
                      active
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <span className={cn(
                      "h-4 w-4 rounded-full flex items-center justify-center shrink-0 border transition-colors",
                      active ? "bg-primary-foreground/25 border-transparent" : "border-muted-foreground/40",
                    )}>
                      {active && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                    </span>
                    <span className="flex flex-col items-start leading-none">
                      <span className="text-xs font-semibold">{l.label}</span>
                      {l.native !== l.label && <span className={cn("text-[9px] mt-0.5", active ? "opacity-80" : "opacity-60")}>{l.native}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

            {dedupedHome.order.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">Pick a language above to see what's trending.</p>
            )}
            {trendingError ? (
              <div role="alert" className="flex flex-col items-center justify-center py-8 text-center">
                <div className="h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
                  <WifiOff className="h-5 w-5 text-destructive" />
                </div>
                <p className="text-sm font-medium">Couldn't load trending songs</p>
                <Button size="sm" variant="outline" className="mt-4 rounded-full" onClick={() => { loadTrending(true); }}>Try again</Button>
              </div>
            ) : dedupedHome.order.map((id) => {
              const label = LANG_OPTIONS.find(l => l.id === id)?.label ?? id;
              const items = trendingRails[id] ?? NO_TRACKS;
              // A rail already on screen is never replaced by a placeholder while it refreshes.
              if (items.length === 0 && loadingLangs.has(id)) {
                return (
                  <Shelf key={id} title={`Trending · ${label}`}>
                    <ShelfSkeleton label={`Loading ${label} songs`} />
                  </Shelf>
                );
              }
              if (items.length === 0 && failedLangs.has(id)) {
                return (
                  <Shelf key={id} title={`Trending · ${label}`}>
                    <button onClick={() => { hapticLight(); loadLang(id, true); }}
                      className="w-full h-12 rounded-2xl border border-border/60 bg-card text-xs text-muted-foreground flex items-center justify-center gap-2 active:scale-[0.98]">
                      <WifiOff className="h-3.5 w-3.5" /> Couldn't load {label} songs · Tap to retry
                    </button>
                  </Shelf>
                );
              }
              return (
                <TrackShelf key={id} title={`Trending · ${label}`} items={items} current={current} isPlaying={isPlaying}
                  onPlay={playFrom} onMore={onMore} />
              );
            })}
            <TrackShelf title="Popular on Free Music" subtitle="This week · licensed, plays in the background" items={freeRail}
              current={current} isPlaying={isPlaying} onPlay={playFrom} onMore={onMore} />

            {/* Moods */}
            <Shelf title="Browse by mood">
              <ScrollRow>
                {MOODS.map((m) => (
                  <MoodTile key={m.id} label={m.label} onClick={() => { hapticLight(); setQuery(m.q); }} />
                ))}
              </ScrollRow>
            </Shelf>

            {/* Browse all — genre grid */}
            <Shelf title="Browse all" subtitle="Pop, indie, hip-hop and more">
              <div className="grid grid-cols-2 gap-3">
                {GENRES.map((g, i) => (
                  <GenreTile key={g.id} index={i} label={g.label} gradient={g.gradient} Icon={genreIcon(g.id)}
                    onClick={() => { hapticLight(); setActiveGenre(g); scrollRef.current?.scrollTo({ top: 0 }); }} />
                ))}
              </div>
            </Shelf>

          </>
        )}

        {searching && (
          <>
            {/* Provider filter chips */}
            <div className="flex gap-2 overflow-x-auto -mx-5 px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Music source">
              {([["all", "All Music"], ["local", "My Files"], ["jamendo", "Free Music"], ["soundcloud", "SoundCloud"], ["audius", "Audius"], ["youtube", "YouTube"]] as const).map(([id, label]) => (
                <button key={id}
                  onClick={() => { hapticLight(); setProviderFilter(id); }}
                  aria-pressed={providerFilter === id}
                  className={cn(
                    "shrink-0 h-9 px-4 rounded-full text-[13px] font-semibold active:scale-95 transition-colors",
                    providerFilter === id ? "bg-primary text-primary-foreground" : "bg-foreground/[0.07] text-foreground/80",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {topResult && (
              <TopResult track={topResult} isCurrent={current?.id === topResult.id} isPlaying={isPlaying}
                onPlay={() => playFromSearch(topResult, topPool)} onMore={() => onMore(topResult)} />
            )}

            {showLocal && searchLocal.length > 0 && (
              <ResultList title="My Files" tracks={searchLocal} loading={false} error={null}
                onRetry={() => {}} emptyText="" current={current} isPlaying={isPlaying} onPlay={playFromSearch} onMore={onMore} />
            )}

            {showJamendo && (
              <ResultList title="Free Music" tracks={jamendoResults} loading={jamendoLoading} error={jamendoError}
                onRetry={() => { hapticLight(); setJamendoRetryGen(g => g + 1); }} emptyText="No Free Music results for this search."
                current={current} isPlaying={isPlaying} onPlay={playFromSearch} onMore={onMore} />
            )}

            {showSoundCloud && (
              <ResultList title="SoundCloud" tracks={soundcloudResults} loading={soundcloudLoading} error={soundcloudError}
                onRetry={() => { hapticLight(); setSoundcloudRetryGen(g => g + 1); }} emptyText="No SoundCloud results for this search."
                current={current} isPlaying={isPlaying} onPlay={playFromSearch} onMore={onMore} />
            )}

            {showYouTube && (
              error && results.length === 0 && !loading ? (
                <div role="alert" className="flex flex-col items-center justify-center py-10 text-center">
                  <div className="h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
                    <WifiOff className="h-5 w-5 text-destructive" />
                  </div>
                  <p className="text-sm font-medium">Couldn't reach YouTube search</p>
                  <p className="text-xs text-muted-foreground mt-1 max-w-[280px] whitespace-pre-line">{error}</p>
                  <Button size="sm" variant="outline" className="mt-4 rounded-full" onClick={() => search(lastQuery || query)}>Try again</Button>
                </div>
              ) : (
                <ResultList title="YouTube" tracks={ytTracks} loading={loading} error={null}
                  onRetry={() => search(lastQuery || query)} emptyText="No YouTube results. Try a different search or pick a mood."
                  current={current} isPlaying={isPlaying} onPlay={playFromSearch} onMore={onMore} />
              )
            )}

            {showAudius && (
              <ResultList title="Audius" tracks={audiusResults} loading={audiusLoading} error={audiusError}
                onRetry={() => { hapticLight(); setAudiusRetryGen(g => g + 1); }} emptyText="No Audius results for this search."
                current={current} isPlaying={isPlaying} onPlay={playFromSearch} onMore={onMore} />
            )}
          </>
        )}
      </div>

      <TrackActionsSheet
        track={actionTrack}
        liked={actionLiked}
        onClose={() => setActionTrack(null)}
        onPlay={playSolo}
        onPlayNext={queueNext}
        onAddToQueue={queueAdd}
        onToggleLike={likeToggle}
        onAddToPlaylist={addTrackToPlaylist}
        onAddToMyPlaylist={(t) => setPickTrack(t)}
        onMoreByArtist={moreByArtist}
      />

      {/* Add to my playlist — picker */}
      <Drawer open={!!pickTrack} onOpenChange={(v) => { if (!v) setPickTrack(null); }}>
        <DrawerContent className="rounded-t-3xl pb-4">
          <div className="px-5 pt-4 pb-2">
            <DrawerTitle className="text-[16px] font-bold text-left">Add to playlist</DrawerTitle>
            <DrawerDescription className="text-[12px] text-left truncate">{pickTrack?.title}</DrawerDescription>
          </div>
          <div className="max-h-[50vh] overflow-y-auto py-1">
            <button onClick={() => { hapticLight(); const seed = pickTrack; setPickTrack(null); setNameSheet({ mode: "new", seed, value: "" }); }}
              className="w-full px-5 h-12 flex items-center gap-3 text-left text-primary font-semibold text-sm active:bg-foreground/5"><Plus className="h-5 w-5" /> New playlist</button>
            {myPlaylists.map((p) => (
              <button key={p.id} onClick={() => pickPlaylist(p.id, p.name)}
                className="w-full px-5 h-12 flex items-center gap-3 text-left text-sm active:bg-foreground/5">
                <Library className="h-5 w-5 text-muted-foreground shrink-0" />
                <span className="flex-1 min-w-0 truncate">{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.tracks.length}</span>
              </button>
            ))}
          </div>
        </DrawerContent>
      </Drawer>

      {/* New / rename playlist */}
      <Drawer open={!!nameSheet} onOpenChange={(v) => { if (!v) setNameSheet(null); }}>
        <DrawerContent className="rounded-t-3xl pb-5">
          <div className="px-5 pt-4 pb-3">
            <DrawerTitle className="text-[16px] font-bold text-left">{nameSheet?.mode === "rename" ? "Rename playlist" : "New playlist"}</DrawerTitle>
            <DrawerDescription className="sr-only">Enter a playlist name</DrawerDescription>
          </div>
          <div className="px-5 flex gap-2">
            <Input autoFocus value={nameSheet?.value ?? ""} maxLength={PLAYLIST_NAME_MAX} placeholder="Playlist name" aria-label="Playlist name"
              onChange={(e) => setNameSheet((n) => (n ? { ...n, value: e.target.value } : n))}
              onKeyDown={(e) => e.key === "Enter" && saveName()}
              className="h-12 rounded-full bg-foreground/[0.07] border-transparent px-4" />
            <Button onClick={saveName} className="h-12 rounded-full px-5">Save</Button>
          </div>
        </DrawerContent>
      </Drawer>

      <AlertDialog open={!!confirmDeletePl} onOpenChange={(v) => !v && setConfirmDeletePl(null)}>
        <AlertDialogContent className="rounded-2xl max-w-xs">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Delete this playlist?</AlertDialogTitle>
            <AlertDialogDescription>The songs themselves stay in your library.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (confirmDeletePl) deletePlaylist(confirmDeletePl); setConfirmDeletePl(null); }}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove-from-playlist confirmation — same destructive-confirm
          pattern used throughout this app (e.g. Vanish Mode's "Clear
          chat?", Playlist.tsx's own remove dialog). Either partner can
          remove either partner's addition (matches the couple-scoped
          DELETE RLS policy) — this removes it for both, not just you. */}
      <AlertDialog open={!!confirmRemovePlaylistSong} onOpenChange={(v) => !v && setConfirmRemovePlaylistSong(null)}>
        <AlertDialogContent className="rounded-2xl max-w-xs">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Remove "{confirmRemovePlaylistSong?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>This removes it from your shared playlist for both of you.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                hapticWarning();
                if (!confirmRemovePlaylistSong) return;
                const { error: removeError } = await ourPlaylist.removeSong(confirmRemovePlaylistSong.id);
                if (removeError) toast({ title: "Couldn't remove song", description: removeError, variant: "destructive" });
                setConfirmRemovePlaylistSong(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add-by-link dialog — for a song search/Audius can't surface
          (Spotify/SoundCloud/Apple Music, or any other URL). Mirrors
          Playlist.tsx's own add dialog so it feels familiar to anyone
          who's used that page, without pulling in its separate player. */}
      <Dialog open={showAddPlaylistLink} onOpenChange={setShowAddPlaylistLink}>
        <DialogContent className="rounded-2xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListMusic className="h-5 w-5" /> Add to Our Playlist
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Song Link *</label>
              <Input
                value={newPlaylistLink.url}
                onChange={(e) => setNewPlaylistLink({ ...newPlaylistLink, url: e.target.value })}
                placeholder="Paste YouTube, Spotify, or any URL"
                className="rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Song Title</label>
              <Input
                value={newPlaylistLink.title}
                onChange={(e) => setNewPlaylistLink({ ...newPlaylistLink, title: e.target.value })}
                placeholder="e.g. Perfect"
                className="rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Artist</label>
              <Input
                value={newPlaylistLink.artist}
                onChange={(e) => setNewPlaylistLink({ ...newPlaylistLink, artist: e.target.value })}
                placeholder="e.g. Ed Sheeran"
                className="rounded-xl"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={addPastedLinkToPlaylist}
              disabled={!newPlaylistLink.url.trim()}
              className="rounded-xl bg-primary text-primary-foreground w-full"
            >
              Add Song
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default Groic;
