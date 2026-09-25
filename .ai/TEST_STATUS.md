Test status. STATUS values: PASS (actually run, passed) / FAIL / BLOCKED
/ NOT RUN. Nothing below is marked PASS in this document — no test
suite has been executable in any sandbox this project has run in so far
(no `npm ci` — registry returns 403, no network egress).

## Phase 2A (2026-09-23) — written, NOT RUN

- `src/test/relationshipSafety.test.ts` — every prohibited-claim pattern
  group added for relationship insights (cheating/attraction, abuse,
  personality-disorder/diagnostic labels, toxicity, relationship-failure,
  breakup-necessity, partner-guilt, partner-mental-state, deception,
  partner-disrespect verdicts, numeric/ratio/"compatibility" scores),
  each of the brief's §16 worked examples (both the BAD text that must be
  blocked and the GOOD text that must pass), the structural rules
  (user-attributed observation, hedged possible explanations, required
  evidence + analysisKind, non-imperative suggestedAction), confirmation
  that `uncertainty`/`evidence` are scanned (not just `observation`), and
  that these rules apply only to `feature === RELATIONSHIP_INSIGHTS`, not
  every insight. Pure function tests (`validateInsight`), no mocking.
- No test file yet for `src/lib/relationship/pipeline.ts`,
  `stores.ts`, or `sharing.ts` directly (deps.ts's injectable
  `RelationshipDeps`/`ShareCtx` seams make these straightforward to unit
  test with an in-memory `InsightBackend` and a mock provider — this is
  the most valuable next testing investment, not yet done for time).

## New this phase — written, NOT RUN

- `src/test/outputValidator.test.ts` — every prohibited phrase (both as
  the observation and inside a possibleExplanation), confidence-ceiling
  per source, structural requirements, partner-directed-action rejection.
  Pure functions, no mocking needed.
- `src/test/redact.test.ts` — key-based redaction (nested, arrays,
  circular refs), JWT-shape string redaction, non-sensitive passthrough.
  Pure functions.
- `src/test/privacyGate.test.ts` — absolute deny rules (cannot be
  overridden by mocked-true consent), capability gate, consent fail-closed
  behavior, `requireCanProcess()`. Mocks `consent.ts`'s `hasConsent` via
  `vi.mock` — doesn't touch Supabase.
- `src/test/secureStorageCrypto.test.ts` — AES-256-GCM round-trip, wrong-key
  failure, tampered-ciphertext (GCM auth) failure, IV uniqueness. Tests
  the primitive directly, not `secureStorage.ts`'s exported functions —
  see the file's own header comment for why: those depend on IndexedDB,
  which jsdom (this project's test environment) doesn't implement, so a
  full round-trip through `secureSet`/`secureGet` would silently generate
  two different master keys and fail for an environment reason, not a
  code reason. Flagged here rather than worked around with an unverified
  new dependency.

STATUS for all four: BLOCKED BY ENVIRONMENT (written, never executed —
no `npm ci` possible in this or any prior sandbox).

## Explicitly not tested

- `consent.ts`'s actual Supabase read/write path (would need a live
  project or a much heavier Supabase client mock than this pass built).
- `secureStorage.ts`'s exported `secureSet`/`secureGet`/`secureWipeAll` —
  see above; the crypto primitive is tested, the IndexedDB/prefs.ts
  integration is not.
- The two new RLS policies and three triggers in
  `20260917100000_privacy_consent_ai_foundation.sql` — no live database
  access. Written to mirror the already-audited transition-guard pattern
  from `call_history_transition_guard.sql`/`partner_requests_transition_guard.sql`,
  but that similarity is not a substitute for actually running them
  against a live Postgres instance.
