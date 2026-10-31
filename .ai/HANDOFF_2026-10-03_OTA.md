# Handoff — 2026-10-03 — v3.22.0 OTA / in-app updates

Built on the uploaded `duospace-v3_21_2-collab-sync.zip` (package.json said 3.21.1). Read `docs/OTA_APP_UPDATES.md` first.

## Done
- Admin-only APK/IPA upload + publish (Admin -> Updates), user notification sheet / blocking overlay for Required, Wi-Fi-only / Wi-Fi+mobile-data policy, Android DownloadManager download, verified installer hand-off, iOS itms-services / store link.
- Real bug fixed: versionCode was hard-coded 1; now stamped from package.json (rule 12).
- Standing owner rule recorded: always deliver the updated zip at session end (IMPLEMENTATION_RULES 11, AGENTS.md).

## Verified in the sandbox
- `tsc -p tsconfig.app.json`: no new errors vs the uploaded zip (16 pre-existing, listed by diff).
- `src/test/appUpdate.test.ts` 33 pass; `src/test/db/appReleasesOta.db.test.ts` 17 pass (real SQL on PGlite).
- eslint clean on changed files; lock check + `npm ci --dry-run` pass; RLS coverage script passes.

## NOT verified
- Android compile of `AppUpdatePlugin.kt`; any device run; real Supabase storage/signed URLs; edge functions undeployed; iOS OTA.
- Pre-existing failing tests in the uploaded zip are unchanged (see `privacyRedTeam.test.ts` etc.); not caused by this work.

## First steps next
1. (Migrations already applied live.) Deploy the two edge functions, build a release-signed APK (version = package.json), run the matrix in the doc.
2. Decide: should Play builds exclude the plugin via a build flag in `ensure-build-deps`? (Currently manual, documented.)
