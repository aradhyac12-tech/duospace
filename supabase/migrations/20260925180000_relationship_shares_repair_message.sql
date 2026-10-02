-- Phase 3C — allow sharing a user-approved repair MESSAGE (and nothing else).
--
-- A REPAIR_MESSAGE share may contain exactly {v, kind, message}: the server
-- rejects any extra key, so private reflection, AI analysis, safety flags or
-- confidence can never ride along — even from a buggy or modified client.
-- Ownership, partner-only insert, recipient-only read, owner revoke and
-- unlink-revokes-all are unchanged (existing policies/triggers apply).

ALTER TABLE public.relationship_shares DROP CONSTRAINT IF EXISTS relationship_shares_kind_check;
ALTER TABLE public.relationship_shares
  ADD CONSTRAINT relationship_shares_kind_check
  CHECK (kind IN ('VALUE_ANSWER', 'EXPECTATION', 'INSIGHT', 'REPAIR_MESSAGE'));

ALTER TABLE public.relationship_shares DROP CONSTRAINT IF EXISTS relationship_shares_repair_payload_check;
ALTER TABLE public.relationship_shares
  ADD CONSTRAINT relationship_shares_repair_payload_check
  CHECK (
    kind <> 'REPAIR_MESSAGE'
    OR (
      payload ->> 'kind' = 'REPAIR_MESSAGE'
      AND (payload - 'v' - 'kind' - 'message') = '{}'::jsonb
      AND jsonb_typeof(payload -> 'message') = 'string'
      AND char_length(payload ->> 'message') BETWEEN 1 AND 2000
    )
  );
