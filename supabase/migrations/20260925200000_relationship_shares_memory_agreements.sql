-- Phase 3D — share ONE explicitly chosen memory, an agreement proposal, or a
-- response to one. Each kind allows an exact key set; anything else (history,
-- other memories, AI output, safety state) is rejected by the server.
-- Ownership, partner-only insert, recipient-only read, owner revoke and
-- unlink-revokes-all are unchanged.

ALTER TABLE public.relationship_shares DROP CONSTRAINT IF EXISTS relationship_shares_kind_check;
ALTER TABLE public.relationship_shares
  ADD CONSTRAINT relationship_shares_kind_check
  CHECK (kind IN ('VALUE_ANSWER', 'EXPECTATION', 'INSIGHT', 'REPAIR_MESSAGE', 'MEMORY', 'AGREEMENT', 'AGREEMENT_RESPONSE'));

ALTER TABLE public.relationship_shares DROP CONSTRAINT IF EXISTS relationship_shares_memory_payload_check;
ALTER TABLE public.relationship_shares
  ADD CONSTRAINT relationship_shares_memory_payload_check
  CHECK (
    kind <> 'MEMORY' OR (
      payload ->> 'kind' = 'MEMORY'
      AND (payload - 'v' - 'kind' - 'memoryId' - 'category' - 'topic' - 'statement' - 'position' - 'lastConfirmedAt') = '{}'::jsonb
      AND jsonb_typeof(payload -> 'statement') = 'string'
      AND char_length(payload ->> 'statement') BETWEEN 1 AND 400
      AND payload ->> 'category' IN ('PREFERENCE','BOUNDARY','NEED','AGREEMENT','REPAIR_COMMITMENT','RECURRING_TOPIC','POSITIVE_REPAIR_EVENT','UNRESOLVED_ISSUE','CHANGE')
    )
  );

ALTER TABLE public.relationship_shares DROP CONSTRAINT IF EXISTS relationship_shares_agreement_payload_check;
ALTER TABLE public.relationship_shares
  ADD CONSTRAINT relationship_shares_agreement_payload_check
  CHECK (
    kind <> 'AGREEMENT' OR (
      payload ->> 'kind' = 'AGREEMENT'
      AND (payload - 'v' - 'kind' - 'agreementId' - 'topic' - 'text' - 'reviewDate') = '{}'::jsonb
      AND char_length(payload ->> 'text') BETWEEN 1 AND 400
    )
  );

ALTER TABLE public.relationship_shares DROP CONSTRAINT IF EXISTS relationship_shares_agreement_response_check;
ALTER TABLE public.relationship_shares
  ADD CONSTRAINT relationship_shares_agreement_response_check
  CHECK (
    kind <> 'AGREEMENT_RESPONSE' OR (
      payload ->> 'kind' = 'AGREEMENT_RESPONSE'
      AND (payload - 'v' - 'kind' - 'agreementId' - 'response') = '{}'::jsonb
      AND payload ->> 'response' IN ('ACCEPTED', 'DECLINED')
    )
  );
