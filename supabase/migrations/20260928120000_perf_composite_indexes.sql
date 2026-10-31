-- Performance: composite indexes for the two hottest keyset-paginated reads.
--
-- 1) Chat history (Chat.tsx fetchMessages) filters
--      (sender_id = me AND receiver_id = partner AND deleted_by_sender IS DISTINCT FROM true)
--      OR (sender_id = partner AND receiver_id = me AND deleted_by_receiver IS DISTINCT FROM true)
--    ORDER BY created_at DESC LIMIT n. The existing idx_messages_not_deleted is
--    PARTIAL (requires BOTH deleted flags to be non-true), so the planner can't use it
--    for this predicate; it falls back to single-column sender/receiver indexes plus a
--    sort. A plain composite lets each OR branch be an ordered index scan.
CREATE INDEX IF NOT EXISTS idx_messages_sender_receiver_created
  ON public.messages (sender_id, receiver_id, created_at DESC);

-- 2) Gallery keyset pagination (Gallery.tsx fetchGalleryPage) orders by
--    (created_at DESC, id DESC) within one owner_id; idx_gallery_items_owner_id alone
--    forces a sort of every row that owner has on each page.
CREATE INDEX IF NOT EXISTS idx_gallery_items_owner_created_id
  ON public.gallery_items (owner_id, created_at DESC, id DESC);
