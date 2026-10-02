# Phase 3H — Verification Kit + Android Pipeline Fix (2026-09-26)

No product features, no UI changes, nothing deployed, production untouched.

## Why a kit
Every remaining gate (HTTP auth, session isolation, app→RLS, Android, calling, notifications, local-AI artifact) needs either `*.supabase.co`, `huggingface.co` or a phone — all unreachable from this sandbox (`host_not_allowed`, verified). The smallest unblock is runnable, reviewed tooling whose output comes back for review.

## Delivered
| Item | File | Verified here |
|---|---|---|
| HTTP auth + RLS E2E (24 checks, real JWTs, throw-away users, refuses production, no secrets in output) | `scripts/verify/http-rls-e2e.mjs` | syntax; refuses with no env (exit 2); refuses production URL (exit 2). **Not run live.** |
| Local-model acquisition (resolve full commit, download, local SHA-256, compare with published LFS hash, manifest snippet) | `scripts/verify/fetch-local-model.mjs` | syntax; fails cleanly on 403 here. **Not run live.** `models/` added to `.gitignore`. |
| Device runbook + matrix | `docs/DEVICE_TEST_KIT.md` | env var names checked against `client.ts` |

## Defect found and fixed — G1 (P1, release pipeline)
`scripts/verify-android-build.mjs --deps` required `@capacitor/assets` to match core's major (8) and told users to bump it to ^8. The newest `@capacitor/assets` is **3.0.5** (npm registry, checked); it is a CLI with no native code. So `npm run cap:add:android` and `npm run cap:sync` failed at their first step for everyone — no Android build could be produced via the repo's own pipeline.
Fix: exempt only `@capacitor/assets` (independently versioned tool). Regression `src/test/androidBuildGate.test.ts` (3): real repo passes; a real plugin mismatch (`@capacitor/preferences@^5` vs core 8) still fails; the CLI isn't flagged. The test fails when the fix is removed.

## Gates (this run)
vitest 101 files / 1166 passed / 2 skipped / 0 failed; DB 32 passed; tsc app 0 / node 0; eslint 0 errors (95 warnings); check:rls 0; build 0; Android deps gate 0 (was 1).

## Decision
PHASE 3H: PARTIAL — tooling ready and one pipeline blocker removed; live results still pending.
OVERALL: NOT READY.
