-- Cloudinary media foundation (additive; nothing existing is altered or removed).
--
-- Supabase stays the source of truth for identity, ownership, authorization and
-- lifecycle. Cloudinary only holds the bytes (type "authenticated" assets).
--
-- Relationship model: there is NO couples table. Partner access is derived from
-- profiles.partner_id through public.get_partner_id(auth.uid()), exactly like the
-- existing gallery/profile/location policies. No couple_id is introduced.
--
-- Writes: clients get SELECT only. Rows are created by the register-cloudinary-media
-- edge function and changed/deleted by delete-cloudinary-media (both service_role,
-- both after verifying the caller). So "insert a row owned by someone else",
-- "change owner" and "delete someone else's media" are impossible by construction
-- (no INSERT/UPDATE/DELETE policy and no table grant for authenticated).

CREATE TABLE IF NOT EXISTS public.media_assets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope                text NOT NULL CHECK (scope IN ('profile','chat','gallery','memories')),
  media_type           text NOT NULL CHECK (media_type IN ('image','video')),
  resource_type        text NOT NULL CHECK (resource_type IN ('image','video')),
  delivery_type        text NOT NULL DEFAULT 'authenticated' CHECK (delivery_type = 'authenticated'),
  cloudinary_public_id text NOT NULL UNIQUE,
  cloudinary_asset_id  text,
  original_filename    text,
  mime_type            text,
  bytes                bigint,
  width                integer,
  height               integer,
  duration             numeric,
  format               text,
  folder               text,
  status               text NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','deleting','deleted','delete_failed')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  deleted_at           timestamptz
);
COMMENT ON TABLE public.media_assets IS
  'Metadata for Cloudinary-hosted media. No delivery URL is stored: URLs are minted on demand by signed-cloudinary-url after an authorization check.';

CREATE INDEX IF NOT EXISTS media_assets_user_scope_created_idx ON public.media_assets (user_id, scope, created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_created_at_idx ON public.media_assets (created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_status_idx ON public.media_assets (status) WHERE status <> 'active';

DROP TRIGGER IF EXISTS media_assets_set_updated_at ON public.media_assets;
CREATE TRIGGER media_assets_set_updated_at BEFORE UPDATE ON public.media_assets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_assets FROM anon, authenticated;
GRANT SELECT ON public.media_assets TO authenticated;

-- Link columns (nullable, so legacy rows are untouched). Declared before the
-- policy below, which reads gallery_items.media_asset_id.
ALTER TABLE public.messages      ADD COLUMN IF NOT EXISTS media_asset_id uuid REFERENCES public.media_assets(id) ON DELETE SET NULL;
ALTER TABLE public.gallery_items ADD COLUMN IF NOT EXISTS media_asset_id uuid REFERENCES public.media_assets(id) ON DELETE SET NULL;
ALTER TABLE public.memories      ADD COLUMN IF NOT EXISTS media_asset_id uuid REFERENCES public.media_assets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS messages_media_asset_id_idx      ON public.messages (media_asset_id)      WHERE media_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS gallery_items_media_asset_id_idx ON public.gallery_items (media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memories_media_asset_id_idx      ON public.memories (media_asset_id)      WHERE media_asset_id IS NOT NULL;

-- Read: own media, or the linked partner's media where the existing model lets the
-- partner see that kind of content. Gallery media follows gallery_items' own RLS
-- (private/shared toggle): the EXISTS below runs as the caller, so an unshared
-- gallery photo's metadata stays invisible to the partner. Soft-deleted rows are
-- invisible to everyone except service_role.
DROP POLICY IF EXISTS "Read own or partner media assets" ON public.media_assets;
CREATE POLICY "Read own or partner media assets" ON public.media_assets
  FOR SELECT TO authenticated
  USING (
    status <> 'deleted' AND deleted_at IS NULL AND (
      user_id = (SELECT auth.uid())
      OR (
        user_id = public.get_partner_id((SELECT auth.uid()))
        AND (
          scope IN ('profile','chat','memories')
          OR (scope = 'gallery' AND EXISTS (
                SELECT 1 FROM public.gallery_items g WHERE g.media_asset_id = media_assets.id))
        )
      )
    )
  );

-- A row may only reference a media asset owned by the row's own author.
-- SECURITY DEFINER so the check sees the asset regardless of the caller's RLS.
CREATE OR REPLACE FUNCTION public.enforce_media_asset_owner() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE author uuid;
BEGIN
  IF NEW.media_asset_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.media_asset_id IS NOT DISTINCT FROM OLD.media_asset_id THEN RETURN NEW; END IF;
  author := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  IF NOT EXISTS (SELECT 1 FROM public.media_assets m
                 WHERE m.id = NEW.media_asset_id AND m.user_id = author AND m.status = 'active') THEN
    RAISE EXCEPTION 'media_asset_id must reference an active media asset owned by the author';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_media_asset_owner() FROM PUBLIC;

DROP TRIGGER IF EXISTS messages_media_owner ON public.messages;
CREATE TRIGGER messages_media_owner BEFORE INSERT OR UPDATE OF media_asset_id ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_media_asset_owner('sender_id');
DROP TRIGGER IF EXISTS gallery_items_media_owner ON public.gallery_items;
CREATE TRIGGER gallery_items_media_owner BEFORE INSERT OR UPDATE OF media_asset_id ON public.gallery_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_media_asset_owner('owner_id');
DROP TRIGGER IF EXISTS memories_media_owner ON public.memories;
CREATE TRIGGER memories_media_owner BEFORE INSERT OR UPDATE OF media_asset_id ON public.memories
  FOR EACH ROW EXECUTE FUNCTION public.enforce_media_asset_owner('creator_id');

-- Upload intents: the server records every signature it issues. register-cloudinary-media
-- only accepts a public_id that has an unexpired intent from the same user, so a client
-- can never register an arbitrary asset. Unregistered, expired intents are the orphan
-- candidates swept by cleanup-cloudinary-orphans. service_role only (RLS on, no policy).
CREATE TABLE IF NOT EXISTS public.media_upload_intents (
  media_id             uuid PRIMARY KEY,
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope                text NOT NULL CHECK (scope IN ('profile','chat','gallery','memories')),
  resource_type        text NOT NULL CHECK (resource_type IN ('image','video')),
  cloudinary_public_id text NOT NULL UNIQUE,
  max_bytes            bigint NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  registered_at        timestamptz
);
CREATE INDEX IF NOT EXISTS media_upload_intents_user_idx ON public.media_upload_intents (user_id);
CREATE INDEX IF NOT EXISTS media_upload_intents_orphans_idx ON public.media_upload_intents (expires_at) WHERE registered_at IS NULL;
ALTER TABLE public.media_upload_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.media_upload_intents FROM anon, authenticated;
