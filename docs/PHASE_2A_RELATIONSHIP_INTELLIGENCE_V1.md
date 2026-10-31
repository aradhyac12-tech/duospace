# Phase 2A — Relationship Intelligence V1

Values Reflection, Expectations, and Communication Reflection: the first
real relationship-AI capability in DuoSpace, built strictly from
explicit user-provided information. This doc covers what it is; see
`docs/PHASE_2A_RELATIONSHIP_INTELLIGENCE_V1_FINAL_REPORT.md` for what
was verified and what wasn't.

## Product purpose

Help a person put their own relationship preferences, expectations, and
a specific communication moment into words — and reflect back what they
provided, in their own terms, with explicit uncertainty. It is not a
relationship diagnosis tool, not a compatibility calculator, and not a
way to learn anything about a partner that the partner hasn't chosen to
share.

## Supported inputs

- **Values**: 30 questions across 15 categories (`.ai/VALUES_SPEC.md`).
  Answered (choice + optional note) / Not sure / Prefer not to answer /
  category skipped.
- **Expectations**: user-written statements, each explicitly typed as
  Preference, Expectation, or Boundary (`.ai/EXPECTATIONS_SPEC.md`) —
  boundary requires a second explicit confirmation.
- **Communication Reflection**: five free-text prompts about one
  interaction ("What happened?" … "What would you want to communicate
  differently next time?"). Analyzed regardless; kept on-device only if
  the user explicitly opts in.

## Prohibited inference

Full list: `.ai/DO_NOT_BUILD.md` (unchanged, still absolute) and the
brief's §8, enforced in `outputValidator.ts`'s `checkRelationshipRules` +
prohibited-claim patterns (tested in `src/test/relationshipSafety.test.ts`).
In one line: the AI may describe what the user reported; it may never
assert anything about the partner's inner state, honesty, or intentions,
never label the relationship as toxic/failing/doomed, never suggest a
breakup, never produce a score of any kind.

## Privacy model

Everything is HIGHLY_SENSITIVE or SENSITIVE, never PRIVATE (the ordinary
app-data default) — see `.ai/DATA_CLASSIFICATION.md`'s Phase 2A table.
Values/expectations/kept-reflections/insights all live device-local
(secureStorage) by default. The only thing that ever reaches a server is
an explicitly shared snapshot.

## Consent model

`RELATIONSHIP_INSIGHTS` (gates every analysis) and `SHARED_INSIGHTS`
(gates every share) — both re-checked at call time via `PrivacyGate`,
never cached as "granted once." Revoking either takes effect on the
very next call. Toggle location: Settings → Privacy & AI Data.

## Provider architecture

`RelationshipAIProvider` interface (`provider.ts`) with three methods
(`analyzeValues`/`analyzeExpectations`/`analyzeCommunicationReflection`),
each taking a minimized input built by a dedicated `buildXInput` helper
— never a userId, never raw stored records, never data behind "prefer
not to answer." One provider is registered (`registry.ts`):
`localRuleProvider` — deterministic, hand-written rules, no model
weights, no network (`isProduction: true`, `kind: "LOCAL_RULE"`, honest
about what it is). A cloud or local-model provider can be added later by
registering a second entry; nothing else in the pipeline, stores, or UI
needs to change.

## Output contract

Standard `AIInsight` (`.ai/AI_OUTPUT_CONTRACT.md`) plus two additive
fields this phase introduced: `evidence` (which of the user's own inputs
produced this — required, never fabricated) and `analysisKind`. A
provider's raw response is parsed defensively
(`parseProviderResponse`) before anything else touches it, then rebuilt
into an `AIInsight` with every identity/classification/consent/expiry
field controlled by the pipeline, never the provider.

## Data lifecycle

Insights expire (180 days for Values/Expectations, 30 days for
Communication Reflection — a single moment shouldn't calcify into a
permanent fact). Corrections (`correctInsight`) never overwrite the
original; `updateLocalInsight` refuses to touch
id/userId/createdAt and re-runs the full safety check.

## Sharing model

Private by default. `previewX()` builds the exact payload that will be
sent; `confirmShare()` requires a fresh hash of that exact payload
before sending, so a stale or swapped preview can never be confirmed.
Server-side: `relationship_shares` (RLS'd, one active share per source
item, immutable except `revoked_at`, auto-revoked on partner unlink).
Editing the source item resets it to PRIVATE — a shared snapshot never
silently drifts from what the owner currently believes.

## Tests

`src/test/relationshipSafety.test.ts` — see `.ai/TEST_STATUS.md` for
exact coverage and what's still missing (pipeline/stores/sharing unit
tests, not yet written).

## Known limitations

- Not runtime-verified — no `npm ci`/vitest/build in this sandbox, same
  as every phase before it. Verified by isolated `tsc --noEmit` only.
- `localRuleProvider` is intentionally simple pattern-matching, not a
  language model — it produces a small, fixed set of observations per
  analysis, not open-ended reflection.
- No pipeline/stores/sharing unit tests yet (only the safety validator
  is tested) — deps.ts's injectable seams make this straightforward, just
  not done this pass.
- No cron/sweep for expired `relationship_shares` rows (hidden from the
  recipient via RLS, but not deleted).
- No "compare with your partner" view yet — `relationship_shares` has
  everything a Phase 2B read-side would need.
