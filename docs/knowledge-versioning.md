# Knowledge versioning

Three independent version strings (currently `2026.10.0`): `knowledge_version`, `rule_version`, `taxonomy_version`
(`types.ts`, `rk_knowledge_versions`). They change by reviewed data change, **not** by app release.

## Append-only history
- Claims/rules/sources carry `version`, `previous_version_id`, `superseded_by_id`; old rows stay.
- `rk_provenance_log` is append-only (DB trigger blocks UPDATE/DELETE) and each entry is hash-chained
  (`appendProvenance` / `verifyChain`, tamper-*evident*; swap `cyrb53` for SHA-256 server-side).
- Admin status changes go through `rk_set_claim_review_status` (requires `is_knowledge_admin()` and a reason; writes the log).

## Inferences are immutable snapshots
`rk_inferences` stores `rule_id`, `rule_version`, `knowledge_version`, `taxonomy_version`, `observation_ids`, `claim_keys`,
`source_keys`, structured `input_state`. A later research update creates *new* inferences; it never rewrites old ones.

## Publishing a version
1. Claims/rules reviewed → `approved` (gates above).
2. Insert `rk_knowledge_versions` row (`draft`), then set `published`.
3. Build a `KnowledgeSnapshot` from approved rows only (`snapshot.ts`).
4. Mark replaced items `superseded`, never delete.
