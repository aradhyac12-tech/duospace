-- Audit fix (2026-09-25) for Phase 3D share payloads.
-- 20260925200000 fixed the KEY SET of MEMORY/AGREEMENT payloads but not the
-- shape of each value: `position` could hold any JSON (an unbounded hidden
-- channel), and ids/timestamps/topic were untyped and unbounded. This tightens
-- the value shapes; the key sets are unchanged, so valid client payloads pass.

-- UPGRADE SAFETY (Phase 3E, 2026-09-25): this migration has not been applied
-- to any live database yet. It is made safe for databases that already hold
-- MEMORY/AGREEMENT shares from 20260925200000: live rows that would violate
-- the new shape rules are WITHDRAWN first (the partner can no longer read a
-- possible hidden payload), then the constraints are added NOT VALID so they
-- bind every new/updated row without failing on withdrawn legacy rows.
-- Verified by src/test/db/migrationUpgrade.db.test.ts.

UPDATE public.relationship_shares SET revoked_at = now()
WHERE revoked_at IS NULL AND NOT (
    kind <> 'MEMORY' OR (
      jsonb_typeof(payload -> 'memoryId') = 'string' AND char_length(payload ->> 'memoryId') BETWEEN 1 AND 64
      AND payload ->> 'topic' IN ('planning','time_together','communication','privacy','boundaries','money','social','household','conflict_repair','affection','future_planning','other')
      AND (NOT (payload ? 'lastConfirmedAt') OR (jsonb_typeof(payload -> 'lastConfirmedAt') = 'string' AND char_length(payload ->> 'lastConfirmedAt') <= 40))
      AND (
        NOT (payload ? 'position') OR jsonb_typeof(payload -> 'position') = 'null'
        OR (
          jsonb_typeof(payload -> 'position') = 'object'
          AND ((payload -> 'position') - 'key' - 'value') = '{}'::jsonb
          AND jsonb_typeof(payload #> '{position,key}') = 'string'
          AND (payload #>> '{position,key}') ~ '^[a-z_]{1,40}$'
          AND (payload #>> '{position,value}') IN ('yes','no','sometimes','not_sure')
        )
      )
    )
);

UPDATE public.relationship_shares SET revoked_at = now()
WHERE revoked_at IS NULL AND NOT (
    kind NOT IN ('AGREEMENT', 'AGREEMENT_RESPONSE') OR (
      jsonb_typeof(payload -> 'agreementId') = 'string' AND char_length(payload ->> 'agreementId') BETWEEN 1 AND 64
      AND (kind <> 'AGREEMENT' OR (
        jsonb_typeof(payload -> 'text') = 'string'
        AND payload ->> 'topic' IN ('planning','time_together','communication','privacy','boundaries','money','social','household','conflict_repair','affection','future_planning','other')
        AND (NOT (payload ? 'reviewDate') OR jsonb_typeof(payload -> 'reviewDate') = 'null' OR (jsonb_typeof(payload -> 'reviewDate') = 'string' AND char_length(payload ->> 'reviewDate') <= 40))
      ))
    )
);

ALTER TABLE public.relationship_shares DROP CONSTRAINT IF EXISTS relationship_shares_memory_values_check;
ALTER TABLE public.relationship_shares
  ADD CONSTRAINT relationship_shares_memory_values_check
  CHECK (
    kind <> 'MEMORY' OR (
      jsonb_typeof(payload -> 'memoryId') = 'string' AND char_length(payload ->> 'memoryId') BETWEEN 1 AND 64
      AND payload ->> 'topic' IN ('planning','time_together','communication','privacy','boundaries','money','social','household','conflict_repair','affection','future_planning','other')
      AND (NOT (payload ? 'lastConfirmedAt') OR (jsonb_typeof(payload -> 'lastConfirmedAt') = 'string' AND char_length(payload ->> 'lastConfirmedAt') <= 40))
      AND (
        NOT (payload ? 'position') OR jsonb_typeof(payload -> 'position') = 'null'
        OR (
          jsonb_typeof(payload -> 'position') = 'object'
          AND ((payload -> 'position') - 'key' - 'value') = '{}'::jsonb
          AND jsonb_typeof(payload #> '{position,key}') = 'string'
          AND (payload #>> '{position,key}') ~ '^[a-z_]{1,40}$'
          AND (payload #>> '{position,value}') IN ('yes','no','sometimes','not_sure')
        )
      )
    )
  ) NOT VALID;

ALTER TABLE public.relationship_shares DROP CONSTRAINT IF EXISTS relationship_shares_agreement_values_check;
ALTER TABLE public.relationship_shares
  ADD CONSTRAINT relationship_shares_agreement_values_check
  CHECK (
    kind NOT IN ('AGREEMENT', 'AGREEMENT_RESPONSE') OR (
      jsonb_typeof(payload -> 'agreementId') = 'string' AND char_length(payload ->> 'agreementId') BETWEEN 1 AND 64
      AND (kind <> 'AGREEMENT' OR (
        jsonb_typeof(payload -> 'text') = 'string'
        AND payload ->> 'topic' IN ('planning','time_together','communication','privacy','boundaries','money','social','household','conflict_repair','affection','future_planning','other')
        AND (NOT (payload ? 'reviewDate') OR jsonb_typeof(payload -> 'reviewDate') = 'null' OR (jsonb_typeof(payload -> 'reviewDate') = 'string' AND char_length(payload ->> 'reviewDate') <= 40))
      ))
    )
  ) NOT VALID;
