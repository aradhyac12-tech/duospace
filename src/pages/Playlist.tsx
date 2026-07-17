import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Trash2, Music, Play, Pause, SkipBack, SkipForward, Search,
  Shuffle, Repeat, Repeat1, Users, ExternalLink, X, Check, Loader2,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticMedium, hapticNotification } from "@/lib/haptics";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";

interface Song {
  id: string;
  title: string;
  artist: string;
  song_url: string;
  platform: string;
  thumbnail_url: string | null;
  added_by: string;
  created_at: string;
}

interface SearchResult {
  title: string;
  artist: string;
  videoId: string;
  thumbnail: string;
  duration: number;
  url: string;
}

type RepeatMode = "off" | "all" | "one";

const detectPlatform = (url: string): string => {
  if (url.includes("spotify")) return "spotify";
  if (url.includes("youtube") || url.includes("youtu.be")) return "youtube";
  if (url.includes("soundcloud")) return "soundcloud";
  if (url.includes("apple")) return "apple-music";
  return "other";
};

const getYouTubeId = (url: string): string | null => {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
};

const getSpotifyId = (url: string): { type: string; id: string } | null => {
  const match = url.match(/spotify\.com\/(track|album|playlist)\/([a-zA-Z0-9]+)/);
  return match ? { type: match[1], id: match[2] } : null;
};

