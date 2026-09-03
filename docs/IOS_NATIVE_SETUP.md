# iOS Native Setup — CallKit / PushKit

This repo has no `ios/` project checked in (same as `android/` — it's
generated, not committed). Everything in `native/ios/` and
`native-plugins/callkit-bridge/ios/` is real, complete Swift, written and
statically verified (balanced braces/parens, matches the documented
CallKit/PushKit/Capacitor plugin APIs) but **never compiled** — this
sandbox has no macOS/Xcode. Treat it as "ready for Xcode," not "tested."

## One-time setup (requires a Mac with Xcode)

1. **Generate the project.** `npx cap add ios` from the repo root. This
   creates `ios/App/App.xcworkspace` and the default Capacitor template
   files (`AppDelegate.swift`, `Info.plist`, etc.) that the rest of this
   guide patches.

2. **Run the patch script.** `npm run cap:patch-permissions` (already
   wired into `npm run cap:add:ios`/`cap:sync` if you use those). This will:
   - Add `NSCameraUsageDescription`/`NSMicrophoneUsageDescription`/etc. to `Info.plist` (unchanged from before).
   - Add `UIBackgroundModes`: `voip`, `audio`, `remote-notification` — **required** or PushKit VoIP pushes can't wake the app from a terminated state.
   - Create `ios/App/App/App.entitlements` with `aps-environment: development`.
   - Copy `CallKitManager.swift` and `PushKitManager.swift` into `ios/App/App/`.
   - Patch `AppDelegate.swift`'s `didFinishLaunchingWithOptions` to start PushKit registration and wire CallKit's action callback.

3. **Manual Xcode steps the script cannot do** (modifying `.pbxproj` safely from a script is not something this repo attempts):
   - Open `ios/App/App.xcworkspace`. Drag `CallKitManager.swift` and `PushKitManager.swift` into the **App** group with **"Add to target: App"** checked — the script copies the files to disk, but Xcode won't compile them until they're in the project file.
   - **Signing & Capabilities** tab on the App target: add **Push Notifications** and **Background Modes** (Voice over IP, Audio, Remote notifications) capabilities, and confirm `App.entitlements` is set as the target's entitlements file.
   - Install the local Capacitor plugin: it's already declared in `package.json` (`duospace-callkit-bridge`) — `npx cap sync ios` will run `pod install` and pick it up automatically.

4. **Before a TestFlight/App Store build**: change `aps-environment` in `App.entitlements` from `development` to `production`. The dev value only works for Xcode-debugger-attached runs; shipping with it set to `development` causes push delivery to silently fail with no error surfaced anywhere in the app.

## Backend: VoIP push delivery (implemented)

`supabase/functions/send-voip-push` is a dedicated Edge Function for iOS
CallKit/PushKit — **not** a code path inside `send-push` (FCM), because
VoIP pushes are a different Apple product entirely:
- Push type `apns-push-type: voip`, priority `10`, topic `<bundle-id>.voip`
  (not the bare bundle id — a regular push to this topic, or a VoIP push
  to the bare bundle id, is silently dropped by Apple).
