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

FCM messages route through one of four Android notification channels
(`_shared/fcm.ts` → `CHANNELS`, must match `NotificationChannels.kt`
exactly): `duospace_messages`, `duospace_incoming_calls`,
`duospace_reactions`, `duospace_system`. If a channel referenced by a push
doesn't exist on-device yet, Android silently drops the notification — so
these are created at app startup, not lazily.

Incoming calls (`incoming_audio_call` / `incoming_video_call`) are sent as
**data-only** FCM messages (no top-level `notification` block) on purpose,
so the OS never auto-displays a plain notification for them — instead:

- `CallNotificationService.kt` (an *additional* `FirebaseMessagingService`,
  registered alongside Capacitor's own push-notifications service — Android
  supports multiple listeners for `com.google.firebase.MESSAGING_EVENT`)
  intercepts just these two types and builds a `PRIORITY_MAX`,
  full-screen-intent, Accept/Decline notification.
- `CallRingingService.kt`, a foreground service
  (`foregroundServiceType="phoneCall"`), plays a **looping** ringtone +
  vibration — a plain notification channel sound only plays once, which
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

- [ ] `adb shell dumpsys notification` shows all four channels after first
      launch (`duospace_messages`, `duospace_incoming_calls`,
      `duospace_reactions`, `duospace_system`).
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
supabase/functions/_shared/pushTypes.ts
supabase/functions/_shared/firebaseAuth.ts
supabase/functions/_shared/fcm.ts
supabase/functions/send-push/index.ts
native/android/NotificationChannels.kt
native/android/CallNotificationService.kt
native/android/CallRingingService.kt
scripts/patch-native-permissions.mjs        (extended)
src/hooks/usePushNotifications.ts           (routing extended, registration untouched)
src/components/IncomingCallOverlay.tsx      (added cold-start active-call check)
src/integrations/supabase/types.ts          (added 4 new table types)
PUSH_NOTIFICATIONS.md                       (this file)
```

## 8. Known limitations / honest gaps

- **iOS/APNs is out of scope.** The task specified Android (package
  `com.duospace.app`), so `fcm.ts` only builds the `android` block of the
  FCM v1 message. FCM v1 does support `apns` in the same request; if/when
  iOS is added, extend `buildFcmMessage` in `_shared/fcm.ts` — the
  OAuth/token/retry layer needs no changes.
- **Group/mention/typing pushes have no trigger** (see §0) — the API
  accepts them, nothing calls it for them yet.
- **Power-button call silencing is not possible** for a non-default-dialer
  app on stock Android (see §5b) — not implemented because it cannot
  actually work, not from lack of effort.
- **Native `.kt` files are unverified by a real Android build** in this
  environment (no Android SDK available here) — they're syntactically
  reviewed and idiomatic Capacitor/FCM code, but treat your first `cap
  sync android` + Android Studio build as the real check, per the
  checklist in §5d.
