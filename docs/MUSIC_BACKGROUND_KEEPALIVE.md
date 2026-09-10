# Background playback for YouTube-provider tracks ("web keep-alive")

## The ask, and what this deliberately does not do

The request behind this pass was "all music should be able to play in
the background, like Brave" — i.e. close the one remaining gap where a
YouTube-provider track (searched/played via the existing hidden IFrame,
see `docs/MUSIC_NATIVE_PLAYBACK.md`) doesn't reliably survive the
installed Android app being backgrounded, the way Audius/SoundCloud
tracks already do via the real native audio engine.

**This is a generic Android process-suspension problem, not a YouTube-
specific restriction to route around.** Backgrounding a browser tab that
is actively producing audio does not stop playback on desktop or Android
Chrome/Firefox/Edge/Samsung Internet — confirmed and already relied on
elsewhere in this codebase (`web.ts`'s header, and the "silent Media
Session anchor" trick in `GroicContext.tsx` that keeps a Chromium tab
classified as "producing audio" specifically so it isn't throttled). The
actual gap is narrower: the **installed Capacitor app's own WebView**
inside a real Android process, which the OS is free to freeze while
backgrounded unless something tells it "this process is actively doing
background media work" — the same reason `MediaPlaybackService` exists
for Audius/SoundCloud at all.

So this pass does the same thing Brave's own Android background-play
protection does under the hood: keep the process/WebView alive via a
foreground service with a real notification, so whatever is already
playing (the YouTube IFrame, unmodified) keeps running. It does **not**
extract, scrape, download, proxy, or otherwise read YouTube's actual
audio stream — that hard boundary from `docs/MUSIC_NATIVE_PLAYBACK.md`
(`isNativelyStreamable()` returns `true` only for Audius/SoundCloud) is
completely unchanged by this pass. Nothing here reaches into YouTube's
player internals, overrides its own JS behavior, or does anything a
person couldn't already do by pinning a tab and leaving it running.

## Design

A second, fully independent foreground service/session — separate from
`MediaPlaybackService` (the real ExoPlayer/AVPlayer engine for Audius/
SoundCloud) — that owns no audio at all:

- **Android**: `WebKeepAliveService.kt`, a `MediaSessionService` backed
  by `androidx.media3.common.SimpleBasePlayer` (Media3's own supported
  API for publishing a real `MediaSession` whose reported state is
  driven by something other than Media3 itself). Its `state` is whatever
  GroicContext last pushed via `updateWebKeepAlive()`; every command a
  real player would normally execute locally (play/pause/seek/skip) is
  instead forwarded to JS as a `webKeepAliveCommand` event.
- **iOS**: no second AVPlayer — `AudioEnginePlugin.swift` gained an
  `isWebKeepAliveActive` mode that activates the same `.playback`
  `AVAudioSession` category real playback already uses, and writes
  `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter` state directly from
  JS-pushed values instead of from a `player`/`AVPlayerItem`. This is
  supplementary to `navigator.mediaSession` (which WebKit already bridges
  to `MPNowPlayingInfoCenter` on its own) and to the `audio`
  `UIBackgroundModes` entry already declared app-wide.
- **Web**: no-op — see `web.ts`'s and `definitions.ts`'s comments on why
  a browser tab doesn't need this.

`GroicContext.tsx` starts keep-alive mode when the current track is
`youtube` and playing (native platforms only), stops it on pause/end/
provider-switch, pushes position/duration on the existing YouTube poll's
own cadence (no new polling added), and routes `webKeepAliveCommand`
events to the exact same `play()`/`pause()`/`next()`/`prev()`/`seek()`
already used for in-app buttons and the `navigator.mediaSession`
handlers — see `GroicContext.tsx`'s "Android/iOS background 'keep-alive'"
section for the actual wiring.

## Files touched

```
native-plugins/audio-engine/src/definitions.ts     WebKeepAliveMeta/StateUpdate/CommandEvent types,
                                                     startWebKeepAlive/updateWebKeepAlive/stopWebKeepAlive
native-plugins/audio-engine/src/web.ts              no-op implementations
native-plugins/audio-engine/android/.../WebKeepAliveService.kt   new — SimpleBasePlayer-backed MediaSessionService
native-plugins/audio-engine/android/.../AudioEnginePlugin.kt     start/update/stop + bind/forward commands
native-plugins/audio-engine/android/src/main/AndroidManifest.xml  registers WebKeepAliveService
native-plugins/audio-engine/ios/Plugin/AudioEnginePlugin.swift    isWebKeepAliveActive mode, 3 new plugin methods
src/lib/music/nativeAudioEngine.ts                  thin wrapper methods
src/contexts/GroicContext.tsx                       start/stop/update wiring + command routing
```

## Verification status — read before shipping

**Not compiled or run.** Same limitation this repo's other native-plugin
work has been explicit about (see `MUSIC_NATIVE_PLAYBACK.md`'s own build-
requirements section): no Android SDK, no Xcode, no device/emulator were
available in this working environment. Treat the Kotlin/Swift here as a
structurally complete first draft against the real Media3
(`SimpleBasePlayer`, 1.4.1) and AVFoundation/MediaPlayer APIs, not as
verified/tested code. In particular:

- `WebKeepAliveService.kt`'s `SimpleBasePlayer.State`/`MediaItemData`
  builder call shapes should be checked against the exact Media3 1.4.1
  API (this class's surface has changed across recent Media3 versions)
  before a real build.
- Neither platform's notification/lock-screen behavior, nor the
  Android foreground-service-start timing edge cases already documented
  for `MediaPlaybackService`'s own `bindToService()`, have been exercised
  on a device here.
- The TypeScript side (`GroicContext.tsx`, `nativeAudioEngine.ts`,
  `definitions.ts`, `web.ts`) follows the same patterns as the
  already-working Audius/SoundCloud wiring it sits next to, but has not
  been run through `tsc`/a dev server in this pass.

## Known limitations

- **iOS**: whether the WKWebView's own audio survives backgrounding as
  reliably as the Android fix closes its gap is not independently
  confirmed here — `UIBackgroundModes: audio` was already declared
  app-wide before this pass (for calls, reused for Audius/SoundCloud), so
  the marginal addition here is mainly the explicit `.playback` session
  activation + Now Playing registration for a YouTube track specifically,
  not a first-time background-audio capability grant.
- **Two "now playing" surfaces on iOS could theoretically race** if
  keep-alive and a real `player` session were ever both active — guarded
  against by `GroicContext`'s existing single-current-track model (a
  YouTube track and an Audius/SoundCloud track are never "current"
  simultaneously) rather than by anything in this plugin enforcing
  mutual exclusion itself.
- **This does not and cannot guarantee indefinite background survival** —
  Android's Doze/App Standby and manufacturer-specific battery
  optimizations can still kill a foreground service under aggressive
  enough settings on some OEM skins; a foreground service with a real
  notification is the standard, correct mitigation, not an absolute
  guarantee.
