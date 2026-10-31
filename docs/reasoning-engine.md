# Deterministic reasoning engine

Pure function: `runEngine({observations, dyad, stage, now, snapshot, safety?}) → {dimensions, safety}`. No AI, no I/O,
no clock reads, no randomness. Same input → same output (tested).

## Order
1. **Safety** (`safety.ts`). Any state ≠ `none` → every other dimension returns `unknown` with
   `suppressedBecause:"safety_override"`; the safety dimension carries the support statement.
2. **Rules** from the *approved-only* `KnowledgeSnapshot`, filtered by stage/context, sorted by safety priority then key.
3. **Honest fall-through**: `contradictory` / `insufficient_evidence` / `unknown`. No score is ever produced.

## Rule shape (data, not React)
```ts
{ ruleKey, name, description, ruleBasis,            // descriptive_comparison | evidence_claim | safety_policy
  dimension, conditions: [{fact:{party,construct,key}, op, value | other}],
  requiredEvidence:{distinctParties}, excludedEvidence:{states},
  outputState, statementKey, confidencePolicy:{cap,minTier,allowInferred},
  applicableStages, applicableContexts, safetyPriority, claimKeys, limitations, forbiddenInferences, version, status }
```
`party` may be `A | B | DYAD | X | Y`; X/Y are role variables so one rule covers both partners (asymmetric comparisons are
tried both ways and de-duplicated).

## Example
```
IF  X.communication_preferences.rhythm ∈ {frequent_short, infrequent_long}
AND Y.…rhythm ∈ {…}   AND X.…rhythm ≠ Y.…rhythm      (tier ≥ confirmed_partner_report, fresh)
THEN communication = different   (confidence ≤ moderate)
NOT  "emotionally distant", "losing interest", "incompatible"     ← listed in forbiddenInferences
```

## Gates
- A rule runs only if `status = approved` **and** every `claimKey` is an approved claim with ≥1 approved, identifier-
  verified, non-retracted source (`ruleExecutable`). **The shipped snapshot has none** — the engine is inert until humans
  approve (tested).
- Inferred evidence satisfies a condition only when the rule sets `allowInferred` (used once, for "wants space", and
  capped at `low`).
- Rule bases: `descriptive_comparison` compares what people *said* and asserts nothing about meaning (no claim needed);
  `evidence_claim` rules cite claims → sources.

## Hard prohibitions (enforced in code and tests)
No numeric compatibility. No inference of love, lack of love, cheating, emotional distance, narcissism, attachment style,
manipulation, loss of interest, breakup intention or diagnosis (`FORBIDDEN_ATTRIBUTE_KEYS`). No prediction, no causal
language (`aiAdapter.BANNED`).

## Explanation contract
`statement, dimension, state, confidence, evidenceSummary, evidenceSourceType, perspective, limitations, timestamp,
knowledgeVersion, ruleVersion`. Wording comes from `statements.ts` templates.

## Observability
`inferenceLogRecord`: `rule_id, rule_version, knowledge_version, evidence_ids, input_state, output_state, confidence,
timestamp` — ids and structured states only.

## Adaptive questions (`gapQuestions.ts`)
One short question at most, only when (a) the answer would feed an *executable* rule, (b) the fact is missing/stale/
contradictory, (c) not asked recently, (d) daily limit not reached, (e) stage allows it, (f) no safety concern is active.
Score = gain × importance × gap-weight ÷ (burden + privacy) — heuristic.
