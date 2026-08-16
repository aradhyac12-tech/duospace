# DuoSpace — Pre-Implementation Stabilization Phase

## Scope

Sync the uploaded ZIP (540 files, includes new `docs/PHASE8*` reports and `src/types/`), then run a full audit-and-document pass. No new relationship-AI features, no surveillance features, no DuoAutoAnswer implementation. Only fixes for defects found during the audit.

## 1. Sync the archive

- Extract `duospace-redesign-final_1.zip` and merge into the project, excluding any `.git` metadata.
- Reinstall dependencies, then run typecheck, lint, tests and a production build; fix only what the sync breaks.

## 2. Bundle identifier

- Ensure a single consistent identifier `com.duospace.app` across `capacitor.config.json` (add explicit iOS `bundleId` / Android `packageName` fields), `whitelabel/apps.json`, and the native patch script so generated Android/iOS projects always receive it.

## 3. Repository discovery (read-only first)

Inventory every area: app source, hooks, services, migrations (`scripts/sql/*`), Edge Functions, native plugins (`native-plugins/`, `native/android/`), Capacitor config, CI, tests, docs, assets. Flag duplicates, dead code, TODO/FIXME, security- and privacy-sensitive paths, all outbound data flows and third-party services (Supabase, Daily.co, YouTube/Piped, FCM/APNs, Google Drive).

## 4. Documentation reconciliation

Compare every claim in `docs/` (phases, memory, rules, design, prd, the PHASE8 reports) against actual source. Produce a discrepancy matrix with statuses limited to PASS / FAIL / PARTIAL / BLOCKED / NOT IMPLEMENTED / NOT VERIFIED. Anything that cannot be executed in this environment (real devices, live Supabase) is marked BLOCKED BY ENVIRONMENT, never PASS.

## 5. Create the `.ai/` context system

New directory with: `PROJECT_CONTEXT.md`, `CURRENT_STATE.md`, `ARCHITECTURE.md`, `PRODUCT_VISION.md`, `PHASE_STATUS.md`, `IMPLEMENTATION_RULES.md`, `SECURITY_MODEL.md`, `PRIVACY_MODEL.md`, `DATA_CLASSIFICATION.md`, `AI_SAFETY_SPEC.md`, `NATIVE_CALLING.md`, `DATABASE_CONTRACT.md`, `DESIGN_SYSTEM.md`, `TEST_STATUS.md`, `KNOWN_ISSUES.md`, `DECISIONS.md`, `DO_NOT_CHANGE.md`, `NEXT_PHASE.md`, `AI_HANDOFF_TEMPLATE.md`, `CHANGELOG.md`.

Content is derived from the code, not copied from old docs. `AI_SAFETY_SPEC.md` codifies the no-cheating-detector / no-lie-detector / observation-plus-uncertainty rules; `DO_NOT_CHANGE.md` codifies the architectural guardrails; `NATIVE_CALLING.md` documents the current call state machine plus DuoAutoAnswer prerequisites (specification only).

## 6. Security and privacy audit + targeted fixes

Inspect before patching, small verifiable changes only:

- `user_secrets` (`daily_api_key`, `google_drive_refresh_token`) — determine client readability and move secret usage server-side into Edge Functions where it can be done without breaking calling or backup.
- Upload path: `resumable-upload` / `finalize-upload` / `cleanup-orphan-uploads` — idempotent finalization, concurrency race, auth handling, MIME/size/path validation, storage RLS and ownership.
- Auth: OAuth redirects and deep links, QR pairing replay/forgery, invite links, session refresh/logout, duplicate callback processing.
- RLS review across profiles, messages, memories, mood, storage objects and all other couple/private tables; live two-account verification is written up as a test plan and marked LIVE VERIFICATION BLOCKED where it cannot run here.
- Logging redaction: no message content, tokens, keys or media in logs.

## 7. Build, tests, observability, performance, a11y, design

Run `lint`, `tsc`, `vitest`, `vite build` and record exact results (no `|| true` masking — the CI workflow's `|| true` on typecheck is removed). Add real behavioural tests where practical for uploads, rate limiting, auth callback parsing and pairing. Audit bundle size, listener leaks, unbounded caches, MediaPipe/worker cost, accessibility (touch targets, contrast, reduced motion, font scaling) and design-system consistency — documented, with fixes only for actual defects.

## 8. Test plans and final report

- Real-device Android/iOS calling matrix (cold start, locked screen, network switch, Bluetooth, decline/cancel/timeout, reboot, push) — plan only, marked NOT VERIFIED.
- Two-account Supabase isolation plan per sensitive table.
- Update `README.md` as the human entry point and point it at `.ai/`.
- Write `docs/PHASE_PRE_IMPLEMENTATION_STABILIZATION_FINAL_REPORT.md` with the required sections, an honest production-readiness score per area, and the P0/P1/P2 counts.

## Technical notes

- ZIP merge uses rsync with `.git` excluded; `.env` and Supabase client credentials are preserved.
- No migrations are deleted; no destructive database changes.
- Deliverables end with the required status block (BUILD / TESTS / SUPABASE / RLS / SECURITY / PRIVACY / ANDROID / IOS / CALLING / AI READINESS / AUTOANSWER / PRODUCTION / SCORE).
- Next phase recorded as: DuoSpace Scientific + Product Specification.
