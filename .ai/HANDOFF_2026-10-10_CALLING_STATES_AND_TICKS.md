# Handoff 2026-10-10 — WhatsApp-style calling states + delivered ticks

## Done (not type-checked/built here: no node_modules in the sandbox — run `npm run build` / tests)
1. Calling: new CallUiState "calling" (src/lib/callUiState.ts). Outgoing call shows "Calling…" until the callee's
   device is reached, then "Ringing…" (+ ringback tone, which only plays on "ringing").
   - Reached = offer ack DELIVERED (Calls.tsx -> markPeerRinging(true)) or inbound CALL_RINGING (CallContext).
   - RECIPIENT_OFFLINE stays "Calling…" until CALL_RINGING arrives.
   - CallContext exposes peerRinging / markPeerRinging; CallStage + Calls.tsx pass peerRinging to deriveCallUiState.
   - peerRinging undefined = legacy behaviour (always "ringing"), so old callers/tests are unaffected.
2. Ticks: single grey = sent, double grey = delivered, double blue = read.
   - Migration supabase/migrations/20261010100000_message_delivered_ticks.sql (delivered_at + mark_messages_delivered() RPC). DEPLOY IT.
   - Recipient device calls the RPC (DockBadgesContext) on mount/online/visibility/new message.
   - Chat.tsx select falls back gracefully if the column isn't deployed yet.

3. Killed-app ringing ack (DONE, source-level; native part NOT compiled/device-tested):
   - android CallRingingAck.kt, called first thing in CallNotificationService.onMessageReceived for incoming_*_call pushes.
     POSTs to <functions>/call-ringing using the existing decline token fields (declineUrl/Token/Exp/Receiver).
   - Edge function supabase/functions/call-ringing (verify_jwt=false, config.toml) -> RPC mark_call_ringing (service_role only)
     -> call_history.ringing_at.
   - CallContext watches ringing_at (realtime + one-shot select) for the active outgoing call -> peerRinging=true.
   - Note: on Android the in-app overlay no longer rings, so this native ack is the main "Ringing" signal for Android callees.

## Applied to PRODUCTION (Supabase project jzlpelxwzjjpddqcrtpu "Duospace") on 2026-10-10
- migration message_delivered_ticks (messages.delivered_at + mark_messages_delivered())
- migration call_ringing_ack (call_history.ringing_at + mark_call_ringing())
- edge function call-ringing v1 (deployed with a local copy of callActionToken.ts; repo version imports ../_shared/)
- All other repo migrations were already applied. Needs CALL_ACTION_SECRET (already used by call-decline).
- Rebuild the APK to get the native ack (needs a new Android build).

## TODO / next
- Update/add tests in src/test for callUiState "calling" and MessageStatus delivered.
- Optional: "Unavailable"/no-answer timeout copy when stuck on "Calling…" > ~30s.

## Video call improvements (same session; source-level, not built/device-tested)
File: src/lib/callEngine/SelfHostedCallEngineAdapter.ts
- Room now has explicit videoCaptureDefaults (720p, front cam), audioCaptureDefaults (echo/noise/AGC),
  publishDefaults (3-layer simulcast 180/360/720, 1.7 Mbps cap, 30fps, maintain-framerate, backup codec, dtx, red).
- networkQuality was only ever "good"/"poor(reconnecting)". Now driven by LiveKit ConnectionQualityChanged
  (local participant): excellent / good / fair(LK poor) / poor(LK lost). "poor" shows the Reconnecting banner.
- autoAudioFallback (was hard-coded false) now real: link "lost" for 8s with camera on -> our camera auto-pauses
  (existing AudioFallbackBanner + toast in CallStage/Calls.tsx fire); resumes after 10s of fair+ link.
  Manual video toggle always overrides and cancels the auto state. Timers cleared in leaveCall.
- TODO: unit tests for the quality mapping/fallback; tune thresholds (8s/10s, 1.7Mbps) after real-device calls;
  optional: tap-to-swap PiP, remote "camera off" avatar, portrait/landscape handling in CallStage.

