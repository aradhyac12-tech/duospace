import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { motion } from "framer-motion";
import { Search, Loader2, Plus, Play, Sparkles, Users, ChevronLeft, WifiOff, Download, Trash2, ListMusic, ExternalLink } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useGroic, GroicTrack } from "@/contexts/GroicContext";
import { youtubeResultToTrack, YouTubeSearchResult } from "@/lib/music/youtubeProvider";
import { searchAudius } from "@/lib/music/audiusProvider";
import { listDownloads, removeDownload, isOfflineDownloadSupported, DownloadedTrack } from "@/lib/music/offlineDownloads";
import { songKey, buildUpNextPool } from "@/lib/music/queueQuality";
import { getRecentlyPlayedKeys } from "@/lib/music/playHistory";
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

const RECENT_KEY = "groic-recent";
const SEARCH_DEBOUNCE_MS = 350;

// ─── Language preference + trending rails ───────────────────────────────────
// FIX ("main page should have trending Marathi/Hindi/English/Haryanvi, and
// ask the user which languages they want"): persisted just like RECENT_KEY
// above — no account-level sync yet, matching every other lightweight
// preference this app already keeps client-side only.
const LANG_PREF_KEY = "groic-lang-prefs";
const LANG_OPTIONS: { id: "hindi" | "english" | "marathi" | "haryanvi"; label: string }[] = [
  { id: "hindi",    label: "Hindi"    },
  { id: "english",  label: "English"  },
  { id: "marathi",  label: "Marathi"  },
  { id: "haryanvi", label: "Haryanvi" },
];

type TrendingBuckets = Partial<Record<"hindi" | "english" | "marathi" | "haryanvi", SearchResult[]>>;

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

