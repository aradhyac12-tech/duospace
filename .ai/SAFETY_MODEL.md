# Safety Model (canonical, as of Phase 3C)

Layers: Phase 2 prohibited-content patterns (diagnosis, toxicity, cheating/lying, mind-reading, scores, breakup necessity…) → Phase 3A dyadic checks (no scores, outcome prediction, AI authority) → Phase 3B response checks (manipulation, coercion, emotion inference, boundary compliance, dependency) → Phase 3C repair checks (blame, forced reconciliation, unsafe confrontation, surveillance, positivity promises, invented partner words, "you said" without a quote).
Conflict-repair safety gate (repair/machine.ts `checkSafety`): threats/violence, stalking/monitoring, coercion/control, sexual coercion, self-harm threats as control, threats to children/pets, isolation, financial coercion, blackmail, immediate danger. Fails closed; sticky per session; on CONCERN no message, no sharing, no apology/reconciliation/confrontation; neutral guidance + "contact your local emergency number"; exit always available. Pattern-based, English-only, real-world accuracy UNKNOWN — not an abuse assessment.
Adjudication/detection/manipulation requests are never turned into messages.

## Phase 3E (2026-09-25)
One `checkSafety` for Repair, Help-me-respond and memory/agreement sharing; all 12 lexicons always run. Emergency number: shown only when device region = IN (locale `-IN` or India time zone); Kyrgyzstan/unknown → neutral. "saare paise" narrowed (false positive). All non-English safety text NOT_REVIEWED; review pack: docs/NATIVE_LANGUAGE_REVIEW_PACK.md.
