# DuoSpace compatibility model (Phase 3M, Stage 2)

Status: IMPLEMENTED (engine + tests under a stand-in runner). Live provider explanations NOT VERIFIED.

## Dimensions
Exactly 16, replacing the earlier 15-value category set with no mapping layer: communication, relationship_direction, pace, affection, independence, boundaries, trust, conflict, support, quality_time, lifestyle, finances, family, future_planning, intimacy, personal_growth. Client keys are the upper-case form (`ValueCategory`); the AI gateway uses the lower-case form (`DIMENSIONS`). `dimensionId()` / `categoryFromDimension()` convert.
Removed keys: PERSONAL_SPACE (folded into BOUNDARIES), CONFLICT_HANDLING (now CONFLICT), EMOTIONAL_SUPPORT (now SUPPORT). New: RELATIONSHIP_DIRECTION, PACE (2 questions each).

## States (per dimension)
- ALIGNED: at least one comparison, all aligned, none unknown.
- DIFFERENT: at least one different answer. Never means incompatible.
- DISCOVERING: some answers exist but something is unknown, not sure, declined or not shared by the partner.
- INSUFFICIENT_DATA: nothing answered yet.
No score, no percentage, no ranking. Counts exist only as evidence metadata.

## Flow
Existing dyadic comparison (compare.ts) -> `computeCompatibility()` (src/lib/relationship/compatibility/engine.ts) -> optional COMPATIBILITY_EXPLAIN gateway task, which may only word the result; the server guard rejects any change of state.
Basis: BOTH_PARTNERS, ONE_PARTNER (wording "based on what you've shared"), or NONE.

## Known risk
Answers stored under the removed keys are not migrated. Store validators drop unknown categories, so those old answers will need re-answering.

## Stage 3 bridge
`explainCompatibility()` returns nothing from the model when basis is NONE (no call made). A model explanation is accepted only if its basis, clearestDifference and stillDiscovering match the deterministic result; otherwise the honest "Not enough information right now." is returned. No fabricated fallback.
