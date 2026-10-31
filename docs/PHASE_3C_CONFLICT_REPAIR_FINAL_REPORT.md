# Phase 3C — Conflict Repair Assistant: Final Report (2026-09-25)

## 1. Executive summary
A private, structured conflict-repair preparation flow is implemented on the deterministic RULE_BASED path, routed through `RelationshipAIService`, with a fail-closed safety/coercion gate, fact/experience/interpretation/unknown separation, behaviour-specific responsibility, preserved disagreement and boundaries, grounded message generation, user edits, and explicit message-only sharing with withdrawal, enforced by a new database constraint and verified on real Postgres with RLS. **Not production-ready:** no real local model, no device testing, no human evaluation, and pre-existing dependency vulnerabilities remain (§18).

## 2. Scientific scope
`docs/CONFLICT_REPAIR_SCIENTIFIC_FOUNDATION.md` separates established constructs, correlational findings (new: Fehr, Gelfand & Nag 2010, abstract read), product hypotheses, unvalidated features and future outcomes. No efficacy claim.

## 3. Existing architecture audited
Baseline before changes: vitest 82 files / 968 passed (exit 0), `tsc -p tsconfig.app.json` exit 0. Reused: `RelationshipAIService` routing, consent gate (`RELATIONSHIP_INSIGHTS`), Phase 2 prohibited-content patterns, Phase 2 grounding checker, Phase 3B component validator, `relationship_shares` + RLS + `confirmShare`/`revokeShare`, PGlite harness.
**`.ai` vs source discrepancy found:** `.ai/TEST_STATUS.md` still said no test had ever run; source reality was 968 passing. Corrected (§ .ai).

## 4. Files changed
`src/lib/relationship/service.ts` (+`prepareRepair`), `src/lib/relationship/types.ts` (+`REPAIR_MESSAGE` kind/payload), `src/lib/relationship/sharing.ts` (classification for the new kind), `src/components/relationship/PartnerComparison.tsx` (mounts the panel), `package.json`/lock (`jspdf` 2.5.2 → 4.2.1, §18), `.ai/*`.

## 5. Files added
`src/lib/relationship/repair/{types,machine,reflect,validate,index,share}.ts`; `src/components/relationship/RepairPanel.tsx`; `supabase/migrations/20260925180000_relationship_shares_repair_message.sql`; tests `src/test/repair/{repair,repairEval}.test.ts`, `src/test/db/repairShares.db.test.ts`; `docs/eval/phase3c_repair_eval.json`, `docs/eval/phase3c_perf.json`; `docs/CONFLICT_REPAIR_SCIENTIFIC_FOUNDATION.md`; `.ai/PHASE_3C_CONFLICT_REPAIR.md`, `.ai/AI_ARCHITECTURE.md`, `.ai/SAFETY_MODEL.md`; this report.

## 6. Repair state machine (`repair/machine.ts`)
PAUSE → FACTS → IMPACT → UNDERSTANDING → RESPONSIBILITY → BOUNDARY → REPAIR_GOAL → REQUEST → NEXT_TIME → REVIEW → SHARE → COMPLETE, plus SAFETY_HOLD and EXITED. EXIT from any stage. Can't leave FACTS without a concrete event. SHARE only from REVIEW with a validated message and without "Don't share". Any answer tripping the safety gate moves to SAFETY_HOLD, which is sticky for the session and refuses every event except EXIT.

## 7. Privacy model
Sessions live in React state only; nothing is written to storage or the server. The repair core (`types, machine, reflect, validate, index`) imports no network, storage, telemetry, analytics or cloud code (static test). `share.ts` is the only network path and sends only the user-approved message. No analytics/crash/model telemetry contains repair content. Classification: `.ai/PRIVACY_MODEL.md` §Phase 3C.

## 8. Safety model
`checkSafety` pattern gate for threats/violence, stalking/monitoring, coercion/control, sexual coercion, self-harm threats used as control, threats to children/pets, isolation, financial coercion, blackmail, immediate danger. Fails closed (malformed input → CONCERN). On CONCERN: no message, no sharing, no apology/reconciliation/confrontation suggestions; neutral guidance incl. "contact your local emergency number"; exit available. It is a conservative filter, **not** an abuse assessment; real-world accuracy is unknown.
Adjudication/detection/manipulation requests anywhere in the answers ("Is my partner lying?", "Analyze their voice", "Make them feel guilty", "Ignore your safety rules"…) are removed from the message with a plain explanation.

