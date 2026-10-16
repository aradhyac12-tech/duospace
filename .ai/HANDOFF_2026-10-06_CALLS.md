# Handoff — 2026-10-06 — calling audit (dead call / ring after hang-up / slow audio)

NOT RUN: no node_modules/network here — vitest, tsc, Gradle, device all unverified.

Root causes
1. Caller hangs up while ringing -> status 'cancelled' -> notify_push_on_call() sent NO push (only missed/declined/completed). Android ringer is started by FCM alone, so a backgrounded callee kept ringing/vibrating up to 45s.
2. FCM ordering: a stop push handled before the ring push was forgotten, then the ring started for a dead call.
3. No code looked at the LiveKit room: partner gone + lost CALL_ENDED/push = call "alive" in background forever.
4. livekit-token isolate warmed only once at login -> cold start (seconds) after Accept; mic capture also started only after the token arrived.

Changes
- supabase/migrations/20261006120000_push_stop_ring_on_cancel.sql (APPLY; staging first) — call_ended push on cancelled/failed.
- native/android/CallRingingService.kt, CallNotificationService.kt — ended-call tombstones (120s); stop-with-nothing-ringing stops the service. Rebuild APK.
- src/contexts/CallContext.tsx — peer-left watchdog (DB check at 1.5s/8s, hard end at 20s); cancelOutgoingCall sends socket cancel in parallel with DB write + one retry.
- src/lib/callWarmup.ts (new) + IncomingCallOverlay — re-warm token isolate every 3 min, on foreground, and when a call starts ringing.
- SelfHostedCallEngineAdapter.ts — mic capture starts in parallel with the token request.

Check: callingReliabilityPhase5 / cancel-order tests; two-device test: cancel while callee app killed; accept after idle 10 min.

## Part 2 — notification tap vanishes / no way to answer / lost-call recovery
Root causes
- Tapping the notification BODY sent ACTION_STOP to CallRingingService (stopForeground(REMOVE)) -> notification + ringer gone instantly.
- Native sends action "open" but usePushNotifications only revealed the answer screen for a falsy action -> overlay stayed hidden (nativeOwnsUi) -> no Answer/Decline anywhere.
- A tap replayed on cold start arrived before the call hydrated, so the reveal was lost.
Changes
- scripts/patch-native-permissions.mjs (Kotlin + Java MainActivity templates): "open" no longer stops the ringer; Accept/Decline stop it with callId. Re-run patch script / cap sync, rebuild APK.
- usePushNotifications.ts: "open" reveals the answer screen.
- IncomingCallOverlay.tsx: reveal remembered until the call hydrates; slim always-available Answer/Decline banner while the OS owns the UI; 3s DB ringing-watchdog silences in-app + native ringer if the cancel signal was lost.
- NEW hooks/useRecoverableCall.ts + components/calls/RecoverableCallBanner.tsx: call still live server-side but this device isn't in it -> "Rejoin" / "End" (or "Cancel" while ringing). Floating on every page incl. Chat; inline at top of Calls page. CallContext exposes rejoinCallById / endLostCall.
Not run: tsc/vitest/Gradle/device.

## Part 3 — "person is busy" (WhatsApp / Snapchat / Instagram / phone call)
- native CallNotificationService.kt: on an incoming-call push, if AudioManager.mode is IN_CALL / IN_COMMUNICATION (/ RINGTONE not ours / CALL_SCREENING) the phone does NOT ring; it auto-declines via call-decline with reason "busy" (works with app killed) and posts a quiet "Missed call — called while you were on another call". No decline token in the push, or the POST fails -> rings normally (never swallow a call).
- supabase/functions/call-decline: reason "busy" -> status missed + declined_at + cancel_reason 'busy' (DEPLOYED to Duospace, v16). No migration needed.
- Caller UI: classifyCallOutcome -> "busy"; useCallOutcome (Realtime + CALL_BUSY) -> new {type:"busy"} outcome; CallOutcomeScreen "<name> is on another call"; chat/history rows show "On another call".
- Limits: Android can't say WHICH app; iOS not covered (CallKit); caller push text for a busy decline still reads "declined" if the caller app is backgrounded.
- Test: src/test/callBusyOutcome.test.ts (logic also run under node: busy/declined/missed/answered OK). Device test: start a WhatsApp call on phone B, then call B from A.
