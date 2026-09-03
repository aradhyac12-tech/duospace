# duospace-audio-engine

Local Capacitor plugin: native background-capable audio playback for
DuoSpace's music player (Audius tracks only — see below).

## What this plugin is for

Exactly one job: play a **resolved, direct audio stream URL** with real
OS-level background playback, lock-screen controls, notification media
controls, and Bluetooth/headset command support. It has no concept of
"Audius" or "YouTube" — `GroicContext` resolves an Audius track to a
playable stream URL first (via `src/lib/music/audiusProvider.ts`) and only
then calls `load()`/`play()` here.

## What this plugin is explicitly NOT for

**YouTube tracks never reach this plugin.** DuoSpace does not extract,
scrape, download, or proxy audio out of YouTube videos — that's illegal
and was explicit out of scope for this feature. YouTube tracks continue
to play through the existing hidden YouTube IFrame player in
`GroicContext.tsx`, completely unchanged by this plugin's existence. See
`docs/MUSIC_NATIVE_PLAYBACK.md` for the full architecture and exactly
where that boundary is enforced in code
(`isNativelyStreamable()` in `src/lib/music/types.ts`).

## Platform implementations

- **Android** (`android/`): `androidx.media3` (ExoPlayer) running inside a
  `MediaSessionService` foreground service. ExoPlayer's own
  `handleAudioFocus`/`setHandleAudioBecomingNoisy` options are used for
  audio-focus and headset-unplug handling rather than hand-rolled
  `AudioManager` listeners — see `MediaPlaybackService.kt`'s header
  comment for why.
- **iOS** (`ios/Plugin/`): `AVPlayer` + `AVAudioSession(.playback)` +
  `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter`. Coordinates with the
  existing calling feature's own `AVAudioSession` usage (Daily.co's
  WebRTC engine, activated via `native-plugins/audio-route`) rather than
  fighting it for the session — see `AudioEnginePlugin.swift`'s header.
- **Web** (`src/web.ts`): a real `HTMLAudioElement` + the standard
  `navigator.mediaSession` API — genuinely functional on desktop
  browsers and Android Chrome, but iOS Safari doesn't support
  `MediaSession` at all and a background browser tab has no
  foreground-service-equivalent protection against being suspended. This
  is exactly why the native platforms exist — see `src/web.ts`'s header
  for the full explanation.

## Cost

Media3/ExoPlayer (Android) and AVFoundation/MediaPlayer (iOS) are both
free/open-source or built into the OS SDK — no license fees, no paid SDK,
consistent with this feature's $0 infrastructure requirement.

## Setup

Not yet part of an existing `android/`/`ios/` project — see
`docs/MUSIC_NATIVE_PLAYBACK.md` for how this plugin gets wired in once
`npx cap add android`/`npx cap add ios` has been run, following the exact
same "generated, not committed" pattern documented in
`docs/IOS_NATIVE_SETUP.md` for this repo's other native plugins.
