# Handoff — 2026-10-04 — calling fixes (v3.22.9)

Owner reported: caller stuck on "Ringing" after the callee picked up; Answer/Decline notification auto-hides; video-call screen bad; ring + notification linger after hang-up.

Changed:
- src/lib/callEngine/SelfHostedCallEngineAdapter.ts — participant count from remoteParticipants (not room.numParticipants); new `remoteVideoOn` state (+ types.ts).
- src/lib/callUiState.ts, src/pages/Calls.tsx, src/pages/Chat.tsx — remote audio playing => connected / everConnected.
- src/lib/sounds.ts — scheduled ringback oscillators are tracked and silenced on stopRingtoneLoop().
- src/components/calls/CallStage.tsx — removed `relative` (beat `fixed`), added overflow-hidden, "Camera is off" avatar.
- android/.../CallRingingService.kt + IncomingCallNotification.kt — 3s heads-up refresh while ringing.
- supabase/functions/_shared/fcm.ts — call_ended / call_rejected now HIGH priority. REDEPLOY send-push.
- src/test/callingReliabilityPhase5.test.ts — 2 new cases.

Not run (no node_modules/network): vitest, tsc, eslint, Gradle. Nothing verified on a device.
Next if the heads-up refresh flickers on the owner's phone: set a full-screen intent only when the screen is locked/off (KeyguardManager / PowerManager), instead of the refresh loop.
