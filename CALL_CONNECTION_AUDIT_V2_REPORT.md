> **Superseded (2026-09-23):** DuoSpace calling is now self-hosted only (WebSocket signaling + LiveKit). Mentions of the previous provider below are historical. Current architecture: `docs/calling-architecture.md`; migration record: `docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md`.

# DuoSpace Call Connection Engine V2 — Audit Report

## Scope note (read first)

This codebase had already been through multiple prior calling-reliability/latency
passes before this audit (visible in-code: parallel Daily key resolution, merged
`create-and-token`, single-flight SDK loading with failure recovery, atomic
`claim_call`, generation-guarded cancellation, an explicit call-latency tracer,
a simulcast ladder, deferred noise-cancellation, etc.). Rather than re-do that
work, this pass traced the real execution path against each of the brief's 28
items to (a) confirm what was already correctly handled, and (b) find what was
still actually wrong. **One confirmed P0 bug was found and fixed.** No other
critical-path defect was found in the files traced. Sections 22/23/26 (network
switch, background/foreground, real-device test matrix) require a running app
on real hardware and were **not tested** — this environment is source-code only
(no build tooling, no device, no network egress for `npm install`). Reported
below as NOT TESTED, not guessed at.

---

## A. Actual root causes found

**P0 — CONNECTED declared before remote audio is real (confirmed, fixed)**

`joinCall()` (in `useDailyCall.ts`) resolves the instant this device's own
`call.join()` succeeds — i.e. **LOCAL_JOINED**, not "the other person is here."
All three call-establishment call sites — outgoing in `Calls.tsx`, outgoing in
`Chat.tsx`, and incoming-accept in `CallContext.tsx` — treated that resolution
as the finish line:

- `callStateMachine`'s `CONNECTED` event was dispatched immediately after
  `joinCall()` resolved.
