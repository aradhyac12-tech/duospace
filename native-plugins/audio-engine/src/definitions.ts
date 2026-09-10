/**
 * DuospaceAudioEngine — the native background-audio-capable player.
 *
 * This plugin exists for exactly one job: play a resolved, direct audio
 * stream URL (Audius tracks only — see the top-level README in this
 * folder) with real OS-level background playback, lock-screen controls,
 * notification media controls, and Bluetooth/headset command support.
 * It has no idea what "Audius" or "YouTube" means — GroicContext resolves
 * a track to a playable stream URL first (via the Audius provider
 * adapter) and only then calls `load()`/`play()` here. YouTube tracks
 * never reach this plugin at all; they stay on the existing hidden
 * IFrame player in GroicContext, unchanged by this plugin's existence.
 *
 * Android: backed by a MediaSessionService (androidx.media3 / ExoPlayer)
 * running in a foreground service — see android/.../MediaPlaybackService.kt.
 * iOS: backed by AVPlayer + AVAudioSession(.playback) +
 * MPNowPlayingInfoCenter + MPRemoteCommandCenter — see
 * ios/Plugin/AudioEnginePlugin.swift.
 * Web: HTMLAudioElement + the standard MediaSession API (real, but
 * necessarily more limited than the native platforms — see web.ts's
 * header for exactly what web can and can't do).
 */
import type { PluginListenerHandle } from "@capacitor/core";

export interface AudioEngineTrack {
  /** Opaque id GroicContext uses for its own queue bookkeeping — round-
   *  tripped back in every event payload so the JS side never has to
   *  guess which track an event refers to. Not interpreted natively. */
  id: string;
  title: string;
  artist: string;
  /** Absolute, publicly-fetchable artwork URL — the native side downloads
   *  this itself for the lock-screen/notification artwork bitmap. */
  artworkUrl?: string;
  /** The actual playable audio URL (Audius's resolved stream URL). */
  streamUrl: string;
  /** Seconds, if known ahead of time — used to seed the lock-screen
   *  scrubber before the real player reports a duration. Advisory only;
   *  overwritten the moment the native player determines the real value. */
  durationHint?: number;
}

export type AudioEnginePlaybackState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export interface AudioEngineState {
  state: AudioEnginePlaybackState;
  currentTrackId: string | null;
  positionSeconds: number;
  durationSeconds: number;
  buffering: boolean;
  volume: number;
}

export interface SetQueueOptions {
  tracks: AudioEngineTrack[];
  /** Index into `tracks` to start at — does NOT itself start playback;
   *  follow with play() if autoplay is wanted. */
  startIndex?: number;
}

export interface SeekOptions { positionSeconds: number; }
export interface SetVolumeOptions { volume: number; } // 0..1
export interface LoadOptions { track: AudioEngineTrack; autoplay?: boolean; }

export interface PlaybackStateChangedEvent { state: AudioEnginePlaybackState; }
export interface TrackChangedEvent { trackId: string | null; index: number; }
export interface PositionChangedEvent { positionSeconds: number; durationSeconds: number; }
export interface DurationChangedEvent { durationSeconds: number; }
export interface BufferingChangedEvent { buffering: boolean; }
export interface ErrorEvent { message: string; trackId: string | null; }
/** `reason` distinguishes a call/other-app taking focus (`began`, pause
 *  and DON'T assume playback resumes on its own) from a transient
 *  interruption the OS itself may auto-resume after (`endedShouldResume`)
 *  — see AudioEnginePlugin's platform files for exactly when each fires. */
export interface AudioInterruptionEvent { reason: "began" | "endedShouldResume" | "endedShouldNotResume"; }

/**
 * "Keep-alive" mode — added so a YouTube-provider track (which stays on
 * the existing hidden IFrame player in GroicContext, per this plugin's
 * top-of-file doc comment and docs/MUSIC_NATIVE_PLAYBACK.md's hard
 * boundary) can still survive Android backgrounding, WITHOUT this plugin
 * ever touching YouTube's audio itself.
 *
 * This is deliberately NOT another player: on Android, startWebKeepAlive()
 * spins up a second, separate foreground service (WebKeepAliveService,
 * see that file) that owns a `androidx.media3.common.SimpleBasePlayer` —
 * a real android.media.session.MediaSession backed by a Player whose
 * state is entirely mirrored from what GroicContext already knows about
 * the IFrame (position/duration/playing, pushed via updateWebKeepAlive()),
 * not by any ExoPlayer instance actually decoding audio. Its only real
 * jobs: (1) hold a `foregroundServiceType="mediaPlayback"` foreground
 * service + notification so Android does not freeze the app process's
 * JS/WebView while a YouTube track is the one playing, exactly the same
 * OS mechanism MediaPlaybackService already uses for Audius/SoundCloud
 * tracks; and (2) publish real lock-screen/notification/Bluetooth
 * play/pause/next/previous/seek controls that call back into JS as
 * `webKeepAliveCommand` events, which GroicContext routes to the IFrame
 * exactly the way it already routes its own in-app button taps
 * (playVideo()/pauseVideo()/etc via the YouTube IFrame API) — never a
 * direct audio operation performed by this plugin.
 *
 * On iOS, startWebKeepAlive() activates `AVAudioSession(.playback)` (see
 * AudioEnginePlugin.swift) so the OS treats the app as an active
 * background-audio app while a YouTube track is playing — supplementary
 * to (not a replacement for) `navigator.mediaSession`, which WebKit
 * already bridges to `MPNowPlayingInfoCenter` on its own for a track
 * GroicContext registers via the web Media Session API (see
 * GroicContext's own single-owner-of-navigator.mediaSession comment).
 * `UIBackgroundModes` already includes `audio` app-wide (see
 * scripts/patch-native-permissions.mjs) for the calling feature and the
 * native engine, reused here rather than adding a second entry.
 *
 * On web, these are no-ops (see web.ts) — the existing silent-audio
 * MediaSession anchor + `navigator.mediaSession` wiring in GroicContext
 * already keeps a Chromium tab classified as "producing audio" (which is
 * what prevents the OS/browser from throttling it), and desktop/Android
 * browser tabs are already documented as reliable for this. Keep-alive
 * mode exists specifically for the installed Capacitor app's own
 * process-level suspension risk, which a browser tab doesn't have.
 */
