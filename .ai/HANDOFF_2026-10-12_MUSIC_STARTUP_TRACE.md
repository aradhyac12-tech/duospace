# Handoff — 2026-10-12 — Music: tap-to-audio instrumentation (session in progress)

## Audit findings (corrects an initial assumption)
- Render isolation was ALREADY done by an earlier session: playback position lives in a separate `GroicProgressContext`
  (`useGroicProgress`), `useGroic()` value is memoised and stable across ticks, `MiniProgress` is its own component,
  `CoverCard/TrackRow` are `memo`, shelves use `ShelfCard/ListRow` wrappers with stable callbacks, and only the CURRENT
  card receives `isPlaying`. No change made there; no evidence of a remaining re-render problem was found by reading.
  NOT measured with React Profiler (no node_modules / device).
- Android back: `useBackHandler` + `lib/backStack` (stack, LIFO). Genre page, list page and full player each push a handler.
  Ordering with the full player open over a genre page is still untested on device.
- There was NO tap-to-audio timing anywhere. Added.

## Changed
- NEW src/lib/music/startupTrace.ts — pure tracer: ui / resolve (offline|cache|network|none) / load / native stages, supersede
  handling, bounded history, injectable clock.
- GroicContext.tsx — marks in `playTrack` (begin, uiCommitted, resolveStart/resolved, loadStart/loadReturned, fail paths),
  `audible` on the native "playing" event, and one `logInfo("music.startup","tap-to-audio",{...})` per played track.
  Observational only; no playback logic changed. IFrame (YouTube) path is not traced (no native event).
- NEW src/test/startupTrace.test.ts.

## Verification (honest)
- Tracer logic: assertions re-run under `node --experimental-strip-types` with a shim (PASS). vitest itself NOT run.
- GroicContext.tsx edits: NOT type-checked or built (no node_modules, no network). Edits are small string insertions; run
  `npx tsc -p tsconfig.app.json && npx vitest run src/test/startupTrace.test.ts` first.
- No latency numbers exist yet. To get them: build, play ~20 tracks on a device, read `music.startup` log lines, compare
  `resolveMs` (network vs cache), `loadMs`, `nativeMs`.

---
# Part 2 — Music visual reorganisation (same day)
Owner brief: premium, restrained dark/wine, Apple-Music polish + Spotify usability; reorganise, not just recolour.

## Changed
- NEW src/lib/music/palette.ts — `WINE_SURFACE`, `WINE_CHIP`, `toneFor(key)` (4 restrained wine/graphite/ember tones, stable per key).
  Decorative surfaces only; interactive controls still use theme `primary`. If a wine THEME is added later, switch these to tokens.
- MusicUI.tsx: removed the in-flow `ProviderBadge` from CoverCard / TrackRow / TopResult / actions sheet (it had no absolute
  positioning, so it sat under the cover and pushed layout) → provider is now a dot beside the artist; removed `blur-3xl` on
  TopResult; MoodTile is a tonal tile (props now just label+onClick; emoji/gradient props gone); Equalizer honours
  reduced-motion; 44px touch targets on "…" buttons; focus-visible rings; NEW `PlayableCard/PlayableRow` (stable-callback memo
  wrappers), `RowSkeleton`, `CardSkeleton`, `pageHeaderClass`.
- GenreView.tsx: tonal header (no emoji), skeleton loading, 12 s provider timeout (no indefinite spinner), explicit offline
  state + disabled retry, memo-stable cards/rows (inline closures defeated memo before).
- Groic.tsx: wine hero (blur-2xl + fuchsia/indigo removed), library hub chips, playlist chips, list-page headers, genre grid and
  mood tiles all on the palette; MOOD_STYLE removed. NEW back handler for the page's own overlays (track menu, playlist picker,
  name sheet, confirm dialogs, add-link dialog): previously Back closed the genre/list PAGE behind an open menu because the
  back stack only falls back to Radix layers when it is empty.
- GroicFullPlayer.tsx queue: "Up next" now = tracks AFTER the current one (it listed every track, incl. already played);
  "Played earlier" section; keyboard-reachable rows (real buttons); 44px remove; empty-src bug in the collapsed preview fixed;
  list bounded to 50 rows.
- NEW src/test/musicPaletteAndBack.test.ts.

## Verification (honest)
- Syntax: every changed file parses (TypeScript transpile, global TS 6.0.3). PASS.
- Type-check: `tsc` over the music files WITHOUT node_modules (no React/lib types → weak). Compared against the pristine zip:
  identical error set (195 = missing-module noise) except one `key`-prop line of the same class. No new errors detected, but
  this is NOT a real type-check.
- Logic assertions for palette + back-stack ordering re-run under node type-stripping (PASS). vitest NOT run.
- NOT run: eslint, vite build, vitest, any device/emulator/screenshot. Visual quality and Android Back were NOT observed.

## Not done (still open from the brief)
- Mini-player and the rest of the full player (artwork/seek/controls) were NOT restyled — only the queue.
- Home was recoloured/de-rainbowed, not re-sequenced; no cross-shelf track de-duplication added (railDedupe.ts already exists
  for some shelves). No search provider-availability filter UI.
- No per-track "unavailable" marker in queue/rows: the context does not track it per track (dead tracks are skipped or hidden).
- Reordering in the queue is not supported by the context (remove/clear only).
- Back with the full player open over a genre page: ordering is covered by the back-stack unit test, never exercised on device.

---
# Part 3 — "App got stuck while playing music" (owner report, no repro details)
Read-only audit first: my own changes (telemetry ring buffer, 1 Hz native position events, isolated progress context) cannot
cause a freeze. The real gap found: only YouTube tracks had a stall watchdog. Native-engine tracks (SoundCloud/Audius/Jamendo/
local) had none, and `nativeEngine.load()` / `stop()` had no timeout — a wedged ExoPlayer or a bridge call that never returns left
the UI on "playing"/spinner forever with no recovery. THIS IS A HYPOTHESIS: the actual cause of the owner's freeze is unconfirmed.

## Changed
- NEW src/lib/music/stallWatchdog.ts: `withTimeout`, `createStallDetector` (pure).
- GroicContext.tsx: `nativeEngine.load` (10 s) and cross-provider `stop` (5 s) wrapped in `withTimeout` → existing catch path
  (retry once with fresh URL, then skip). NEW native stall watchdog (2 s tick, 7 ticks ≈ 14 s with frozen position while intent is
  playing) → `retryCurrentRef` once, then `skipBrokenRef("native stalled")`. Grace for URL resolution, recent seek, hidden app,
  deliberate pause. `resolvingRef` added.
- NEW src/test/stallWatchdog.test.ts (shim-verified, vitest not run).

## Not verified / risks
- Never run on a device. Possible false positive: a native engine that does not emit position while legitimately playing would
  be retried after 14 s — check logs for `music.watchdog native playback stalled` during normal playback.
- Does NOT address a frozen UI thread (JS/main-thread block): a watchdog running on that same thread cannot see it.
  If the whole app froze, capture `adb logcat` / a Chrome remote-debugging performance trace and the `music.startup` lines.