- Sent to the token from `PushKitManager.onTokenUpdated`
  (`native-plugins/callkit-bridge`'s `voipTokenUpdated` event), stored in
  `push_tokens` with `token_type = 'apns_voip'` — a distinct row from the
  regular `fcm`/`apns` token the same device may also have registered.
- Authenticated with an APNs **provider token** (ES256 JWT signed from a
  `.p8` key), not FCM's OAuth2 service-account flow — see
  `supabase/functions/_shared/apnsAuth.ts`.

### Required Supabase secrets

```bash
supabase secrets set APNS_TEAM_ID="..."          # Apple Developer team id
supabase secrets set APNS_KEY_ID="..."            # the .p8 key's Key ID
supabase secrets set APNS_PRIVATE_KEY="$(cat AuthKey_XXXXXXXXXX.p8)"
supabase secrets set APNS_BUNDLE_ID="com.duospace.app"   # WITHOUT the .voip suffix — the function appends it itself
supabase secrets set APNS_ENVIRONMENT="sandbox"   # "sandbox" while Xcode-debugging/TestFlight-adjacent, "production" for real App Store builds
```

- **Team ID / Key ID**: Apple Developer portal → Membership (Team ID) and
  Certificates, Identifiers & Profiles → Keys (Key ID of the auth key you
  create below).
- **The `.p8` key**: Apple Developer portal → Keys → create a new key with
  the **Apple Push Notifications service (APNs)** capability enabled (one
  key works for both regular APNs and VoIP — no separate VoIP-specific key
  exists). Download it once; Apple will not let you download it again, so
  store the original safely outside this repo. Never commit the `.p8`
  file, never paste its contents into a chat/AI tool — treat it as a live
  credential. If it's ever exposed, revoke it in the portal and generate a
  new one, then update the `APNS_PRIVATE_KEY` secret.
- **`APNS_ENVIRONMENT`**: matches `App.entitlements`' `aps-environment`
  (see step 4 above) — `sandbox` for anything not distributed via the App
  Store/TestFlight production track, `production` for real distribution.
  Apple's sandbox and production APNs hosts are entirely separate;
  sending to the wrong one silently fails deliveries with no local error.

Deploy: `supabase functions deploy send-voip-push`. It shares
`supabase/functions/_shared/{cors,rateLimit}.ts` with `send-push` but has
its own `apnsAuth.ts`/`apns.ts` — no FCM code path touches VoIP at all.

### End-to-end flow

`Caller starts call → call_history INSERT (status=in_progress) → Postgres
trigger notify_voip_on_call_insert → send-voip-push → APNs (.voip topic) →
PushKit → CallKitManager.reportIncomingCall → native incoming-call UI →
user answers → claim_call() RPC (multi-device race) → daily-call get-token
→ Daily room joins.` Cancellation before answer, and a missed/completed
call before being claimed, both go through `notify_voip_on_call_end`,
which sends a `"cancel"` VoIP event that ends CallKit's ringing UI on
every device that isn't the one that claimed it — see
`native/ios/CallKitManager.swift`'s `reportCancelledCall`.

### Token model

`push_tokens.token_type` is now `'fcm' | 'apns' | 'apns_voip'`
(`supabase/migrations/20260808120000_ios_voip_push.sql`), plus a
`device_id` column so a token *rotation* on the same physical install
upserts in place (`user_id, device_id, token_type` is unique) instead of
accumulating one row per rotation. Existing rows are untouched — the
migration only adds columns with backward-compatible defaults, and
Android/FCM delivery is not modified in any way.

### Multi-device answer race

A ringing call can reach more than one of a person's devices at once (an
iPhone and an iPad both signed in, for instance). `public.claim_call(uuid)`
is a `SECURITY DEFINER` RPC that atomically wins the call for exactly one
device (`UPDATE ... WHERE claimed_by IS NULL AND status = 'in_progress'
... RETURNING`); every device that loses the race must tear down its own
ringing UI when it sees the resulting realtime update, rather than joining
independently. The web client's accept path (`Chat.tsx`'s
`handleAcceptIncoming`) calls this before doing any Daily.co work.

## What's real vs. what's still a gap

| Piece | Status |
|---|---|
| `CallKitManager.swift`, `PushKitManager.swift` | Written, balanced, API-correct — now includes the VoIP "cancel" event path. Not compiled. |
| `AppDelegate.swift` patch | Verified against a scaffold matching Capacitor's actual default template — insertion lands correctly, idempotent on re-run. |
| `Info.plist` / `App.entitlements` patching | Verified the same way — valid plist XML, idempotent. |
| Xcode target membership for the new Swift files | **Not automatable from here** — manual step above. |
| `duospace-callkit-bridge` plugin (JS + Swift + Android no-op) | Written, follows the exact structure of the existing `duospace-audio-route` plugin. Not built (`npm run build` inside the plugin dir requires network for its own toolchain in a clean environment). |
| VoIP APNs backend delivery (`send-voip-push`, `_shared/apnsAuth.ts`, `_shared/apns.ts`) | **Implemented** — ES256 provider-token auth, error classification/retry, idempotent per-device dispatch. Requires `APNS_*` Supabase secrets + a real Apple Developer Program account + a real device to actually verify delivery. |
| `push_tokens` token model (`token_type`, `device_id`) + migration | **Implemented**, backward-compatible, Android/FCM untouched. |
| Multi-device claim (`claim_call`/`cancel_call` RPCs) | **Implemented** on the DB + web-client accept path. Native CallKit side does not yet listen for "answered elsewhere" to auto-dismiss its own ringing UI on a losing device — see the final audit in `PUSH_NOTIFICATIONS.md`/commit notes for the honest gap. |
| Dynamic Island / Live Activities | Not started — separate ActivityKit work, out of scope for this pass. |
| Device/Xcode compile+run testing | **Not performed** — no macOS/Xcode in this environment. |