export interface WebKeepAliveMeta {
  title: string;
  artist: string;
  artworkUrl?: string;
}
export interface WebKeepAliveStateUpdate {
  playing: boolean;
  positionSeconds: number;
  durationSeconds: number;
  /** Only sent when metadata actually changed (a new YouTube track became
   *  current) — omitted on plain position ticks so the native side isn't
   *  re-parsing/re-downloading artwork every second. */
  meta?: WebKeepAliveMeta;
}
export type WebKeepAliveAction = "play" | "pause" | "next" | "previous" | "seek";
/** A remote command arriving while keep-alive mode is active. GroicContext
 *  is the only listener and forwards it to the YouTube IFrame API exactly
 *  like an in-app button tap — this plugin never decides playback itself
 *  in this mode, only reports what the OS/Bluetooth/lock-screen asked
 *  for. `positionSeconds` is only present for `action: "seek"`. */
export interface WebKeepAliveCommandEvent { action: WebKeepAliveAction; positionSeconds?: number; }

export interface DuospaceAudioEnginePlugin {
  /** Loads a track (replacing any current one) and optionally starts
   *  playback immediately. Does not touch the queue — call setQueue()
   *  separately for next()/previous() to have anywhere to go. */
  load(options: LoadOptions): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Alias kept distinct from play() at the JS boundary (matching the
   *  brief's requested API) even though both currently resolve to the
   *  same native "resume playback" call — resume() is what a "restore
   *  after interruption" flow should call, so intent stays clear at the
   *  call site even though the native effect is identical today. */
  resume(): Promise<void>;
  stop(): Promise<void>;
  seek(options: SeekOptions): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  setQueue(options: SetQueueOptions): Promise<void>;
  getState(): Promise<AudioEngineState>;
  getPosition(): Promise<{ positionSeconds: number }>;
  getDuration(): Promise<{ durationSeconds: number }>;
  setVolume(options: SetVolumeOptions): Promise<void>;

  /** Starts keep-alive mode for a YouTube-provider track — see the doc
   *  comment above this interface for exactly what this does and does
   *  not do. Call once when a YouTube track becomes the current, playing
   *  track; harmless to call again while already active (updates the
   *  displayed metadata in place rather than restarting the service). */
  startWebKeepAlive(options: { meta: WebKeepAliveMeta }): Promise<void>;
  /** Pushes GroicContext's own position/duration/playing state (already
   *  polled from the YouTube IFrame at its existing ~500ms/1s rates — see
   *  GroicContext.tsx) so the lock-screen scrubber and play/pause icon
   *  stay accurate. Cheap to call frequently; the native side does not
   *  re-render its notification on every position-only update. */
  updateWebKeepAlive(options: WebKeepAliveStateUpdate): Promise<void>;
  /** Stops keep-alive mode and tears down its foreground service/audio
   *  session — call when the YouTube track pauses, ends, or the current
   *  track switches to a natively-streamable provider (which has its own
   *  foreground service via MediaPlaybackService and must not overlap
   *  with this one; GroicContext's existing single-current-track model
   *  already guarantees the two are never both wanted at once). Safe to
   *  call when not active. */
  stopWebKeepAlive(): Promise<void>;

  addListener(eventName: "webKeepAliveCommand", listenerFunc: (event: WebKeepAliveCommandEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "playbackStateChanged", listenerFunc: (event: PlaybackStateChangedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "trackChanged", listenerFunc: (event: TrackChangedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "positionChanged", listenerFunc: (event: PositionChangedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "durationChanged", listenerFunc: (event: DurationChangedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "playbackEnded", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "bufferingChanged", listenerFunc: (event: BufferingChangedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "error", listenerFunc: (event: ErrorEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: "audioInterruption", listenerFunc: (event: AudioInterruptionEvent) => void): Promise<PluginListenerHandle>;
  /** Fired when the OS reports the active output route changed to/from a
   *  Bluetooth device — distinct from audioInterruption (a Bluetooth
   *  disconnect is a route change, not necessarily a focus loss). */
  addListener(eventName: "headsetConnected", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "headsetDisconnected", listenerFunc: () => void): Promise<PluginListenerHandle>;
  /** Fired when the OS-level media session receives a remote command this
   *  plugin doesn't fully resolve itself — specifically next()/previous()
   *  from a lock-screen/Bluetooth/car-audio control. The native side does
   *  NOT know the app's queue (that's GroicContext's job); it forwards the
   *  command up as this event AND advances its own loaded queue (set via
   *  setQueue()) so the lock-screen artwork/metadata updates immediately
   *  without waiting a JS round-trip. */
  addListener(eventName: "remoteNext", listenerFunc: () => void): Promise<PluginListenerHandle>;
  addListener(eventName: "remotePrevious", listenerFunc: () => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}