// Compact horizontal rail of song cards — used for the per-language
// trending rows and the "Because you searched" personalization row.
// Deliberately a plain scroll row (not the 2-column grid the active
// search-results view uses) so several of these can stack vertically on
// the home state without turning it into a wall of squares.
const SongRail = ({
  title, items, currentVideoId, onPlay, onEnqueue, onAddToPlaylist,
}: {
  title: string;
  items: SearchResult[];
  currentVideoId: string | undefined;
  onPlay: (r: SearchResult, pool: SearchResult[]) => void;
  onEnqueue: (r: SearchResult) => void;
  onAddToPlaylist?: (r: SearchResult) => void;
}) => {
  if (items.length === 0) return null;
  return (
    <section>
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">{title}</p>
      <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
        {items.map((r) => {
          const isCurrent = currentVideoId === r.videoId;
          return (
            <div key={r.videoId} className="shrink-0 w-[128px]">
              <div className="relative aspect-square rounded-2xl overflow-hidden bg-muted">
                <img src={r.thumbnail} alt={r.title} className="h-full w-full object-cover" loading="lazy" />
                <button
                  onClick={() => onPlay(r, items)}
                  aria-label={`Play ${r.title}`}
                  className="absolute bottom-1.5 right-1.5 h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg active:scale-90"
                >
                  <Play className="h-3.5 w-3.5 ml-0.5" />
                </button>
                {isCurrent && (
                  <div className="absolute top-1.5 left-1.5 px-1.5 h-4 rounded-full bg-primary/90 text-primary-foreground text-[8px] font-bold flex items-center">
                    NOW
                  </div>
                )}
              </div>
              <div className="mt-1.5 flex items-start justify-between gap-1">
                <div className="min-w-0">
                  <p className="text-xs font-semibold truncate">{r.title}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{r.artist}</p>
                </div>
                <button onClick={() => onEnqueue(r)} className="text-muted-foreground active:scale-90 mt-0.5 shrink-0" aria-label="Add to queue">
                  <Plus className="h-3.5 w-3.5" />
                </button>
                {onAddToPlaylist && (
                  <button onClick={() => onAddToPlaylist(r)} className="text-muted-foreground active:scale-90 mt-0.5 shrink-0" aria-label="Add to Our Playlist">
                    <ListMusic className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

const Groic = () => {
  const { playTrack, enqueue, sessionRole, partnerListening, startSession, endSession, current, queue } = useGroic();
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
  const [recent, setRecent]   = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
  });

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
  const [langPrefs, setLangPrefs] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LANG_PREF_KEY) || "null");
      return Array.isArray(saved) && saved.length > 0 ? saved : ["hindi", "english"];
    } catch { return ["hindi", "english"]; }
  });
  const toggleLangPref = useCallback((id: string) => {
    setLangPrefs(prev => {
      // GUARD: at least one language must stay selected — deselecting the
      // last one used to leave the home state with zero trending rails (the
      // render falls back to showing all four, which silently ignored the
      // user's explicit choice and made the buttons feel like they "did
      // nothing"). Toggling off the final remaining chip is now a no-op.
      const next = prev.includes(id)
        ? (prev.length > 1 ? prev.filter(x => x !== id) : prev)
        : [...prev, id];
      try { localStorage.setItem(LANG_PREF_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);

  // Real per-language trending rails (home state only) — replaces what
  // used to be a single hidden discovery *search* mislabeled "Trending".
  // See music-trending/index.ts for the actual per-language fetching.
  const [trending, setTrending] = useState<TrendingBuckets>({});
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [trendingError, setTrendingError] = useState(false);

  // "Because you searched…" — a real personalization rail driven by the
  // user's own search history (per the direct request to use search
  // behavior to inform the home screen, not just time-of-day discovery
  // buckets). One extra lightweight search for the single most recent
  // distinct query, not the whole history, to keep this cheap.
  const [historyRail, setHistoryRail] = useState<{ term: string; results: SearchResult[] } | null>(null);

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
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* private mode */ }
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

  // Real per-language trending rails on first mount — replaces the old
  // "hidden discovery search mislabeled Trending" behavior. Fetched once;
  // rails are filtered/ordered by langPrefs at render time, not re-fetched
  // per toggle, since all four buckets come back in one call anyway.
  useEffect(() => {
    let cancelled = false;
    setTrendingLoading(true);
    setTrendingError(false);
    invokeEdgeFunction<{ hindi?: SearchResult[]; english?: SearchResult[]; marathi?: SearchResult[]; haryanvi?: SearchResult[]; error?: string }>(
      "music-trending", { body: {} },
    ).then((data) => {
      if (cancelled) return;
      setTrending({
        hindi: data?.hindi ?? [], english: data?.english ?? [],
        marathi: data?.marathi ?? [], haryanvi: data?.haryanvi ?? [],
      });
    }).catch((err) => {
      if (cancelled) return;
      setTrendingError(true);
      capture("DS-GROIC-002", { component: "Groic", action: "trending", cause: err });
    }).finally(() => { if (!cancelled) setTrendingLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const toTrack = (r: SearchResult): GroicTrack => youtubeResultToTrack(r);

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
    } else {
      window.open(song.song_url, "_blank", "noopener,noreferrer");
    }
  };

  const onPlay = (r: SearchResult, pool: SearchResult[] = results) => {
    hapticMedium();
    const t = toTrack(r);
    // See the QUEUE_NOISE_RE / buildUpNextPool comment near the top of
    // this file for why this is deduped-by-song and shuffled instead of
    // "the rest of whatever list this came from, in order" — and now also
    // excludes recently-played songs (playHistory.ts) so the same song
    // doesn't get suggested again right after it was already played.
    const rest = buildUpNextPool(pool, r, (x) => x.videoId, Math.random, getRecentlyPlayedKeys());
    playTrack(t, [t, ...rest.map(toTrack)]);
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
  const [providerFilter, setProviderFilter] = useState<"all" | "youtube" | "audius">("all");
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
    if (!q || providerFilter === "youtube") {
      setAudiusResults([]);
      setAudiusError(null);
      return;
    }
    let cancelled = false;
    setAudiusLoading(true);
    setAudiusError(null);
    const t = window.setTimeout(() => {
      searchAudius(q)
        .then((tracks) => { if (!cancelled) setAudiusResults(tracks); })
        .catch((err) => {
          if (cancelled) return;
          setAudiusResults([]);
          setAudiusError(err instanceof Error && err.message ? err.message : "Audius is unreachable right now.");
        })
        .finally(() => { if (!cancelled) setAudiusLoading(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { cancelled = true; window.clearTimeout(t); };
  }, [query, providerFilter, audiusRetryGen]);

  const onPlayAudius = (t: GroicTrack, pool: GroicTrack[] = audiusResults) => {
    hapticMedium();
    const rest = buildUpNextPool(pool, t, (x) => x.id, Math.random, getRecentlyPlayedKeys());
    playTrack(t, [t, ...rest]);
  };

  // FIX ("the fixed songs on home should not also be there [in] trending"):
  // the home state stacks several song rails (what's already playing/
  // queued, "Because you searched…", then one Trending rail per selected
  // language) and nothing previously stopped the same song appearing more
  // than once across them — e.g. a song already sitting in the current
  // up-next queue could also show up in a Trending rail right below it.
  // Builds one running "already shown on this page" key set and filters
  // each rail against it in priority order (now playing/queued first,
  // since that's the most "fixed"/committed set for this session, then
  // the personalized history rail, then each language's trending rail) —
  // every rail still renders, just without repeating a song a rail above
  // it already showed.
  const dedupedHome = useMemo(() => {
    const used = new Set<string>();
    if (current) used.add(songKey(current.title));
    for (const t of queue) used.add(songKey(t.title));

    const dedupeAgainst = (items: SearchResult[]): SearchResult[] => {
      const kept: SearchResult[] = [];
      for (const item of items) {
        const key = songKey(item.title);
        if (used.has(key)) continue;
        used.add(key);
        kept.push(item);
      }
      return kept;
    };

    const history = historyRail ? { ...historyRail, results: dedupeAgainst(historyRail.results) } : null;
    const order = langPrefs.length > 0 ? langPrefs : LANG_OPTIONS.map(l => l.id);
    const trendingByLang: TrendingBuckets = {};
    for (const id of order) {
      trendingByLang[id as keyof TrendingBuckets] = dedupeAgainst(trending[id as keyof TrendingBuckets] ?? []);
    }
    return { history, trendingByLang, order };
  }, [current, queue, historyRail, trending, langPrefs]);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-36"
      style={{ WebkitOverflowScrolling: "touch" as any }}
    >
      <header className="safe-top px-5 pt-4 pb-3 sticky top-0 z-20 bg-background/85 backdrop-blur-xl border-b border-border/40">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={() => { navigate(-1); }}
            className="h-10 w-10 rounded-full bg-accent/15 flex items-center justify-center active:scale-95" aria-label="Back">
            <ChevronLeft className="h-5 w-5 text-accent" />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold tracking-tight flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" /> Groic
            </h1>
            <p className="text-[10px] text-muted-foreground -mt-0.5">Listen together · low-latency sync</p>
          </div>
          <button
            onClick={async () => {
              if (sessionRole === "solo") { await startSession(); toast({ title: "Session started 🎶" }); }
              else { await endSession(); toast({ title: "Session ended" }); }
            }}
            className={cn(
              "h-8 px-3 rounded-full text-[11px] font-medium flex items-center gap-1 active:scale-95",
              sessionRole !== "solo" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground",
            )}
          >
            <Users className="h-3 w-3" /> {sessionRole === "solo" ? "Together" : partnerListening ? "Connected" : sessionRole}
            {sessionRole !== "solo" && partnerListening && (
              <span className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" />
            )}
          </button>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && search(query)}
            placeholder="Search songs, artists, vibes…"
            className="h-9 pl-8 pr-20 rounded-full bg-muted/60 border-transparent text-sm"
            aria-label="Search music"
          />
          <Button
            onClick={() => search(query)}
            disabled={loading}
            size="sm"
            className="absolute right-1 top-1/2 -translate-y-1/2 h-7 px-3 rounded-full text-[11px]"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : "Go"}
          </Button>
        </div>
      </header>

      <div className="px-5 pt-4 space-y-6">
        {/* Moods */}
        <section>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Moods</p>
          <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
            {MOODS.map(m => (
              <button key={m.id}
                onClick={() => { setQuery(m.q); }}
                className="shrink-0 h-8 px-3 rounded-full bg-card border border-border/60 text-xs active:scale-95"
              >
                {m.label}
              </button>
            ))}
          </div>
        </section>

        {/* Recent */}
        {recent.length > 0 && (
          <section>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Recent</p>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {recent.map(r => (
                <button key={r} onClick={() => { setQuery(r); }}
                  className="shrink-0 h-8 px-3 rounded-full bg-muted text-xs text-muted-foreground active:scale-95">
                  {r}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Downloads — only ever populated on native platforms (see
            isOfflineDownloadSupported), and only shown when there's
            actually something in it; an empty section here would just be
            dead space for the common case of someone who's never
            downloaded anything yet. */}
        {isOfflineDownloadSupported() && downloads.length > 0 && !query.trim() && (
          <section>
            <div className="flex items-center gap-1.5 mb-2">
              <Download className="h-3 w-3 text-muted-foreground" />
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Downloads</p>
            </div>
            <div className="space-y-1.5">
              {downloads.map((d) => (
                <div key={d.id} className="flex items-center gap-3 p-1.5 rounded-xl active:bg-foreground/5">
                  <button onClick={() => playDownload(d)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                    <div className="relative h-10 w-10 rounded-lg overflow-hidden bg-muted shrink-0">
                      {d.thumbnail && <img src={d.thumbnail} alt="" className="h-full w-full object-cover" />}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm truncate">{d.title}</p>
                      <p className="text-xs text-muted-foreground truncate">{d.artist}</p>
                    </div>
                  </button>
                  <button
                    onClick={() => removeDownloadedTrack(d)}
                    aria-label={`Remove downloaded ${d.title}`}
                    className="text-muted-foreground active:scale-90 p-1.5 shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Our Playlist — the shared couple playlist, with attribution on
            every row (see useOurPlaylist.ts for the "why wasn't this here
            already" history). Home state only, same reasoning as
            Downloads/language picker below: irrelevant clutter above
            actual search results once you're searching for something. */}
        {!query.trim() && (
          <section>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1.5">
                <ListMusic className="h-3 w-3 text-muted-foreground" />
                <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Our Playlist</p>
              </div>
              <button
                onClick={() => setShowAddPlaylistLink(true)}
                aria-label="Add a song by link"
                className="h-6 w-6 rounded-full bg-accent/15 flex items-center justify-center active:scale-90"
              >
                <Plus className="h-3.5 w-3.5 text-accent" />
              </button>
            </div>
            {ourPlaylist.loading ? (
              <div className="space-y-1.5" aria-busy="true" aria-label="Loading playlist">
                {Array.from({ length: 2 }).map((_, i) => <Shimmer key={i} className="h-14 rounded-xl" />)}
              </div>
            ) : ourPlaylist.error ? (
              <p className="text-xs text-muted-foreground py-2">Couldn't load your playlist right now.</p>
            ) : ourPlaylist.songs.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2">
                Nothing here yet — add a song from search or paste a link with the + above.
              </p>
            ) : (
              <div className="space-y-1.5">
                {ourPlaylist.songs.map((song) => {
                  const isCurrent = current && (
                    (song.platform === "youtube" && current.videoId === song.song_url.match(YOUTUBE_URL_ID_RE)?.[1]) ||
                    (song.platform === "audius" && current.provider === "audius" && current.providerTrackId === (song.song_url.startsWith("audius:") ? song.song_url.slice(7) : song.song_url))
                  );
                  const playable = song.platform === "youtube" || song.platform === "audius";
                  return (
                    <div key={song.id} className={cn(
                      "flex items-center gap-3 p-2 rounded-xl border",
                      isCurrent ? "bg-primary/5 border-primary/20" : "bg-card border-border/60",
                    )}>
                      <button onClick={() => playOurPlaylistSong(song)} className="flex items-center gap-3 flex-1 min-w-0 text-left" aria-label={playable ? `Play ${song.title}` : `Open ${song.title}`}>
                        <div className="relative h-10 w-10 rounded-lg overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                          {song.thumbnail_url ? (
                            <img src={song.thumbnail_url} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <ListMusic className="h-4 w-4 text-muted-foreground" />
                          )}
                          {!playable && <ExternalLink className="h-3 w-3 absolute bottom-0.5 right-0.5 text-foreground/70" />}
                        </div>
                        <div className="min-w-0">
                          <p className={cn("text-sm font-medium truncate", isCurrent && "text-primary")}>{song.title}</p>
                          <p className="text-[11px] text-muted-foreground truncate">{song.artist}</p>
                          <p className="text-[10px] text-muted-foreground/80 truncate">Added by {ourPlaylist.attributionFor(song.added_by)}</p>
                        </div>
                      </button>
                      <button
                        onClick={() => { hapticWarning(); setConfirmRemovePlaylistSong(song); }}
                        aria-label={`Remove ${song.title} from Our Playlist`}
                        className="h-9 w-9 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors shrink-0"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* FIX (direct request: "ask the user for their language support"):
            a simple persisted multi-select — not an onboarding modal, since
            this is squarely a Groic-specific preference, not an account-
            wide one, and should be trivial to change your mind about later
            without digging through Settings. Only shown on the home state;
            once you're actively searching it'd just be dead space above
            search results you already asked for directly. */}
        {!query.trim() && (
          <section>
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Your languages</p>
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {LANG_OPTIONS.map(l => {
                const active = langPrefs.includes(l.id);
                return (
                  <button key={l.id}
                    onClick={() => { hapticLight(); toggleLangPref(l.id); }}
                    aria-pressed={active}
                    className={cn(
                      "shrink-0 h-8 px-3 rounded-full text-xs active:scale-95 border",
                      active ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border/60 text-muted-foreground",
                    )}
                  >
                    {l.label}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Provider filter — "All Music" is the sensible default; YouTube/
            Audius narrow to one source. Only shown while actively
            searching — irrelevant noise on the home state. */}
        {query.trim() && (
          <div className="flex gap-2">
            {([["all", "All Music"], ["youtube", "YouTube"], ["audius", "Audius"]] as const).map(([id, label]) => (
              <button key={id}
                onClick={() => { hapticLight(); setProviderFilter(id); }}
                aria-pressed={providerFilter === id}
                className={cn(
                  "h-7 px-3 rounded-full text-[11px] font-medium active:scale-95 border",
                  providerFilter === id ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border/60 text-muted-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Results grid — active search — unchanged from before */}
        {query.trim() ? (
        <>
        {providerFilter !== "audius" && (
        <section>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
            Results · {results.length}
          </p>
          {loading && results.length === 0 ? (
            <div className="grid grid-cols-2 gap-3" aria-busy="true" aria-label="Loading songs">
              {Array.from({ length: 6 }).map((_, i) => (
                <Shimmer key={i} className="aspect-square rounded-2xl" />
              ))}
            </div>
          ) : error ? (
            <div role="alert" className="flex flex-col items-center justify-center py-12 text-center">
              <div className="h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
                <WifiOff className="h-5 w-5 text-destructive" />
              </div>
              <p className="text-sm font-medium">Couldn't reach music search</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[280px] whitespace-pre-line">{error}</p>
              <Button size="sm" variant="outline" className="mt-4 rounded-full"
                onClick={() => search(lastQuery || query)}>
                Try again
              </Button>
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="h-14 w-14 rounded-full bg-muted/60 flex items-center justify-center mb-3">
                <Search className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No results found</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[260px]">
                Try a different search or pick a mood above.
              </p>
              <Button size="sm" variant="outline" className="mt-4 rounded-full" onClick={() => search(query)}>
                Try again
              </Button>
            </div>
          ) : (

            <div className="grid grid-cols-2 gap-3">
              {results.map((r, i) => {
                const isCurrent = current?.videoId === r.videoId;
                return (
                  <motion.div
                    key={r.videoId + i}
                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.02, 0.2) }}
                    className="rounded-2xl overflow-hidden bg-card border border-border/60 active:scale-[0.98] transition-transform"
                  >
                    <div className="relative aspect-square bg-muted">
                      <img src={r.thumbnail} alt={r.title} className="h-full w-full object-cover" loading="lazy" />
                      <button
                        onClick={() => onPlay(r)}
                        aria-label={`Play ${r.title}`}
                        className="absolute bottom-2 right-2 h-9 w-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg active:scale-90"
                      >
                        <Play className="h-4 w-4 ml-0.5" />
                      </button>
                      {isCurrent && (
                        <div className="absolute top-2 left-2 px-2 h-5 rounded-full bg-primary/90 text-primary-foreground text-[9px] font-bold flex items-center">
                          NOW
                        </div>
                      )}
                    </div>
                    <div className="p-2.5">
                      <p className="text-xs font-semibold truncate">{r.title}</p>
                      <div className="flex items-center justify-between mt-0.5">
                        <p className="text-[10px] text-muted-foreground truncate flex-1">{r.artist}</p>
                        <button onClick={() => { hapticLight(); enqueue(toTrack(r)); toast({ title: "Added to queue" }); }}
                          className="text-muted-foreground active:scale-90 ml-1" aria-label="Add to queue">
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => addYouTubeToPlaylist(r)}
                          className="text-muted-foreground active:scale-90 ml-1" aria-label="Add to Our Playlist">
                          <ListMusic className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </section>
        )}

        {/* Audius results — real native-streamable tracks, normalized into
            the same GroicTrack card format the trending/history rails
            already use (SongRail), rather than a separate visual
            treatment. Selecting one plays it natively (see onPlayAudius);
            selecting a YouTube result above uses the existing permitted
            YouTube player behavior — never pretending a YouTube track is
            a native background track. */}
        {providerFilter !== "youtube" && (
        <section>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
            Audius · {audiusResults.length}
          </p>
          {audiusLoading && audiusResults.length === 0 ? (
            <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1" aria-busy="true" aria-label="Loading Audius songs">
              {Array.from({ length: 4 }).map((_, i) => (
                <Shimmer key={i} className="shrink-0 w-[128px] aspect-square rounded-2xl" />
              ))}
            </div>
          ) : audiusError ? (
            <div className="flex items-center gap-2 py-2">
              <p className="text-xs text-warning flex-1 min-w-0 truncate">{audiusError}</p>
              <button
                onClick={() => { hapticLight(); setAudiusRetryGen(g => g + 1); }}
                aria-label="Retry Audius search"
                className="shrink-0 h-8 px-3 rounded-full bg-card border border-border/60 text-[11px] font-medium text-foreground/80 active:scale-95 transition-transform"
              >
                Retry
              </button>
            </div>
          ) : audiusResults.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              {audiusLoading ? "" : "No Audius results for this search."}
            </p>
          ) : (
            <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1">
              {audiusResults.map((t) => {
                const isCurrent = current?.id === t.id;
                return (
                  <div key={t.id} className="shrink-0 w-[128px]">
                    <div className="relative aspect-square rounded-2xl overflow-hidden bg-muted">
                      {t.thumbnail && <img src={t.thumbnail} alt={t.title} className="h-full w-full object-cover" loading="lazy" />}
                      <button
                        onClick={() => onPlayAudius(t)}
                        aria-label={`Play ${t.title}`}
                        className="absolute bottom-1.5 right-1.5 h-8 w-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg active:scale-90"
                      >
                        <Play className="h-3.5 w-3.5 ml-0.5" />
                      </button>
                      {isCurrent && (
                        <div className="absolute top-1.5 left-1.5 px-1.5 h-4 rounded-full bg-primary/90 text-primary-foreground text-[8px] font-bold flex items-center">
                          NOW
                        </div>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-start justify-between gap-1">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold truncate">{t.title}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{t.artist}</p>
                      </div>
                      <button onClick={() => { hapticLight(); enqueue(t); toast({ title: "Added to queue" }); }}
                        className="text-muted-foreground active:scale-90 mt-0.5 shrink-0" aria-label="Add to queue">
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => addAudiusToPlaylist(t)}
                        className="text-muted-foreground active:scale-90 mt-0.5 shrink-0" aria-label="Add to Our Playlist">
                        <ListMusic className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        )}
        </>
        ) : (
        /* Home state — real per-language trending rails + search-history
           personalization, replacing the old single hidden-discovery-search
           section that used to masquerade as "Trending". */
        <>
          {trendingLoading ? (
            <section>
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">Trending</p>
              <div className="flex gap-3 overflow-x-auto pb-1 -mx-1 px-1" aria-busy="true" aria-label="Loading trending songs">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Shimmer key={i} className="shrink-0 w-[128px] aspect-square rounded-2xl" />
                ))}
              </div>
            </section>
          ) : trendingError ? (
            <div role="alert" className="flex flex-col items-center justify-center py-10 text-center">
              <div className="h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center mb-3">
                <WifiOff className="h-5 w-5 text-destructive" />
              </div>
              <p className="text-sm font-medium">Couldn't load trending songs</p>
              <Button size="sm" variant="outline" className="mt-4 rounded-full"
                onClick={() => { setTrendingLoading(true); setTrendingError(false);
                  invokeEdgeFunction<{ hindi?: SearchResult[]; english?: SearchResult[]; marathi?: SearchResult[]; haryanvi?: SearchResult[] }>("music-trending", { body: {} })
                    .then(data => setTrending({ hindi: data?.hindi ?? [], english: data?.english ?? [], marathi: data?.marathi ?? [], haryanvi: data?.haryanvi ?? [] }))
                    .catch(() => setTrendingError(true))
                    .finally(() => setTrendingLoading(false));
                }}>
                Try again
              </Button>
            </div>
          ) : (
            <>
              {dedupedHome.history && dedupedHome.history.results.length > 0 && (
                <SongRail
                  title={`Because you searched "${dedupedHome.history.term}"`}
                  items={dedupedHome.history.results.slice(0, 10)}
                  currentVideoId={current?.videoId}
                  onPlay={onPlay}
                  onEnqueue={(r) => { hapticLight(); enqueue(toTrack(r)); toast({ title: "Added to queue" }); }}
                  onAddToPlaylist={addYouTubeToPlaylist}
                />
              )}
              {dedupedHome.order.map((id) => (
                <SongRail
                  key={id}
                  title={`Trending · ${LANG_OPTIONS.find(l => l.id === id)?.label ?? id}`}
                  items={(dedupedHome.trendingByLang[id as keyof TrendingBuckets] ?? []).slice(0, 10)}
                  currentVideoId={current?.videoId}
                  onPlay={onPlay}
                  onEnqueue={(r) => { hapticLight(); enqueue(toTrack(r)); toast({ title: "Added to queue" }); }}
                  onAddToPlaylist={addYouTubeToPlaylist}
                />
              ))}
            </>
          )}
        </>
        )}
      </div>

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
