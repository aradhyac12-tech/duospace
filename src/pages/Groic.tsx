import { useEffect, useState, useCallback } from "react";
import { motion } from "framer-motion";
import { Search, Loader2, Plus, Play, Sparkles, Users, ChevronLeft } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useGroic, GroicTrack } from "@/contexts/GroicContext";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticMedium } from "@/lib/haptics";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

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

const Groic = () => {
  const { playTrack, enqueue, sessionRole, partnerListening, startSession, endSession, current } = useGroic();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [query, setQuery]     = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [recent, setRecent]   = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
  });

  const search = useCallback(async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("music-search", { body: { query: q.trim() } });
      if (error) throw error;
      setResults(data?.results || []);
      const r = [q.trim(), ...recent.filter(x => x !== q.trim())].slice(0, 8);
      setRecent(r);
      localStorage.setItem(RECENT_KEY, JSON.stringify(r));
    } catch (err) {
      toast({ title: "Search failed", description: (err as Error).message, variant: "destructive" });
    }
    setLoading(false);
  }, [recent, toast]);

  // Default: load a trending recommendation on first mount
  useEffect(() => {
    if (results.length === 0) search("trending music 2026");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            className="h-8 w-8 rounded-full bg-accent/60 flex items-center justify-center active:scale-95" aria-label="Back">
            <ChevronLeft className="h-4 w-4" />
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
                onClick={() => { hapticLight(); setQuery(m.label); search(m.q); }}
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
                <button key={r} onClick={() => { setQuery(r); search(r); }}
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
            {query ? `Results · ${results.length}` : "Trending"}
          </p>
          {loading && results.length === 0 ? (
            <div className="grid grid-cols-2 gap-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="aspect-square rounded-2xl bg-muted/60 animate-pulse" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <div className="h-14 w-14 rounded-full bg-muted/60 flex items-center justify-center mb-3">
                <Search className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">No results found</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-[260px]">
                Try a different search, a mood above, or check your connection.
              </p>
              <Button size="sm" variant="outline" className="mt-4 rounded-full"
                onClick={() => search(query || "trending music 2026")}>
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
                        className="absolute bottom-2 right-2 h-9 w-9 rounded-full bg-foreground text-background flex items-center justify-center shadow-lg active:scale-90"
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
