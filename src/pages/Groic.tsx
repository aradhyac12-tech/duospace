import { useEffect, useState, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import { Search, Loader2, Plus, Play, Sparkles, Users, ChevronLeft, WifiOff } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useGroic, GroicTrack } from "@/contexts/GroicContext";
import { useAuth } from "@/hooks/useAuth";
import { invokeEdgeFunction, EdgeFunctionError } from "@/lib/edgeFunction";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Shimmer } from "@/components/skeletons/Shimmer";
import { useErrorManager } from "@/lib/errors/useErrorManager";

interface SearchResult {
  title: string; artist: string; videoId: string;
  thumbnail: string; duration: number; url: string;
}

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


// Rotating discovery queries so the default "Trending" section isn't the
// same single hardcoded search every time — picks a different angle based
// on time of day (and a bit of day-to-day variety) instead of one fixed string.
const DISCOVERY_QUERIES = {
  morning:   ["feel good morning playlist", "upbeat coffee music", "acoustic morning vibes", "sunrise indie mix"],
  afternoon: ["trending music this week", "focus instrumental playlist", "chill afternoon mix", "top charts today"],
  evening:   ["romantic evening playlist", "trending love songs", "sunset chill mix", "unwind evening acoustic"],
  night:     ["late night vibes playlist", "lofi late night beats", "cozy night in music", "midnight R&B mix"],
};

// FIX ("trending should change daily and according to the user"): this
// used to call Math.random() on every mount — meaning leaving Groic and
// coming back a minute later could show a completely different "Trending"
// pick within the same hour, which doesn't read as "trending" at all, it
// reads as random. And it never used anything about the user, despite the
// app already tracking their recent searches (`recent`, in localStorage).
//
// djb2 string hash — deterministic, not cryptographic, doesn't need to be.
// Just needs to turn "today + this user" into a stable number.
const hashSeed = (s: string): number => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
};

const pickDiscoveryQuery = (userId: string | undefined, recentSearches: string[]): string => {
  const hour = new Date().getHours();
  const bucket =
    hour < 6 ? DISCOVERY_QUERIES.night :
    hour < 12 ? DISCOVERY_QUERIES.morning :
    hour < 18 ? DISCOVERY_QUERIES.afternoon :
    hour < 22 ? DISCOVERY_QUERIES.evening :
    DISCOVERY_QUERIES.night;

  // Seeded by calendar date + user id: stable across every mount/re-visit
  // for the rest of today (so it genuinely reads as "today's trending"),
  // and rotates automatically the moment the date changes — no cron job,
  // no stored state, no extra query needed for that part.
  const dateKey = new Date().toDateString();
  const seed = hashSeed(`${dateKey}:${userId ?? "anon"}`);

  // Personalization: when the user has actually searched for something
  // before, fold a "more like <their most recent search>" angle into
  // today's pool about half the time — so Trending increasingly reflects
  // their own taste rather than staying purely generic forever. Never
  // 100% personalized on purpose: always keep genuine discovery in the mix
  // too, or it just echoes their last search back at them.
  const pool = recentSearches.length > 0 && seed % 2 === 0
    ? [...bucket, `more like ${recentSearches[0]}`, `similar to ${recentSearches[0]}`]
    : bucket;

  return pool[seed % pool.length];
};

const Groic = () => {
  const { playTrack, enqueue, sessionRole, partnerListening, startSession, endSession, current } = useGroic();
  const { user } = useAuth();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { capture } = useErrorManager("Groic & Playlist");

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

  // Default: load a discovery recommendation on first mount — deterministic
  // per user+day (see pickDiscoveryQuery), not re-randomized every visit.
  useEffect(() => {
    search(pickDiscoveryQuery(user?.id, recentRef.current), { remember: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);


  const toTrack = (r: SearchResult): GroicTrack => ({
    id: r.videoId, videoId: r.videoId,
    title: r.title, artist: r.artist,
    thumbnail: r.thumbnail, duration: r.duration,
  });

  const onPlay = (r: SearchResult) => {
    hapticMedium();
    const t = toTrack(r);
    playTrack(t, [t, ...results.filter(x => x.videoId !== r.videoId).map(toTrack)]);
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}
      className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-36"
      style={{ WebkitOverflowScrolling: "touch" as any }}
    >
      <header className="safe-top px-5 pt-4 pb-3 sticky top-0 z-20 bg-background/85 backdrop-blur-xl border-b border-border/40">
        <div className="flex items-center gap-3 mb-3">
          <button onClick={() => { hapticLight(); navigate(-1); }}
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
                onClick={() => { hapticLight(); setQuery(m.q); }}
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
                <button key={r} onClick={() => { hapticLight(); setQuery(r); }}
                  className="shrink-0 h-8 px-3 rounded-full bg-muted text-xs text-muted-foreground active:scale-95">
                  {r}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Results grid */}
        <section>
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
            {query.trim() ? `Results · ${results.length}` : "Trending"}
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
                onClick={() => search(lastQuery || query || pickDiscoveryQuery(user?.id, recentRef.current))}>
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
              <Button size="sm" variant="outline" className="mt-4 rounded-full"
                onClick={() => search(query || pickDiscoveryQuery(user?.id, recentRef.current))}>
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
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </motion.div>
  );
};

export default Groic;
