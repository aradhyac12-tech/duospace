Expectations — canonical spec. Implementation: `src/lib/relationship/`
(`types.ts`'s `ExpectationType`/`Expectation`, `validation.ts`,
`stores.ts`); UI: `src/pages/Reflection.tsx`'s Expectations tab.

## The three types (brief's exact definitions)

- **Preference** — something the user would like but can reasonably
  compromise on.
- **Expectation** — something the user reasonably expects within the
  relationship.
- **Boundary / non-negotiable** — something the user considers necessary.

## The boundary rule — the one rule this spec exists to make unmissable

`type` is required on every create/update call; nothing defaults to it
and nothing upgrades a preference or expectation into a boundary
automatically. **A boundary can only ever be created by the user's
explicit confirmation.** Concretely: `createExpectation`/
`updateExpectation` (`stores.ts`) call `validateExpectationInput`
(`validation.ts`), which throws `BOUNDARY_NOT_CONFIRMED` unless
`confirmedBoundary === true` is passed — and the UI
(`Reflection.tsx`'s `ExpectationsTab`) only ever sets that flag from a
second, explicit confirmation dialog ("Mark this as a boundary? …Only
you can decide this."), never from the first save tap. There is no AI
path into this field at all — providers return *insights*
(`ProviderInsightDraft`), never expectation items; nothing a provider
outputs can become a stored boundary, preference, or expectation.

## Metadata

`id, category, statement, type, importance, createdAt, updatedAt,
visibility, dataClassification` (brief's exact list) plus `status`
(ACTIVE / ARCHIVED — the brief's "not relevant any more", brief §20's
correction affordance applied to an expectation rather than an insight)
and `shareId`. `importance` is LOW/MEDIUM/HIGH, set by the user, never
inferred.

## Editing

Same rule as Values: any edit (`updateExpectation`,
`setExpectationStatus`) resets `visibility` to PRIVATE. Archiving an
item also force-clears any active share — an item marked "not relevant
anymore" cannot stay visible to a partner as if it still were.

## Classification

See `.ai/DATA_CLASSIFICATION.md`'s Phase 2A table —
`classifyExpectation()` in `classification.ts`: any BOUNDARY, or any
item in Intimacy/Boundaries/Finances/Family, is HIGHLY_SENSITIVE;
everything else is SENSITIVE. Never PRIVATE (the ordinary app-data
default) — this is a deliberate departure documented in
`.ai/DATA_CLASSIFICATION.md`.

## AI analysis

`analyzeExpectations()` sends the provider only category/type/importance
labels via `buildExpectationsInput` — never the free-text `statement`
unless a caller opts in (`includeStatements`, unused today). Archived
items are excluded. The resulting insight can observe patterns ("you
marked 2 items as boundaries") but can never assert that a boundary
exists that the user hasn't explicitly set — see the prohibited-claims
list in `.ai/AI_SAFETY_SPEC.md`.
