# Handoff — 2026-10-15 — "Maximum call stack size exceeded" crash/lag (v3.22.27)

Report: black-box "died-while-open", repeated `unhandledrejection ... Maximum call stack size exceeded` right after
`liveLocation: realtime_dropped`, 1.5–4.4s main-thread blocks, then process death.

## Root cause
supabase `removeChannel()` re-emits `CLOSED` into the SAME `.subscribe(cb)` callback. Handlers did
`removeChannel(ch)` and only afterwards cleared their reference, so the nested callback still passed its
"is this still my channel" guard -> infinite synchronous recursion -> stack overflow, long tasks, OOM/kill.
Worst offender: LocationContext partner-location channel (dropped every ~2s in the log, retry loop).

## Fix (detach reference BEFORE removeChannel; ignore stale statuses)
- src/contexts/LocationContext.tsx: guard `channel !== thisChannel`, null it first, clear old retryTimer.
- src/contexts/GroicContext.tsx: shared-listening channel + invite probe, same pattern.
- src/test/realtimeReentrancy.test.ts: regression for the pattern.

## NOT verified
No build/test/device run. Run `npm run verify:lock && npm run build && npm test`.
Also separate, unfixed: edge fn `livekit-token` returns error (DS-API-001) on resume — check its Supabase logs.
Check on device: airplane-mode toggle with Location screen open; no `Maximum call stack` in the black-box trail.

---
# Follow-up (v3.22.28) — livekit-token "error" on every resume

Finding: NOT a broken call path. The app sends an intentional empty-body warm-up (isolate pre-warm); the function
correctly answers 400 "callId is required". It was logged as `[warn] returned an error` + `[error] DS-API-001`
on every foreground, from THREE uncoordinated sites (callWarmup, CallContext x2).
Fix: `quiet` option on invokeEdgeFunction + all sites use warmCallBackend() (20s de-dup). Test: src/test/edgeFunctionQuiet.test.ts.

Verified this round: new tests pass; full suite 2628 pass. Pre-existing, unrelated, also fail on the 3.22.26 zip:
src/test/ai-eval/fixtures.test.ts (UNDERSTAND accepts: quote-from-recent-message) and tsc TS2367 at GroicContext.tsx:1103.

NOT verified (needs your Supabase project): that a REAL call gets a token. If calls still fail to connect, check in order:
1. `supabase secrets list` has LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_URL (missing => 503 livekit_not_configured)
2. livekit-token function logs for a real callId (authorizeLiveKitToken denials: status must be in_progress, receiver must hold claim_call claim)
3. The client call-error code in callErrors.ts for the actual failing step

---
# Follow-up (v3.22.29) — GroicContext.tsx:1103 TS2367
Not a bug: `advanceNext` returns early for guests (line ~1083), so the later `!== "guest"` was always true and TS flagged it.
Removed the redundant clause; behaviour identical. Verified: tsc clean for GroicContext, 10 music/listening test files (128 tests) pass.
Remaining pre-existing, unrelated: ai-eval/fixtures.test.ts failure; tsc errors in src/test/surpriseDocument.test.ts and supabase/functions/_shared/ai/gateway.ts.

---
# Follow-up (v3.22.30) — "SoundCloud takes too long to play"
Server already tuned (progressive-first, search-hint fast path, 4-min caches, parallel auth/rate-limit; avg 0.86s in prod).
Gaps found on the client: (1) nothing kept soundcloud-search warm (cold isolate + client_id scrape lands in front of the tap);
(2) re-tapping a loading song restarted the resolve (log showed two tap-to-audio 3s apart); (3) on-screen warm-up didn't re-run on foreground.
Fixes: musicWarmup.ts (+ test), re-tap guard in playTrack (resolveStartedRef, 13s bound, {fresh} retries exempt), fgTick re-warm in Groic.tsx.
Verified: 13 music-related test files / 160 tests pass; no new tsc errors (3 pre-existing: localLibrary.ts:139, Groic.tsx:776-777, plus earlier list).
NOT verified: real-device latency. MEASURE: copy the `music.startup` lines (stage durations from startupTracer) for a first tap after 5+ min idle, before vs after.
Still unaddressed: ExoPlayer HLS buffering time after the URL resolves; the "music section" UX complaint (needs specifics).

---
# Follow-up (v3.22.31) — "music section sucks: all of it (look, search, playback, library)"
Audited by reading code (no device, no screenshots). Fixed only what was provable:
- B Search: no client cache; every query re-hit up to 5 rate-limited edge fns. Added searchCache.ts (+5 tests).
- D Library: save failures were swallowed (user thinks saved, data lost). Now toast (+1 test). Limits that REMAIN: playlists/likes are per-device localStorage
  (no cross-phone sync, lost on reinstall/clear data). Real fix = Supabase tables + RLS + sync (needs migration + deploy; not done).
- C Playback: no defect found by reading. `retry-fresh-url` at foreground is the intended expired-signed-URL recovery, not a bug.
- A Look/feel: NOT changed — cannot judge visual quality without screenshots; blind restyling would be guesswork.
Verified: 17 music/library test files, 182 tests pass; no new tsc errors (pre-existing: Groic.tsx ScanOutcome.reason, localLibrary.ts Uint8Array BlobPart).

---
# Follow-up (v3.22.32) — Liked Songs + playlists now follow the ACCOUNT
Design: one `music_library` row per user (RLS own-row, like music_profiles). `liked`/`playlists` are maps keyed by id with `at` (last change, ms)
and tombstones (`del:true`) so an unlike/delete on one phone is not resurrected by the other. Cycle = pull -> diff local vs last-synced meta
(localStorage `groic-library-sync:<uid>`) -> per-item LWW merge -> apply local -> push only if changed, optimistic concurrency on `updated_at`
(trigger bumps it; conflict => rerun, max 3). Triggers: sign-in, 4s after a real like/playlist change, app foreground.
Safety: every local read/apply asserts the music-profile scope == the sync's user (sign-out mid-cycle aborts instead of tombstoning everything).
Remote data is sanitized. Caps: 500 liked, 50 playlists (overflow tombstoned so devices agree). Tombstones dropped after 30 days.

## DEPLOY (not done — needs your project)
`supabase db push --project-ref jzlpelxwzjjpddqcrtpu`  (or paste supabase/migrations/20261016100000_music_library_sync.sql into the SQL editor). No edge function changes.

## Verified
- 21 new tests (merge + two-phone engine incl. conflict retry, no-resurrection, offline merge); mutation-checked (broken tombstones / inverted LWW both fail the suite).
- Migration parsed with a real Postgres parser (pglast), NOT executed against a database.
- Full suite 2656 pass; sole failure is the pre-existing ai-eval fixture. No new tsc errors.
## NOT verified
- Against real Supabase (RLS, the `.eq("updated_at", ...)` string round-trip with microsecond timestamps, CHECK size limits).
- On two real phones. TEST: apply migration, like a song on phone A, open app on phone B (foreground) -> appears; unlike on B -> disappears on A.
## Accepted limits
Same playlist edited on two phones at once keeps the later whole-playlist edit; a phone offline >30 days can resurrect something removed elsewhere;
Recently Played is still per-device; "Our Playlist" (partner) untouched.
