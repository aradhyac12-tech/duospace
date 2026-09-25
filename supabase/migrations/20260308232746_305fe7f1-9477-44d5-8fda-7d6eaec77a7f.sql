
-- Create a security definer function to get partner_id without triggering RLS
CREATE OR REPLACE FUNCTION public.get_partner_id(_user_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT partner_id FROM public.profiles WHERE user_id = _user_id LIMIT 1
$$;

-- Fix profiles SELECT policy to avoid infinite recursion
DROP POLICY IF EXISTS "Users can view partner profiles" ON public.profiles;
CREATE POLICY "Users can view partner profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  OR user_id = public.get_partner_id(auth.uid())
);

-- Fix locations SELECT policy
DROP POLICY IF EXISTS "Users can view partner location" ON public.locations;
CREATE POLICY "Users can view partner location"
ON public.locations
FOR SELECT
TO authenticated
USING (
  auth.uid() = user_id
  OR user_id = public.get_partner_id(auth.uid())
);

-- Fix gallery_items SELECT policy
DROP POLICY IF EXISTS "Users can view own gallery" ON public.gallery_items;
CREATE POLICY "Users can view own gallery"
ON public.gallery_items
FOR SELECT
TO authenticated
USING (
  auth.uid() = owner_id
  OR (is_shared = true AND owner_id = public.get_partner_id(auth.uid()))
  OR (owner_id IN (
    SELECT p.user_id FROM public.profiles p
    WHERE p.gallery_shared = true AND p.user_id = public.get_partner_id(auth.uid())
  ))
);
