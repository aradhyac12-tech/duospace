-- OTA: make the update check package- and version-aware (v3.23.1).
--
-- Before: get_latest_app_release compared ONLY the numeric build number, and a
-- release never recorded which app package its file belongs to. If the build
-- number the admin published ever differed from the one stamped inside the
-- installed APK, an up-to-date app kept being offered the same update.
--
-- Now a release is offered only when ALL of these hold:
--   * its package_name equals the installed app's package (when the app sends it)
--   * its build number is greater than the installed build number
--   * its version name (x.y.z) is greater than the installed version name
--     (when the app sends a valid one)
-- Older app builds that still call get_latest_app_release(platform, code)
-- keep working: the two new arguments are optional.

ALTER TABLE public.app_releases
  ADD COLUMN IF NOT EXISTS package_name text NOT NULL DEFAULT 'com.duospace.app';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'app_releases_package_name_format'
  ) THEN
    ALTER TABLE public.app_releases
      ADD CONSTRAINT app_releases_package_name_format
      CHECK (package_name ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$');
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.get_latest_app_release(text, integer);

CREATE OR REPLACE FUNCTION public.get_latest_app_release(
  _platform text,
  _current_code integer,
  _package_name text DEFAULT NULL,
  _current_version text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.app_releases;
  _mandatory boolean;
  _cur int[];
BEGIN
  IF _platform NOT IN ('android', 'ios') THEN
    RETURN NULL;
  END IF;

  -- Only trust a well-formed x.y.z (bounded so the int cast cannot overflow).
  IF _current_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$' THEN
    _cur := string_to_array(_current_version, '.')::int[];
  END IF;

  SELECT * INTO r
  FROM public.app_releases
  WHERE platform = _platform AND status = 'published'
    AND (_package_name IS NULL OR package_name = _package_name)
    AND version_code > COALESCE(_current_code, 0)
    AND (_cur IS NULL OR string_to_array(version_name, '.')::int[] > _cur)
  ORDER BY version_code DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Mandatory if ANY applicable published release between the installed build
  -- and the latest is flagged mandatory, so a forced release can't be skipped.
  SELECT EXISTS (
    SELECT 1 FROM public.app_releases
    WHERE platform = _platform AND status = 'published' AND mandatory
      AND (_package_name IS NULL OR package_name = _package_name)
      AND version_code > COALESCE(_current_code, 0)
      AND (_cur IS NULL OR string_to_array(version_name, '.')::int[] > _cur)
  ) INTO _mandatory;

  RETURN jsonb_build_object(
    'id', r.id,
    'platform', r.platform,
    'package_name', r.package_name,
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
REVOKE ALL ON FUNCTION public.get_latest_app_release(text, integer, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.get_latest_app_release(text, integer, text, text) TO anon, authenticated, service_role;

-- Admin create: record the package the uploaded file belongs to. The extra
-- argument is optional so existing 9-argument callers keep working.
DROP FUNCTION IF EXISTS public.admin_create_app_release(text, text, integer, text, boolean, text, text, text, boolean);

CREATE OR REPLACE FUNCTION public.admin_create_app_release(
  _platform text, _version_name text, _version_code integer, _release_notes text,
  _mandatory boolean, _file_path text, _sha256 text, _external_url text, _publish boolean,
  _package_name text DEFAULT NULL
)
RETURNS public.app_releases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _size bigint;
  _pkg text := COALESCE(NULLIF(btrim(_package_name), ''), 'com.duospace.app');
  _row public.app_releases;
BEGIN
  PERFORM private.assert_admin();

  IF _pkg !~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$' THEN
    RAISE EXCEPTION 'invalid package name %', _pkg;
  END IF;

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
    platform, package_name, version_name, version_code, release_notes, mandatory, status,
    file_path, file_size_bytes, sha256, external_url, created_by, published_at
  ) VALUES (
    _platform, _pkg, _version_name, _version_code, COALESCE(_release_notes, ''), COALESCE(_mandatory, false),
    CASE WHEN _publish THEN 'published' ELSE 'draft' END,
    _file_path, _size, lower(_sha256), NULLIF(_external_url, ''), auth.uid(),
    CASE WHEN _publish THEN now() ELSE NULL END
  )
  RETURNING * INTO _row;

  PERFORM private.admin_log('create_app_release', NULL, jsonb_build_object(
    'platform', _platform, 'package', _pkg, 'version', _version_name, 'published', _publish,
    'mandatory', COALESCE(_mandatory, false)));
  RETURN _row;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_create_app_release(text, text, integer, text, boolean, text, text, text, boolean, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.admin_create_app_release(text, text, integer, text, boolean, text, text, text, boolean, text) TO authenticated;
