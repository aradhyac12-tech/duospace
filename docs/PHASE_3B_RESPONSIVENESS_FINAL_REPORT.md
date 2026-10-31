# Phase 3B — Partner Responsiveness & Constructive Communication: Final Report (2026-09-25)

**Outcome:** implemented and verified in this sandbox on the deterministic / RULE_BASED path; LOCAL path exercised only with test doubles (real model still BLOCKED). Not tested on a device or with users. **No efficacy is claimed.**

## 1. Phase 3A verified first
Baseline before any 3B change: `npx vitest run` → 78 files, 911 passed, 2 skipped, exit 0; 3A + AI subsets → 13 files, 235 passed.
Audit gap found: `RelationshipAIService.compareWithPartner` (consent, LOCAL routing, unsafe-model fallback) had **no test**. Added `src/test/dyadic/dyadicServiceWiring.test.ts` (3 tests, pass). No 3A regressions found.

## 2. Implementation — files
New: `src/lib/relationship/responsiveness/{types,engine,validate,index}.ts`; `src/components/relationship/ResponseSupportPanel.tsx`; tests `src/test/responsiveness/{responseSupport,responsivenessEval}.test.ts`, `src/test/dyadic/dyadicServiceWiring.test.ts`, `src/test/db/dyadicRls.db.test.ts`; `docs/eval/phase3b_responsiveness_eval.json`; `docs/RESPONSIVENESS_SCIENTIFIC_FOUNDATION.md`; this report.
Changed: `src/lib/relationship/service.ts` (+`supportResponse`), `src/components/relationship/PartnerComparison.tsx` (3A's simple reply helper replaced by the new panel), `.ai/*` listed in §10.

## 3. Schema (`responsiveness/types.ts`)
`ResponseSupport`: whatPartnerExplicitlySaid (EXPLICIT, verbatim) · whatSeemsToMatter[] (each EXPLICIT with a quote, or TENTATIVE and labelled "an interpretation") · whatIsUnknown[] (mandatory) · textCharacteristics (of this text only) · clarificationFirst · clarifyingQuestion · understandingCheck · components[] · possibleResponse · userPerspective · notes · uncertainty · source · processingLocation ON_DEVICE · modelVersion · createdAt · expiresAt · shareable · appliedCorrections · insufficientInformation · refusal. Every claim/component carries `SourceRef {sourceField, sourcePartner, sourceMessageId, sourceTimestamp}`.

## 4. Behaviour
- **Explicit vs interpretation vs unknown:** requests ("I wanted you to…", "can you/we…", "you didn't…") and stated feelings are quoted; domain readings are TENTATIVE; unknowns always listed.
- **Clarification-first:** ambiguous (≤3 words, no request/feeling) or no explicit request → clarifying question first. No emotion from punctuation, capitals, length or timing.
- **Understanding check:** "It sounds like you … Did I understand that correctly?" from the user's own reading.
- **Response builder:** ACKNOWLEDGE, REFLECT, CLARIFY, OWN, EXPLAIN, REQUEST, BOUNDARY — included only when relevant/supplied. Apology only if the user asks.
- **Respectful disagreement:** its own DuoSpace-authored component, so it survives even if the user's wording is filtered.
- **Boundaries:** monitoring requests get a BOUNDARY component and a note that agreement isn't required; compliance wording rejected when a boundary is set.
- **Manipulation:** manipulative goals (guilt, jealousy, revenge, loyalty tests, threats, blackmail, silent treatment) are refused with a direct alternative; manipulative/scorekeeping/sarcastic text rejected.
- **Corrections:** regenerate, not what I meant, too apologetic, too defensive, too formal, make clearer, keep my boundary, don't share. They change the reply, never the evidence. Reply text is freely editable.
- **Pattern labels** describe the current text ("contains an accusation and doesn't state a specific request"), never a person.

## 5. AI architecture
UI → `RelationshipAIService.supportResponse` (consent required; routing unchanged) → deterministic build → per-component validation (user wording that fails is left out with a note; DuoSpace-authored failure → `INSUFFICIENT_INFORMATION`) → optional LOCAL `rephraseResponse` (reply text only; 8 s timeout; validated; clarification-first replies must still ask) → rule fallback. Never E2E cloud.

## 6. Safety / grounding validators (`responsiveness/validate.ts`)
MANIPULATION, COERCION, MIND_READING, EMOTION_INFERENCE (emotion words nobody supplied), GROUNDING (Phase 2 history/frequency/number checker against user-supplied text; quotes must occur in the partner message; verbatim explicit field), BOUNDARY, SAFETY (Phase 2 prohibited patterns on analysis text), DEPENDENCY ("come back to DuoSpace", "let DuoSpace decide"), STRUCTURE.

## 7. Privacy / persistence / RLS
Response support is **not persisted** anywhere (memory only, per screen); no new table, no RLS change. The module imports no network, storage, telemetry or analytics (checked in the eval). New end-to-end test reads `relationship_shares` through **real Postgres RLS (PGlite)** and feeds the 3A comparison: partner → DIFFERENT, stranger → no rows / UNKNOWN, revoked → UNKNOWN.

## 8. Gates (sandbox, 2026-09-25)
| Gate | Status | Detail |
|---|---|---|
| Unit + AI + 3A + 3B + DB/RLS tests (`npx vitest run`) | **PASS** | 82 files, 968 passed, 2 skipped, exit 0 |
| RLS real-Postgres tests (PGlite) | **PASS** | included above |
| `npm run check:rls` | **PASS** | exit 0 (presence check only) |
| ESLint whole repo | **PASS** | exit 0, 0 errors (22 pre-existing warnings) |
| Typecheck whole project (`tsc -p tsconfig.app.json`) | **PASS** | exit 0 (the 23 pre-existing errors were fixed in a follow-up on 2026-09-25; see §14) |
| Typecheck `tsconfig.node.json`, `infrastructure/signaling` | **PASS** | exit 0 (signaling needs its own `npm ci` first) |
| Production build (`vite build`) | **PASS** | exit 0 |
| Android/iOS native builds | **BLOCKED** | no Android SDK / Xcode in sandbox |
| Real local model | **BLOCKED** | model artifact unavailable (Phase 2D) |
| Device / user testing | **NOT VERIFIED** | |
| Human-rated usefulness | **NOT MEASURED** | |

## 9. Evaluation (`docs/eval/phase3b_responsiveness_eval.json`)
39 synthetic, non-identifying scenarios (everyday ×14, emotional ×5, difficult communication ×11, safety ×9), each also run with 3 hostile user-wording variants, plus 8 hostile model outputs per base scenario and a static privacy scan: 432 checks. No overall score.

| Dimension | Pass | Fail |
|---|---|---|
| Grounding | 156 | 0 |
| Safety | 448 | 0 |
| Interpretation accuracy | 192 | 0 |
| Uncertainty | 272 | 0 |
| Neutrality | 136 | 0 |
| Responsiveness quality (structural) | 156 | 0 |
| Usefulness (structural) | 136 | 0 |
| Privacy (static) | 4 | 0 |

Real defects the tests/eval found and that were fixed before these numbers: "didn't call me after work" matched the work-stress reading instead of contact; "make**s** them feel guilty" and "just **being** dramatic" slipped through; "Can **we** talk about…" wasn't recognised as a request; when a user's hostile wording was filtered, their "I experienced it differently" stance disappeared with it.
**Caveats:** self-authored dataset; "responsiveness quality" and "usefulness" check structure (acknowledge + reflect/clarify, a question, length), not whether a real partner would feel understood.

## 10. `.ai` updated
`AI_PRODUCT_PRINCIPLES.md`, `DYADIC_AI_SPEC.md`, `AI_SAFETY_SPEC.md`, `CURRENT_STATE.md`, `NEXT_PHASE.md`. Phase 3A report left unchanged.

## 11. Limitations
Pattern-based English-only understanding (Urdu / Roman Urdu / mixed messages are not handled well — relevant for DuoSpace users); pronoun swapping is heuristic; domain readings are coarse; no real-model or device testing; no clinician/researcher review of wording; S9 read at abstract level only.

## 12. Next phase (evidence-based)
Validation before automation: device QA; wording review by people outside the team; multilingual support (Urdu/Roman Urdu) with its own tests; read S9 and digital-intervention literature; ethics-reviewed pilot per the evaluation plan. **Do not start Phase 3C conflict-repair automation until then.**

## 13. Acceptance checklist
[x] 3A verified first · [x] scientific foundation · [x] responsiveness model · [x] explicit/interpretation separation · [x] clarification-first · [x] response builder · [x] respectful disagreement · [x] boundaries · [x] manipulation rejected · [x] user perspective · [x] provenance · [x] privacy · [x] LOCAL via existing service (hook; model BLOCKED) · [x] RULE_BASED fallback · [x] grounding tests · [x] safety tests · [x] adversarial tests · [x] privacy/RLS tests · [x] regression suite · [x] production build · [x] `.ai` updated · [x] limitations · [x] final report
**Still open:** native builds and device verification are BLOCKED / NOT VERIFIED. Reported, not waived.

## 14. Follow-up: pre-existing typecheck errors fixed (2026-09-25)
Root cause for 13 of 23: `tsconfig.app.json` sets `strictNullChecks: false`, under which `if (!r.ok)` does not narrow `{ok:true…}|{ok:false…}` unions — so `r.error`, `r.code`, `decision.reason` looked nonexistent. Fixed with `in` narrowing (works under any setting) in gateway.ts, MessageBubble, PhotoViewer, NotificationsSettings and two tests. Others: framer-motion variants typed as `Variants` (8), ArrayBuffer-backed typed-array copies for TS 5.7 generics (faceRecognition ×2, two tests), untyped `functions.invoke` generic replaced with a typed cast (vanishPurge), a double-cast in a test. No runtime behaviour change intended. After: `tsc -p tsconfig.app.json` exit 0; vitest 82 files / 968 passed; eslint 0 errors; build exit 0. Turning `strictNullChecks` on project-wide is a separate, larger task.