## Video screen polish + flip camera (same session; source-level, not built/device-tested)
- FLIP CAMERA was a no-op stub (cycleCamera only logged) and facingMode was never set. Now cycleCamera restarts the
  live camera track on the opposite lens (LocalVideoTrack.restartTrack({facingMode})), falling back to cycling
  videoinput devices; facingMode is tracked (front mirrors the self-view; re-enabled camera resets to front).
  Flip button now shows whenever video is on (was gated on a stale cameras.length>1), 36px target.
- ZOOMED/CROPPED: (1) capture is orientation-aware (portrait 720x1280 on a portrait screen; before, a fixed
  1280x720 landscape request made phones send landscape frames); (2) remote video uses object-contain on black
  when the frame orientation clearly differs from the screen, object-cover otherwise (CallStage remoteFit).
- LOOK: self-view enlarged (~30vw, 104-136px, 3:4, rounded-2xl, ring + shadow), top/bottom gradient scrims for
  header/controls legibility on video calls.
- TODO: verify on device (esp. Android WebView portrait capture + restartTrack on facingMode), consider
  tap-to-swap main/self view, camera-off avatar tile for the remote side.

## Tap-to-swap (same session; source-level, not built/device-tested)
- CallStage: tap the small self-view to make yourself full screen and the partner the small tile; tap the tile to swap back.
  Same two <video> elements (CSS/layout only) so refs/streams never detach. Only when both cameras are live (canSwap);
  auto-resets otherwise. Dragging is disabled while swapped; flip-camera button moves under the header when swapped.
- Already existed (verified, no change): remote camera-off avatar tile (remoteVideoOn is driven by TrackMuted/Unmuted).
- Known nit: while swapped the bottom/top gradient scrims sit under the full-screen self-view (controls still readable on
  the glass dock). Verify z-order of header/dock vs the z-0 self-view wrapper on device.
- TODO: unit tests (callUiState "calling", quality mapping, fallback timers, MessageStatus delivered); device QA list in
  docs/CALLING_DEVICE_VERIFICATION.md.

## Tests added (written, NOT run — sandbox has no node_modules): run `npm test`
- src/test/callingStatesAndTicks.test.ts — deriveCallUiState calling/ringing/legacy/incoming cases.
- src/test/messageStatusTicks.test.tsx — sent / delivered / read ticks (assumes lucide renders class "lucide-check"/"lucide-check-check";
  if the installed lucide version names differ, adjust the selectors).
- src/test/audioFirstFallback.test.ts — quality mapping + audio-first camera pause/resume (fake timers).
  The logic was EXTRACTED from the adapter into src/lib/callEngine/audioFirstFallback.ts (adapter now calls createAudioFirstFallback);
  re-verify the adapter still compiles/behaves (ConnectionQualityChanged handler, toggleVideo/leaveCall cancel()).

## Network handling / auto quality (same session; source-level, not built/device-tested)
New pure module src/lib/callEngine/callNetworkPolicy.ts (+ src/test/callNetworkPolicy.test.ts).
- Offline during a call: adapter exposes isOffline (window online/offline). Reconnect watchdog is 90s when the device is
  offline (tunnel/lift/handoff) vs 30s online, and re-arms a fresh window when `online` fires (was a fixed 30s kill).
- Partner link: remoteNetworkQuality from LiveKit ConnectionQualityChanged (non-local participant).
- Receive-side adaptation: while OUR link is fair/poor, remote video is pinned to the LOW layer (audio keeps priority);
  back to HIGH when it recovers. Sender side unchanged (simulcast + audio-first camera pause).
- UI: one banner at a time, most severe first — "No internet — reconnecting…" > "Reconnecting…" > "Your connection is weak"
  > "Their connection is weak" (voice AND video calls). New banners in CallStatusBanner.tsx.
- Starting a call while offline now fails fast with a toast instead of hanging on "Calling…" (Calls.tsx startCallImpl).
- CallEngine type gained isOffline + remoteNetworkQuality: any test mock/other adapter implementing CallEngine needs them.
- Not done: accepting an incoming call while offline (CallContext accept path), signaling-socket offline UX, Capacitor
  Network plugin for cellular-vs-wifi labelling, adaptive capture resolution (only simulcast layers adapt today).

