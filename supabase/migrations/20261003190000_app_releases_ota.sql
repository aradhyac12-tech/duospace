-- OTA / in-app update: admin-published APK/IPA releases (v3.22.0).
--
-- Complements (does not replace) public.app_update_config from
-- 20261003100000_admin_console.sql, which stays the link-only "latest / minimum
-- version" notice and is the fallback when no release is published here.
--
-- WHO CAN DO WHAT
--   * Upload / publish / unpublish / delete a release: the ADMIN account only.
--     "Admin" = get_effective_entitlement(auth.uid()) = 'ADMIN' (the same gate as
--     private.assert_admin()), itself pinned to public.admin_allowlist. A
--     FOUNDER/BETA account or an admin's partner is NOT an admin here.
--   * Learn that a published update exists: anyone, including a signed-out app
--     (an update may be exactly what fixes a broken sign-in). Metadata only —
--     never the storage path.
--   * Download the binary: only via the app-release-download edge function,
--     which mints a short-lived signed URL for a PUBLISHED release. The bucket
--     is private and has no anon/public policy.

-- Boolean form of private.assert_admin() for RLS / storage policies, which
-- cannot call a function that raises. Not executable by anon.
CREATE OR REPLACE FUNCTION public.is_app_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND public.get_effective_entitlement(auth.uid()) = 'ADMIN';
$$;
REVOKE ALL ON FUNCTION public.is_app_admin() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.is_app_admin() TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.app_releases (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  platform         text NOT NULL CHECK (platform IN ('android', 'ios')),
  version_name     text NOT NULL CHECK (version_name ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  -- Android versionCode / iOS CFBundleVersion: major*10000+minor*100+patch,
  -- stamped into the native project by scripts/patch-native-permissions.mjs.
  version_code     integer NOT NULL CHECK (version_code > 0),
  release_notes    text NOT NULL DEFAULT '' CHECK (char_length(release_notes) <= 4000),
  mandatory        boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'revoked')),
  file_path        text,
  file_size_bytes  bigint CHECK (file_size_bytes IS NULL OR file_size_bytes > 0),
  sha256           text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  -- iOS only: an App Store / TestFlight link opened instead of an OTA install.
  external_url     text CHECK (external_url IS NULL OR external_url ~ '^https://[^[:space:]]+$'),
  created_by       uuid NOT NULL REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  published_at     timestamptz,
  UNIQUE (platform, version_code),
  CONSTRAINT app_releases_android_needs_file CHECK (platform <> 'android' OR file_path IS NOT NULL),
  CONSTRAINT app_releases_needs_payload CHECK (file_path IS NOT NULL OR external_url IS NOT NULL),
  CONSTRAINT app_releases_file_needs_hash CHECK (file_path IS NULL OR (sha256 IS NOT NULL AND file_size_bytes IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS app_releases_platform_status_code_idx
  ON public.app_releases (platform, status, version_code DESC);

ALTER TABLE public.app_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.app_releases FROM anon;
GRANT SELECT ON TABLE public.app_releases TO authenticated;
GRANT ALL ON TABLE public.app_releases TO service_role;

-- Admin-only read. All writes go through the SECURITY DEFINER RPCs below.
CREATE POLICY "app_releases_admin_select"
  ON public.app_releases FOR SELECT TO authenticated
  USING (public.is_app_admin());

-- Private bucket; every storage operation is admin-only. Object names must be
-- <platform>/<version_code>/<file>.apk|ipa
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('app-releases', 'app-releases', false, 524288000)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "app_releases_objects_admin_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'app-releases' AND public.is_app_admin());

CREATE POLICY "app_releases_objects_admin_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'app-releases' AND public.is_app_admin()
    AND name ~ '^(android|ios)/[0-9]+/[A-Za-z0-9._-]+\.(apk|ipa)$'
  );

CREATE POLICY "app_releases_objects_admin_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'app-releases' AND public.is_app_admin())
  WITH CHECK (
    bucket_id = 'app-releases' AND public.is_app_admin()
    AND name ~ '^(android|ios)/[0-9]+/[A-Za-z0-9._-]+\.(apk|ipa)$'
  );

CREATE POLICY "app_releases_objects_admin_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'app-releases' AND public.is_app_admin());

-- Public read: newest published release newer than the installed build.
CREATE OR REPLACE FUNCTION public.get_latest_app_release(_platform text, _current_code integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.app_releases;
  _mandatory boolean;
BEGIN
  IF _platform NOT IN ('android', 'ios') THEN
    RETURN NULL;
  END IF;

  SELECT * INTO r
  FROM public.app_releases
  WHERE platform = _platform AND status = 'published'
    AND version_code > COALESCE(_current_code, 0)
  ORDER BY version_code DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Mandatory if ANY published release between the installed build and the
  -- latest is flagged mandatory, so a forced release can't be skipped by
  -- jumping past it.
  SELECT EXISTS (
    SELECT 1 FROM public.app_releases
    WHERE platform = _platform AND status = 'published' AND mandatory
      AND version_code > COALESCE(_current_code, 0)
  ) INTO _mandatory;

  RETURN jsonb_build_object(
    'id', r.id,
    'platform', r.platform,
    'version_name', r.version_name,
    'version_code', r.version_code,
    'release_notes', r.release_notes,
    'mandatory', _mandatory,
    'file_size_bytes', r.file_size_bytes,
    'sha256', r.sha256,
    'has_file', r.file_path IS NOT NULL,
    'external_url', r.external_url,
    'published_at', r.published_at
  );
END;
$$;
REVOKE ALL ON FUNCTION public.get_latest_app_release(text, integer) FROM public;
GRANT EXECUTE ON FUNCTION public.get_latest_app_release(text, integer) TO anon, authenticated, service_role;

-- Admin RPCs (gate: private.assert_admin(); every action lands in admin_audit_log).
CREATE OR REPLACE FUNCTION public.admin_create_app_release(
  _platform text, _version_name text, _version_code integer, _release_notes text,
  _mandatory boolean, _file_path text, _sha256 text, _external_url text, _publish boolean
)
RETURNS public.app_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _size bigint;
  _row public.app_releases;
BEGIN
  PERFORM private.assert_admin();

  IF _file_path IS NOT NULL THEN
    IF _file_path !~ ('^' || _platform || '/' || _version_code::text || '/[A-Za-z0-9._-]+\.(apk|ipa)$') THEN
      RAISE EXCEPTION 'file path must be %/%/<name>.apk|ipa', _platform, _version_code;
    END IF;
    IF (_platform = 'android' AND _file_path !~ '\.apk$') OR (_platform = 'ios' AND _file_path !~ '\.ipa$') THEN
      RAISE EXCEPTION 'file extension does not match platform %', _platform;
    END IF;
    -- Size comes from storage, never from the client.
    SELECT (o.metadata ->> 'size')::bigint INTO _size
    FROM storage.objects o
    WHERE o.bucket_id = 'app-releases' AND o.name = _file_path;
    IF _size IS NULL THEN
      RAISE EXCEPTION 'uploaded file not found in storage: %', _file_path;
    END IF;
  END IF;

  INSERT INTO public.app_releases (
    platform, version_name, version_code, release_notes, mandatory, status,
    file_path, file_size_bytes, sha256, external_url, created_by, published_at
  ) VALUES (
    _platform, _version_name, _version_code, COALESCE(_release_notes, ''), COALESCE(_mandatory, false),
    CASE WHEN _publish THEN 'published' ELSE 'draft' END,
    _file_path, _size, lower(_sha256), NULLIF(_external_url, ''), auth.uid(),
    CASE WHEN _publish THEN now() ELSE NULL END
  )
  RETURNING * INTO _row;

  PERFORM private.admin_log('create_app_release', NULL, jsonb_build_object(
    'platform', _platform, 'version', _version_name, 'published', _publish, 'mandatory', COALESCE(_mandatory, false)));
  RETURN _row;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_create_app_release(text, text, integer, text, boolean, text, text, text, boolean) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_app_release(text, text, integer, text, boolean, text, text, text, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION public.admin_set_app_release_status(_id uuid, _status text)
RETURNS public.app_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.app_releases;
BEGIN
  PERFORM private.assert_admin();
  IF _status NOT IN ('draft', 'published', 'revoked') THEN
    RAISE EXCEPTION 'invalid status %', _status;
  END IF;

  UPDATE public.app_releases
  SET status = _status,
      published_at = CASE WHEN _status = 'published' THEN COALESCE(published_at, now()) ELSE published_at END
  WHERE id = _id
  RETURNING * INTO _row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'release not found';
  END IF;
  PERFORM private.admin_log('set_app_release_status', NULL, jsonb_build_object(
    'platform', _row.platform, 'version', _row.version_name, 'status', _status));
  RETURN _row;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_set_app_release_status(uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_app_release_status(uuid, text) TO authenticated;

-- Row only; the client removes the storage object first (blobs must go through
-- the Storage API). A published release cannot be deleted — unpublish first.
CREATE OR REPLACE FUNCTION public.admin_delete_app_release(_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _row public.app_releases;
BEGIN
  PERFORM private.assert_admin();
  SELECT * INTO _row FROM public.app_releases WHERE id = _id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF _row.status = 'published' THEN
    RAISE EXCEPTION 'unpublish the release before deleting it';
  END IF;
  DELETE FROM public.app_releases WHERE id = _id;
  PERFORM private.admin_log('delete_app_release', NULL, jsonb_build_object(
    'platform', _row.platform, 'version', _row.version_name));
END;
$$;
REVOKE ALL ON FUNCTION public.admin_delete_app_release(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_app_release(uuid) TO authenticated;
