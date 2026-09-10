# DuoSpace — Calls reliability audit (freeze-phase brief)

Scope: Calls only, per the brief. Map/Chat/Music/Gallery/Groic untouched.
This continues directly from last session's fix (accept-vs-start cancel bug,
v3.4.1) — that fix is carried forward, not redone.

## 1. Current HEAD

Same checkout as the last two sessions (`duospace-map-reliability-hardening.zip`
base + last session's `CallContext.tsx`/`Calls.tsx`/`CallOverlay.tsx` fix +
this session's `Chat.tsx` fix). Version bumped 3.4.1 → 3.4.2.

## 2–4. State machine / incoming / outgoing

Traced `callState` end to end: it's genuinely authoritative — one instance of
`useDailyCall()`, shared app-wide via `CallContext` (this was itself a fixed
bug in an earlier session — "Duplicate DailyIframe instances" — see prior
history). `isAcceptingCall`/`isStartingCall` are the only things that can make
the UI show a call screen while `callState` is still `"idle"`, and last
session's fix means both hang-up buttons now handle that correctly for both
directions. No other producer of call-state UI found. Not re-verified with
two live accounts this session (no device access).

## 5–6. Call UI / glassmorphism

Read only, unchanged — already matches the brief's hierarchy (minimal
identity, subtle glass on controls, visually distinct end-call). No gaps
found worth a change; not touched, per the freeze brief's "don't touch what
isn't broken."

## 7–9. Audio route / mic / camera

`toggleAudio`/`toggleVideo` mutate Daily's real track state synchronously
with the React state that drives the icon — not optimistic-then-hope, an
actual paired call. `leaveCall()` calls Daily's `destroyCall()` on the call
object, which releases all media tracks; verified by reading, not by
confirming zero mic/camera activity on a real device afterward — that needs
actual hardware.

## 10. Call + Music

Already correctly implemented (`GroicContext.tsx`'s call-coordination
effect): pauses only a track that was actually playing when a call starts,
resumes only if it was actually playing, never auto-starts a paused track,
YouTube left alone (doesn't touch the call's audio session). This was
already fixed in an earlier session per the file's own audit comment — read
and confirmed correct, not re-touched.

## 11. Call + voice recording — real gap found and fixed

**Nothing tied an in-progress recording to `callState`.** `isRecording` and
the live `MediaRecorder`/mic stream lived entirely in `Chat.tsx`'s own state,
with zero effect watching `callState`. Chat's render early-returns to
`<CallOverlay/>` once `callState` hits `"joining"`/`"joined"` — but that's a
JSX swap on the same mounted component, not an unmount, so a recording in
progress kept running silently underneath the call screen while
`joinCall()` requested its own separate mic track for the call. Two
concurrent mic claims from the same page/process is unreliable, and on
native, CallKit/Telecom can force the OS audio session over to the call,
potentially killing the recording's track mid-capture with nothing
noticing. Resuming the composer after the call would show a still-running
recording timer that had counted through the whole call, with a Send button
that would ship whatever survived — silence, a truncated clip, or nothing.

**Fix:** a new effect in `Chat.tsx` watches `callState`; the instant it
becomes `"joining"` or `"joined"` while `isRecording` is true, the recording
is cancelled (mic released, timer cleared, nothing sent) with a toast
explaining why. Cancel rather than attempted pause/resume — `MediaRecorder`
pause/resume isn't reliably supported across this app's native targets, and
a file that spans a call interruption is exactly the corrupted-audio outcome
the brief's own wording asks to avoid.

## 12. Call + attachment upload

Already covered and confirmed in last week's Chat audit: calls render via
the same app-root overlay, so an in-flight `resumableUpload()` and its
`setMessages` progress callbacks keep running uninterrupted through a call.
Not re-verified with an actual live upload + live call this session.

## 13. Call termination / cleanup

