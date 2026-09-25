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
import { Capacitor } from "@capacitor/core";
import { PushNotifications } from "@capacitor/push-notifications";
import { DuospaceAudioEngine } from "duospace-audio-engine";
import { logInfo, logWarn, logError } from "@/lib/telemetry";
import type {
  AudioEngineTrack, AudioEngineState, AudioEnginePlaybackState,
  PlaybackStateChangedEvent, TrackChangedEvent, PositionChangedEvent,
  ErrorEvent as AudioEngineErrorEvent, AudioInterruptionEvent,
  WebKeepAliveMeta, WebKeepAliveStateUpdate, WebKeepAliveCommandEvent,
  NotificationIssueEvent,
} from "duospace-audio-engine";
import { GroicTrack } from "./types";

export type {
  AudioEngineState, AudioEnginePlaybackState,
  PlaybackStateChangedEvent, TrackChangedEvent, PositionChangedEvent,
  AudioEngineErrorEvent, AudioInterruptionEvent,
  WebKeepAliveMeta, WebKeepAliveStateUpdate, WebKeepAliveCommandEvent,
  NotificationIssueEvent,
};

export const trackToEngineTrack = (t: GroicTrack): AudioEngineTrack => ({
  id: t.id,
  title: t.title,
  artist: t.artist,
  artworkUrl: t.thumbnail ?? t.artwork ?? undefined,
  streamUrl: t.streamUrl ?? "",
  durationHint: t.duration,
});

// Android 13+ won't show ANY notification (including the music controls) until
// POST_NOTIFICATIONS is granted, and the app only ever asked once, at sign-in.
// Ask again — once per app session, only while the answer is still "prompt" —
// the first time music actually starts. Never blocks or fails playback.
let notificationPermissionChecked = false;
const ensureNotificationPermission = async (): Promise<void> => {
  // DIAGNOSTIC: this single line, if it's ever missing from the console,
  // means playback started without the permission check running at all —
  // e.g. this module never got imported/called on this code path.
  logInfo("music.notificationPermission", "ensureNotificationPermission called", {
    platform: Capacitor.getPlatform(),
    isNative: Capacitor.isNativePlatform(),
    alreadyChecked: notificationPermissionChecked,
  });
  if (notificationPermissionChecked || !Capacitor.isNativePlatform()) return;
  notificationPermissionChecked = true;
  try {
    const status = await PushNotifications.checkPermissions();
    logInfo("music.notificationPermission", "current status", { receive: status.receive });
    if (status.receive === "prompt" || status.receive === "prompt-with-rationale") {
      const result = await PushNotifications.requestPermissions();
      logInfo("music.notificationPermission", "requested — result", { receive: result.receive });
    } else if (status.receive === "denied") {
      // DIAGNOSTIC: this is the #1 real-world cause of "no music
      // notifications at all" — the OS will not show ANY notification,
      // including play/pause controls, once this is "denied", and Android
      // only lets an app ask once; after a denial the person has to grant
      // it manually in system settings (nativeEngine.openNotificationSettings
      // — GroicContext's onNotificationIssue toast already offers this).
      logWarn("music.notificationPermission", "POST_NOTIFICATIONS is denied — no notification will show until the user grants it in system settings");
    }
  } catch (e) {
    logError("music.notificationPermission", "permission check/request threw", e);
    /* permission plumbing must never affect playback */
  }
};

export const nativeEngine = {
  ensureNotificationPermission,
  openNotificationSettings: () => DuospaceAudioEngine.openNotificationSettings(),
  onNotificationIssue: (cb: (e: NotificationIssueEvent) => void) =>
    DuospaceAudioEngine.addListener("notificationIssue", cb),
  // DIAGNOSTIC counterpart — see AudioEnginePlugin.kt / MediaPlaybackService.kt.
  onNotificationVisible: (cb: () => void) =>
    DuospaceAudioEngine.addListener("notificationVisible", cb),
  load: (track: GroicTrack, autoplay: boolean) => {
    // DIAGNOSTIC: if this line never appears in the console for a track
    // that should be natively streamable, GroicContext isn't calling into
    // the native engine at all for it — the bug is in track routing
    // (isNativelyStreamable / provider detection), not in playback or
    // notifications, and nothing below this file can be at fault.
    logInfo("music.nativeEngine", "load()", { id: track.id, provider: track.provider, autoplay });
    return DuospaceAudioEngine.load({ track: trackToEngineTrack(track), autoplay });
  },
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
