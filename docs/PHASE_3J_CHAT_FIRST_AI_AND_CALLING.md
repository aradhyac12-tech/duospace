# Phase 3J — Chat-first relationship AI, calling fixes, location ringback (2026-09-27)

Baseline: uploaded `duospace-redesign-final.zip` (3.17.0 + calling/surprise changes). Earlier in-progress work re-applied on top (no overlapping files). Baseline before changes: vitest 1224 passed; eslint 0 errors / 100 warnings; tsc 3 pre-existing errors (surprise).

## 1. Calling
**Evidence (production, read-only logs, last 24h):** `signaling-ticket` 433× 200; the self-hosted gateway (user-agent `node`) authorised calls via `signaling_get_call_facts` as recently as 09:01 → the server is up, failures are intermittent. `livekit-token` 30× 400 are the app's deliberate warm-up calls with an empty body (`CallContext.tsx`) — noise, not failures.
**Root cause (code):** readiness waits were shorter than one signaling attempt (per-attempt connect timeout 10s): accept waited 8s, outgoing default 5s. On a phone just woken by the ring push, ticket fetch + DNS + TLS often exceed that, so the app gave up mid-attempt → "Couldn't reach the calling service (CONNECT_TIMEOUT)", stuck on Connecting after pick-up, then "Couldn't join call".
**Fix:** `CallSignalingClient.ensureReady` never waits less than `MIN_READY_WAIT_MS` (12s); accept waits `SIGNALING_ACCEPT_READY_TIMEOUT_MS` = 20s (two attempts, inside the 60s accept watchdog). Healthy networks connect as before (sub-second when pre-warmed during ringing).
**Test:** `signalingReadyWait.test.ts` (4) — fails on the old values, passes now. All 18 call/signaling test files (162 tests) pass.
**Not verified:** on a device/network. If the gateway is genuinely down, no timeout change helps — check `wss://…/health`, TLS expiry, firewall.

## 2. Ringback by location (caller's "it's ringing" tone)
`src/lib/ringback.ts` (pure) + `sounds.ts` playback. Location from the device **time zone** first (Asia/Kolkata → India, Asia/Bishkek → Kyrgyzstan…), then locale region; the app language is never used. Before: region came only from `navigator.language`, so Indian phones on `en-US` played US beeps; the "India" tone was a 920 Hz chirp.
| Region | Tone | Cadence |
|---|---|---|
| India | 400 Hz × 25 Hz AM (375+425) | 0.4 on · 0.2 off · 0.4 on · 2.0 off |
| Kyrgyzstan / CIS | 425 Hz | 1.0 on · 4.0 off |
| US/Canada | 440+480 Hz | 2.0 on · 4.0 off |
| default | 400+450 Hz | 0.4 · 0.2 · 0.4 · 2.0 |
Plays only while the call UI is "ringing"; message sound (user's audio file) and incoming ringtone (user's chosen file) are unchanged and distinct. `ringback.test.ts` (6). Not verified by ear on a device.

## 3. Chat-first relationship AI — one extraction, three presentations
- **Canonical extractor:** `src/lib/relationship/contextual/extract.ts` with the only pattern set in `contextual/patterns.ts` (leaf module, no cycle). Kinds: REQUEST, QUESTION, FEELING, APOLOGY, BOUNDARY, UNCERTAINTY (clarification), EVENT, ACCUSATION, CONTROL, PAST_EXPECTATION, ACKNOWLEDGEMENT, DEFENSIVE. Every fact: exact phrase, `[start,end)` span with `text.slice(start,end) === phrase`, rule id, source message id; optional `detail` (request object) also span-exact. Safety via the one shared `checkSafety` gate (all 12 languages). Non-English: only script-independent questions; otherwise "can't reliably tell".
- **Responsiveness engine refactored:** `analyzeMessage` now reads the extraction (no regex of its own). All Phase 3B tests unchanged and passing.
- **Consumers:** `QuickReplySheet` (≤3 grounded intents, honest fallback, chips Another/Shorter/More casual/Ask first, never sends), `UnderstandSheet` (one grounded sentence, Why?, Help me reply, lightweight repair entries), `TodayInsight` (at most one observation from today's partner messages in the local decrypted cache; else "Nothing to flag today"; stores only dismissed message ids). Old mood check-in moved under More tools; Compare/Repair/Memory/insights unchanged.
- **Privacy:** no network, no new tables, no raw message persistence, consent gate `RELATIONSHIP_INSIGHTS` before any processing.
- Tests: `contextual.test.ts` + `contextualUi.test.tsx` (51). The previous MessageContextMenu test failure was the test using `open` instead of the component's real `isOpen` prop — fixed in the test, component API unchanged.

## 4. Baseline defects fixed (minimal, no behaviour change)
`surpriseEngine.ts` untyped `data?.length`; two unused `@ts-expect-error` in `surpriseCapabilities.test.ts`.

## Gates (this run)
vitest 113 files / 1285 passed / 2 skipped / 0 failed; tsc app 0, node 0; eslint 0 errors / 100 warnings (= baseline); build 0; lock-sync 0; Android deps gate 0; check:rls 0. Duplicate-logic audit: message patterns exist only in `contextual/patterns.ts`; no direct pattern regex use elsewhere.

## Status: PARTIAL
Code verified; device behaviour (calls, ringback, long-press sheets, Today) NOT VERIFIED; native-language review NOT done.
