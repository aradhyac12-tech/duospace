# Native Music Playback — Architecture

Turns DuoSpace's music player into a real background-capable player
(lock-screen controls, notification media controls, Bluetooth/headset
commands, playback that survives leaving the app) for **Audius** tracks,
while keeping YouTube exactly where it already was: a discovery/search
provider played through the existing hidden IFrame, never touched for
audio extraction.

## Why two providers, and why they're not interchangeable

| | YouTube | Audius |
|---|---|---|
| What it's for | Search/discovery, and playing a video the person explicitly picked | Actual native background playback |
| How it plays | Existing hidden YouTube IFrame player (unchanged) | `duospace-audio-engine` native plugin |
| Can it background/lock-screen? | No — and this app does not attempt to make it do so | Yes |
| Where's the audio come from? | Never extracted — IFrame owns its own playback entirely | A real, resolvable stream URL from Audius's own API |

This is a hard boundary, not a preference: DuoSpace does not extract,
scrape, download, or proxy audio out of YouTube videos. See
`isNativelyStreamable()` in `src/lib/music/types.ts` — the one place in
the codebase that decides which engine a track uses, and it returns
`true` only for `provider === "audius"`.

## The provider-agnostic track model

`src/lib/music/types.ts` defines `GroicTrack` — every provider adapter
normalizes into this shape, so the queue, the UI, and shared listening
never branch on provider except at the two points that genuinely need to
(which engine to play through, and whether to show a provider badge in
search).

`videoId` (not renamed to something provider-neutral) is kept as the
literal field name because it's read well beyond `GroicContext` — chat's
shared-song messages, `Playlist.tsx`'s saved songs, `GroicFullPlayer`'s
queue rendering. For a non-YouTube track it just holds the same value as
`providerTrackId`, so every existing `track.videoId` read in the app kept
working unchanged through this refactor.

## Files

```
src/lib/music/
  types.ts              GroicTrack, MusicProvider, isNativelyStreamable()
  youtubeProvider.ts     normalizes music-search's YouTube results
  audiusProvider.ts       search/trending/stream-URL-resolution, via audius-search edge fn
  nativeAudioEngine.ts    thin wrapper around the duospace-audio-engine plugin
  queueLogic.ts           pure: repeat/shuffle/end-of-queue decision (unit tested)
  driftCorrection.ts      pure: shared-listening drift math (unit tested)
  queueQuality.ts         pure: "up next" dedup-by-song + shuffle (unit tested)

supabase/functions/
  audius-search/          search, trending, stream-URL resolution (proxied, see below)
  music-search/            unchanged — YouTube search
  music-trending/           unchanged except a hard 15-min cutoff on results

native-plugins/audio-engine/   the Capacitor plugin — see its own README.md
  src/definitions.ts            JS-facing API + events
  src/web.ts                    real HTMLAudio + MediaSession web fallback
  android/…MediaPlaybackService.kt   ExoPlayer + MediaSessionService (foreground service)
  android/…AudioEnginePlugin.kt      Capacitor bridge, binds to the service
  ios/Plugin/AudioEnginePlugin.swift  AVPlayer + AVAudioSession + MPNowPlayingInfoCenter

src/contexts/GroicContext.tsx    orchestration layer — see below
src/pages/Groic.tsx               search UI (All/YouTube/Audius), trending rails, language prefs
src/components/GroicFullPlayer.tsx  added shuffle/repeat controls, error display
src/components/GroicMiniPlayer.tsx   unchanged — its existing props stayed compatible
```

## GroicContext: orchestration, not the engine

`GroicContext` holds the state every consumer reads (`current`, `queue`,
`isPlaying`, `position`, `duration`, `buffering`, `volume`, `repeatMode`,
`shuffle`, shared-listening state) but does not itself own an `<audio>`
element or an `AVPlayer`. For a `youtube` track it drives the existing
hidden IFrame exactly as before. For an `audius` track it calls
`nativeEngine.*` (the plugin wrapper) and listens for its events,
translating them into the same state fields — which is why
`GroicMiniPlayer`/`GroicFullPlayer` needed no structural rewrite.