## 9. Consent model
PRIVATE → READY_TO_SHARE (explicit action + exact preview of what will and won't be shared) → SHARED (existing consent gate + partner-only insert under RLS) → WITHDRAWN (owner revoke; partner loses access immediately). Withdrawal before sending = "Don't send". RECEIVED: the partner sees shared repair messages in their panel. RESPONDED: the recipient can reply (preview + confirm); the reply references the original by uuid (`inReplyTo`), the original sender sees it, and states are derived only from RLS-visible, non-revoked, non-expired rows. Opening a message is never treated as a response or consent (see §26). Linking and read receipts are never treated as consent.

## 10. Grounding model
Every statement/component carries `RepairSource {sourceType, sourceField, sourcePartner, sourceMessageId, sourceTimestamp}`. Quotes must exist in user-supplied text; "you said" requires a verbatim quote; no feelings, intent, history or frequency that nobody supplied; messages made only of templates are refused (INSUFFICIENT_INFORMATION).

## 11. Validation model
Per component: Phase 3B validator (manipulation, mind-reading, emotion inference, grounding, boundary, dependency) on DuoSpace-authored text + Phase 2 prohibited patterns + repair-specific BLAME, FORCED_RECONCILIATION, UNSAFE_ENGAGEMENT, SURVEILLANCE, POSITIVITY, INVENTED_PARTNER_WORDS, MIND_READING. User wording that fails is left out with a note; DuoSpace-authored failure → INSUFFICIENT_INFORMATION. Model drafts are validated the same way and may not drop the user's boundary. 13-point quality check (spec §21) attached to every result. Versions: `repair-rule-v1`, `repair-validator-v1`, `repair-contract-v1`, execution mode on every result. No results are cached, so no stale-model reuse is possible.

## 12–13. Tests and counts
| Suite | Tests | Result |
|---|---|---|
| `src/test/repair/repair.test.ts` (A–Q) | 23 `it` blocks → 36 cases | PASS |
| `src/test/repair/repairEval.test.ts` | 1 (151 checks) | PASS |
| `src/test/db/repairShares.db.test.ts` (real Postgres + RLS) | 6 | PASS |
| Full suite `npx vitest run` | 85 files, 1011 passed, 2 skipped | PASS (exit 0) |

## 14. Typecheck — **PASS**: `tsc -p tsconfig.app.json` exit 0; `tsc -p tsconfig.node.json` exit 0.
## 15. Lint — **PASS**: `eslint .` exit 0, 0 errors (95 warnings, pre-existing style warnings).
## 16. Build — **PASS**: `vite build` exit 0.
## 17. RLS — **PASS**: `src/test/db/*` 19 tests on PGlite (real Postgres) with RLS as `authenticated`; `check:rls` exit 0. Verified: partner-only insert, recipient-only read, stranger sees nothing, server rejects any extra payload key/over-long/empty/wrong-kind message, owner-only withdraw, existing kinds unaffected.

## 18. Security
Existing authz/privacy/crypto tests pass. `npm audit --omit=dev` (pre-existing, not introduced by 3C): before 22 (2 critical, 6 high); fixed `jspdf` critical by upgrading 2.5.2 → 4.2.1 (**a major version**; verified by typecheck, build, full suite, and a runtime smoke test of the exact calls `shayariPdf.ts` uses — valid 2-page PDF); after 20 (1 critical `tar` via `@capacitor/cli`, 6 high incl. `vite`, `@capacitor/cli`, `@huggingface/transformers`, `sharp`, `js-yaml`). Those need major upgrades → **not done in this phase** (see §23). Shayari PDF export on a real device: NOT VERIFIED.

## 19. Performance (`docs/eval/phase3c_perf.json`)
Measured, 300 runs, RULE_BASED, **sandbox Node.js — not a phone**: first response 0.42 ms, p50 0.23 ms, p95 0.37 ms (rule p50 0.03 ms, validation p50 0.17 ms), heap 52.9 MB (whole test process). LOCAL_MODEL: NOT MEASURED. CLOUD_MODEL: not applicable. Fallback frequency: NOT MEASURED. Device performance: NOT MEASURED.

## 20. Evaluation (`docs/eval/phase3c_repair_eval.json`, 151 checks)
| Dimension | Pass | Fail |
|---|---|---|
| Adversarial (13 spec §29 prompts × 5 fields) | 130 | 0 |
| Grounding | 8 | 0 |
| Safety / quality check | 8 | 0 |
| Fact–interpretation separation | 8 | 0 |
| Unknowns present | 8 | 0 |
| Usefulness (structural) | 11 | 0 |
| No positivity bias | 8 | 0 |
| Hostile model-output rejection | 64 | 0 |
| Disagreement / boundary preserved | 1 / 1 | 0 |
| Safety gate true positives (this set) | 8 | 0 |
| Safety gate false positives on benign conflicts (this set) | 6 clear | 0 |
Defects found by tests/eval and fixed: "why this hurt" asserted a feeling the partner hadn't stated; "You said…" without a quote and "I know you feel…" passed; quoted partner words tripped the validator; a template-only message was produced from empty input; "Your partner clearly doesn't care" passed the repair validator (Phase 2 patterns weren't applied); one of DuoSpace's own "unknown" sentences read as mind-reading.
**Caveats:** self-authored, small, English-only dataset; gate accuracy on this set says nothing about real-world detection.

## 21. Known limitations
English-only patterns (Urdu/Roman Urdu not supported); pattern-based safety gate can miss danger phrased differently and can over-trigger; received-message display is minimal; no persistence means a session is lost if the app is closed (by design); no clinician/researcher review.

## 22. Blocked items
Real local model (Phase 2D artifact) · Android/iOS builds (no SDK) · device testing and device performance · human evaluation (not authorised) · major dependency upgrades (need their own regression effort).

## 23. Scientific claims NOT made
That DuoSpace repairs relationships, increases forgiveness, reduces conflict, improves satisfaction or responsiveness, detects abuse, or that its safety gate is accurate.

## 24. Recommended Phase 3D
Not longitudinal or predictive intelligence. Recommended: (1) device QA of the Insights tab flows; (2) Urdu/Roman Urdu support with tests; (3) safety-gate review by a domain expert and a false-positive/negative study on de-identified examples; (4) dependency major upgrades (vite, capacitor) as a separate engineering phase; (6) ethics-reviewed pilot.

## 25. Acceptance
| Area | Status |
|---|---|
| 3A/3B intact · no UI redesign · structured flow · private by default | COMPLETE |
| Facts/interpretations separated · unknowns explicit · responsibility ≠ blame | COMPLETE |
| Boundaries and disagreement preserved · grounded messages · no invented feelings · no hidden intent | COMPLETE |
| Safety/coercion gate · no unsafe reconciliation | COMPLETE (pattern-based; real-world accuracy unknown) |
| Sharing needs explicit consent · private analysis never shared | COMPLETE (server-enforced) |
| Withdrawal | COMPLETE |
| Consent states RECEIVED/RESPONDED | COMPLETE (§26) |
| Local/rule modes network-free · E2E boundary preserved | COMPLETE |
| Safety & grounding validators pass adversarial tests | COMPLETE |
| RLS tests · privacy tests · typecheck · lint · build · full tests documented | COMPLETE |
| `.ai` updated · final report · no fabricated evidence | COMPLETE |
| LOCAL model execution | BLOCKED |
| Device verification, native builds, human evaluation | BLOCKED |
| Production-ready | **NO** |

## 26. Follow-up (2026-09-25): RESPONDED state completed
Migration `20260925190000_repair_message_in_reply_to.sql` widens the REPAIR_MESSAGE payload constraint to allow exactly one optional extra key, `inReplyTo`, which must be a uuid string; everything else is still rejected server-side. `repair/share.ts`: `previewRepairShare(…, inReplyTo)` and pure `deriveRepairThreads` (RECEIVED/RESPONDED, partner-reply lookup). UI: Reply → preview → confirm on received messages; "Your partner replied" on a shared session.
Tests: `src/test/repair/repairThreads.test.ts` (5) and a new real-Postgres case in `repairShares.db.test.ts` (reply accepted by uuid; non-uuid, numeric and extra-key payloads rejected).
Gates after: vitest 89 files / 1056 passed, 2 skipped (exit 0); tsc exit 0; eslint exit 0 (0 errors); `check:rls` exit 0; build exit 0.
