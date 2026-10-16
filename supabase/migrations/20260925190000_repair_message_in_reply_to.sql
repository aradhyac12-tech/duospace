-- Phase 3C completion — RESPONDED state.
-- A REPAIR_MESSAGE may optionally carry `inReplyTo`: the id (uuid) of the
-- repair message it answers. Still nothing else: no analysis, flags or notes.
ALTER TABLE public.relationship_shares DROP CONSTRAINT IF EXISTS relationship_shares_repair_payload_check;
ALTER TABLE public.relationship_shares
  ADD CONSTRAINT relationship_shares_repair_payload_check
  CHECK (
    kind <> 'REPAIR_MESSAGE'
    OR (
      payload ->> 'kind' = 'REPAIR_MESSAGE'
      AND (payload - 'v' - 'kind' - 'message' - 'inReplyTo') = '{}'::jsonb
      AND jsonb_typeof(payload -> 'message') = 'string'
      AND char_length(payload ->> 'message') BETWEEN 1 AND 2000
      AND (
        NOT (payload ? 'inReplyTo')
        OR (jsonb_typeof(payload -> 'inReplyTo') = 'string'
            AND (payload ->> 'inReplyTo') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      )
    )
  );
