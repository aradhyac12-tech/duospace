# Handoff — 2026-10-17 — Groic Premium Music (running log, one phase at a time)

Source spec: music-premium-implementation-prompt.md (Scopes A–F). Owner asked: "Continue with phase 1 and slowly next".

## Phase 1 — Scope A (home re-sequence)  [DONE, unverified]
WHY: home was one long feed with competing oversized headings/shadows; first viewport should be search + quick picks + one mix + one recent rail.
WHAT (src/pages/Groic.tsx only, JSX order + class names; zero logic/handler changes):
- New order: offline notice, greeting+Quick picks, Your mix hero, Recently played, Your library hub (incl. Our Playlist tile),
  Made for you, "Because you searched", Our Playlist shelf (play/shuffle/add intact, #groic-our-playlist anchor intact),
  Recent searches, Downloads, Discover (languages, Free Music, moods, genres).
- Greeting 34px -> 28px; hero radius 32 -> 28, padding 6 -> 5, title 32 -> 28px, lighter shadow, removed decorative blur blob;
  library heading 24px -> 17px; library tiles lost their drop shadow.
RISK: Recent searches chips are now lower on the page (below Our Playlist); if that hurts search discoverability, move them up.
  Empty states: if Recently played is empty the hero is followed directly by the library hub (TrackShelf already renders nothing when empty).
TEST: syntax-only TypeScript parse of Groic.tsx = 0 diagnostics. NOT RUN: tsc, eslint, vitest, vite build (no node_modules here),
  no device/visual check, no Profiler trace.
RESULT: layout intent implemented in source; not seen on screen.

## Phase 2 — Scope B (Now Playing / mini-player polish)  [DONE, unverified]
AUDIT FINDINGS (read, not run):
- Reduced motion is ALREADY app-wide: App.tsx wraps everything in MotionConfig reducedMotion="user" (covers framer springs/loops
  incl. the mini/full equalizer bars) + a global CSS `prefers-reduced-motion` rule (covers animate-pulse/spin). No per-component change needed.
- Touch targets in mini (44px buttons, 56px hidden icon) and full player already >=44px; aria-labels present on all transport controls.
- Artwork-to-mini morph + drag/pull gesture code left UNTOUCHED (tuned springs 330/300/420 stay as-is).
WHY/WHAT:
- NEW src/lib/music/motionTokens.ts (SPRING_SHEET, SPRING_POP, COVER_FADE, CONTENT_FADE). Mini player uses all four (same values as before);
  full player title/artist fade now uses CONTENT_FADE (0.32s -> 0.3s, only visible difference).
- NEW src/lib/music/artOnError.ts: broken/blocked cover -> generated fallback art once. Wired to mini thumb + hidden icon, full-player
  main art/blurred bg/info card, and queue rows. (Before: a failing URL left a blank grey box.)
- Mini player error state ("Couldn't play this one") is now a tap-to-retry button (before: dead text; only the slow state had retry).
RISK: onError creates a tiny closure per render (negligible). Retry button reuses the existing retry() used by the slow state.
KNOWN, NOT CHANGED: mini bar is role="button" containing real <button>s (nested interactive; screen readers may announce oddly).
  Fixing needs restructuring around the gesture code; deferred on purpose. Mini player text is 10-12px (small).
TEST: syntax-only parse of GroicMiniPlayer/GroicFullPlayer/motionTokens/artOnError = 0 diagnostics. Added src/test/artOnError.test.ts
  (NOT RUN — no node_modules). NOT DONE: tsc/eslint/vitest/build, device check of long titles, narrow screens, composer overlap,
  system gestures, Android Back, fast taps (all still need a real device).
RESULT: source changes in place; nothing seen running.

## Phase 3 — Scope C (provider-aware warming + YouTube tracing)  [DONE, unverified]
WHY: warmStreams() warmed SoundCloud only; the shared resolver also serves Audius/Jamendo. YouTube taps were explicitly untraced
(`startupTracer.fail()` on that branch), so no latency numbers existed for them.
WHAT:
- NEW src/lib/music/warmPlanner.ts: planWarmTargets (caps: soundcloud 4 / audius 2 / jamendo 2, total 6; dedupe provider:id;
  skips cached, no-id, isStreamable=false, direct streamUrl, local/youtube, and everything when offline) + createWarmRunner
  (same-set 60s gate; SoundCloud = one batch request first; Audius/Jamendo started one at a time and only while that run is
  still the newest generation; cancel() supersedes queued lookups).
- GroicContext.tsx: warmStreams now delegates to the runner; playTrack calls cancelWarm() right after the re-tap guard so the tapped
  track never competes with queued warming (in-flight resolves are shared by the resolver, so a tap simply joins them).
- Groic.tsx search branch now warms top 4 SoundCloud + 2 Audius + 2 Jamendo results (was SoundCloud only); effect deps extended.
- startupTrace.ts: new resolveSource "iframe". YouTube branch of playTrack now marks uiCommitted -> loadStart/loadReturned (the
  synchronous loadVideoById call) and the IFrame onStateChange===1 calls startupTracer.audible(); IFrame onError calls fail().
  Reading it: provider "youtube", resolveMs null, nativeMs = call-returned -> PLAYING (iframe buffering).
RISK: (1) a request already on the wire cannot be recalled — cancel only stops the NOT-yet-started tail. (2) If the IFrame API is not
  ready yet, loadVideo queues the request, so loadMs ~0 and nativeMs absorbs the wait; compare medians per provider.
  (3) Warming now touches audius-search/jamendo-search at search time (<=2 requests each per distinct result set, 60s gate); watch
  their logs/rate limits. (4) Prior behaviour for the home-screen warm is unchanged except Audius/Jamendo items now qualify.
KEPT: stale-tap protection, 12s resolve cap, retry-fresh -> alternate -> skip ladder, stall watchdog, local/offline-first (local never warmed).
NOT DONE in Scope C: item 6 (capability labels / native-alternate identity) and item 7 offline lookahead audit were only read, not changed;
  per-provider latency summary UI not built (data is in the "music.startup / tap-to-audio" log line).
TEST: syntax-only parse = 0 diagnostics on GroicContext, Groic, warmPlanner, startupTrace and both test files. NEW tests
  src/test/warmPlanner.test.ts (caps, dedupe/skips, offline, same-set gate, cancel stops queued singles) and an added YouTube case in
  src/test/startupTrace.test.ts — NOT RUN (no node_modules). No live-provider or device latency measured; make no "instant" claim.
RESULT: source in place, unbuilt.

## Phase 4 — Scope D (auto-next + queue correctness)  [PARTLY DONE, unverified]
FINDINGS (read): `queue` state is already the single source of truth for enqueue / playNext / remove / clear; the native lookahead
window re-syncs from it via an effect on [current.id, queue, shuffle, repeatMode] (300ms debounce, same current track => the plugin only
swaps neighbours, no restart). Next-window stream URLs are already batch-prefetched (NATIVE_AHEAD=5) after the tapped song starts.
DEFECT FOUND + FIXED: topUpQueue shared ONE in-flight promise regardless of track, and appended its result even after the person had
skipped away (stale suggestions landing in the queue; a caller for the new track could also be handed the old track's lookup).
WHAT:
- NEW src/lib/music/topUpGate.ts (createTopUpGate): in-flight lookup keyed by current-track id; same key joins, different key starts
  its own; result applied ONLY if still fresh (current id unchanged and auto-next still on), else discarded; failures -> [] and slot freed.
  GroicContext.topUpQueue now uses it (autoNextPromiseRef removed).
- queueLogic.ts: NEW pure moveUpcoming(queue, currentId, id, delta) — moves one upcoming track by one slot; never moves/precedes the
  current track, no-op returns the SAME array. GroicContext: NEW moveInQueue(id, delta) (in GroicAPI + provider value/deps).
- GroicFullPlayer queue tab: "Reorder" toggle (44px) in the Up next header; in reorder mode each upcoming row shows Move up / Move down
  (44px, disabled at the ends, aria-labels "Move <title> up/down") instead of the trash button; an aria-live status announces
  "Moved <title> up/down to position n of m". Reorder is HIDDEN while shuffle is on (then play order = shuffle chain, so list order
  would not be what plays — honest, not faked).
RISK: (1) a prefetched top-up whose track ended before the lookup returned is now dropped; the existing effect (ahead<=3 on current
  change) re-requests for the new track — one extra request in that case, by design. (2) Row markup in renderQueueRow changed from an
  expression body to a block body (pure refactor + conditional buttons). (3) Drag-to-reorder NOT built: gesture arbitration inside the
  player sheet is the risky part; the button path is the keyboard/screen-reader alternative the spec asked for.
NOT CHANGED (read only): fallback ladder / dead-track loop guards / title-family dedupe (autoNext.ts, queueQuality.ts), shuffle bag,
  repeat-one semantics; "pre-resolve next 1-2 playable candidates" is covered by the existing native-window prefetch, not extended.
TEST: syntax-only parse = 0 diagnostics (GroicContext, GroicFullPlayer, queueLogic, topUpGate, new test). NEW src/test/queueReorderTopUp.test.ts
  (moveUpcoming edge cases incl. no-mutation/current-in-place; topUpGate join/stale-discard/failure) — NOT RUN. NOT VERIFIED: lock-screen /
  Bluetooth next/previous, queue edits during playback on device, consecutive dead tracks, provider timeouts, background/resume.
RESULT: source in place, unbuilt.

## Phase 5 — Scope E (performance budget)  [AUDITED by reading, one test added; NOT profiled]
FINDINGS (read, not run):
- Position isolation is already in place: GroicProvider splits `GroicContext` (stable value, memoised) from `GroicProgressContext`
  ({position, duration}); only useGroicProgress() consumers (seek bar, lyrics, mini/full player) update on a tick. `children` is a stable
  prop, so the 2Hz setPosition re-runs the provider function body but not the page tree. No change made.
- Not proven: no React Profiler / performance trace was taken, so "the page does not re-render per tick" is a code reading, not a measurement.
- localStorage: only small flags are written by the context (e.g. groic-auto-next). Full-state serialisation during playback was not
  found in the files read; library/history stores were not re-audited this pass.
- Kotlin / ExoPlayer / audio focus / crossfade: NOT touched, NOT compiled (no Android SDK, no network).
KNOWN NUANCE (not changed): syncNativeQueue drops a window entry whose stream URL cannot be resolved and sends the rest. Native then skips
that dead track while the queue UI still lists it; onTrackChanged re-syncs `current` to the track that really plays. Truncating at the gap
would keep UI order exact but make background playback stop earlier (JS may be frozen when locked), so it was left as dead-track skipping.
Decide deliberately before changing.

## Phase 6 — Scope F (tests, version, delivery)
VERSION: package.json 3.22.32 -> 3.22.33; `node scripts/patch-native-permissions.mjs` stamped android/app/build.gradle
versionCode 32233 / versionName 3.22.33 (verified in the file). package-lock.json still says 3.22.9 and was NOT regenerated (needs network).
Run in an online environment: `npm install --package-lock-only` then `npm run verify:lock`. `npm run check:lock` (static, offline) passes
with a cosmetic stale-version warning only. The zip filename follows package.json (3.22.33), not the "v3.22.45" in the original archive name.
NEW TEST: src/test/queueOrderPlayed.test.ts — native window follows the visible queue order after reorder / play-next / remove, repeat-one,
shuffle (queued+unplayed only), missing current, tracksAhead lead.
TESTS ADDED ACROSS PHASES 1-6 (all NOT RUN): artOnError, warmPlanner, startupTrace (YouTube case), queueReorderTopUp, queueOrderPlayed.

## Verification status (honest)
RAN: TypeScript syntax-only transpile of every touched source/test file = 0 diagnostics; offline lock check; native version stamp script.
NOT RUN (BLOCKED: no node_modules, no network, no Android SDK): npm ci, tsc, eslint, vitest (targeted or full), vite build, Android compile,
Profiler trace, any device or live-provider check, per-provider latency measurement. Baseline (pre-change) test results were never
obtained, so old vs new failures cannot be separated. No "instant", "lag-free" or "premium-ready" claim is made.

## Phase 7 — Scope C item 7 (offline lookahead)  [DONE, unverified]
WHY: warmPlanner already skipped offline, but prefetchNeighbors and syncNativeQueue still fired resolver requests offline.
WHAT (GroicContext.tsx): both skip remote lookups when navigator.onLine === false; downloaded/local copies still resolve (getOfflinePlayableTrack first).
RISK: navigator.onLine can be wrong (true on captive Wi-Fi); then behaviour is unchanged. Window entries without a local copy are dropped offline (same as a failed lookup before).
TEST: syntax-only parse = 0 diagnostics; no test added (logic lives inside the provider closure) — NOT RUN.

## Phase 8 — Scope C item 6 (capability labels / native-alternate identity)  [PARTLY DONE, unverified]
AUDIT: the only user-visible capability hint is the full-player comment/label that Audius is background-capable and the mini-player's
"playing in background" aria-label. When the screen locks, syncNativeQueue swaps upcoming YouTube entries for a cached SoundCloud/Audius
"twin" (a different upload matched by title/artist/duration); native then advances onto it and `current` becomes the twin object, so the
title shown is the twin's own (not mislabelled), but nothing recorded that it was a substitute.
WHAT: GroicTrack.twinOfId (optional, observability only); syncNativeQueue stamps it on swapped entries; onTrackChanged logs
"music.twin" {youtubeId, playingId, provider} when native advances onto one. No behaviour or UI text changed.
NOT DONE: any visible "background version" badge/label in the player (needs a design decision on wording); YouTube-vs-native capability
labels in search results. RISK: the twin object now carries one extra field and is broadcast to the partner as before.
TEST: syntax-only parse = 0 diagnostics; no test added — NOT RUN.

## Phase 9 — Scope D "playable lead" (pre-resolve next 1-2 candidates)  [DONE, unverified]
GAP: a top-up appended suggestion METADATA; they only got a stream if the debounced native-window sync ran (native current track only,
and only after 300ms), so with a YouTube current track, or right after a top-up, the next song could still be cold.
WHAT: warmPlanner.planLeadTargets (n=2, order mode only, reuses planWarmTargets so offline / cached / in-hand streamUrl / YouTube /
local are skipped; shuffle returns [] because the shuffle chain is prefetched by the window sync). GroicContext top-up apply step
prefetches those targets through the shared resolver (SoundCloud batches; in-flight work is shared, so no duplicate requests), and
SKIPS it while the tapped track is still resolving so the tapped song keeps the startup/rate-limit budget.
RISK: up to 2 extra lookups per top-up (top-up runs once per current-track generation). Failures are swallowed; the normal
resolve-at-play path is unchanged. Not a guarantee the next song is ready — only that it was asked for.
TEST: NEW src/test/playableLead.test.ts (4 cases) — NOT RUN; syntax-only parse = 0 diagnostics. No latency measured.

## Phase 10 — Scope B nested interactive roles in the mini player  [DONE, unverified]
WHY: the full mini bar was role="button" tabIndex=0 containing five real <button>s (nested interactive; invalid ARIA, odd announcements).
WHAT (GroicMiniPlayer.tsx, state A only): bar is now role="group" (aria-label "Music player, <title> by <artist>"), tabIndex/onKeyDown removed;
the decorative trailing chevron became a real 44px button "Open full player" (stopPropagation, expand(true)). Pointer tap on the bar still
expands; touch-swipe handlers, drag/morph code and the minimized-icon state B (a single role="button" with no children) are untouched.
Artist/status line 10px -> 11px.
RISK: the bar is 28px wider in controls (chevron 16 -> 44px), so the title column is narrower on small phones — check truncation on a
~360px device. Keyboard users now tab to the chevron button to open the player instead of focusing the bar itself.
TEST: syntax-only parse = 0 diagnostics; no automated test, no screen-reader/device check — NOT RUN.

## Phase 11 — Scope C item 6, capability hints on cards  [DONE, unverified; WORDING IS MY CHOICE — please review]
WHAT: NEW src/lib/music/providerCapability.ts (providerCapabilityNote / providerLabelWithCapability). YouTube: "plays in the app only and may
stop when the screen locks"; SoundCloud/Audius/Free Music: "can keep playing when the screen is locked"; My Files: "stored on this device, can
keep playing in the background". MusicUI.tsx: ProviderDot aria-label+title and ProviderBadge title (+ sr-only text) now carry that note.
No new visible text, no layout change. A unit test ties the wording to isNativelyStreamable so the two cannot drift.
LIMIT: "can keep playing" describes the engine, not any single track (SoundCloud is an unofficial path and a track can still be dead). A visible
"background version" caption while a twin plays (Phase 8) is still not built. Hover titles do not appear on touch; screen readers get the text.
TEST: syntax-only parse = 0 diagnostics; src/test/providerCapability.test.ts — NOT RUN.

## Phase 12 — Scope D drag-to-reorder  [DONE, unverified; gesture NOT tried on a device]
WHAT: NEW src/lib/music/dragReorder.ts (nextDragStep: swap one slot per 60% of a row of finger travel, remainder carried = hysteresis).
GroicFullPlayer queue rows (reorder mode only, never in shuffle): a pointer-only grip handle (GripVertical, aria-hidden, 32x44) before the
move buttons. Pointer capture on the handle; each step calls the SAME moveInQueue(id, ±1) as the buttons, so order, native-window resync
and the "queue order = played order" guarantee are unchanged; announce "Moved <title>" on release. The move up/down buttons stay as the
keyboard / screen-reader path. Isolation from the sheet gestures: data-no-pull (pull-to-minimise ignores it), touch-action:none (no list
scroll/pan during the drag), onPointerDownCapture stopPropagation (framer sheet drag never starts) — same pattern the row buttons use.
LOOK/FEEL: step-drag, not a floating-row drag — the row snaps slot by slot under the finger (no lifted/translated ghost row; deliberate,
to avoid a second transform writer inside the sheet).
RISK: not exercised on a device — verify (1) pulling the sheet down from the handle does not minimise, (2) the list does not scroll while
dragging, (3) a fast drag over several rows (one step per pointermove event, so a very fast flick may lag a row behind), (4) Android Back.
Drag past the first/last upcoming row is a no-op (moveUpcoming clamps). The drag handle has no auto-scroll at the edge of the list.
TEST: syntax-only parse = 0 diagnostics; NEW src/test/dragReorder.test.ts — NOT RUN. No component test for the handle.

## Phase 13 — visible capability captions  [DONE, unverified; DEFAULT WORDING — change freely]
WHAT: (1) ProviderDot (used by every card/row/drawer) now also renders a small visible "App only" chip for YouTube tracks only (aria-hidden; the
dot's label already carries the full sentence). Native providers show no extra text — absence of the chip is the normal case. (2) Full-player
title block shows "Background version · SoundCloud/Audius" under the artist while a twin (track.twinOfId, Phase 8) is the current track.
RISK: one extra ~50px chip on YouTube rows (title/artist still truncate; check a 360px phone); the mini player does NOT show the twin caption
(its artist line is shared with loading/error status). "Background version" is only visible once native has advanced onto the twin.
TEST: syntax-only parse = 0 diagnostics; no automated test, no visual check — NOT RUN.

## Phase 14 — twin caption in the mini player  [DONE, unverified]
WHAT: GroicMiniPlayer artist line appends " · Background version" while current.twinOfId is set (idle state only; loading / slow / error
text still takes the line, as before). Same truncation, no layout change. RISK: longer artist line truncates sooner on ~360px phones.
TEST: syntax-only parse = 0 diagnostics; no visual check — NOT RUN.

## Phase 15 — per-provider latency summary  [DONE, unverified]
WHAT: startupTrace.summarizeByProvider(reports) -> per provider: taps / audible / failed / superseded + medians (total, resolve, native) over
AUDIBLE taps only. GroicContext.diagnose() now returns it as `startupSummary`, so the existing Diagnostics dump shows it with no new UI.
Window = the tracer's last <=50 taps, in memory only (resets on app restart). YouTube rows have resolveMs null and native = iframe buffering.
LIMIT: small samples; compare `audible` counts before trusting a median; same-network comparisons only. This is how to back (or refute) any
speed claim — there is still NO measured number in this repo from this session.
TEST: 2 new cases appended to src/test/startupTrace.test.ts — NOT RUN; syntax-only parse = 0 diagnostics.

## Phase 16 — self-review of this session's unrun code  [1 DEFECT FOUND + FIXED]
Read-through (no compiler available) of: warm runner/planner, lead targets, top-up apply step, drag handle, mini player, capability wording.
- tsconfig.app.json has strictFunctionTypes=false and strictNullChecks=false, so passing getCachedStreamUrl(MusicProvider) as a (string) peek
  compiles in this repo's config (same pattern as the existing warmRunner wiring).
- All refs used by the new top-up code (resolvingRef, shuffleRef, currentRef, queueRef) are declared before topUpQueue.
- DEFECT: topUpGate registered its in-flight entry AFTER starting the async body, so a loader that threw SYNCHRONOUSLY ran its `finally`
  before the entry existed and the entry was then left registered — later calls for that key would get the dead promise (no top-up) until the
  track changed. Real call sites pass an async loader (cannot throw synchronously), so production was not affected, but fixed anyway: entry is
  registered first. Regression test added in queueReorderTopUp.test.ts (NOT RUN).
- Still not provable without running: render behaviour of the drag handle, the "App only" chip layout, mini-player truncation.

## Not done
- Scope D: floating-row drag visual + edge auto-scroll (the drag handle snaps one slot at a time; buttons remain the accessible path).
- Scope B: device checks (long titles, narrow screens, composer overlap, Back, fast taps).
- Scope A: no screenshot/visual check; recent-searches chips moved lower (see Phase 1 RISK).
First thing next session (with network): npm ci -> npx vitest run src/test/{warmPlanner,playableLead,providerCapability,dragReorder,queueReorderTopUp,queueOrderPlayed,startupTrace,artOnError}* -> tsc -> eslint -> build.
