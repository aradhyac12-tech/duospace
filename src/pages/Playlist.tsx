import PageHeader from "@/components/PageHeader";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus, Trash2, Music, Play, Pause, SkipBack, SkipForward, Search,
  Shuffle, Repeat, Repeat1, Users, ExternalLink, X, Check, Loader2, GripVertical,
} from "lucide-react";
import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { useAuth } from "@/hooks/useAuth";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { hapticLight, hapticMedium, hapticNotification, hapticWarning, hapticError } from "@/lib/haptics";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Shimmer } from "@/components/skeletons/Shimmer";
import { ErrorCard } from "@/components/errors/ErrorCard";
import { useErrorManager } from "@/lib/errors/useErrorManager";
import type { DuoSpaceErrorPayload } from "@/lib/errors/types";
import { positionForNewTopEntry, positionForMove, sortByPosition, reconcileRealtimeRow } from "@/lib/music/playlistOrdering";

interface Song {
  id: string;
  title: string;
  artist: string;
  song_url: string;
  platform: string;
  thumbnail_url: string | null;
  added_by: string;
  created_at: string;
  position: number;
  updated_at: string;
  updated_by: string | null;
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
  const { capture } = useErrorManager("Groic & Playlist");

  // Song list
  const [songs, setSongs] = useState<Song[]>([]);
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  // Loading vs empty distinction — without it, "No songs yet" flashes on
  // every cold load (and would stick around forever on a genuine fetch
  // failure, with the collection looking silently wiped).
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<DuoSpaceErrorPayload | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState<Song | null>(null);
  const [removing, setRemoving] = useState(false);

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

  // Trending (Home rails)
  const [trendingEnglish, setTrendingEnglish] = useState<SearchResult[]>([]);
  const [trendingHindi, setTrendingHindi] = useState<SearchResult[]>([]);
  const [trendingLoading, setTrendingLoading] = useState(true);
  const [trendingError, setTrendingError] = useState(false);

  // Up Next — varied auto-suggestions seeded from whatever's currently
  // playing, so "Play Next" doesn't just loop the same static library once
  // you reach the end of it.
  const [upNext, setUpNext] = useState<SearchResult[]>([]);
  const [upNextLoading, setUpNextLoading] = useState(false);
  const suggestedIdsRef = useRef<Set<string>>(new Set());

  const blendChannelRef = useRef<any>(null);
  const songsRef = useRef<Song[]>([]);
  useEffect(() => { songsRef.current = songs; }, [songs]);

  // ── Reorder (drag-and-drop) ──────────────────────────────────────────────
  // Optimistic: the local `songs` array is reordered immediately (see the
  // drag handlers below, which call setSongs directly during the drag for
  // live visual feedback), then this persists the ONE moved row's new
  // position. `toIndex` is the row's final index within `songs` AFTER the
  // live drag reorder already placed it there. Declared here (ahead of the
  // drag pointer handlers below, which depend on it) so those handlers'
  // useCallback dependency arrays never reference it before it exists.
  const commitReorder = useCallback(async (songId: string, toIndex: number) => {
    const current = songsRef.current;
    const others = current.filter((s) => s.id !== songId).map((s) => s.position);
    const newPosition = positionForMove(others, toIndex);
    const moved = current.find((s) => s.id === songId);
    if (!moved) return;

    // Reflect the committed position locally right away (rather than
    // waiting for our own realtime UPDATE to arrive) so the very next
    // drag on the same item has correct neighbor positions to compute
    // against.
    setSongs((prev) => sortByPosition(prev.map((s) => (s.id === songId ? { ...s, position: newPosition } : s))));

    const { error } = await supabase
      .from("playlist_songs")
      .update({ position: newPosition })
      .eq("id", songId);

    if (error) {
      capture("DS-GROIC-003", { component: "Playlist", action: "reorder", cause: error });
      toast({ title: "Couldn't save the new order", description: error.message, variant: "destructive" });
      // Revert to the pre-drag position rather than leaving local state
      // out of sync with the DB.
      setSongs((prev) => sortByPosition(prev.map((s) => (s.id === songId ? moved : s))));
    }
  }, [capture, toast]);

