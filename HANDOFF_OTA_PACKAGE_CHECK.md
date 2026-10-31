# Handoff: OTA update check made package- and version-aware

## Problem
An app already on the latest version kept being offered the same update. The check compared only a
numeric build number, a release never recorded its package, and the build number the admin published
was a formula of the typed version name, not the number actually stamped inside the uploaded APK.
The old fallback prompt (app_update_config) also compared against the JS bundle's constant, not the
version the phone really runs.

## What changed
- supabase/migrations/20261005100000_ota_package_aware_check.sql  (APPLY THIS)
  - app_releases.package_name (default com.duospace.app)
  - get_latest_app_release(platform, code, package_name?, current_version?) -> offers a release only if
    package matches AND build number is higher AND x.y.z version is higher. Old 2-arg callers still work.
  - admin_create_app_release gains optional _package_name (9-arg callers still work).
- src/lib/appUpdate/policy.ts: isNewerThanInstalled() + compareSemver(): local final gate (package, build,
  version name). Works even against a server without the migration.
- appUpdateController / index.ts: sends installed package + version name; filters through the gate.
- Admin Releases tab: build number and package are read from the uploaded APK itself (source of truth);
  wrong package or debug build still blocks; publishes package_name.
- AppUpdateHost (fallback prompt): compares against the installed native version.
- UI: new update sheet (version A -> B, size chip, what's new, Download/Install steps, MB progress,
  verified-ready state); Settings shows build number.
- Tests: src/test/appUpdatePackageCheck.test.ts

## Verification status
- Not run here: no node_modules / no network in the sandbox. Run `npm test` and `npm run build`.
- Apply the migration to staging (duospace-staging) first, then production.
- Releases published BEFORE this change were stamped with the old formula number; if one of them is the
  one nagging users, unpublish it and re-upload the APK so its real build number is recorded.

## Next steps
1. npm install && npm test (check appUpdate.test.ts, appUpdatePackageCheck.test.ts, db tests)
2. Apply migration, rebuild APK (version bump if your builder doesn't auto-bump), upload via Admin -> Releases
3. On a device: install N, publish N+1 -> prompt shows; install N+1 -> no prompt, Settings says latest
