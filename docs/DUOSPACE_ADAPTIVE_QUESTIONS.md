# DuoSpace adaptive questions (Phase 3M, Stage 2)

Status: selection logic IMPLEMENTED (src/lib/relationship/compatibility/adaptive.ts). Wording via ADAPTIVE_QUESTION gateway task NOT VERIFIED live.

- One question at a time. The app picks the next dimension (first unknown, fixed order); the model only words the question.
- Stopping rule: ENOUGH_INFORMATION when 6 dimensions have an answer (COVERAGE), after 8 questions in a session (SESSION_LIMIT), or when no unasked dimension remains (NOTHING_LEFT).
- "Not sure" and "prefer not to answer" count as asked, never re-asked in the same session.
- Constants: MIN_DIMENSIONS_COVERED=6, MAX_QUESTIONS_PER_SESSION=8 (tune after Stage 4 evaluation).

## Stage 3 bridge
`nextAdaptiveQuestion()` (compatibility/cloud.ts) calls ADAPTIVE_QUESTION only for wording. If the model returns a different dimension, ENOUGH_INFORMATION, no text, or the call fails, the static VALUE_QUESTIONS prompt for the app-chosen dimension is used. Source is reported as CLOUD_AI or QUESTION_BANK.
