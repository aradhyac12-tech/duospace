# Handoff — 2026-10-08 — Groic premium music redesign

See the 2026-10-08 entry at the top of CHANGELOG.md. Files: src/pages/Groic.tsx, src/components/music/MusicUI.tsx, src/lib/music/libraryStore.ts, src/lib/music/queueLogic.ts (insertAfterCurrent), src/contexts/GroicContext.tsx (playNext, recordRecentTrack), GroicMiniPlayer.tsx, GroicFullPlayer.tsx, src/test/musicLibraryAndPlayNext.test.ts.

## Done
- Spotify/Apple-style home + search + "…" actions sheet, Liked Songs (local), Recently played, Play next, mini-player progress, full-player heart + Clear queue.

## NOT done / not verified
- Never rendered on a device. Check: small-phone spacing, safe areas, mini-player over the new bottom padding (pb-40), long titles beside the heart, the sheet over the full player (z-index 1200 vs player z-60).
- Liked Songs / Recently played are per-device only. Syncing to the partner needs a table + RLS + an Edge/RPC path (rule 6/4).
- No version bump (package.json still 3.22.9; some tests hard-code 3.22.9). Bump to 3.22.10 + run `node scripts/patch-native-permissions.mjs` before OTA (rule 12).
- Not built: lyrics, sleep timer, playlists beyond the shared Our Playlist, artist/album pages (the providers return no artist/album ids).

## First steps next
1. Build the APK, open Music, tap through: quick pick, mix hero, "…" sheet (all six actions), search → Top result, Like in the full player, Clear queue.
2. Pre-existing: TS2367 at GroicContext.tsx ~1017; 12 failing tests noted in HANDOFF_2026-10-04_MUSIC.md.

## Addendum — next-song quality (see 2026-10-08 (2) in CHANGELOG.md)
Files: src/lib/music/autoNext.ts, queueQuality.ts, queueLogic.ts (pickNativeWindow), src/contexts/GroicContext.tsx (native resync effect), src/pages/Groic.tsx (playFromSearch).
Device checks to do: (1) search a word that is also a title ("payal"), tap a result → the next 4 are different songs and the top-up is by artist/taste; (2) shuffle on, then Play next / Add to queue, let the track end → the queue's order is what plays; (3) repeat-one on an Audius/SoundCloud track → it repeats, never advances; (4) lock-screen next/previous in normal and shuffle mode; (5) a T-Series/YouTube-channel track → suggestions are not "random label uploads".
