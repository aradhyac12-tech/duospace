# Dyadic AI Spec (Phase 3A)

Code: `src/lib/relationship/dyadic/` · entry: `RelationshipAIService.compareWithPartner` · UI: `src/components/relationship/PartnerComparison.tsx` (Insights tab).

## Data model (`dyadic/types.ts`)
`DyadicItem` = kind, key, category, prompt, state (ANSWERED/NOT_SURE/DECLINED), choiceId, statement (owner's words/option label), context (owner's correction note), provenance {source: user_self_report, owner SELF|PARTNER, sharedWithPartner, shareId, confidence: explicit, createdAt, updatedAt}. Nothing is inferred.

## Authorisation
- PARTNER items: only `relationship_shares` rows with recipient = me, owner = my linked partner, not revoked, not expired (RLS enforces recipient; code re-checks all four).
- SELF items: my own on-device store; compared and shown only on my device; never uploaded.
- No new tables; no service-role; no cross-partner channel.

## Comparison (`dyadic/compare.ts`) — deterministic, source of truth
UNKNOWN if: I haven't answered · partner hasn't shared · either NOT_SURE · either declined · either option ambiguous (`flex/depends/varies/mix/mixed/unsure`) · free-text expectations · corrected OUTDATED / COMPARISON_WRONG / NOT_WHAT_I_MEANT. Else same choiceId → ALIGNED, different → DIFFERENT. UNKNOWN is never turned into DIFFERENT.
Staleness: either answer > 180 days old or > 90 days apart → `needsClarification` (shown in unknowns + prompt "Is this still how each of you see it today?").
Corrections (`rel_dyadic_corrections_v1`, encrypted secureStorage): override the result; expire automatically once either answer is updated after them. DONT_SHARE also revokes my share.

## Explanation (`dyadic/explain.ts`)
Rule templates always available (`dyadic-rule-v1`). LOCAL model (only if the provider implements `explainDyadic`) may rephrase comparison / possibilities / prompt / suggestion — never status, evidence or unknowns. Any timeout, throw, malformed or unsafe draft → rule result; rule result failing validation → `INSUFFICIENT_INFORMATION`. No cloud path.
Result separates OBSERVED · COMPARISON · POSSIBLE INTERPRETATIONS (DIFFERENT only, ≥2, hedged) · UNKNOWN (always ≥1) · CONVERSATION PROMPT (a neutral question).

## Validators (all must pass)
STATUS (equals deterministic) · GROUNDING (evidence verbatim; quotes only of stated text; with users' words stripped, no history/frequency term or number from DuoSpace) · SAFETY (Phase 2 prohibited patterns + outcome prediction + "trust me"/authority) · NO_SCORE · STRUCTURE (prompt is a non-accusatory question, unknowns present, hedged possibilities).

## Responsiveness (`dyadic/responsiveness.ts`)
Five self-checks on the user's own draft; quotes only the partner's words; refuses "who is right"/labelling requests. Nothing stored.

## Phase 3B — response support (`src/lib/relationship/responsiveness/`)
Entry: `RelationshipAIService.supportResponse(userId, input, {corrections})` · UI: `src/components/relationship/ResponseSupportPanel.tsx`.
Schema: see `responsiveness/types.ts` (explicit / tentative / unknown kept separate; every claim has `SourceRef`). Components: ACKNOWLEDGE, REFLECT, CLARIFY, OWN, EXPLAIN, REQUEST, BOUNDARY (only when relevant). Clarification-first when ambiguous or no explicit request. Corrections alter the reply, never the evidence.
**Persistence: none.** In memory per screen; no table, no RLS change. LOCAL may only rephrase the reply text (`rephraseResponse`), validated, rule fallback; never cloud.
