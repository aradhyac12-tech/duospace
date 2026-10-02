# DuoSpace — Calls audit: the "End call" during Accept bug

Scope: the previously flagged-but-untouched ~500-line live in-call block in
`Calls.tsx`, plus its counterpart `CallOverlay.tsx` (Chat's own in-call
screen) and `CallContext.tsx` (where accept/decline actually live). No Calls
UI redesign — one real, reproducible bug found and fixed; everything else in
the block read as correct.

## Root cause

Both `Calls.tsx`'s and `CallOverlay.tsx`'s hang-up buttons decide which
cancel path to use with `callState === "idle" ? cancelStartingCall() :
endCall()`. That check was written for the OUTGOING call's pre-join window
(tap "Call" → busy-check → permission prompt → `create-and-token` → THEN
`joinCall()`, which is what actually flips `callState` off `"idle"`).

The full-screen call UI, though, is also shown while `isAcceptingCall` is
true — and `acceptIncomingCall()` (`CallContext.tsx`) has the exact same
shape: `claim_call` RPC → `get-token` edge function (up to 25s on a cold
start) → THEN `call.joinCall()`. `callState` stays `"idle"` for that entire
window too.

So tapping "End call" while a call was still being **accepted** (not
started) landed on `cancelStartingCall()` — a page-local function built only
for the outgoing flow. It set a ref `acceptIncomingCall()` never reads,
called `leaveCall()` (a harmless no-op since nothing had joined yet), and
showed "Call cancelled" — but nothing actually stopped
`acceptIncomingCall()`'s in-flight `claim_call`/`get-token`/`joinCall` chain.
A few seconds later the call would connect anyway, and the full-screen call
UI would silently reappear (`callState === "joined"` alone satisfies both
screens' render gate), even though the person had already been told the
call was cancelled and had put the phone down.

## Fix

- `CallContext.tsx`: added `acceptCancelledRef`, checked at both await
  boundaries inside `acceptIncomingCall()` (after `claim_call`, after
  `get-token`, and again right after `joinCall()` resolves in case
  cancellation landed mid-join). Each checkpoint does the *correct* thing for
  where the flow actually is — a DB update marking the claimed row `missed`/
  `declined_at` if cancelled before joining (can't reuse `decline_call()`
  post-claim; it requires `claimed_by IS NULL`), or a real `leaveCall()` +
  `completed` update if cancelled just after joining.
- Added `cancelAcceptingCall()`, exposed on `CallContext` — sets the ref,
  drops `isAcceptingCall` immediately (don't wait for the network to notice),
  tears down anything that may have already joined.
- `Calls.tsx` and `CallOverlay.tsx`: hang-up button now checks
  `isAcceptingCall` first, before falling back to the outgoing-call
  `callState === "idle"` check. `CallOverlay` gained `isAcceptingCall`/
  `cancelAcceptingCall` as distinct optional props (previously only fed a
  conflated `isStartingCall={isStartingCall || isAcceptingCall}` used for
  display, which was fine — this is a separate prop for the button's
  decision, not a display change).

## Everything else in the block (verified, not changed)

Traced start-to-end: busy pre-check, permission flow, `create-and-token`
latency fix, cancellation-during-outgoing-start (this one already worked
correctly — it's the pattern the accept side was missing), duplicate-
DailyIframe guards, call-state crossfade, self-preview drag/snap, idle
auto-hide controls, camera/audio-route pickers, PiP, lip reading toggle,
screen-share, multi-device claim race safety. No other gaps found.

## Verification

- Isolated `npx tsc --noEmit` per touched file (no real build/network in
  this sandbox — same limitation as every session on this project): zero
  syntax errors, only the expected missing-`@types/react` noise from
  checking files outside their real project context.
- Not build-verified, not device-verified. This needs a real two-device
  test: A calls B, B taps Accept, A or B taps End before B's screen fully
  connects, confirm the call actually ends and doesn't silently reconnect.

## Files changed

- `src/contexts/CallContext.tsx`
- `src/pages/Calls.tsx`
- `src/components/chat/CallOverlay.tsx`
- `src/pages/Chat.tsx` (wiring only — passes the two new props through)
- `src/lib/errors/DuoSpaceError.ts` + `package.json` — version bump
  3.4.0 → 3.4.1 per this repo's rule (every shipped change bumps both)
