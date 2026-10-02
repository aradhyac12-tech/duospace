# Native Call Notification Audit — Phase 8J

**Source-level trace only. No physical Android or iOS device was available
in this session — anything below marked `REQUIRES REAL DEVICE` is
unverified, per the task's rule that no native call claim is considered
verified without one.**

## Trace: incoming push → notification → call state → answer/decline → cleanup

### Android

1. FCM delivers the data-only `incoming_audio_call`/`incoming_video_call`
   push to **two** registered listeners simultaneously (Android allows
   multiple `MESSAGING_EVENT` receivers):
   - `CallNotificationService.kt` (native) — builds the full-screen ringing
     notification (id `9911`), starts `CallRingingService` (foreground
     service, ringtone + vibration, notification id `9912` — a distinct,
     required-by-Android foreground-service notification, not a user-facing
     duplicate of the ringing UI), and best-effort registers with
     `TelecomHelper`.
   - Capacitor's own FCM service → `pushNotificationReceived` in
     `src/hooks/usePushNotifications.ts` — **found and fixed this session**:
     this unconditionally showed a generic toast for every push type,
     including call-lifecycle ones, which meant a foregrounded call push
     produced the full-screen ringing overlay AND a redundant
     "Incoming video call" toast at the same time. Now excludes
     `incoming_audio_call`/`incoming_video_call`/`missed_call`/`call_ended`/
     `call_rejected` from the generic toast, since native/CallContext
     already own presenting those states.
2. `TelecomHelper` / `DuoSpaceConnectionService` / `DuoSpaceConnection`
   register the call with Android's Telecom framework for Bluetooth/car
   head-unit support. Confirmed by source read: none of these three files
   independently create or show a `Notification` — they only affect
   OS-level call routing/mute/hangup, dispatched back into the app via the
   `duospace-call-control` CustomEvent. No duplicate-notification path found
   here.
3. Accept/Decline on the full-screen notification → `MainActivity` →
   `callAction` extra → JS `handleNativeCallAction` in
   `usePushNotifications.ts` → either navigates to `/chat` (accept — the
   existing `IncomingCallOverlay` active-call check picks up the still-
   ringing `call_history` row) or marks `call_history.status = "missed"`
   and returns (decline). This hand-off is consistent and doesn't appear
   to have a source-level gap.
4. Timeout: `.setTimeoutAfter(45_000)` on the notification auto-dismisses
   it; `CallRingingService` isn't observed to have a matching 45s
   self-stop in the portion read — **REQUIRES REAL DEVICE** to confirm the
   ringtone/vibration actually stops when the notification times out
   rather than continuing to ring with no visible notification.

### iOS

1. VoIP push → `PushKitManager` → `CallKitManager.reportIncomingCall`.
   Source already contains an explicit, well-reasoned guard against
   double-reporting a duplicate/retried VoIP push (see the comment block
   around line 77-86) rather than something this session needed to add.
2. `CXProviderDelegate` answer/end actions are implemented.
3. Cancel and "answered elsewhere" VoIP push variants are both handled per
   Apple's PushKit contract (every VoIP push must resolve to
   `reportNewIncomingCall`, including cancels — the code's comments show
   awareness of this Apple-specific requirement and the standard
   workaround).

## What could not be checked from source alone — `REQUIRES REAL DEVICE`

- Whether the Android full-screen intent actually launches over the lock
  screen on current OEM skins (this varies significantly by manufacturer
  regardless of correct code — Samsung/Xiaomi/etc. battery-optimization
  behavior is a common real-world failure point for this exact pattern).
- Whether `CallRingingService`'s ringtone/vibration loop actually stops at
  the notification's 45s timeout, or only stops on explicit
  accept/decline/cancel.
- Whether receiving a call push while the app is fully killed (not just
  backgrounded) reliably cold-starts `CallNotificationService` — Android's
  background-execution limits vary by OS version and can suppress this.
- Real Bluetooth/car head-unit answer/reject via `DuoSpaceConnectionService`
  — Telecom framework registration succeeding is different from a real
  paired device's answer button working end to end.
