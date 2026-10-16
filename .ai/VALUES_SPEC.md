Values Reflection — canonical spec. Implementation: `src/lib/relationship/`
(`types.ts`, `questions.ts`, `classification.ts`, `validation.ts`,
`stores.ts`); UI: `src/pages/Reflection.tsx`'s Values tab.

## What it is

A private questionnaire across 15 categories (`ValueCategory` in
`types.ts`, matching the brief's §3 list exactly: communication,
affection, independence, trust, quality time, personal space, conflict
handling, emotional support, finances, family, future planning,
lifestyle, boundaries, intimacy, personal growth). 30 questions total,
2 per category (`questions.ts`).

## Answer modes

Every question supports exactly the four the brief requires
(`AnswerMode` + `choiceId`):
- **Answered** — a selected option, plus an optional free-text note (never
  required, always separately classified — see `.ai/DATA_CLASSIFICATION.md`).
- **Not sure** — a first-class answer. Retains category-level signal
  ("you weren't sure about Trust") without a choice or note.
- **Prefer not to answer** — retains nothing at all: no choice, no note,
  not even that a note existed. `validateValueAnswerInput()` enforces
  this structurally, not just by UI convention.
- A whole category can be marked "doesn't apply to my relationship"
  (`skippedCategories`) — the brief's "don't assume all categories are
  relevant to every relationship."

## What options look like

No option is worded as healthier, more mature, or more correct than
another (see the comment at the top of `questions.ts`) — these are
different ordinary ways people are, not a graded scale.

## Storage and lifecycle

Device-local only (`secureStorage`, AES-256-GCM — see
`.ai/DATA_CLASSIFICATION.md`'s Phase 2A section for classification).
Editing an answer always resets its `visibility` back to PRIVATE even if
it was previously shared (`updateValueAnswer` in `stores.ts`) — a shared
snapshot must never silently drift from what the owner currently
believes; re-sharing after an edit requires a fresh preview+confirm.

## AI analysis

`analyzeValues()` (`pipeline.ts`) sends the provider only category
labels, question prompts, and selected option labels (`buildValuesInput`
in `provider.ts`) — never the raw free-text note unless a future caller
explicitly opts in via `includeNotes` (nothing does yet). "Prefer not to
answer" items are never included at all. See
`.ai/AI_OUTPUT_CONTRACT.md` and `.ai/AI_SAFETY_SPEC.md` for what the
resulting insight must and must not claim.

## Sharing

Per-answer, explicit, preview-first (`previewValueAnswer`/`confirmShare`
in `sharing.ts`). A shared answer never carries the private note field
unless a future design explicitly adds it (it currently never does —
see the comment in `previewValueAnswer`).