## Offline round 2 (same session) — VERIFIED in sandbox this time (npm ci + tsc + vitest + vite build)
- Accept while offline: CallContext.acceptIncomingCall bails BEFORE the accept lock / state machine / claim RPC when
  navigator.onLine === false: toast "No internet connection", call keeps ringing, person can tap again.
- Signalling socket down: callNetworkPolicy gained `signal-down` (lowest severity, below weak-them) from a new optional
  `signaling` input; CallStage subscribes to signalingBridge.onConnectionState (4s debounce on "down", immediate on "up";
  only when signalingBridge.isConfigured()); new SignalingDownBanner "Can't reach call server — retrying…".
- Fixed: selfHostedCallEngineAdapter.test.ts livekit mock was missing VideoPresets/VideoQuality/Track/new RoomEvent keys
  (10 tests failed since the previous round's adapter changes). Mock updated; 14/14 pass.
- Fixed: duplicate `cancel_reason` in the CallHistoryRow type in Calls.tsx (TS2300).
- Tests: +3 signalling cases in src/test/callNetworkPolicy.test.ts.
- Results: vitest 2414 pass / 1 fail / 2 skipped; vite build OK. The 1 failure is src/test/singleStopSharingAction.test.ts
  (unlink copy/option test) — NOT touched this round, not investigated.
- tsc -p tsconfig.app.json: no errors in any file touched in these two rounds. Pre-existing errors remain elsewhere
  (admin tabs, AdaptiveQuestionCard, secureKey.ts, Auth.tsx, GroicContext, MessageContextMenu, ai-eval fixtures,
  mediaValidation/surpriseDocument tests, supabase/functions/_shared/ai/gateway.ts).
- Still not done: Capacitor Network plugin for Wi-Fi vs cellular labelling; adaptive capture resolution; device QA
  (native ack, flip camera, portrait capture, thresholds 8s/10s/90s/4s).

## Cleanup round (same session)
- singleStopSharingAction.test.ts: the "restored" assertion matched USE_STOP_SHARING inside a SQL COMMENT of the restore
  migration. Test now strips `--` comment lines first. Migration unchanged (it was correct). That file passes 4/4. Full suite CONFIRMED green after the fix when run in two halves: non-DB 177 files / 2323 pass / 2 skipped; src/test/db (12 PGlite files) 92 pass. Total 2415 pass, 0 fail. NOTE: a single `vitest run` of everything exceeded the sandbox's ~280s tool limit (the PGlite DB tests are slow), it did not hang; run `npx vitest run src/test/db` separately if you hit the same limit.
- Remaining `tsc -p tsconfig.app.json` errors were reviewed, NOT mass-edited: tsconfig.app.json has strictNullChecks:false,
  which disables discriminated-union narrowing (`ok:false` branches) -> the "Property 'category'/'reason'/'failure'/'label'
  does not exist" errors in AdaptiveQuestionCard, Auth.tsx, ai-eval fixtures, _shared/ai/gateway.ts are config artifacts,
  not runtime bugs. `npm run build` (vite) does not type-check, so they never blocked a build. Real-but-minor candidates
  to look at later: secureKey.ts (NativeBiometric plugin typings: isCredentialsSaved / setCredentials overloads),
  admin tabs (Select onValueChange setter types), MessageContextMenu Item[][] typing, mediaValidation.test.ts (TS 5.7+ BlobPart).
- GroicContext.tsx:1042 `!== "guest"` is flagged by control-flow narrowing (an earlier branch already excludes guest);
  not a logic bug as far as read.

## Wi-Fi/mobile-data label + adaptive capture resolution (same session)
- callNetworkPolicy.ts: ConnectionKind + normalizeConnectionKind/connectionNoun; CaptureTier/captureProfileForTier/captureTierFor;
  createAdaptiveCapture (tier steps DOWN immediately on fair/poor, back UP only after 10s of a better link; dedupes; reapply(); cancel()).
- SelfHostedCallEngineAdapter: connectionKind state (Capacitor Network on native, navigator.connection.type on web -> often "unknown");
  captureRef drives mst.applyConstraints({width,height,frameRate ideal}) on OUR camera track from the local ConnectionQualityChanged
  handler (full 1280x720@30 / reduced 640x360@20 / minimal 320x180@15, swapped in portrait). Re-applied after camera flip, manual
  camera re-enable and audio-first resume (a new/restarted track comes back at defaults). Cancelled in leaveCall.
- CallEngine type gained connectionKind (any mock/other adapter needs it). Weak-you banner now reads "Your Wi-Fi is weak" /
  "Your mobile data is weak" / "Your connection is weak" (unknown).
- Verified: tsc clean for touched files; callNetworkPolicy tests 16/16 (new: connection kind, tiers, controller w/ fake timers);
  adapter + related tests 49/49; vite build OK.
- NOT verified: real-device behaviour. applyConstraints on Android WebView / iOS may be ignored or clamp differently; LiveKit
  may also re-request its own constraints on republish. Check the capture_tier / capture_tier_failed log lines on device.
  navigator.connection.type is not exposed by Chrome/Android WebView on web builds, so web shows the generic wording.

## Top tier raised: up to 1080p @ 90/60 fps by device (owner request, same session)
- callNetworkPolicy: tier "full" is now up to 1920x1080 (1080x1920 portrait) at pickMaxFps(caps): 90 if the camera reports >=90,
  60 if >=60, else 30 (unknown capability -> request 60; `ideal` constraints are clamped by the browser, never an error).
  Clamped to the camera's reported max width/height. maxBitrateFor() = ~0.05 bit/pixel/frame, 0.3-8 Mbps. good AND excellent links
  both map to this tier; fair -> 640x360@20; lost -> 320x180@15 (unchanged, 10s step-up hysteresis unchanged).
- Adapter: capture defaults 1920x1080@60 (portrait swapped); publish ceilings maxBitrate 8 Mbps / maxFramerate 90 (was 1.7 Mbps / 30);
  simulcast layers 180/360/720 under the 1080p main layer; capability read from mediaStreamTrack.getCapabilities(); tier re-applied on
  RoomEvent.LocalTrackPublished(camera) so 90fps/1080p is requested as soon as the track exists. Log: call.self_hosted.capture_tier "<tier> WxH@fps".
- Verified: tsc clean for touched files, callNetworkPolicy 19/19, adapter+related 48/48, vite build OK.
- NOT verified / honest caveats: (1) real devices — many phone WebViews expose 60fps at best and 90/120fps often only on the native
  camera, so 90 may simply never be offered; (2) WebRTC/the encoder may still cap or drop frames above 60fps and 1080p60 needs a strong
  uplink: BWE (not our 8 Mbps ceiling) decides the real rate, and the weak-link tiers step down within seconds; (3) heat/battery on long
  1080p60 calls — if it shows up, add a thermal/battery cap (e.g. 30fps when battery saver or Device thermal state is serious);
  (4) the receiving side's screen/decoder still limits what the partner sees.

## Battery-saver / long-call cap on the top tier (same session)
- callNetworkPolicy.powerLimitFor(state, callMs): charging=true lifts all caps; level<=15% unplugged -> top tier 720p@30;
  level<=30% -> 30fps (stays 1080p); 20 min of call time while not known-charging -> 30fps ("long-call"); unknown battery -> no battery
  cap (never guessed). Only the TOP tier ("full") is shaped; reduced/minimal tiers are unchanged. captureProfileForTier(tier, portrait, caps, limit).
- Adapter: battery from the native DuospaceDeviceStatus plugin (getStatus + statusChanged) else navigator.getBattery() (often absent on
  WebViews); 30s interval re-checks the long-call rule; on any change of limit reason -> captureRef.reapply() + log
  call.self_hosted.power_limit "<reason|none>".
- THIS IS A PROXY, NOT THERMAL: the device-status plugin has no thermal state or battery-saver flag. Real thermal throttling signals need
  native work (Android PowerManager.getCurrentThermalStatus / addThermalStatusListener API 29+, isPowerSaveMode; iOS
  ProcessInfo.thermalState + isLowPowerModeEnabled) added to native-plugins/device-status and compiled/device-tested - NOT done.
- Approximation: "long-call" uses total call duration, not time-since-unplugged.
- Verified: tsc clean for touched files, callNetworkPolicy 25/25, adapter 14/14, vite build OK. Not verified on a device.
