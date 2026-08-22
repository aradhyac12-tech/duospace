# Background location + call/message-triggered fixes — native layer

## The gap this closes

`docs/DUOSPACE-LOCATION-CONTEXT.md` fixed every **foreground** case: moving
between Chat/Calls/Settings/Map, the ringing-call overlay, a notification
banner while the app is open. It explicitly flagged what it did *not* fix:

> This still doesn't add true background tracking for a minimized/
> screen-off app... that needs a background-location + foreground-service
> plugin wired in separately, which is outside what a JS-only provider
> change can do.

This is that separate, larger native change, plus the specific ask of
"get a fresh location fix the instant a call or message arrives" — both via
a new local Capacitor plugin, `duospace-background-geolocation`
(`native-plugins/background-geolocation/`).

## What was added

### 1. A background-capable watcher (Android + iOS)

- **Android**: `native/android/DuoSpaceLocationService.kt`, a real
  foreground service (`android:foregroundServiceType="location"`) driving
  `FusedLocationProviderClient`. Runs independently of the WebView's own
  JS timers — it keeps producing fixes while the app process is alive but
  backgrounded/screen-off, which `navigator.geolocation`/
  `@capacitor/geolocation` cannot do once the OS suspends the WebView.
  Started with `START_STICKY` so the OS restarts it if it's killed to
  reclaim memory, matching the "always on while signed in" product
  decision `LocationContext.tsx` already encodes for the foreground
  engine.
- **iOS**: `DuoSpaceLocationManager` (in the plugin's
  `BackgroundGeolocationPlugin.swift`), a `CLLocationManager` wrapper with
  `allowsBackgroundLocationUpdates = true` and significant-location-change
  monitoring as the OS-level wake source once the app is *suspended* (not
  just backgrounded). Requires "Always" location authorization — iOS's
  two-step permission model still shows the When-In-Use prompt first
  (both usage-description strings are required, see below).

### 2. Immediate one-shot fix on call/message arrival

- **Android** — `CallNotificationService.kt`'s `onMessageReceived` now
  requests an immediate one-shot fix for **every** push it receives (calls
  and ordinary messages alike — the trigger sits before the existing
  call-type filter), by starting `DuoSpaceLocationService` with
  `ACTION_ONE_SHOT`. This is a plain same-package foreground-service
  Intent, with zero dependency on the Capacitor Bridge/WebView/plugin
  having ever loaded — it fires even on a fully cold FCM wakeup, before
  the app has ever been opened.
- **iOS** — `CallKitManager.swift`'s `reportIncomingCall` calls
  `DuoSpaceLocationManager.shared.requestImmediateFix(reason:
  "incoming_call")` directly, for the same reason: a VoIP push can arrive
  before the app has ever launched. iOS Capacitor plugins compile straight
  into the single app target (unlike Android's separate Gradle module), so
  no bridge is needed there either.
- **Both platforms, ordinary messages while the JS bridge is alive** —
  `usePushNotifications.ts`'s `pushNotificationReceived` listener also
  calls `DuospaceBackgroundGeolocation.requestImmediateFix()`. This is the
  *only* trigger for a non-call message push on iOS (there's no native
  hook for regular messages there, only VoIP calls via PushKit); on
  Android it's redundant with the native trigger above by design — two
  upserts of the same row is harmless, and this one is what fires while
  developing/testing in a browser-attached debug session where the native
  FCM service path isn't exercised the same way.

### 3. One write path regardless of source

`LocationContext.tsx` subscribes to the plugin's `locationUpdate` event
and writes every fix — watcher tick or one-shot, native-triggered or
JS-triggered — through the same `locations` table upsert +
`enqueueLocation` offline-queue fallback `useLiveLocation.ts`'s own
`writeLocation()` already uses. There's exactly one queue and one upsert
shape no matter which layer produced the fix.

## Required setup (run after `npx cap sync`)

`scripts/patch-native-permissions.mjs` was extended to add:

- Android manifest permissions: `ACCESS_FINE_LOCATION`,
  `ACCESS_COARSE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`,
  `FOREGROUND_SERVICE_LOCATION`.
- The `<service android:name=".DuoSpaceLocationService" ... />`
  registration.
- `DuoSpaceLocationService.kt` added to the list of files copied into the
  app's Kotlin source tree.
- iOS `Info.plist` keys: `NSLocationWhenInUseUsageDescription`,
  `NSLocationAlwaysAndWhenInUseUsageDescription`,
  `NSLocationAlwaysUsageDescription`.
- `"location"` added to iOS `UIBackgroundModes`.

Run `node scripts/patch-native-permissions.mjs` after every `cap sync`, as
already documented for the rest of this script.

## Known limitations (deliberately not solved here)

- **A fully OS-killed / never-opened app cannot be woken by an ordinary
  message push on either platform.** Only a VoIP push (calls) can wake a
  terminated iOS app via PushKit; Android's FCM data message *can* wake a
  killed app's `FirebaseMessagingService` (which is what makes the
  Android one-shot trigger work even cold), but iOS has no equivalent
  guarantee for a plain remote notification. This is an OS-level
  constraint, not something a plugin can route around.
- **Android background location additionally requires a manual "Allow all
  the time" selection in system Settings** on most OEMs — `cap`-requested
  `ACCESS_BACKGROUND_LOCATION` alone does not always suffice depending on
  Android version/OEM; there's no way to force this from app code, only
  to prompt the user toward Settings.
- **Battery**: the background watcher intentionally uses a much lower
  cadence (`PRIORITY_BALANCED_POWER_ACCURACY`, default 45s floor) than the
  foreground engine — it exists to keep *something* flowing while
  suspended, not to match foreground accuracy.
- **Unverified**: written against the documented
  `FusedLocationProviderClient`/`CLLocationManager`/foreground-service API
  surfaces. Not compiled or run on a device — no Android SDK or Xcode/
  macOS available in the environment that generated it, the same caveat
  every native file in this project already carries (see the header
  comments in `CallKitManager.swift` / `PushKitManager.swift`). Treat as
  structurally correct and ready for a real build, not as tested.
