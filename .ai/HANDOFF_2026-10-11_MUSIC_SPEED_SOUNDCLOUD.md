# Handoff — 2026-10-11 — Music: SoundCloud not playing, slow start, laggy page

Owner report: music section laggy/slow, SoundCloud songs don't play, play takes too long after tapping.

## Root causes found (by reading the code; none reproduced live — no network here)
1. soundcloud-search picked "the first hls" transcoding. SoundCloud often lists the Opus/Ogg HLS variant first; ExoPlayer's HLS cannot play Ogg segments, so the URL resolved fine and then never played. Now ranked: progressive MP3 > HLS AAC > HLS MP3; Opus/Ogg excluded.
2. client_id scrape sent User-Agent "compatible; DuoSpace/1.0" (soundcloud.com can serve a stripped page to bots, so no client_id -> every call 502 "SoundCloud is unreachable"), required a `crossorigin` attr on the script tag, and fetched up to 8 bundles one after another (up to ~24s cold). Now a normal browser UA, broader script/client_id patterns, bundles fetched in parallel, one shared in-flight scrape, stale id reused if a refresh fails, optional `SOUNDCLOUD_CLIENT_ID` secret as last-resort fallback.
3. Tapping a track cost: auth -> rate-limit RPC -> /tracks/:id -> transcoding URL, strictly in sequence, then a 15s timeout + blind retry on the client. Now: rate-limit runs in parallel with the work; search results remember each track's transcodings + track_authorization (per warm isolate, 25 min) so a tap costs one SoundCloud request; client uses 8s timeout + exactly one quick retry (not for 400/401/403/404/429).
4. SNIP (30s Go+ preview) and BLOCK tracks were listed as normal songs. Now filtered out of search.
5. ExoPlayer default load control waits for 2.5s buffered before starting. Now 0.8s (min 15s / max 50s / after-rebuffer 2s).
6. Lag: every rail card got a new inline callback per render, defeating memo() — typing, buffering flips and play/pause re-rendered ~100 cards. Added ShelfCard/ListRow wrappers (stable callbacks), only the CURRENT card gets isPlaying, playFrom/playFromSearch are stable (query read via ref), rail slices memoised. Also: sticky header + play-chip backdrop-blur removed (blur over scrolling images is costly on WebView), 500px SoundCloud art downsized to 300px in cards/rows, off-screen rails use content-visibility:auto.
7. New: GroicContext.warmStreams() — after search results / on home (recents + first rail) the top 4 SoundCloud songs get their stream URL resolved in ONE batched request (debounced), so a tap starts without a network wait.

## Files
supabase/functions/soundcloud-search/index.ts, src/lib/music/soundcloudProvider.ts, src/contexts/GroicContext.tsx (warmStreams), src/pages/Groic.tsx, src/components/music/MusicUI.tsx, native-plugins/audio-engine/android/.../MediaPlaybackService.kt (load control), src/test/musicProviders.test.ts (+3 tests).

## UPDATE (same day) — real root cause of "songs skip automatically", from production logs
Supabase function logs (project jzlpelxwzjjpddqcrtpu) showed `/media/.../stream/progressive returned 404` for most tracks. The old code resolved ONLY the progressive transcoding and gave up on a 404, so the client got "unavailable" and auto-skipped (3 in a row = playback stops). soundcloud-search now tries every playable transcoding in order (progressive -> HLS AAC -> HLS MP3), remembers for 10 min that progressive is 404ing and then tries HLS first, and logs `no transcoding resolved` with the available protocols if all fail. DEPLOYED to production as soundcloud-search v19 (verify_jwt true, unchanged). Not tested against live SoundCloud from here.

## MUST DO to see the SoundCloud fix (edge function part is already deployed; APK rebuild still needed for the app-side changes)
- Redeploy the edge function: `supabase functions deploy soundcloud-search` (project jzlpelxwzjjpddqcrtpu). The app alone does not fix it.
- Rebuild the APK (native load-control change + web changes).
- If SoundCloud still 502s from Supabase's IPs, set a secret `SOUNDCLOUD_CLIENT_ID` (a current id taken from soundcloud.com's own network requests).

## NOT verified
- No node_modules / network here: no tsc, vitest, build, or deploy was run — only a syntax transpile of every changed TS file. Run `npm run verify:lock && npm run build` and the vitest suite (12 pre-existing failures noted in HANDOFF_2026-10-04_MUSIC.md).
- Kotlin not compiled. It uses `androidx.annotation.OptIn` + `@UnstableApi` for DefaultLoadControl; if Gradle objects, that is the only native change.
- Never run on a device. Check: tap a SoundCloud song from search and from a rail (time to sound), skip next/prev, a Go+ song no longer appears, rails scroll smoothly, pause/play while buffering.
- No version bump (OTA update compares versions; bump before shipping if you want it offered).