- iOS: real VoIP push delivery through APNs to a backgrounded/killed app,
  and whether `reportNewIncomingCall`'s completion handler timing holds up
  under real network latency (Apple will silently stop delivering VoIP
  pushes to an app that doesn't report a call promptly and consistently —
  a policy violation that can't be observed from source).

## Status

- Duplicate-notification risk: **one confirmed instance, fixed** (JS toast
  vs. native full-screen UI). No other duplicate-notification path found in
  the portions of the native call stack read this session.
- Overall: **STATICALLY VERIFIED** for the trace and hand-off logic:
  **REQUIRES REAL DEVICE** for the timing/OS-behavior items above before
  this can be called done.

## Follow-up pass — Android ringing termination (source-level only, no device)

Re-traced item 4 above ("`CallRingingService` isn't observed to have a
matching 45s self-stop — REQUIRES REAL DEVICE to confirm") further than the
original pass had time for, and it's worse than that entry implies: it's
not a timing question a device would resolve either way, because **no code
path existed that could ever stop the service at all**.

Confirmed by source-level grep across `native/android/`,
`native-plugins/callkit-bridge/`, and every JS call site:
- `CallRingingService.ACTION_STOP` was declared but never sent from
  anywhere in the app.
- `CallNotificationService.onMessageReceived` only handled
  `incoming_audio_call`/`incoming_video_call`; the three "this call is
  over" push types the backend already sends to the receiver
  (`missed_call`/`call_ended`/`call_rejected` — see
  `supabase/functions/_shared/fcm.ts`) fell through unhandled.
- The Android side of the CallKit bridge plugin
  (`DuospaceCallKitBridgePlugin.kt`) is an explicit no-op stub —
  `reportCallEnded()` does nothing on Android by design (see its own
  header comment), so there's no JS-triggered path either.
- `MainActivity` (referenced throughout this doc and the Kotlin files'
  comments) is not present in this repository — it's generated by
  `npx cap add android` and patched by
  `scripts/patch-native-permissions.mjs`, not checked in — so the
  accept/decline hand-off described in item 3 above could not be
  re-verified this pass; only the ringing-termination gap was fixed.

Net effect before this fix: on a backgrounded or killed app, once
`CallRingingService` started for an incoming call, there was no way to
stop it — not the caller cancelling, not the call being answered
elsewhere, not the call ending normally — short of the OS eventually
killing the process. This is the specific failure mode the brief's
"NATIVE TERMINATION" section describes ("the native ringing UI must
terminate immediately").

**Fixed (source-level; still REQUIRES REAL DEVICE to confirm):**
- `CallNotificationService.kt` now handles `missed_call`/`call_ended`/
  `call_rejected` by sending `CallRingingService.ACTION_STOP` (with the
  push's `callId`) and cancelling the ringing notification.
- `CallRingingService.kt` now tracks `currentCallId` and checks it before
  honoring `ACTION_STOP`/`ACTION_SILENCE` — a delayed/out-of-order stop
  push for an old call can't cut off a newer one ringing now (item 12:
  "a stale event from an old call must never terminate a newer call" —
  the same principle `callStateMachine.ts` enforces on the web side,
  applied here to this service's one piece of state since there's no
  shared machine to plug native code into).
- `CallRingingService.kt` also now self-stops after 45s regardless
  (matching `CallNotificationService`'s own `.setTimeoutAfter(45_000)`),
  as a safety net for the stop push itself being delayed or dropped —
  FCM delivery is best-effort like any other push.

**Still REQUIRES REAL DEVICE:**
- Whether `missed_call`/`call_ended`/`call_rejected` pushes are actually
  delivered to `CallNotificationService` (not just Capacitor's generic
  listener) with the same reliability as the `incoming_*_call` pushes —
  unverified assumption carried over from the rest of this doc.
- Whether `startService()` inside `stopIncomingCallUi` succeeds if
  `CallRingingService` isn't already running when the stop push arrives
  (background-service-start restrictions vary by OS version/manufacturer
  and FCM's temporary foreground exemption window — flagged in the code
  comment at that call site, wrapped in try/catch either way).
- Telecom-level (`DuoSpaceConnectionService`/`DuoSpaceConnection`)
  termination was NOT touched this pass — `TelecomHelper.kt` has no
  matching "end call" method to call from here, and guessing at
  `DuoSpaceConnection`'s internal lifecycle without being able to compile
  or run it felt like a good way to introduce a new bug while fixing
  another. If Bluetooth/car-head-unit UI also needs to be told a call
  ended (separately from the ringtone/notification fixed here), that's
  the next thing to trace.
- MainActivity's accept/decline hand-off (item 3, original pass) — not
  re-verified, since the file isn't in this repository.
