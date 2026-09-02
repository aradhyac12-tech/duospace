# Push Notifications (FCM HTTP v1) — DuoSpace

This document covers the full push-notification backend added to DuoSpace:
a `send-push` Supabase Edge Function using the Firebase Cloud Messaging
**HTTP v1 API** (OAuth2, service account — never the deprecated legacy
server key), wired to fire automatically from Postgres triggers whenever a
message, reaction, call, or partner request happens.

## 0. Scope note — please read first

DuoSpace's actual schema is a **1:1 "couple" app** (`profiles.partner_id`).
There is no `conversations`, `groups`, `friends`, or `mentions` table
anywhere in the codebase. So:

- **Really wired to automatic DB triggers today:** chat / image / voice /
  file messages, replies, reactions, incoming/missed/ended calls, and
  partner-pairing requests (`partner_requests` — this app's actual
  equivalent of "friend request" / "friend accepted"; a couple is exactly
  one accepted request).
- **Supported by the `send-push` API, but nothing triggers them yet**
  because there's no source table to trigger from: `group_message`,
  `group_invitation`, `mention`, `typing`. These are valid `type` values
  today so the API is ready the moment those features exist — see
  `supabase/functions/_shared/pushTypes.ts`.

Nothing about your existing client-side push **registration** logic
(`src/hooks/usePushNotifications.ts`'s `registration` listener, and the
`profiles.push_token`/`push_platform` columns it writes) was touched. A new
DB trigger keeps a new multi-device `push_tokens` table in sync with it
automatically.

## 1. Required Supabase secrets

Set these with the Supabase CLI (never commit them, never paste them into
a chat/AI tool — treat a service account private key as a live credential):

```bash
supabase secrets set FIREBASE_PROJECT_ID="your-firebase-project-id"
supabase secrets set FIREBASE_CLIENT_EMAIL="firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com"
# Keep the \n escapes literal — paste the private_key field's value exactly
# as it appears in the downloaded JSON, single-quoted so the shell doesn't
# reinterpret backslashes:
supabase secrets set FIREBASE_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n'
```

These three come from **Firebase Console → Project Settings → Service
Accounts → Generate new private key**. `send-push` reads them exclusively
via `Deno.env.get(...)` in `supabase/functions/_shared/firebaseAuth.ts` —
they are never hardcoded and never logged (only the *names* of missing env
vars are ever logged, never values).

If you ever paste or commit one of these by mistake, treat it as
compromised: generate a new key in Firebase Console and delete the old one
immediately (same page).

`send-push` also uses the project's standard `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`, which Supabase already injects into every Edge
Function automatically — nothing to configure there.

## 2. One-time Vault setup (lets Postgres triggers call the Edge Function)

Messages/reactions/calls/partner-requests trigger `send-push`
**automatically** via a `pg_net` HTTP call from a Postgres trigger (see the
migration `supabase/migrations/20260725091342_fcm_push_notifications.sql`).
That trigger needs to know your project URL and service role key — stored
in Supabase Vault, **not** hardcoded into the migration (a checked-in SQL
file must never contain a real service key):

```sql
select vault.create_secret('https://<your-project-ref>.supabase.co', 'project_url');
select vault.create_secret('<your-service-role-key>', 'service_role_key');
```

Run this once per environment (dev/staging/prod each need their own). Until
these two secrets exist, the triggers log a `WARNING` and skip dispatch —
they never fail or roll back the message/call/request that triggered them.

## 3. Deploying

```bash
# Apply the schema (push_tokens, notification_history, notification_preferences,
# blocked_users, and the trigger functions):
supabase db push

# Deploy the function:
supabase functions deploy send-push

# Confirm secrets are visible to the function:
supabase secrets list
```

## 4. What actually happens end-to-end

1. A row is inserted into `messages` / `message_reactions` / `call_history`
   (insert or status-changing update) / `partner_requests`.
2. A trigger (`notify_push_on_message`, `_on_reaction`, `_on_call`,
   `_on_partner_request`) builds a small JSON payload and calls
   `private.dispatch_push(...)`, which POSTs it to
   `{project_url}/functions/v1/send-push` with
   `Authorization: Bearer <service_role_key>` and `{ internal: true, ... }`.
3. `send-push` recognizes the service-role bearer token as a trusted
   internal caller (no separate JWT check needed — only the DB itself, via
   the Vault secret, can present that key).
4. It validates the payload, then for each recipient:
   - confirms the recipient profile exists,
   - skips if the sender is in the recipient's `blocked_users`,
   - checks `notification_preferences` (do-not-disturb, mute-until,
     per-type toggles),
   - loads every valid token from `push_tokens` (falling back to
     `profiles.push_token` for accounts that predate the sync trigger),
   - looks up the sender's display name/avatar for the notification body,
   - computes an unread count for message-like types,
   - builds the FCM v1 payload (`_shared/fcm.ts`) and sends one request per
     device token, with exponential-backoff retry for transient failures.
