-- Phase 3F (found by the Supabase security linter on the staging project):
-- the immutability trigger function had a role-mutable search_path
-- (lint 0011). Pin it. Logic is unchanged; only the lookup path is fixed.
ALTER FUNCTION public.enforce_relationship_share_immutability() SET search_path = public;
