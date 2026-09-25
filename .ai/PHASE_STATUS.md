> **Superseded (2026-09-23):** DuoSpace calling is now self-hosted only (WebSocket signaling + LiveKit). Mentions of the previous provider below are historical. Current architecture: `docs/calling-architecture.md`; migration record: `docs/CALLING_MIGRATION_DAILY_TO_SELF_HOSTED.md`.

Phase ledger.

## Phase 0 — Stabilization / pre-implementation baseline
Repository discovery, `.ai/` directory creation, initial security audit.
See `docs/PHASE_PRE_IMPLEMENTATION_STABILIZATION_FINAL_REPORT.md`.

## Phase 0.5 — Scientific + Product Specification
Relationship-science research, compatibility/values/expectations/
conflict/trust/mood frameworks, regulatory review, do-not-build list. See
`docs/DUOSPACE_SCIENTIFIC_PRODUCT_SPECIFICATION_FINAL_REPORT.md` (if
present in your snapshot — see `.ai/KNOWN_ISSUES.md` KI-01).

## Ongoing — Security hardening (docs/PHASE_4_SECURITY_AUDIT.md)
Multiple passes closing real findings: partner Daily.co key oracle,
call-status spoofing, broad SELECT policies, reaction races,
`search_users` enumeration, upload validation gaps, `partner_requests`
transition guard, `finalize-upload` bucket-allowlist mismatch, Realtime
channel authorization, `send-push` recipient authorization. Still open:
full edge-function-adjacent items (encryption lifecycle threat model,
session/clock-skew, telemetry review, TS `any` audit, push-token RLS,
docs-vs-source discrepancy matrix). Verdict: **NOT READY**, unchanged
across every pass.

## Parallel track — Self-hosted calling architecture (not this phase's scope)
`infrastructure/signaling/`, LiveKit integration, `CALL_PROVIDER` flag.
Wired end-to-end by static analysis, never runtime-verified. Daily
remains the hard default. See `docs/calling-architecture-v2.md`.

## Phase 1 — Privacy, Consent & Local-First Intelligence Foundation (THIS PHASE)
- Objective: infrastructure only — data classification, consent
  management, privacy gate, local encrypted storage, AI insight schema/
  provenance/confidence/correction/lifecycle, sharing model, DB-layer
  enforcement, tests. No relationship-AI model built (per the freeze).
- Files: see `.ai/ARCHITECTURE.md`'s "Privacy / AI foundation" section
  for the full file list.
- Database: `20260917100000_privacy_consent_ai_foundation.sql` —
  `user_consents`, `ai_insights`, 7 RLS policies, 3 triggers.
- Tests: 4 new suites, written, not executable in this environment (see
  `.ai/TEST_STATUS.md`).
- UI: one new settings page (`PrivacyAISettings.tsx`), linked from
  Settings, no other navigation/layout changes.
- Two small fixes to existing code discovered while implementing this
  phase: `signOutAndClearPushTokens()` now also clears the consent cache
  and wipes secure-storage data (previously would have left both stale
  post-logout).
- Full findings: `docs/PHASE_1_PRIVACY_CONSENT_LOCAL_AI_FINAL_REPORT.md`.
- Remaining work: see `.ai/KNOWN_ISSUES.md` and `.ai/NEXT_PHASE.md`.

## Next — Phase 2 (relationship-AI, P0 self-report tier only)
Gated on: the still-open security queue (`docs/PHASE_4_SECURITY_AUDIT.md`)
AND this phase's own open items (KI-01 through KI-06) being triaged, not
necessarily all closed, before real user data starts flowing through the
foundation built this phase.

## Phase 1.5 — Production Verification (2026-09-19, THIS PHASE)

- Objective: deep production-readiness/security-closure pass before
  Relationship AI Phase 2 — no new features, verification and honest
  BLOCKED/NOT VERIFIED classification throughout.
- New P0 found: `livekit-client` lockfile mismatch (KI-07) — blocks
  `npm ci` everywhere, not just this sandbox.
- New integration gap found: 4 pre-existing mood/face features don't
  route through the Phase 1 privacy/consent system (§11 of the final
  report) — flagged, not fixed.
- 6 governance `.ai/` files restored from real prior content.
- TypeScript safety sampled (183 occurrences, systemic pattern
  identified, 3 redundant casts removed).