5. Permanently-invalid tokens (`UNREGISTERED`, bad token, sender/project
   mismatch) are automatically flipped to `is_valid = false` in
   `push_tokens` (and cleared from `profiles.push_token` if that was the
   stale one) — nothing manual to clean up.
6. Every attempt (sent/partial/failed/skipped, and why) is logged to
   `notification_history`, which the recipient can read via RLS and mark
   read from the client.

`send-push` can also be called directly by an authenticated client (e.g. a
future "send a custom notification" admin action) — those calls must
present a normal user JWT and may only impersonate themselves as
`senderId`, and are rate-limited via the existing `consume_rate_limit` SQL
function (reused from `_shared/rateLimit.ts`, no new rate-limit
infrastructure was added).

## 5. Android integration

### 5a. Notification channels & full-screen incoming calls

FCM messages route through Android notification channels
(`_shared/soundCatalog.ts` / `_shared/fcm.ts` → `messageChannelId()` /
`callChannelId()`, must match `NotificationChannels.kt` exactly):
`duospace_reactions`, `duospace_system`, plus one physical channel **per
sound choice** for messages and calls (`duospace_messages_classic/chime/pop/marimba`,
`duospace_incoming_calls_classic/gentle/urgent/marimba` — see §5e). If a
channel referenced by a push doesn't exist on-device yet, Android silently
drops the notification — so all of these are created at app startup, not
lazily.

Incoming calls (`incoming_audio_call` / `incoming_video_call`) are sent as
**data-only** FCM messages (no top-level `notification` block) on purpose,
so the OS never auto-displays a plain notification for them — instead:

- `CallNotificationService.kt` (an *additional* `FirebaseMessagingService`,
  registered alongside Capacitor's own push-notifications service — Android
  supports multiple listeners for `com.google.firebase.MESSAGING_EVENT`)
  intercepts just these two types and builds a `PRIORITY_MAX`,
  full-screen-intent, Accept/Decline notification.
- `CallRingingService.kt`, a foreground service
  (`foregroundServiceType="phoneCall"`), plays the recipient's chosen
  bundled ringtone in a **loop** via `MediaPlayer` + a matching vibration
  waveform — a plain notification channel sound only plays once, which
  doesn't read as "ringing."
- Tapping Accept/Decline (or the notification itself) opens
  `MainActivity`, which stops the ringtone and dispatches a
  `duospace-call-action` `CustomEvent` into the WebView
  (`window.dispatchEvent(...)`) — handled in
  `src/hooks/usePushNotifications.ts`. Decline updates `call_history` to
  `missed` directly; Accept just navigates to `/chat`, where
  `IncomingCallOverlay` (which now also checks for an already-ringing call
  on mount, not just new realtime inserts — needed because the
  `call_history` INSERT already happened before a killed app relaunches)
  picks up the still-ringing call and shows the normal in-app answer UI.

### 5b. Silencing a ringing call (volume buttons) — and why the power button can't

Pressing a volume key while a call is ringing calls
`CallRingingService.silence()` (stops sound + vibration, call keeps
ringing) instead of adjusting system volume — wired via `onKeyDown` in
`MainActivity.kt`.

**The power button is intentionally not wired up.** On stock Android, only
the system's own Telecom/Phone stack (the default dialer) can silence a
ringing call by intercepting the power button; `KEYCODE_POWER` is not
delivered to a normal third-party app's Activity at all. There's no
supported way around this without DuoSpace registering itself as the
default phone app, which is out of scope. If this matters a lot in
practice, the real fix is integrating Android's `ConnectionService`/Telecom
APIs so calls appear as native OS calls — a much larger project than a push
notification backend.

### 5c. Applying the native changes


None of this exists until you've run `npx cap add android` at least once.
Then, every time after `cap add android` / `cap sync`:

```bash
node scripts/patch-native-permissions.mjs
```

This idempotently:
- adds `POST_NOTIFICATIONS` (Android 13+), `USE_FULL_SCREEN_INTENT`
  (Android 14+), `VIBRATE`, `WAKE_LOCK`, `FOREGROUND_SERVICE`, and
  `FOREGROUND_SERVICE_PHONE_CALL` to `AndroidManifest.xml`, alongside the
  camera/mic/internet permissions it already added;
- copies `native/android/{NotificationChannels,CallNotificationService,CallRingingService}.kt`
  into `android/app/src/main/java/com/duospace/app/`;
