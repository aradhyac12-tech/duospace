-- Storage buckets used by the app. Apply on external Supabase SQL editor.
-- Safe to re-run (INSERT ... ON CONFLICT DO NOTHING).

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

-- chat-files: public read (bucket serves via CDN so partners can display each
-- other's media without signing URLs), per-sender uid/ prefix, 25 MB.
insert into storage.buckets (id, name, public, file_size_limit)
values ('chat-files','chat-files',true,26214400)
on conflict (id) do update set public = excluded.public;





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

  -- chat-files: sender may write to their own uid/ prefix.
  if not exists (select 1 from pg_policies where policyname = 'chat-files owner write') then
    create policy "chat-files owner write" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'chat-files'
                  and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'chat-files owner modify') then
    create policy "chat-files owner modify" on storage.objects
      for update to authenticated
      using (bucket_id = 'chat-files'
             and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'chat-files owner delete') then
    create policy "chat-files owner delete" on storage.objects
      for delete to authenticated
      using (bucket_id = 'chat-files'
             and (storage.foldername(name))[1] = auth.uid()::text);
  end if;
  -- Read: sender OR their linked partner (via profiles.partner_id both ways).
  if not exists (select 1 from pg_policies where policyname = 'chat-files pair read') then
    create policy "chat-files pair read" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'chat-files'
        and (
          (storage.foldername(name))[1] = auth.uid()::text
          or exists (
            select 1 from public.profiles p
            where p.user_id = auth.uid()
              and p.partner_id::text = (storage.foldername(name))[1]
          )
          or exists (
            select 1 from public.profiles p
            where p.user_id::text = (storage.foldername(name))[1]
              and p.partner_id = auth.uid()
          )
        )
      );
  end if;
end $$;

