-- Raise storage.buckets.file_size_limit for the two buckets photos/videos
-- actually upload through (chat-files, gallery) so Supabase Storage itself
-- never rejects an upload the app already accepted client-side.
--
-- WHY THIS WAS NEEDED: neither bucket had an explicit file_size_limit set
-- (see the original INSERT INTO storage.buckets calls in
-- 20260308224547_..., 20260511075549_..., and the idempotency fix in
-- 20260820100000_...  — none of them pass a file_size_limit, so Storage
-- was falling back to the project-wide default). The app's own limits are
-- enforced in two other places — Chat.tsx's client-side MAX_MB check and
-- finalize-upload/index.ts's ALLOWED_BUCKETS maxBytes — both raised to
-- 100MB (chat-files) / already 500MB (gallery) in this same change. An
-- unset bucket-level limit below those numbers would mean Storage itself
-- rejects a raw, uncompressed photo/video that both app-level checks had
-- already accepted — the "no errors" part of the ask. Setting it here
-- explicitly closes that gap instead of relying on whatever the project
-- default happens to be.
--
-- chat-files: 100MB, matching Chat.tsx MAX_MB and finalize-upload's
-- ALLOWED_BUCKETS["chat-files"].maxBytes.
UPDATE storage.buckets SET file_size_limit = 104857600 WHERE id = 'chat-files';

-- gallery: 500MB, matching finalize-upload's ALLOWED_BUCKETS["gallery"].maxBytes
-- (already comfortably above the 100MB floor — this just makes the bucket's
-- own limit agree with what finalize-upload already enforces, instead of
-- leaving it unset).
UPDATE storage.buckets SET file_size_limit = 524288000 WHERE id = 'gallery';
