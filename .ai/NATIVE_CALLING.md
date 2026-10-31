# Native calling — what is in the source (Phase 1.6 static audit)

STATUS: NOT VERIFIED on any device or emulator. Nothing here has been built or
run in any sandbox. See KNOWN_ISSUES KI-19 for the incoming-call fixes that are
source-level only.

## Provider
Self-hosted only: `src/lib/callEngine/SelfHostedCallEngineAdapter.ts`
(LiveKit), `src/lib/signalingEngine/` (WebSocket call control),
`infrastructure/`, edge functions `livekit-token`, `signaling-ticket`.
Native code is provider-agnostic (media is WebView WebRTC).
See `docs/calling-architecture.md`.

## Android (files in `native/android/`, copied into the generated project by
`scripts/patch-native-permissions.mjs`)
`CallBridge.kt`, `CallNotificationService.kt`, `CallRingingService.kt`,
`CallOngoingService.kt`, `DuoSpaceConnection.kt`, `DuoSpaceConnectionService.kt`,
`TelecomHelper.kt` (self-managed Telecom `ConnectionService`),
`DuoSpaceMessagingService.kt` (FCM), `NotificationChannels.kt`,
`DuoSpaceLocationService.kt`, `CrashLogger.kt`. FCM config: `google-services.json`
is present in `native/android/` (a client config, not a signing key).

## iOS (files in `native/ios/`)
`CallKitManager.swift`, `PushKitManager.swift`. The patch script copies them into
`ios/App/App/` but they must then be added to the Xcode **App target by hand**
(the script says so) — this step is not automated (KI-29).

## Push
Edge functions `send-push` (FCM/APNs alert push) and `send-voip-push` (PushKit).

## Bridge plugin
`native-plugins/callkit-bridge` (`DuospaceCallKitBridge`): CallKit on iOS,
deliberate no-op on Android (Telecom is wired at the native layer).

## Privacy facts for calls
Call media transits the self-hosted LiveKit SFU (and TURN relay when needed);
it is not end-to-end encrypted at the application layer. No recording/egress
service is deployed. Registered as sensor purpose `CALL_MEDIA`
(`src/lib/privacy/sensorPolicy.ts`).
