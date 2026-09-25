# Notification sounds & ringtones (v3.11.1)

Request: "unable to select other notification / call sounds, it should work
properly after selection, add more options."

## What was wrong (from reading the code — none of it was run)

1. **Picker rows locked.** `NotificationsSettings.tsx` disabled every row until
   a Supabase read finished and again during each save. On a slow/dead network
   nothing could be tapped (reads are capped at 25 s by the offline-first client).
2. **Failed save looked like success.** The row was marked selected before the
   save, a failure toasted once, and the next visit reverted to the server value.
   Nothing was kept on the device.
3. **In-app sounds ignored the choice.** `playMessageSound()` (chat ping) and
   the in-app incoming-call ring (`startRingtoneLoop()`) were hard-coded synth
   tones. The chosen sound only ever played from a push while the app was closed.
   (On Android the native ring is deliberately skipped while the app is in the
   foreground — `CallNotificationService.isAppForegrounded` — so foreground
   ringing is entirely the JS side.)
4. **iOS CallKit ringtone** was only applied when picked in Settings on that
   device — a fresh install / second device rang the default.
5. **New ids could not be saved.** `notification_preferences` had `CHECK`
   constraints listing exactly the original four ids.
6. **Android layering (not reported, found while tracing):** the incoming-call
   notification and the ringing service's foreground notification were both on
   the per-ringtone channel, so the channel played the ringtone once on top of
   `CallRingingService`'s own loop. Every 2nd+ message in a thread also
   re-alerted, because the group summary (same channel) was re-posted with
   default alert behaviour.

## What changed

| Area | Change |
|---|---|
| Catalog | 12 message sounds (+bell, droplet, crystal, harp, sparkle, tick, whistle, glass) and 12 call ringtones (+retro, digital, melody, bells, pulse, sunrise, waltz, groove), each with its own vibration pattern. |
| Assets | 16 new sounds × 3 formats (`public/sounds/*.m4a`, `native/android/res_raw/*.ogg`, `native/ios/Sounds/*.caf`). Synthesized by `scripts/generate-notification-sounds.py`, mastered to the same ~-19 dBFS peak as the original 8. Ringtones end in silence and start/end at zero amplitude (they loop). |
| Local-first prefs | `lib/notificationSoundPrefs.ts`: choice saved on-device instantly (localStorage, per user id), pushed to the server with retry; a local change is never overwritten by the server until it lands. `hooks/useNotificationSoundSync.ts` (mounted in `ProtectedRoutes`) syncs on sign-in / reconnect / app resume and re-applies the ringtone to iOS CallKit every time. |
| Settings page | Rows never disabled; instant select + preview; play/stop toggle; a "waiting to sync" note when the server hasn't confirmed; the save error code is shown in the toast. |
| In-app playback | `playMessageSound()` plays the chosen file. Incoming-call overlay plays the chosen ringtone (`startIncomingRingtone`), unless the OS reports it is already ringing (`DuospaceCallKitBridge.isIncomingRinging`, new: Android checks for the ringing-service notification, iOS asks CallKit). The caller's ringback ("Ringing…") is unchanged. |
| Server | Migration `20260921100000_notification_sound_catalog_expansion.sql` replaces the four-id `CHECK`s with a shape check (`^[a-z][a-z0-9_]{0,31}$`); the real allow-list is `soundCatalog.ts` (normalizes unknown → classic) so future sounds need no migration. `soundCatalog.ts` extended. |
| Android | `NotificationChannels.kt` / `CallRingingService.kt` extended to all ids. New silent channel `duospace_incoming_call_visual` for the full-screen call notification and the ringing service's foreground notification when the service is the ringer (per-ringtone channel remains the fallback if the OS refuses the service). Group summary no longer re-alerts. |
| iOS | `CallKitManager.VALID_RINGTONE_IDS` extended; new `isRingingUnanswered` accessor. |
| Guard | `src/test/notificationSoundCatalog.test.ts` fails if the client, edge function, Kotlin (channels, raw names, vibration, ringing service), Swift, bundled assets or the migration shape check drift. |

## Deploy order (matters)

1. Apply the migration **before** shipping the client, or saving a new sound
   fails with a check violation (the client keeps the choice on-device and
   retries, but pushes keep the old sound until it lands).
2. Deploy `send-push` (uses `_shared/soundCatalog.ts`).
3. Rebuild the native apps. Existing installs get the 16 new Android channels on
   next launch (`createAll` runs at startup); already-created channels are untouched.
   New `.caf` files must be in the Xcode target (see `PUSH_NOTIFICATIONS.md`).

## NOT verified (no build / device / Supabase access in the sandbox)

* `vitest`, `eslint`, `tsc` project build, Gradle, Xcode: not run. Checked by an
  isolated `tsc --noEmit` per touched file (only missing-module noise, no real
  type errors), the catalog parity test run through a minimal node harness
  (10/10, plus a mutation check that it fails on drift), and a bracket-balance
  sweep of the edited Kotlin/Swift (deltas identical to the untouched originals).
* The 16 generated sounds were analysed (levels, duration, spectrogram, edge
  amplitude) but **not listened to**. Judge them by ear; tweak the generator.
* The exact reason picking "did nothing" for you can't be proven from source. The
  locked rows (1) and reverted saves (2) are the concrete mechanisms; a
  migration/RLS problem would surface now as a toast with the error code.
* Android: silent visual channel and summary change, and the iOS/Android
  `isIncomingRinging` probe, need a real-device call + message test.
* Perceived loudness: all assets, old and new, peak around -19 dBFS (quiet). If
  everything should be louder, raise `TARGET_PEAK_DB` in the generator and
  re-render the original 8 too — otherwise sounds jump in volume when switching.

## Device test checklist

- [ ] Settings → Notifications: every row taps instantly, also in airplane mode;
      "waiting to sync" appears offline and clears after reconnect.
- [ ] Pick a new message sound, leave the page, come back: still selected.
- [ ] Chat open on another device sends a message: the ping is the chosen sound.
- [ ] App open, incoming call: chosen ringtone plays once (no second copy).
- [ ] App closed / locked, incoming call: chosen ringtone loops once (no
      layering / echo at the start), vibration matches the preview.
- [ ] App closed, 3 messages in one thread: sound on each new message, not twice.
- [ ] iOS: pick a ringtone, force-quit, incoming call rings with it; fresh
      install on a second device rings with the same one after first sign-in.
