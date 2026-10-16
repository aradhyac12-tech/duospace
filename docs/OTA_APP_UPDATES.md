# OTA / in-app app updates (v3.22.0)

The admin uploads an APK (Android) or IPA / store link (iOS). Every sideloaded install is notified, the user chooses
Wi-Fi only or Wi-Fi + mobile data, the app downloads the file and hands it to the system installer.

## Who can do what

| Action | Who | Enforced where |
|---|---|---|
| Upload, publish, unpublish, delete a release | the allow-listed ADMIN account only | Postgres: `private.assert_admin()` in every `admin_*_app_release` RPC; `public.is_app_admin()` in the `app_releases` SELECT policy and in all four `storage.objects` policies of the private `app-releases` bucket |
| See that a published update exists (metadata) | anyone, even signed out | `get_latest_app_release(platform, code)` (no storage path in the result) |
| Download the binary | anyone holding a link minted for a PUBLISHED release | edge function `app-release-download` (signed URL, 6 h APK; iOS: 10-min HMAC link to `app-release-ios-manifest`) |

FOUNDER / BETA accounts and the admin's partner are not admins here. The Admin screen's "Updates" tab is a convenience; a modified
client can open it and still gets "admin only" from Postgres. Every action is written to `admin_audit_log`.

## Flow (Android)

1. Admin builds a release-signed APK from a tree whose `package.json` version is `x.y.z` (the build script stamps
   versionCode = major*10000+minor*100+patch, e.g. 3.22.0 = 32200), opens Admin -> Updates, picks Android, enters `x.y.z`,
   adds notes, chooses the file, optionally "Required update", taps Upload. The browser computes SHA-256, uploads to
   `android/<code>/duospace-<x.y.z>.apk`, then `admin_create_app_release` reads the real size from storage and records it.
2. Installs check on launch, on resume (>10 min since last) and every 6 h: `get_latest_app_release('android', <installed versionCode>)`.
3. Newer release -> bottom sheet (notes, size). "Later" hides it 24 h for that release. A Required release shows a blocking
   screen instead (the admin lifts it by unpublishing).
4. Update now -> network policy (Settings -> App updates; default "ask on mobile data"):
   `wifi-only` and `ask` on Wi-Fi start a Wi-Fi-only job (the OS pauses it on mobile data and resumes on Wi-Fi);
   `always` allows mobile data (never roaming); `ask` on mobile data asks "Use mobile data / Wait for Wi-Fi".
   Android's DownloadManager does the transfer, so it resumes after drops and survives the app being killed. A stored
   download is re-attached after a restart.
5. Install now -> the plugin refuses unless: SHA-256 matches the published hash, the archive is `com.duospace.app`, its versionCode
   equals the release's, it is newer than installed, and (API 28+) it is signed by the same certificate. Then it opens the
   system installer through its own FileProvider. First time: Android sends the user to "Install unknown apps" for DuoSpace.
6. After the app has been updated the leftover APK is deleted.

## iOS

No in-app installer exists on iOS. Publish either an ad-hoc / enterprise / development-signed `.ipa` (installed through
`itms-services://` + a signed manifest, only on devices in the provisioning profile) or an App Store / TestFlight link.

## Google Play

Play forbids an app updating itself outside Play and restricts `REQUEST_INSTALL_PACKAGES`. The updater switches itself off when the
installer is `com.android.vending`, but a Play upload should not contain the plugin at all (remove `duospace-app-update` from the build
or set `VITE_DISABLE_SELF_UPDATE=true`, and check the merged manifest has no `REQUEST_INSTALL_PACKAGES`).

## Relation to the older link-only notice

`app_update_config` (Admin -> Announce -> App update: latest / minimum version + store links) still works and is the fallback.
While a published release exists for an install, `AppUpdateHost` stays silent and `UpdatePrompt` owns the notice; the release's
own Required switch is then what blocks. With no published release, behaviour is exactly as before.

## Deploy order

1. Apply `20261003190000_app_releases_ota.sql` then `20261003191000_app_releases_revoke_default_grants.sql` (both already applied to the live Duospace project on 2026-10-03).
2. `supabase functions deploy app-release-download app-release-ios-manifest` (config.toml keeps `verify_jwt = false`; optional secret `APP_BUNDLE_ID`, default `com.duospace.app`).
3. Build the app (`npm ci && npm run build && npx cap sync android`; the build runs `patch-native-permissions.mjs`, which stamps the version).
4. Install the first OTA-capable build manually (older builds do not contain the updater). Later versions arrive through it.

## Tests

`src/test/appUpdate.test.ts` (controller, network policy, version stamping, static guards) and `src/test/db/appReleasesOta.db.test.ts`
(the real migration on Postgres/PGlite: admin-only writes, FOUNDER is not admin, storage policies, no path leak, audit).
The Kotlin plugin, signed URLs against real Supabase storage and the install flow are NOT covered.

## Manual test matrix (none run yet)

1. Non-admin (incl. FOUNDER, BETA, partner of admin) cannot see the Updates tab data, insert into `app-releases`, or call any `admin_*_app_release` RPC (expect "admin only").
2. Signed-out `get_latest_app_release('android', 1)` returns metadata with no `file_path`; `app-release-download` for a draft/revoked id returns 404.
3. Upload 3.22.0 -> published; an older installed build shows the sheet; a build at 3.22.0 shows nothing.
4. Wi-Fi only on mobile data: notification shows queued; turning Wi-Fi on completes it.
5. Ask policy on mobile data: dialog appears; both answers behave as labelled. Always: downloads on mobile data.
6. Kill the app mid-download, reopen: progress resumes / "ready" appears.
7. Corrupt the upload (wrong hash in DB): install is refused with the corruption message and the file is deleted.
8. APK signed with a different key: refused (SIGNATURE_MISMATCH); a lower versionCode: refused (NOT_NEWER).
9. Mark Required: full-screen block, no Later; unpublish: block disappears at next check/resume.
10. "Install unknown apps" off: settings screen opens, returning completes the install without re-tapping.
11. Play-installed build: no prompt, no Settings row.
12. iOS ad-hoc IPA via itms-services; iOS store link opens.

## Auto-detected release fields (admin upload)
Choosing an .apk in Admin -> Updates now reads AndroidManifest.xml in the browser (`src/lib/appUpdate/apkMetadata.ts`, zip central directory + binary XML, no dependencies) and fills the version. The form blocks the upload if the package id is not `com.duospace.app`, the build number != semverToVersionCode(versionName), or the APK is debuggable. Notes are optional (default "Bug fixes and improvements."). `.ipa` files only switch the platform; iOS version is still typed (Info.plist not parsed). Tests: `src/test/apkMetadata.test.ts` (synthetic APKs from `src/test/helpers/apkFixture.ts`).
