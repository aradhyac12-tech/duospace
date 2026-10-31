DROP POLICY IF EXISTS "Authenticated users upload to own folder" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users read own or partner files" ON storage.objects;
DROP POLICY IF EXISTS "Users update own files" ON storage.objects;
DROP POLICY IF EXISTS "Users delete own files" ON storage.objects;
DROP POLICY IF EXISTS "avatars public read" ON storage.objects;
DROP POLICY IF EXISTS "avatars owner write" ON storage.objects;
DROP POLICY IF EXISTS "avatars owner update" ON storage.objects;
DROP POLICY IF EXISTS "avatars owner delete" ON storage.objects;
DROP POLICY IF EXISTS "attachments owner all" ON storage.objects;
DROP POLICY IF EXISTS "backups owner all" ON storage.objects;
DROP POLICY IF EXISTS "Auth users can upload surprise assets" ON storage.objects;
DROP POLICY IF EXISTS "Public read surprise assets" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own surprise assets" ON storage.objects;

CREATE POLICY "Authenticated users upload to own folder" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id IN ('chat-files','gallery','memories') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Authenticated users read own or partner files" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id IN ('chat-files','gallery','memories') AND ((storage.foldername(name))[1] = auth.uid()::text OR (storage.foldername(name))[1] = (SELECT partner_id::text FROM public.profiles WHERE user_id = auth.uid())));
CREATE POLICY "Users update own files" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id IN ('chat-files','gallery','memories') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Users delete own files" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id IN ('chat-files','gallery','memories') AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatars public read" ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'avatars');
CREATE POLICY "avatars owner write" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatars owner update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "avatars owner delete" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "attachments owner all" ON storage.objects FOR ALL TO authenticated USING (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text) WITH CHECK (bucket_id = 'attachments' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "backups owner all" ON storage.objects FOR ALL TO authenticated USING (bucket_id = 'backups' AND (storage.foldername(name))[1] = auth.uid()::text) WITH CHECK (bucket_id = 'backups' AND (storage.foldername(name))[1] = auth.uid()::text);
CREATE POLICY "Auth users can upload surprise assets" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'surprise-assets');
CREATE POLICY "Public read surprise assets" ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'surprise-assets');
CREATE POLICY "Users can delete own surprise assets" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'surprise-assets');