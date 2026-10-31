-- ============================================================================
-- Security audit v3.22.9 remediation (additive; no existing migration edited)
--   RLS-001  search_users: exact username/phone match instead of substring
--   RLS-002  stop_sharing: lock both pairing rows up front (canonical order)
--   RLS-003  admin/config tables: idempotently strip write privileges
--   ADM-001  admin_audit_log: append-only (UPDATE/DELETE/TRUNCATE blocked)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- RLS-001 — username enumeration via substring search.
-- Substring ILIKE let any signed-in user walk the username space (3+ chars,
-- 20 rows per call). Partner discovery in this app (Onboarding.tsx,
-- PartnerSettings.tsx) is submit-based and always for ONE known person, so the
-- search is now an exact, case-insensitive username match or an exact phone
-- match. 3-char minimum, 20/60s rate limit and the self-exclusion are kept.
-- (Restricting to existing contacts, as the audit suggested, would make it
-- impossible to find a new partner, so exact match is used instead.)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_users(search_term text)
RETURNS TABLE(user_id uuid, display_name text, username text, avatar_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_term text := trim(coalesce(search_term, ''));
  v_is_phone_like boolean := v_term ~ '^[0-9+][0-9+\-\s()]{4,}$';
BEGIN
  IF (v_is_phone_like AND length(v_term) < 5) OR (NOT v_is_phone_like AND length(v_term) < 3) THEN
    RETURN;
  END IF;

  IF auth.uid() IS NOT NULL AND NOT public.consume_rate_limit(auth.uid(), 'search_users', 20, 60) THEN
    RAISE EXCEPTION 'Too many searches — please wait a moment and try again.';
  END IF;

  RETURN QUERY
  SELECT p.user_id, p.display_name, p.username, p.avatar_url
  FROM public.profiles p
  WHERE (lower(p.username) = lower(v_term) OR p.phone_number = v_term)
    AND p.user_id != auth.uid()
  LIMIT 20;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.search_users(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.search_users(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- RLS-002 — stop_sharing() mutated the caller's rows before taking the pair
-- lock inside private.schedule_unlink_core(). Take both profile locks first,
-- in user_id order (the same order apply_unlink / schedule_unlink_core use, so
-- no deadlock), then run the unchanged body of 20261003160000.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stop_sharing()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_partner uuid;
  v_stopped timestamptz;
  v_unlink  jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;

  -- Before ANY side effect.
  IF NOT private.has_recent_auth(300) THEN
    RETURN jsonb_build_object('error', 'REAUTH_REQUIRED');
  END IF;

  -- RLS-002: serialize against a concurrent unlink/accept/relink of this pair.
  SELECT partner_id INTO v_partner FROM public.profiles WHERE user_id = v_uid;
  IF v_partner IS NOT NULL THEN
    PERFORM 1 FROM public.profiles WHERE user_id IN (v_uid, v_partner) ORDER BY user_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM public.profiles WHERE user_id = v_uid FOR UPDATE;
  END IF;

  INSERT INTO public.sharing_state (user_id) VALUES (v_uid)
    ON CONFLICT (user_id) DO NOTHING;
  SELECT stopped_at INTO v_stopped FROM public.sharing_state WHERE user_id = v_uid;

  DELETE FROM public.locations WHERE user_id = v_uid;

  UPDATE public.profiles
     SET battery_level = NULL, battery_charging = NULL,
         ringer_mode = NULL, device_status_updated_at = NULL
   WHERE user_id = v_uid;

  UPDATE public.relationship_shares
     SET revoked_at = now()
   WHERE owner_id = v_uid AND revoked_at IS NULL;

  BEGIN
    UPDATE public.call_history
       SET status = 'cancelled'
     WHERE status = 'in_progress' AND (caller_id = v_uid OR receiver_id = v_uid);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'stop_sharing: could not end live calls: %', SQLERRM;
  END;

  v_unlink := private.schedule_unlink_core();

  IF v_unlink->>'status' = 'executed' OR v_unlink->>'error' = 'NOT_LINKED' THEN
    DELETE FROM public.sharing_state WHERE user_id = v_uid;
  END IF;

  RETURN jsonb_build_object('status', 'stopped', 'stopped_at', v_stopped, 'unlink', v_unlink);
END;
$$;
REVOKE ALL ON FUNCTION public.stop_sharing() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stop_sharing() TO authenticated;

-- ---------------------------------------------------------------------------
-- RLS-003 — privilege drift on admin/config tables. Idempotent: strips every
-- write-capable privilege from anon/authenticated/public. app_releases keeps
-- its narrow SELECT (filtered by its policy). Future drift is caught by
-- src/test/security/adminTableGrants.test.ts (static migration lint).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['app_releases','commission_rates','admin_audit_log','admin_allowlist'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public.%I FROM anon, authenticated, public', t);
      IF t <> 'app_releases' THEN
        EXECUTE format('REVOKE SELECT ON TABLE public.%I FROM anon, authenticated, public', t);
      END IF;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- ADM-001 — admin_audit_log is append-only for EVERY role, including
-- service_role. A superuser can still DROP the trigger; that is a deliberate,
-- visible DDL act rather than a silent DELETE.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION private.admin_audit_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only (% blocked)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
REVOKE ALL ON FUNCTION private.admin_audit_log_immutable() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS admin_audit_log_no_update_delete ON public.admin_audit_log;
CREATE TRIGGER admin_audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON public.admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION private.admin_audit_log_immutable();

DROP TRIGGER IF EXISTS admin_audit_log_no_truncate ON public.admin_audit_log;
CREATE TRIGGER admin_audit_log_no_truncate
  BEFORE TRUNCATE ON public.admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION private.admin_audit_log_immutable();