- `PrivacyAISettings.tsx` — no component-render test written this pass.
- Any pre-existing test suite in this repo — not re-run (couldn't be).

## Standing gap (all phases)

`npm ci` / `npm run lint` / `tsc` / `npm test` / `npm run build` have
never actually executed successfully in any sandbox this project has
been worked in. Every "FIXED" claim across every `.ai/`/`docs/` file
means "written and hand-verified against the actual call sites", not
"compiled and tested" — stated explicitly here so it isn't lost in
translation between passes.

## 2026-09-19 — Phase 1.5 Production Verification pass

- `npm ci`: FAIL (confirmed again — 403 from registry; ALSO, independent
  of network, would fail on lockfile/package.json mismatch for
  `livekit-client` even with network access — see KNOWN_ISSUES.md KI-07).
  STATUS: BLOCKED BY ENVIRONMENT + a real repo-state bug underneath it.
- `npm run lint` / `npx tsc --noEmit` / `npm test` / `npm run build`:
  NOT RUN — all depend on `npm ci` succeeding first.
- `npm run verify:lock` / `npm run check:rls`: NOT RUN (same reason;
  also not confirmed these scripts exist in `package.json` — not checked
  this pass).
- TypeScript safety: sampled (not exhaustive) — see KNOWN_ISSUES.md KI-08.
  No compiler was run; this was a static grep-based review only.
- No new test files added this pass (prior pass's 4 suites — validator,
  redact, privacyGate, secureStorage-crypto — still the full set; still
  unexecuted, same BLOCKED reason).

STATUS overall: unchanged from every prior pass. Nothing in this project
has ever compiled, linted, tested, or built successfully in any sandbox
session to date.

## 2026-09-20 — location error classification

- `src/test/locationErrors.test.ts` — native-error normalisation ("services
  not enabled" -> unavailable, never timeout; unknown -> timeout, never
  denied), `describeGeoError`, `isServicesOffMessage`. Pure functions.
  vitest run: BLOCKED BY ENVIRONMENT (no `npm ci`). The same assertions were
  run in plain Node against the tsc-compiled module: PASS.
- Not covered by any test: the fallback fix, the watcher restart after 3
  timeouts, `retryPermission()`, and MapView's overlay selection (needs a
  Capacitor/geolocation mock harness this project doesn't have).

## 2026-09-19 — E2E fallback + FLAG_SECURE patch

- `src/test/e2eAccountWideKey.test.ts` extended (`isSyncTableUnavailable`,
  `resolveIdentityKeyWithFallback`). vitest run: BLOCKED BY ENVIRONMENT (no
  `npm ci`). The same assertions were executed in plain Node against
  hand-written mocks of the Supabase client / crypto module: PASS (12/12).
- `scripts/patch-native-permissions.mjs` `patchSecureWindow()` executed against
  stub Java + Kotlin MainActivity files (fresh, pre-patched, idempotent,
  missing-`super.onCreate`): PASS. Resulting Java/Kotlin NOT compiled.
- Chat.tsx wait-for-keys flow: syntax-parsed only; no React/DOM harness exists.


---
# Phase 1.6 (2026-09-20)

- `npm ci` / `npm run lint` / `tsc --noEmit` / `npm test` / `npm run build`:
  **BLOCKED** (no registry access; `node_modules` absent). `npm run check:lock`
  **FAIL** (reproduces KI-20).
- `npm run check:rls`: **PASS** (presence check only; 42 tables + storage.objects).
- New test files (written for vitest, in `src/test/`): `privacyPolicy` (26),
  `sensorPolicy` (20, includes a static inventory scan of `src/`),
  `aiProvenance` (33), `telemetryRedaction` (7). The merged theme overlay adds
  `themeCatalog` (4). **None have been run under vitest.** They were executed
  against the real source with a throwaway stand-in runner (esbuild bundle + a
  ~40-line `describe/it/expect` shim, Capacitor/Supabase stubbed): 148 test
  cases passed, 0 failed, across 9 files — the 5 above plus the existing
  `telemetry` (9), `redact` (11), `outputValidator` (34), `secureStorageCrypto`
  (4). That is evidence the logic is right, NOT evidence the suite passes in CI
  (the shim is not vitest; ~20 other existing test files could not be run by it
  at all, e.g. those using `vi.mock`, `localStorage`, or matchers it lacks).
- Changed modules were type-checked with a standalone `tsc --strict` over the
  pure modules and new tests: no errors other than missing ambient types
  (`import.meta.env`, `node:*`, `@supabase`/`@capacitor` — environment only).
  The edited `.tsx` files were only syntax-checked (esbuild), not type-checked.
- Not covered by any test: `consent.ts` persistence/cache (needs a Supabase
  mock), `cameraBus.acquireCamera` end-to-end, `secureStorage` (existing
  `secureStorageCrypto.test.ts` unchanged), `MoodDetector` behaviour.
- Existing `privacyGate.test.ts` (uses `vi.mock`) was not runnable here; the
  gate keeps its old public behaviour but that is unconfirmed.


- 2026-09-20 (music notification): `src/test/notificationIssue.test.ts` (6 cases) passed under the
  stand-in runner (NOT real vitest). The Kotlin changes are uncompiled and unrun.

## 2026-09-20 — audit pass (perf + QR link)
- `src/test/qrPartnerClaim.test.ts` — written, NOT RUN under vitest. Same logic (19 checks) executed in
  Node/tsx against stubbed storage + supabase: all passed.
- crypto derived-key cache: executed in Node against real WebCrypto (round-trip, wrong key, failed-derivation
  eviction, derive count): passed. Not run in a browser/WebView.
- SQL in `20260920130000_qr_partner_link_fix.sql`: hand-reviewed only, never executed.
- Edge functions: syntax-checked only (no Deno runtime).
- 2026-09-20 deploy: after applying the migration, catalog query confirmed grants/columns/functions and an
  unauthenticated `claim_qr_partner_link` call returned NOT_SIGNED_IN. Edge functions deployed (ACTIVE) but not
  invoked. No two-phone test yet.

## 2026-09-20 — Calling Phase 4
- RAN (local vitest-compatible shim via tsx — NOT real vitest; shim verified to fail bad assertions): 164 tests.
  New 131: `infrastructure/signaling/test/{gateway,protocol,rateLimit}` 68, `webSocketSignalingEngine` 11,
  `callSignalingClient` 21, `signalingArchitecture` 12 (real gateway + client + LiveKit authz, no Realtime),
  `signalingProtocolParity` 6, `livekitTokenAuthz` 8, `callLatencyPhase4` 5. Pre-existing re-run 33:
  `signalingEngine` 15, `callLatencyPercentiles` 4, `callHistoryProviderField` 2, `callStateMachine` 12.
- Strict `tsc`: clean on gateway core and client signaling modules (only `setImmediate` in a test helper lacks node types here).
  Syntax-level `tsc` on the merged React files: no syntax errors (found + fixed a duplicate `callRef`).
- WRITTEN, NOT RUN: `createOutgoingCallRoom.test.ts` (vi.mock), `callSignalingBridge.test.ts` (Testing Library + vi.mock).
- NOT RUN AT ALL: real vitest, `npm ci`, project `tsc`, eslint, build, Postgres migration/RPC, gateway process, docker, LiveKit, TURN, Deno, devices.

## 2026-09-23 (Phase 2B)
Full suite 727 passed / 6 failed (pre-existing, unrelated: connectivity ×4, networkQualityClassifier, playHistory). New: src/test/ai/ (pipeline 18, safety 52, evaluation 5, capabilities 12), src/test/db/relationshipShares.db.test.ts (10, REAL Postgres via PGlite running actual migrations with RLS). check:lock PASS, check:rls PASS, eslint 0 errors, build PASS, tsc 18 pre-existing errors / 0 new. No real model executed. See docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md.

## 2026-09-23 (Phase 2C, merged tree)
790 passed / 6 failed (same pre-existing: connectivity ×4, networkQualityClassifier, playHistory). AI tests 181 pass. tsc: pre-existing only (PhotoViewer/faceRecognition lines shifted by photos zip; MoodDetector fixed). lint 0 errors. build 0. See docs/PHASE_2C_REAL_LOCAL_AI_AND_E2E_ROUTING_REPORT.md.

## 2026-09-23 (Phase 2D)
806 passed / 2 skipped (real-model runner, no LOCAL_MODEL_DIR) / 6 failed (pre-existing: connectivity ×4, networkQualityClassifier, playHistory). AI tests 204 pass. tsc 18 pre-existing, 0 new. lint 0 errors. build 0. See docs/PHASE_2D_REAL_LOCAL_AI_FINAL_REPORT.md.
