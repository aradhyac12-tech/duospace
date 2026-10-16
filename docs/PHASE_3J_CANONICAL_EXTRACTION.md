# Phase 3J — Canonical conversation extraction (current source of truth, 2026-09-27)

## Baseline found
`duospace-full-project.zip` = 3.18.0 (earlier chat-first work already present) + newer owner changes (calls, billing, surprise, Chat). No `.git` directory → `git status/branch/diff` not available. Before changes: tsc app/node 0; lock-sync 0; vitest 1286 passed / **8 failed** (all in `monetizationAdminAndLifecycle.db.test.ts`).
Those 8 were a **test-harness** gap, not product code: `pgliteHarness.ts` lacked `public.update_updated_at_column()` and the production `profiles` columns `username/display_name/avatar_url` (both read-only-verified in production). Harness updated; no assertion changed; all 44 DB tests pass.

## Architecture
```
message → extractFacts()  (src/lib/relationship/contextual/extract.ts)
            patterns: contextual/patterns.ts (the ONLY message-pattern + domain regexes; leaf module)
        → Extraction { facts[] (exact spans), primaryIntent, domain, ambiguous, safetySignals, confidence, language, provenance ids }
        → shared safety gate (repair/machine.ts checkSafety — English + 12-language lexicons)
        → presentations: QuickReply (responsiveness engine), Understand, Today (contextual/present.ts)
```
Location stays `contextual/` (already in use; the brief allows adapting names).
- **Responsiveness engine** (`responsiveness/engine.ts`): `analyzeMessage` now takes request/feeling/accusation/control/acknowledgement/defensive **and domain + ambiguity** from the extraction. Its remaining regexes are not message interpretation: `SUBJECT_NEXT` (pronoun grammar for reflections) and `MANIPULATIVE_GOAL` (safety check on the *user's own* goal text).
- **Signals** (only those supported by existing rules): REQUEST, QUESTION, FEELING (stated), PAST_EXPECTATION, ACKNOWLEDGEMENT, DEFENSIVE, APOLOGY, BOUNDARY, UNCERTAINTY (clarification), EVENT, ACCUSATION, CONTROL; plus `ambiguous`.
- **Span provenance:** every fact has `span [start,end)` with `text.slice(start,end) === phrase`, and optional `detail` with its own exact `detailSpan`; rule id; source message id.
- **primaryIntent** (deterministic, tested): REQUEST > QUESTION > EXPRESSION (stated feeling) > ACKNOWLEDGEMENT > UNKNOWN. Safety is carried separately in `safetySignals` and always handled first by every consumer.
- **domain:** CONTACT, WORK_STRESS, PLANS, CHORES, SPACE, LISTENING, FAMILY_FRIENDS (first match; request object before whole message) — rules moved verbatim from the engine.

## Consumers
- **QuickReply** — grounded intents; unclear message opens directly in ask-first mode; never sends.
- **Understand** — one grounded sentence; "Why?" shows the exact words + "Based only on what they explicitly said."; primary "Help me reply", or **"Ask them"** when nothing is reliably grounded.
- **Today** — at most one notice from today's partner messages in the local decrypted cache (request > question > stated feeling > clarification > apology, latest wins); safety-flagged messages never become a notice; else **"Nothing needs decoding today."** Only dismissed message ids are stored. The old mood check-in lives under More tools.

## Known limitations
- Imperatives without a request marker ("Call me when you're free.") are not detected by the existing rules → treated as unknown (no invented request).
- Non-English text: only script-independent questions + safety lexicons; otherwise "can't reliably tell". Native-language review NOT done.
- New UI strings go through the existing `tr()` catalog (English source; other languages fall back to English until reviewed).

## Tests (this run)
vitest 116 files / **1330 passed** / 2 skipped / 0 failed (incl. `phase3j.test.ts` span invariant over 18 inputs incl. all required examples, `contextualUi.test.tsx`, `todayInsightUi.test.tsx`). tsc app 0 / node 0; eslint 0 errors / 100 warnings (baseline lint count for this snapshot was not measured separately before changes; previous snapshot was 100); build 0; lock-sync 0; Android deps gate 0; check:rls 0.

## Status: PARTIAL
Code-verified. Device behaviour NOT VERIFIED. Not production-ready (HTTP/auth, devices, calling, notifications, local AI, native review, encryption, iOS remain open).
