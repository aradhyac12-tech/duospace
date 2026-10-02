-- Applied directly to the live project (jzlpelxwzjjpddqcrtpu) on 2026-08-24
-- via the Supabase MCP connector, during Gallery Phase 5 (Part 20:
-- favorites). This file exists so source control matches what's live.
--
-- Shared couple favorites -- the brief's own stated default -- one
-- is_favorite boolean on gallery_items, not a per-user favorites table.

ALTER TABLE public.gallery_items
  ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false;

-- The existing owner-only UPDATE policy correctly protects file_url/
-- is_shared/etc, but also blocks a partner from ever favoriting a shared
-- item. Rather than widen that policy wholesale (which would let a
-- partner change ANY column on someone else's row), this adds a second,
-- narrower UPDATE policy scoped to partner + item-visibility, plus a
-- trigger rejecting a non-owner update that touches anything besides
-- is_favorite.
CREATE POLICY "Partner can favorite shared gallery items" ON public.gallery_items
  FOR UPDATE TO authenticated
  USING (
    owner_id = public.get_partner_id(auth.uid())
    AND (
      is_shared = true
      OR EXISTS (
        SELECT 1 FROM public.profiles p
        WHERE p.user_id = owner_id AND p.gallery_shared = true AND p.user_id = public.get_partner_id(auth.uid())
      )
    )
  )
  WITH CHECK (
    owner_id = public.get_partner_id(auth.uid())
  );

CREATE OR REPLACE FUNCTION public.enforce_gallery_favorite_only_for_non_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS DISTINCT FROM OLD.owner_id THEN
    IF NEW.file_url IS DISTINCT FROM OLD.file_url
       OR NEW.file_type IS DISTINCT FROM OLD.file_type
       OR NEW.is_shared IS DISTINCT FROM OLD.is_shared
       OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'Only is_favorite may be changed on a gallery item you do not own';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gallery_favorite_only_for_non_owner ON public.gallery_items;
CREATE TRIGGER gallery_favorite_only_for_non_owner
  BEFORE UPDATE ON public.gallery_items
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_gallery_favorite_only_for_non_owner();
