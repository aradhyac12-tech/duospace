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
