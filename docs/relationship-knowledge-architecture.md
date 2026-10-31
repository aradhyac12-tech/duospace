# Relationship Knowledge & Evidence Engine — architecture (Phase 4 foundation)

> Goal: a **traceable, versioned, evidence-aware, deterministic** foundation. Acceptance criterion:
> *"Why did DuoSpace say this?"* is answerable as
> `USER EVIDENCE → NORMALIZED OBSERVATION → RULE → KNOWLEDGE CLAIM → RESEARCH SOURCE`.
>
> This is **not** a claim of scientific validation. See "What is not validated" below.

## Principle

```
RESEARCH SOURCE → STUDY → FINDING → CONSTRUCT → EVIDENCE CLAIM → RULE
        ↓ (human review gate: only `approved` is executable)
OBSERVATION → INFERENCE → RELATIONSHIP STATE → EXPLANATION
                              ↑
              SAFETY OVERRIDE (runs first, can withhold everything)
                              ↓
              optional AI language layer (rephrase only, validated, template fallback)
```

The LLM is never the authority. Authority = approved knowledge + deterministic rules + safety policy.

## Three zones that never mix

| Zone | Tables | Who can read | Who can write |
|---|---|---|---|
| Public knowledge | `rk_sources … rk_rules`, `rk_constructs`, `rk_knowledge_versions` | signed-in users see **approved** rows only; admin sees all | knowledge admin (`is_knowledge_admin()` → `admin_allowlist`) |
| Private evidence | `rk_observations` | the **observer** only | the observer (relationship member) — evidence is immutable |
| System inferences | `rk_inferences` | owner (or `dyad`-visible rows to members) | service role only; rows immutable |

A relationship has no table in DuoSpace (it is the `profiles.partner_id` pair), so
`rk_relationship_key(a,b)` derives a stable id and `rk_is_relationship_member()` checks membership.

## Audit of what already existed (reused, not duplicated)

| Area | Found | Decision |
|---|---|---|
| Relationship lib `src/lib/relationship/*` (values, dyadic compare, repair, memory, responsiveness, compatibility, i18n) | rich, production | **untouched**; new code lives in `relationship/knowledge/` |
| Language detection + Indian-language safety lexicon `relationship/i18n/lang.ts` | script-based, Hinglish, safety LEX | **reused** (`detectLanguage`, `multilingualSafetyCategories`); only Romanized-Marathi detection added |
| English safety patterns `relationship/repair/machine.ts` (`checkSafety`) | fail-closed regex set | **reused** in `normalize.ts` |
| Localised safety copy + India region rule `repair/machine.ts` / `i18n/strings.ts` | reviewed copy | **reused** (`localizedSafetyGuidance`); no new hotline table (could not be verified offline) |
| AI safety `src/lib/ai/outputValidator.ts`, `groundingValidator.ts`, `provenance.ts` | existing validators | left in place; knowledge engine has its own stricter language validator (`aiAdapter.ts`) |
| `ai-gateway` edge function (consent, quota, keys) | only place that talks to providers | **not changed**; the adapter is transport-agnostic (wiring a task type is a follow-up) |
| `ai_insights` table | per-user insight storage | untouched; `rk_inferences` is separate because it adds rule/claim/source provenance |
| Admin: `admin_allowlist`, ADMIN entitlement | single allowlisted admin | **reused** for research admin RPC |
| Tests: `src/test/relationshipSafety.test.ts`, `src/test/dyadic/*`, `docs/ai-eval/*` | present | untouched; new tests in `src/test/relationshipKnowledge/` |
| Neo4j / second DB | none | **not introduced** — relational tables + FKs + JSONB |

## Module map (`src/lib/relationship/knowledge/`)

`types` · `taxonomy` (43 constructs, versioned) · `evidence` (tiers, resolution) · `temporal` (staleness/decay) ·
`dyadic` (A→A, A→B, B→A, B→B, dyad) · `engine` (rule evaluation) · `safety` (override) · `snapshot` (approved-only view) ·
`gapQuestions` (adaptive question) · `normalize` (multilingual) · `explain` + `statements` (contract + approved wording) ·
`provenance` (why-chain, hash-chained log) · `aiAdapter` (subordinate AI) · `ingestion/*` (adapters, dedupe, gates) · `seed/*`.

## What the user sees

Concise statements from approved templates, e.g. *"Your communication rhythms seem different."* No scores, no
"scientific analysis says", no attachment labels. No UI was changed in this phase.

## Not wired yet (honest list)

DB read/write repository, running the engine in the app, the ai-gateway task type, the admin UI, real discovery adapters
(PubMed/OpenAlex/…), and human review of any seed claim. Until then nothing user-facing changes.
