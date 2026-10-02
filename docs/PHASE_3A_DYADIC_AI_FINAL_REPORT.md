# Phase 3A — Dyadic AI: Final Report (2026-09-25)

**Outcome:** implemented and verified in this sandbox through the deterministic / RULE_BASED path. The real local model is still BLOCKED (Phase 2D), so the LOCAL path is exercised only with test doubles. Not tested on a real device. **DuoSpace has not demonstrated efficacy.**

## Audit summary
- Existing: Values (30 questions / 15 areas, NOT_SURE + PREFER_NOT_TO_ANSWER), Expectations (free text), Communication Reflection, `RelationshipAIService` (LOCAL / E2E_CLOUD / RULE_BASED / UNAVAILABLE routing), local-rule provider, output + grounding validators, provenance, consent (`RELATIONSHIP_INSIGHTS`), explicit per-item sharing via `relationship_shares` (RLS: owner or recipient select; insert only to current partner; owner revoke).
- Reused rather than duplicated: service routing, consent gate, secure on-device storage, sharing/RLS, Phase 2 prohibited-content patterns and grounding checker.
- Found and fixed during this work (pre-existing, not Phase 3A): Reflection saves hung forever on web because Capacitor's `Preferences` Proxy was returned from async functions and treated as a thenable (`src/lib/prefs.ts`, `src/lib/capacitorAuthStorage.ts`).

## Implementation — files
New: `src/lib/relationship/dyadic/{types,compare,explain,responsiveness,index}.ts`, `src/components/relationship/PartnerComparison.tsx`, `src/test/dyadic/{dyadicComparison,dyadicAdversarialEval,dyadicPrivacyStatic}.test.ts`, `docs/eval/phase3a_dyadic_eval.json`, `docs/AI_SCIENTIFIC_FOUNDATION.md`, `docs/DYADIC_AI_EVALUATION_PLAN.md`, `.ai/AI_PRODUCT_PRINCIPLES.md`, `.ai/DYADIC_AI_SPEC.md`, this report.
Changed: `src/lib/relationship/service.ts` (+`compareWithPartner`), `src/lib/ai/outputValidator.ts` (+exported `findProhibitedContent`), `src/pages/Reflection.tsx` (mounts the comparison in the Insights tab), `.ai/AI_SAFETY_SPEC.md`, `.ai/CURRENT_STATE.md`, `.ai/NEXT_PHASE.md`, `package.json` (version, dev-dep `fake-indexeddb` for the storage regression test).

## Data model
See `src/lib/relationship/dyadic/types.ts` and `.ai/DYADIC_AI_SPEC.md`. `DyadicItem` with `DyadicProvenance {source: "user_self_report", owner, sharedWithPartner, shareId, confidence: "explicit", createdAt, updatedAt}`; `DyadicComparison {status, unknownReason, self, partner, staleness}`; `DyadicResult` = the §17 contract (observation, comparison, status, self/partner evidence, possible_explanations, unknowns, conversation_prompt, suggested_action, qualitative confidence, uncertainty, source, model_version, classification, processing_location ON_DEVICE, consent_reference, created_at, expires_at). **No numeric field exists in the result** (asserted by a test). No database schema change: corrections are stored encrypted on-device (`rel_dyadic_corrections_v1`).

## Comparison engine
Deterministic (`compare.ts`). UNKNOWN when: self not answered, partner not shared, NOT_SURE, declined, ambiguous option (`flex, depends, varies, mix, mixed, unsure`), free-text expectation, or a correction marks it outdated/wrong. Otherwise identical choice → ALIGNED, different choice → DIFFERENT. Staleness: >180 days old or >90 days apart → clarification flag. Corrections override and expire when the underlying answer is updated later.

## AI architecture
comparison → `ruleExplain` (templates) → optional LOCAL `explainDyadic` (may only rephrase comparison, possibilities, prompt, suggestion; 8 s timeout) → `validateDyadicResult` → first passing candidate, else `INSUFFICIENT_INFORMATION`. Service picks LOCAL only when routing says LOCAL and the provider implements `explainDyadic`; E2E cloud is never used; consent required.

## Safety — validators
`validateDyadicResult`: STATUS · GROUNDING · SAFETY (Phase 2 patterns + outcome prediction + AI-authority) · NO_SCORE · STRUCTURE. Model drafts with prohibited content in any field are rejected whole.

