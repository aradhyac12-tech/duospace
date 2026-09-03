/**
 * GroicContext — global music player + shared sync engine.
 *
 * ARCHITECTURE (post native-playback refactor — see
 * docs/MUSIC_NATIVE_PLAYBACK.md for the full writeup):
 *
 *  This context is an ORCHESTRATION layer, not the audio engine itself.
 *  It holds the state every consumer (mini-player, full-player, chat
 *  invites, the Groic page) reads, and delegates actual playback to
 *  whichever of two engines a track's provider requires:
 *
 *   - youtube-provider tracks: the existing hidden YouTube IFrame player,
 *     completely unchanged from before this refactor — same mount, same
 *     YT JS API calls, same event handling. YouTube audio is never
 *     extracted, proxied, or routed through the native engine — see
 *     native-plugins/audio-engine/README.md.
 *
 *   - audius-provider tracks (the ones actually capable of true
 *     background/lock-screen playback): delegated to the native
 *     DuospaceAudioEngine Capacitor plugin via src/lib/music/
 *     nativeAudioEngine.ts — real ExoPlayer+MediaSession on Android, real
 *     AVPlayer+MPNowPlayingInfoCenter on iOS, HTMLAudio+MediaSession on
 *     web. This context never touches an <audio> element or AVPlayer
 *     directly; it only calls the plugin wrapper and listens for its
 *     events, translating them into the same state fields the UI already
 *     reads (current, isPlaying, position, duration) — which is exactly
 *     why GroicMiniPlayer/GroicFullPlayer needed no rewrite for basic
 *     playback display.
 *
 *  Shared listening still uses a Supabase Realtime broadcast channel keyed
 *  by the couple, unchanged in its core drift-correction design — see the
 *  original tick/drift comments preserved below — but payloads now carry
 *  `provider`/`providerTrackId` so a guest resolves the SAME provider
 *  track (re-resolving an Audius stream URL locally, rather than trusting
 *  a URL the host already resolved, since Audius stream URLs are
 *  per-request) before starting playback, instead of assuming every
 *  shared track is a YouTube videoId.
 *
 *  Call coordination: this context pauses whichever engine is actually
 *  playing (Audius via the native engine, or YouTube via the IFrame) when
 *  a Daily.co call becomes active, and resumes it when the call ends only
 *  if that track was actually playing right before the call started — the
 *  existing audio-route plugin's own doc comment already establishes that
 *  a call's AVAudioSession/AudioFocus configuration takes priority over
 *  the music player's; see the `useCall()` effect below.
 */

import {
  createContext, useContext, useEffect, useRef, useState, useCallback,
  ReactNode, useMemo,
} from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCall } from "@/contexts/CallContext";
import { loadYouTubeAPI, extractYouTubeId } from "@/lib/youtubeApi";
import { GroicTrack, RepeatMode, MusicProvider, isNativelyStreamable, makeTrackId } from "@/lib/music/types";
import { resolveAudiusStreamUrl } from "@/lib/music/audiusProvider";
import { getOfflinePlayableTrack } from "@/lib/music/offlineDownloads";
import { nativeEngine } from "@/lib/music/nativeAudioEngine";
import { resolveAdvance } from "@/lib/music/queueLogic";
import { computeDrift } from "@/lib/music/driftCorrection";
import { recordPlayed } from "@/lib/music/playHistory";

export type { GroicTrack };

type Role = "solo" | "host" | "guest";

interface GroicState {
  current: GroicTrack | null;
  queue: GroicTrack[];
  isPlaying: boolean;
  position: number;        // seconds
  duration: number;        // seconds
  buffering: boolean;
  volume: number;          // 0..1 — Audius (native engine) only; YouTube's own IFrame volume is separate and untouched
  repeatMode: RepeatMode;
  shuffle: boolean;
  loading: boolean;        // resolving an Audius stream URL, or the track itself is otherwise not yet playable
  error: string | null;    // last playback error, cleared on next successful playTrack
  expanded: boolean;       // full-player open
  hidden: boolean;         // mini-player UI hidden while still playing
  sessionRole: Role;
  partnerListening: boolean;
  partnerInviteActive: boolean; // partner is hosting a session, not yet joined
}

interface GroicAPI extends GroicState {
  playTrack: (t: GroicTrack, queue?: GroicTrack[]) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  seek: (sec: number) => void;
  setVolume: (v: number) => void;
  setRepeatMode: (m: RepeatMode) => void;
  toggleShuffle: () => void;
  enqueue: (t: GroicTrack) => void;
  removeFromQueue: (id: string) => void;
  clearQueue: () => void;
  expand: (v: boolean) => void;
  hide: () => void;
  show: () => void;
  close: () => void;
  startSession: () => Promise<void>;
  endSession: () => Promise<void>;
  joinPartnerSession: () => void;
  dismissPartnerInvite: () => void;
}

