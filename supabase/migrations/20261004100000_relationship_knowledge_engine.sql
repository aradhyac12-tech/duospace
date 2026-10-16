-- PHASE 4 — Relationship Knowledge & Evidence Engine (foundation)
--
-- Three strictly separated zones (never mixed in one table):
--   1. PUBLIC KNOWLEDGE   rk_sources … rk_rules      (approved rows readable by signed-in users)
--   2. PRIVATE EVIDENCE   rk_observations            (observer-only)
--   3. SYSTEM INFERENCES  rk_inferences              (owner-only unless service role marks it dyad-visible)
--
-- Reuses: auth.users, profiles.partner_id / get_partner_id(), admin_allowlist.
-- There is no couples table in DuoSpace; a relationship is the mutually linked
-- pair, identified here by rk_relationship_key(a, b).
-- Nothing here stores raw chat text: observations carry structured values and
-- an opaque source_reference only.

-- ───────────────────────── helpers ─────────────────────────

CREATE OR REPLACE FUNCTION public.rk_relationship_key(_a uuid, _b uuid)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE WHEN _a::text < _b::text THEN _a::text || ':' || _b::text ELSE _b::text || ':' || _a::text END
$$;

-- True only for the single allowlisted admin (same source of truth as the
-- entitlements trigger). Research administration piggybacks on it.
CREATE OR REPLACE FUNCTION public.is_knowledge_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users u JOIN public.admin_allowlist a ON a.email = lower(u.email)
    WHERE u.id = auth.uid()
  )
$$;
REVOKE ALL ON FUNCTION public.is_knowledge_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_knowledge_admin() TO authenticated;