**Queue/drift logic is pure and unit-tested, not embedded in the
component.** `queueLogic.ts`'s `resolveAdvance()` is the actual
repeat-one/repeat-all/shuffle/end-of-queue decision; `driftCorrection.ts`'s
`computeDrift()` is the actual shared-listening sync math. `GroicContext`
calls these rather than reimplementing the branching inline — see
`src/test/musicQueueLogic.test.ts` and `musicDriftCorrection.test.ts`.

## Audius integration

`supabase/functions/audius-search/index.ts` handles search, trending, and
stream-URL resolution. Audius's read API needs no secret credential — only
an `app_name` identifier string (not sensitive, per Audius's own docs) —
but this is still proxied through Supabase rather than called directly
from the client, for the same reasons `music-search` already is:
consistent auth/rate-limiting, and one place to swap discovery-node hosts
if one goes down (mirrors the existing Piped/Invidious multi-host
fallback for YouTube).

`AUDIUS_APP_NAME` is read from an env var (defaults to `"DuoSpace"`) —
not hard-coded, even though it isn't a secret, for the same "one place to
change it" reasoning the rest of this codebase already follows.

A track Audius marks `is_streamable: false` (uploader disabled streaming,
region restriction, etc.) is filtered out of search/trending results
entirely — never queued, never presented as playable. If stream-URL
resolution fails for any other reason (network, a track since taken
down), `resolveAudiusStreamUrl()` returns `null` rather than throwing, and
`GroicContext.playTrack()` surfaces that as `error` state instead of ever
showing a false "playing" state — see `GroicFullPlayer.tsx`'s error
banner.

## The native engine plugin

See `native-plugins/audio-engine/README.md` for the full per-platform
breakdown. Summary:

- **Android**: `androidx.media3` (ExoPlayer) inside a `MediaSessionService`
  foreground service. Audio focus and "audio becoming noisy" (headset
  unplugged) handling come from ExoPlayer's own built-in options
  (`handleAudioFocus`, `setHandleAudioBecomingNoisy`) rather than
  hand-rolled `AudioManager` listeners — see that file's header comment
  for why using the library's own correct implementation beats a second,
  parallel one.
- **iOS**: `AVPlayer` + `AVAudioSession(.playback)` +
  `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter`. Coordinates with the
  existing calling feature's own `AVAudioSession` usage (Daily.co, via
  `native-plugins/audio-route`) rather than fighting it for the session —
  an interruption (a call starting) is treated as "pause and back off,"
  never "re-assert `.playback` over the call."
- **Web**: real `HTMLAudioElement` + the standard `navigator.mediaSession`
  API. Functional on desktop and Android Chrome; iOS Safari has no
  `MediaSession` support and no foreground-service-equivalent protection
  for a backgrounded tab — which is exactly why the native platforms
  exist. See `src/web.ts`'s header for the full explanation.

Position updates are throttled to 1 event/second on every platform
(matching comments in `MediaPlaybackService.kt`/`AudioEnginePlugin.swift`/
`web.ts`) — never per-frame, so React never re-renders faster than a
person can perceive from a position update.

## Lock-screen / notification media controls (both providers)

**Update (2026-09-04):** notification/lock-screen controls used to only
work for Audius tracks — the native engine (`nativeAudioEngine.ts` /
`web.ts`) owned `navigator.mediaSession` around its own `<audio>` element,
but nothing wired it for YouTube tracks, which is most real play sessions
since YouTube is the default "All Music" search provider. That's the "no
song notification" gap, not a bug in the native-engine path, which was
already correct.

Fixed by making `GroicContext` the single owner of `navigator.mediaSession`
for the whole app, covering both providers:

- Metadata (`title`/`artist`/`artwork`) and `playbackState` update on every
  track change/play/pause, for whichever provider is current.
- `setPositionState()` keeps the notification's scrub bar in sync (throttled
  to the existing 1×/second position tracking already running for each
  provider — no new polling added).
- Action handlers (`play`/`pause`/`nexttrack`/`previoustrack`/`seekto`/
  `seekforward`/`seekbackward`) call GroicContext's own `play()`/`pause()`/
  `next()`/`prev()`/`seek()`, which already branch on
  `isNativelyStreamable()` — for a YouTube track this calls the existing YT
  IFrame API's `playVideo()`/`pauseVideo()`/`seekTo()` (same calls
  `toggle()`/`advanceNext()` already used), describing what's playing to the
  OS and forwarding OS/Bluetooth commands to controls the player already
  exposes. **This still never extracts, proxies, or reads YouTube's actual
  audio stream** — the hard boundary above is unchanged; only playback
  metadata and remote-control routing are new.
