
-- Relax user_id: anon_signup QRs are minted before an account exists.
ALTER TABLE public.qr_pairing_tokens
  ALTER COLUMN user_id DROP NOT NULL;

-- Extend token_type enum with 'anon_signup'.
ALTER TABLE public.qr_pairing_tokens
  DROP CONSTRAINT IF EXISTS qr_pairing_tokens_token_type_check;
ALTER TABLE public.qr_pairing_tokens
  ADD CONSTRAINT qr_pairing_tokens_token_type_check
  CHECK (token_type IN ('device_pairing','signup_invite','anon_signup'));

-- Who scanned the QR and, for anon_signup, which user should auto-link once
-- that pending account is created. Both nullable, populated after redeem.
ALTER TABLE public.qr_pairing_tokens
  ADD COLUMN IF NOT EXISTS redeemed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pending_partner_for uuid REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS qr_pairing_tokens_pending_partner_idx
  ON public.qr_pairing_tokens (pending_partner_for)
  WHERE pending_partner_for IS NOT NULL;

-- Helper: link two users as partners atomically. SECURITY DEFINER so edge
-- functions running with the service role (or a signed-in user completing
-- signup) can call it without needing to touch profiles directly.
CREATE OR REPLACE FUNCTION public.link_partners(_a uuid, _b uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF _a IS NULL OR _b IS NULL OR _a = _b THEN
    RAISE EXCEPTION 'Invalid partner ids';
  END IF;
  -- Clear any stale links on either side first.
  UPDATE public.profiles SET partner_id = NULL
    WHERE user_id IN (_a, _b)
      AND partner_id IS NOT NULL
      AND partner_id NOT IN (_a, _b);
  -- Symmetric link.
  UPDATE public.profiles SET partner_id = _b WHERE user_id = _a;
  UPDATE public.profiles SET partner_id = _a WHERE user_id = _b;
END;
$$;

REVOKE ALL ON FUNCTION public.link_partners(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.link_partners(uuid, uuid) TO service_role, authenticated;

-- Called by a freshly-signed-up user to complete any pending QR partner link.
CREATE OR REPLACE FUNCTION public.complete_qr_pending_link(_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_partner uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND auth.uid() <> _user_id THEN
    RAISE EXCEPTION 'Not allowed';
  END IF;
  SELECT pending_partner_for INTO v_partner
    FROM public.qr_pairing_tokens
   WHERE pending_partner_for IS NOT NULL
     AND redeemed_by_user_id = _user_id
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_partner IS NULL THEN RETURN NULL; END IF;
  PERFORM public.link_partners(_user_id, v_partner);
  UPDATE public.qr_pairing_tokens
     SET pending_partner_for = NULL
   WHERE redeemed_by_user_id = _user_id;
  RETURN v_partner;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_qr_pending_link(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.complete_qr_pending_link(uuid) TO service_role, authenticated;
