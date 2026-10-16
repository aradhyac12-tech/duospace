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
