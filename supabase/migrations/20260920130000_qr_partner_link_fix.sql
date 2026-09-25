-- QR partner-link fix (2026-09-20)
--
-- ROOT CAUSES (found by reading the repo AND the live function bodies):
--
--  1. Scanning a partner's QR while signed in never linked anyone. The QR
--     shown from Onboarding / Settings is a `signup_invite` token; the old
--     redeem-qr-token only returned { kind: 'signup_invite' } for it and the
--     scanning screen then toasted "Linked ✓" — success copy with no link.
--
--  2. The "finish signup later" path could never work:
--       * complete_qr_pending_link(_user_id) looked for rows where
--         redeemed_by_user_id = _user_id, but redeemed_by_user_id is the
--         SCANNER, while the caller is the ISSUER — so it always found nothing
--         (and if the scanner called it, link_partners(x, x) raised).
--       * Auth.tsx called it right after signUp(); with "Confirm email" on
--         there is no session yet, so the call ran as `anon`, which has no
--         EXECUTE grant — silently swallowed as "auto-link skipped".
--
--  3. SECURITY: link_partners(_a, _b) was SECURITY DEFINER and EXECUTE-able by
--     every authenticated user with arbitrary ids and no ownership check, so
--     any signed-in user could pair or re-pair any two accounts. It also
--     "cleared stale links" by nulling only ONE side, leaving the third
--     party's row pointing at a user who no longer pointed back.
--
-- WHAT THIS MIGRATION DOES
--   * link_partners: refuses to touch anyone who already has a different
--     partner (raises ALREADY_LINKED), locks both rows, is idempotent for an
--     existing pair, and is EXECUTE-able by service_role ONLY. Legitimate
--     callers are the redeem-qr-token edge function (service role) and the
--     claim_qr_partner_link() RPC below (SECURITY DEFINER).
--   * claim_qr_partner_link(_token): the deferred half of the flow. A device
--     that holds the raw QR token and has now signed up / signed in proves
--     possession of it; the function links the caller to the user recorded in
--     qr_pairing_tokens.pending_partner_for. Single use, 48h window.
--   * complete_qr_pending_link: kept (old app builds still reference it) but
--     is now a harmless no-op returning NULL.
--   * qr_pairing_tokens.claimed_by_user_id: marks a token as consumed for
--     linking (also used by check-qr-token-status so the QR-showing device
--     can tell "linked" from "just scanned").
--
-- DEPLOY ORDER: apply this migration FIRST, then deploy the edge functions
-- redeem-qr-token and check-qr-token-status, then ship the app build.
-- Idempotent: safe to run twice.

ALTER TABLE public.qr_pairing_tokens
  ADD COLUMN IF NOT EXISTS claimed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- link_partners — guarded, service-role only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.link_partners(_a uuid, _b uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  IF _a IS NULL OR _b IS NULL OR _a = _b THEN
    RAISE EXCEPTION 'Invalid partner ids';
  END IF;

  -- Lock both rows in a stable order so two simultaneous links can't deadlock
  -- or interleave.
  PERFORM 1 FROM public.profiles WHERE user_id IN (_a, _b) ORDER BY user_id FOR UPDATE;

  SELECT count(*) INTO v_count FROM public.profiles WHERE user_id IN (_a, _b);
  IF v_count <> 2 THEN
    RAISE EXCEPTION 'PROFILE_MISSING';
  END IF;

  -- Never silently steal someone out of an existing pairing.
  IF EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _a AND partner_id IS NOT NULL AND partner_id <> _b)
     OR EXISTS (SELECT 1 FROM public.profiles WHERE user_id = _b AND partner_id IS NOT NULL AND partner_id <> _a) THEN
    RAISE EXCEPTION 'ALREADY_LINKED';
  END IF;

  UPDATE public.profiles SET partner_id = _b WHERE user_id = _a AND partner_id IS DISTINCT FROM _b;
  UPDATE public.profiles SET partner_id = _a WHERE user_id = _b AND partner_id IS DISTINCT FROM _a;
END;
$$;

REVOKE ALL ON FUNCTION public.link_partners(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_partners(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- claim_qr_partner_link — the deferred half of the flow
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_qr_partner_link(_token text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_hash text;
  v_row  public.qr_pairing_tokens%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('error', 'NOT_SIGNED_IN');
  END IF;
  IF _token IS NULL OR length(_token) < 16 OR length(_token) > 128 THEN
    RETURN jsonb_build_object('error', 'INVALID_TOKEN');
  END IF;

  v_hash := encode(sha256(convert_to(_token, 'UTF8')), 'hex');

  SELECT * INTO v_row FROM public.qr_pairing_tokens WHERE token_hash = v_hash FOR UPDATE;

  IF NOT FOUND
     OR v_row.token_type NOT IN ('anon_signup', 'signup_invite')
     OR v_row.redeemed_at IS NULL THEN
    RETURN jsonb_build_object('error', 'NOTHING_TO_LINK');
  END IF;

  IF v_row.redeemed_at < now() - interval '48 hours' THEN
    RETURN jsonb_build_object('error', 'EXPIRED');
  END IF;

  IF v_row.pending_partner_for IS NULL THEN
    -- The scan happened while the scanner was signed out too, so there is
    -- nobody to link to.
    RETURN jsonb_build_object('error', 'NO_PARTNER_SCANNED');
  END IF;

  IF v_row.pending_partner_for = v_uid THEN
    RETURN jsonb_build_object('error', 'SELF');
  END IF;

  IF v_row.claimed_by_user_id IS NOT NULL THEN
    IF v_row.claimed_by_user_id = v_uid THEN
      -- Already done by this same account (e.g. a retried request).
      RETURN jsonb_build_object('success', true, 'partner_id', v_row.pending_partner_for, 'already', true);
    END IF;
    RETURN jsonb_build_object('error', 'ALREADY_CLAIMED');
  END IF;

  BEGIN
    PERFORM public.link_partners(v_uid, v_row.pending_partner_for);
  EXCEPTION WHEN raise_exception THEN
    RETURN jsonb_build_object('error', SQLERRM);
  END;

  UPDATE public.qr_pairing_tokens SET claimed_by_user_id = v_uid WHERE id = v_row.id;

  RETURN jsonb_build_object('success', true, 'partner_id', v_row.pending_partner_for);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_qr_partner_link(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_qr_partner_link(text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- complete_qr_pending_link — superseded; kept so old builds don't 404
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.complete_qr_pending_link(_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Superseded by claim_qr_partner_link(_token). The old lookup could never
  -- match the issuing account; returning NULL keeps old clients harmless.
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_qr_pending_link(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_qr_pending_link(uuid) TO authenticated, service_role;
