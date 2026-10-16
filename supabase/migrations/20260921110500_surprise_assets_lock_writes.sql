-- Applied live 2026-09-21. surprise-assets is a PUBLIC (world-readable) bucket that no client code
-- uses and that held 0 objects. Its INSERT/DELETE policies had no ownership check, so any signed-in
-- user could host arbitrary public files and delete anyone else's objects. Writes are now
-- service_role only; the public read policy is unchanged.
-- (docs/../20260824090000 flagged this as an "unconfirmed finding"; it is confirmed.)
DROP POLICY IF EXISTS "Auth users can upload surprise assets" ON storage.objects;
DROP POLICY IF EXISTS "Users can delete own surprise assets" ON storage.objects;