const GroicContext = createContext<GroicAPI | null>(null);

export const useGroic = (): GroicAPI => {
  const ctx = useContext(GroicContext);
  if (!ctx) throw new Error("useGroic must be used within GroicProvider");
  return ctx;
};

const TICK_MS = 1500;

export const GroicProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const [current, setCurrent]       = useState<GroicTrack | null>(null);
  const [queue, setQueue]           = useState<GroicTrack[]>([]);
  const [isPlaying, setIsPlaying]   = useState(false);
  const [position, setPosition]     = useState(0);
  const [duration, setDuration]     = useState(0);
  const [buffering, setBuffering]   = useState(false);
  const [volume, setVolumeState]    = useState(1);
  const [repeatMode, setRepeatModeState] = useState<RepeatMode>("off");
  const [shuffle, setShuffle]       = useState(false);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [expanded, setExpanded]     = useState(false);
  // Distinct from `expanded`/closing: hidden keeps everything playing (audio,
  // session sync, queue) but tucks the mini-player bar away — a small
  // restore tab takes its place so it's never lost. Separate from `close()`,
  // which actually stops playback.
  const [hidden, setHidden]         = useState(false);
  const [sessionRole, setSessionRole] = useState<Role>("solo");
  const [partnerListening, setPartnerListening] = useState(false);
  const [partnerInviteActive, setPartnerInviteActive] = useState(false);
  const [partnerId, setPartnerId]   = useState<string | null>(null);

  const playerRef    = useRef<any>(null); // YouTube IFrame player only
  const containerRef = useRef<HTMLDivElement | null>(null);
  const channelRef   = useRef<any>(null);
  const probeRef      = useRef<any>(null); // the "am I being invited" listener, kept so joinPartnerSession can tear it down
  const tickTimer    = useRef<number | null>(null);
  const muteHostBroadcast = useRef(false); // ignore self echo
  const pendingVideoRef = useRef<{ videoId: string; autoplay: boolean } | null>(null);
  // Mirrors of state read inside stable callbacks (subscribeChannel) that
  // shouldn't themselves depend on current/isPlaying — a dependency there
  // would tear down and recreate the realtime channel on every tick.
  const currentRef   = useRef<GroicTrack | null>(null);
  const isPlayingRef = useRef(false);
  const repeatModeRef = useRef<RepeatMode>("off");
  const shuffleRef    = useRef(false);
  const queueRef       = useRef<GroicTrack[]>([]);
  // Mirrors exactly what was last handed to nativeEngine.setQueue() (see
  // syncNativeQueue below), keyed by id, WITH the resolved streamUrl each
  // entry actually carries natively — unlike `queue`'s own entries, which
  // don't get a resolved streamUrl until they've actually been played.
  // This is what the onTrackChanged handler below looks up a track in
  // when the native engine advances on its own (a real lock-screen/
  // Bluetooth remote command), since `current` needs the same resolved
  // object playTrack() would have produced for that track.
  const nativeQueueWindowRef = useRef<Map<string, GroicTrack>>(new Map());
  // Forward-reference to `broadcast` (declared further below, after this
  // file's native-engine event-wiring effect) — same pattern as
  // `advanceNextRef` just below: a plain ref, assigned with a plain
  // synchronous line right after the real callback is declared, so a
  // callback body that only runs later (an event firing) always sees the
  // current render's `broadcast` without a temporal-dead-zone reference.
  const broadcastRef = useRef<(event: string, payload: Record<string, unknown>) => void>(() => {});
  // Native engine (Audius) position/duration — kept in a ref (not just
  // React state) so the host's tick broadcast can read a synchronous,
  // always-current value without waiting for a re-render, the same way
  // playerRef.current.getCurrentTime() is a synchronous read for YouTube.
  const nativePositionRef = useRef(0);
  const nativeDurationRef = useRef(0);
  useEffect(() => { currentRef.current = current; }, [current]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { repeatModeRef.current = repeatMode; }, [repeatMode]);
  useEffect(() => { shuffleRef.current = shuffle; }, [shuffle]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  // BUG FIX (auto-advance never worked): the YT `onStateChange` handler is
  // registered once, at mount, so it permanently captured the FIRST
  // render's `advanceNext` — whose `queue` closure was always the initial
  // empty array. Ended tracks therefore never advanced to the next queued
  // song. Routing through a ref that is refreshed every render gives the
  // one-time listener the current implementation. The native engine's own
  // playbackEnded listener (wired once, below) uses the same ref for the
  // identical reason.
  const advanceNextRef = useRef<() => void>(() => {});


  // Resolve partner id once
  useEffect(() => {
    if (!user) return;
    supabase.from("profiles").select("partner_id").eq("user_id", user.id).single()
      .then(({ data }) => setPartnerId(data?.partner_id ?? null));
  }, [user]);

  // ── Mount hidden YouTube player (youtube-provider tracks only) ──────────
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
            // 1=playing, 2=paused, 0=ended — only meaningful while the
            // current track is actually a YouTube one; if the user has
            // since switched to an Audius track, the native engine's own
            // listener (below) is the source of truth instead.
            if (currentRef.current?.provider !== "youtube") return;
            if (e.data === 1) setIsPlaying(true);
            if (e.data === 2) setIsPlaying(false);
            if (e.data === 0) advanceNextRef.current();
          },
        },
      });
    });

    // Position polling — YouTube IFrame only; the native engine reports
    // its own position via positionChanged events (see the effect below),
    // not polling, since ExoPlayer/AVPlayer already push updates.
    const positionPoll = window.setInterval(() => {
      if (currentRef.current?.provider !== "youtube") return;
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
      clearInterval(positionPoll);
      try { playerRef.current?.destroy?.(); } catch { /* noop */ }
      div.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Native audio engine (Audius) event wiring — mounted once ────────────
  // FIX ("do not send a position update to React state every few
  // milliseconds"): the native engine itself only emits positionChanged
  // on a 1s interval (see AudioEnginePlugin.kt/.swift/web.ts) — this
  // effect doesn't add any further throttling on top because none is
  // needed; it's just relaying an already-reasonable-rate event into
  // React state.
  useEffect(() => {
    const subs: Promise<{ remove: () => void }>[] = [];
    subs.push(nativeEngine.onPlaybackStateChanged(({ state }) => {
      if (currentRef.current && !isNativelyStreamable(currentRef.current)) return;
      setIsPlaying(state === "playing");
      setBuffering(state === "loading");
    }));
    subs.push(nativeEngine.onPositionChanged(({ positionSeconds, durationSeconds }) => {
      nativePositionRef.current = positionSeconds;
      if (durationSeconds) nativeDurationRef.current = durationSeconds;
      if (currentRef.current && !isNativelyStreamable(currentRef.current)) return;
      setPosition(positionSeconds);
      if (durationSeconds) setDuration(durationSeconds);
    }));
    subs.push(nativeEngine.onPlaybackEnded(() => {
      if (currentRef.current && !isNativelyStreamable(currentRef.current)) return;
      advanceNextRef.current();
    }));
    // BUG FIX (native background audio — lock-screen/Bluetooth "next"/
    // "previous" desyncs the app UI): a real OS-level transport command
    // advances the native engine's OWN queue directly (see
    // syncNativeQueue below for what populates it) — it never goes
    // through this context's own next()/prev(), which apply shuffle/
    // repeat via queueLogic.ts. The audio genuinely changes and the
    // lock-screen artwork/title even update on their own (native reads
    // that straight from the MediaItem it's already playing) — but
    // without this, `current`/`position`/`duration` here silently kept
    // showing whatever was playing before the remote command, so the
    // mini-player and full-player displayed the wrong track while a
    // different one was actually audible.
    subs.push(nativeEngine.onTrackChanged(({ trackId }) => {
      if (currentRef.current && !isNativelyStreamable(currentRef.current)) return;
      if (!trackId || trackId === currentRef.current?.id) return;
      // Look the track up in the just-synced native queue window (which
      // carries the resolved streamUrl actually in use natively) rather
      // than the app's main `queue`, whose entries don't get a resolved
      // streamUrl until they've actually been played — see
      // nativeQueueWindowRef's own doc comment above.
      const match = nativeQueueWindowRef.current.get(trackId);
      if (!match) return; // outside the synced lookahead window — nothing safe to show as current
      setCurrent(match);
      setPosition(0);
      setDuration(match.duration || 0);
      setIsPlaying(true);
      broadcastRef.current("load", { provider: match.provider, providerTrackId: match.providerTrackId, track: match });
    }));
    subs.push(nativeEngine.onError(({ message }) => {
      if (currentRef.current && !isNativelyStreamable(currentRef.current)) return;
      setError(message || "This track can't be played right now.");
      setIsPlaying(false);
    }));
    // Interruptions (a call starting, another app taking audio focus,
    // headphones unplugged): the native side already paused itself —
    // this just keeps React state in sync so the mini-player doesn't
    // show "playing" over silence. Deliberately does NOT auto-resume on
    // endedShouldResume — see AudioInterruptionEvent's doc comment in
    // native-plugins/audio-engine/src/definitions.ts for why that's left
    // to explicit user action rather than surprising them with audio
    // restarting on its own.
    subs.push(nativeEngine.onAudioInterruption(() => {
      if (currentRef.current && !isNativelyStreamable(currentRef.current)) return;
      setIsPlaying(false);
    }));
    subs.push(nativeEngine.onHeadsetDisconnected(() => {
      if (currentRef.current && !isNativelyStreamable(currentRef.current)) return;
      setIsPlaying(false);
    }));
    return () => { subs.forEach((p) => p.then((h) => h.remove()).catch(() => {})); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Call coordination ─────────────────────────────────────────────────
  // A Daily.co call takes priority over music — pause proactively rather
  // than relying solely on the OS-level interruption notification, since
  // the call and the music player run in the SAME app/process and don't
  // naturally interrupt each other via the cross-app OS mechanism the
  // native plugin's interruption handling is built for. See
  // native-plugins/audio-route's own header comment: a call's
  // AVAudioSession/AudioFocus configuration takes priority and this
  // player must not fight it for the session.
  //
  // AUDIT FIX (2026-08-28): this previously only paused the native engine
  // (Audius) and left YouTube alone, on the reasoning that the hidden
  // YouTube IFrame is "muted by default." It isn't — playerVars never set
  // mute: 1, so a YouTube track playing when a call starts kept playing
  // audibly underneath the call. Both providers now get the identical
  // pause-on-start/conditional-resume-on-end treatment; this effect no
  // longer special-cases which engine is active beyond which API call
  // (nativeEngine vs. playerRef) actually pauses/resumes it.
  //
  // AUDIT FIX (2026-08-24): this previously paused on call-start but
  // deliberately never resumed on call-end, on the reasoning that
  // auto-resuming audio could startle the person. The Music brief is
  // explicit and has now stated the same requirement twice — "resume
  // ONLY if it was playing before the interruption; do not start Music
  // if the user had already paused it" — which is a real, specific
  // behavior, not just "don't auto-resume." Implementing it as written:
  // resume happens only on the call→not-call transition, only for a
  // track that was actually playing (not paused) right before the call,
  // and the flag is cleared unconditionally afterward so a later
  // interruption never resumes based on a stale flag from two calls ago.
  const { callState } = useCall();
  const wasPlayingBeforeCallRef = useRef(false);
  const wasInCallRef = useRef(false);
  useEffect(() => {
    const inCall = callState === "joining" || callState === "joined";

    if (inCall && !wasInCallRef.current) {
      // Call just started.
      if (currentRef.current && isPlayingRef.current) {
        wasPlayingBeforeCallRef.current = true;
        if (isNativelyStreamable(currentRef.current)) {
          nativeEngine.pause().catch(() => {});
        } else {
          try { playerRef.current?.pauseVideo?.(); } catch { /* player not ready */ }
        }
        setIsPlaying(false);
      } else {
        wasPlayingBeforeCallRef.current = false;
      }
    } else if (!inCall && wasInCallRef.current) {
      // Call just ended.
      if (wasPlayingBeforeCallRef.current && currentRef.current) {
        if (isNativelyStreamable(currentRef.current)) {
          nativeEngine.play().catch(() => {});
        } else {
          try { playerRef.current?.playVideo?.(); } catch { /* player not ready */ }
        }
        setIsPlaying(true);
      }
      wasPlayingBeforeCallRef.current = false;
    }

    wasInCallRef.current = inCall;
  }, [callState]);

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
  broadcastRef.current = broadcast;

  // ── Native lock-screen/Bluetooth "next"/"previous" queue lookahead ──────
  // The native engine (ExoPlayer/AVPlayer) only advances through whatever
  // queue was last handed to it via nativeEngine.setQueue() — this
  // context's OWN shuffle/repeat-aware advance logic (queueLogic.ts)
  // never runs inside the native player. Without ever calling setQueue(),
  // the native side only ever has the single currently-loaded track, so a
  // lock-screen/Bluetooth "next" press has nothing real to advance to: on
  // Android that just reports no next item available; on iOS
  // (AudioEnginePlugin.swift's advance()) it's worse — tapping "next"
  // with no real queue set PAUSES playback outright and reports "ended",
  // which is actively broken, not merely inert.
  //
  // Handing the ENTIRE app queue to the native side isn't safe either:
  // most queue entries (audiusProvider.ts's search/trending results)
  // don't carry a resolved streamUrl until they've actually been played,
  // and Audius stream URLs are per-request/short-lived (see
  // resolveAudiusStreamUrl's doc comment and the shared-listening section
  // of docs/MUSIC_NATIVE_PLAYBACK.md) — pre-resolving a long queue up
  // front would both waste requests and hand the native side URLs that
  // may have gone stale by the time a remote command actually reaches
  // deep into it.
  //
  // This resolves and syncs only a small window around whichever track
  // just became current (1 back, 2 ahead) — enough for the realistic
  // lock-screen/Bluetooth use case, resolved right when it'll actually be
  // needed. nativeQueueWindowRef mirrors exactly what was last handed to
  // the native side, so the onTrackChanged handler above has a real,
  // resolved track object to sync `current` to when the native side
  // advances on its own.
  const syncNativeQueue = useCallback(async (around: GroicTrack, queueOverride?: GroicTrack[]) => {
    if (!isNativelyStreamable(around)) return;
    const q = queueOverride ?? queueRef.current;
    const idx = q.findIndex((x) => x.id === around.id);
    if (idx < 0) {
      // Not part of a queue (played standalone) — still worth giving the
      // native side a length-1 "queue" of just this track, so a stray
      // remote next/previous degrades to a harmless restart instead of
      // iOS's pause-and-report-ended path.
      nativeEngine.setQueue([around], 0).catch(() => {});
      nativeQueueWindowRef.current = new Map([[around.id, around]]);
      return;
    }
    const windowTracks = q.slice(Math.max(0, idx - 1), idx + 3);
    const resolvedWindow = await Promise.all(windowTracks.map(async (t) => {
      if (!isNativelyStreamable(t)) return null;
      if (t.id === around.id) return around; // already resolved by the caller (playTrack)
      if (t.streamUrl) return t;
      const offline = await getOfflinePlayableTrack(t.id).catch(() => null);
      const streamUrl = offline?.streamUrl ?? await resolveAudiusStreamUrl(t.providerTrackId).catch(() => null);
      return streamUrl ? { ...t, streamUrl } : null;
    }));
    const playable = resolvedWindow.filter((t): t is GroicTrack => t !== null);
    if (!playable.some((t) => t.id === around.id)) return; // never send a queue missing the track already playing
    nativeEngine.setQueue(playable, playable.findIndex((t) => t.id === around.id)).catch(() => {});
    nativeQueueWindowRef.current = new Map(playable.map((t) => [t.id, t]));
  }, []);

  // Synchronous "what's the real current position right now" — branches
  // by provider, since YouTube's IFrame and the native engine each expose
  // this differently (a direct getCurrentTime() call vs a ref kept fresh
  // by positionChanged events).
  const getPositionSync = useCallback((): number => {
    const t = currentRef.current;
    if (!t) return 0;
    if (isNativelyStreamable(t)) return nativePositionRef.current;
    return playerRef.current?.getCurrentTime?.() || 0;
  }, []);

  const playTrack = useCallback(async (t: GroicTrack, q?: GroicTrack[]) => {
    setError(null);
    if (q) setQueue(q);
    // FIX ("one song should not be suggested again"): single choke point
    // every real play funnels through (search taps, downloads, queue
    // advance/prev) — see playHistory.ts for how this feeds back into
    // future up-next pool building.
    recordPlayed(t.title);

    // FIX (audio engine ownership / provider switching): playTrack had no
    // guard against two engines running at once. currentRef.current here
    // is still the *previous* track — setCurrent below hasn't committed
    // yet, and the ref only syncs from `current` after render — so this
    // is the one correct place to compare old vs new provider before
    // anything else changes. Mirrors the stop logic close() already uses
    // when there's no next track; this is the same rule applied at a
    // provider switch instead of a stop.
    //
    // AUDIT FIX (2026-08-28): the native stop() below used to be fired
    // without awaiting it, so a cross-provider switch (Audius→YouTube or
    // reverse) could start the new engine before the old native engine had
    // actually finished tearing down — a real, if narrow, dual-audio race.
    // Awaited now so the switch is genuinely sequential; playTrack is
    // already async, so this doesn't change its calling contract.
    const prev = currentRef.current;
    if (prev && isNativelyStreamable(prev) !== isNativelyStreamable(t)) {
      if (isNativelyStreamable(prev)) {
        await nativeEngine.stop().catch(() => {});
      } else {
        try { playerRef.current?.stopVideo?.(); } catch { /* player not ready */ }
      }
    }

    if (isNativelyStreamable(t)) {
      // FIX (requirement: "if a track cannot be streamed, gracefully skip
      // it or display it as unavailable"): resolve the stream URL before
      // committing to `current`/`isPlaying` — a track whose URL can't be
      // resolved never becomes "current" as if it were playing; it
      // surfaces as `error` instead, and the mini-player never shows a
      // false playing state for it.
      setCurrent(t);
      setLoading(true);
      // Offline downloads: prefer a locally downloaded copy when one
      // exists — this is what actually makes offline playback work with
      // no connection at all, and it avoids re-streaming data already on
      // the device. Falls through to the normal remote resolution below
      // if there's no local copy or it's gone stale (see
      // getOfflinePlayableTrack's own cleanup for that case).
      const offline = await getOfflinePlayableTrack(t.id).catch(() => null);
      const streamUrl = offline?.streamUrl ?? t.streamUrl ?? await resolveAudiusStreamUrl(t.providerTrackId);
      setLoading(false);
      if (!streamUrl) {
        setError("This track isn't available right now.");
        setIsPlaying(false);
        return;
      }
      const resolved: GroicTrack = { ...t, streamUrl };
      setCurrent(resolved);
      try {
        await nativeEngine.load(resolved, true);
        setIsPlaying(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Playback failed to start.");
        setIsPlaying(false);
        return;
      }
      // Fire-and-forget: gives lock-screen/Bluetooth next/previous a real
      // queue to advance through (see syncNativeQueue's own doc comment
      // above) — never gates actual playback start on this resolving.
      syncNativeQueue(resolved, q ?? queueRef.current).catch(() => {});
      broadcast("load", { provider: resolved.provider, providerTrackId: resolved.providerTrackId, track: resolved });
      return;
    }

    setCurrent(t);
    loadVideo(t.videoId, true);
    setIsPlaying(true);
    broadcast("load", { provider: t.provider, providerTrackId: t.providerTrackId, track: t });
  }, [loadVideo, broadcast, syncNativeQueue]);

  // Picks the next queue index honoring shuffle — see
  // src/lib/music/queueLogic.ts's pickNextIndex/resolveAdvance for the
  // actual (now unit-tested) decision logic; this just wires it to
  // GroicContext's own refs/setters.
  const advanceNext = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;

    const q = queueRef.current;
    const idx = q.findIndex((x) => x.id === cur.id);
    const decision = resolveAdvance(q.length, idx, repeatModeRef.current, shuffleRef.current);

    if (decision.repeatCurrent) {
      if (isNativelyStreamable(cur)) { nativeEngine.seek(0).then(() => nativeEngine.play()).catch(() => {}); }
      else { playerRef.current?.seekTo?.(0, true); playerRef.current?.playVideo?.(); }
      broadcast("seek", { position: 0 });
      return;
    }

    const next = decision.index >= 0 ? q[decision.index] : undefined;
    if (next) {
      playTrack(next, undefined);
    } else {
      setIsPlaying(false);
    }
  }, [broadcast, playTrack]);
  advanceNextRef.current = advanceNext;


  const next = useCallback(() => advanceNext(), [advanceNext]);
  const prev = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    const q = queueRef.current;
    const idx = q.findIndex((x) => x.id === cur.id);
    const p = q[idx - 1];
    if (p) { playTrack(p); return; }
    if (isNativelyStreamable(cur)) nativeEngine.seek(0).catch(() => {});
    else playerRef.current?.seekTo?.(0, true);
  }, [playTrack]);

  const toggle = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    if (isNativelyStreamable(cur)) {
      if (isPlaying) { nativeEngine.pause().catch(() => {}); broadcast("pause", { position: nativePositionRef.current }); }
      else { nativeEngine.play().catch(() => {}); broadcast("play", { position: nativePositionRef.current }); }
      return;
    }
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
    const cur = currentRef.current;
    if (cur && isNativelyStreamable(cur)) nativeEngine.seek(sec).catch(() => {});
    else playerRef.current?.seekTo?.(sec, true);
    setPosition(sec);
    broadcast("seek", { position: sec });
  }, [broadcast]);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    // Volume only applies to the native engine (Audius) — YouTube's own
    // IFrame has its own separate, unrelated volume control this app has
    // never exposed and isn't adding here.
    nativeEngine.setVolume(clamped).catch(() => {});
  }, []);

  const setRepeatMode = useCallback((m: RepeatMode) => setRepeatModeState(m), []);
  const toggleShuffle = useCallback(() => setShuffle((s) => !s), []);

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
      const t = currentRef.current;
      if (!t) return;
      channelRef.current.send({
        type: "broadcast",
        event: "tick",
        payload: {
          provider: t.provider,
          providerTrackId: t.providerTrackId,
          videoId: t.videoId,
          position: getPositionSync(),
          isPlaying,
          ts: Date.now(),
        },
      });
    }, TICK_MS);
    tickTimer.current = id;
    return () => clearInterval(id);
  }, [sessionRole, isPlaying, getPositionSync]);

  // ── Guest: handle inbound events ─────────────────────────────────────────
  // STALE-CLOSURE FIX (preserved from before this refactor): the realtime
  // handlers are bound once, inside subscribeChannel(), when the guest
  // joins. Anything this callback reads from render scope is frozen at
  // that moment — all live reads go through refs so this callback stays
  // genuinely stable and always sees current values.
  const onGuestEvent = useCallback(async (event: string, payload: any) => {
    const cur = currentRef.current;
    const provider: MusicProvider = payload.provider === "audius" ? "audius" : "youtube";

    // A guest resolves the SAME provider track itself rather than trusting
    // a stream URL the host resolved — Audius stream URLs are per-request,
    // and this also means a guest without access to a given track (a
    // regional restriction, a track since taken down) fails gracefully
    // for THEM specifically instead of silently reusing a URL that
    // happened to work for the host a moment ago.
    const resolveGuestTrack = async (): Promise<GroicTrack | null> => {
      if (provider === "youtube") {
        const videoId = payload.videoId || payload.providerTrackId;
        if (!videoId) return null;
        return payload.track ?? {
          id: makeTrackId("youtube", videoId), provider: "youtube", providerTrackId: videoId,
          videoId, title: cur?.title ?? "", artist: "", thumbnail: null, duration: 0,
        };
      }
      const providerTrackId = payload.providerTrackId;
      if (!providerTrackId) return null;
      const streamUrl = await resolveAudiusStreamUrl(providerTrackId);
      if (!streamUrl) return null;
      const base: GroicTrack = payload.track ?? {
        id: makeTrackId("audius", providerTrackId), provider: "audius", providerTrackId,
        videoId: providerTrackId, title: "", artist: "", thumbnail: null, duration: 0,
      };
      return { ...base, streamUrl };
    };

    if (event === "load") {
      const track = await resolveGuestTrack();
      if (!track) { setError("Couldn't join this track — it may be unavailable."); return; }
      // FIX (same audio-engine-ownership gap as playTrack): a guest
      // switching providers mid-session — host goes YouTube → Audius or
      // back — needs the previous engine stopped before the new one
      // starts, exactly like playTrack now does for the local case.
      if (cur && isNativelyStreamable(cur) !== isNativelyStreamable(track)) {
        if (isNativelyStreamable(cur)) {
          nativeEngine.stop().catch(() => {});
        } else {
          try { playerRef.current?.stopVideo?.(); } catch { /* player not ready */ }
        }
      }
      setCurrent(track);
      if (track.provider === "audius") {
        try { await nativeEngine.load(track, true); setIsPlaying(true); }
        catch { setError("Couldn't play this track."); setIsPlaying(false); }
      } else {
        loadVideo(track.videoId, true);
        setIsPlaying(true);
      }
      return;
    }

    if (event === "play") {
      if (cur && isNativelyStreamable(cur)) { nativeEngine.play().catch(() => {}); }
      else { playerRef.current?.playVideo?.(); }
      setIsPlaying(true);
      return;
    }
    if (event === "pause") {
      if (cur && isNativelyStreamable(cur)) { nativeEngine.pause().catch(() => {}); }
      else { playerRef.current?.pauseVideo?.(); }
      setIsPlaying(false);
      return;
    }
    if (event === "seek") {
      if (cur && isNativelyStreamable(cur)) { nativeEngine.seek(payload.position || 0).catch(() => {}); }
      else { playerRef.current?.seekTo?.(payload.position, true); }
      return;
    }
    if (event === "tick") {
      const trackIdChanged = provider === "youtube"
        ? payload.videoId && cur?.videoId !== payload.videoId
        : payload.providerTrackId && cur?.providerTrackId !== payload.providerTrackId;

      // Self-healing: broadcasts are fire-and-forget, so a guest can miss
      // the "load" for a track change (backgrounded tab, dropped frame on
      // a flaky mobile connection). If the tick's track doesn't match
      // what we're playing, resync the track itself instead of
      // drift-correcting against the wrong song forever.
      if (trackIdChanged) {
        const track = await resolveGuestTrack();
        if (!track) return;
        setCurrent(track);
        if (track.provider === "audius") { try { await nativeEngine.load(track, true); } catch { return; } }
        else { loadVideo(track.videoId, true); }
        setIsPlaying(true);
        return;
      }

      const isNative = cur ? isNativelyStreamable(cur) : false;
      const localPos = isNative ? nativePositionRef.current : (playerRef.current?.getCurrentTime?.() || 0);
      // See src/lib/music/driftCorrection.ts for the (now unit-tested)
      // expectedPosition/drift/action math this wires up to the actual
      // player calls.
      const { action, expectedPosition } = computeDrift(
        payload.position || 0, payload.ts || Date.now(), Date.now(), localPos,
        /* supportsRateNudge */ !isNative,
      );

      if (isNative) {
        if (action === "seek") nativeEngine.seek(expectedPosition).catch(() => {});
      } else if (action === "seek") {
        playerRef.current?.seekTo?.(expectedPosition, true);
        try { playerRef.current?.setPlaybackRate?.(1); } catch { /* noop */ }
      } else if (action === "nudge-fast") {
        try { playerRef.current?.setPlaybackRate?.(1.05); } catch { /* noop */ }
      } else if (action === "nudge-slow") {
        try { playerRef.current?.setPlaybackRate?.(0.95); } catch { /* noop */ }
      } else {
        try { playerRef.current?.setPlaybackRate?.(1); } catch { /* noop */ }
      }

      const playing = isPlayingRef.current;
      if (payload.isPlaying && !playing) {
        if (isNative) nativeEngine.play().catch(() => {}); else playerRef.current?.playVideo?.();
        setIsPlaying(true);
      }
      if (!payload.isPlaying && playing) {
        if (isNative) nativeEngine.pause().catch(() => {}); else playerRef.current?.pauseVideo?.();
        setIsPlaying(false);
      }
    }
  }, [loadVideo]);


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
      .on("broadcast", { event: "join" },  ({ payload }) => {
        setPartnerListening(true);
        // Instant-connect: a guest that just joined shouldn't wait up to
        // TICK_MS for the next scheduled heartbeat to hear what's playing.
        if (role === "host" && payload?.role === "guest") {
          const track = currentRef.current;
          if (track) {
            ch.send({ type: "broadcast", event: "load", payload: { provider: track.provider, providerTrackId: track.providerTrackId, videoId: track.videoId, track, ts: Date.now() } });
            ch.send({ type: "broadcast", event: "tick", payload: { provider: track.provider, providerTrackId: track.providerTrackId, videoId: track.videoId, position: getPositionSync(), isPlaying: isPlayingRef.current, ts: Date.now() } });
          }
        }
      })
      .on("broadcast", { event: "leave" }, () => setPartnerListening(false))
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          ch.send({ type: "broadcast", event: "join", payload: { role } });
        }
      });
    channelRef.current = ch;
  }, [channelName, onGuestEvent, getPositionSync]);

  // Host: re-announce presence periodically, not just once on subscribe.
  // Realtime broadcasts are fire-and-forget with no replay — a partner who
  // opens/reloads Groic after the one-shot "join" already went out would
  // otherwise never learn a session is active. This heartbeat is what lets
  // a late-joining partner still sync up within a few seconds.
  useEffect(() => {
    if (sessionRole !== "host" || !channelRef.current) return;
    const id = window.setInterval(() => {
      try {
        channelRef.current?.send({ type: "broadcast", event: "join", payload: { role: "host" } });
      } catch { /* channel may be mid-teardown */ }
    }, 4000);
    return () => clearInterval(id);
  }, [sessionRole]);

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
    setPartnerInviteActive(false);
  }, []);

  // Auto-listen for incoming sessions: surface an invite rather than
  // silently auto-joining, so the partner gets a "tap to join" prompt.
  useEffect(() => {
    if (!user || !partnerId || !channelName) return;
    if (sessionRole !== "solo") return;
    let dismissed = false;
    const announceInvite = () => {
      if (dismissed) return;
      setPartnerInviteActive(true);
    };
    const probe = supabase.channel(channelName, { config: { broadcast: { self: false } } })
      .on("broadcast", { event: "join" }, ({ payload }) => {
        if (payload?.role === "host") announceInvite();
      })
      // A host is the only role that ever sends these — either one arriving
      // is proof a session is live, even if we missed the "join" heartbeat.
      .on("broadcast", { event: "tick" }, () => announceInvite())
      .on("broadcast", { event: "load" }, () => announceInvite())
      .subscribe();
    probeRef.current = probe;
    return () => {
      dismissed = true;
      supabase.removeChannel(probe);
      if (probeRef.current === probe) probeRef.current = null;
    };
  }, [user, partnerId, channelName, sessionRole]);

  const joinPartnerSession = useCallback(() => {
    if (probeRef.current) {
      supabase.removeChannel(probeRef.current);
      probeRef.current = null;
    }
    setPartnerInviteActive(false);
    setSessionRole("guest");
    subscribeChannel("guest");
  }, [subscribeChannel]);

  const dismissPartnerInvite = useCallback(() => setPartnerInviteActive(false), []);

  // FIX (preserved from before this refactor): neither GroicMiniPlayer nor
  // GroicFullPlayer exposed any way to actually stop playback and dismiss
  // the player. Now also stops the native engine, not just the YouTube
  // IFrame, whichever was actually active.
  const close = useCallback(() => {
    const cur = currentRef.current;
    if (cur && isNativelyStreamable(cur)) { nativeEngine.stop().catch(() => {}); }
    else { try { playerRef.current?.stopVideo?.(); } catch { /* player not ready */ } }
    if (sessionRole !== "solo" && channelRef.current) {
      try { channelRef.current.send({ type: "broadcast", event: "leave", payload: {} }); } catch { /* noop */ }
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    }
    setSessionRole("solo");
    setPartnerListening(false);
    setPartnerInviteActive(false);
    setIsPlaying(false);
    setCurrent(null);
    setQueue([]);
    setPosition(0);
    setDuration(0);
    setBuffering(false);
    setError(null);
    setExpanded(false);
    setHidden(false);
  }, [sessionRole]);

  const hide = useCallback(() => setHidden(true), []);
  const show = useCallback(() => setHidden(false), []);

  const value: GroicAPI = {
    current, queue, isPlaying, position, duration, buffering, volume,
    repeatMode, shuffle, loading, error, expanded, hidden,
    sessionRole, partnerListening, partnerInviteActive,
    playTrack, toggle, next, prev, seek, setVolume, setRepeatMode, toggleShuffle,
    enqueue, removeFromQueue, clearQueue,
    expand: setExpanded, hide, show, close,
    startSession, endSession,
    joinPartnerSession, dismissPartnerInvite,
  };

  return <GroicContext.Provider value={value}>{children}</GroicContext.Provider>;
};

export { extractYouTubeId };
