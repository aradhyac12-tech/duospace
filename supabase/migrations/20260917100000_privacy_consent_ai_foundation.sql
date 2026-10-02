-- PHASE 1: Privacy, Consent & Local-First Intelligence Foundation.
-- Adds two new tables: user_consents (the server-of-record for
-- .ai/CONSENT_MODEL.md's consent state, read by
-- src/lib/privacy/consent.ts) and ai_insights (storage for the
-- .ai/AI_OUTPUT_CONTRACT.md shape, matching src/lib/ai/types.ts's
-- AIInsight). No relationship-AI feature writes to ai_insights yet — the
-- feature freeze (.ai/DO_NOT_BUILD.md) is still in effect; this is
-- infrastructure for whatever the first real feature turns out to be.
--
-- Security is enforced at this layer, not just in the client
-- (PrivacyGate/outputValidator), per the phase brief's own instruction:
-- "Do not assume frontend filtering is security. Security must exist at
-- the database layer." Two triggers do the DB-layer enforcement:
--   1. enforce_ai_insight_consent — an INSERT into ai_insights must name
--      a consent_reference that is (a) the inserting user's own row,
--      (b) currently granted, not revoked. A client-side PrivacyGate bug
--      or a direct API call cannot bypass this.
--   2. enforce_ai_insight_immutability — after insert, only the
--      lifecycle/expiration/correction/sharing fields may ever change.
--      The observation/confidence/source/etc. an insight was created
--      with are permanent, matching .ai/RELATIONSHIP_MEMORY_SPEC.md's
--      "AI corrections must not silently overwrite the original
--      provenance" rule — a correction is recorded alongside the
--      original, never in place of it.

CREATE TABLE IF NOT EXISTS public.user_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature text NOT NULL,
  granted boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  source text NOT NULL DEFAULT 'unknown',
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, feature)
);

CREATE INDEX IF NOT EXISTS idx_user_consents_user_id ON public.user_consents(user_id);

ALTER TABLE public.user_consents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own consents: select" ON public.user_consents;
CREATE POLICY "own consents: select" ON public.user_consents
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "own consents: insert" ON public.user_consents;
CREATE POLICY "own consents: insert" ON public.user_consents
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "own consents: update" ON public.user_consents;
CREATE POLICY "own consents: update" ON public.user_consents
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- Deliberately no DELETE policy: consent state is an append/upsert
-- (granted -> revoked) audit trail, not something a user erases outright.
-- Revoking is the supported action; see .ai/CONSENT_MODEL.md.

CREATE OR REPLACE FUNCTION public.touch_user_consents_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_user_consents_touch ON public.user_consents;
CREATE TRIGGER on_user_consents_touch
  BEFORE UPDATE ON public.user_consents
  FOR EACH ROW EXECUTE FUNCTION public.touch_user_consents_updated_at();


CREATE TABLE IF NOT EXISTS public.ai_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  feature text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  observation text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('LOW', 'MEDIUM', 'HIGH')),
  uncertainty text NOT NULL,
  context text,
  possible_explanations text[] NOT NULL,
  suggested_action text,

  source text NOT NULL CHECK (source IN ('USER_REPORTED', 'USER_ENTERED', 'LOCAL_MODEL', 'LOCAL_RULE', 'SHARED_COUPLE_DATA', 'CLOUD_MODEL')),
  model_version text,
  data_classification text NOT NULL CHECK (data_classification IN ('PUBLIC', 'PRIVATE', 'COUPLE', 'SENSITIVE', 'HIGHLY_SENSITIVE', 'SECRET', 'DEVICE_ONLY')),
  processing_location text NOT NULL CHECK (processing_location IN ('DEVICE', 'SUPABASE', 'CLOUD_AI')),
  consent_reference uuid NOT NULL REFERENCES public.user_consents(id),

  lifecycle text NOT NULL DEFAULT 'ACTIVE' CHECK (lifecycle IN ('TEMPORARY', 'ACTIVE', 'EXPIRED', 'CORRECTED', 'DELETED')),
  expires_at timestamptz,

  correction jsonb,

  sharing text NOT NULL DEFAULT 'PRIVATE' CHECK (sharing IN ('PRIVATE', 'SHARE_PENDING', 'SHARED', 'REVOKED')),
  shared_with_user_id uuid REFERENCES auth.users(id),
  shared_at timestamptz,

  CONSTRAINT possible_explanations_min_two CHECK (array_length(possible_explanations, 1) >= 2),
  -- DEVICE_ONLY data must never reach this (or any) server table — this
  -- constraint is the DB-layer backstop for privacyGate.ts's
  -- ABSOLUTE_DENY_RULES, in case a future client bug ever tried.
  CONSTRAINT no_device_only_rows CHECK (data_classification <> 'DEVICE_ONLY')
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_user_id ON public.ai_insights(user_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_shared_with ON public.ai_insights(shared_with_user_id) WHERE shared_with_user_id IS NOT NULL;

ALTER TABLE public.ai_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai insights: select own or shared with me" ON public.ai_insights;
CREATE POLICY "ai insights: select own or shared with me" ON public.ai_insights
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR (sharing = 'SHARED' AND shared_with_user_id = auth.uid()));

