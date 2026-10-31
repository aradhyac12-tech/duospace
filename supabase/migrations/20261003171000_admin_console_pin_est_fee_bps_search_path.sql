-- Linter (function_search_path_mutable): pin search_path on the v3.21.0 helper.
-- It is no longer called (fees now come from private.est_fee_minor + the
-- commission_rates table) but is kept so earlier migrations stay replayable.
ALTER FUNCTION private.est_fee_bps(public.payment_provider) SET search_path = public;