const formatDuration = (seconds: number): string => {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const Playlist = () => {
  const { user } = useAuth();
  const { toast } = useToast();

  // Song list
  const [songs, setSongs] = useState<Song[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});

  // Playback state
  const [queue, setQueue] = useState<Song[]>([]);
  const [currentIndex, setCurrentIndex] = useState<number>(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffleOn, setShuffleOn] = useState(false);
  const [repeatMode, setRepeatMode] = useState<RepeatMode>("off");

  // Search
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSearch, setShowSearch] = useState(false);

  // Add song dialog
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newSong, setNewSong] = useState({ title: "", artist: "", url: "" });

  // Blend
  const [blendActive, setBlendActive] = useState(false);
  const [blendPending, setBlendPending] = useState<any>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);

  const blendChannelRef = useRef<any>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const currentSong = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;

  // Load songs and profiles
  useEffect(() => {
    if (!user) return;
    const load = async () => {
      const { data } = await supabase
        .from("playlist_songs")
        .select("id,added_by,title,artist,song_url,platform,thumbnail_url,created_at")
        .order("created_at", { ascending: false });
      if (data) {
        const s = data as Song[];
        setSongs(s);
        setQueue(s);
      }

      let myPartnerId: string | null = null;
      const { data: p } = await supabase.from("profiles").select("user_id, display_name, pet_name, partner_id");
      if (p) {
        const map: Record<string, string> = {};
        (p as any[]).forEach((prof) => {
          map[prof.user_id] = prof.pet_name || prof.display_name;
          if (prof.user_id === user.id && prof.partner_id) {
            setPartnerId(prof.partner_id);
            myPartnerId = prof.partner_id;
          }
        });
        setProfiles(map);
      }

      // B12 Fix: Only check blend status when user has a partner
      if (myPartnerId) {
        const { data: blends } = await supabase
          .from("blend_invites")
          .select("id,added_by,title,artist,song_url,platform,thumbnail_url,created_at")
          .in("status", ["pending", "accepted"]) as any;
        if (blends && blends.length > 0) {
          const activeBlend = blends.find((b: { status: string }) => b.status === "accepted");
          if (activeBlend) setBlendActive(true);
          const pendingBlend = blends.find(
            (b: { status: string; sender_id: string }) => b.status === "pending" && b.sender_id !== user.id
          );
          if (pendingBlend) setBlendPending(pendingBlend);
        }
      }
    };
    load();
  }, [user]);

  // Realtime blend sync channel
  useEffect(() => {
    if (!user || !blendActive) return;

    const channel = supabase
      .channel("blend-sync")
      .on("broadcast", { event: "playback" }, (payload: { payload: Record<string, unknown> }) => {
        const data = payload.payload;
        if (data.userId === user.id) return; // Ignore own broadcasts

        if (data.action === "play") {
          const idx = queue.findIndex((s) => s.id === data.songId);
          if (idx >= 0) {
            setCurrentIndex(idx);
            setIsPlaying(true);
          }
        } else if (data.action === "pause") {
          setIsPlaying(false);
        } else if (data.action === "skip") {
          const idx = queue.findIndex((s) => s.id === data.songId);
          if (idx >= 0) setCurrentIndex(idx);
        }
      })
      .subscribe();

    blendChannelRef.current = channel;
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, blendActive, queue]);

  // Realtime for blend invite notifications
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel("blend-invites-rt")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "blend_invites" },
        (payload) => {
          const invite = payload.new as any;
          if (invite.sender_id !== user.id && invite.status === "pending") {
            hapticNotification("success");
            setBlendPending(invite);
            toast({ title: "🎵 Blend Invite!", description: "Your partner wants to listen together" });
          }
        }
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "blend_invites" },
        (payload) => {
          const invite = payload.new as any;
          if (invite.status === "accepted") {
            setBlendActive(true);
            setBlendPending(null);
            hapticNotification("success");
            toast({ title: "🎶 Blend Active!", description: "You're now listening together" });
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user]);

  const broadcastPlayback = useCallback(
    (action: string, songId?: string) => {
      if (!blendActive || !blendChannelRef.current) return;
      blendChannelRef.current.send({
        type: "broadcast",
        event: "playback",
        payload: { action, songId, userId: user?.id },
      });
    },
    [blendActive, user]
  );

  // Shuffle queue
  useEffect(() => {
    if (shuffleOn) {
      const shuffled = [...songs].sort(() => Math.random() - 0.5);
      setQueue(shuffled);
      setCurrentIndex(currentSong ? shuffled.findIndex((s) => s.id === currentSong.id) : 0);
    } else {
      setQueue([...songs]);
      if (currentSong) {
        setCurrentIndex(songs.findIndex((s) => s.id === currentSong.id));
      }
    }
  }, [shuffleOn, songs]);




  const playSong = (song: Song) => {
    hapticLight();
    const idx = queue.findIndex((s) => s.id === song.id);
    setCurrentIndex(idx >= 0 ? idx : 0);
    setIsPlaying(true);
    broadcastPlayback("play", song.id);
  };

  const togglePlay = () => {
    hapticLight();
    setIsPlaying(!isPlaying);
    broadcastPlayback(isPlaying ? "pause" : "play", currentSong?.id);
  };

  const playNext = useCallback(() => {
    hapticLight();
    if (repeatMode === "one") {
      // Replay same song (re-trigger by toggling index)
      setCurrentIndex((prev) => prev);
      setIsPlaying(true);
      return;
    }
    let next = currentIndex + 1;
    if (next >= queue.length) {
      if (repeatMode === "all") next = 0;
      else {
        setIsPlaying(false);
        return;
      }
    }
    setCurrentIndex(next);
    setIsPlaying(true);
    broadcastPlayback("skip", queue[next]?.id);
  }, [currentIndex, queue, repeatMode, broadcastPlayback]);

  const playPrev = () => {
    hapticLight();
    let prev = currentIndex - 1;
    if (prev < 0) prev = repeatMode === "all" ? queue.length - 1 : 0;
    setCurrentIndex(prev);
    setIsPlaying(true);
    broadcastPlayback("skip", queue[prev]?.id);
  };

  // Media Session API for notification panel controls
  useEffect(() => {
    if (!currentSong || !("mediaSession" in navigator)) return;

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentSong.title,
      artist: currentSong.artist,
      album: "DuoSpace Playlist",
      artwork: currentSong.thumbnail_url
        ? [{ src: currentSong.thumbnail_url, sizes: "256x256", type: "image/jpeg" }]
        : [],
    });

    navigator.mediaSession.setActionHandler("play", () => { setIsPlaying(true); broadcastPlayback("play", currentSong?.id); });
    navigator.mediaSession.setActionHandler("pause", () => { setIsPlaying(false); broadcastPlayback("pause", currentSong?.id); });
    navigator.mediaSession.setActionHandler("previoustrack", playPrev);
    navigator.mediaSession.setActionHandler("nexttrack", () => playNext());

    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";

    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
    };
  }, [currentSong, isPlaying, broadcastPlayback, playNext, playPrev]);

  const toggleShuffle = () => {
    hapticLight();
    setShuffleOn(!shuffleOn);
  };

  const cycleRepeat = () => {
    hapticLight();
    const modes: RepeatMode[] = ["off", "all", "one"];
    const idx = modes.indexOf(repeatMode);
    setRepeatMode(modes[(idx + 1) % 3]);
  };

  // Search YouTube
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const { data, error } = await supabase.functions.invoke("music-search", {
        body: { query: searchQuery.trim() },
      });
      if (error) throw error;
      setSearchResults(data?.results || []);
    } catch (err: unknown) {
      toast({ title: "Search failed", description: (err instanceof Error ? err.message : String(err)), variant: "destructive" });
    }
    setSearching(false);
  };

  const addFromSearch = async (result: SearchResult) => {
    if (!user) return;
    hapticMedium();

    const { data, error } = await supabase
      .from("playlist_songs")
      .insert({
        added_by: user.id,
        title: result.title,
        artist: result.artist,
        song_url: result.url,
        platform: "youtube",
        thumbnail_url: result.thumbnail,
      })
      .select()
      .single();

    if (error) {
      toast({ title: "Couldn't add song", description: error.message, variant: "destructive" });
    } else if (data) {
      const s = data as Song;
      setSongs((prev) => [s, ...prev]);
      toast({ title: "Added to playlist 🎵" });
      // Auto-play the added song
      setTimeout(() => playSong(s), 100);
    }
  };

  const addSong = async () => {
    if (!user || !newSong.url.trim()) return;
    hapticLight();
    const platform = detectPlatform(newSong.url);
    let title = newSong.title.trim();
    let thumbnail: string | null = null;

    if (platform === "youtube") {
      const ytId = getYouTubeId(newSong.url);
      if (ytId) {
        thumbnail = `https://img.youtube.com/vi/${ytId}/mqdefault.jpg`;
        if (!title) title = "YouTube Track";
      }
    }
    if (!title) title = "Untitled Song";

    const { data, error } = await supabase
      .from("playlist_songs")
      .insert({
        added_by: user.id,
        title,
        artist: newSong.artist.trim() || "Unknown",
        song_url: newSong.url.trim(),
        platform,
        thumbnail_url: thumbnail,
      })
      .select()
      .single();

    if (error) {
      toast({ title: "Couldn't add song", description: error.message, variant: "destructive" });
    } else if (data) {
      setSongs((prev) => [data as Song, ...prev]);
      setShowAddDialog(false);
      setNewSong({ title: "", artist: "", url: "" });
      toast({ title: "Song added! 🎵" });
    }
  };

  const deleteSong = async (id: string) => {
    hapticLight();
    await supabase.from("playlist_songs").delete().eq("id", id);
    setSongs((prev) => prev.filter((s) => s.id !== id));
    if (currentSong?.id === id) {
      setCurrentIndex(-1);
      setIsPlaying(false);
    }
  };

  // Blend actions
  const sendBlendInvite = async () => {
    if (!user) return;
    hapticMedium();
    const { error } = await supabase.from("blend_invites").insert({ sender_id: user.id } as any);
    if (error) {
      toast({ title: "Couldn't send invite", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Blend invite sent! 🎶", description: "Waiting for your partner to accept" });
    }
  };

  const acceptBlend = async () => {
    if (!blendPending) return;
    hapticMedium();
    await supabase
      .from("blend_invites")
      .update({ status: "accepted" } as any)
      .eq("id", blendPending.id);
    setBlendActive(true);
    setBlendPending(null);
  };

  const declineBlend = async () => {
    if (!blendPending) return;
    hapticLight();
    await supabase.from("blend_invites").delete().eq("id", blendPending.id);
    setBlendPending(null);
  };

  const endBlend = async () => {
    hapticLight();
    await supabase.from("blend_invites").delete().in("status", ["accepted"] as any);
    setBlendActive(false);
  };

  const platformIcon = (platform: string) => {
    switch (platform) {
      case "spotify": return "🟢";
      case "youtube": return "🔴";
      case "soundcloud": return "🟠";
      case "apple-music": return "🍎";
      default: return "🎵";
    }
  };

  const ytId = currentSong?.platform === "youtube" ? getYouTubeId(currentSong.song_url) : null;
  const spotifyData = currentSong?.platform === "spotify" ? getSpotifyId(currentSong.song_url) : null;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }} className="flex-1 min-h-0 overflow-y-auto overscroll-contain pb-36" style={{ WebkitOverflowScrolling: "touch" as any }}>
      <PageHeader title="Our Playlist" subtitle="Songs we love together">
        <div className="flex items-center gap-2">
          <button
            onClick={() => { hapticLight(); setShowSearch(!showSearch); }}
            className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center"
          >
            <Search className="h-5 w-5 text-foreground" />
          </button>
          <button
            onClick={() => setShowAddDialog(true)}
            className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center"
          >
            <Plus className="h-5 w-5 text-foreground" />
          </button>
        </div>
      </PageHeader>

      {/* Blend Status Banner */}
      <div className="px-5 mb-3">
        {blendPending && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-primary/10 border border-primary/20 rounded-2xl p-4 flex items-center justify-between"
          >
            <div>
              <p className="text-sm font-medium">🎶 Blend Invite</p>
              <p className="text-[11px] text-muted-foreground">
                {profiles[blendPending.sender_id] || "Partner"} wants to listen together
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={declineBlend}
                className="h-8 w-8 rounded-full bg-muted flex items-center justify-center"
              >
                <X className="h-4 w-4" />
              </button>
              <button
                onClick={acceptBlend}
                className="h-8 w-8 rounded-full bg-primary flex items-center justify-center"
              >
                <Check className="h-4 w-4 text-primary-foreground" />
              </button>
            </div>
          </motion.div>
        )}

        {blendActive ? (
          <div className="flex items-center justify-between bg-primary/5 border border-primary/10 rounded-xl px-4 py-2">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              <span className="text-xs font-medium text-primary">Blend Active</span>
            </div>
            <button onClick={endBlend} className="text-[10px] text-muted-foreground hover:text-foreground">
              End
            </button>
          </div>
        ) : (
          !blendPending &&
          partnerId && (
            <button
              onClick={sendBlendInvite}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-border text-xs text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors"
            >
              <Users className="h-3.5 w-3.5" /> Start Blend – Listen Together
            </button>
          )
        )}
      </div>

      {/* Search Section */}
      <AnimatePresence>
        {showSearch && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="px-5 mb-4 overflow-hidden"
          >
            <div className="flex gap-2">
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                placeholder="Search YouTube for songs..."
                className="rounded-xl flex-1"
              />
              <Button
                onClick={handleSearch}
                disabled={searching}
                size="sm"
                className="rounded-xl bg-foreground text-background px-4"
              >
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </div>

            {searchResults.length > 0 && (
              <div className="mt-3 space-y-2 max-h-60 overflow-y-auto">
                {searchResults.map((r, i) => (
                  <motion.button
                    key={`${r.videoId}-${i}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: i * 0.03 }}
                    onClick={() => addFromSearch(r)}
                    className="w-full flex items-center gap-3 p-2 rounded-xl bg-card border border-border hover:bg-accent/50 transition-colors text-left"
                  >
                    <img
                      src={r.thumbnail}
                      alt=""
                      className="h-10 w-10 rounded-lg object-cover shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{r.title}</p>
                      <p className="text-[10px] text-muted-foreground truncate">
                        {r.artist} {r.duration > 0 && `• ${formatDuration(r.duration)}`}
                      </p>
                    </div>
                    <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
                  </motion.button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Now Playing */}
      <AnimatePresence>
        {currentSong && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="px-5 mb-4"
          >
            <div className="bg-card rounded-2xl border border-border overflow-hidden shadow-sm">
              {/* Player embed */}
              {isPlaying && ytId && (
                <iframe
                  src={`https://www.youtube.com/embed/${ytId}?autoplay=1&enablejsapi=1`}
                  className="w-full aspect-video"
                  allow="autoplay; encrypted-media"
                  allowFullScreen
                />
              )}
              {isPlaying && spotifyData && (
                <iframe
                  src={`https://open.spotify.com/embed/${spotifyData.type}/${spotifyData.id}?autoplay=1`}
                  className="w-full h-20"
                  allow="autoplay; clipboard-write; encrypted-media"
                />
              )}
              {isPlaying && !ytId && !spotifyData && (
                <div className="p-4 text-center">
                  <a
                    href={currentSong.song_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-2 text-primary text-xs"
                  >
                    <ExternalLink className="h-4 w-4" /> Open in browser
                  </a>
                </div>
              )}

              {/* Song info + controls */}
              <div className="p-4">
                <div className="text-center mb-3">
                  <p className="text-sm font-semibold truncate">{currentSong.title}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{currentSong.artist}</p>
                </div>

                {/* Playback controls */}
                <div className="flex items-center justify-center gap-5">
                  <button
                    onClick={toggleShuffle}
                    className={`h-8 w-8 rounded-full flex items-center justify-center transition-colors ${
                      shuffleOn ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    <Shuffle className="h-4 w-4" />
                  </button>

                  <button onClick={playPrev} className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                    <SkipBack className="h-4 w-4" />
                  </button>

                  <button
                    onClick={togglePlay}
                    className="h-14 w-14 rounded-full bg-foreground flex items-center justify-center shadow-lg"
                  >
                    {isPlaying ? (
                      <Pause className="h-6 w-6 text-background" />
                    ) : (
                      <Play className="h-6 w-6 text-background ml-0.5" />
                    )}
                  </button>

                  <button onClick={playNext} className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                    <SkipForward className="h-4 w-4" />
                  </button>

                  <button
                    onClick={cycleRepeat}
                    className={`h-8 w-8 rounded-full flex items-center justify-center transition-colors ${
                      repeatMode !== "off" ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    {repeatMode === "one" ? <Repeat1 className="h-4 w-4" /> : <Repeat className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Song list */}
      <div className="px-5 space-y-2">
        {songs.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <div className="h-16 w-16 rounded-2xl bg-accent flex items-center justify-center mx-auto">
              <Music className="h-8 w-8 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">No songs yet. Add your first song!</p>
            <div className="flex gap-2 justify-center">
              <Button
                onClick={() => { hapticLight(); setShowSearch(true); }}
                variant="outline"
                className="rounded-xl gap-2"
              >
                <Search className="h-4 w-4" /> Search
              </Button>
              <Button
                onClick={() => setShowAddDialog(true)}
                variant="outline"
                className="rounded-xl gap-2"
              >
                <Plus className="h-4 w-4" /> Paste Link
              </Button>
            </div>
          </div>
        ) : (
          <AnimatePresence>
            {queue.map((song, i) => {
              const isCurrent = currentSong?.id === song.id;
              return (
                <motion.div
                  key={song.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -80 }}
                  transition={{ delay: i * 0.02 }}
                  onClick={() => playSong(song)}
                  className={`flex items-center gap-3 p-3 rounded-2xl border transition-colors cursor-pointer ${
                    isCurrent
                      ? "bg-primary/5 border-primary/20"
                      : "bg-card border-border hover:bg-accent/30"
                  }`}
                >
                  <div className="h-11 w-11 rounded-xl bg-accent flex items-center justify-center shrink-0 overflow-hidden relative">
                    {song.thumbnail_url ? (
                      <img src={song.thumbnail_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-base">{platformIcon(song.platform)}</span>
                    )}
                    {isCurrent && isPlaying && (
                      <div className="absolute inset-0 bg-primary/30 flex items-center justify-center">
                        <div className="flex gap-0.5 items-end h-3">
                          <motion.div animate={{ height: ["30%", "100%", "30%"] }} transition={{ repeat: Infinity, duration: 0.5 }} className="w-[2px] bg-primary-foreground rounded-full" />
                          <motion.div animate={{ height: ["60%", "30%", "100%"] }} transition={{ repeat: Infinity, duration: 0.6 }} className="w-[2px] bg-primary-foreground rounded-full" />
                          <motion.div animate={{ height: ["100%", "50%", "80%"] }} transition={{ repeat: Infinity, duration: 0.4 }} className="w-[2px] bg-primary-foreground rounded-full" />
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${isCurrent ? "text-primary" : ""}`}>
                      {song.title}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">{song.artist}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {profiles[song.added_by] || "Unknown"}
                    </p>
                  </div>

                  {song.added_by === user?.id && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSong(song.id);
                      }}
                      className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* Add song dialog (paste link) */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="rounded-2xl max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Music className="h-5 w-5" /> Add a Song
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Song Link *</label>
              <Input
                value={newSong.url}
                onChange={(e) => setNewSong({ ...newSong, url: e.target.value })}
                placeholder="Paste YouTube, Spotify, or any URL"
                className="rounded-xl"
              />
              <p className="text-[10px] text-muted-foreground">
                Supports YouTube, Spotify, SoundCloud, Apple Music
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Song Title</label>
              <Input
                value={newSong.title}
                onChange={(e) => setNewSong({ ...newSong, title: e.target.value })}
                placeholder="e.g. Perfect"
                className="rounded-xl"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] text-muted-foreground uppercase tracking-wider">Artist</label>
              <Input
                value={newSong.artist}
                onChange={(e) => setNewSong({ ...newSong, artist: e.target.value })}
                placeholder="e.g. Ed Sheeran"
                className="rounded-xl"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={addSong}
              disabled={!newSong.url.trim()}
              className="rounded-xl bg-foreground text-background w-full"
            >
              Add Song
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.div>
  );
};

export default Playlist;
