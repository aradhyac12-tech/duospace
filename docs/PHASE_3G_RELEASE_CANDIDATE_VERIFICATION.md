# Phase 3G — Release-Candidate Verification (2026-09-26)

No features added, no UI changed, nothing deployed, production untouched (not even read in this phase).

1. **Environment:** sandbox Linux, Node v22.22.2, npm 10.9.7 (repo declares npm@10.9.2, engines node >=22). Outbound network allow-list: `*.supabase.co` and `huggingface.co` → `host_not_allowed` (verified this run).
2. **Build/version:** 3.16.4; `npm ci` clean exit 0; lockfile consistent; `vite build` exit 0. Android APK/AAB: NOT produced (no `android/` project, no SDK).
3. **Devices:** none available. Android/iOS BLOCKED.
4. **Staging backend:** `otaficrlkiscaihdwxnt` exists (Phase 3F); not reachable over HTTP from this environment.
5. **Auth (HTTP):** BLOCKED.
6. **Session isolation:** NOT_TESTED (code-reviewed only).
7. **App → RLS:** BLOCKED at HTTP; DB-level PASS carried from 3F (not re-run here).
8. **Relationship sharing:** PARTIAL (server PASS, app E2E not run).
9. **Offline/online:** NOT_TESTED on device; unit coverage for offline delete-all (E1) passes.
10. **Android:** BLOCKED. Config inspected: appId `com.duospace.app`; signing wired by `patch-android-signing.mjs` from CI secret; `allowBackup="false"`; `PrivacyScreen` disabled.
11. **Notifications:** NOT_TESTED.
12. **Calling:** NOT_TESTED.
13. **Network/privacy:** release bundle scan clean (no service_role/JWT/test creds); private AI paths zero-network (automated). Local AI network isolation not runtime-tested because local model execution remains unavailable.
14. **Local AI artifact:** BLOCKED (download impossible here). Candidate: SmolLM2-360M-Instruct, ONNX commit `028493f`; sizes/hashes not computed.
15. **Multilingual regression:** PASS (included in full suite); native review NOT done.
16. **Bugs discovered:** none requiring code change. Findings recorded: production-URL fallback when env is missing (P2); screenshots unprotected (privacy decision); committed google-services.json (informational).
17. **Fixes made:** none (no defect met the P0/data-integrity bar).
18. **Regression tests added:** none (nothing to regress).
19. **Final automated counts (this run):** vitest 100 files / 1163 passed / 2 skipped / 0 failed; DB (PGlite) 32 passed; tsc app 0, node 0; eslint 0 errors (95 warnings); check:rls 0; build 0.
20. **Remaining blockers:** see `docs/PRODUCTION_READINESS_CURRENT.md`.
21. **Decision:** PHASE 3G = **BLOCKED** (device, HTTP and model gates could not be exercised); OVERALL = **NOT READY**.
