# Handoff — 2026-10-12 — Music: Jamendo "Free Music" + "My Files" (local imports)

Owner request: wanted YouTube-ReVanced-style background play. Declined stream extraction (against ToS and docs/MUSIC_NATIVE_PLAYBACK.md hard boundary; ReVanced patches the official YouTube app and cannot be applied to an IFrame embed). Owner chose option B: add Jamendo + user-imported files, both fully free and natively playable in the background.

## What changed
- supabase/functions/jamendo-search (NEW): search / trending / stream modes against Jamendo's official API. Needs secret JAMENDO_CLIENT_ID; 503 without it. Auth + rate-limit bucket "jamendo-search" (60/min) like audius-search.
- src/lib/music/jamendoProvider.ts (NEW): searchJamendo, trendingJamendo, resolveJamendoStreamUrl. Search results carry a long-lived streamUrl.
- src/lib/music/localLibrary.ts (NEW): import audio files into Directory.Data/groic-local/ (chunked write), records in localStorage (scoped per profile), resolve -> file:// URI for ExoPlayer. Web build keeps imports for the session only.
- types.ts: MusicProvider += "jamendo"; isNativelyStreamable now true for jamendo + local.
- GroicContext.tsx: stream resolver dispatches jamendo/local; shared-listening provider mapping knows both; a guest cannot play a host's "local" track and gets a clear message instead of a generic failure.
- Groic.tsx: "Free Music" + "My Files" filter chips and result sections, "My Files" shelf (import + remove) on home, Jamendo can be added to Our Playlist (jamendo:<id>), local tracks cannot (toast explains).
- MusicUI.tsx / GroicFullPlayer.tsx: provider labels.
- src/test/localLibrary.test.ts (NEW).

## MUST DO
1. Get a free client id at devportal.jamendo.com, then `supabase secrets set JAMENDO_CLIENT_ID=...` and `supabase functions deploy jamendo-search` (project jzlpelxwzjjpddqcrtpu).
2. LICENCE: Jamendo's free API tier is non-commercial. DuoSpace has Razorpay monetization — clear Jamendo's commercial/API terms before shipping this to paying users, or gate it. Tracks are Creative Commons: keep artist visible (done) and link back where required.
3. Rebuild the APK (web changes only; no native Kotlin change this session).

## NOT verified
- No node_modules here: no tsc, vitest, or build was run — only an esbuild syntax transpile of every changed file. Run `npm run verify:lock && npm run build` and vitest.
- Never run on a device or against live Jamendo. Check: import 3 mp3s, play, lock the screen (background), kill/reopen app (files persist), delete a file, search a Jamendo track, add it to Our Playlist, shared session with a Jamendo track and with a local track.
- Local file:// playback through ExoPlayer is expected to work (no custom DataSource in MediaPlaybackService) but is untested.
- No ID3 tag reading: title/artist come from "Artist - Title.ext" file names. No version bump (OTA compares versions).

