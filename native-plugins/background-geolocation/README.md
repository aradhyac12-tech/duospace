# duospace-background-geolocation

Local Capacitor plugin (not published — installed the same way
`duospace-device-status` / `duospace-callkit-bridge` / `duospace-audio-route`
are, via `file:./native-plugins/background-geolocation` in the root
`package.json`).

Gives JS a native-backed location layer that keeps producing fixes when the
WebView itself is suspended (app minimized, screen off), plus an
`requestImmediateFix()` for "get a fresh fix right now" — used the instant
a call or message push arrives.

See `docs/BACKGROUND_LOCATION_NATIVE.md` at the project root for the full
design writeup, what triggers what, and known limitations. Short version:

- **Android**: `start()`/`stop()` control a foreground service
  (`native/android/DuoSpaceLocationService.kt`) that keeps
  `FusedLocationProviderClient` updates flowing while the app process is
  alive but backgrounded. `CallNotificationService.kt` also starts this
  service directly (independent of this plugin / any Bridge existing) the
  instant any push arrives, calls and messages alike.
- **iOS**: backed by `DuoSpaceLocationManager` (a `CLLocationManager`
  wrapper with `allowsBackgroundLocationUpdates` + significant-change
  monitoring). `CallKitManager.swift` calls
  `DuoSpaceLocationManager.shared.requestImmediateFix(...)` directly the
  instant an incoming call is reported — no plugin/Bridge dependency
  needed there either, since iOS Capacitor plugins compile straight into
  the single app target.
- **Web**: no implementation — the existing
  `navigator.geolocation.watchPosition` path in `useLiveLocation.ts`
  already runs continuously on web without needing this.

Requires `npx cap sync` (registers the plugin) followed by
`node scripts/patch-native-permissions.mjs` (adds the location permissions,
`UIBackgroundModes: location`, and registers `DuoSpaceLocationService` in
`AndroidManifest.xml` — see that script's `ANDROID_PERMISSIONS` /
`IOS_KEYS` / service-registration additions).
