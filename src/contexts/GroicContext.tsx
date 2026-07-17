/**
 * GroicContext — global music player + shared sync engine.
 *
 * Architecture
 * ─────────────
 *  - One hidden YouTube IFrame Player mounted at app root, controlled via the
 *    YT JS API (play/pause/seek/load).
 *  - State (track, queue, isPlaying, position) lives in this context so the
 *    mini-player, full-player, chat invites, and Groic page all see the same
 *    truth.
 *  - Shared listening uses a Supabase Realtime broadcast channel keyed by the
 *    couple. The user who pressed "Start Session" becomes the host. The host
 *    emits `tick` events ~1.5s with `(trackId, positionMs, isPlaying, ts)`.
 *    Guests compute drift = (hostPos + (now - ts)) - localPos and:
 *      - drift > 1500ms → seek to host position (hard catch-up)
 *      - drift  500–1500ms → playbackRate 1.05 / 0.95 nudges (soft catch-up)
 *      - drift  < 500ms → leave alone
 *  - Host change events (load track, play, pause, seek) are pushed immediately
 *    so guests don't wait for the next tick.
 */

import {
  createContext, useContext, useEffect, useRef, useState, useCallback,
  ReactNode, useMemo,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { loadYouTubeAPI, extractYouTubeId } from "@/lib/youtubeApi";

export interface GroicTrack {
  id: string;            // playlist_songs.id (or videoId fallback)
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string | null;
  duration?: number;
}

type Role = "solo" | "host" | "guest";

interface GroicState {
  current: GroicTrack | null;
  queue: GroicTrack[];
  isPlaying: boolean;
  position: number;        // seconds
  duration: number;        // seconds
  expanded: boolean;       // full-player open
  sessionRole: Role;
  partnerListening: boolean;
}

interface GroicAPI extends GroicState {
  playTrack: (t: GroicTrack, queue?: GroicTrack[]) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (sec: number) => void;
  enqueue: (t: GroicTrack) => void;
  removeFromQueue: (id: string) => void;
  clearQueue: () => void;
  expand: (v: boolean) => void;
  startSession: () => Promise<void>;
  endSession: () => Promise<void>;
}

const GroicContext = createContext<GroicAPI | null>(null);

export const useGroic = (): GroicAPI => {
  const ctx = useContext(GroicContext);
  if (!ctx) throw new Error("useGroic must be used within GroicProvider");
  return ctx;
};

const TICK_MS = 1500;
const HARD_DRIFT = 1.5;   // seconds
const SOFT_DRIFT = 0.5;

export const GroicProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const [current, setCurrent]       = useState<GroicTrack | null>(null);
  const [queue, setQueue]           = useState<GroicTrack[]>([]);
  const [isPlaying, setIsPlaying]   = useState(false);
  const [position, setPosition]     = useState(0);
  const [duration, setDuration]     = useState(0);
  const [expanded, setExpanded]     = useState(false);
  const [sessionRole, setSessionRole] = useState<Role>("solo");
  const [partnerListening, setPartnerListening] = useState(false);
  const [partnerId, setPartnerId]   = useState<string | null>(null);

  const playerRef    = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const channelRef   = useRef<any>(null);
  const tickTimer    = useRef<number | null>(null);
  const positionPoll = useRef<number | null>(null);
  const muteHostBroadcast = useRef(false); // ignore self echo
  const pendingVideoRef = useRef<{ videoId: string; autoplay: boolean } | null>(null);

  // Resolve partner id once
  useEffect(() => {
    if (!user) return;
    supabase.from("profiles").select("partner_id").eq("user_id", user.id).single()
      .then(({ data }) => setPartnerId(data?.partner_id ?? null));
  }, [user]);

  // ── Mount hidden YouTube player ──────────────────────────────────────────
  useEffect(() => {
    if (typeof document === "undefined") return;
    const div = document.createElement("div");
    div.id = "groic-yt-host";
    div.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none;";
    document.body.appendChild(div);
    containerRef.current = div;

    let cancelled = false;
    loadYouTubeAPI().then((YT) => {
      if (cancelled) return;
      playerRef.current = new YT.Player(div, {
        height: "1", width: "1",
        playerVars: { autoplay: 0, controls: 0, modestbranding: 1, playsinline: 1 },
        events: {
          onReady: () => {
            const pending = pendingVideoRef.current;
            pendingVideoRef.current = null;
            if (pending) {
              if (pending.autoplay) playerRef.current?.loadVideoById?.(pending.videoId);
              else playerRef.current?.cueVideoById?.(pending.videoId);
            }
          },
          onStateChange: (e: any) => {
            // 1=playing, 2=paused, 0=ended
            if (e.data === 1) setIsPlaying(true);
            if (e.data === 2) setIsPlaying(false);
            if (e.data === 0) advanceNext();
          },
        },
      });
    });

    // Position polling
    positionPoll.current = window.setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      try {
        setPosition(p.getCurrentTime() || 0);
        const d = p.getDuration?.() || 0;
        if (d) setDuration(d);
      } catch { /* player not ready */ }
    }, 500) as unknown as number;

    return () => {
      cancelled = true;
      if (positionPoll.current) clearInterval(positionPoll.current);
      try { playerRef.current?.destroy?.(); } catch { /* noop */ }
      div.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Player commands ──────────────────────────────────────────────────────
  const loadVideo = useCallback((videoId: string, autoplay: boolean) => {
    const p = playerRef.current;
    if (!p?.loadVideoById) {
      pendingVideoRef.current = { videoId, autoplay };
      return;
    }
    if (autoplay) p.loadVideoById(videoId);
    else p.cueVideoById(videoId);
  }, []);

  const broadcast = useCallback((event: string, payload: Record<string, unknown>) => {
    if (sessionRole !== "host" || !channelRef.current) return;
    channelRef.current.send({ type: "broadcast", event, payload: { ...payload, ts: Date.now() } });
  }, [sessionRole]);

  const playTrack = useCallback((t: GroicTrack, q?: GroicTrack[]) => {
    setCurrent(t);
    if (q) setQueue(q);
    loadVideo(t.videoId, true);
    setIsPlaying(true);
    broadcast("load", { videoId: t.videoId, track: t });
  }, [loadVideo, broadcast]);

  const advanceNext = useCallback(() => {
    setCurrent((cur) => {
      if (!cur) return cur;
      const idx = queue.findIndex((x) => x.id === cur.id);
      const next = queue[idx + 1];
      if (next) {
        loadVideo(next.videoId, true);
        broadcast("load", { videoId: next.videoId, track: next });
        return next;
      }
      setIsPlaying(false);
      return cur;
    });
  }, [queue, loadVideo, broadcast]);

  const next = useCallback(() => advanceNext(), [advanceNext]);
  const prev = useCallback(() => {
    if (!current) return;
    const idx = queue.findIndex((x) => x.id === current.id);
    const p = queue[idx - 1];
    if (p) playTrack(p);
    else playerRef.current?.seekTo?.(0, true);
  }, [current, queue, playTrack]);

  const toggle = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    if (isPlaying) {
      p.pauseVideo?.();
      broadcast("pause", { position: p.getCurrentTime?.() || 0 });
    } else {
      p.playVideo?.();
      broadcast("play", { position: p.getCurrentTime?.() || 0 });
    }
  }, [isPlaying, broadcast]);

  const seek = useCallback((sec: number) => {
    playerRef.current?.seekTo?.(sec, true);
    setPosition(sec);
    broadcast("seek", { position: sec });
  }, [broadcast]);

  const enqueue = useCallback((t: GroicTrack) => {
    setQueue((q) => q.some((x) => x.id === t.id) ? q : [...q, t]);
  }, []);
  const removeFromQueue = useCallback((id: string) => {
    setQueue((q) => q.filter((x) => x.id !== id));
  }, []);
  const clearQueue = useCallback(() => setQueue([]), []);

  // ── Host: emit periodic ticks for guests ─────────────────────────────────
  useEffect(() => {
    if (sessionRole !== "host" || !channelRef.current) return;
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (!p?.getCurrentTime || !current) return;
      channelRef.current.send({
        type: "broadcast",
        event: "tick",
        payload: {
          videoId: current.videoId,
          position: p.getCurrentTime(),
          isPlaying,
          ts: Date.now(),
        },
      });
    }, TICK_MS);
    tickTimer.current = id;
    return () => clearInterval(id);
  }, [sessionRole, current, isPlaying]);

  // ── Guest: handle inbound events ─────────────────────────────────────────
  const onGuestEvent = useCallback((event: string, payload: any) => {
    const p = playerRef.current;
    if (!p) return;
    if (event === "load") {
      setCurrent(payload.track);
      loadVideo(payload.videoId, true);
      setIsPlaying(true);
      return;
    }
    if (event === "play")  { p.playVideo?.();  setIsPlaying(true);  return; }
    if (event === "pause") { p.pauseVideo?.(); setIsPlaying(false); return; }
    if (event === "seek")  { p.seekTo?.(payload.position, true); return; }
    if (event === "tick") {
      const localPos  = p.getCurrentTime?.() || 0;
      const networkLag = (Date.now() - (payload.ts || Date.now())) / 1000;
      const targetPos = (payload.position || 0) + networkLag;
      const drift = targetPos - localPos;
      if (Math.abs(drift) > HARD_DRIFT) {
        p.seekTo?.(targetPos, true);
        try { p.setPlaybackRate?.(1); } catch { /* noop */ }
      } else if (Math.abs(drift) > SOFT_DRIFT) {
        try { p.setPlaybackRate?.(drift > 0 ? 1.05 : 0.95); } catch { /* noop */ }
      } else {
        try { p.setPlaybackRate?.(1); } catch { /* noop */ }
      }
      if (payload.isPlaying && !isPlaying) { p.playVideo?.(); setIsPlaying(true); }
      if (!payload.isPlaying && isPlaying) { p.pauseVideo?.(); setIsPlaying(false); }
    }
  }, [loadVideo, isPlaying]);

  // ── Session lifecycle ────────────────────────────────────────────────────
  const channelName = useMemo(() => {
    if (!user || !partnerId) return null;
    const ids = [user.id, partnerId].sort().join(":");
    return `groic:${ids}`;
  }, [user, partnerId]);

  const subscribeChannel = useCallback((role: Role) => {
    if (!channelName) return;
    if (channelRef.current) supabase.removeChannel(channelRef.current);
    const ch = supabase.channel(channelName, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "load" },  ({ payload }) => role === "guest" && onGuestEvent("load", payload))
      .on("broadcast", { event: "play" },  ({ payload }) => role === "guest" && onGuestEvent("play", payload))
      .on("broadcast", { event: "pause" }, ({ payload }) => role === "guest" && onGuestEvent("pause", payload))
      .on("broadcast", { event: "seek" },  ({ payload }) => role === "guest" && onGuestEvent("seek", payload))
      .on("broadcast", { event: "tick" },  ({ payload }) => role === "guest" && onGuestEvent("tick", payload))
      .on("broadcast", { event: "join" },  () => setPartnerListening(true))
      .on("broadcast", { event: "leave" }, () => setPartnerListening(false))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          ch.send({ type: "broadcast", event: "join", payload: { role } });
        }
      });
    channelRef.current = ch;
  }, [channelName, onGuestEvent]);

  const startSession = useCallback(async () => {
    if (!user || !partnerId) return;
    setSessionRole("host");
    subscribeChannel("host");
  }, [user, partnerId, subscribeChannel]);

  const endSession = useCallback(async () => {
    if (channelRef.current) {
      try { channelRef.current.send({ type: "broadcast", event: "leave", payload: {} }); } catch { /* noop */ }
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    setSessionRole("solo");
    setPartnerListening(false);
  }, []);

  // Auto-listen for incoming sessions (act as guest if partner starts hosting).
  useEffect(() => {
    if (!user || !partnerId || !channelName) return;
    if (sessionRole !== "solo") return;
    const probe = supabase.channel(channelName, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "join" }, ({ payload }) => {
        if (payload?.role === "host") {
          // Promote to guest
          supabase.removeChannel(probe);
          setSessionRole("guest");
          subscribeChannel("guest");
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(probe); };
  }, [user, partnerId, channelName, sessionRole, subscribeChannel]);

  const value: GroicAPI = {
    current, queue, isPlaying, position, duration, expanded,
    sessionRole, partnerListening,
    playTrack, toggle, next, prev, seek,
    enqueue, removeFromQueue, clearQueue,
    expand: setExpanded,
    startSession, endSession,
  };

  return <GroicContext.Provider value={value}>{children}</GroicContext.Provider>;
};

export { extractYouTubeId };
