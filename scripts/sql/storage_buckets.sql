-- Storage buckets used by the app. Apply on external Supabase SQL editor.
-- Safe to re-run (INSERT ... ON CONFLICT DO NOTHING).
--
-- STALENESS WARNING (found 2026-09-16, see
-- supabase/functions/finalize-upload/index.ts's own header comment and
-- docs/PHASE_4_SECURITY_AUDIT.md §15 for the full story): this script's
-- bucket set (avatars/attachments/backups) does NOT match what the app's
-- real upload code actually uses. The buckets the client code genuinely
-- uploads through are "chat-files" and "gallery" (via
-- src/lib/resumableUpload.ts, called from Chat.tsx/Gallery.tsx) plus
-- "memories"/"surprise-assets"/"avatars" via direct .upload() calls
-- elsewhere — provisioned inline across the numbered
-- supabase/migrations/*.sql files (search any of them for
-- "INSERT INTO storage.buckets"), not by this script. "backups" is real
-- (src/hooks/useCloudBackup.ts) but bypasses this script's own
-- attachments/backups framing entirely.
--
-- Do not treat this file as authoritative for what buckets exist or what
-- their real limits are — it appears to predate, or was written
-- independently of, the naming the app settled on. Kept as-is (not
-- deleted) pending a real dependency check on whether "attachments" is
-- used by anything outside src/ (edge functions, native code, or a
-- planned-but-unbuilt feature) — see .ai/DO_NOT_CHANGE.md's "don't delete
-- without dependency analysis" rule.

-- avatars: public read, auth write, 2 MB, images only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars','avatars',true,2097152,
        array['image/png','image/jpeg','image/webp','image/gif'])
on conflict (id) do nothing;

-- attachments: private, per-user prefix, 25 MB.
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments','attachments',false,26214400)
on conflict (id) do nothing;

-- backups: private, per-user prefix, 50 MB (used by BackupManager).
insert into storage.buckets (id, name, public, file_size_limit)
values ('backups','backups',false,52428800)
on conflict (id) do nothing;

-- ── RLS on storage.objects ───────────────────────────────────────────────
-- avatars: everyone reads (public bucket already implies public read via
-- the CDN, but the objects policy still gates the S3 API), owner writes.
do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'avatars public read') then
    create policy "avatars public read" on storage.objects
      for select to anon, authenticated
      using (bucket_id = 'avatars');
  end if;

  if not exists (select 1 from pg_policies where policyname = 'avatars owner write') then
    create policy "avatars owner write" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'avatars'
                  and (storage.foldername(name))[1] = auth.uid()::text);
  end if;

  if not exists (select 1 from pg_policies where policyname = 'avatars owner update') then
    create policy "avatars owner update" on storage.objects
      for update to authenticated
      using (bucket_id = 'avatars'
             and (storage.foldername(name))[1] = auth.uid()::text);
  end if;

  if not exists (select 1 from pg_policies where policyname = 'avatars owner delete') then
    create policy "avatars owner delete" on storage.objects
      for delete to authenticated
      using (bucket_id = 'avatars'
             and (storage.foldername(name))[1] = auth.uid()::text);
  end if;

  -- attachments: fully scoped by owner path prefix.
  if not exists (select 1 from pg_policies where policyname = 'attachments owner all') then
    create policy "attachments owner all" on storage.objects
      for all to authenticated
      using (bucket_id = 'attachments'
             and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'attachments'
                  and (storage.foldername(name))[1] = auth.uid()::text);
  end if;

  if not exists (select 1 from pg_policies where policyname = 'backups owner all') then
    create policy "backups owner all" on storage.objects
      for all to authenticated
      using (bucket_id = 'backups'
             and (storage.foldername(name))[1] = auth.uid()::text)
      with check (bucket_id = 'backups'
                  and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
end $$;
