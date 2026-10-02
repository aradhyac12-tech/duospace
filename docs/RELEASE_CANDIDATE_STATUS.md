# DuoSpace 3.18.1 — Phase 3K Release-Candidate Status

Version tested: `package.json` 3.18.1. Git commit: **unavailable** (uploaded zip has no `.git`).
Environment: sandbox, Node v22.22.2, npm 10.9.7. Egress to `huggingface.co` and `*.supabase.co` returns **403**. No staging credentials in the environment. No `adb`, no `android/` project, no devices.

Every PASS below was executed in this phase. Nothing is carried over from earlier reports.

## Verdict

**3.18.1 is NOT yet a release candidate.** Software gates pass. Every gate that needs staging, a phone or a real model was not run. Not production ready.

## Matrix

| Area | Status | Evidence / what is missing |
|---|---|---|
| Dependency install | PASS | `npm ci` exit 0 |
| Lock | PASS | `npm run check:lock` exit 0 (static check only) |
| TypeScript | PASS | `tsc --noEmit`, `-p tsconfig.app.json`, `-p tsconfig.node.json` all exit 0 |
| ESLint | PASS | `npm run lint` exit 0; 0 errors, 100 warnings (25 auto-fixable, many unused `eslint-disable`) |
| Tests | PASS (after 1 fix) | Final: 119 files, 1348 passed, 2 skipped, 0 failed. Initial: 9 failed (see D1) |
| Build | PASS | `npm run build` exit 0; chunk-size warning only |
| RLS coverage | PASS | `npm run check:rls` exit 0. Presence check only, not scoping |
| Supabase HTTP E2E | BLOCKED | Supabase host 403 from sandbox; no credentials. Run `scripts/verify/http-rls-e2e.mjs` against staging, save JSON to `docs/eval/` |
| RLS / DB behaviour | PARTIAL | Real-Postgres (PGlite) suites pass (9 files, 53 tests). Not live staging |
| Session isolation | NOT VERIFIED | Needs live HTTP run and A→B device switch |
| Relationship sharing | PARTIAL | DB-level tests pass. No client-level E2E with accounts A/B/C |
| Chat | NOT VERIFIED | Needs two devices |
| Attachments | NOT VERIFIED | Needs two devices |
| Understand / Quick Reply / Today | PARTIAL | Unit tests pass; no on-device run, no timings |
| Multilingual safety | PARTIAL | 5 test files (113 tests) covering `वो मुझे मारता है` pass. Not run through the UI on a device |
| i18n | PARTIAL | 21 strings migrated (D2). Non-English catalogs empty for `p1.*`, so all fall back to English. Contextual relationship UI and engine-generated strings not audited |
| Calling | NOT VERIFIED | Two phones, signaling server, LiveKit, `livekit-token` all unverified |
| Notifications | NOT VERIFIED | Needs device |
| Privacy / logging | PARTIAL | `service_role` absent from `dist/assets/*.js`; no JWT literal found. No logcat, no network trace |
| Encryption | PARTIAL | See "Encryption findings" |
| Local AI artifact | BLOCKED | `huggingface.co` 403. `fetch-local-model.mjs` not run. No hash, revision or size verified |
| Local AI runtime | BLOCKED | Depends on the artifact. Keep `local-rule-v1` fallback |
| Billing | NOT VERIFIED | DB entitlement tests pass (PGlite). No Play sandbox purchase, no plugin load on device |
| Android | NOT VERIFIED | No APK built: no `android/` project, no `adb`/SDK. Source presence is not runtime evidence |
| iOS | NOT VERIFIED | No Xcode/hardware |
| Performance | NOT VERIFIED | No device timings |

## Defects

**D1 — test harness (reproduced).** `src/test/db/pgliteHarness.ts` ran an unconditional `GRANT … ON public.relationship_shares`. `commerceReconcile.db.test.ts` does not load the migration that creates that table, so its 9 tests failed with Postgres `42P01`. Root cause is test-only; no production code or migration was wrong. Fix: grant only if `to_regclass('public.relationship_shares')` is not null. Result: all 9 DB test files pass. No new test was needed, since the existing 9 tests are the regression.

**D2 — hardcoded English in Phase 3J UI (static evidence).** `TodayInsight.tsx`, `UnderstandSheet.tsx` and `QuickReplySheet.tsx` (which imported no `tr`) hardcoded strings despite the 3J report saying otherwise. Migrated 21 strings to `tr()` keys in the existing catalog (`src/lib/i18n.ts`), English wording preserved. Regression test: `src/test/phase3kRelationshipUiI18n.test.ts` (3 tests; confirmed it fails when a literal is re-hardcoded).

## Encryption findings (static only)

- `secureStorage.ts` generates an AES-256-GCM master key with WebCrypto, `extractable = true`, exports it as JWK and stores it in IndexedDB.
- I found no Android Keystore or iOS Keychain use in `src`, `native` or `native-plugins` (only comments matched). **Not hardware-backed.** Classified PARTIAL.
- `secureWipeAll` deletes the key and indexed values on logout or account deletion. Keys are per user id. Behaviour on reinstall, account switch and rooted devices is not runtime-verified.
- `patch-native-permissions.mjs` sets `allowBackup="false"`. Not checked in a built APK.

## PrivacyScreen (record only, no change)

Source shows Android always calls `PrivacyScreen.enable()` and the build verifier checks `MainActivity` for FLAG_SECURE, so screenshots are blocked on Android by design. iOS follows the peek-guard and privacy-mode settings. `capacitor.config.json` has `enable: false`. Not runtime-verified. Recommendation (P-level, not applied): confirm this is intended, since it blocks user screenshots of chats.

## Stale documentation (partially reconciled)

- `docs/PRODUCTION_READINESS_CURRENT.md` says "version 3.17.0 (Phase 3I)"; snapshot is 3.18.1.
- `.ai/TEST_STATUS.md` cites 1163 tests in 100 files (2026-09-25); current is 1350 tests in 119 files.
- `.ai/CURRENT_STATE.md` still says local AI is blocked at the artifact. That remains true here, but for a different reason (sandbox 403), not because of a verified repo state.
- Not yet checked: the "production migrations not deployed" claim and monetization statements. Confirming the first needs staging/production access.

## Procedures required on a networked / device environment

1. `http-rls-e2e.mjs` against staging (credentials via env only); confirm the URL is the staging project, not production.
2. `node scripts/verify/fetch-local-model.mjs`, then the real-model eval suite.
3. `npm run build:staging && npm run cap:add:android && (cd android && ./gradlew assembleDebug) && npm run cap:verify:apk`; record path, SHA-256, applicationId, versionName, versionCode.
4. Sections 6, 7, 10, 11, 12, 17 of the phase brief on the S24 Ultra and a second phone.
5. Play sandbox purchase for billing.

## Recommended next phase

Phase 3L: staging HTTP E2E plus one Android debug APK on the S24 Ultra covering the auth/session matrix and chat. Calling and local AI follow only after that passes.
