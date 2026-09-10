-- Applied directly to the live project (jzlpelxwzjjpddqcrtpu) on 2026-08-24
-- via the Supabase MCP connector, during Gallery Phase 5 (Part 19: couple
-- albums). This file exists so source control matches what's live.
--
-- Modeled the same way every other couple-scoped table in this app
-- already is (gallery_items, playlist_songs): an owning row +
-- get_partner_id() for the pair, not a separate "couples" entity that
-- doesn't exist elsewhere in this schema.

CREATE TABLE public.gallery_albums (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) > 0 AND char_length(name) <= 80),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.gallery_albums ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Couple can view their albums" ON public.gallery_albums
  FOR SELECT TO authenticated
  USING (owner_id = auth.uid() OR owner_id = public.get_partner_id(auth.uid()));

CREATE POLICY "Users can create albums" ON public.gallery_albums
  FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());

-- Either partner can rename/delete -- an album is a couple object, unlike
-- a single gallery_items row which stays personally owned.
CREATE POLICY "Couple can update their albums" ON public.gallery_albums
  FOR UPDATE TO authenticated
  USING (owner_id = auth.uid() OR owner_id = public.get_partner_id(auth.uid()));

CREATE POLICY "Couple can delete their albums" ON public.gallery_albums
  FOR DELETE TO authenticated
  USING (owner_id = auth.uid() OR owner_id = public.get_partner_id(auth.uid()));

CREATE TABLE public.gallery_album_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id uuid NOT NULL REFERENCES public.gallery_albums(id) ON DELETE CASCADE,
  gallery_item_id uuid NOT NULL REFERENCES public.gallery_items(id) ON DELETE CASCADE,
  added_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (album_id, gallery_item_id)
);

ALTER TABLE public.gallery_album_items ENABLE ROW LEVEL SECURITY;

-- INSERT additionally requires the referenced gallery_item to actually be
-- visible to the couple -- without that, someone could reference an
-- arbitrary gallery_items.id belonging to a totally unrelated couple's
-- private photo into their own album. Wouldn't leak the photo's bytes
-- (signed URLs + gallery_items SELECT are still couple-scoped separately)
-- but is still a real data-integrity hole worth closing here.
CREATE POLICY "Couple can view their album items" ON public.gallery_album_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.gallery_albums a
      WHERE a.id = album_id
        AND (a.owner_id = auth.uid() OR a.owner_id = public.get_partner_id(auth.uid()))
    )
  );

CREATE POLICY "Couple can add items to their albums" ON public.gallery_album_items
  FOR INSERT TO authenticated
  WITH CHECK (
    added_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.gallery_albums a
      WHERE a.id = album_id
        AND (a.owner_id = auth.uid() OR a.owner_id = public.get_partner_id(auth.uid()))
    )
    AND EXISTS (
      SELECT 1 FROM public.gallery_items gi
      WHERE gi.id = gallery_item_id
        AND (
          gi.owner_id = auth.uid()
          OR (gi.is_shared = true AND gi.owner_id = public.get_partner_id(auth.uid()))
          OR gi.owner_id IN (
            SELECT p.user_id FROM public.profiles p
            WHERE p.gallery_shared = true AND p.user_id = public.get_partner_id(auth.uid())
          )
        )
    )
  );

CREATE POLICY "Couple can remove items from their albums" ON public.gallery_album_items
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.gallery_albums a
      WHERE a.id = album_id
        AND (a.owner_id = auth.uid() OR a.owner_id = public.get_partner_id(auth.uid()))
    )
  );

CREATE INDEX gallery_album_items_album_idx ON public.gallery_album_items (album_id);
CREATE INDEX gallery_album_items_item_idx ON public.gallery_album_items (gallery_item_id);

DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.gallery_albums;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.gallery_album_items;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