- `native-plugins/audio-engine/src/web.ts` no longer sets
  `navigator.mediaSession.metadata`/`setActionHandler` itself (it used to,
  scoped to its own element) — GroicContext is now the single source of
  truth so the two don't race to set the same global. It still keeps
  `playbackState`/`setPositionState` in sync with its own element, which is
  harmless.

**Platform reality:**
- Desktop browser tabs and Android Chrome/Firefox/Edge/Samsung Internet:
  real OS notification, working play/pause/next/previous/seek, for both
  providers.
- iOS Safari: `navigator.mediaSession` is supported (Baseline since Sept
  2021), so controls work while the tab is open; WebKit's background-tab
  suspension policy (see `web.ts`'s header) still limits how long that
  survives backgrounded/locked — an unresolved WebKit platform issue, not
  fixable from this app's code.
- Inside the installed Capacitor app: Audius tracks get a real, durable
  background notification from the native engine (`MediaSessionService` on
  Android, `MPNowPlayingInfoCenter` on iOS) that survives backgrounding/
  locking. A YouTube track playing in the app's WebView gets the same
  `navigator.mediaSession` wiring and can show a notification while the
  WebView is alive, but Android can suspend a backgrounded WebView's JS/
  audio without the foreground-service protection a native player gets —
  so a locked-screen YouTube session inside the installed app isn't
  guaranteed to survive as long as an Audius one. This is a WebView
  platform constraint; closing this gap fully for YouTube specifically
  would require extracting its audio into the native engine, which this
  app deliberately does not do.

## Call coordination

A Daily.co call takes priority over music. `GroicContext` watches
`useCall()`'s `callState` and proactively pauses the native engine when a
call becomes active (`joining`/`joined`) — this is explicit, in-app
coordination, not reliance on the OS-level interruption mechanism alone,
because the call and the music player run in the same app process and
don't naturally cross-interrupt each other the way two separate apps
would. Deliberately does **not** auto-resume when the call ends, matching
the same "let the person decide" reasoning used for the native plugin's
own `audioInterruption` handling (see `definitions.ts`'s doc comment).

## Shared listening

Unchanged in its core design (a Supabase Realtime broadcast channel keyed
by the couple; host ticks position/state periodically, guest
drift-corrects), but broadcast payloads now carry `provider` and
`providerTrackId`. A guest **re-resolves the same provider track locally**
rather than trusting a stream URL the host already resolved — Audius
stream URLs are per-request, and this also means a guest without access
to a given track (a regional restriction, a track since taken down) fails
gracefully for *them* specifically instead of silently reusing a URL that
happened to work for the host a moment ago.

## Search UX

`Groic.tsx` adds a provider filter chip row (All Music / YouTube /
Audius) shown while actively searching. Selecting a YouTube result uses
the existing permitted YouTube player behavior; selecting an Audius
result plays it natively. Both render through the same card treatment —
no separate visual language per provider beyond a section label.

## Environment variables

| Variable | Required? | Purpose |
|---|---|---|
| `AUDIUS_APP_NAME` | No (defaults to `"DuoSpace"`) | Sent to Audius's API as a non-secret app identifier |

No Audius API key/secret is required for the read operations this
feature uses (search, trending, stream-URL resolution) — see
`audius-search/index.ts`'s header comment for the specifics of what
Audius's own docs say is and isn't sensitive here.

## Build requirements

- This plugin follows the exact same "generated, not committed" native
  project pattern already documented in `docs/IOS_NATIVE_SETUP.md` for
  this repo's other native plugins — `android/`/`ios/` don't exist in
  source control; `npx cap add android`/`npx cap add ios` generates them,
  then `npm run cap:sync` (which runs `scripts/patch-native-permissions.mjs`)
  wires in the required manifest/`Info.plist` entries.
- `duospace-audio-engine` (like `duospace-audio-route` before it) needs
  its own build step before the app can import it —
  `cd native-plugins/audio-engine && npm install && npm run build`.
- **Everything in `native-plugins/audio-engine/android/` and `ios/` was
  written to the real Media3/AVFoundation APIs but could not be compiled
  or run in this working environment** — no Android SDK, no Xcode, no
  device/emulator were available. Treat the native Kotlin/Swift as a
  structurally complete first draft ready for a real native build, not
  as verified/tested code. Everything in `src/lib/music/` and
  `src/contexts/GroicContext.tsx`, by contrast, was verified with `tsc`
  (syntax-level — this sandbox has no `node_modules`/network to run a
  full typed build either) and the pure logic modules have real unit
  tests in `src/test/`.

## Known provider limitations

- **No true "related tracks" from either provider.** YouTube's Data API
  deprecated `relatedToVideoId` years ago; there's no equivalent ML
  recommendation endpoint available from a plain API key for either
  provider. The "up next" queue fix (`queueQuality.ts`) works within that
  real constraint — dedup by song + shuffle — rather than pretending to
  replicate Spotify/YouTube Music's actual recommendation systems.
- **Haryanvi has no YouTube-recognized `relevanceLanguage` code** — that
  trending rail (`music-trending/index.ts`) relies on a targeted search
  query + region code instead of a language filter, a real API
  limitation, not an implementation gap.
- **iOS Safari (web, not the native app) cannot background/lock-screen
  audio at all** — no `MediaSession` API support, no foreground-service
  equivalent for a backgrounded tab. Native iOS (via this plugin) doesn't
  have this limitation.
- **Audius track availability varies** — a track can be marked
  non-streamable, region-restricted, or removed by its uploader at any
  time; this is handled (filtered from results, graceful `error` state on
  playback failure) but obviously can't be prevented.

## Draggable mini-player

`src/hooks/useDraggableMiniPlayer.ts` — real pointer drag, added because
the previous mini-player (`GroicMiniPlayer.tsx`) only had a mount/unmount
slide animation and could not be moved. Applies a `translate3d` offset to
the bar's DOM node directly via a ref + `requestAnimationFrame`, so a drag
never triggers a React re-render of the surrounding tree. Clamped against
safe-area insets, an approximate floating-dock clearance, and
`useKeyboardOpen()`'s current state; re-clamped on resize/orientation
change; snaps to the nearer horizontal edge on release; position persists
per-session via `sessionStorage` (`groic-mini-pos`), not `localStorage` —
deliberately not meant to survive a force-quit into a possibly very
different viewport. A drag is distinguished from a tap by a 6px movement
threshold, so the existing tap-to-expand handler is untouched and remains
the non-drag way to open the full player (accessibility requirement).

## Couple playlist ("Our Playlist") — RLS fix + realtime

**Found and fixed a real cross-couple data exposure.** Every migration
that ever touched `playlist_songs` (back to 20260308233714) shipped a
`SELECT ... USING (true)` policy — any authenticated DuoSpace user could
read *every* couple's playlist, not just their own; there was effectively
one global "Our Playlist" shared by the whole platform. Migration
`20260823120000_playlist_songs_couple_scope_and_realtime.sql` scopes
SELECT/DELETE to `added_by = auth.uid() OR added_by = get_partner_id(auth.uid())`
— the same `get_partner_id()` pattern already used for `profiles`,
`locations`, and messages — and also extends DELETE so either partner can
remove a track the other added (a genuinely joint list, matching the
brief's "A removes -> B sees / B removes -> A sees" test expectations,
not two privately-owned lists rendered together).

Realtime: the same migration adds `playlist_songs` to the
`supabase_realtime` publication (mirroring how `call_history` is already
enabled). `src/pages/Playlist.tsx` subscribes via `postgres_changes` for
INSERT/DELETE, de-duped by row id against the optimistic local insert
`addSong`/`addFromSearch` already perform (whichever arrives first wins;
the other is a no-op) — no polling. A `currentSongIdRef` (mirroring the
file's existing `songsRef` pattern) is read inside the handler instead of
the `currentSong` closure value, since the subscription effect is only
set up once per `user` and would otherwise never see later selection
changes.

**Known limitation carried over, not introduced by this pass:** locally
adding a song (`addSong`/`addFromSearch`) updates `songs` but not
`queue` — a freshly added track doesn't join the active playback queue
until the next full reload. This preexists this change; the realtime
handler intentionally mirrors that same `setSongs`-only behavior for
partner-added tracks so the two paths stay consistent with each other,
rather than silently fixing queue behavior no one asked to have touched.

## Offline downloads

`src/lib/music/offlineDownloads.ts` — new module, scoped narrowly on
purpose: only a track the Audius API itself marked `isDownloadable` can
ever be downloaded (`canDownload()`), and only on a native platform
(`isOfflineDownloadSupported()`, i.e. `Capacitor.isNativePlatform()` —
the web build, including iOS Safari, has no app-private persistent
filesystem to write into). There is no code path here that ever touches
a YouTube URL.

Audio bytes are fetched from the same `resolveAudiusStreamUrl()` this
codebase already uses for live playback, streamed through with progress
reported as a 0–1 fraction when the response has a `Content-Length`
header (`null`/indeterminate when it doesn't — not faked), and written
via `@capacitor/filesystem` to `Directory.Data` (app-private, already a
project dependency, already used the same way by `fileExport.ts`). The
lightweight index (which tracks are downloaded, title/artist/artwork for
the Downloads list, the local file name) persists through `src/lib/
storage.ts` — this codebase's existing small-JSON wrapper — rather than
a second persistence mechanism for a few KB of metadata.

`GroicContext.playTrack()` now checks for a local downloaded copy first
for any natively-streamable (Audius) track, before falling back to
resolving a fresh remote stream URL — this is what makes offline
playback actually work with no connection, and it avoids re-streaming
data already on the device. If the index points at a file that's since
been cleared out from under the app, `getOfflinePlayableTrack()` drops
the stale index entry and playback falls through to the normal remote
path rather than failing outright.

UI: `GroicFullPlayer` gained a Download control in the secondary-controls
row (next to shuffle/repeat) — download / in-progress / downloaded-remove
states, shown only when `canDownload()` (or already downloaded) is true
for the current track, so it never appears for YouTube. `Groic.tsx`'s
home state gained a Downloads section (artwork, title, artist, tap to
play, remove) shown only on native platforms with at least one download
— matching the brief's request for a simple list, not a file manager.

**Known limitation:** the Downloads section in `Groic.tsx` reads the
index once on mount, not reactively — downloading a track from the full
player won't update that list until the Music tab is revisited. The
index itself and playback are both correct immediately; this is a
freshness gap in one list view, not a data-loss risk.

## $0 infrastructure confirmation

- Audius's read API (search/trending/stream resolution): free, no paid
  plan, no credential required for these operations.
- Media3/ExoPlayer (Android): free, open-source (Apache 2.0), part of
  AndroidX.
- AVFoundation/MediaPlayer (iOS): part of the OS SDK, no cost.
- No new paid Supabase feature — `audius-search` is a standard edge
  function on the plan already in use, identical in kind to the existing
  `music-search`/`music-trending` functions.
- No subscription, no paid SDK, no commercial licensing service was added
  anywhere in this implementation.

## Hardening pass (2026-08-24) — audit findings and fixes

Two real bugs found by tracing the code (not device-tested, but these are
logic errors visible in source, not device-behavior questions):

1. **Dual-engine bug in provider switching.** `playTrack()` and the
   shared-listening guest "load" handler both set the new track/engine
   without ever stopping whichever engine was previously active. Switching
   YouTube → Audius left the YouTube IFrame running underneath the new
   Audius playback; Audius → YouTube left the native engine running
   underneath. Fixed in both places: before anything else changes, compare
   the previous track's engine (native vs IFrame) against the new track's
   and stop the previous one if they differ — mirrors the stop logic
   `close()` already had for the "no next track" case.

2. **Call-resume behavior didn't match the spec.** The call-coordination
   effect paused native playback when a call started (correct) but had a
   deliberate no-auto-resume-on-call-end decision baked in from an earlier
   pass, reasoned as "don't surprise the person with audio restarting."
   The Music brief is explicit, and has now stated the same requirement
   twice: resume only if playing before the call, never start it if the
   user had already paused. Implemented as written — a `wasInCallRef`
   tracks the call→not-call transition explicitly (not just "not in call"
   on every render) so resume fires exactly once per call, only when the
   flag was set, and the flag is always cleared afterward.

Everything else audited this pass — mini-player drag channel naming,
realtime subscription cleanup, RLS, Android/iOS manifest patch scripts,
foreground-service permission scoping — was already correct; see the
"Playlist" and "Offline downloads" and "Draggable mini-player" sections
above and the conversation's final audit report for the full breakdown.

## Hardening pass (2026-08-30) — lock-screen/Bluetooth next/previous was non-functional

Found by tracing the plugin wrapper against GroicContext, not device-tested:

**`nativeEngine.setQueue()` was defined by the plugin (both platforms)
but never once called from GroicContext.** Every native `load()` call
only ever loaded a single track — the native side's own internal queue
never had more than one item in it. Consequence for a real lock-screen/
Bluetooth/car "next" or "previous" press (which acts directly on the
native player, bypassing this context's own shuffle/repeat-aware
`next()`/`prev()` entirely):

- **Android**: `hasNextMediaItem()`/`hasPreviousMediaItem()` were always
  false, so Media3's own transport-command availability correctly
  reported no next/previous item — inert, but not actively broken.
- **iOS**: `AudioEnginePlugin.swift`'s `advance()` doesn't gate on queue
  length the same way — tapping "next" with only one item in `queue`
  fell through to the "no next item" branch, which **pauses playback
  outright and reports `state: "ended"`**. A lock-screen next tap was
  silently stopping the music entirely.

Also, `GroicContext` never subscribed to the plugin's own `trackChanged`
event at all (the wrapper exposed `onTrackChanged`; nothing called it).
So even once the native side legitimately advances to a different track
— from a remote command, or from any other source — `current`/
`position`/`duration` here had no way to find out; the mini-player and
full-player would keep displaying whatever was playing *before* that
change.

**Fix**: added `syncNativeQueue()` — resolves a small window (1 track
back, 2 ahead) around whichever track just became current and hands it
to `nativeEngine.setQueue()`, called from `playTrack()` right after a
native track starts playing (fire-and-forget, never gates playback
start). Deliberately NOT the whole app queue — most queue entries don't
carry a resolved streamUrl until actually played, and Audius stream URLs
are per-request/short-lived (same reasoning already established for
shared listening), so resolving further ahead than a realistic
lock-screen tap would reach both wastes requests and risks handing the
native side a URL that's gone stale by the time it's used. A track with
no resolvable stream is dropped from the window rather than queued dead.
`nativeQueueWindowRef` mirrors exactly what was last sent (with the
resolved streamUrl), and the newly-added `onTrackChanged` subscription
looks a remote-command track change up there to sync `current` — falling
back to doing nothing (rather than showing a wrong track) if the change
landed outside the synced window.

Also hardened `AudioEnginePlugin.kt`'s `load()`: it started
`MediaPlaybackService` with a plain `context.startService(intent)`,
which throws `IllegalStateException` on Android 8+ if the OS considers
the calling process backgrounded at that exact instant (a real, if
narrow, window — e.g. a Bluetooth/lock-screen "play" command arriving
after the Activity's been backgrounded a while). Switched to
`ContextCompat.startForegroundService()`, which is correct and safe on
every API level and behaves identically to before for the common case
(the app in the foreground, `load()` called from a just-tapped play
button).

## Browser background/lock-screen audio — verified, not assumed (2026-09-01)

Researched current (2026) cross-browser behavior rather than relying on
possibly-stale assumptions, since a wrong claim here is worse than no
claim. Findings, and what changed in `native-plugins/audio-engine/src/web.ts`
as a result:

- **Desktop (all major browsers) and Android (Chrome/Firefox/Edge/Samsung
  Internet): reliable.** A tab actively playing audio is not suspended on
  backgrounding or phone lock — confirmed no self-inflicted bug in this
  file's `<audio>`/`navigator.mediaSession` wiring.

- **Corrected a false claim already in this file's own doc comment**: it
  previously said iOS Safari doesn't support `navigator.mediaSession` at
  all. That's wrong — it's been Baseline-available across browsers, iOS
  Safari included, since September 2021 (MDN). The real iOS constraint is
  WebKit's background-tab suspension policy itself, not MediaSession
  support.

- **Current (late-2025/2026) reports show installed home-screen PWAs on
  iOS 26 are, right now, WORSE for background audio than a plain Safari
  tab** — the opposite of what "install it, it'll feel more native" would
  suggest. Multiple concurrent, still-open reports: audio breaking after
  first use, next-track not advancing while locked, needing the app
  foregrounded again to recover, with the same site working fine as a
  plain tab. Live WebKit/iOS platform issue, not fixable from this app's
  JS.

- **Fix actually made**: `wireVisibilityResume()` in `web.ts` — tracks
  whether the element was genuinely mid-playback right before the tab was
  hidden, and retries `play()` automatically once the tab is visible again
  if it's since gone quietly paused. Covers both `visibilitychange` and
  `pageshow` (iOS has been reported to fire the latter without the former
  in some versions). This can't prevent the OS suspending playback while
  backgrounded — nothing in JS can — it only removes the "notice the
  silence, manually tap play again" step once the person is back looking
  at the tab, which several of the reports above describe as their only
  recovery path today.

## SoundCloud — added as PRIMARY provider (2026-09-04)

SoundCloud joins Audius as a second natively-streamable provider (full
background/lock-screen/Bluetooth support, same as Audius — see
`isNativelyStreamable()` in `types.ts`), and is now searched/ranked ahead
of it as the primary source, with Audius and YouTube as backups, per the
project's stated provider priority.

**Why this one is structurally different from Audius:** SoundCloud closed
public API registration years ago — there is no self-serve `client_id`/
secret to apply for. `soundcloud-search/index.ts` uses the same mechanism
every real-world unofficial SoundCloud integration uses (Discord music
bots, `soundcloud-downloader`/`soundcloud-scraper` npm packages, hosted
scraper services): it scrapes the `client_id` SoundCloud's own
soundcloud.com web player embeds in its public JS bundle, then calls
`api-v2.soundcloud.com` — the same endpoint the website itself uses. This
is the same category of fragility already accepted in this codebase for
YouTube search via Piped/Invidious in `music-search/index.ts` (unofficial,
can break, mirrors the real client) — not a new risk profile for this
project, just a second provider using it. The `client_id` is cached
per-isolate (20 min TTL) and self-heals by re-scraping once within a
request on a 401/403, mirroring `audius-search`'s host-list caching
pattern.

**Stream resolution is a two-hop lookup**, unlike Audius's single
redirect-URL fetch: fetch the track's `media.transcodings` list, then GET
the chosen transcoding's own metadata URL to get the real, short-lived,
signed CDN URL. Prefers a `progressive` (plain MP3) transcoding when one
exists (works in any `<audio>`/native player with no extra plumbing);
falls back to `hls` otherwise, since SoundCloud is phasing progressive
out. **Known limitation:** the web fallback engine (a plain
`HTMLAudioElement`, used on non-Safari browsers) does not play `.m3u8`
without an HLS.js-style library, which this project doesn't currently
bundle for music playback — native Android (ExoPlayer)/iOS (AVPlayer)
both handle HLS natively, so this only affects desktop/Android-web
listening to a SoundCloud track that has no progressive transcoding.

**Never offline-downloadable, deliberately** — `soundcloudProvider.ts`
always sets `isDownloadable: false`, and `offlineDownloads.ts`'s
`canDownload()` remains hard-gated to `provider === "audius"`, untouched
by this pass. This app does not download and permanently rehost
copyrighted SoundCloud audio.

**Files added/touched:**
```
supabase/functions/soundcloud-search/index.ts   search, stream-URL resolution (new)
src/lib/music/soundcloudProvider.ts              client adapter (new)
src/lib/music/types.ts                            MusicProvider gained "soundcloud"; isNativelyStreamable() extended
src/contexts/GroicContext.tsx                     resolveNativeStreamUrl() dispatcher added; every audius-only
                                                    branch (stream resolution, shared-listening guest provider
                                                    parsing/playback gating) generalized to check isNativelyStreamable()
                                                    or dispatch by provider, instead of hardcoding "audius"
src/pages/Groic.tsx                               SoundCloud search section (rendered first, ahead of Audius/
                                                    YouTube), provider filter chip, Our Playlist add/play support
src/components/GroicFullPlayer.tsx                ProviderChip gained an explicit SoundCloud branch — it was
                                                    falling through to the "Offline copy" label before this fix,
                                                    since that branch's implicit else previously only had to
                                                    account for youtube/audius
src/test/musicProviders.test.ts                   mirrors every existing Audius test for SoundCloud
```

**Not in this pass** (scoped out deliberately, not forgotten): a
"SoundCloud Picks" trending/home rail (the Home Experience brief's other
rails), and SoundCloud results feeding the native queue's Up Next
recommendation pool beyond what falls out of `isNativelyStreamable()`
already being provider-agnostic. Both are straightforward follow-ups
against the same pattern once this pass is verified working end-to-end.