- `callLatency.finishTrace("connected")` was called at the same instant, so
  `totalSetupLatencyMs` measured tap→local-join, not tap→usable-call — exactly
  the wrong number for a "why do calls feel slow" investigation, and exactly
  what section 3/4 of the brief warned against ("do not call the call
  connected merely because call.join() resolved").

This is a real defect in the *state semantics and telemetry*, not a visible
UI bug — see the mitigating factor below.

**Mitigating factor (why no one likely noticed):** the actual on-screen
"Ringing…" vs "Connected" UI does **not** read from `callStateMachine` at all.
It's driven by `callUiState.ts`'s `deriveCallUiState()`, which already
correctly gates `"connected"` on `participantCount > 1` (the partner has
actually joined the Daily room). So the person watching the screen was never
shown a false "Connected" before the other side picked up. The bug's impact
was confined to: (1) the state machine having a technically-wrong internal
`CONNECTED` transition that other logic *could* have keyed off in the future,
and (2) latency telemetry under-reporting real connect time.

No other P0/P1 defect was found in the traced files. Everything else audited
below was already implemented correctly.

**P1/P2 — none found in this pass.** (See "Remaining blocker," item J, for
what a future pass would need real telemetry to find.)

---

## B. Before/after architecture

```
OLD (outgoing, Calls.tsx/Chat.tsx)
Tap → busy-check → create-and-token (parallel room+token) → joinCall()
    → call.join() resolves (LOCAL join only)
    → dispatch CONNECTED / finishTrace("connected")   ← WRONG MOMENT
    (meanwhile, on screen: still correctly shows "Ringing…" until
     participantCount > 1, via callUiState.ts — unaffected by the above)

OLD (incoming, CallContext.tsx)
Accept → claim_call (atomic) → get-token → joinCall()
    → call.join() resolves (LOCAL join only)
    → dispatch CONNECTED / finishTrace("connected")   ← WRONG MOMENT

NEW (both paths)
... → joinCall() → call.join() resolves (LOCAL join only, unchanged)
    → await waitForRemoteAudioReady(8000)   [NEW]
        resolves true the instant Daily reports remote audio "playable"
        (participant-joined-with-playable-audio, or track-started/audio),
        or false after an 8s bounded timeout (never hangs the flow)
    → dispatch CONNECTED / finishTrace("connected")   ← CORRECT MOMENT
```

No change to: Daily room/token creation, key resolution, busy check, claim
logic, SDK loading/warming, simulcast config, noise-cancellation timing, or
any visual/CSS/layout. `joinCall()`'s own resolution point is unchanged (other
logic — e.g. `callState === "joined"` gating camera-picker enumeration —
legitimately still wants "local join done," so it wasn't touched).

---

## C. Latency measurements

**Not available.** This environment is the extracted source tree only — no
build pipeline, no emulator/device, no network egress to run the app or hit
Daily's/Supabase's live APIs. Per the brief's own rule ("do not invent
numbers"), no cold/warm median/p95 figures are reported. The
`totalSetupLatencyMs` metric now measures the correct interval
(tap → real remote audio) going forward; a follow-up pass with a real device
and `call.latency` log access should pull the actual distribution.

---

## D. Stage timing

Structurally unchanged and already correct in the existing instrumentation
(`callLatency.ts`), which already separates:

- `daily_room_requested` / `daily_room_ready`
- `token_requested` / `token_ready`
- `join_started` / `joined_meeting`
- `remote_participant_detected`
- `first_remote_audio` / `first_remote_video`
- `connected` (now genuinely gated on remote audio — see A/B above)

No fabricated per-stage millisecond figures are given, per C above.

---

## E. State-machine changes

Only the **moment** `CONNECTED` is dispatched changed; the transition table
in `callStateMachine.ts` (`CONNECTING → CONNECTED`) is untouched.

- `CONNECTING`: entered exactly as before — once `joinCall()`/accept flow
  begins (unchanged).
- `RINGING` (`OUTGOING_RINGING` / `INCOMING_RINGING`): unchanged.
- `CONNECTED`: now entered only after `waitForRemoteAudioReady()` settles
  (real remote audio, or an 8s bounded fallback) rather than immediately on
  local join.
- `RECONNECTING` / `ENDED`: unchanged.

---

## F. Reliability verification

| Scenario | Result |
|---|---|
| Double tap Call / Accept | NOT TESTED (requires running app) |
| Cancel during connecting (room/join/token pending) | NOT TESTED — code path reviewed: the cancellation check after `joinCall()` resolves is preserved and now re-checked again after the new `waitForRemoteAudioReady()` wait, so a cancel arriving during that wait still hits the existing `leaveCall()` + DB-cleanup path, not a stale CONNECTED |
| Duplicate accept / two-device accept | NOT TESTED — `claim_call` atomicity untouched by this change |
| Network switch (Wi-Fi↔4G) | NOT TESTED |
| Background/foreground | NOT TESTED |
| Retry after failure | NOT TESTED |

Everything above requires a real device/build, which this environment cannot
provide. Marked honestly as NOT TESTED rather than assumed PASS.

---

## G. Security verification

No changes touched authorization, `claim_call`, RLS, authentication, token
issuance, or call-history ownership checks. The new code only adds a
client-side wait on an already-established, already-authorized Daily call
object's own event stream (`participant-joined` / `track-started`) — it makes
no new network or database calls and holds no secrets.

---

## H. Files changed

- `src/hooks/useDailyCall.ts` — added `remoteAudioReadyRef` /
  `remoteAudioWaitersRef` and the exported `waitForRemoteAudioReady(timeoutMs)`
  function; reset per call attempt; resolved from the two existing
  "first remote audio" event sites (`participant-joined`, `track-started`).
- `src/contexts/CallContext.tsx` — incoming-accept flow now awaits
  `waitForRemoteAudioReady(8000)` before dispatching `CONNECTED` /
  finishing the latency trace; cancellation re-checked after the wait.
- `src/pages/Calls.tsx` — outgoing flow: same change; destructures
  `waitForRemoteAudioReady` from `useCall()`.
- `src/pages/Chat.tsx` — outgoing flow: same change (this file doesn't use
  `callStateMachine`, so only the latency trace's finalization moved).

Diff attached separately (`duospace-connection-fix.diff`).

---

## I. UI regression

No intentional UI/UX change. Visual "Ringing…"/"Connecting…"/"Connected"
states, layout, animations, colors, typography, controls, and gestures are
untouched — `callUiState.ts` (which drives all of that) was not modified and
was already correct.

---

## J. Remaining blocker

Cannot be determined without real measurements (see C). The one structural
gap worth flagging for a follow-up pass with real telemetry: `daily_room_ready`
/`token_ready`/`joined_meeting` stage timings already exist in the tracer, but
without a device/network to actually run calls, it's not possible to say from
source alone whether the dominant remaining latency is Supabase Edge Function
cold-start, Daily REST round-trips, WebRTC/ICE establishment, or the remote
device's own network — that requires pulling real `call.latency` log data
(now more trustworthy thanks to the fix in this pass) rather than further
speculative code changes.