## Grounding — provenance
Evidence fields must equal the owner's explicit statement verbatim; any quoted text must be something one of them stated; after stripping users' words, any history/frequency term or number authored by DuoSpace is rejected (so "your partner always…" fails even if "always" appears in an answer label). Day counts appear only in the computed staleness line.

## Privacy
Partner data only from active share rows addressed to me by my linked partner (RLS + code re-check of recipient/owner/revoked/expiry). My own items stay on my device. The dyadic module imports no network, telemetry, analytics, cloud or service-role code (static test). Reply-helper text is never stored. RLS unchanged.

## Tests — commands and exit codes (sandbox, 2026-09-25)
| Command | Result | Exit |
|---|---|---|
| `npx vitest run` | 78 files, 911 passed, 2 skipped | 0 |
| `npx vitest run src/test/dyadic` | 3 files, 33 tests passed | 0 |
| `npm run check:rls` | presence check passed | 0 |
| `npx eslint <changed files>` | no errors | 0 |
| `npx tsc -p tsconfig.app.json` (changed files) | no errors in changed files (pre-existing errors elsewhere unchanged) | — |
| `npx vite build` | built | 0 |

## Evaluation (`docs/eval/phase3a_dyadic_eval.json`)
2,328 cases: 14 required topics × their catalogue questions × 7 scenarios (aligned, different, partner missing, not sure, declined, revoked share, stale) × 5 user-context variants (none + 4 hostile/injected), plus 16 hostile model outputs per comparable case and 4 adversarial reply-helper inputs. Reported per dimension, no overall score:

| Dimension | Pass | Fail |
|---|---|---|
| Factual grounding | 980 | 0 |
| Safety compliance | 2,328 | 0 |
| Comparison correctness | 980 | 0 |
| Uncertainty calibration | 1,120 | 0 |
| Privacy | 980 | 0 |
| Usefulness (structural proxy) | 980 | 0 |
| Conversation-prompt quality (structural) | 980 | 0 |
| Neutrality | 980 | 0 |
| Hallucination | 980 | 0 |
| Hostile model-output rejection | 1,344 | 0 |

The evaluation found two real gaps that were fixed before these numbers: outcome prediction ("will cause problems / break up") was not caught by any validator, and history words present in an answer label could license a fabricated pattern claim.
**Caveat:** usefulness and prompt quality are structural checks (non-empty, question form, area-specific, not accusatory), not human judgements. The dataset is authored by the same team that wrote the rules, so it tests known failure modes, not unknown ones.

## Scientific foundation
See `docs/AI_SCIENTIFIC_FOUNDATION.md`: Reis & Shaver 1988 (via S2); Laurenceau, Barrett & Pietromonaco 1998; Laurenceau, Barrett & Rovine 2005; Hawkins et al. 2008; Blanchard et al. 2009 (abstracts read); Fawcett et al. 2010, Halford & Bodenmann 2013, Falconier et al. 2015 (citation-verified only; not relied on). Limitations: correlational diary evidence for PPR; programme-based, US-heavy samples and modest effects for relationship education; no evidence about AI or app delivery.

## Remaining limitations
- Real local model unavailable → LOCAL explanation path untested with a real model.
- UI not tested on a device or by users; wording not reviewed by a clinician or researcher.
- Free-text expectations are shown side by side but never compared.
- Comparison is per question only; one question cannot capture what an answer means to someone.
- Adversarial set is self-authored; no external red-team.
- The comparison is visible only to the person who runs it; there is no shared/joint view.

## Next phase (evidence-based recommendation)
**Phase 3B: validation, not new automation.** Real-device QA of the comparison and reply helper; a small usability/wording review with people outside the team; read S6–S8 and evidence on digitally delivered couple interventions; select validated instruments for the evaluation plan and seek ethics review. Do **not** start conflict-repair automation or multimodal AI.

## Acceptance checklist
- [x] repository audited  - [x] `.ai` reconciled  - [x] scientific foundation documented
- [x] dyadic data model  - [x] ALIGNED  - [x] DIFFERENT  - [x] UNKNOWN
- [x] no compatibility score  - [x] no health score  - [x] no diagnosis  - [x] no mind-reading
- [x] provenance  - [x] temporal grounding  - [x] explicit sharing enforced  - [x] corrections
- [x] responsiveness support  - [x] neutral prompts  - [x] rule-based fallback  - [x] LOCAL via existing service (hook; model BLOCKED)
- [x] safety validation  - [x] grounding validation  - [x] privacy tests  - [x] adversarial tests
- [x] regression suite  - [x] production build  - [x] documentation  - [x] final report
