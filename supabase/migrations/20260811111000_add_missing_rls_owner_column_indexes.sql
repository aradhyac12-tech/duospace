-- ============================================================
-- PERFORMANCE FIX (Backend Hardening Pass — Sections 4 & 17)
--
-- Every RLS policy on these tables filters directly on the listed owner
-- column (e.g. `USING (auth.uid() = creator_id OR ...)`), including the
-- ones this remediation pass just scoped down from USING(true) — a
-- sequential scan was invisible before because USING(true) never touched
-- the column at all; a correctly-scoped policy makes the column's
-- selectivity matter on every single query against the table. None of
-- these had a PRIMARY KEY, UNIQUE constraint, or explicit CREATE INDEX
-- covering the column (confirmed by reading each table's full CREATE
-- TABLE statement, not assumed), so today every SELECT against any of
-- them is a full sequential scan filtered by a security-critical
-- predicate — that only stays cheap while the table is small.
--
-- Not applied blindly to every FK in the schema — see
-- docs/SUPABASE_SCHEMA_INVENTORY.md for the full audit; these nine are
-- specifically the ones with an active RLS policy referencing the column
-- and no existing index of any kind.
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_countdowns_creator_id ON public.countdowns (creator_id);
CREATE INDEX IF NOT EXISTS idx_memories_creator_id ON public.memories (creator_id);
CREATE INDEX IF NOT EXISTS idx_taps_sender_id ON public.taps (sender_id);
CREATE INDEX IF NOT EXISTS idx_gallery_items_owner_id ON public.gallery_items (owner_id);
CREATE INDEX IF NOT EXISTS idx_playlist_songs_added_by ON public.playlist_songs (added_by);
CREATE INDEX IF NOT EXISTS idx_shayaris_user_id ON public.shayaris (user_id);
CREATE INDEX IF NOT EXISTS idx_mood_logs_user_id ON public.mood_logs (user_id);
CREATE INDEX IF NOT EXISTS idx_code_surprises_creator_id ON public.code_surprises (creator_id);
CREATE INDEX IF NOT EXISTS idx_blend_invites_sender_id ON public.blend_invites (sender_id);

-- gallery_items additionally needs `is_shared` supported for the partner
-- "shared with me" branch of its SELECT policy — a partial index keeps
-- this cheap without duplicating the full-table owner index above.
CREATE INDEX IF NOT EXISTS idx_gallery_items_shared ON public.gallery_items (owner_id) WHERE is_shared = true;

-- CREATE INDEX (not CONCURRENTLY): matches every other index migration in
-- this repo's history and is fine for tables that are small today, but per
-- Section 23 (zero-downtime review) — if any of these tables are already
-- large in production, running this migration will take a brief
-- ACCESS EXCLUSIVE-adjacent lock (CREATE INDEX takes a SHARE lock, blocking
-- writes but not reads, for the build duration). CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block / a single multi-statement
-- migration the way Supabase applies these, so if downtime is a concern,
-- these should be split into individual migrations run outside a
-- transaction, or applied via the Dashboard SQL editor with
-- CONCURRENTLY, rather than as-is through the normal migration runner.
-- Given none of these tables have any other evidence of being
-- production-scale yet (no partitioning, no archival strategy elsewhere in
-- this schema), this is flagged rather than pre-emptively engineered
-- around.
-- ============================================================
