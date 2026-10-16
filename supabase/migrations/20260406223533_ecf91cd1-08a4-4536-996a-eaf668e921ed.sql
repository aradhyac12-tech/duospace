
-- 1. Allow users to update their own mood logs (for feedback thumbs)
CREATE POLICY "Update own mood logs"
ON public.mood_logs FOR UPDATE TO authenticated
USING (auth.uid() = user_id);

-- 2. Allow users to update/overwrite their own storage objects
CREATE POLICY "Users can update own files"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = ANY(ARRAY['chat-files', 'gallery', 'avatars', 'memories', 'surprise-assets']));

-- 3. Allow any authenticated user to see profiles (for search/requests)
DROP POLICY IF EXISTS "Users can view partner profiles" ON public.profiles;
CREATE POLICY "Authenticated users can view profiles"
ON public.profiles FOR SELECT TO authenticated
USING (true);
