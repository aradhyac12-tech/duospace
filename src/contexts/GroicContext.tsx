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
 *  the call engine call becomes active, and resumes it when the call ends only
 *  if that track was actually playing right before the call started — the
 *  existing audio-route plugin's own doc comment already establishes that
 *  a call's AVAudioSession/AudioFocus configuration takes priority over
 *  the music player's; see the `useCall()` effect below.
 */

import {
  createContext, useContext, useEffect, useRef, useState, useCallback,
  ReactNode, useMemo,
} from "react";
import { Capacitor } from "@capacitor/core";
import { supabase } from "@/integrations/supabase/appClient";
import { useAuth } from "@/hooks/useAuth";
import { useCall } from "@/contexts/CallContext";
import { loadYouTubeAPI, extractYouTubeId } from "@/lib/youtubeApi";
import { GroicTrack, RepeatMode, MusicProvider, isNativelyStreamable, makeTrackId } from "@/lib/music/types";
import { resolveAudiusStreamUrl } from "@/lib/music/audiusProvider";
import { resolveSoundCloudStreamUrl, resolveSoundCloudStreamUrls } from "@/lib/music/soundcloudProvider";
import { resolveJamendoStreamUrl } from "@/lib/music/jamendoProvider";
import { resolveLocalStreamUrl } from "@/lib/music/localLibrary";
import { createStreamResolver, isGenuinePause } from "@/lib/music/streamResolver";

// A ~0.25s, 8kHz mono 8-bit PCM WAV of literal digital silence (every
// sample = 128, the zero-point for unsigned 8-bit PCM) — generated once,
// inlined so no extra network asset/build step is needed. See the
// silentAnchorRef comment above for why this exists.
const SILENT_AUDIO_DATA_URI = "data:audio/wav;base64,UklGRvQHAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YdAHAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

// Single dispatch point for "resolve this natively-streamable track's
// playable URL" — added when SoundCloud joined Audius as a second
// natively-streamable provider, so every call site below branches once,
// here, instead of each guessing which resolver function to call. Never
// throws — matches resolveAudiusStreamUrl/resolveSoundCloudStreamUrl's own
// "return null, don't throw" contract, since every caller already treats
// a null as "skip/mark unavailable" rather than a hard error.
// Shared stream-URL resolver: short-lived cache + in-flight de-duplication +
// batched prefetch (see lib/music/streamResolver.ts for the why). SoundCloud
// has a batch endpoint (one request / one rate-limit unit for several tracks);
// Audius resolves per track.
const streamResolver = createStreamResolver<MusicProvider>({
  resolveOne: (provider, id, opts) =>
    provider === "soundcloud" ? resolveSoundCloudStreamUrl(id, opts)
    : provider === "jamendo" ? resolveJamendoStreamUrl(id)
    : provider === "local" ? resolveLocalStreamUrl(id)
    : resolveAudiusStreamUrl(id),
  resolveBatch: (provider, ids) => (provider === "soundcloud" ? resolveSoundCloudStreamUrls(ids) : null),
  ttlMs: 4 * 60_000, // below the server cache TTL; signed CDN URLs are short-lived
});
const resolveNativeStreamUrl = (provider: MusicProvider, providerTrackId: string, opts?: { fresh?: boolean }): Promise<string | null> =>
  streamResolver.resolve(provider, providerTrackId, opts);
const getCachedStreamUrl = (provider: MusicProvider, providerTrackId: string): string | null =>
  streamResolver.peek(provider, providerTrackId);

// SPEED: resolve the stream URLs of the songs currently on screen (top of a
// rail / search results) BEFORE the user taps one, so the tap starts playback
// without waiting on the network. SoundCloud only — it has a batch endpoint, so
// this is ONE request / ONE rate-limit unit for up to 4 songs; already-cached
// and in-flight ids are skipped by the resolver. Never throws, fire-and-forget.
let lastWarmKey = "";
let lastWarmAt = 0;
const warmStreams = (tracks: GroicTrack[]): void => {
  const targets = tracks
    .filter((t) => t.provider === "soundcloud" && t.isStreamable !== false && !t.streamUrl && !streamResolver.peek(t.provider, t.providerTrackId))
    .slice(0, 4)
    .map((t) => ({ provider: t.provider, id: t.providerTrackId }));
  if (targets.length === 0) return;
  const key = targets.map((x) => x.id).join(",");
  const now = Date.now();
  if (key === lastWarmKey && now - lastWarmAt < 60_000) return; // same set a moment ago
  lastWarmKey = key; lastWarmAt = now;
  void streamResolver.prefetch(targets).catch(() => {});
};
import { getOfflinePlayableTrack, isDownloaded as isTrackDownloadedSync } from "@/lib/music/offlineDownloads";
import { startupTracer } from "@/lib/music/startupTrace";
import { createStallDetector, withTimeout } from "@/lib/music/stallWatchdog";
import { nativeEngine } from "@/lib/music/nativeAudioEngine";
import { createIssueDeduper } from "@/lib/music/notificationIssue";
import { showNotificationIssueToast } from "@/lib/music/notificationIssueToast";
import { logInfo, logWarn } from "@/lib/telemetry";
import { resolveAdvanceWithBag, tracksAhead, insertAfterCurrent, pickNativeWindow } from "@/lib/music/queueLogic";
import { fetchAutoNext } from "@/lib/music/autoNext";
import { computeDrift, estimateClockOffset, pickBestOffset, type OffsetSample } from "@/lib/music/driftCorrection";
import { toast } from "sonner";
import { recordPlayed, recordSkipped, recordCompleted } from "@/lib/music/playHistory";
import { recordRecentTrack } from "@/lib/music/libraryStore";
import { startMusicProfileSync, endMusicProfileSession } from "@/lib/music/musicProfileSync";
import { findNativeTwin, buildTwinQuery } from "@/lib/music/nativeTwin";
import storage from "@/lib/storage";

export type { GroicTrack };

type Role = "solo" | "host" | "guest";

interface GroicState {
  current: GroicTrack | null;
  queue: GroicTrack[];
  isPlaying: boolean;
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
  play: () => void;
  pause: () => void;
  next: () => void;
  prev: () => void;
  seek: (sec: number) => void;
  setVolume: (v: number) => void;
  setRepeatMode: (m: RepeatMode) => void;
  toggleShuffle: () => void;
  /** When on (default), the queue is topped up with suggestions derived from
   *  what you play, and playback continues past the end of the queue. */
  autoNext: boolean;
  toggleAutoNext: () => void;
  enqueue: (t: GroicTrack) => void;
  /** Insert right after the current track (Apple Music "Play Next"). */
  playNext: (t: GroicTrack) => void;
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
  /** Pre-resolve stream URLs for songs on screen so tapping one starts instantly. */
  warmStreams: (tracks: GroicTrack[]) => void;
}

const GroicContext = createContext<GroicAPI | null>(null);

/**
 * PERF: playback position/duration used to live inside GroicContext's main value,
 * and position ticks twice a second while a track plays. Every consumer of
 * useGroic() — the always-mounted mini-player, the invite banner, the 37KB full
 * player, the Gallery page — therefore re-rendered 2x/second for as long as music
 * was playing, though only the seek bar reads the numbers. They now live in their
 * own context: useGroic() is stable across ticks, and only components that call
 * useGroicProgress() (the seek bar) update with playback.
 */
export interface GroicProgress {
  position: number; // seconds
  duration: number; // seconds
}
const GroicProgressContext = createContext<GroicProgress>({ position: 0, duration: 0 });

export const useGroicProgress = (): GroicProgress => useContext(GroicProgressContext);

export const useGroic = (): GroicAPI => {
  const ctx = useContext(GroicContext);
  if (!ctx) throw new Error("useGroic must be used within GroicProvider");
  return ctx;
};