  // ── Drag-to-reorder state ────────────────────────────────────────────────
  // Pointer events (not a drag-and-drop library, and no scroll listener),
  // transform-based live reordering of the `songs` array itself during the
  // drag so the list visually reflows in real time, then a single position
  // write on release. rowRefs holds each row's live DOM node so pointermove
  // can read real layout (getBoundingClientRect) without re-rendering just
  // to measure.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRafRef = useRef<number | null>(null);
  const pendingClientYRef = useRef<number | null>(null);

  const reorderLive = useCallback((clientY: number) => {
    const id = draggingId;
    if (!id) return;
    setSongs((prev) => {
      const fromIndex = prev.findIndex((s) => s.id === id);
      if (fromIndex === -1) return prev;
      // Target index = how many OTHER rows' vertical midpoints the
      // pointer is currently below.
      let toIndex = 0;
      for (const s of prev) {
        if (s.id === id) continue;
        const el = rowRefs.current.get(s.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        const mid = rect.top + rect.height / 2;
        if (clientY > mid) toIndex++;
      }
      if (toIndex === fromIndex) return prev;
      const next = prev.filter((s) => s.id !== id);
      next.splice(toIndex, 0, prev[fromIndex]);
      return next;
    });
  }, [draggingId]);

  const onDragPointerMove = useCallback((e: React.PointerEvent) => {
    if (!draggingId) return;
    pendingClientYRef.current = e.clientY;
    if (dragRafRef.current != null) return;
    dragRafRef.current = requestAnimationFrame(() => {
      dragRafRef.current = null;
      if (pendingClientYRef.current != null) reorderLive(pendingClientYRef.current);
    });
  }, [draggingId, reorderLive]);

  const onDragPointerUp = useCallback((e: React.PointerEvent) => {
    if (!draggingId) return;
    const id = draggingId;
    setDraggingId(null);
    try { (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); } catch { /* noop */ }
    if (dragRafRef.current != null) { cancelAnimationFrame(dragRafRef.current); dragRafRef.current = null; }
    const finalIndex = songsRef.current.findIndex((s) => s.id === id);
    if (finalIndex >= 0) commitReorder(id, finalIndex);
  }, [draggingId, commitReorder]);

  const onDragPointerDown = useCallback((e: React.PointerEvent, songId: string) => {
    hapticMedium();
    setDraggingId(songId);
    try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* noop */ }
  }, []);
  // Read inside the playlist realtime handler below, which is only set up
  // once ([user]) — without this ref it would close over currentSong from
  // whichever render set it up and never see later changes.
  const currentSongIdRef = useRef<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement>(null);

  const currentSong = currentIndex >= 0 && currentIndex < queue.length ? queue[currentIndex] : null;
  useEffect(() => { currentSongIdRef.current = currentSong?.id ?? null; }, [currentSong?.id]);

  // Load songs and profiles
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const { data, error } = await supabase
          .from("playlist_songs")
          .select("id,added_by,title,artist,song_url,platform,thumbnail_url,created_at,position,updated_at,updated_by")
          .order("position", { ascending: true });
        if (error) throw error;
        if (cancelled) return;
        if (data) {
          const s = sortByPosition(data as Song[]);
          setSongs(s);
          setQueue(s);
        }

        let myPartnerId: string | null = null;
        const { data: p, error: pErr } = await supabase.from("profiles").select("user_id, display_name, pet_name, partner_id");
        if (pErr) throw pErr;
        if (cancelled) return;
        if (p) {
          const rows = p as any[];
          const mine = rows.find((prof) => prof.user_id === user.id);
          if (mine?.partner_id) {
            setPartnerId(mine.partner_id);
            myPartnerId = mine.partner_id;
          }
          const map: Record<string, string> = {};
          rows.forEach((prof) => {
            map[prof.user_id] = prof.user_id === myPartnerId
              ? (mine?.pet_name || prof.display_name)
              : prof.display_name;
          });
          setProfiles(map);
        }