DROP POLICY IF EXISTS "ai insights: insert own" ON public.ai_insights;
CREATE POLICY "ai insights: insert own" ON public.ai_insights
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "ai insights: update own" ON public.ai_insights;
CREATE POLICY "ai insights: update own" ON public.ai_insights
  FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "ai insights: delete own" ON public.ai_insights;
CREATE POLICY "ai insights: delete own" ON public.ai_insights
  FOR DELETE TO authenticated USING (user_id = auth.uid());

-- Trigger 1: an insight's consent_reference must genuinely belong to the
-- inserting user and be currently granted. Runs as SECURITY DEFINER only
-- to read user_consents cheaply via a direct lookup rather than relying
-- on the inserting session's own RLS on that table (which would already
-- allow it, since "own consents: select" covers this case — DEFINER is
-- used here for a stable, explicit check rather than as a privilege
-- escalation; the WHERE clause below still requires the row to match the
-- inserting user_id).
CREATE OR REPLACE FUNCTION public.enforce_ai_insight_consent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.user_consents
    WHERE id = NEW.consent_reference
      AND user_id = NEW.user_id
      AND granted = true
      AND revoked_at IS NULL
  ) INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'ai_insights.consent_reference must be a currently-granted consent belonging to the same user';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_ai_insights_check_consent ON public.ai_insights;
CREATE TRIGGER on_ai_insights_check_consent
  BEFORE INSERT ON public.ai_insights
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ai_insight_consent();

-- Trigger 2: immutability of the insight's substantive content after
-- creation. Only lifecycle, expires_at, correction, sharing,
-- shared_with_user_id, and shared_at may ever change via UPDATE.
CREATE OR REPLACE FUNCTION public.enforce_ai_insight_immutability()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.feature IS DISTINCT FROM OLD.feature
    OR NEW.observation IS DISTINCT FROM OLD.observation
    OR NEW.confidence IS DISTINCT FROM OLD.confidence
    OR NEW.uncertainty IS DISTINCT FROM OLD.uncertainty
    OR NEW.context IS DISTINCT FROM OLD.context
    OR NEW.possible_explanations IS DISTINCT FROM OLD.possible_explanations
    OR NEW.suggested_action IS DISTINCT FROM OLD.suggested_action
    OR NEW.source IS DISTINCT FROM OLD.source
    OR NEW.model_version IS DISTINCT FROM OLD.model_version
    OR NEW.data_classification IS DISTINCT FROM OLD.data_classification
    OR NEW.processing_location IS DISTINCT FROM OLD.processing_location
    OR NEW.consent_reference IS DISTINCT FROM OLD.consent_reference
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'ai_insights: only lifecycle/expires_at/correction/sharing fields may be updated after creation';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS on_ai_insights_enforce_immutability ON public.ai_insights;
CREATE TRIGGER on_ai_insights_enforce_immutability
  BEFORE UPDATE ON public.ai_insights
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ai_insight_immutability();

COMMENT ON TABLE public.user_consents IS 'Server-of-record for feature-specific user consent state. Read by src/lib/privacy/consent.ts. See .ai/CONSENT_MODEL.md.';
COMMENT ON TABLE public.ai_insights IS 'Storage for the AI insight contract (src/lib/ai/types.ts AIInsight). Empty until a real relationship-AI feature ships — see .ai/DO_NOT_BUILD.md for the current feature freeze. See .ai/AI_OUTPUT_CONTRACT.md.';