CREATE OR REPLACE FUNCTION public.rk_is_relationship_member(_relationship_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL
     AND public.get_partner_id(auth.uid()) IS NOT NULL
     AND _relationship_id = public.rk_relationship_key(auth.uid(), public.get_partner_id(auth.uid()))
$$;
REVOKE ALL ON FUNCTION public.rk_is_relationship_member(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rk_is_relationship_member(text) TO authenticated;

-- ───────────────────────── 1. PUBLIC KNOWLEDGE ─────────────────────────

CREATE TABLE IF NOT EXISTS public.rk_knowledge_versions (
  knowledge_version text PRIMARY KEY,               -- e.g. 2026.10.0
  taxonomy_version  text NOT NULL,
  rule_version      text NOT NULL,
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded')),
  notes             text,
  published_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rk_sources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key          text NOT NULL,                  -- stable slug, e.g. funk-rogge-2007
  version             integer NOT NULL DEFAULT 1,
  source_type         text NOT NULL CHECK (source_type IN (
    'journal_article','systematic_review','meta_analysis','book_chapter','guideline','agency_report','instrument_manual','dataset','preprint','other')),
  title               text NOT NULL,
  authors             jsonb NOT NULL DEFAULT '[]',     -- [{name, orcid?}]
  publication         text,
  publication_year    integer,
  doi                 text,
  pmid                text,
  pmcid               text,
  openalex_id         text,
  semantic_scholar_id text,
  datacite_doi        text,
  orcid_ids           text[] NOT NULL DEFAULT '{}',
  url                 text,
  license             text,
  abstract_available  boolean NOT NULL DEFAULT false,
  full_text_available boolean NOT NULL DEFAULT false,
  full_text_stored    boolean NOT NULL DEFAULT false, -- only ever true when license permits
  retrieved_at        timestamptz,
  last_verified_at    timestamptz,
  identifiers_verified boolean NOT NULL DEFAULT false, -- identifier checked against the registry by a human/adapter
  retraction_status   text NOT NULL DEFAULT 'unknown' CHECK (retraction_status IN ('none_known','unknown','corrected','retracted','expression_of_concern')),
  citation_metadata   jsonb NOT NULL DEFAULT '{}',
  funding_information text,
  conflict_of_interest_information text,
  source_quality      text NOT NULL DEFAULT 'unassessed' CHECK (source_quality IN ('unassessed','low','moderate','high')),
  review_status       text NOT NULL DEFAULT 'discovered' CHECK (review_status IN (
    'discovered','metadata_verified','under_review','evidence_extracted','quality_assessed','approved','rejected','superseded','retracted')),
  previous_version_id uuid REFERENCES public.rk_sources(id),
  superseded_by_id    uuid REFERENCES public.rk_sources(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rk_sources_full_text_license CHECK (NOT full_text_stored OR license IS NOT NULL),
  UNIQUE (source_key, version)
);
-- Identifier-first deduplication (never title-only).
CREATE UNIQUE INDEX IF NOT EXISTS rk_sources_doi_uq  ON public.rk_sources (lower(doi))  WHERE doi  IS NOT NULL AND superseded_by_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rk_sources_pmid_uq ON public.rk_sources (pmid)        WHERE pmid IS NOT NULL AND superseded_by_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rk_sources_pmcid_uq ON public.rk_sources (pmcid)      WHERE pmcid IS NOT NULL AND superseded_by_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rk_sources_openalex_uq ON public.rk_sources (openalex_id) WHERE openalex_id IS NOT NULL AND superseded_by_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rk_sources_s2_uq   ON public.rk_sources (semantic_scholar_id) WHERE semantic_scholar_id IS NOT NULL AND superseded_by_id IS NULL;

CREATE TABLE IF NOT EXISTS public.rk_studies (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id        uuid NOT NULL REFERENCES public.rk_sources(id),
  study_design     text NOT NULL,
  sample_size      integer,
  population       text,
  relationship_type text,
  country          text,
  measures         jsonb NOT NULL DEFAULT '[]',
  limitations      text[] NOT NULL DEFAULT '{}',
  review_status    text NOT NULL DEFAULT 'discovered',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rk_constructs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  construct_id       text NOT NULL,                    -- canonical_name slug
  version            text NOT NULL,                    -- taxonomy version
  canonical_name     text NOT NULL,
  display_name       text NOT NULL,
  definition         text NOT NULL,
  parent_construct_id text,
  aliases            text[] NOT NULL DEFAULT '{}',
  related_constructs text[] NOT NULL DEFAULT '{}',
  opposing_or_distinct_constructs text[] NOT NULL DEFAULT '{}',
  applicable_relationship_stages text[] NOT NULL DEFAULT '{}',
  applicable_contexts text[] NOT NULL DEFAULT '{}',
  measurement_notes  text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated','proposed')),
  UNIQUE (construct_id, version)
);

CREATE TABLE IF NOT EXISTS public.rk_findings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id      uuid NOT NULL REFERENCES public.rk_studies(id),
  construct_ids text[] NOT NULL,
  finding_text  text NOT NULL,                         -- paraphrase, attributed to the study; never LLM-originated
  effect_size   jsonb,
  limitations   text[] NOT NULL DEFAULT '{}',
  extracted_by  text NOT NULL CHECK (extracted_by IN ('human','human_verified_assist')),
  review_status text NOT NULL DEFAULT 'evidence_extracted',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.rk_instruments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id      text NOT NULL,
  version            integer NOT NULL DEFAULT 1,
  name               text NOT NULL,
  abbreviation       text,
  construct_id       text NOT NULL,
  population         text,
  relationship_type  text,
  number_of_items    integer,
  response_format    text,
  scoring_method     text,
  reliability        jsonb NOT NULL DEFAULT '{}',
  validity           jsonb NOT NULL DEFAULT '{}',
  measurement_invariance jsonb NOT NULL DEFAULT '{}',
  responsiveness     jsonb NOT NULL DEFAULT '{}',
  known_limitations  text[] NOT NULL DEFAULT '{}',
  translation_validation jsonb NOT NULL DEFAULT '{}',
  license_status     text NOT NULL DEFAULT 'unknown',
  source_id          uuid REFERENCES public.rk_sources(id),
  doi                text,
  pmid               text,
  cosmin_assessed    boolean NOT NULL DEFAULT false,
  user_facing_authorized boolean NOT NULL DEFAULT false,  -- research asset by default; product decision required
  review_status      text NOT NULL DEFAULT 'discovered',
  UNIQUE (instrument_id, version)
);

CREATE TABLE IF NOT EXISTS public.rk_claims (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_key           text NOT NULL,
  version             integer NOT NULL DEFAULT 1,
  construct_id        text NOT NULL,
  claim_text          text NOT NULL,
  claim_type          text NOT NULL CHECK (claim_type IN ('definition','measurement','association','longitudinal_association','process','methodological','safety_framework')),
  evidence_type       text NOT NULL,
  direction           text CHECK (direction IN ('positive','negative','mixed','none','not_applicable')),
  association_type    text CHECK (association_type IN ('cross_sectional','longitudinal','experimental','qualitative','psychometric','none')),
  causal_claim        boolean NOT NULL DEFAULT false,
  causal_basis        text,                              -- required when causal_claim
  effect_size         jsonb,
  certainty           text NOT NULL DEFAULT 'unknown' CHECK (certainty IN ('very_low','low','moderate','high','unknown')),
  certainty_dimensions jsonb NOT NULL DEFAULT '{}',      -- study_quality, design, sample_size, replication, consistency, directness, precision, risk_of_bias, publication_bias, population_fit, temporal_evidence
  grade_formally_assessed boolean NOT NULL DEFAULT false,
  population          text,
  age_range           text,
  relationship_type   text,
  relationship_stage  text,
  context             text,
  sample_size         integer,
  study_design        text,
  follow_up_duration  text,
  limitations         text[] NOT NULL DEFAULT '{}',
  replication_status  text NOT NULL DEFAULT 'unknown',
  review_status       text NOT NULL DEFAULT 'discovered' CHECK (review_status IN (
    'discovered','metadata_verified','under_review','evidence_extracted','quality_assessed','approved','rejected','superseded','retracted')),
  knowledge_version   text REFERENCES public.rk_knowledge_versions(knowledge_version),
  previous_version_id uuid REFERENCES public.rk_claims(id),
  superseded_by_id    uuid REFERENCES public.rk_claims(id),
  reviewed_by         uuid REFERENCES auth.users(id),
  reviewed_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  -- association != causation: a causal claim must name its basis.
  CONSTRAINT rk_claims_causal_needs_basis CHECK (NOT causal_claim OR (causal_basis IS NOT NULL AND association_type = 'experimental')),
  -- A certainty other than 'unknown' must carry its underlying dimensions; and
  -- approval additionally requires at least one linked source (see trigger).
  CONSTRAINT rk_claims_certainty_has_reasons CHECK (certainty = 'unknown' OR certainty_dimensions <> '{}'::jsonb),
  UNIQUE (claim_key, version)
);

CREATE TABLE IF NOT EXISTS public.rk_claim_sources (
  claim_id   uuid NOT NULL REFERENCES public.rk_claims(id) ON DELETE CASCADE,
  source_id  uuid NOT NULL REFERENCES public.rk_sources(id),
  finding_id uuid REFERENCES public.rk_findings(id),
  PRIMARY KEY (claim_id, source_id)
);

CREATE TABLE IF NOT EXISTS public.rk_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_key         text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  name             text NOT NULL,
  description      text NOT NULL,
  rule_basis       text NOT NULL CHECK (rule_basis IN ('descriptive_comparison','evidence_claim','safety_policy')),
  conditions       jsonb NOT NULL,
  required_evidence jsonb NOT NULL DEFAULT '{}',
  excluded_evidence jsonb NOT NULL DEFAULT '{}',
  dimension        text NOT NULL,
  output_state     text NOT NULL,
  confidence_policy jsonb NOT NULL,
  applicable_stages text[] NOT NULL DEFAULT '{}',
  applicable_contexts text[] NOT NULL DEFAULT '{}',
  safety_priority  integer NOT NULL DEFAULT 0,
  rule_version     text NOT NULL,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','under_review','approved','rejected','superseded')),
  superseded_by_id uuid REFERENCES public.rk_rules(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- A rule that asserts more than a descriptive comparison must cite claims (enforced by trigger below).
  UNIQUE (rule_key, version)
);
CREATE TABLE IF NOT EXISTS public.rk_rule_claims (
  rule_id  uuid NOT NULL REFERENCES public.rk_rules(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES public.rk_claims(id),
  PRIMARY KEY (rule_id, claim_id)
);

-- Only approved knowledge may back an approved rule; evidence_claim rules need ≥1 claim.
CREATE OR REPLACE FUNCTION public.rk_guard_rule_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.status = 'approved' THEN
    IF NEW.rule_basis = 'evidence_claim' AND NOT EXISTS (SELECT 1 FROM public.rk_rule_claims WHERE rule_id = NEW.id) THEN
      RAISE EXCEPTION 'evidence_claim rule % has no linked claims', NEW.rule_key;
    END IF;
    IF EXISTS (SELECT 1 FROM public.rk_rule_claims rc JOIN public.rk_claims c ON c.id = rc.claim_id
               WHERE rc.rule_id = NEW.id AND c.review_status <> 'approved') THEN
      RAISE EXCEPTION 'rule % depends on a claim that is not approved', NEW.rule_key;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rk_rules_guard ON public.rk_rules;
CREATE TRIGGER rk_rules_guard BEFORE INSERT OR UPDATE ON public.rk_rules FOR EACH ROW EXECUTE FUNCTION public.rk_guard_rule_approval();

-- Append-only provenance for knowledge changes (who/when/why/previous version).
CREATE TABLE IF NOT EXISTS public.rk_provenance_log (
  id            bigserial PRIMARY KEY,
  entity_type   text NOT NULL CHECK (entity_type IN ('source','study','finding','construct','instrument','claim','rule','knowledge_version')),
  entity_id     uuid,
  entity_key    text,
  action        text NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  source        text,
  version       text,
  previous_version text,
  change_reason text NOT NULL,
  entry_hash    text                                 -- hash chain written by the service, for tamper evidence
);
CREATE OR REPLACE FUNCTION public.rk_block_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'rk_provenance_log is append-only'; END $$;
DROP TRIGGER IF EXISTS rk_provenance_no_update ON public.rk_provenance_log;
CREATE TRIGGER rk_provenance_no_update BEFORE UPDATE OR DELETE ON public.rk_provenance_log FOR EACH ROW EXECUTE FUNCTION public.rk_block_mutation();

-- Admin review action: single audited entry point for status changes.
CREATE OR REPLACE FUNCTION public.rk_set_claim_review_status(_claim_id uuid, _status text, _reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _old text;
BEGIN
  IF NOT public.is_knowledge_admin() THEN RAISE EXCEPTION 'not authorized'; END IF;
  IF coalesce(btrim(_reason), '') = '' THEN RAISE EXCEPTION 'change reason required'; END IF;
  SELECT review_status INTO _old FROM public.rk_claims WHERE id = _claim_id FOR UPDATE;
  IF _old IS NULL THEN RAISE EXCEPTION 'claim not found'; END IF;
  UPDATE public.rk_claims SET review_status = _status, reviewed_by = auth.uid(), reviewed_at = now(), updated_at = now() WHERE id = _claim_id;
  INSERT INTO public.rk_provenance_log (entity_type, entity_id, action, created_by, source, version, previous_version, change_reason)
  VALUES ('claim', _claim_id, 'review_status_change', auth.uid(), 'admin_rpc', _status, _old, _reason);
END $$;
REVOKE ALL ON FUNCTION public.rk_set_claim_review_status(uuid, text, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.rk_set_claim_review_status(uuid, text, text) TO authenticated;

-- ───────────────────────── 2. PRIVATE USER EVIDENCE ─────────────────────────

CREATE TABLE IF NOT EXISTS public.rk_observations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id  text NOT NULL,
  observer_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  subject_user_id  uuid REFERENCES auth.users(id) ON DELETE CASCADE,   -- NULL = the dyad itself
  target_user_id   uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  construct_id     text NOT NULL,
  attribute_key    text NOT NULL,
  value            jsonb NOT NULL,                  -- structured value, never raw text
  normalized_value text,
  source_type      text NOT NULL CHECK (source_type IN ('self_report','partner_report','observed_pattern','inferred')),
  evidence_tier    text NOT NULL CHECK (evidence_tier IN ('explicit_self_report','confirmed_partner_report','mutually_confirmed','observed_pattern','inferred','unconfirmed_partner_report')),
  source_reference text,                            -- opaque id, never content
  confidence       numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  explicitness     text NOT NULL CHECK (explicitness IN ('explicit','implicit')),
  temporal_scope   text NOT NULL DEFAULT 'current' CHECK (temporal_scope IN ('current','recent','historical','habitual')),
  perspective      text NOT NULL CHECK (perspective IN ('A_to_A','A_to_B','B_to_A','B_to_B','dyad')),
  confirmation_status text NOT NULL DEFAULT 'unconfirmed' CHECK (confirmation_status IN ('unconfirmed','confirmed','disputed','withdrawn')),
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_until      timestamptz,
  observed_at      timestamptz NOT NULL DEFAULT now(),
  last_confirmed_at timestamptz,
  staleness_threshold_days integer,
  confidence_half_life_days integer,
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Inference can never masquerade as explicit evidence.
  CONSTRAINT rk_obs_inferred_not_explicit CHECK (source_type <> 'inferred' OR (explicitness = 'implicit' AND evidence_tier = 'inferred')),
  CONSTRAINT rk_obs_self_report_subject CHECK (source_type <> 'self_report' OR subject_user_id IS NULL OR subject_user_id = observer_user_id),
  CONSTRAINT rk_obs_partner_report_subject CHECK (source_type <> 'partner_report' OR (subject_user_id IS NOT NULL AND subject_user_id <> observer_user_id)),
  CONSTRAINT rk_obs_tier_matches_source CHECK (
    (source_type = 'self_report'      AND evidence_tier IN ('explicit_self_report','mutually_confirmed')) OR
    (source_type = 'partner_report'   AND evidence_tier IN ('unconfirmed_partner_report','confirmed_partner_report','mutually_confirmed')) OR
    (source_type = 'observed_pattern' AND evidence_tier = 'observed_pattern') OR
    (source_type = 'inferred'         AND evidence_tier = 'inferred'))
);
CREATE INDEX IF NOT EXISTS rk_obs_rel_idx ON public.rk_observations (relationship_id, construct_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS rk_obs_observer_idx ON public.rk_observations (observer_user_id);

-- Core evidence fields are immutable: history is never overwritten. A change in
-- value or tier requires a NEW row. Only lifecycle fields may move; and an
-- inferred row can never be edited into a stronger tier.
CREATE OR REPLACE FUNCTION public.rk_guard_observation_update()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.value IS DISTINCT FROM OLD.value OR NEW.evidence_tier IS DISTINCT FROM OLD.evidence_tier
     OR NEW.source_type IS DISTINCT FROM OLD.source_type OR NEW.construct_id IS DISTINCT FROM OLD.construct_id
     OR NEW.attribute_key IS DISTINCT FROM OLD.attribute_key OR NEW.observer_user_id IS DISTINCT FROM OLD.observer_user_id
     OR NEW.subject_user_id IS DISTINCT FROM OLD.subject_user_id OR NEW.observed_at IS DISTINCT FROM OLD.observed_at THEN
    RAISE EXCEPTION 'observation evidence is immutable; insert a new observation instead';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rk_obs_guard ON public.rk_observations;
CREATE TRIGGER rk_obs_guard BEFORE UPDATE ON public.rk_observations FOR EACH ROW EXECUTE FUNCTION public.rk_guard_observation_update();

ALTER TABLE public.rk_observations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rk obs: observer reads own" ON public.rk_observations;
CREATE POLICY "rk obs: observer reads own" ON public.rk_observations FOR SELECT TO authenticated
  USING (observer_user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "rk obs: observer inserts own" ON public.rk_observations;
CREATE POLICY "rk obs: observer inserts own" ON public.rk_observations FOR INSERT TO authenticated
  WITH CHECK (observer_user_id = (SELECT auth.uid()) AND public.rk_is_relationship_member(relationship_id));
DROP POLICY IF EXISTS "rk obs: observer updates own lifecycle" ON public.rk_observations;
CREATE POLICY "rk obs: observer updates own lifecycle" ON public.rk_observations FOR UPDATE TO authenticated
  USING (observer_user_id = (SELECT auth.uid())) WITH CHECK (observer_user_id = (SELECT auth.uid()));
DROP POLICY IF EXISTS "rk obs: observer deletes own" ON public.rk_observations;
CREATE POLICY "rk obs: observer deletes own" ON public.rk_observations FOR DELETE TO authenticated
  USING (observer_user_id = (SELECT auth.uid()));

-- ───────────────────────── 3. SYSTEM INFERENCES ─────────────────────────

CREATE TABLE IF NOT EXISTS public.rk_inferences (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id  text NOT NULL,
  owner_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  dimension        text NOT NULL,
  state            text NOT NULL,
  confidence       text NOT NULL CHECK (confidence IN ('low','moderate','high','unknown')),
  rule_id          text NOT NULL,
  rule_version     text NOT NULL,
  knowledge_version text NOT NULL,
  taxonomy_version text NOT NULL,
  observation_ids  uuid[] NOT NULL DEFAULT '{}',
  claim_keys       text[] NOT NULL DEFAULT '{}',
  source_keys      text[] NOT NULL DEFAULT '{}',
  input_state      jsonb NOT NULL,                  -- structured states only, never raw text
  evidence_source_type text NOT NULL,
  perspective      text NOT NULL,
  limitations      text[] NOT NULL DEFAULT '{}',
  safety_state     text NOT NULL DEFAULT 'none' CHECK (safety_state IN ('none','possible_safety_concern','reported_safety_concern','confirmed_safety_concern','urgent_safety_concern')),
  visibility       text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','dyad')),
  computed_at      timestamptz NOT NULL DEFAULT now(),
  -- Historical inferences are retained and never silently recomputed.
  CONSTRAINT rk_inf_no_raw CHECK (NOT (input_state ? 'raw_text'))
);
CREATE INDEX IF NOT EXISTS rk_inf_rel_idx ON public.rk_inferences (relationship_id, dimension, computed_at DESC);

ALTER TABLE public.rk_inferences ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rk inf: owner reads" ON public.rk_inferences;
CREATE POLICY "rk inf: owner reads" ON public.rk_inferences FOR SELECT TO authenticated
  USING (owner_user_id = (SELECT auth.uid())
         OR (visibility = 'dyad' AND public.rk_is_relationship_member(relationship_id)));
-- Writes: service role only (inference runs server-side / via trusted client path
-- that is added in a later phase). No INSERT/UPDATE/DELETE policy for authenticated.
CREATE OR REPLACE FUNCTION public.rk_block_inference_edit()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN RAISE EXCEPTION 'rk_inferences rows are immutable'; END $$;
DROP TRIGGER IF EXISTS rk_inf_immutable ON public.rk_inferences;
CREATE TRIGGER rk_inf_immutable BEFORE UPDATE ON public.rk_inferences FOR EACH ROW EXECUTE FUNCTION public.rk_block_inference_edit();

-- ───────────────────────── RLS for the public-knowledge zone ─────────────────────────

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rk_knowledge_versions','rk_sources','rk_studies','rk_findings','rk_constructs','rk_instruments','rk_claims','rk_claim_sources','rk_rules','rk_rule_claims','rk_provenance_log']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'rk admin all ' || t, t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_knowledge_admin()) WITH CHECK (public.is_knowledge_admin())', 'rk admin all ' || t, t);
  END LOOP;
END $$;

-- Ordinary signed-in users may read ONLY approved, published knowledge needed to
-- render explanations (constructs, approved claims/rules/sources). Instruments,
-- studies, findings and the provenance log are admin-only.
DROP POLICY IF EXISTS "rk read approved claims" ON public.rk_claims;
CREATE POLICY "rk read approved claims" ON public.rk_claims FOR SELECT TO authenticated USING (review_status = 'approved');
DROP POLICY IF EXISTS "rk read approved rules" ON public.rk_rules;
CREATE POLICY "rk read approved rules" ON public.rk_rules FOR SELECT TO authenticated USING (status = 'approved');
DROP POLICY IF EXISTS "rk read approved sources" ON public.rk_sources;
CREATE POLICY "rk read approved sources" ON public.rk_sources FOR SELECT TO authenticated USING (review_status = 'approved' AND retraction_status <> 'retracted');
DROP POLICY IF EXISTS "rk read active constructs" ON public.rk_constructs;
CREATE POLICY "rk read active constructs" ON public.rk_constructs FOR SELECT TO authenticated USING (status = 'active');
DROP POLICY IF EXISTS "rk read published versions" ON public.rk_knowledge_versions;
CREATE POLICY "rk read published versions" ON public.rk_knowledge_versions FOR SELECT TO authenticated USING (status = 'published');
DROP POLICY IF EXISTS "rk read approved claim sources" ON public.rk_claim_sources;
CREATE POLICY "rk read approved claim sources" ON public.rk_claim_sources FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rk_claims c WHERE c.id = claim_id AND c.review_status = 'approved'));
DROP POLICY IF EXISTS "rk read approved rule claims" ON public.rk_rule_claims;
CREATE POLICY "rk read approved rule claims" ON public.rk_rule_claims FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.rk_rules r WHERE r.id = rule_id AND r.status = 'approved'));

-- Retraction handling: retracting a source demotes every claim that depends only
-- on it (history kept; claims are marked, never deleted).
CREATE OR REPLACE FUNCTION public.rk_on_source_retracted()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.retraction_status = 'retracted' AND OLD.retraction_status IS DISTINCT FROM 'retracted' THEN
    UPDATE public.rk_claims c SET review_status = 'retracted', updated_at = now()
    WHERE c.review_status = 'approved'
      AND EXISTS (SELECT 1 FROM public.rk_claim_sources cs WHERE cs.claim_id = c.id AND cs.source_id = NEW.id)
      AND NOT EXISTS (SELECT 1 FROM public.rk_claim_sources cs2 JOIN public.rk_sources s ON s.id = cs2.source_id
                      WHERE cs2.claim_id = c.id AND cs2.source_id <> NEW.id AND s.retraction_status <> 'retracted' AND s.review_status = 'approved');
    INSERT INTO public.rk_provenance_log (entity_type, entity_id, action, source, change_reason)
    VALUES ('source', NEW.id, 'retracted', 'trigger', 'source marked retracted; dependent single-source claims demoted');
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rk_sources_retraction ON public.rk_sources;
CREATE TRIGGER rk_sources_retraction AFTER UPDATE OF retraction_status ON public.rk_sources FOR EACH ROW EXECUTE FUNCTION public.rk_on_source_retracted();

-- A claim cannot be approved without at least one approved, non-retracted source.
CREATE OR REPLACE FUNCTION public.rk_guard_claim_approval()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.review_status = 'approved' AND NOT EXISTS (
    SELECT 1 FROM public.rk_claim_sources cs JOIN public.rk_sources s ON s.id = cs.source_id
    WHERE cs.claim_id = NEW.id AND s.review_status = 'approved' AND s.retraction_status <> 'retracted' AND s.identifiers_verified
  ) THEN
    RAISE EXCEPTION 'claim % needs at least one approved source with verified identifiers', NEW.claim_key;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rk_claims_guard ON public.rk_claims;
CREATE TRIGGER rk_claims_guard BEFORE INSERT OR UPDATE ON public.rk_claims FOR EACH ROW EXECUTE FUNCTION public.rk_guard_claim_approval();