- Full detail: `docs/PHASE_1_5_PRODUCTION_VERIFICATION_FINAL_REPORT.md`,
  including the complete Production Readiness Matrix and 20-question
  Final Gate.
- Status: **NOT READY** — closer in two concrete, newly-documented ways,
  but the standing blocker (nothing ever executed in any sandbox) is
  unchanged.

## Next — Phase 2 (relationship-AI, P0 self-report tier only)

Still gated on: the `livekit-client` lockfile fix (new, P0), the
mood/face privacy-integration gap (new), and the pre-existing security
queue (encryption lifecycle, session/clock-skew, broader telemetry
review, docs-vs-source discrepancy matrix) — none of which require live
access to at least *triage* (the lockfile fix does need network; the
privacy-integration gap can be scoped and possibly fixed without it).


## Phase 1.6 — Repository reconciliation + privacy foundation (2026-09-20) — IN PROGRESS, NOT COMPLETE
Reconciled the actual repo against the Phase 1 design: found and fixed real
privacy defects (KNOWN_ISSUES "Fixed in Phase 1.6"), made the PrivacyGate model
every egress destination, put every camera/microphone consumer in one
registry with runtime enforcement on the shared camera path, hardened
telemetry redaction and made uploads consent-gated, added an offline lockfile
checker. **Blocked:** dependency install / lint / tsc / vitest / build /
Android / iOS (no network, no SDKs). **Release gate not met:** lockfile does not
match `package.json` (KI-20). Full report:
`docs/PHASE_1_6_REPOSITORY_RECONCILIATION_FINAL_REPORT.md`.

## Phase 2A — Relationship Intelligence V1 (2026-09-23)
Implemented the first real relationship-AI capability, scoped exactly to
the Phase 2A brief: Values Reflection, Expectations (preference /
expectation / boundary, boundary only ever user-confirmed), Communication
Reflection, and a local-only, rule-based `RelationshipAIProvider`
(`src/lib/relationship/`). Pipeline: validation -> PrivacyGate ->
provider -> safety validator (extended with relationship-specific
structural rules + ~15 new prohibited-claim pattern groups) -> encrypted
local storage -> display. `RELATIONSHIP_INSIGHTS` and `AI_PROCESSING`
capabilities flipped on for this feature only (`FEATURE_CAPABILITIES`);
`SHARED_INSIGHTS` also on, gating a new explicit per-item partner-sharing
flow (preview -> hash-bound confirm -> `relationship_shares` table,
RLS'd, auto-revoked on unlink). No relationship score of any kind exists
or can pass the validator (numeric/ratio/"compatibility" patterns are
structurally blocked). UI: one new `/reflection` page (Values /
Expectations / Reflect / Insights tabs), reached only from the existing
Hub — no shell/nav change. Full report:
`docs/PHASE_2A_RELATIONSHIP_INTELLIGENCE_V1_FINAL_REPORT.md`.
**Not run:** `npm ci` / lint / `vitest` / build (same standing sandbox
limitation as every phase above) — verified instead via an isolated
`tsc --noEmit` (stubbed external packages) covering every file this
phase touched or added, which is clean.

## Phase 2B — Local AI + evaluation + 2A hardening (2026-09-23)
2A hardening PASS · local model PARTIAL (not executed) · Web UNVERIFIED · Android BLOCKED · iOS BLOCKED · Safety PASS · Privacy PASS · Evaluation PARTIAL · Build PASS (pre-existing tsc/test exceptions) · Production AI NOT READY. Multimodal AI remains out of scope. See docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md.

## Phase 2C (2026-09-23)
Routing/orchestration IMPLEMENTED · Local model BLOCKED (no artifact) · Real inference NOT EXECUTED · E2E_CLOUD BLOCKED (no attested TEE) · RULE_BASED = what users get · Safety PASS · Privacy PASS · Production: PARTIAL/BLOCKED. See docs/PHASE_2C_REAL_LOCAL_AI_AND_E2E_ROUTING_REPORT.md.

## Phase 2D (2026-09-23)
Artifact BLOCKED · integrity mechanism verified, no hash · real inference BLOCKED · Web/Android/iOS/S24/low-end BLOCKED · Safety PASS · Grounding PASS (validator) · Privacy PASS (static) · Performance NOT MEASURED · Routing PARTIAL · Regression PASS · Production local AI NOT READY. Next phase: Local AI stabilization. See docs/PHASE_2D_REAL_LOCAL_AI_FINAL_REPORT.md.
