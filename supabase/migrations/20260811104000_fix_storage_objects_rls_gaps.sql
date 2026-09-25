-- ============================================================
-- P1 FIX (Phase 8D — RLS Security Matrix sweep, storage.objects)
--
-- FINDING 1 — stale unscoped UPDATE policy still active:
--   20260406223533_...sql created "Users can update own files":
--     FOR UPDATE TO authenticated
--     USING (bucket_id = ANY(ARRAY['chat-files','gallery','avatars','memories','surprise-assets']))
--   with NO auth.uid()/folder ownership check at all, despite the
--   name. 20260708090207_...sql later created a *differently named*
--   "Users update own files" policy that correctly scopes by
--   (storage.foldername(name))[1] = auth.uid()::text — but because
--   the names differ ("Users can update own files" vs "Users update
--   own files"), no DROP POLICY ever removed the original. Postgres
--   OR's all applicable permissive policies together, so the broad
--   original has remained in force the entire time alongside the
--   correctly-scoped one: any authenticated user has been able to
--   UPDATE the storage.objects row (path/metadata) for ANY object in
--   chat-files, gallery, avatars, or memories — not just their own.
--   This does not expose file contents, but does allow
--   metadata/path tampering against other users' private files
--   (e.g. renaming/moving via the Storage API, which operates
--   through UPDATE on this table).
--   FIX: drop the stale broad policy. The correctly-scoped
--   "Users update own files" policy already covers all legitimate
--   app usage.
--
-- FINDING 2 — surprise-assets INSERT/DELETE have no ownership scope:
--   "Auth users can upload surprise assets" — WITH CHECK (bucket_id
--   = 'surprise-assets') only, no folder/owner check: any
--   authenticated user can write to any path in this bucket.
--   "Users can delete own surprise assets" — USING (bucket_id =
--   'surprise-assets') only, same gap: despite the name, any
--   authenticated user can delete ANY file in this bucket, not just
--   their own.
--   The bucket is intentionally public for SELECT (storage.buckets
--   .public = true, per the 20260511075549 comment "still public for
--   sharing" — unauthenticated recipients need to view a shared
--   surprise), so public read is left unchanged here — that part is
--   INTENTIONAL, not a bug.
--   No client code or edge function under src/ or supabase/functions/
--   references the surprise-assets bucket at all in this snapshot —
--   there is no confirmed current upload/delete call site to
--   validate a path convention against. In the absence of evidence
--   of a different convention, this applies the same per-user-folder
--   pattern already used consistently for every other non-public
--   bucket in this repo (chat-files, gallery, memories, avatars,
--   attachments, backups): (storage.foldername(name))[1] =
--   auth.uid()::text. If a future upload flow for this bucket does
--   NOT place files under the uploader's own folder, this policy
--   will need to be revisited alongside that code — flagged in
--   docs/RLS_SECURITY_MATRIX.md.
-- ============================================================

DROP POLICY IF EXISTS "Users can update own files" ON storage.objects;

DROP POLICY IF EXISTS "Auth users can upload surprise assets" ON storage.objects;
CREATE POLICY "Auth users can upload surprise assets" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'surprise-assets' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "Users can delete own surprise assets" ON storage.objects;
CREATE POLICY "Users can delete own surprise assets" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'surprise-assets' AND (storage.foldername(name))[1] = auth.uid()::text);

-- ============================================================
-- REQUIRES VERIFICATION: if any surprise-asset upload flow exists
-- that this session didn't find (e.g. a future/removed feature, or
-- a code path outside src/ and supabase/functions/), confirm it
-- uploads under `${auth.uid()}/...` before relying on this fix, and
-- check for any pre-existing objects in this bucket NOT under a
-- user-id folder (they would become undeletable by their uploader
-- under this policy and need a one-off manual cleanup/migration).
-- ============================================================
