AI safety specification — implementation-level companion to the research
in (if present in your snapshot) `.ai/SCIENTIFIC_FOUNDATION.md` and
`.ai/DO_NOT_BUILD.md`. This file covers the *enforcement mechanism*;
those cover the *evidence*.

## The rule

No AI output may state a conclusion as fact when the evidence doesn't
support it — see `docs/DUOSPACE_SCIENTIFIC_PRODUCT_SPECIFICATION_FINAL_REPORT.md`
(if present in your snapshot) for why: human lie-detection accuracy is
~54% (near chance), facial expressions don't map reliably to discrete
emotions, and no algorithm has been shown to predict relationship
outcomes from self-report data.

## Two-layer enforcement (implemented this phase)

1. **Structural** (`src/lib/ai/types.ts`'s `AIInsight`/`NewAIInsight`):
   there is no field for bare certainty. Every insight requires an
   `uncertainty` string and at least two `possibleExplanations`. A
   well-formed insight object cannot express "definitely" by
   construction.
2. **Pattern-matched** (`src/lib/ai/outputValidator.ts`): a denylist of
   prohibited phrases ("cheating", "lying", "definitely angry", "doesn't
   love you", "relationship will fail", "break up", "toxic", "trust this
   person 100%", "hiding something", "proves deception") checked against
   every free-text field, case-insensitive substring match, not exact
   equality — a generator rephrasing around the exact list is exactly
   what the structural layer above exists to catch instead.

Plus a confidence ceiling per source type
(`SOURCE_CONFIDENCE_CEILING` in `outputValidator.ts`): only
`USER_REPORTED`/`USER_ENTERED` (the person's own words) may claim HIGH
confidence. Any model-derived source (`LOCAL_MODEL`, `LOCAL_RULE`,
`CLOUD_MODEL`, `SHARED_COUPLE_DATA`) is capped at MEDIUM. Raising that
ceiling for a specific feature needs an explicit human review, not a
self-declared exception.

`suggestedAction` may never be phrased as an instruction to the user's
*partner* ("your partner should...", "tell them to...") — every action
this system ever proposes is something the user themselves can do.

## Both layers are tested

`src/test/outputValidator.test.ts` — every prohibited phrase, both
directly and inside a `possibleExplanations` entry; the confidence
ceiling for every source type; the partner-directed-action check;
structural requirements (missing uncertainty, fewer than two
explanations, missing consent reference, missing model version for a
model source).

## What this does NOT cover

No feature currently generates insight text for this validator to check
— it exists as the required checkpoint for whatever the first real
feature turns out to be (see `runLocalProcessor()` in
`../ai/localProcessor.ts`, which calls it automatically so a feature
author can't forget to). The validator itself hasn't been attacked with
adversarial inputs beyond the prohibited-phrase list tested — a
determined generator could likely phrase an unsupported claim in a way
neither layer catches (e.g. "there is strong reason to believe they are
not being fully honest" contains none of the denylisted words). This is
a real limitation of a two-layer-but-still-heuristic approach, not a
solved problem — the structural layer (no field for bare certainty) is
the stronger of the two defenses for exactly this reason.

## Phase 2B (2026-09-23)
- Validator extended to hedged/euphemistic forms (may be hiding / seeing someone else / not telling the truth / keeping secrets / red flag / on purpose / lost interest / feelings faded / time to leave / plural+modal partner-mind verbs "they feel/think/know" / partner emotional state / diagnosis terms).
- Fixed false negatives: "Your partner …" no longer counts as user-attributed; "they don't care" now caught.
- Tests: `src/test/ai/safetyValidator.test.ts` (direct + euphemistic across 15 categories, in observation/explanations/context, plus must-stay-allowed cases); adversarial model outputs in `evaluation.test.ts`. See docs/PHASE_2B_LOCAL_AI_FINAL_REPORT.md.

## Phase 2C (2026-09-23)
Added: conditional-love tests, generalization/typology, overconfident conclusions, hidden blame/imputed motive, coercive/directive advice, fabricated history, probability-framed accusations, prompt-injection echoes. 70 phrases × 3 fields tested; legitimate reflections still accepted. See docs/PHASE_2C_REAL_LOCAL_AI_AND_E2E_ROUTING_REPORT.md.

## Phase 2D (2026-09-23) — safety spec v3
Grounding: generated text may not introduce history, recurrence, frequency or numbers absent from the user's input (input-relative; local-rule-v1 exempt). Models must be evaluated against spec v3 to load. See docs/PHASE_2D_REAL_LOCAL_AI_FINAL_REPORT.md.
