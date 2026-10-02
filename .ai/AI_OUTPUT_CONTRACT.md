Canonical AI insight contract. Implementation: `src/lib/ai/types.ts`'s
`AIInsight` interface — treat that file as authoritative; this is the
field-by-field rationale.

| Field | Why |
|---|---|
| `observation` | Specific, falsifiable, described in terms of what was reported — not a labeled conclusion |
| `confidence` | LOW/MEDIUM/HIGH only — never a false-precision percentage. Capped per source type, see `.ai/AI_SAFETY_SPEC.md` |
| `uncertainty` | Required, non-empty. What's unknown or could flip the interpretation |
| `context` | Optional. What context could alter the interpretation (a bad day, external stress) |
| `possibleExplanations` | At least two, one of them mundane/non-relationship |
| `suggestedAction` | Optional, for the *user*, never an instruction directed at their partner |
| `source` | USER_REPORTED / USER_ENTERED / LOCAL_MODEL / LOCAL_RULE / SHARED_COUPLE_DATA / CLOUD_MODEL — never lets an inference masquerade as a user statement |
| `modelVersion` | Required if source is a model — provenance for future calibration |
| `dataClassification` / `processingLocation` | Tie every insight to `.ai/DATA_CLASSIFICATION.md` and `.ai/PRIVACY_MODEL.md` |
| `consentReference` | Which consent record authorized this — DB-enforced, not just convention (see the `enforce_ai_insight_consent` trigger) |
| `lifecycle` | TEMPORARY / ACTIVE / EXPIRED / CORRECTED / DELETED — nothing sensitive lives forever by default |
| `expiresAt` | Nullable — set where appropriate |
| `correction` | `{ verdict, note?, correctedAt }` — a correction is recorded *alongside* the original, never overwriting it (DB-enforced via `enforce_ai_insight_immutability`) |
| `sharing` / `sharedWithUserId` / `sharedAt` | PRIVATE by default; a partner only ever sees an insight the owner explicitly moved to SHARED |

## Validation

`src/lib/ai/outputValidator.ts`'s `validateInsight()`/`assertValidInsight()`
— structural completeness, confidence ceiling, prohibited-phrase scan.
See `.ai/AI_SAFETY_SPEC.md`.

## Storage

`public.ai_insights` (migration `20260917100000_privacy_consent_ai_foundation.sql`).
RLS: owner, plus a partner the insight was explicitly `SHARED` with.
Immutable after creation except for lifecycle/correction/sharing fields.

## Status

Phase 2A (Relationship Reflection) is the first feature to actually
produce these. Two additive, optional fields were added for it —
`evidence: string[]` (concise pointers to which of the user's own inputs
produced the observation, e.g. "Your answers in Communication"; never
chain-of-thought, never fabricated — the provider can only cite strings
from the exact catalog it was given) and `analysisKind` (VALUES /
EXPECTATIONS / COMMUNICATION_REFLECTION). Every other feature's insights
simply omit both. `RELATIONSHIP_INSIGHTS`-feature insights are held to
extra structural rules in `outputValidator.ts` (`checkRelationshipRules`)
on top of everything above — see `.ai/AI_SAFETY_SPEC.md`.

`InsightCorrection.verdict` gained `PARTLY_ACCURATE` and `NOT_RELEVANT`
(Phase 2A's four-way correction UI: accurate / partly accurate / not
accurate / not relevant anymore) alongside the existing `NOT_ACCURATE`/
`CORRECT`/`ADD_CONTEXT`.

Phase 2A's own insights are NOT stored in `public.ai_insights` — see
`.ai/CURRENT_STATE.md`'s Phase 2A note and `.ai/DATA_CLASSIFICATION.md`:
they use the same local `InsightBackend`-based store
(`src/lib/ai/localInsightStore.ts`) but device-only, per the brief's
"prefer local encrypted storage" instruction. The contract above (fields,
validator, immutable-except-correction) is unchanged; only the storage
target differs for this one feature.

## Phase 2B additions (2026-09-23)
- **Confidence semantics:** how directly the USER'S OWN supplied information supports the OBSERVATION (LOW = partial/indirect, MEDIUM = directly stated). Never a probability that a theory about the partner is true. LOCAL_RULE/LOCAL_MODEL/CLOUD_MODEL capped at MEDIUM.
- **Provenance:** every `evidence` entry must be one of the labels in the analysis input's `evidenceCatalog` (enforced in pipeline.ts); anything else = fabricated → insight rejected. Evidence is a label, never a copy of the user's text.
- **Model output:** strict JSON `{"insights":[...]}` with content fields only; the pipeline — never the model — sets id, feature, source, modelVersion, dataClassification, processingLocation, consentReference, createdAt, expiresAt. Invalid → rejected → local-rule-v1 fallback. See docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md.

## Phase 2D (2026-09-23)
OUTPUT_SCHEMA_VERSION = 1 (manifest must match). Grounding added to the acceptance chain. See docs/PHASE_2D_REAL_LOCAL_AI_FINAL_REPORT.md.