        // B12 Fix: Only check blend status when user has a partner
        if (myPartnerId) {
          const { data: blends } = await supabase
            .from("blend_invites")
            .select("id,added_by,title,artist,song_url,platform,thumbnail_url,created_at")
            .in("status", ["pending", "accepted"]) as any;
          if (cancelled) return;
          if (blends && blends.length > 0) {
            const activeBlend = blends.find((b: { status: string }) => b.status === "accepted");
            if (activeBlend) setBlendActive(true);
            const pendingBlend = blends.find(
              (b: { status: string; sender_id: string }) => b.status === "pending" && b.sender_id !== user.id
            );
            if (pendingBlend) setBlendPending(pendingBlend);
          }
        }
      } catch (err) {
        if (cancelled) return;
        setLoadError(capture("DS-GROIC-002", { component: "Playlist", action: "load", cause: err }));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [user, capture, reloadTick]);

  // Trending rails — fetched once per visit, independent of the song
  // library load above so a slow/failed trending fetch never blocks it.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      setTrendingLoading(true);
      setTrendingError(false);
      try {
        const data = await invokeEdgeFunction<{ english?: SearchResult[]; hindi?: SearchResult[] }>(
          "music-trending",
          { body: {} },
        );
        if (cancelled) return;
        setTrendingEnglish(data?.english ?? []);
        setTrendingHindi(data?.hindi ?? []);
      } catch (err) {
        if (cancelled) return;
        setTrendingError(true);
      } finally {
        if (!cancelled) setTrendingLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  // Up Next — refetch varied suggestions whenever the playing song changes.
  // Seeded on the artist (not the exact title) so results are genuinely
  // different songs rather than more copies of the same one, and filtered
  // against the library + everything already suggested this session so the
  // rail (and auto-continue below) doesn't repeat itself.
  const refreshUpNext = useCallback(async (seed: Song) => {
    if (!seed.artist) { setUpNext([]); return; }
    setUpNextLoading(true);
    try {
      const data = await invokeEdgeFunction<{ results?: SearchResult[] }>("music-search", {
        body: { query: `${seed.artist} songs` },
      });
      const librarySet = new Set(songsRef.current.map((s) => `${s.title}::${s.artist}`.toLowerCase()));
      const fresh = (data?.results ?? []).filter((r) => {
        const key = `${r.title}::${r.artist}`.toLowerCase();
        if (librarySet.has(key)) return false; // already in the saved playlist
        if (suggestedIdsRef.current.has(r.videoId)) return false; // already suggested this session
        return true;
      });
      fresh.forEach((r) => suggestedIdsRef.current.add(r.videoId));
      setUpNext(fresh.slice(0, 8));
    } catch {
      setUpNext([]);
    } finally {
      setUpNextLoading(false);
    }
  }, []);

  // Refetch Up Next whenever the currently playing song changes.
  useEffect(() => {
    if (!currentSong) return;
    refreshUpNext(currentSong);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSong?.id]);

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

  // Realtime "Our Playlist" sync — a partner's add/remove/reorder must
  // show up here without a manual refresh (Music 2.0 brief). The
  // couple-scope RLS migrations already limit which rows Realtime will
  // ever deliver to this client to the pair's own songs, so no
  // client-side owner filtering is needed for correctness — only for the
  // toast, which should announce the partner's action, not echo our own.
  //
  // INSERT: de-duped by id against the optimistic local insert addSong/
  // addFromSearch already performs, so whichever arrives first (the local
  // insert's own response, or this Realtime event) wins and the other is
  // a no-op — never a duplicate row, and no dependency on delivery order.
  // Inserted in position order rather than blindly prepended, since a
  // partner's add doesn't necessarily belong at the very top once
  // reordering is in play.
  //
  // UPDATE (new — reordering): a `position` (or any other field) change,
  // most commonly from a partner dragging a song. Guarded by `updated_at`
  // so a stale/duplicate/out-of-order realtime delivery can never clobber
  // a NEWER local state — this is the "don't let an older event overwrite
  // a newer local state" requirement from the brief, made concrete: if
  // what's already in local state for this id has an updated_at at or
  // after the incoming row's, the incoming event is a no-op.
  useEffect(() => {
    if (!user) return;
    const applyUpsert = (row: Song, announcePartner: (row: Song) => void) => {
      setSongs((prev) => reconcileRealtimeRow(prev, row));
      if (row.added_by !== user.id || (row.updated_by && row.updated_by !== user.id)) {
        announcePartner(row);
      }
    };

    const channel = supabase
      .channel("playlist-songs-rt")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "playlist_songs" },
        (payload) => {
          const row = payload.new as Song;
          applyUpsert(row, (r) => {
            if (r.added_by === user.id) return;
            hapticNotification("success");
            toast({ title: "🎵 New song added", description: "Your partner added a track to Our Playlist" });
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "playlist_songs" },
        (payload) => {
          const row = payload.new as Song;
          applyUpsert(row, (r) => {
            if (r.updated_by === user.id) return;
          });
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "playlist_songs" },
        (payload) => {
          const removedId = (payload.old as { id?: string })?.id;
          if (!removedId) return;
          setSongs((prev) => prev.filter((s) => s.id !== removedId));
          setQueue((prev) => prev.filter((s) => s.id !== removedId));
          if (currentSongIdRef.current === removedId) {
            setCurrentIndex(-1);
            setIsPlaying(false);
          }
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user, toast]);

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

  // Shuffle queue (preserves any auto-suggested songs appended at the tail
  // by playFromUpNext — those only live in `queue`, never in `songs`/the DB,
  // so a naive `setQueue([...songs])` here would silently drop whichever
  // one is currently playing whenever `songs` changes for an unrelated
  // reason, e.g. adding a new song mid-playback).
  useEffect(() => {
    const autoTail = queue.filter((s) => s.id.startsWith("auto_"));
    if (shuffleOn) {
      const shuffled = [...songs].sort(() => Math.random() - 0.5);
      const next = [...shuffled, ...autoTail];
      setQueue(next);
      setCurrentIndex(currentSong ? next.findIndex((s) => s.id === currentSong.id) : 0);
    } else {
      const next = [...songs, ...autoTail];
      setQueue(next);
      if (currentSong) {
        setCurrentIndex(next.findIndex((s) => s.id === currentSong.id));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shuffleOn, songs]);




  const playSong = (song: Song) => {
    const idx = queue.findIndex((s) => s.id === song.id);
    setCurrentIndex(idx >= 0 ? idx : 0);
    setIsPlaying(true);
    broadcastPlayback("play", song.id);
  };

  const togglePlay = () => {
    setIsPlaying(!isPlaying);
    broadcastPlayback(isPlaying ? "pause" : "play", currentSong?.id);
  };

  // Turn an Up Next suggestion into a playable queue entry without writing
  // it to the shared playlist_songs table — it's a transient suggestion,
  // not something either partner deliberately added.
  const playFromUpNext = useCallback((item: SearchResult) => {
    const autoSong: Song = {
      id: `auto_${item.videoId}`,
      title: item.title,
      artist: item.artist,
      song_url: item.url,
      platform: "youtube",
      thumbnail_url: item.thumbnail,
      added_by: "auto",
      created_at: new Date().toISOString(),
    };
    setQueue((prev) => [...prev, autoSong]);
    setUpNext((prev) => prev.filter((r) => r.videoId !== item.videoId));
    setCurrentIndex(queue.length);
    setIsPlaying(true);
    broadcastPlayback("skip", autoSong.id);
  }, [queue.length, broadcastPlayback]);

  const playNext = useCallback(() => {
    if (repeatMode === "one") {
      // Replay same song (re-trigger by toggling index)
      setCurrentIndex((prev) => prev);
      setIsPlaying(true);
      return;
    }
    let next = currentIndex + 1;
    if (next >= queue.length) {
      if (repeatMode === "all") {
        next = 0;
      } else if (upNext.length > 0) {
        // Ran out of the saved playlist — keep going with a varied
        // suggestion instead of just stopping (or silently looping the
        // same fixed list, which is what used to happen).
        playFromUpNext(upNext[0]);
        return;
      } else {
        setIsPlaying(false);
        return;
      }
    }
    setCurrentIndex(next);
    setIsPlaying(true);
    broadcastPlayback("skip", queue[next]?.id);
  }, [currentIndex, queue, repeatMode, broadcastPlayback, upNext, playFromUpNext]);

  const playPrev = () => {
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
    setShuffleOn(!shuffleOn);
  };

  const cycleRepeat = () => {
    const modes: RepeatMode[] = ["off", "all", "one"];
    const idx = modes.indexOf(repeatMode);
    setRepeatMode(modes[(idx + 1) % 3]);
  };

  // Search YouTube
  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const data = await invokeEdgeFunction<{ results?: SearchResult[] }>("music-search", {
        body: { query: searchQuery.trim() },
      });
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
        position: positionForNewTopEntry(songsRef.current.map((s) => s.position)),
      })
      .select()
      .single();

    if (error) {
      toast({ title: "Couldn't add song", description: error.message, variant: "destructive" });
    } else if (data) {
      const s = data as Song;
      setSongs((prev) => sortByPosition([s, ...prev]));
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
        position: positionForNewTopEntry(songsRef.current.map((s) => s.position)),
      })
      .select()
      .single();

    if (error) {
      capture("DS-GROIC-003", { component: "AddSongDialog", action: "insert", cause: error });
      toast({ title: "Couldn't add song", description: error.message, variant: "destructive" });
    } else if (data) {
      setSongs((prev) => sortByPosition([data as Song, ...prev]));
      setShowAddDialog(false);
      setNewSong({ title: "", artist: "", url: "" });
      toast({ title: "Song added! 🎵" });
    }
  };

  const deleteSong = async (song: Song) => {
    // Auto-suggested (Up Next) songs were never written to playlist_songs —
    // just drop it from the local queue instead of issuing a DB delete
    // for a row that was never inserted.
    if (song.id.startsWith("auto_")) {
      setQueue((prev) => prev.filter((s) => s.id !== song.id));
      if (currentSong?.id === song.id) {
        setCurrentIndex(-1);
        setIsPlaying(false);
      }
      setConfirmRemove(null);
      return;
    }
    setRemoving(true);
    const { error } = await supabase.from("playlist_songs").delete().eq("id", song.id);
    setRemoving(false);
    if (error) {
      capture("DS-GROIC-003", { component: "Playlist", action: "deleteSong", cause: error });
      toast({ title: "Couldn't remove song", variant: "destructive" });
      return;
    }
    setSongs((prev) => prev.filter((s) => s.id !== song.id));
    if (currentSong?.id === song.id) {
      setCurrentIndex(-1);
      setIsPlaying(false);
    }
    setConfirmRemove(null);
  };

  // Blend actions
  const sendBlendInvite = async () => {
    if (!user) return;
    hapticMedium();
    const { error } = await supabase.from("blend_invites").insert({ sender_id: user.id } as any);
    if (error) {
      capture("DS-GROIC-004", { component: "Playlist", action: "sendBlendInvite", cause: error });
      toast({ title: "Couldn't send invite", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Blend invite sent! 🎶", description: "Waiting for your partner to accept" });
    }
  };

  const acceptBlend = async () => {
    if (!blendPending) return;
    hapticMedium();
    const { error } = await supabase
      .from("blend_invites")
      .update({ status: "accepted" } as any)
      .eq("id", blendPending.id);
    if (error) {
      capture("DS-GROIC-004", { component: "Playlist", action: "acceptBlend", cause: error });
      toast({ title: "Couldn't accept invite", description: "Try again.", variant: "destructive" });
      return;
    }
    setBlendActive(true);
    setBlendPending(null);
  };

  const declineBlend = async () => {
    if (!blendPending) return;
    hapticLight();
    const { error } = await supabase.from("blend_invites").delete().eq("id", blendPending.id);
    if (error) {
      capture("DS-GROIC-004", { component: "Playlist", action: "declineBlend", cause: error });
      toast({ title: "Couldn't decline invite", description: "Try again.", variant: "destructive" });
      return;
    }
    setBlendPending(null);
  };

  const endBlend = async () => {
    hapticLight();
    const { error } = await supabase.from("blend_invites").delete().in("status", ["accepted"] as any);
    if (error) {
      capture("DS-GROIC-004", { component: "Playlist", action: "endBlend", cause: error });
      toast({ title: "Couldn't end blend", description: "Try again.", variant: "destructive" });
      return;
    }
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
            onClick={() => { setShowSearch(!showSearch); }}
            aria-label={showSearch ? "Close search" : "Search songs"}
            className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center"
          >
            <Search className="h-5 w-5 text-accent-foreground" aria-hidden="true" />
          </button>
          <button
            onClick={() => setShowAddDialog(true)}
            aria-label="Add song"
            className="h-9 w-9 rounded-xl bg-accent flex items-center justify-center"
          >
            <Plus className="h-5 w-5 text-accent-foreground" aria-hidden="true" />
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
                aria-label="Decline blend invite"
                className="h-10 w-10 rounded-full bg-muted flex items-center justify-center"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                onClick={acceptBlend}
                aria-label="Accept blend invite"
                className="h-10 w-10 rounded-full bg-primary flex items-center justify-center"
              >
                <Check className="h-4 w-4 text-primary-foreground" aria-hidden="true" />
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
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-border text-xs text-muted-foreground hover:text-accent hover:border-accent/40 transition-colors"
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
                className="rounded-xl bg-primary text-primary-foreground px-4"
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
                      loading="lazy" decoding="async"
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

      {/* Trending rails (Home) */}
      {!showSearch && (
        <div className="mb-4 space-y-4">
          {trendingLoading ? (
            <div className="px-5 flex gap-3 overflow-hidden">
              {[0, 1, 2].map((i) => (
                <Shimmer key={i} className="h-32 w-28 rounded-xl shrink-0" />
              ))}
            </div>
          ) : trendingError ? null : (
            <>
              {trendingEnglish.length > 0 && (
                <div>
                  <p className="px-5 text-xs font-semibold text-muted-foreground mb-2">Trending English</p>
                  <div className="flex gap-3 overflow-x-auto px-5 pb-1">
                    {trendingEnglish.map((r, i) => (
                      <button
                        key={`en-${r.videoId}-${i}`}
                        onClick={() => addFromSearch(r)}
                        className="w-28 shrink-0 text-left"
                      >
                        <img loading="lazy" decoding="async" src={r.thumbnail} alt="" className="h-28 w-28 rounded-xl object-cover mb-1.5" />
                        <p className="text-[11px] font-medium truncate">{r.title}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{r.artist}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {trendingHindi.length > 0 && (
                <div>
                  <p className="px-5 text-xs font-semibold text-muted-foreground mb-2">Trending Hindi</p>
                  <div className="flex gap-3 overflow-x-auto px-5 pb-1">
                    {trendingHindi.map((r, i) => (
                      <button
                        key={`hi-${r.videoId}-${i}`}
                        onClick={() => addFromSearch(r)}
                        className="w-28 shrink-0 text-left"
                      >
                        <img loading="lazy" decoding="async" src={r.thumbnail} alt="" className="h-28 w-28 rounded-xl object-cover mb-1.5" />
                        <p className="text-[11px] font-medium truncate">{r.title}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{r.artist}</p>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

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
                    onClick={() => { toggleShuffle(); }}
                    aria-label={shuffleOn ? "Turn off shuffle" : "Turn on shuffle"}
                    aria-pressed={shuffleOn}
                    className={`h-9 w-9 rounded-full flex items-center justify-center transition-all duration-150 active:scale-90 ${
                      shuffleOn ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    <Shuffle className="h-4 w-4" aria-hidden="true" />
                  </button>

                  <button onClick={() => { playPrev(); }} aria-label="Previous track" className="h-10 w-10 rounded-full bg-muted flex items-center justify-center active:scale-90 transition-transform">
                    <SkipBack className="h-4 w-4" aria-hidden="true" />
                  </button>

                  <button
                    onClick={() => { hapticMedium(); togglePlay(); }}
                    aria-label={isPlaying ? "Pause" : "Play"}
                    className="h-14 w-14 rounded-full bg-primary flex items-center justify-center shadow-lg active:scale-90 transition-transform"
                  >
                    {isPlaying ? (
                      <Pause className="h-6 w-6 text-primary-foreground" aria-hidden="true" />
                    ) : (
                      <Play className="h-6 w-6 text-primary-foreground ml-0.5" aria-hidden="true" />
                    )}
                  </button>

                  <button onClick={() => { playNext(); }} aria-label="Next track" className="h-10 w-10 rounded-full bg-muted flex items-center justify-center active:scale-90 transition-transform">
                    <SkipForward className="h-4 w-4" aria-hidden="true" />
                  </button>

                  <button
                    onClick={() => { cycleRepeat(); }}
                    aria-label={`Repeat: ${repeatMode === "off" ? "off" : repeatMode === "one" ? "one song" : "all"}. Tap to change`}
                    className={`h-9 w-9 rounded-full flex items-center justify-center transition-all duration-150 active:scale-90 ${
                      repeatMode !== "off" ? "text-primary" : "text-muted-foreground"
                    }`}
                  >
                    {repeatMode === "one" ? <Repeat1 className="h-4 w-4" aria-hidden="true" /> : <Repeat className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Up Next — varied suggestions seeded from the current song, so the
          queue doesn't just loop the same static playlist. Only shown while
          something's actually playing. */}
      {currentSong && (upNextLoading || upNext.length > 0) && (
        <div className="px-5 mb-4">
          <p className="text-xs font-semibold text-muted-foreground mb-2">Up Next</p>
          {upNextLoading ? (
            <div className="space-y-2">
              {[0, 1].map((i) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded-xl border border-border">
                  <Shimmer className="h-10 w-10 rounded-lg shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Shimmer className="h-3 w-1/2" />
                    <Shimmer className="h-2.5 w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {upNext.map((r, i) => (
                <button
                  key={`upnext-${r.videoId}-${i}`}
                  onClick={() => playFromUpNext(r)}
                  className="w-full flex items-center gap-3 p-2 rounded-xl bg-card border border-border hover:bg-accent/50 transition-colors text-left"
                >
                  <img loading="lazy" decoding="async" src={r.thumbnail} alt="" className="h-10 w-10 rounded-lg object-cover shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{r.title}</p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {r.artist} {r.duration > 0 && `• ${formatDuration(r.duration)}`}
                    </p>
                  </div>
                  <Play className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Song list */}
      <div className="px-5 space-y-2">
        {loading ? (
          <div className="space-y-2" aria-busy="true" aria-label="Loading playlist">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 p-3 rounded-2xl border border-border">
                <Shimmer className="h-11 w-11 rounded-xl shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Shimmer className="h-3 w-1/2" />
                  <Shimmer className="h-2.5 w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : loadError ? (
          <div className="flex justify-center py-8">
            <ErrorCard error={loadError} onRetry={() => setReloadTick((t) => t + 1)} />
          </div>
        ) : songs.length === 0 ? (
          <div className="text-center py-16 space-y-3">
            <div className="h-16 w-16 rounded-2xl bg-accent flex items-center justify-center mx-auto">
              <Music className="h-8 w-8 text-accent-foreground/70" />
            </div>
            <p className="text-sm text-muted-foreground">No songs yet. Add your first song!</p>
            <div className="flex gap-2 justify-center">
              <Button
                onClick={() => { setShowSearch(true); }}
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
              const isAuto = song.id.startsWith("auto_");
              const isDragging = draggingId === song.id;
              // Either partner can remove or reorder any song in the joint
              // list (matches the couple-scoped DELETE/UPDATE RLS policies)
              // — auto-suggested "Up Next" rows aren't real playlist_songs
              // rows, so they're never draggable/reorderable.
              const canManage = !isAuto;
              return (
                <motion.div
                  key={song.id}
                  ref={(el) => { if (el) rowRefs.current.set(song.id, el); else rowRefs.current.delete(song.id); }}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -80 }}
                  transition={{ delay: i * 0.02 }}
                  onClick={() => { playSong(song); }}
                  onPointerMove={onDragPointerMove}
                  onPointerUp={onDragPointerUp}
                  onPointerCancel={onDragPointerUp}
                  className={`flex items-center gap-3 p-3 rounded-2xl border transition-all duration-150 active:scale-[0.98] cursor-pointer ${
                    isDragging ? "relative z-10 shadow-lg scale-[1.02]" : ""
                  } ${
                    isCurrent
                      ? "bg-primary/5 border-primary/20"
                      : "bg-card border-border hover:bg-accent/30"
                  }`}
                >
                  {canManage && (
                    <button
                      onClick={(e) => e.stopPropagation()}
                      onPointerDown={(e) => { e.stopPropagation(); onDragPointerDown(e, song.id); }}
                      aria-label={`Drag to reorder ${song.title}`}
                      className="h-10 w-6 -ml-1 flex items-center justify-center text-muted-foreground/50 touch-none shrink-0 cursor-grab active:cursor-grabbing"
                    >
                      <GripVertical className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                  <div className="h-11 w-11 rounded-xl bg-accent flex items-center justify-center shrink-0 overflow-hidden relative">
                    {song.thumbnail_url ? (
                      <img loading="lazy" decoding="async" src={song.thumbnail_url} alt="" className="h-full w-full object-cover" />
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

                  {canManage && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        hapticWarning();
                        setConfirmRemove(song);
                      }}
                      aria-label="Delete song"
                      className="h-10 w-10 rounded-lg flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>

      {/* Remove-song confirmation — unified destructive-action pattern */}
      <AlertDialog open={!!confirmRemove} onOpenChange={(v) => !v && setConfirmRemove(null)}>
        <AlertDialogContent className="rounded-2xl max-w-xs">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">Remove "{confirmRemove?.title}"?</AlertDialogTitle>
            <AlertDialogDescription>This removes it from your shared playlist for both of you.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-xl">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-xl bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={removing}
              onClick={() => { hapticError(); if (confirmRemove) deleteSong(confirmRemove); }}
            >
              {removing ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

export default Playlist;