- registers both services in the manifest plus a default FCM channel
  meta-data entry;
- adds a second deep-link host (`duospace://call`) alongside the existing
  `duospace://auth` OAuth one, and patches `MainActivity.kt` with the
  `onCreate` / `onNewIntent` / `onKeyDown` hooks described above.

**If your project's `MainActivity` is Java, not Kotlin:** the script
detects `MainActivity.java` and prints a warning instead of guessing at a
patch — port the block from `native/android/MainActivity-additions` (the
Kotlin injected block documented in `scripts/patch-native-permissions.mjs`)
by hand, or add a Kotlin `MainActivity.kt` alongside (Capacitor Android
projects support mixed Kotlin/Java in the same module) and rerun the script.

Then rebuild in Android Studio (`npx cap sync android && npx cap open
android`) — this environment has no Android SDK available to compile these
`.kt` files, so treat your first real build as the correctness check, and
watch Logcat for the `CallNotificationService`/`CallRingingService` tags
while testing.

### 5d. Manual verification checklist on a real device/emulator

- [ ] `adb shell dumpsys notification` shows the reactions/system channels
      plus all 8 sound-variant channels after first launch
      (`duospace_messages_classic/chime/pop/marimba`,
      `duospace_incoming_calls_classic/gentle/urgent/marimba`).
- [ ] Send yourself a text message from the partner account → heads-up
      notification appears, grouped by conversation, tapping it opens `/chat`.
- [ ] Trigger an incoming call → full-screen ringing UI appears even with
      the screen off/locked; ringtone loops (not a single blip).
- [ ] Press a volume button while it's ringing → sound/vibration stop,
      call keeps ringing, screen stays as-is.
- [ ] Tap Decline → `call_history.status` becomes `missed`, ringing stops.
- [ ] Force-stop the app, trigger a call, tap the notification from a cold
      start → `IncomingCallOverlay` still appears (exercises the new
      mount-time active-call check in `IncomingCallOverlay.tsx`).
- [ ] Uninstall/reinstall (simulates a token becoming `UNREGISTERED`), send
      a push → `notification_history.delivery_status = 'failed'` initially,
      then `push_tokens.is_valid` flips to `false` for that token on the
      next attempt.
- [ ] Settings → Notifications → pick a different message sound and call
      ringtone → preview plays + vibrates immediately; the real next
      incoming message/call uses the new sound even with the app fully
      closed (kill it from Recents first, don't just background it).
- [ ] On iOS, change the call ringtone in Settings, then force-quit the app
      before the next incoming call — CallKit's ring should still use the
      newly-picked sound (exercises `applyRingtonePreference`'s
      `UserDefaults` persistence, not a live in-memory value).

### 5e. Multiple sounds + haptics — how "pick your own" is implemented

Android freezes a notification channel's sound and vibration pattern the
moment it's first created (no supported API to change them on an existing
channel). So instead of one channel with a fixed sound, there's **one
channel per sound choice** — 4 for messages, 4 for calls — all created
upfront in `NotificationChannels.kt`. Choosing a sound in Settings just
changes which channel id future pushes route through
(`notification_preferences.message_sound` / `.call_ringtone`, read by
`send-push/index.ts` and turned into a channel id by
`soundCatalog.ts#messageChannelId/callChannelId`). The channel itself is
what makes the sound/vibration fire correctly even when the app is fully
killed — it's an OS-level property, not something the app has to be
running to apply.

For calls specifically, the channel's sound is a fallback only:
`CallRingingService.kt` plays the chosen ringtone directly via `MediaPlayer`
(looped) plus its own `VibrationEffect.createWaveform` pattern, because a
channel sound plays once per notification, not "ring until answered."
Which ringtone to use is echoed into the FCM `data` payload per-push
(`data.callRingtone`) rather than read from a local setting, since Android
already has the fresh value on every call push.

iOS calls ring through the separate CallKit/PushKit path (§ not covered by
this doc historically — see `native/ios/CallKitManager.swift` /
`PushKitManager.swift`), not through FCM, and `CXProviderConfiguration`
has no equivalent "read this from the current push" mechanism — CallKit can
answer a call from a cold process start before any JS/Supabase state is
available. So the iOS ringtone choice is instead persisted locally
(`UserDefaults`, set via the `DuospaceCallKitBridge.setRingtone()` plugin
method whenever Settings saves) and applied to
`provider.configuration.ringtoneSound` at both app-launch and live-change
time.

