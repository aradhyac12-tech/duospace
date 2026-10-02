# DuoSpace AI evaluation plan (Phase 3M, Stage 4 — not yet run)

Fixtures live in docs/ai-eval/. Planned suites: grounding (every claim has evidence), state-preservation (explanation never changes a deterministic state), banned claims (no scores, predictions, diagnoses), multilingual (Hindi, Hinglish, Tamil, Bengali, Arabic, English), adaptive stopping, provider comparison before enabling Sarvam specialist routing.
Result vocabulary: IMPLEMENTED / PARTIAL / BLOCKED / NOT VERIFIED only.

## Stage 4 status (PARTIAL; updated 2026-10-02)
Added: docs/ai-eval/adaptive_stopping.json (9 cases + 2 simulations: never repeats a dimension, stops by SESSION_LIMIT / COVERAGE / NOTHING_LEFT, session limit wins over coverage) and docs/ai-eval/grounding.json (UNDERSTAND quotes, numbers, MEMORY_SUGGESTION, FACT_EXTRACTION) with suites in src/test/ai-eval/fixtures.test.ts. 45 cases pass under a stand-in runner (zod stubbed; real vitest NOT run). Grounding uses SCRIPTED model output, so live grounding is still NOT VERIFIED.
Finding: a HARD_BANNED term in ANY FACT_EXTRACTION draft fails the whole call (BANNED_CLAIM) because the guard's up-front scan covers every output string; the per-fact banned check in that branch is unreachable for those terms. Behaviour is safe (rejects more, not less); pinned by a test, not changed.

Runnable fixtures: docs/ai-eval/banned_claims.json, explain_state_preservation.json, compatibility_states.json, exercised by src/test/ai-eval/fixtures.test.ts (18 cases; all pass under a stand-in runner, vitest not run).
Finding: the guard missed "will not last" (only "won't last" was covered). Fixed in supabase/functions/_shared/ai/guard.ts; the 'will|won't|will not|not going to|...' pattern is deliberately narrow to avoid blocking "will end at 4 pm".
NOT YET COVERED: multilingual banned-claim cases (Hindi, Hinglish, Tamil, Bengali, Arabic) are not in the fixtures, because the guard's non-English patterns need native-speaker review first; grounding fixtures with real model output; provider comparison (needs live keys).
