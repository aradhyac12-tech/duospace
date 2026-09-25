-- FEATURE: private "Surprise library" — saved uploads (zip / html / css / js)
-- the creator can reuse later WITHOUT sending anything to their partner.
--
-- WHY A NEW TABLE (and not code_surprises.is_active = false):
-- code_surprises' SELECT policy is `creator_id = auth.uid() OR creator_id =
-- get_partner_id(auth.uid())` — every row, active or not, is readable by the
-- creator's partner, and fetchSurprisesForConversation() lists inactive rows
-- in the partner's timeline. A "draft" stored there would leak. This table is
-- owner-only end to end: no partner-readable policy exists, on purpose.
--
-- Content is stored exactly like a surprise (html/css/js text; imported media
-- is inlined as data: URIs by src/lib/surpriseImport.ts), so "Use" in the
-- editor is a plain copy of three strings.
--
-- SIZE: html+css+js is capped at 4,500,000 characters, matching
-- SURPRISE_LIMITS.maxSurpriseChars in src/lib/surpriseDocument.ts, so a row
-- can never be larger than what the editor will let anyone send. (This is a
-- NEW table, so the CHECK cannot invalidate existing data. The same cap is
-- enforced client-side on code_surprises; adding it there as a constraint
-- would need a NOT VALID + VALIDATE dance against unknown existing rows and
-- was deliberately left out.)

CREATE TABLE IF NOT EXISTS public.surprise_library (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title         text NOT NULL DEFAULT 'Untitled upload',
  html_content  text NOT NULL DEFAULT '',
  css_content   text NOT NULL DEFAULT '',
  js_content    text NOT NULL DEFAULT '',
  source_type   text NOT NULL DEFAULT 'manual',
  source_name   text,
  asset_count   integer NOT NULL DEFAULT 0,
  byte_size     integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT surprise_library_title_len CHECK (char_length(title) <= 200),
  CONSTRAINT surprise_library_source_type_chk CHECK (source_type IN ('manual', 'html', 'css', 'js', 'zip', 'files')),
  CONSTRAINT surprise_library_size_chk CHECK (
    char_length(html_content) + char_length(css_content) + char_length(js_content) <= 4500000
  )
);

CREATE INDEX IF NOT EXISTS idx_surprise_library_owner_created
  ON public.surprise_library (owner_id, created_at DESC);

ALTER TABLE public.surprise_library ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.surprise_library TO authenticated;
GRANT ALL ON public.surprise_library TO service_role;

-- Owner-only, all four verbs. No partner policy — see header.
DROP POLICY IF EXISTS "surprise library: select own" ON public.surprise_library;
CREATE POLICY "surprise library: select own" ON public.surprise_library
  FOR SELECT TO authenticated USING (owner_id = auth.uid());

DROP POLICY IF EXISTS "surprise library: insert own" ON public.surprise_library;
CREATE POLICY "surprise library: insert own" ON public.surprise_library
  FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());

-- WITH CHECK matters here: without it an owner could UPDATE owner_id to
-- someone else's uid and plant a row in another account's library.
DROP POLICY IF EXISTS "surprise library: update own" ON public.surprise_library;
CREATE POLICY "surprise library: update own" ON public.surprise_library
  FOR UPDATE TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "surprise library: delete own" ON public.surprise_library;
CREATE POLICY "surprise library: delete own" ON public.surprise_library
  FOR DELETE TO authenticated USING (owner_id = auth.uid());

DROP TRIGGER IF EXISTS trg_surprise_library_updated_at ON public.surprise_library;
CREATE TRIGGER trg_surprise_library_updated_at
  BEFORE UPDATE ON public.surprise_library
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.surprise_library IS 'Owner-only saved surprise sources (zip/html/css/js uploads) — see src/lib/surpriseLibrary.ts. Never partner-readable; code_surprises is what gets delivered.';
