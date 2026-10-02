-- Self-hosted calling is now the ONLY provider (Daily removed from the app).
-- Additive and non-destructive:
--   * historical 'daily' rows are kept exactly as they are (history/badges);
--   * the provider CHECK still allows 'daily' so those rows stay valid;
--   * NEW rows default to, and must be, 'self_hosted'.
-- The partner Daily-key columns/RPC from earlier migrations are intentionally
-- NOT dropped here (destructive, and unused by the app since this release);
-- drop them in a separate, reviewed migration once no old client remains.

ALTER TABLE public.call_history
  ALTER COLUMN provider SET DEFAULT 'self_hosted';

CREATE OR REPLACE FUNCTION public.call_history_require_self_hosted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.provider IS DISTINCT FROM 'self_hosted' THEN
    RAISE EXCEPTION 'call_history: provider % is no longer supported (self_hosted only)', NEW.provider
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS call_history_require_self_hosted ON public.call_history;
CREATE TRIGGER call_history_require_self_hosted
  BEFORE INSERT ON public.call_history
  FOR EACH ROW EXECUTE FUNCTION public.call_history_require_self_hosted();

-- Any Daily call still marked live can never be joined again (no Daily code
-- or edge function exists anymore). Close it so busy checks
-- (is_partner_on_call) and history don't report a phantom active call.
UPDATE public.call_history
   SET status = 'failed', ended_reason = COALESCE(ended_reason, 'provider_removed')
 WHERE provider = 'daily' AND status = 'in_progress';
