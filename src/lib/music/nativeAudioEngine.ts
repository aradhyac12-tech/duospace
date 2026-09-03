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
} from "duospace-audio-engine";
import { GroicTrack } from "./types";
import { logWarn } from "@/lib/telemetry";

export type {
  AudioEngineState, AudioEnginePlaybackState,
  PlaybackStateChangedEvent, TrackChangedEvent, PositionChangedEvent,
  AudioEngineErrorEvent, AudioInterruptionEvent,
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
    engineCall("load", () => DuospaceAudioEngine.load({ track: trackToEngineTrack(track), autoplay })),
  play: () => engineCall("play", () => DuospaceAudioEngine.play()),
  pause: () => engineCall("pause", () => DuospaceAudioEngine.pause()),
  resume: () => engineCall("resume", () => DuospaceAudioEngine.resume()),
  stop: () => engineCall("stop", () => DuospaceAudioEngine.stop()),
  seek: (positionSeconds: number) => engineCall("seek", () => DuospaceAudioEngine.seek({ positionSeconds })),
  next: () => engineCall("next", () => DuospaceAudioEngine.next()),
  previous: () => engineCall("previous", () => DuospaceAudioEngine.previous()),
  setQueue: (tracks: GroicTrack[], startIndex = 0) =>
    engineCall("setQueue", () => DuospaceAudioEngine.setQueue({ tracks: tracks.map(trackToEngineTrack), startIndex })),
  getState: () => DuospaceAudioEngine.getState(),
  setVolume: (volume: number) => engineCall("setVolume", () => DuospaceAudioEngine.setVolume({ volume })),

  onPlaybackStateChanged: (cb: (e: PlaybackStateChangedEvent) => void) =>
    DuospaceAudioEngine.addListener("playbackStateChanged", cb),
  onTrackChanged: (cb: (e: TrackChangedEvent) => void) =>
    DuospaceAudioEngine.addListener("trackChanged", cb),
  onPositionChanged: (cb: (e: PositionChangedEvent) => void) =>
    DuospaceAudioEngine.addListener("positionChanged", cb),
  onDurationChanged: (cb: (e: { durationSeconds: number }) => void) =>
    DuospaceAudioEngine.addListener("durationChanged", cb),
  onBufferingChanged: (cb: (e: { buffering: boolean }) => void) =>
    DuospaceAudioEngine.addListener("bufferingChanged", cb),
  onPlaybackEnded: (cb: () => void) =>
    DuospaceAudioEngine.addListener("playbackEnded", cb),
  onError: (cb: (e: AudioEngineErrorEvent) => void) =>
    DuospaceAudioEngine.addListener("error", cb),
  onAudioInterruption: (cb: (e: AudioInterruptionEvent) => void) =>
    DuospaceAudioEngine.addListener("audioInterruption", cb),
  onHeadsetDisconnected: (cb: () => void) =>
    DuospaceAudioEngine.addListener("headsetDisconnected", cb),
};

function engineCall<T>(operation: string, action: () => Promise<T>): Promise<T> {
  return action().catch((error: unknown) => {
    logWarn("music.engine", `${operation} failed`);
    throw error;
  });
}