// Faster heartbeat = faster self-correction (was 1500).
const TICK_MS = 1000;
// After THIS device sends a control (play/pause/seek/load/next), ignore the
// partner's heartbeat state for a moment: the heartbeat in flight was sent
// before our command reached them and would otherwise instantly undo it.
const CONTROL_GRACE_MS = 2500;

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
  const [autoNext, setAutoNextState] = useState<boolean>(() => {
    try { return localStorage.getItem("groic-auto-next") !== "0"; } catch { return true; }
  });
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
  // FIX (this session — "notification doesn't come, Bluetooth pause desyncs
  // the icon, no way to resume/skip"): a YouTube track's actual audio lives
  // inside a cross-origin <iframe> (youtube.com/embed/...), not our own
  // document. Chromium attributes a tab's *single* active Media Session to
  // whichever frame currently owns the playing HTMLMediaElement — and
  // that's the iframe, not us, even though we call
  // navigator.mediaSession.metadata/setActionHandler on our OWN top-level
  // document. In practice this means: our mediaSession registration below
  // can lose the "who does the OS notification/Bluetooth key belong to"
  // contest to YouTube's own embedded player, which is why no DuoSpace
  // notification appeared, and why a hardware pause command could reach
  // the actual video (so the audio really did pause) without ever calling
  // OUR pause()/setActionHandler("pause", ...) — so our `isPlaying` state
  // never moved, the icon looked wrong, and tapping it then called our
  // (now out-of-sync) toggle() the wrong direction.
  //
  // Fix: hold Media Session ownership in OUR OWN top-level document by
  // always having a real (inaudible — literal digital silence, not just a
  // muted element, since a muted element doesn't count as "producing
  // audio" for this purpose either) HTMLAudioElement of our own actively
  // playing whenever a YouTube track is the current one and isPlaying.
  // This is the same "silent keep-alive audio" pattern other sites use
  // when they need Media Session control over audio actually produced by
  // an embed they don't own. It changes nothing about what the user hears
  // (true silence) and never touches YouTube's real audio path.
  const silentAnchorRef = useRef<HTMLAudioElement | null>(null);
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
  const autoNextRef   = useRef(true);
  const sessionRoleRef = useRef<Role>("solo");
  const lastLocalControlRef = useRef(0);
  const offsetKnownRef = useRef(false);
  const partnerSeenRef = useRef(0);
  const partnerOnlineRef = useRef(false);
  const lastSeekRef = useRef(0);
  const lastResubRef = useRef(0);
  // Estimated (host clock - my clock) in ms. Phones' clocks routinely differ
  // by seconds, which made the old `now - hostTs` "network lag" garbage.
  const clockOffsetRef = useRef(0);
  const offsetSamplesRef = useRef<OffsetSample[]>([]);
  const nextRef = useRef<() => void>(() => {});
  const subscribeChannelRef = useRef<(role: Role) => void>(() => {});
  const prevRef = useRef<() => void>(() => {});
  // Shuffle "bag": ids already played in the current shuffle cycle, so
  // shuffle walks the whole queue before anything repeats (see queueLogic's
  // resolveAdvanceWithBag). `historyRef` is the listening trail shuffle's
  // "previous" walks back through (a random order has no "index - 1").
  const playedIdsRef  = useRef<Set<string>>(new Set());
  const historyRef    = useRef<string[]>([]);
  const skipHistoryRef = useRef(false);
  const autoNextPromiseRef = useRef<Promise<GroicTrack[]> | null>(null);
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
  // The one shuffle pick last handed to the native window (see pickNativeWindow).
  const shuffleNextIdRef = useRef<string | null>(null);
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
  useEffect(() => { autoNextRef.current = autoNext; }, [autoNext]);
  useEffect(() => { sessionRoleRef.current = sessionRole; }, [sessionRole]);
  useEffect(() => { queueRef.current = queue; }, [queue]);
  const positionRef = useRef(0);
  // Timestamp of the last user/remote seek. Position ticks that arrive for a
  // moment afterwards still carry the PRE-seek time (YouTube's getCurrentTime and
  // ExoPlayer's 1s tick lag the seek) and made the thumb jump back then forward.
  const lastSeekAtRef = useRef(0);
  const SEEK_HOLD_MS = 700;
  useEffect(() => { positionRef.current = position; }, [position]);
  const playTrackRef = useRef<((t: GroicTrack, q?: GroicTrack[]) => Promise<void> | void) | null>(null);
  const seekRef = useRef<((sec: number) => void) | null>(null);
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

  // ── Per-account taste profile ───────────────────────────────────────────
  // Suggestions/taste follow the signed-in ACCOUNT, not the phone: scope the
  // local profile to the user and mirror it to Supabase (musicProfileSync.ts).
  // On sign-out the scope drops back to anonymous so the next account never
  // sees this one's history.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (userId) void startMusicProfileSync(userId);
    else endMusicProfileSession();
    return () => { /* sync is torn down by the next start/end call */ };
  }, [userId]);

  // Consecutive tracks that failed to start/play. Auto-skipping a dead track
  // used to be missing entirely (a bad stream or an embed-disabled YouTube
  // video left the player "stuck" on it); capped so a dead network can't
  // make the queue spin through every song.
  const failedInARowRef = useRef(0);
  /** true while a stream URL is being resolved — the native stall watchdog must not judge that window. */
  const resolvingRef = useRef(false);
  const skipBrokenRef = useRef<(why: string) => void>(() => {});
  const pausedCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track id we already retried once with a freshly resolved stream URL.
  const retriedTrackIdRef = useRef<string | null>(null);
  const retryCurrentRef = useRef<() => boolean>(() => false);

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
            if (e.data === 1) { failedInARowRef.current = 0; isPlayingRef.current = true; setIsPlaying(true); setBuffering(false); }
            // FIX (play/pause button stuck on a spinner): `buffering` was only ever
            // cleared by state 1. Pausing (2) or cueing (5) while YouTube was
            // buffering left it true forever, and the buttons ignored taps while
            // "busy" — so the player looked frozen and could not be resumed.
            if (e.data === 2) { isPlayingRef.current = false; setIsPlaying(false); setBuffering(false); }
            if (e.data === 5) setBuffering(false);
            if (e.data === 3) setBuffering(true);
            if (e.data === 0) {
              const c = currentRef.current;
              if (c) recordCompleted(c.title);
              advanceNextRef.current();
            }
          },
          // 2 bad id · 5 HTML5 error · 100 removed/private · 101/150 embedding
          // disabled by the owner. None of these ever fire state 0, so the
          // queue used to freeze on the dead video.
          onError: (e: any) => {
            if (currentRef.current?.provider !== "youtube") return;
            skipBrokenRef.current(`youtube error ${e?.data}`);
          },
        },
      });
    });

    // Position polling — YouTube IFrame only; the native engine reports
    // its own position via positionChanged events (see the effect below),
    // not polling, since ExoPlayer/AVPlayer already push updates.
    //
    // FIX (isPlaying reconciliation): this poll now also re-reads the
    // player's own getPlayerState() and corrects `isPlaying` if it's out of
    // sync. onStateChange (above) is normally sufficient on its own, but
    // it depends on YouTube's embedded player noticing and re-broadcasting
    // an external pause/play — a step this app doesn't control. If that
    // ever doesn't happen (an external Bluetooth/OS-level pause that
    // reaches the underlying player without going through YouTube's own
    // postMessage bridge is exactly the scenario reported), `isPlaying`
    // would otherwise stay wrong indefinitely — showing the wrong icon and
    // making the in-app button call the wrong one of play()/pause() (a
    // stale "playing" reads as "tap to pause", which is a no-op on an
    // already-paused video, i.e. exactly "no way to resume"). Polling every
    // 500ms here is a correction safety net, not the primary mechanism —
    // it's a re-use of a timer that already exists, not a new one.
    const positionPoll = window.setInterval(() => {
      if (currentRef.current?.provider !== "youtube") return;
      const p = playerRef.current;
      if (!p?.getCurrentTime) return;
      try {
        if (Date.now() - lastSeekAtRef.current > SEEK_HOLD_MS) setPosition(p.getCurrentTime() || 0);
        const d = p.getDuration?.() || 0;
        if (d) setDuration(d);
        const state = p.getPlayerState?.();
        if (state === 1 && !isPlayingRef.current) { isPlayingRef.current = true; setIsPlaying(true); }
        if (state === 2 && isPlayingRef.current) { isPlayingRef.current = false; setIsPlaying(false); }
        if (state === 1 || state === 2 || state === 5) setBuffering((b) => (b ? false : b));
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

  // ── Silent Media Session anchor (see silentAnchorRef comment above) ─────
  // Created once; its play/pause state is driven below by whichever of
  // (current track is YouTube) AND (isPlaying) is true — i.e. it mirrors
  // exactly when a YouTube track is actually audible, never longer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const el = new Audio(SILENT_AUDIO_DATA_URI);
    el.loop = true;
    el.volume = 1; // literal silence in the samples themselves — this is not a "quiet" hack, the audio data is inaudible regardless of volume
    // `muted` deliberately left false: a muted element does not count as
    // "producing audio" for Media Session/tab-audio-focus attribution in
    // Chromium, which defeats the entire point of this element.
    silentAnchorRef.current = el;
    return () => { try { el.pause(); } catch { /* noop */ } silentAnchorRef.current = null; };
  }, []);

  useEffect(() => {
    const el = silentAnchorRef.current;
    if (!el) return;
    const shouldPlay = isPlaying && current?.provider === "youtube";
    if (shouldPlay && el.paused) {
      el.play().catch(() => { /* blocked by autoplay policy — will retry on the next state change, which normally follows a user gesture (tapping play) anyway */ });
    } else if (!shouldPlay && !el.paused) {
      el.pause();
    }
  }, [isPlaying, current?.provider]);

  // ── Reattach to background playback after the app was closed ───────────
  // FIX ("music keeps playing after I close the app, but when I reopen it
  // I can't see or control what's playing"): the native MediaPlaybackService
  // (and its now-playing notification) outlives the WebView, but a reopened
  // app started with an empty `current`/`queue` and never asked the engine
  // what it was doing — so the mini-player was gone and nothing could be
  // paused/skipped from inside the app. Now the current track + queue are
  // snapshotted to storage, and on startup the engine's real state is read
  // back and the player UI is restored to match it.
  const SNAPSHOT_KEY = "groic-now-playing-snapshot";
  useEffect(() => {
    if (!current) return;
    const t = setTimeout(() => {
      try {
        const q = queue.length > 200 ? queue.slice(0, 200) : queue;
        storage.set(SNAPSHOT_KEY, JSON.stringify({ current, queue: q, savedAt: Date.now() }));
      } catch { /* quota — best effort */ }
    }, 400);
    return () => clearTimeout(t);
  }, [current, queue]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    const reattach = async () => {
      try {
        const st = await nativeEngine.getState();
        if (cancelled || !st?.currentTrackId) return;
        if (st.state !== "playing" && st.state !== "paused" && st.state !== "loading") return;
        if (currentRef.current?.id === st.currentTrackId) {
          // Warm resume: just resync play state/position.
          setIsPlaying(st.state === "playing");
          setPosition(st.positionSeconds || 0);
          return;
        }
        const raw = storage.get(SNAPSHOT_KEY);
        if (!raw) return;
        const snap = JSON.parse(raw) as { current: GroicTrack; queue: GroicTrack[] };
        const all = [snap.current, ...(snap.queue || [])].filter(Boolean);
        const track = all.find(t => t.id === st.currentTrackId);
        if (!track) return;
        all.forEach(t => nativeQueueWindowRef.current.set(t.id, t));
        currentRef.current = track;
        setQueue(snap.queue?.length ? snap.queue : [track]);
        setCurrent(track);
        setIsPlaying(st.state === "playing");
        setBuffering(st.state === "loading");
        setPosition(st.positionSeconds || 0);
        setDuration(st.durationSeconds || track.duration || 0);
        setHidden(false);
        logInfo("music.reattach", "restored player UI from background playback", { trackId: track.id });
      } catch (e) {
        logWarn("music.reattach", "could not read native engine state", { error: String(e) });
      }
    };
    void reattach();
    // Also on every return to the foreground (notification tap, recents).
    const onVis = () => { if (!document.hidden) void reattach(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVis); };
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
      if (state === "playing") {
        failedInARowRef.current = 0; setError(null);
        if (currentRef.current) startupTracer.audible(currentRef.current.id);
      }
      // FIX (play/pause/play flicker): the native player reports "paused" whenever
      // ExoPlayer's isPlaying is false — which is ALSO true while it is merely
      // buffering (every track change, every HLS rebuffer). Believing it flipped
      // the icon to "paused" and back. Now a "paused" event is only trusted after
      // the engine's real state is re-read (250 ms later, cancelled by any
      // playing/loading event). A genuine pause still updates within ~250 ms.
      if (pausedCheckTimerRef.current) { clearTimeout(pausedCheckTimerRef.current); pausedCheckTimerRef.current = null; }
      if (state === "playing") { retriedTrackIdRef.current = null; setIsPlaying(true); }
      else if (state === "ended") setIsPlaying(false);
      else if (state === "paused") {
        pausedCheckTimerRef.current = setTimeout(async () => {
          pausedCheckTimerRef.current = null;
          let st: { state?: string } | null = null;
          try { st = await nativeEngine.getState(); } catch { st = null; }
          if (isGenuinePause(st)) setIsPlaying(false);
        }, 250);
      }
      setBuffering(state === "loading");
    }));
    subs.push(nativeEngine.onPositionChanged(({ positionSeconds, durationSeconds }) => {
      nativePositionRef.current = positionSeconds;
      if (durationSeconds) nativeDurationRef.current = durationSeconds;
      if (currentRef.current && !isNativelyStreamable(currentRef.current)) return;
      if (Date.now() - lastSeekAtRef.current > SEEK_HOLD_MS) setPosition(positionSeconds);
      if (durationSeconds) setDuration(durationSeconds);
    }));
    subs.push(nativeEngine.onPlaybackEnded(() => {
      if (currentRef.current && !isNativelyStreamable(currentRef.current)) return;
      if (currentRef.current) recordCompleted(currentRef.current.title);
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
      // Same bookkeeping playTrack does, so shuffle/"previous"/taste stay in step.
      if (currentRef.current) historyRef.current.push(currentRef.current.id);
      playedIdsRef.current.add(match.id);
      recordPlayed(match.title, match.artist);
      recordRecentTrack(match);
      setCurrent(match);
      setPosition(0);
      setDuration(match.duration || 0);
      setIsPlaying(true);
      broadcastRef.current("load", { provider: match.provider, providerTrackId: match.providerTrackId, track: match });
    }));
    subs.push(nativeEngine.onError(({ message }) => {
      if (currentRef.current && !isNativelyStreamable(currentRef.current)) return;
      // A signed stream URL can expire or a CDN hiccup can fail a request: retry the
      // SAME track once with a freshly resolved URL before giving up and skipping.
      if (retryCurrentRef.current()) return;
      setError(message || "This track can't be played right now.");
      setIsPlaying(false);
      // A dead/expired stream used to leave the player stuck on this track.
      skipBrokenRef.current(`native error: ${message}`);
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
    // Android told us the OS isn't showing the "Now playing" notification.
    // Deliberately NOT gated on isNativelyStreamable (YouTube tracks use the
    // same notification) and deliberately does not touch player state — a
    // missing notification is not a playback error.
    const shouldShowNotificationIssue = createIssueDeduper();
    subs.push(nativeEngine.onNotificationIssue(({ reason }) => {
      logWarn("music.notification", "notificationIssue from native", { reason });
      if (!shouldShowNotificationIssue(reason)) return;
      showNotificationIssueToast(reason, nativeEngine.openNotificationSettings);
    }));
    // DIAGNOSTIC: the confirmation counterpart. If a track is playing and
    // NEITHER this nor a notificationIssue warning above ever logs, native
    // playback (postNotificationInternal) is never being reached at all —
    // point the investigation at AudioEnginePlugin's service binding
    // instead of at the notification-building code.
    subs.push(nativeEngine.onNotificationVisible(() => {
      logInfo("music.notification", "OS confirmed the now-playing notification is visible");
    }));
    return () => { subs.forEach((p) => p.then((h) => h.remove()).catch(() => {})); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Call coordination ─────────────────────────────────────────────────
  // A the call engine call takes priority over music — pause proactively rather
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
    // Both partners can drive playback now (was host-only, which is why the
    // connected partner's pause/resume did nothing for the other side).
    if (sessionRoleRef.current === "solo" || !channelRef.current) return;
    if (event !== "tick") lastLocalControlRef.current = Date.now();
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
    // Window follows the app's own shuffle/repeat decision (queueLogic.ts →
    // pickNativeWindow); a plain slice here made the native player play a
    // different "next" than the queue showed whenever shuffle/repeat was on.
    const picked = pickNativeWindow({
      queue: q, currentId: around.id, shuffle: shuffleRef.current, repeatMode: repeatModeRef.current,
      played: playedIdsRef.current, shuffleNextId: shuffleNextIdRef.current,
    });
    shuffleNextIdRef.current = picked.shuffleNextId;
    const windowTracks = picked.window;
    // One batched resolution for the whole window (cache hits are skipped) so the
    // per-track lookups below are instant instead of a burst of separate requests.
    await streamResolver.prefetch(windowTracks
      .filter((t) => isNativelyStreamable(t) && t.id !== around.id && !t.streamUrl)
      .map((t) => ({ provider: t.provider, id: t.providerTrackId })));
    const resolvedWindow = await Promise.all(windowTracks.map(async (t) => {
      if (!isNativelyStreamable(t)) return null;
      if (t.id === around.id) return around; // already resolved by the caller (playTrack)
      if (t.streamUrl) return t;
      const offline = await getOfflinePlayableTrack(t.id).catch(() => null);
      const streamUrl = offline?.streamUrl ?? await resolveNativeStreamUrl(t.provider, t.providerTrackId).catch(() => null);
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

  // Warm the stream URL of the next and previous tracks so a tap on
  // next/previous starts instantly instead of waiting on the network.
  const prefetchNeighborsRef = useRef<(around: GroicTrack) => void>(() => {});
  prefetchNeighborsRef.current = (around: GroicTrack) => {
    const q = queueRef.current;
    const idx = q.findIndex((x) => x.id === around.id);
    if (idx < 0) return;
    const targets = [q[idx + 1], q[idx + 2], q[idx - 1]].filter(
      (x): x is GroicTrack => !!x && isNativelyStreamable(x) && !x.streamUrl,
    );
    // One batched request for SoundCloud instead of a burst of single ones.
    void streamResolver.prefetch(targets.map((x) => ({ provider: x.provider, id: x.providerTrackId })));
  };
  const playRequestRef = useRef(0);
  const playTrack = useCallback(async (t: GroicTrack, q?: GroicTrack[], opts?: { fresh?: boolean }) => {
    const myRequest = ++playRequestRef.current;
    startupTracer.begin(t.id, t.provider);
    setError(null);
    if (q) {
      setQueue(q);
      queueRef.current = q;
      // A fresh queue (the user tapped a song) starts a fresh shuffle cycle
      // and listening trail.
      playedIdsRef.current = new Set();
      historyRef.current = [];
    }
    // Shuffle bag + "previous" trail. Navigating BACK must not push onto
    // the trail it is popping from.
    const leaving = currentRef.current;
    if (leaving && leaving.id !== t.id && !skipHistoryRef.current) {
      historyRef.current.push(leaving.id);
      if (historyRef.current.length > 100) historyRef.current.shift();
    }
    skipHistoryRef.current = false;
    playedIdsRef.current.add(t.id);
    // FIX ("one song should not be suggested again"): single choke point
    // every real play funnels through (search taps, downloads, queue
    // advance/prev) — see playHistory.ts for how this feeds back into
    // future up-next pool building. The artist feeds the taste profile
    // that drives auto-next suggestions (autoNext.ts).
    recordPlayed(t.title, t.artist);
    recordRecentTrack(t); // feeds the "Recently played" shelf (libraryStore.ts)

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
        await withTimeout(nativeEngine.stop(), 5000, "native stop").catch(() => {});
      } else {
        try { playerRef.current?.stopVideo?.(); } catch { /* player not ready */ }
      }
    }

    // A newer tap arrived while the old engine was stopping: let it win.
    if (playRequestRef.current !== myRequest) return;

    if (isNativelyStreamable(t)) {
      // FIX (requirement: "if a track cannot be streamed, gracefully skip
      // it or display it as unavailable"): resolve the stream URL before
      // committing to `current`/`isPlaying` — a track whose URL can't be
      // resolved never becomes "current" as if it were playing; it
      // surfaces as `error` instead, and the mini-player never shows a
      // false playing state for it.
      // Show the new track and the "playing" state INSTANTLY (optimistic) so
      // the UI never flashes pause while the URL resolves.
      setCurrent(t);
      setPosition(0);
      isPlayingRef.current = true;
      setIsPlaying(true);
      startupTracer.mark("uiCommitted", t.id);
      // FIX (slow start / offline copy waited on the network): a downloaded
      // copy used to be raced against the remote lookup with Promise.all, so
      // playing an OFFLINE song still waited for the (possibly hanging) network
      // resolve to fail. The "is it downloaded" check is synchronous — a hit now
      // never touches the network at all.
      const offline = isTrackDownloadedSync(t.id) ? await getOfflinePlayableTrack(t.id).catch(() => null) : null;
      const cachedUrl = offline ? null : (opts?.fresh ? null : (t.streamUrl ?? getCachedStreamUrl(t.provider, t.providerTrackId)));
      if (!offline && !cachedUrl) setLoading(true);
      resolvingRef.current = true;
      startupTracer.mark("resolveStart", t.id);
      startupTracer.setResolveSource(t.id, offline ? "offline" : cachedUrl ? "cache" : "network");
      const streamUrl: string | null = offline?.streamUrl
        ?? (cachedUrl ?? await withTimeout(
            resolveNativeStreamUrl(t.provider, t.providerTrackId, opts?.fresh ? { fresh: true } : undefined),
            // HARD CAP (song stuck on "loading"): a resolve that joined a slow prefetch batch could wait
            // 10s (batch) + 2x8s (single retry). Whatever happens, the spinner ends within 12s and the
            // normal retry/alternate/skip ladder takes over.
            12_000, "stream resolve",
          ).catch(() => null));
      setLoading(false);
      resolvingRef.current = false;
      startupTracer.mark("resolved", t.id);
      // A newer tap/next/prev happened while we were resolving: drop this one.
      if (playRequestRef.current !== myRequest) return;
      if (!streamUrl) {
        startupTracer.setResolveSource(t.id, "none");
        startupTracer.fail(t.id);
        setError("This track isn't available right now.");
        setIsPlaying(false);
        skipBrokenRef.current("stream url unresolved");
        return;
      }
      const resolved: GroicTrack = { ...t, streamUrl };
      setCurrent(resolved);
      // First play of the session: make sure Android will actually let the
      // "Now playing" notification show (fire-and-forget; never blocks play).
      void nativeEngine.ensureNotificationPermission();
      try {
        // FIX (pause during loading was ignored): the user may have tapped
        // pause while the stream URL was still resolving. Honour that instead
        // of force-starting playback (and flipping the icon back) on load.
        const wantPlay = isPlayingRef.current;
        startupTracer.mark("loadStart", t.id);
        // A bridge call that never returns used to leave the UI on "playing" forever; a timeout throws
        // into the catch below, which retries once with a fresh URL and then skips.
        await withTimeout(nativeEngine.load(resolved, wantPlay), 10_000, "native load");
        startupTracer.mark("loadReturned", t.id);
        if (playRequestRef.current !== myRequest) return;
        setIsPlaying(wantPlay);
        prefetchNeighborsRef.current(resolved);
      } catch (e) {
        if (!opts?.fresh && retryCurrentRef.current()) return;
        startupTracer.fail(t.id);
        setError(e instanceof Error ? e.message : "Playback failed to start.");
        setIsPlaying(false);
        skipBrokenRef.current("native load failed");
        return;
      }
      // Fire-and-forget: gives lock-screen/Bluetooth next/previous a real
      // queue to advance through (see syncNativeQueue's own doc comment
      // above) — never gates actual playback start on this resolving.
      syncNativeQueue(resolved, q ?? queueRef.current).catch(() => {});
      broadcast("load", { provider: resolved.provider, providerTrackId: resolved.providerTrackId, track: resolved });
      return;
    }

    // IFrame (YouTube) path: no native engine event to time, so it is not traced.
    startupTracer.fail(t.id);
    setCurrent(t);
    setPosition(0);
    loadVideo(t.videoId, true);
    setIsPlaying(true);
    broadcast("load", { provider: t.provider, providerTrackId: t.providerTrackId, track: t });
  }, [loadVideo, broadcast, syncNativeQueue]);

  // Tap-to-audio timing (startupTrace.ts): one structured log line per played track so real-device
  // latency can be read from logs instead of guessed. Observational only.
  useEffect(() => startupTracer.subscribe((r) => logInfo("music.startup", "tap-to-audio", { ...r })), []);

  // Suggestions to keep playback going (autoNext.ts). One request at a time:
  // a call made while another is in flight awaits the same promise, so a
  // prefetch and an end-of-queue advance never double-fetch.
  const topUpQueue = useCallback((): Promise<GroicTrack[]> => {
    if (!autoNextRef.current || sessionRoleRef.current === "guest") return Promise.resolve([]);
    if (autoNextPromiseRef.current) return autoNextPromiseRef.current;
    const cur = currentRef.current;
    if (!cur) return Promise.resolve([]);
    const p = (async () => {
      try {
        const fresh = await fetchAutoNext({ current: cur, queue: queueRef.current, limit: 10 });
        const have = new Set(queueRef.current.map((x) => x.id));
        const add = fresh.filter((x) => !have.has(x.id));
        if (add.length > 0) {
          const nq = [...queueRef.current, ...add];
          queueRef.current = nq;
          setQueue(nq);
        }
        return add;
      } catch {
        return [];
      } finally {
        autoNextPromiseRef.current = null;
      }
    })();
    autoNextPromiseRef.current = p;
    return p;
  }, []);

  // Decision for "what plays after the current track" — shuffle-bag aware.
  const decideNext = useCallback(() => {
    const cur = currentRef.current;
    const q = queueRef.current;
    return resolveAdvanceWithBag({
      ids: q.map((x) => x.id),
      currentId: cur?.id,
      repeatMode: repeatModeRef.current,
      shuffle: shuffleRef.current,
      played: playedIdsRef.current,
    });
  }, []);

  // Picks the next queue index honoring shuffle — see
  // src/lib/music/queueLogic.ts's resolveAdvanceWithBag for the actual
  // (unit-tested) decision logic; this wires it to GroicContext's refs.
  const advanceNext = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    // Guest: the host owns the queue and auto-advance; the guest follows
    // the host's "load". (Manual next/prev from a guest go via "cmd".)
    if (sessionRoleRef.current === "guest") return;

    const decision = decideNext();

    if (decision.repeatCurrent) {
      if (isNativelyStreamable(cur)) { nativeEngine.seek(0).then(() => nativeEngine.play()).catch(() => {}); }
      else { playerRef.current?.seekTo?.(0, true); playerRef.current?.playVideo?.(); }
      broadcast("seek", { position: 0 });
      return;
    }

    if (decision.newCycle) playedIdsRef.current = new Set();
    const next = decision.index >= 0 ? queueRef.current[decision.index] : undefined;
    if (next) {
      playTrack(next, undefined);
      return;
    }

    // End of the queue. With auto-next on (and repeat off) keep going with
    // suggestions built from what's been playing, instead of stopping.
    // (guests already returned at the top of advanceNext, so no role check is needed here — it was a dead
    // comparison that failed tsc, TS2367.)
    if (autoNextRef.current && repeatModeRef.current === "off") {
      setLoading(true);
      // HARD CAP: suggestion lookup fans out to 3 providers; if one hangs the spinner used to stay forever.
      withTimeout(topUpQueue(), 10_000, "auto-next lookup").catch(() => [] as GroicTrack[]).then(() => {
        setLoading(false);
        // The user may have picked something else while we were fetching.
        if (currentRef.current?.id !== cur.id) return;
        const again = decideNext();
        const t = again.index >= 0 ? queueRef.current[again.index] : undefined;
        if (t) playTrack(t, undefined);
        else {
          // Nothing playable even after the fallback ladder (offline, or
          // every provider failed). Say so instead of stopping silently.
          setIsPlaying(false);
          setError("Couldn't find more songs to play next. Check your connection or add something to the queue.");
        }
      });
      return;
    }
    setIsPlaying(false);
  }, [broadcast, playTrack, decideNext, topUpQueue]);
  advanceNextRef.current = advanceNext;

  // Retry the current native track ONCE with a freshly resolved stream URL (the
  // cached/signed one may have expired). Returns true if a retry was started.
  retryCurrentRef.current = () => {
    const cur = currentRef.current;
    if (!cur || !isNativelyStreamable(cur)) return false;
    if (retriedTrackIdRef.current === cur.id) return false; // already retried; let the skip logic take over
    retriedTrackIdRef.current = cur.id;
    streamResolver.invalidate(cur.provider, cur.providerTrackId);
    logInfo("music.retry-fresh-url", "retrying current track with a fresh stream URL", { id: cur.id });
    const { streamUrl: _stale, ...rest } = cur;
    void playTrack(rest as GroicTrack, undefined, { fresh: true });
    return true;
  };

  // Skip a track that cannot play, instead of freezing on it. Gives up (and
  // keeps the error visible) after 3 dead tracks in a row.
  // "This track isn't available" -> play ANOTHER VERSION of the same song (any provider,
  // full length) instead of skipping it. Tried once per track; the replacement is marked
  // tried too so a bad alternate can never loop.
  const altTriedRef = useRef<Set<string>>(new Set());
  const resolveAlternate = async (cur: GroicTrack): Promise<GroicTrack | null> => {
    try {
      const [{ searchSoundCloud }, { searchAudius }, { youtubeResultToTrack }, { invokeEdgeFunction }, { findPlayableAlternate, buildTwinQuery }] = await Promise.all([
        import("@/lib/music/soundcloudProvider"),
        import("@/lib/music/audiusProvider"),
        import("@/lib/music/youtubeProvider"),
        import("@/lib/edgeFunction"),
        import("@/lib/music/nativeTwin"),
      ]);
      const q = buildTwinQuery(cur);
      const [sc, au, yt] = await Promise.all([
        searchSoundCloud(q).catch(() => [] as GroicTrack[]),
        searchAudius(q).catch(() => [] as GroicTrack[]),
        invokeEdgeFunction<{ results?: Parameters<typeof youtubeResultToTrack>[0][] }>("music-search", { body: { query: q } })
          .then((d) => (Array.isArray(d?.results) ? d!.results! : []).filter((r) => r && r.videoId && r.title).map(youtubeResultToTrack))
          .catch(() => [] as GroicTrack[]),
      ]);
      return findPlayableAlternate(cur, [...sc, ...au, ...yt], altTriedRef.current);
    } catch { return null; }
  };

  skipBrokenRef.current = (why: string) => {
    const cur = currentRef.current;
    if (!cur) return;
    if (!altTriedRef.current.has(cur.id)) {
      altTriedRef.current.add(cur.id);
      if (altTriedRef.current.size > 200) altTriedRef.current.delete(altTriedRef.current.values().next().value as string); // bounded
      setError("Finding another version of this song…");
      // Hard 6s cap: a slow/hung search must never leave the player waiting — it
      // falls through to the normal skip. All network work here is async and only
      // runs after a track has already FAILED; nothing runs per frame or per tick.
      void withTimeout(resolveAlternate(cur), 6_000, "alternate lookup").catch(() => null).then((alt) => {
        if (currentRef.current?.id !== cur.id) return; // user moved on meanwhile
        if (alt) {
          altTriedRef.current.add(alt.id);
          logInfo("music.alternate", "playing another version instead of skipping", { from: cur.id, to: alt.id, why });
          queueRef.current = queueRef.current.map((x) => (x.id === cur.id ? alt : x));
          setQueue((q) => q.map((x) => (x.id === cur.id ? alt : x)));
          setError(null);
          void playTrack(alt);
        } else {
          setError("This track isn't available right now.");
          skipBrokenRef.current(why); // no alternate exists: fall through to the normal skip
        }
      });
      return;
    }
    failedInARowRef.current += 1;
    logWarn("music.skip-broken", "track failed, skipping", { id: cur.id, why, streak: failedInARowRef.current });
    if (failedInARowRef.current > 3) { setIsPlaying(false); return; }
    advanceNextRef.current();
  };

  // A manual "next" shortly after a track starts is a skip — a negative
  // taste signal (recordSkipped). The natural end-of-track path calls
  // advanceNextRef directly and is never counted.
  const next = useCallback(() => {
    if (sessionRoleRef.current === "guest") { broadcast("cmd", { action: "next" }); return; }
    const cur = currentRef.current;
    if (cur && getPositionSync() < 25) recordSkipped(cur.title, cur.artist);
    advanceNext();
  }, [advanceNext, getPositionSync, broadcast]);
  nextRef.current = next;

  const prev = useCallback(() => {
    if (sessionRoleRef.current === "guest") { broadcast("cmd", { action: "prev" }); return; }
    const cur = currentRef.current;
    if (!cur) return;
    const q = queueRef.current;
    // Shuffle has no meaningful "index - 1": walk back through what was
    // actually played instead.
    if (shuffleRef.current) {
      const trail = historyRef.current;
      while (trail.length > 0) {
        const id = trail.pop()!;
        const t = q.find((x) => x.id === id);
        if (t && t.id !== cur.id) { skipHistoryRef.current = true; playTrack(t); return; }
      }
    } else {
      const idx = q.findIndex((x) => x.id === cur.id);
      const p = q[idx - 1];
      if (p) { playTrack(p); return; }
    }
    if (isNativelyStreamable(cur)) nativeEngine.seek(0).catch(() => {});
    else playerRef.current?.seekTo?.(0, true);
  }, [playTrack, broadcast]);
  prevRef.current = prev;

  // Keep the queue stocked: when only a couple of tracks remain (repeat off,
  // not a guest), fetch suggestions in the background so the next track is
  // ready and lock-screen "next" has somewhere to go.
  // Refills at 3 tracks left (was 2 — one slow provider call and the queue
  // ran dry), and ALSO when the queue itself changes (a track removed, a
  // queue replaced by tapping a short rail) — not only on track change.
  // Cannot loop: a refill that adds nothing leaves the queue length
  // unchanged, so this effect does not re-run.
  useEffect(() => {
    if (!current || !autoNext) return;
    if (repeatModeRef.current !== "off" || sessionRoleRef.current === "guest") return;
    const ahead = tracksAhead(queueRef.current.map((x) => x.id), current.id, shuffleRef.current, playedIdsRef.current);
    if (ahead <= 3) void topUpQueue();
  }, [current?.id, autoNext, queue.length, topUpQueue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the native lookahead window honest. It used to be set once, when a
  // track started, so anything done afterwards — Play next, Add to queue,
  // remove, an auto-next top-up, toggling shuffle/repeat — left the native
  // player advancing through the OLD order. Re-sync (debounced) on any of
  // those. Same current track ⇒ the plugin only swaps its neighbours, so
  // playback is not interrupted (see MediaPlaybackService setQueue).
  useEffect(() => {
    if (!current || !isNativelyStreamable(current)) return;
    const id = current.id;
    const h = window.setTimeout(() => {
      const cur = currentRef.current;
      if (!cur || cur.id !== id) return;
      // Prefer the already-resolved copy (carries the live streamUrl).
      void syncNativeQueue(nativeQueueWindowRef.current.get(id) ?? cur).catch(() => {});
    }, 300);
    return () => window.clearTimeout(h);
  }, [current?.id, queue, shuffle, repeatMode, syncNativeQueue]); // eslint-disable-line react-hooks/exhaustive-deps

  // FIX (split out of toggle — see the MediaSession effect below): a
  // lock-screen/notification "play" or "pause" control sends an explicit,
  // one-directional command, not a toggle. Routing the OS's "play" through
  // a toggle worked by accident only because the OS also disables the
  // "play" affordance while already playing (via playbackState) — but a
  // stale/late-arriving command (a Bluetooth headset button queued during
  // a network hiccup, a race between two rapid taps) could still land as a
  // toggle and flip the wrong way. play()/pause() are unconditional in the
  // direction they name; toggle() (used by DuoSpace's own in-app buttons,
  // where a toggle really is what's wanted) is now just `isPlaying ? pause() : play()`.
  // FIX (optimistic isPlaying — "paused via headphone but icon/state never
  // changed, no way to resume"): play()/pause() used to only call the
  // engine and wait for its own async event (YT's onStateChange
  // postMessage, or the native engine's playbackStateChanged) to update
  // `isPlaying`. That round-trip is what silently broke: a command that
  // reaches the actual player without going through this app's own call —
  // exactly what an OS/Bluetooth media key can do once it's decided the
  // underlying element itself is the target — leaves `isPlaying` never
  // corrected (see the reconciliation poll and silent Media Session anchor
  // above, which cover that path). But even for the *ordinary* case where
  // this app's own play()/pause() IS what fired (a normal in-app tap, or a
  // Bluetooth command that did route through our own setActionHandler),
  // there's no reason to make the UI wait on that async round-trip at all
  // — the caller just told the engine what to do, so reflect it
  // immediately. Each engine's own event is still the eventual source of
  // truth and will simply confirm (or, rarely, correct) this.
  const play = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    isPlayingRef.current = true; // synchronous: a rapid second tap must see this
    setIsPlaying(true);
    if (isNativelyStreamable(cur)) {
      nativeEngine.play().catch(() => {});
      broadcast("play", { position: nativePositionRef.current });
      return;
    }
    playerRef.current?.playVideo?.();
    broadcast("play", { position: playerRef.current?.getCurrentTime?.() || 0 });
  }, [broadcast]);

  const pause = useCallback(() => {
    const cur = currentRef.current;
    if (!cur) return;
    isPlayingRef.current = false;
    setIsPlaying(false);
    if (isNativelyStreamable(cur)) {
      nativeEngine.pause().catch(() => {});
      broadcast("pause", { position: nativePositionRef.current });
      return;
    }
    playerRef.current?.pauseVideo?.();
    broadcast("pause", { position: playerRef.current?.getCurrentTime?.() || 0 });
  }, [broadcast]);

  const toggle = useCallback(() => {
    if (!currentRef.current) return;
    // FIX (double-tap / rapid taps toggled the wrong way): this read the
    // `isPlaying` STATE from the render closure, so two taps inside one render
    // both saw the same value and both issued "pause". The ref is updated
    // synchronously by play()/pause(), so every tap sees the latest intent.
    if (isPlayingRef.current) pause(); else play();
  }, [play, pause]);

  const seek = useCallback((sec: number) => {
    const cur = currentRef.current;
    if (cur && isNativelyStreamable(cur)) nativeEngine.seek(sec).catch(() => {});
    else playerRef.current?.seekTo?.(sec, true);
    lastSeekAtRef.current = Date.now();
    setPosition(sec);
    broadcast("seek", { position: sec });
  }, [broadcast]);

  // ── MediaSession: the actual lock-screen/notification/Bluetooth-headset
  // controls (the thing this pass exists to fix) ──────────────────────────
  //
  // BUG this fixes: only Audius tracks ever got a system notification.
  // nativeEngine's own web fallback (native-plugins/audio-engine/src/web.ts)
  // wires navigator.mediaSession, but only around its own HTMLAudioElement
  // — so a YouTube track (the majority of real plays; YouTube is the
  // default/"All Music" search provider) produced no notification at all,
  // no lock-screen artwork, no Bluetooth/headset play-pause-next-previous.
  // That's the actual gap, not a native-plugin bug — the native engine
  // side was already correct for Audius.
  //
  // Fix: GroicContext — which already knows which engine is live for the
  // current track and already exposes play()/pause()/next()/prev()/seek()
  // that each correctly branch on isNativelyStreamable() — becomes the
  // SINGLE owner of `navigator.mediaSession` for the whole app, covering
  // both providers uniformly. For a YouTube track this calls the existing
  // YT IFrame API's own playVideo()/pauseVideo()/seekTo() (already used
  // elsewhere in this file, e.g. toggle()/advanceNext()) — describing
  // "here's what's playing" to the OS and forwarding OS commands to
  // controls the player already exposes. This never extracts, proxies, or
  // reads YouTube's actual audio stream — the hard boundary documented in
  // docs/MUSIC_NATIVE_PLAYBACK.md is unchanged; only playback *metadata and
  // remote-control routing* are new here.
  //
  // Platform reality, stated plainly rather than assumed:
  //   - Desktop browser tabs and Android Chrome/Firefox/Edge/Samsung
  //     Internet: this genuinely produces a real OS notification with
  //     working play/pause/next/previous/seek, for BOTH providers now,
  //     exactly like this effect is written.
  //   - iOS Safari: navigator.mediaSession IS supported (Baseline since
  //     Sept 2021) so the controls work while the tab is open/foregrounded;
  //     WebKit's background-tab suspension policy (see web.ts's header
  //     comment) is what limits how long that survives backgrounded/locked
  //     — a WebKit platform constraint, not something fixable here.
  //   - Inside the native Capacitor app (Android/iOS installed app, not a
  //     browser tab): Audius tracks get a REAL, durable background
  //     notification from the native engine (MediaSessionService on
  //     Android, MPNowPlayingInfoCenter on iOS) that survives the app being
  //     backgrounded or the screen locking — see MediaPlaybackService.kt /
  //     AudioEnginePlugin.swift. A YouTube track playing inside the app's
  //     WebView gets this same navigator.mediaSession wiring and can show
  //     a notification while the WebView is actually alive, but — same as
  //     any WebView, this app included — Android is free to suspend a
  //     backgrounded WebView's JS/audio without the foreground-service
  //     protection a native player gets, so a locked-screen YouTube session
  //     inside the app is not guaranteed to survive as long as an Audius
  //     one. This is an Android/WebView platform constraint, not a bug in
  //     this wiring — the only way around it for YouTube specifically would
  //     be extracting its audio into the native engine, which this app
  //     deliberately does not do.
  const durationRef = useRef(0);
  useEffect(() => { durationRef.current = duration; }, [duration]);
  // FIX (broadcast staleness): play/pause/next/prev/seek each ultimately
  // call broadcast(), which reads `sessionRole` — so re-registering these
  // handlers every time any of them changes identity (not just once at
  // mount) matters for real: registering once at mount would otherwise
  // permanently pin the handlers to whatever `sessionRole` was at first
  // render (almost always "solo"), so a lock-screen/Bluetooth command sent
  // after actually starting a shared-listening session would keep silently
  // skipping the broadcast to the partner. setActionHandler is idempotent
  // (re-setting the same action just replaces the callback in place), so
  // there's no cost to doing this on every relevant change.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const safeSetHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try { ms.setActionHandler(action, handler); } catch { /* action unsupported in this browser — non-fatal */ }
    };
    safeSetHandler("play", () => play());
    safeSetHandler("pause", () => pause());
    safeSetHandler("nexttrack", () => next());
    safeSetHandler("previoustrack", () => prev());
    safeSetHandler("seekto", (details) => {
      if (typeof details.seekTime === "number") seek(details.seekTime);
    });
    // Coarse forward/back skip (10s) — some OS media notifications (e.g.
    // Android's) show these instead of / alongside seek-on-scrubber.
    safeSetHandler("seekforward", () => seek(Math.min(getPositionSync() + 10, durationRef.current || getPositionSync() + 10)));
    safeSetHandler("seekbackward", () => seek(Math.max(getPositionSync() - 10, 0)));
  }, [play, pause, next, prev, seek, getPositionSync]);

  // Metadata (title/artist/artwork) — must update every track change,
  // for both providers; this is what actually makes the notification show
  // the right song instead of either nothing or the previous one.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    if (!current) { try { navigator.mediaSession.metadata = null; } catch { /* ignore */ } return; }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.artist,
        album: current.album || "DuoSpace",
        artwork: current.thumbnail ? [
          { src: current.thumbnail, sizes: "96x96", type: "image/jpeg" },
          { src: current.thumbnail, sizes: "512x512", type: "image/jpeg" },
        ] : [],
      });
    } catch { /* MediaMetadata unsupported — non-fatal */ }
  }, [current]);

  // playbackState — must reflect actual state so the OS shows the right
  // play-vs-pause affordance in the notification.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try { navigator.mediaSession.playbackState = current ? (isPlaying ? "playing" : "paused") : "none"; } catch { /* ignore */ }
  }, [isPlaying, current]);

  // Scrub-bar position — setPositionState is what actually feeds the
  // lock-screen/notification progress bar; without it the bar either never
  // renders or freezes at 0:00 (neither browser infers this from an
  // <audio> element or the YT IFrame on its own). Throttled to 1/s via the
  // effect's own dependency on the rounded-second `position` value from
  // the existing position-tracking already running elsewhere in this file
  // (the YT poll interval / native engine's positionChanged listener) —
  // this adds no new polling of its own.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession as MediaSession & { setPositionState?: (s?: MediaPositionState) => void };
    if (typeof ms.setPositionState !== "function") return;
    if (!current || !isFinite(duration) || duration <= 0) return;
    try {
      ms.setPositionState({ duration, playbackRate: 1, position: Math.min(Math.max(position, 0), duration) });
    } catch { /* e.g. position momentarily > duration mid-seek/track-switch — skip this tick */ }
  }, [Math.floor(position), duration, current]);

  // ── Legal background play for YouTube tracks: provider handoff ──────────
  // YouTube's API Terms don't allow an embedded player to keep playing
  // audio once the app/player is hidden (background play is a YouTube
  // Premium feature; Brave does it as a *browser*, which isn't an option
  // for an app embedding the IFrame player). So instead of bypassing that,
  // when the app goes to the background while a YouTube track is playing,
  // Groic looks up the SAME song on SoundCloud / Audius — licensed sources
  // that are streamed natively and can legally play in the background —
  // and switches to it from roughly the same position. If no confident
  // match exists, the YouTube track simply pauses, as YouTube requires.
  playTrackRef.current = playTrack;
  seekRef.current = seek;
  const handoffInFlightRef = useRef(false);

  // Resolve (and cache) the native "twin" of a YouTube track WHILE the app is
  // still in the foreground. The old code only searched once the app was
  // already hidden — by then the WebView's network/timers are throttled or
  // frozen, the two searches ran one after the other, and the YouTube audio
  // had already been cut, which is exactly the "stuck when backgrounded"
  // symptom. With the twin cached, hiding the app is an instant switch.
  const twinCacheRef = useRef<Map<string, GroicTrack | null>>(new Map());
  const twinInFlightRef = useRef<Map<string, Promise<GroicTrack | null>>>(new Map());
  const resolveTwin = useCallback((cur: GroicTrack): Promise<GroicTrack | null> => {
    if (twinCacheRef.current.has(cur.id)) return Promise.resolve(twinCacheRef.current.get(cur.id) ?? null);
    const running = twinInFlightRef.current.get(cur.id);
    if (running) return running;
    const p = (async () => {
      try {
        const { searchSoundCloud } = await import("@/lib/music/soundcloudProvider");
        const { searchAudius } = await import("@/lib/music/audiusProvider");
        const q = buildTwinQuery(cur);
        const [sc, au] = await Promise.all([
          searchSoundCloud(q).catch(() => [] as GroicTrack[]),
          searchAudius(q).catch(() => [] as GroicTrack[]),
        ]);
        const match = findNativeTwin(cur, [...sc, ...au]);
        // Only cache a real answer; a failed/empty lookup may be a network blip.
        if (match || sc.length + au.length > 0) twinCacheRef.current.set(cur.id, match);
        if (twinCacheRef.current.size > 60) twinCacheRef.current.delete(twinCacheRef.current.keys().next().value as string);
        return match;
      } catch { return null; }
      finally { twinInFlightRef.current.delete(cur.id); }
    })();
    twinInFlightRef.current.set(cur.id, p);
    return p;
  }, []);

  // Prefetch for the track that is playing now (native app only).
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    if (!current || current.provider !== "youtube") return;
    void resolveTwin(current);
  }, [current?.id, current?.provider, resolveTwin]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const onHide = async () => {
      if (!document.hidden) return;
      const cur = currentRef.current;
      if (!cur || cur.provider !== "youtube" || handoffInFlightRef.current) return;
      // Only hand off a track that is actually meant to be playing.
      if (!isPlayingRef.current) return;
      handoffInFlightRef.current = true;
      const at = positionRef.current || playerRef.current?.getCurrentTime?.() || 0;
      try {
        // Cached twin = instant. Otherwise one bounded attempt (4s) — a
        // slower lookup is useless: the OS stops the IFrame regardless.
        const match = await Promise.race([
          resolveTwin(cur),
          new Promise<null>((r) => setTimeout(() => r(null), 4000)),
        ]);
        if (currentRef.current?.id !== cur.id) return; // user changed track meanwhile
        if (match) {
          logInfo("music.handoff", "YouTube → native provider for background play", { from: cur.id, to: match.id });
          const q2 = queueRef.current.map(t => (t.id === cur.id ? match : t));
          // playTrack() stops the IFrame itself (provider switch).
          await playTrackRef.current?.(match, q2.some(t => t.id === match.id) ? q2 : [match, ...q2]);
          if (at > 5) setTimeout(() => seekRef.current?.(at), 1200);
          return;
        }
        // No same-song twin. If the very next song is natively playable,
        // carry on with it rather than going silent; otherwise pause
        // honestly. The old code did neither: the YouTube audio died but
        // `isPlaying` stayed true, so the UI showed a playing song that
        // was silent and tapping pause/play did nothing useful.
        const d = decideNext();
        const nextTrack = !d.repeatCurrent && d.index >= 0 ? queueRef.current[d.index] : undefined;
        if (nextTrack && isNativelyStreamable(nextTrack)) {
          logInfo("music.handoff", "no native twin, continuing with next native track", { next: nextTrack.id });
          advanceNextRef.current();
        } else {
          try { playerRef.current?.pauseVideo?.(); } catch { /* player not ready */ }
          setIsPlaying(false);
          logInfo("music.handoff", "no native twin, paused YouTube track for background", { id: cur.id });
        }
      } catch (e) {
        logWarn("music.handoff", "background handoff failed", { error: String(e) });
        try { playerRef.current?.pauseVideo?.(); } catch { /* noop */ }
        setIsPlaying(false);
      } finally {
        handoffInFlightRef.current = false;
      }
    };
    // Back in the foreground: resync the displayed state from the IFrame
    // itself, in case the OS paused/froze it while we were away.
    const onShow = () => {
      if (document.hidden) return;
      const c = currentRef.current;
      if (!c || c.provider !== "youtube") return;
      try {
        const st = playerRef.current?.getPlayerState?.();
        if (st === 1) setIsPlaying(true);
        else if (st === 2 || st === 5 || st === -1) setIsPlaying(false);
      } catch { /* player not ready */ }
    };
    const onVisibility = () => { if (document.hidden) void onHide(); else onShow(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [resolveTwin, decideNext]);

  // Stall watchdog (YouTube): "playing" intent but the position hasn't moved
  // for ~12s while the app is visible → the IFrame is wedged (network blip,
  // ad-block/consent interstitial, frozen after a long background). Re-load
  // the video at the last position once; if it still doesn't move, skip.
  useEffect(() => {
    let lastPos = -1, stuckTicks = 0, retried = false, lastId = "";
    const id = window.setInterval(() => {
      const c = currentRef.current;
      if (!c || c.provider !== "youtube" || !isPlayingRef.current || document.hidden) { stuckTicks = 0; return; }
      if (c.id !== lastId) { lastId = c.id; lastPos = -1; stuckTicks = 0; retried = false; }
      const pos = playerRef.current?.getCurrentTime?.() ?? 0;
      if (Math.abs(pos - lastPos) < 0.2) stuckTicks += 1; else { stuckTicks = 0; retried = false; }
      lastPos = pos;
      if (stuckTicks < 6) return; // 6 × 2s
      stuckTicks = 0;
      if (!retried) {
        retried = true;
        logWarn("music.watchdog", "YouTube stalled, reloading at position", { id: c.id, pos });
        try { playerRef.current?.loadVideoById?.({ videoId: c.videoId, startSeconds: Math.max(0, pos - 1) }); } catch { /* noop */ }
      } else {
        retried = false;
        skipBrokenRef.current("youtube stalled");
      }
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // Stall watchdog (native engine): the YouTube watchdog above never covered SoundCloud / Audius / Jamendo /
  // local tracks. "Playing" intent but the native position frozen for ~14 s (ExoPlayer wedged in buffering,
  // dead HLS, a stuck bridge) -> retry ONCE with a fresh stream URL, then skip — the same ladder every other
  // failure path uses. Never fires for a deliberate pause, a backgrounded app, URL resolution or a fresh seek.
  useEffect(() => {
    const detector = createStallDetector(7);
    const id = window.setInterval(() => {
      const c = currentRef.current;
      const native = !!c && isNativelyStreamable(c);
      const stalled = detector.sample({
        trackId: native ? c!.id : null,
        wantPlaying: isPlayingRef.current,
        hidden: document.hidden,
        grace: resolvingRef.current || Date.now() - lastSeekAtRef.current < SEEK_HOLD_MS + 3000,
        positionSeconds: nativePositionRef.current,
      });
      if (!stalled || !c) return;
      logWarn("music.watchdog", "native playback stalled", { id: c.id, provider: c.provider, pos: nativePositionRef.current });
      if (!retryCurrentRef.current()) skipBrokenRef.current("native stalled");
    }, 2000);
    return () => clearInterval(id);
  }, []);

  // ── Android/iOS background "keep-alive" for YouTube-provider tracks ────
  // See native-plugins/audio-engine/src/definitions.ts's WebKeepAliveMeta
  // doc comment for the full design. Short version: navigator.mediaSession
  // above already gets a YouTube track's metadata/controls in front of the
  // OS, but on the installed native app that's not enough by itself —
  // Android can freeze this app's process (and with it, the hidden
  // YouTube IFrame's JS/audio) once backgrounded, since nothing here was
  // otherwise telling Android "this app is actively doing background
  // media work" the way MediaPlaybackService's foreground service already
  // does for Audius/SoundCloud tracks. This section starts/stops that same
  // kind of foreground-service protection for a YouTube track specifically
  // — never touching or extracting its audio, only keeping the process
  // (and therefore the existing IFrame) alive and reachable by OS/
  // Bluetooth remote commands. No-op on web (see web.ts) and harmless if
  // called on a native build lacking this plugin update.
  //
  // Remote commands arriving through keep-alive mode: routed to the exact
  // same play()/pause()/next()/prev()/seek() this file already exposes for
  // in-app buttons and the navigator.mediaSession handlers above — kept
  // separate from that effect (rather than merged into safeSetHandler)
  // because these two control surfaces are OS-native APIs on different
  // platforms (browser MediaSession vs. Android's real
  // android.media.session.MediaSession / iOS's MPRemoteCommandCenter,
  // relayed here through the plugin) and can both be live in the native
  // app simultaneously without conflicting — only one is ever actually
  // wired to a real system surface for a given platform/track combination.
  useEffect(() => {
    const sub = nativeEngine.onWebKeepAliveCommand(({ action, positionSeconds }) => {
      // play/pause/seek on a native-engine track were already applied natively;
      // only YouTube needs them relayed. next/previous are also forwarded by the
      // native service when ITS queue window can't satisfy them, so they must
      // be honoured for any provider.
      const isYouTubeNow = currentRef.current?.provider === "youtube";
      if (!currentRef.current) return;
      if (!isYouTubeNow && action !== "next" && action !== "previous") return; // stale command from a since-ended keep-alive session
      switch (action) {
        case "play": play(); break;
        case "pause": pause(); break;
        case "next": next(); break;
        case "previous": prev(); break;
        case "seek": if (typeof positionSeconds === "number") seek(positionSeconds); break;
      }
    });
    return () => { sub.then((h) => h.remove()).catch(() => {}); };
  }, [play, pause, next, prev, seek]);

  // Start/stop keep-alive mode as the current track's provider/playing
  // state changes. Deliberately does NOT start on every position tick —
  // only on the actual transitions that matter — and metadata is only
  // sent from here (once per track), not on the position-push effect
  // below, matching WebKeepAliveStateUpdate's "meta only when it changed"
  // contract.
  const webKeepAliveActiveRef = useRef(false);
  const webKeepAliveTrackIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const isYouTube = current?.provider === "youtube";
    // Keep the now-playing notification / lock-screen card for the WHOLE
    // time a YouTube track is the current one — including while paused, so
    // the Play button is still there to resume from (previously a pause
    // tore it down completely, leaving nothing to tap). It is only removed
    // when the current track stops being a YouTube track (switched to a
    // native provider, or the player was closed).
    if (isYouTube && current && (isPlaying || webKeepAliveActiveRef.current)) {
      const trackChanged = webKeepAliveTrackIdRef.current !== current.id;
      if (!webKeepAliveActiveRef.current || trackChanged) {
        webKeepAliveActiveRef.current = true;
        webKeepAliveTrackIdRef.current = current.id;
        // The permission was only ever requested on the native-stream path,
        // so a YouTube-only listener could reach playback without it.
        void nativeEngine.ensureNotificationPermission();
        nativeEngine.startWebKeepAlive({
          title: current.title,
          artist: current.artist,
          artworkUrl: current.thumbnail ?? current.artwork ?? undefined,
        }).catch(() => {
          webKeepAliveActiveRef.current = false;
          webKeepAliveTrackIdRef.current = null;
        });
      }
    } else if (!isYouTube && webKeepAliveActiveRef.current) {
      webKeepAliveActiveRef.current = false;
      webKeepAliveTrackIdRef.current = null;
      nativeEngine.stopWebKeepAlive().catch(() => {});
    }
  }, [current?.id, current?.provider, isPlaying]);

  // Position/duration push while keep-alive is active — mirrors the
  // setPositionState effect above, throttled the same way (via the
  // rounded-second `position` dependency, riding the YouTube poll's
  // existing ~500ms tick rather than adding a new one). `current?.id` is a
  // dependency so a track change immediately re-syncs the real
  // playing/paused state right after the (always "playing") start call.
  useEffect(() => {
    if (!webKeepAliveActiveRef.current) return;
    nativeEngine.updateWebKeepAlive({
      playing: isPlaying,
      positionSeconds: position,
      durationSeconds: duration,
    }).catch(() => {});
  }, [Math.floor(position), isPlaying, duration, current?.id]);

  // Tear down keep-alive on unmount (e.g. sign-out) so a stale foreground
  // service/notification never outlives the app knowing about it.
  useEffect(() => () => {
    if (webKeepAliveActiveRef.current) nativeEngine.stopWebKeepAlive().catch(() => {});
  }, []);

  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    setVolumeState(clamped);
    // Volume only applies to the native engine (Audius) — YouTube's own
    // IFrame has its own separate, unrelated volume control this app has
    // never exposed and isn't adding here.
    nativeEngine.setVolume(clamped).catch(() => {});
  }, []);

  const setRepeatMode = useCallback((m: RepeatMode) => setRepeatModeState(m), []);
  const toggleShuffle = useCallback(() => {
    const on = !shuffleRef.current;
    shuffleRef.current = on;
    // Turning shuffle on starts a fresh cycle where what's playing counts
    // as already heard.
    if (on) playedIdsRef.current = new Set(currentRef.current ? [currentRef.current.id] : []);
    setShuffle(on);
  }, []);
  const toggleAutoNext = useCallback(() => {
    const on = !autoNextRef.current;
    autoNextRef.current = on;
    try { localStorage.setItem("groic-auto-next", on ? "1" : "0"); } catch { /* private mode */ }
    setAutoNextState(on);
  }, []);

  const enqueue = useCallback((t: GroicTrack) => {
    setQueue((q) => q.some((x) => x.id === t.id) ? q : [...q, t]);
  }, []);
  // "Play Next": slot the track directly after whatever is playing. The queue
  // normally contains the current track (see GroicFullPlayer's Up-next list);
  // when it doesn't (empty queue), the current track is put in front first so
  // next() still lands on the inserted song instead of skipping it.
  const playNext = useCallback((t: GroicTrack) => {
    const cur = currentRef.current;
    if (cur && cur.id === t.id) return;
    setQueue((q) => insertAfterCurrent(q, cur, t));
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
          isPlaying: isPlayingRef.current,
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
    partnerSeenRef.current = Date.now();
    // Seconds a control event spent in flight, measured on the partner's
    // clock mapped onto ours (capped so a bad offset can't fling playback).
    const flight = payload?.ts && offsetKnownRef.current
      ? Math.min(3, Math.max(0, (Date.now() + clockOffsetRef.current - payload.ts) / 1000)) : 0;
    // Both partners pressed at the same moment: the later press wins on both
    // phones. Only enforced once the clock offset is trustworthy.
    if (event !== "tick" && payload?.ts && offsetKnownRef.current &&
        payload.ts - clockOffsetRef.current < lastLocalControlRef.current) return;
    const provider: MusicProvider =
      payload.provider === "audius" ? "audius" :
      payload.provider === "soundcloud" ? "soundcloud" :
      payload.provider === "jamendo" ? "jamendo" :
      payload.provider === "local" ? "local" : "youtube";

    // A guest resolves the SAME provider track itself rather than trusting
    // a stream URL the host resolved — both Audius's and SoundCloud's
    // stream URLs are per-request/short-lived, and this also means a
    // guest without access to a given track (a regional restriction, a
    // track since taken down) fails gracefully for THEM specifically
    // instead of silently reusing a URL that happened to work for the
    // host a moment ago.
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
      if (provider === "local") return null; // a file on the host's phone doesn't exist here
      const streamUrl = await resolveNativeStreamUrl(provider, providerTrackId);
      if (!streamUrl) return null;
      const base: GroicTrack = payload.track ?? {
        id: makeTrackId(provider, providerTrackId), provider, providerTrackId,
        videoId: providerTrackId, title: "", artist: "", thumbnail: null, duration: 0,
      };
      return { ...base, streamUrl };
    };

    if (event === "load") {
      const track = await resolveGuestTrack();
      if (!track) {
        setError(provider === "local"
          ? "Your partner is playing a file stored on their phone — it can't play on yours."
          : "Couldn't join this track — it may be unavailable.");
        return;
      }
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
      if (isNativelyStreamable(track)) {
        try { await nativeEngine.load(track, true); setIsPlaying(true); }
        catch { setError("Couldn't play this track."); setIsPlaying(false); }
      } else {
        loadVideo(track.videoId, true);
        setIsPlaying(true);
      }
      return;
    }

    if (event === "cmd") {
      // Partner pressed next/previous while following us — we own the queue.
      if (sessionRoleRef.current === "host") {
        if (payload?.action === "next") nextRef.current();
        else if (payload?.action === "prev") prevRef.current();
        toast(payload?.action === "next" ? "Partner skipped to the next song ⏭️" : "Partner went back ⏮️", { duration: 2000 });
      }
      return;
    }
    if (event === "play") {
      if (cur && isNativelyStreamable(cur)) { nativeEngine.play().catch(() => {}); }
      else { playerRef.current?.playVideo?.(); }
      if (typeof payload.position === "number") {
        const target = payload.position + flight;
        if (Math.abs(target - getPositionSync()) > 0.7) {
          if (cur && isNativelyStreamable(cur)) nativeEngine.seek(target).catch(() => {});
          else playerRef.current?.seekTo?.(target, true);
        }
      }
      setIsPlaying(true);
      toast("Partner resumed the music ▶️", { duration: 1800 });
      return;
    }
    if (event === "pause") {
      if (cur && isNativelyStreamable(cur)) { nativeEngine.pause().catch(() => {}); }
      else { playerRef.current?.pauseVideo?.(); }
      setIsPlaying(false);
      toast("Partner paused the music ⏸️", { duration: 1800 });
      return;
    }
    if (event === "seek") {
      lastSeekRef.current = Date.now();
      // Only a playing track advances while the seek message travels.
      const seekTo = (payload.position || 0) + (isPlayingRef.current ? flight : 0);
      if (cur && isNativelyStreamable(cur)) { nativeEngine.seek(seekTo).catch(() => {}); }
      else { playerRef.current?.seekTo?.(seekTo, true); }
      return;
    }
    if (event === "tick") {
      // We just pressed something ourselves: this heartbeat predates it.
      if (Date.now() - lastLocalControlRef.current < CONTROL_GRACE_MS) return;
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
        if (isNativelyStreamable(track)) { try { await nativeEngine.load(track, true); } catch { return; } }
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
        payload.position || 0, payload.ts || Date.now(), Date.now() + clockOffsetRef.current, localPos,
        /* supportsRateNudge */ !isNative,
      );

      // A seek needs time to buffer; re-seeking every tick while it settles
      // causes stutter loops, so rate-limit hard corrections.
      const seekCooling = Date.now() - lastSeekRef.current < 2500;
      if (action === "seek") lastSeekRef.current = seekCooling ? lastSeekRef.current : Date.now();
      if (isNative) {
        if (action === "seek" && !seekCooling) nativeEngine.seek(expectedPosition).catch(() => {});
      } else if (action === "seek" && seekCooling) {
        /* wait for the previous correction to settle */
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
  }, [loadVideo, getPositionSync]);


  // ── Session lifecycle ────────────────────────────────────────────────────
  // SECURITY (2026-09-16, Realtime authorization audit — see
  // supabase/migrations/20260916150000_realtime_authorization_couple_channels.sql):
  // this topic format (already colon-delimited, unlike typing-/presence-'s
  // old hyphen format) is now also gated server-side by RLS on
  // realtime.messages via is_couple_realtime_topic_authorized(), and both
  // channels below are marked `private: true` to actually invoke that
  // check. Do not change this "groic:<uid1>:<uid2>" shape without
  // updating that migration to match.
  const channelName = useMemo(() => {
    if (!user || !partnerId) return null;
    const ids = [user.id, partnerId].sort().join(":");
    return `groic:${ids}`;
  }, [user, partnerId]);

  // FIX ("Together"/join sometimes just does nothing — no error, no
  // connection): two gaps here, both silent.
  //
  // 1. Realtime Authorization for a `private: true` channel runs
  //    is_couple_realtime_topic_authorized() against auth.uid() on the
  //    REALTIME SOCKET's own JWT — which is a separate token handoff from
  //    the main REST client's session, normally kept in sync only by an
  //    auth *state change* event (SIGNED_IN/TOKEN_REFRESHED). On a fresh
  //    page load, or right after a token refresh, there's a real race
  //    where this subscribes before that handoff has actually reached the
  //    realtime socket — auth.uid() then evaluates NULL server-side, the
  //    RLS check returns false, and the subscribe never becomes
  //    SUBSCRIBED. ensureRealtimeAuth() below closes that race by
  //    explicitly (re)sending the current access token first.
  // 2. Even when that race isn't the cause (a genuine dropped connection,
  //    a slow network), the old `.subscribe((status) => ...)` callback
  //    only ever handled the SUBSCRIBED case — CHANNEL_ERROR/TIMED_OUT/
  //    CLOSED were dropped on the floor. No "join" broadcast went out, no
  //    error surfaced, and sessionRole was already set to "host"/"guest"
  //    by the caller, so the UI just sat there looking connected forever.
  //    Now: one retry (covers a genuine transient drop), then a real
  //    error via `error` and a fall back to "solo" instead of a stuck fake
  //    session.
  const ensureRealtimeAuth = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (token) await supabase.realtime.setAuth(token);
    } catch { /* best-effort — a real auth problem still surfaces via the subscribe status below */ }
  }, []);

  const markPartner = useCallback((online: boolean) => {
    partnerSeenRef.current = Date.now();
    if (partnerOnlineRef.current === online) return;
    partnerOnlineRef.current = online;
    setPartnerListening(online);
    toast(online ? "Partner joined the session 🎧" : "Partner left the session", { duration: 2000 });
  }, []);

  const subscribeChannel = useCallback((role: Role) => {
    if (!channelName) return;
    partnerOnlineRef.current = false;
    offsetKnownRef.current = false;
    clockOffsetRef.current = 0;
    offsetSamplesRef.current = [];
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }

    const attemptSubscribe = (attempt: number) => {
      ensureRealtimeAuth().then(() => {
        const ch = supabase.channel(channelName, { config: { broadcast: { self: false }, private: true } })
          .on("broadcast", { event: "load" },  ({ payload }) => onGuestEvent("load", payload))
          .on("broadcast", { event: "play" },  ({ payload }) => onGuestEvent("play", payload))
          .on("broadcast", { event: "pause" }, ({ payload }) => onGuestEvent("pause", payload))
          .on("broadcast", { event: "seek" },  ({ payload }) => onGuestEvent("seek", payload))
          .on("broadcast", { event: "cmd" },   ({ payload }) => onGuestEvent("cmd", payload))
          .on("broadcast", { event: "tick" },  ({ payload }) => role === "guest" && onGuestEvent("tick", payload))
          // NTP-style clock sync: anyone answers a ping with their own clock.
          .on("broadcast", { event: "clock-ping" }, ({ payload }) => {
            ch.send({ type: "broadcast", event: "clock-pong", payload: { t0: payload?.t0, t1: Date.now(), to: payload?.from } });
          })
          .on("broadcast", { event: "clock-pong" }, ({ payload }) => {
            if (payload?.to !== user?.id || typeof payload?.t0 !== "number") return;
            const s = estimateClockOffset(payload.t0, payload.t1, Date.now());
            offsetSamplesRef.current = [...offsetSamplesRef.current.slice(-7), s];
            clockOffsetRef.current = pickBestOffset(offsetSamplesRef.current);
            offsetKnownRef.current = true;
            partnerSeenRef.current = Date.now();
          })
          // Lightweight liveness beat (a "join" would make the host reload
          // the track for the guest every time).
          .on("broadcast", { event: "hb" }, () => markPartner(true))
          // Guest came back to the foreground / reconnected: answer with the
          // current state immediately instead of waiting for the next tick.
          .on("broadcast", { event: "sync-req" }, () => {
            const t = currentRef.current;
            if (role !== "host" || !t) return;
            ch.send({ type: "broadcast", event: "tick", payload: { provider: t.provider, providerTrackId: t.providerTrackId, videoId: t.videoId, position: getPositionSync(), isPlaying: isPlayingRef.current, ts: Date.now() } });
          })
          .on("broadcast", { event: "join" },  ({ payload }) => {
            markPartner(true);
            // Host measures its own offset to the guest too, so it can
            // latency-compensate the guest's play/seek commands.
            if (role === "host" && payload?.role === "guest" && user) {
              offsetSamplesRef.current = [];
              [0, 300, 900, 2000].forEach((d) => window.setTimeout(() => {
                if (channelRef.current === ch) ch.send({ type: "broadcast", event: "clock-ping", payload: { t0: Date.now(), from: user.id } });
              }, d));
            }
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
          .on("broadcast", { event: "leave" }, () => markPartner(false))
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              setError(null);
              ch.send({ type: "broadcast", event: "join", payload: { role } });
              partnerSeenRef.current = Date.now();
              // Liveness + watchdog + clock refresh, all self-cancelling once
              // this channel is replaced or torn down.
              let beats = 0;
              const live = window.setInterval(() => {
                if (channelRef.current !== ch) { window.clearInterval(live); return; }
                beats += 1;
                try { ch.send({ type: "broadcast", event: "hb", payload: { role } }); } catch { /* mid-teardown */ }
                const silent = Date.now() - partnerSeenRef.current;
                if (role === "host" && partnerOnlineRef.current && silent > 12000) markPartner(false);
                if (role === "guest" && silent > 10000 && Date.now() - lastResubRef.current > 15000) {
                  lastResubRef.current = Date.now();
                  toast("Reconnecting to your partner…", { duration: 2000 });
                  window.clearInterval(live);
                  subscribeChannelRef.current("guest");
                  return;
                }
                if (user && beats % 8 === 0) ch.send({ type: "broadcast", event: "clock-ping", payload: { t0: Date.now(), from: user.id } });
              }, 4000);
              if (role === "guest" && user) {
                // Burst of pings so the offset is good before the first drift decision.
                offsetSamplesRef.current = [];
                [0, 300, 900, 2000, 5000].forEach((d) => window.setTimeout(() => {
                  if (channelRef.current === ch) ch.send({ type: "broadcast", event: "clock-ping", payload: { t0: Date.now(), from: user.id } });
                }, d));
              }
              return;
            }
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
              // A newer attempt (or a teardown) already replaced this
              // channel — this stale callback firing late shouldn't undo it.
              if (channelRef.current !== ch) return;
              // RE-ENTRANCY FIX: removeChannel() re-emits CLOSED into this callback; detach first so the
              // nested call fails the guard above instead of recursing to a stack overflow.
              channelRef.current = null;
              try { void supabase.removeChannel(ch); } catch { /* already gone */ }
              if (attempt < 1) {
                attemptSubscribe(attempt + 1);
              } else {
                channelRef.current = null;
                setSessionRole("solo");
                setPartnerListening(false);
                setError("Couldn't connect a shared listening session — check your connection and try again.");
              }
            }
          });
        channelRef.current = ch;
      });
    };

    attemptSubscribe(0);
  }, [channelName, onGuestEvent, getPositionSync, ensureRealtimeAuth, user, markPartner]);
  subscribeChannelRef.current = subscribeChannel;

  // Back in the foreground (or network returned): ask the host for state now.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible" || sessionRoleRef.current !== "guest") return;
      try { channelRef.current?.send({ type: "broadcast", event: "sync-req", payload: {} }); } catch { /* noop */ }
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onVis);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("online", onVis); };
  }, []);

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
    // Reach the partner even if their app is closed (in-app banner only
    // works while it's open). Server rate-limits repeat pushes.
    try { await supabase.rpc("notify_partner_listening" as never); } catch { /* best-effort */ }
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
  //
  // FIX (same silent-failure gap as subscribeChannel above, on the
  // invitee's side this time): this is a `private: true` channel too, so
  // it's subject to the exact same auth-handoff race, and its old
  // `.subscribe()` call passed no status callback at all — if this
  // subscription never actually authorized, the invite banner simply
  // never appeared for the partner, with nothing anywhere to say why.
  // Same fix: send the current token first, retry once on a real error.
  useEffect(() => {
    if (!user || !partnerId || !channelName) return;
    if (sessionRole !== "solo") return;
    let dismissed = false;
    const announceInvite = () => {
      if (dismissed) return;
      setPartnerInviteActive(true);
    };
    const attemptProbe = (attempt: number) => {
      ensureRealtimeAuth().then(() => {
        if (dismissed) return;
        const probe = supabase.channel(channelName, { config: { broadcast: { self: false }, private: true } })
          .on("broadcast", { event: "join" }, ({ payload }) => {
            if (payload?.role === "host") announceInvite();
          })
          // A host is the only role that ever sends these — either one arriving
          // is proof a session is live, even if we missed the "join" heartbeat.
          .on("broadcast", { event: "tick" }, () => announceInvite())
          .on("broadcast", { event: "load" }, () => announceInvite())
          .subscribe((status) => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
              if (dismissed || probeRef.current !== probe) return;
              probeRef.current = null; // detach first: removeChannel re-emits CLOSED into this callback
              try { void supabase.removeChannel(probe); } catch { /* already gone */ }
              if (attempt < 1) attemptProbe(attempt + 1);
            }
          });
        probeRef.current = probe;
      });
    };
    attemptProbe(0);
    return () => {
      dismissed = true;
      if (probeRef.current) { supabase.removeChannel(probeRef.current); probeRef.current = null; }
    };
  }, [user, partnerId, channelName, sessionRole, ensureRealtimeAuth]);

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

  const value: GroicAPI = useMemo(() => ({
    current, queue, isPlaying, buffering, volume,
    repeatMode, shuffle, autoNext, loading, error, expanded, hidden,
    sessionRole, partnerListening, partnerInviteActive,
    playTrack, toggle, play, pause, next, prev, seek, setVolume, setRepeatMode, toggleShuffle, toggleAutoNext,
    enqueue, playNext, removeFromQueue, clearQueue,
    expand: setExpanded, hide, show, close,
    startSession, endSession,
    joinPartnerSession, dismissPartnerInvite, warmStreams,
  }), [
    current, queue, isPlaying, buffering, volume,
    repeatMode, shuffle, autoNext, loading, error, expanded, hidden,
    sessionRole, partnerListening, partnerInviteActive,
    playTrack, toggle, play, pause, next, prev, seek, setVolume, setRepeatMode, toggleShuffle, toggleAutoNext,
    enqueue, playNext, removeFromQueue, clearQueue,
    setExpanded, hide, show, close,
    startSession, endSession,
    joinPartnerSession, dismissPartnerInvite,
  ]);

  const progress: GroicProgress = useMemo(() => ({ position, duration }), [position, duration]);

  return (
    <GroicContext.Provider value={value}>
      <GroicProgressContext.Provider value={progress}>{children}</GroicProgressContext.Provider>
    </GroicContext.Provider>
  );
};

export { extractYouTubeId };
