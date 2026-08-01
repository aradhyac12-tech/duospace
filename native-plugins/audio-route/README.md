# duospace-audio-route

Local Capacitor 8 plugin: real OS-level call audio route switching
(earpiece / speaker / Bluetooth / wired headset). Not achievable from the
web layer — this is the piece the earlier browser-only pass couldn't do.

## Setup (run once native projects exist)

```bash
npm install                 # picks up the file: dependency in package.json
npx cap add android         # if not already run
npx cap add ios             # if not already run
node scripts/patch-native-permissions.mjs
npx cap sync                # discovers this plugin automatically (has a
                             # "capacitor" key in its package.json, same as
                             # any published plugin) and wires it into the
                             # Android Gradle project + iOS CocoaPods
```

No manual `settings.gradle` / `Podfile` edits needed — `cap sync` handles
local `file:` plugins the same way it handles npm-published ones.

## What it does / doesn't do

- Wraps `AudioManager` (Android) / `AVAudioSession` (iOS) to list available
  output routes, read the current one, switch on demand, and emit
  `routeChanged` when the OS changes it on its own (headset unplugged, BT
  disconnects mid-call).
- Deliberately does **not** touch audio session category/mode/focus —
  Daily.co's WebRTC engine already owns that once a call is joined. This
  plugin only flips routing on top of the session WebRTC already set up,
  the same approach native WebRTC/CallKit apps use. Calling it outside an
  active call is a harmless no-op, not a crash.
- `src/hooks/useAudioRoute.ts` on the JS side feature-detects
  `Capacitor.isPluginAvailable(...)` and reports `supported: false` on
  web/dev or if `cap sync` hasn't run yet — `pages/Calls.tsx` hides the
  route-picker button entirely in that case rather than showing dead UI.

## Verifying on a device

Can't be verified in a browser or emulator without real audio hardware
routing (emulator audio is virtual). Test on a physical device: join a
call, tap the route button mid-call, confirm the toggle between earpiece/
speaker is audible, and if you have a Bluetooth headset, confirm it shows
up in the list and that unplugging/disconnecting mid-call falls back
correctly (that's what `routeChanged` is for).
