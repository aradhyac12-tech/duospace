# Handoff — 2026-10-15 — SoundCloud stuck on "loading song" + app sticks/crashes

Owner report: SoundCloud stuck on loading a song; app sticks and crashes, cause unknown. Asked for Supabase logs.

## Supabase evidence (prod project jzlpelxwzjjpddqcrtpu, last 24h)
- soundcloud-search: 85x 200 (avg 0.86s, max 2.8s), 1x 404 (dead track). The server is NOT what hangs.
- Only warning: `[soundcloud] no transcoding resolved <id> policy=MONETIZE failures=` (empty = the track exposes no playable transcoding; correctly marked dead).
- audius-search: 3x 404 taking ~17s each (slow failure path) — not SoundCloud, but can stall Audius songs / alternate lookups.
- Postgres: zero ERROR/FATAL. Other functions healthy (one send-email 500).
- No client crash telemetry reaches Supabase, so the crash/freeze cause could NOT be read from logs.

## Code findings (read, not reproduced — no device, no node_modules)
1. playTrack awaited the stream resolve with no overall cap. A tap that joined a prefetch batch could wait ~10s (batch) + 2x8s (single retry) -> spinner for 25s+.
2. advanceNext: `setLoading(true); topUpQueue().then(setLoading(false))` — topUpQueue fans out to SoundCloud/Audius/YouTube with no timeout; one hung provider = spinner forever.
3. Native side already hardened (main-thread hops, try/catch around startForeground, runOnMainSafely) — no crash found there by reading.

## Changes
- src/contexts/GroicContext.tsx: 12s hard cap on stream resolve (falls into existing retry -> alternate -> skip ladder); 10s hard cap on auto-next top-up so `loading` always clears.
- src/lib/music/soundcloudProvider.ts: batch prefetch timeout 10s -> 7s.
- Version 3.22.22 -> 3.22.23 (package.json, android/app/build.gradle versionCode 32223) so OTA offers it.
- Edge function unchanged (nothing to redeploy).

## NOT verified
- No tsc/vitest/build run (only a syntax transpile of the two TS files). Run `npm install && npm run build && npm test`.
- Never run on a device. Check: tap SoundCloud song from search/rail; airplane-mode tap ends spinner within ~12s; end of queue with auto-next.

## To find the real crash/freeze
- Run `adb logcat -b crash` and `adb logcat | grep -i -E "duospace|exoplayer|AndroidRuntime"` while it happens, or share the "music.watchdog" / "music.skip-broken" lines from the app log.
- Suspect list if it still freezes: ExoPlayer HLS stuck in BUFFERING (watchdog retries once, then skips), audius-search 17s failures.

## UPDATE (same day, v3.22.24) — pause/resume, premium polish, black box
1. **Paused music dies, Bluetooth play does nothing**: MediaPlaybackService detached from foreground the moment playback paused (START_NOT_STICKY, no media-button receiver), so Android killed it. Now it stays foreground while paused (PAUSED_KEEP_ALIVE_MS = 6h, then detaches), and a PLAY on an IDLE-with-item player calls prepare() first. Kotlin NOT compiled. NOT covered: process death after the 6h/OEM battery kill — a MediaButtonReceiver that restarts the service + restores the last track is the next step.
2. **Premium look**: MusicUI.tsx (bigger section titles, 156px rounded-18 cards with layered shadows, 1-line titles, 56px rows, larger hero card) and mini player (rounded-22, shadow, bigger thumb). Class-level only; the full player (already artwork-ambient + morph) untouched. A deeper Apple/Spotify-style redesign of Groic.tsx home is still open.
3. **Black box** (src/lib/blackBox.ts, components/BlackBoxNotice.tsx, hooked in main.tsx + telemetry.ts record()): breadcrumbs of every telemetry log/route/error persisted in localStorage; 1s heartbeat detects main-thread lag (>1.5s) and freezes (>6s); long-task observer; on next launch, if the last session ended in foreground (or had freezes) a card "DuoSpace stopped unexpectedly last time" appears with Copy report/Details (trail of last 60 events, route, heap, lag stats). Last 6 reports kept (getReports()). Limits: cannot see native (Kotlin/OOM) stack traces — use adb logcat -b crash for those.
Version 3.22.24 / versionCode 32224. Nothing built or run on a device.

## UPDATE 2 (v3.22.25) — Bluetooth PLAY after the process was killed
MediaPlaybackService: session media-button receiver restored (PendingIntent.getService -> this service, was null), onStartCommand routes ACTION_MEDIA_BUTTON via MediaButtonReceiver.handleIntent, the pause path saves a resume point (id/title/artist/art/uri/position in SharedPreferences "duo_audio_resume"), and PLAY on an empty player restores it and plays. Only non-http(s) URIs (local files) are restored; signed SoundCloud/Audius URLs expire and are intentionally skipped. Kotlin NOT compiled; never run on a device. Test: play a local song, pause, force-stop via `adb shell am kill com.<app>` (or wait), press Bluetooth play. If Android 12+ refuses the background service start, the press is simply ignored (no crash: all calls are try/caught).

## UPDATE 3 (v3.22.26) — premium home + Audius slow failures
- Groic.tsx home: 34px greeting, "Your mix" hero (32px title, bigger covers, soft glow, deeper shadow), library tiles + QuickTiles larger with soft shadows. Class-level only.
- supabase/functions/audius-search: stream lookup now asks all discovery hosts in parallel, a 404 is answered at once, hard 5s cap (was up to ~17s sequential, seen in prod logs). **NOT DEPLOYED** — run `supabase functions deploy audius-search --project-ref jzlpelxwzjjpddqcrtpu` (verify_jwt stays true).
- Nothing built/run; TS syntax-checked only.
