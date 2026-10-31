# duospace-device-status

Local Capacitor 8 plugin: real battery percentage (+ charging state) on both
platforms, and ringer/silent mode — real on Android, always `unknown` on iOS.

## Why ringer mode is `unknown` on iOS

Apple provides **no public API** to read the physical mute-switch position.
Full stop — this isn't something a plugin (local or published) can work
around properly. Some apps fake it with a "play a silent sound and time
whether the completion callback fires on schedule" trick, but that's
unreliable (produces false positives/negatives depending on device load,
audio session state, iOS version) and this is a couples-trust app — a
*wrong* "they're not on silent" is worse than an honest "can't tell on
iPhone". So iOS always reports `'unknown'`, on purpose, and the Map UI
should treat that as "hide the ringer icon for this device" rather than
showing a bell/no-bell icon that might be lying.

Battery level and charging state ARE fully real and reliable on iOS via
`UIDevice` battery monitoring — only the ringer switch is the iOS gap.

## Setup

Same as `duospace-audio-route` — registered as a `file:` dependency, picked
up automatically by `npx cap sync` after `cap add android` / `cap add ios`:

```bash
npm install
npx cap sync
```

No extra Android permissions needed — `ACTION_BATTERY_CHANGED` (sticky) and
`AudioManager.getRingerMode()` are both permission-free public APIs.

## Verifying on a device

Emulators can fake a battery percentage (`adb emulator -avd ... -battery`)
but can't test the ringer hardware switch (Android emulators don't have
one either — use `adb shell cmd audio set-ringer-mode` variants, or a real
device). Test on real hardware for the full picture.