All 8 sound assets were synthesized offline with `ffmpeg` (no network, no
prerecorded samples) — see `native/android/res_raw/*.ogg` (Android raw
resources), `native/ios/Sounds/*.caf` (iOS bundle, **must be added to the
Xcode target as a folder reference** — plain file references get
re-flattened and lose the naming `CXProviderConfiguration.ringtoneSound` /
`UNNotificationSound(named:)` depend on), and `public/sounds/*.m4a` (web
preview only, played by the in-app picker's preview button — never the
actual delivery path). `scripts/patch-native-permissions.mjs` copies the
Android/iOS copies into place on every run.

**iOS regular-message custom sound is best-effort, not guaranteed**: unlike
calls (dedicated VoIP/APNs path), regular message pushes go through this
same FCM v1 `send-push` function, and `fcm.ts` now attaches an `apns` block
naming the chosen `.caf` file — but that only works if the recipient's
saved push token is a genuine Firebase-issued FCM registration token. If
`@capacitor/push-notifications` on this iOS build is registering a raw APNs
token instead (no Firebase iOS SDK wired in — not confirmed either way in
this codebase), FCM v1 can't deliver to it at all, sound or no sound; that
gap predates this change and is unrelated to notification sounds
specifically.

## 6. Database objects added

| Table                       | Purpose                                                              |
|------------------------------|-----------------------------------------------------------------------|
| `push_tokens`                | Multi-device FCM token registry, auto-synced from `profiles.push_token` |
| `notification_preferences`   | Per-user opt-out toggles, do-not-disturb, mute-until                  |
| `blocked_users`               | Recipient-side block list checked before sending                     |
| `notification_history`       | Delivery/read audit log (RLS: recipient can read + mark read)        |

Plus trigger functions `notify_push_on_message`, `notify_push_on_reaction`,
`notify_push_on_call`, `notify_push_on_partner_request`, and the
`private.dispatch_push` / `sync_push_token_to_push_tokens` helpers. All are
`SECURITY DEFINER` with `search_path` pinned, and RLS is enabled with
explicit policies on every new table.

## 7. Files in this change

```
supabase/migrations/20260725091342_fcm_push_notifications.sql
supabase/migrations/20260812090000_notification_sound_preferences.sql
supabase/functions/_shared/pushTypes.ts
supabase/functions/_shared/firebaseAuth.ts
supabase/functions/_shared/fcm.ts                    (per-sound-variant channels, apns block)
supabase/functions/_shared/soundCatalog.ts            (new — sound id catalog, Deno side)
supabase/functions/send-push/index.ts                 (resolves recipient's saved sound prefs)
native/android/NotificationChannels.kt                 (rewritten — channel-per-sound)
native/android/CallNotificationService.kt
native/android/CallRingingService.kt                   (rewritten — bundled ringtone via MediaPlayer)
native/android/res_raw/*.ogg                           (new — 8 offline-synthesized sound assets)
native/ios/Sounds/*.caf                                (new — same 8 assets, iOS bundle format)
native/ios/CallKitManager.swift                        (added applyRingtonePreference)
native-plugins/callkit-bridge/                         (added setRingtone() JS/iOS/Android)
scripts/patch-native-permissions.mjs                   (extended — copies sound assets both platforms)
src/lib/notificationSounds.ts                          (new — client sound catalog + preview)
src/pages/settings/NotificationsSettings.tsx           (new — sound/haptic picker UI)
src/pages/Settings.tsx                                 (added Notifications hub row)
src/App.tsx                                            (added /settings/notifications route)
src/hooks/usePushNotifications.ts           (routing extended, registration untouched)
src/components/IncomingCallOverlay.tsx      (added cold-start active-call check)
src/integrations/supabase/types.ts          (added 4 new table types + message_sound/call_ringtone)
public/sounds/*.m4a                         (new — web preview-only copies of the 8 assets)
PUSH_NOTIFICATIONS.md                       (this file)
```

## 8. Known limitations / honest gaps

- **iOS regular-message push delivery is unconfirmed** (predates this
  change): calls have a dedicated, working CallKit/PushKit/VoIP path, but
  regular chat/reaction/etc. pushes for iOS still go through this same FCM
  v1 function, and whether the token `@capacitor/push-notifications`
  registers there is FCM-compatible was never verified — see §5e's last
  paragraph.
- **Group/mention/typing pushes have no trigger** (see §0) — the API
  accepts them, nothing calls it for them yet.
- **Power-button call silencing is not possible** for a non-default-dialer
  app on stock Android (see §5b) — not implemented because it cannot
  actually work, not from lack of effort.
- **Native `.kt`/`.swift` files are unverified by a real build** in this
  environment (no Android SDK or Xcode available here) — they're
  syntactically reviewed and idiomatic Capacitor/FCM/CallKit code, but
  treat your first `cap sync` + real build as the actual check, per the
  checklist in §5d.