`leaveCall()` clears every timer it owns (duration, reconnect, poor-quality,
join watchdog), destroys the Daily call object, nulls all three video refs,
and resets every piece of call-related React state in one place — a single
cleanup path reached from every termination route (`endCall`,
`cancelStartingCall`, `cancelAcceptingCall`, remote-left). No separate
cleanup logic duplicated per termination reason that could drift out of
sync. Read-verified, not device-verified.

## 14–15. Call history / missed vs. declined vs. cancelled

`decline_call()` is a real CAS (`claimed_by IS NULL`, atomic UPDATE), sets
both `status='missed'` and a separate `declined_at` marker so the caller's
UI can tell "didn't answer" from "declined" apart — this exact distinction
was a deliberately-added fix in an earlier session, confirmed still present
and now also correctly reachable from the accept-then-cancel path added last
session (marks `missed`+`declined_at` when cancelled pre-join, `completed`
when cancelled just after joining). Outgoing cancel-before-connect uses
`cancel_call()`. No duplicate-row path found — every terminal write is
scoped to `.eq("status","in_progress")`, so a second write after the row's
already terminal is a no-op, not a stomp or a duplicate.

## 16. Background / lock screen

**Not verified — read-only assessment, explicitly flagged per the brief's
own instruction not to claim otherwise.** `CallKitManager.swift`,
`TelecomHelper.kt`, `DuoSpaceConnection(Service).kt`, and the CallKit-bridge
plugin all exist and read as structurally sound (VoIP push → CallKit
report/Telecom connection → app wake → claim → join), but I have no
iOS/Android build or device in this sandbox to confirm any of it actually
behaves this way on a locked or backgrounded phone. This needs a real device
test, not another reading pass.

## 17–18. Notification cleanup / duplicate events

`IncomingCallOverlay` is a single instance mounted once at the app root
(fixed in an earlier session — it used to be Chat-only), subscribes to both
the call's INSERT and its own UPDATE (dismissing on any terminal status OR
on `claimed_by` being set by another device), plus a cold-start reconcile
query for a push-opened app. One state, one realtime pair, no path that
could show two incoming-call screens for the same call_history row found by
reading. The 30s client auto-decline is a real `decline_call()` RPC call
(CAS-guarded), not just a local dismiss, so it can't race a genuine answer
into a false "missed." Native-side notification dismissal (Android's actual
notification-manager cancel, iOS's CallKit end-report) not independently
confirmed — same device-access limitation as §16.

## 19. Network interruption

`Calls.tsx` already has a `reconnecting` state wired through
`callUiState.ts` with its own banner, distinct from `connected` — read as
correct, not re-tested against an actual dropped/restored connection.

## 20–22. Animation / layout / accessibility

Not touched this session — no reported issue, and the freeze brief's own
instruction is not to modify what isn't broken.

## Automated verification (§25)

- Isolated `npx tsc --noEmit` on the one touched file (`Chat.tsx`, in a
  tsconfig-free scratch dir — same approach as every session): clean, no
  real errors.
- No ESLint/Vitest/production build run — no `node_modules`/network in this
  sandbox, same limitation as every session on this project.
- No Gradle/Xcode build — no Android/iOS toolchain here.

**CODE VERIFIED** (this file, by reading + isolated syntax check): the §11
fix and last session's §2/§3/§13/§14 fix.
**BUILD VERIFIED**: no.
**DEVICE VERIFIED**: no — §16, §18's native half, §19, and the two-account
test matrix (§23–24) all still need a real phone.

## Remaining bugs / open items

- §16/§18 native behavior, §19 real-network test, and the full two-account
  matrix are unverified, not "verified and passing" — don't read this
  report as a freeze clearance. The freeze condition explicitly requires
  device verification this session couldn't do.
- Everything else audited this pass (state machine, incoming/outgoing,
  audio/mic/camera read-level, music coordination, upload survival,
  termination cleanup, history/missed-vs-declined, notification dedup,
  reconnecting state) read as already correct — no further code changes
  made for those.

## Files changed

- `src/pages/Chat.tsx` — §11 fix (cancel recording on call start)
- `src/lib/errors/DuoSpaceError.ts` + `package.json` — version bump
  3.4.1 → 3.4.2
