/**
 * Thin wrapper around the DuospaceAudioEngine Capacitor plugin —
 * GroicContext's single delegation point for any natively-streamable
 * (Audius) track. Works identically whether Capacitor resolves to the
 * real native Kotlin/Swift implementation or the web fallback (src/web.ts
 * in the plugin) — that's the whole point of it being a Capacitor plugin
 * rather than an `if (Capacitor.isNativePlatform())` branch scattered
 * through GroicContext itself.
 *
 * GroicContext never imports the plugin package directly — every call
 * goes through here, so there's exactly one place that knows the plugin
 * exists.
 */
import { DuospaceAudioEngine } from "duospace-audio-engine";
import type {
  AudioEngineTrack, AudioEngineState, AudioEnginePlaybackState,
  PlaybackStateChangedEvent, TrackChangedEvent, PositionChangedEvent,
  ErrorEvent as AudioEngineErrorEvent, AudioInterruptionEvent,
  WebKeepAliveMeta, WebKeepAliveStateUpdate, WebKeepAliveCommandEvent,
} from "duospace-audio-engine";
import { GroicTrack } from "./types";

export type {
  AudioEngineState, AudioEnginePlaybackState,
  PlaybackStateChangedEvent, TrackChangedEvent, PositionChangedEvent,
  AudioEngineErrorEvent, AudioInterruptionEvent,
  WebKeepAliveMeta, WebKeepAliveStateUpdate, WebKeepAliveCommandEvent,
};

export const trackToEngineTrack = (t: GroicTrack): AudioEngineTrack => ({
  id: t.id,
  title: t.title,
  artist: t.artist,
  artworkUrl: t.thumbnail ?? t.artwork ?? undefined,
  streamUrl: t.streamUrl ?? "",
  durationHint: t.duration,
});

export const nativeEngine = {
  load: (track: GroicTrack, autoplay: boolean) =>
    DuospaceAudioEngine.load({ track: trackToEngineTrack(track), autoplay }),
  play: () => DuospaceAudioEngine.play(),
  pause: () => DuospaceAudioEngine.pause(),
  resume: () => DuospaceAudioEngine.resume(),
  stop: () => DuospaceAudioEngine.stop(),
  seek: (positionSeconds: number) => DuospaceAudioEngine.seek({ positionSeconds }),
  next: () => DuospaceAudioEngine.next(),
  previous: () => DuospaceAudioEngine.previous(),
  setQueue: (tracks: GroicTrack[], startIndex = 0) =>
    DuospaceAudioEngine.setQueue({ tracks: tracks.map(trackToEngineTrack), startIndex }),
  getState: () => DuospaceAudioEngine.getState(),
  setVolume: (volume: number) => DuospaceAudioEngine.setVolume({ volume }),

  onPlaybackStateChanged: (cb: (e: PlaybackStateChangedEvent) => void) =>
    DuospaceAudioEngine.addListener("playbackStateChanged", cb),
  onTrackChanged: (cb: (e: TrackChangedEvent) => void) =>
    DuospaceAudioEngine.addListener("trackChanged", cb),
  onPositionChanged: (cb: (e: PositionChangedEvent) => void) =>
    DuospaceAudioEngine.addListener("positionChanged", cb),
  onPlaybackEnded: (cb: () => void) =>
    DuospaceAudioEngine.addListener("playbackEnded", cb),
  onError: (cb: (e: AudioEngineErrorEvent) => void) =>
    DuospaceAudioEngine.addListener("error", cb),
  onAudioInterruption: (cb: (e: AudioInterruptionEvent) => void) =>
    DuospaceAudioEngine.addListener("audioInterruption", cb),
  onHeadsetDisconnected: (cb: () => void) =>
    DuospaceAudioEngine.addListener("headsetDisconnected", cb),

  // Keep-alive mode — for YouTube-provider tracks, which never go through
  // load()/play()/etc above (those are for natively-streamable tracks
  // only). See definitions.ts's WebKeepAliveMeta doc comment for the full
  // explanation of what this does and why it exists.
  startWebKeepAlive: (meta: WebKeepAliveMeta) =>
    DuospaceAudioEngine.startWebKeepAlive({ meta }),
  updateWebKeepAlive: (update: WebKeepAliveStateUpdate) =>
    DuospaceAudioEngine.updateWebKeepAlive(update),
  stopWebKeepAlive: () => DuospaceAudioEngine.stopWebKeepAlive(),
  onWebKeepAliveCommand: (cb: (e: WebKeepAliveCommandEvent) => void) =>
    DuospaceAudioEngine.addListener("webKeepAliveCommand", cb),
};
