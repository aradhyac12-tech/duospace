# Background Music Reliability Plan

## Outcome
Deliver one production-ready playback path for **Audius/direct audio tracks** across:

- Android APK: playback continues when the app is backgrounded, the phone is locked, or the task is removed while actively playing; lock-screen, notification, Bluetooth, and car controls remain synchronized.
- Native iOS app: playback continues while backgrounded/locked with Now Playing metadata and remote controls.
- Android browsers: use the real HTML audio element and Media Session where supported, with reliable resume/error handling.
- iOS browsers: provide best-effort playback and recovery, while explicitly preserving the platform limitation that Safari/WebKit cannot guarantee continuous background playback or queue advancement for a normal tab/PWA.
- Calls: music pauses before Daily audio takes ownership and resumes only when it was playing before the call; no competing audio sessions or camera/audio leaks.

YouTube will remain on its existing iframe path and will not be extracted, proxied, or falsely advertised as native background music.

## Implementation steps

1. **Baseline and wiring audit**
   - Verify the local Capacitor audio-engine package is resolved from source in clean web builds and is included after `cap sync` on Android/iOS.
   - Verify generated native projects receive the audio service, media permissions, iOS background-audio mode, and required app capabilities through the existing native patch flow.
   - Add deterministic diagnostics around engine availability, load/play failures, track transitions, service disconnects, audio interruptions, and call handoff without logging private URLs or user data.

2. **Android background playback hardening**
   - Confirm the Media3 `MediaSessionService` is promoted and remains alive only while playback is active, including Android 8–15 behavior and Android 14/15 foreground-service requirements.
   - Ensure the final merged manifest contains `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `WAKE_LOCK`, and the media service declaration.
   - Make service binding/rebinding safe after Activity recreation, process/task backgrounding, and lock-screen transport commands.
   - Keep one ExoPlayer/MediaSession source of truth and make notification metadata, queue transitions, errors, and JS state converge after remote commands.

3. **iOS native background playback hardening**
   - Confirm `AVAudioSession` uses the playback category only for music and never fights the Daily call session.
   - Make Now Playing state update on play, pause, seek, buffering, track changes, completion, interruption, route changes, and errors.
   - Verify remote commands are registered once, removed/disabled when appropriate, and cannot create duplicate handlers after plugin reloads.
   - Ensure generated Xcode projects include `UIBackgroundModes=audio`, required framework/plugin target membership, and the correct release capability configuration.

4. **Web playback hardening**
   - Keep a single `HTMLAudioElement` and make `play()` failures, source errors, stalls, visibility changes, `pageshow`, and ended transitions explicit state-machine events.
   - Use Media Session metadata and action handlers only when supported, with per-action capability guards so unsupported browsers do not throw.
   - Preserve user-gesture requirements and show a recoverable “tap to resume” state when a browser blocks autoplay or background resume.
   - Add browser capability detection so Android browsers get the supported background path and iOS Safari/PWA is reported as best-effort rather than guaranteed.

5. **Call/audio coordination**
   - Audit the Daily audio track attachment and native audio-route lifecycle together with GroicContext.
   - Enforce a single transition sequence: pause music, release/hand off audio focus/session, start or join the call, then restore music only when the pre-call state was playing and the call has fully ended.
   - Cover interruption, headset/Bluetooth removal, app resume, failed joins, and rapid call/music switching.

6. **Tests and production verification**
   - Add/extend unit tests for playback state transitions, queue/remote-command reconciliation, interruption/resume rules, and browser capability branching.
   - Run the required repository checks plus a production web build.
   - On real devices/emulators, validate Android APK and iOS builds with a test matrix covering backgrounding, screen lock, task swipe, Bluetooth controls, notification controls, next/previous, calls, interruptions, and recovery after network loss.
   - Validate Android Chrome and iOS Safari separately; document any OS/browser behavior that is not controllable by application code.

## Technical files likely in scope

- `native-plugins/audio-engine/src/definitions.ts`
- `native-plugins/audio-engine/src/web.ts`
- `native-plugins/audio-engine/android/**`
- `native-plugins/audio-engine/ios/Plugin/AudioEnginePlugin.swift`
- `native-plugins/audio-engine/android/src/main/AndroidManifest.xml`
- `native-plugins/audio-engine/DuospaceAudioEngine.podspec`
- `src/lib/music/nativeAudioEngine.ts`
- `src/contexts/GroicContext.tsx`
- `src/hooks/useDailyCall.ts`
- `src/hooks/useAudioRoute.ts`
- `scripts/patch-native-permissions.mjs`
- native build/setup documentation and focused tests, only where needed to make the behavior reproducible.

No UI redesign, unrelated feature changes, or YouTube audio extraction will be included.

## Platform reality and acceptance criteria

- Native Android and native iOS are the only paths where lock-screen/background playback can be treated as a product requirement, subject to correct native project generation, signing, capabilities, and device testing.
- Android browsers can normally keep an actively playing media element alive in the background, but browser power management and autoplay rules still apply.
- iOS Safari/PWA background playback and automatic queue advancement are not fully guaranteed by Web APIs; the native iOS app is the required reliable solution.
- Calls are not expected to run simultaneously with music; music yields to the call and resumes only under the defined pre-call rule.
