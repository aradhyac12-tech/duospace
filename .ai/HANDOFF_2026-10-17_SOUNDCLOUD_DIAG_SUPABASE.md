# Handoff — 2026-10-17 — SoundCloud "loading" diagnostic + Supabase logs

Input: diagnostics JSON (track "Tumhe Apna Banane Ka", soundcloud:238249771; engine state=loading, pos 0, dur 0,
buffering, HLS aac_160k URL cached, inNativeWindow true, notification confirmed) + prod Supabase logs (jzlpelxwzjjpddqcrtpu).

## Supabase evidence (UTC, 2026-10-17)
- 13:10:36-40 app launch burst: ~25 music requests in ~2s (music-trending x2, music-search x4, audius-search x6,
  soundcloud-search x6, jamendo-search) + a dozen isolate boots. Tap-to-play at 13:10:42 competes with this.
- 13:10:42 OPTIONS -> 13:10:43.49 POST 200 soundcloud-search (stream resolve): server answered in ~1s. Server is NOT the stall.
- POST 400 on soundcloud-search every 3 min at :36 (13:34, 13:37, 13:40 ...): this is musicWarmup.ts keep-warm sending an
  intentionally EMPTY `streams` batch (documented, quiet). Benign, not a bug. Do not "fix".
- jamendo-search 404 at 13:10:43 (one dead/unknown track, not investigated).
- No ERROR/FATAL for soundcloud-search in the window.

## What the diagnostic does / does not prove
- The snapshot's events end at 13:10:43, ~1s after load(). Position 0 / loading is NORMAL that early; it does NOT prove a hang.
- URL is HLS (path contains .m3u8 beyond the 48-char truncation); media3-exoplayer-hls is a dependency and buildMediaItem sets
  APPLICATION_M3U8, so a missing-decoder cause is ruled out by reading.
- Existing safety net: GroicContext native stall watchdog = 7 ticks x 2s (~14s frozen position) -> retry once with fresh URL -> skip.
  A real hang should self-clear in ~14-16s; if it does not, that is the actual bug.

## Change (diagnostics only, no behaviour change)
- src/contexts/GroicContext.tsx diagnose(): adds capturedAt, hidden, online, pathTail, hasM3u8, expiresHint.
- NOT version-bumped (package.json is 3.22.32 though the zip is named v3_22_46 — reconcile before shipping/OTA).
- Not built, no tsc/vitest run, never run on device.

## Next step to get a conclusive answer
Reproduce, wait >=20s on the spinner, THEN copy diagnostics. Also grab `adb logcat | grep -i -E "duospacea?udio|exoplayer|hls"`
and any "music.watchdog" lines. If it stays stuck past ~20s, candidates: HLS playlist fetch retrying silently (media3 default
load-error policy), launch request flood starving the player, expired signature (expiresHint).