## Part 2 — Spotify/Apple-Music-style browse (same day)
- src/lib/music/genres.ts (NEW): 16 genres (Pop, Indie, Hip-Hop, Rock, Electronic, Dance, Lo-fi, Chill, Acoustic, R&B/Soul, Jazz, Classical, Ambient, Folk, Metal, Reggae), each with a Jamendo tag + a SoundCloud search phrase.
- src/components/music/GenreView.tsx (NEW): genre page — gradient header with Play/Shuffle, "<Genre> hits" cover rail (SoundCloud), "Top <Genre> · Free Music" list (Jamendo). Either source can fail alone; 5-min cache; retry button.
- Groic.tsx: "Browse all" 2-column genre grid on home (opens GenreView in place; Back returns), "Popular on Free Music" rail on home (hidden silently if Jamendo isn't configured).
- Not done: Android hardware Back does not close the genre page (only the on-screen Back does); no per-genre artist pages; genre rails only use Jamendo/SoundCloud (YouTube is never queried for these).
- Tests: src/test/genres.test.ts. Not run (no node_modules).

## Part 3 — Deployed + SoundCloud hardening (2026-10-12)
DEPLOYED to project jzlpelxwzjjpddqcrtpu via Supabase MCP (verify_jwt true): `jamendo-search` v1 (new) and `soundcloud-search` v21 (was v20).
Production-log finding behind the SoundCloud change: the only failures logged were ~8 distinct tracks ("no transcoding resolved"), each re-resolved up to 14x in a minute by client retries/prefetch, and the log never said WHY a variant failed.
soundcloud-search changes:
- Failure diagnostics: the warning now prints `policy=` and `failures=progressive:404|hls:403|...` per variant, so the next investigation has the real cause.
- Dead-track cache (5 min, per warm isolate): a track whose variants all failed DEFINITIVELY (401/403/404/410/no-url) is answered instantly and hidden from search results. Timeouts/5xx do NOT mark a track dead. An explicit client `fresh:true` retry clears the mark and gets one real attempt.
- Search asks for 30 results (was 20) so filtering SNIP/BLOCK/dead tracks still leaves a full list.
NOT changed: the unofficial client_id scrape (SOUNDCLOUD_CLIENT_ID secret remains an optional fallback only). Secrets cannot be listed through the MCP, so JAMENDO_CLIENT_ID being set is unverified; neither function was invoked end-to-end (needs a user JWT).
Next time SoundCloud tracks fail: query function logs for `no transcoding resolved` and read the `failures=` field.

## Part 4 — My Files tags/covers + Back button (2026-10-12)
- src/lib/music/id3.ts (NEW): dependency-free ID3v2.3/2.4 reader (title, artist, embedded cover). Pure `parseId3` verified under node with synthetic tags; src/test/id3.test.ts added (vitest not run). MP3 only; v2.2 and m4a/flac/ogg tags fall back to the "Artist - Title" file name.
- localLibrary.ts: imports now use tag title/artist, and embedded art is centre-cropped to a 200px JPEG data URL stored in a separate localStorage map (groic-local-covers:<profile>) — deleted with the track. If storage is full, tracks just show no art.
- Groic.tsx: My Files rows show the cover; Android hardware Back closes an open genre page (useBackHandler).
- Untested on device: createImageBitmap/canvas cover path, and Back-button ordering when the full player is also open.

## Part 5 — "Every artwork should be there" (2026-10-12)
Owner: fix the artwork limits so every track shows art.
- src/lib/music/fallbackArt.ts (NEW): deterministic generated cover (gradient + first letter, SVG data URL) for any track without art.
- MusicUI.tsx `Cover`: new optional `seed` ({title, artist}); a missing OR failed-to-load image is replaced by generated art (onError). All track-based Cover usages (MusicUI + Groic.tsx) pass the seed. Mini player, full player (artwork, blurred ambient background, queue rows) also fall back to generated art. NOTE: a Cover without `seed` still shows the plain gradient — pass `seed` when adding new Cover usages.
- src/lib/music/audioTags.ts (NEW): reads tags + embedded cover from MP3 (ID3, id3.ts), M4A/MP4 (iTunes atoms) and FLAC (Vorbis comment + PICTURE). OGG/Opus/WAV fall back to file name + generated art.
- localLibrary.ts rewritten: covers are saved as FILES (Directory.Data/groic-local/<id>.jpg) and held in memory — no localStorage quota. One-time migration of covers the previous build kept in localStorage. Files imported before tag reading existed are re-tagged once in the background on first open (fetch via convertFileSrc -> readAudioTags), then flagged `tagged`.
- Tests: src/test/audioTags.test.ts (M4A, FLAC, fallbackArt) — all 5 pass when run in Node against synthetic files via an esbuild bundle + tiny vitest shim; id3 + localLibrary tests were checked the same way earlier. Real vitest/tsc/build still NOT run (no node_modules).
- Untested on device: createImageBitmap/canvas cover path, cover file read-back, background re-tag via fetch(convertFileSrc(...)), and real-world files with unusual tags (ID3 v2.2, unsynchronised tags).
- Known limit: YouTube/SoundCloud/Jamendo artwork still depends on the provider's image URL; if it is missing or fails to load, generated art now appears instead.

## Part 6 — Full-page Liked Songs / My Files (2026-10-12)
- src/components/music/TrackListView.tsx (NEW): full-page list — gradient header, Play + Shuffle, in-page filter box (shown above 8 tracks), every track, optional per-row remove, optional header action.
- Groic.tsx: `listView` state ("liked" | "files"), Android Back closes it (useBackHandler). Liked Songs shelf gets "See all N" (>5); My Files shelf gets Play + Shuffle buttons and "See all N" (>8). The hidden file <input> is now always mounted (it used to live inside the home fragment, which would have broken Import on the My Files page).
- NOT done (offered, not chosen/started): sleep timer and crossfade — a JS timer is throttled with the screen off, so a reliable sleep timer should live in the native MediaPlaybackService. User-created personal playlists don't exist (only the shared "Our Playlist" page); not added.
- Verified: esbuild syntax transpile only. Not run: tsc, vitest, build, device.
