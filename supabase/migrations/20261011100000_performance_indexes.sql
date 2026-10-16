-- Performance indexes (additive only — no table, column, policy or data is changed).
--
-- Why: the app's hot reads are per-user "newest first" lists (call history,
-- gallery, memories, shayaris, mood log, playlist, surprises), unread-message
-- lookups, and per-user push-token lookups. Most of those tables only had a
-- single-column index on the owner column (e.g. idx_gallery_items_owner_id), so
-- Postgres had to fetch every row for the user and then sort by created_at.
-- Composite (owner, created_at DESC) indexes serve "filter + ORDER BY + LIMIT"
-- straight from the index, and RLS policies that filter on the owner column
-- benefit from the same leading column.
--
-- Safety:
--   * Every statement is CREATE INDEX IF NOT EXISTS — re-running is a no-op.
--   * The helper below only creates an index when the table AND every column it
--     names exist, otherwise it RAISE NOTICEs and moves on, so a schema that
--     differs from the one these were written against can never fail the migration.
--   * Plain (non-CONCURRENT) builds because migrations run inside a transaction;
--     these tables are small enough (a two-person product) that the brief lock is fine.
--   * Existing indexes are left alone (idx_messages_pair_created, idx_messages_not_deleted,
--     idx_messages_client_message_id, idx_call_history_pair_created, ... already cover
--     the chat timeline and call-pair lookups). Nothing here duplicates them.
--
-- Rollback: DROP INDEX IF EXISTS public.<name>; for any index listed below.

CREATE OR REPLACE FUNCTION pg_temp.duo_ix(
  p_name text, p_table text, p_cols text[], p_def text
) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE
  missing text;
BEGIN
  IF to_regclass(format('public.%I', p_table)) IS NULL THEN
    RAISE NOTICE 'skip %: table public.% does not exist', p_name, p_table;
    RETURN;
  END IF;

  SELECT string_agg(c, ', ') INTO missing
  FROM unnest(p_cols) AS c
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = p_table AND column_name = c
  );
  IF missing IS NOT NULL THEN
    RAISE NOTICE 'skip %: public.% is missing column(s): %', p_name, p_table, missing;
    RETURN;
  END IF;

  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I %s', p_name, p_table, p_def);
END
$fn$;

-- ── messages ────────────────────────────────────────────────────────────────
-- Unread badge / "mark conversation read": only the (small) unread tail is indexed.
SELECT pg_temp.duo_ix('idx_messages_unread_by_receiver', 'messages',
  ARRAY['receiver_id', 'sender_id', 'created_at', 'is_read'],
  '(receiver_id, sender_id, created_at DESC) WHERE is_read = false');
-- Quoted-reply / reply-thread lookups and the FK cascade check.
SELECT pg_temp.duo_ix('idx_messages_reply_to', 'messages',
  ARRAY['reply_to_id'],
  '(reply_to_id) WHERE reply_to_id IS NOT NULL');

-- ── call_history ────────────────────────────────────────────────────────────
-- Calls screen / chat call events: "my calls, newest first" from either side.
SELECT pg_temp.duo_ix('idx_call_history_caller_created', 'call_history',
  ARRAY['caller_id', 'created_at'], '(caller_id, created_at DESC)');
SELECT pg_temp.duo_ix('idx_call_history_receiver_created', 'call_history',
  ARRAY['receiver_id', 'created_at'], '(receiver_id, created_at DESC)');

-- ── gallery / memories / lists (owner + newest first) ───────────────────────
SELECT pg_temp.duo_ix('idx_gallery_items_owner_created', 'gallery_items',
  ARRAY['owner_id', 'created_at'], '(owner_id, created_at DESC)');
-- The partner's view reads only items the owner shared.
SELECT pg_temp.duo_ix('idx_gallery_items_owner_shared_created', 'gallery_items',
  ARRAY['owner_id', 'created_at', 'is_shared'], '(owner_id, created_at DESC) WHERE is_shared = true');
SELECT pg_temp.duo_ix('idx_gallery_albums_owner_created', 'gallery_albums',
  ARRAY['owner_id', 'created_at'], '(owner_id, created_at DESC)');
SELECT pg_temp.duo_ix('idx_memories_creator_created', 'memories',
  ARRAY['creator_id', 'created_at'], '(creator_id, created_at DESC)');
SELECT pg_temp.duo_ix('idx_countdowns_creator_target', 'countdowns',
  ARRAY['creator_id', 'target_date'], '(creator_id, target_date)');
SELECT pg_temp.duo_ix('idx_shayaris_user_created', 'shayaris',
  ARRAY['user_id', 'created_at'], '(user_id, created_at DESC)');
SELECT pg_temp.duo_ix('idx_mood_logs_user_created', 'mood_logs',
  ARRAY['user_id', 'created_at'], '(user_id, created_at DESC)');
SELECT pg_temp.duo_ix('idx_playlist_songs_added_by_created', 'playlist_songs',
  ARRAY['added_by', 'created_at'], '(added_by, created_at DESC)');

-- ── surprises ───────────────────────────────────────────────────────────────
SELECT pg_temp.duo_ix('idx_code_surprises_creator_created', 'code_surprises',
  ARRAY['creator_id', 'created_at'], '(creator_id, created_at DESC)');
SELECT pg_temp.duo_ix('idx_code_surprise_events_surprise_created', 'code_surprise_events',
  ARRAY['surprise_id', 'created_at'], '(surprise_id, created_at DESC)');
SELECT pg_temp.duo_ix('idx_surprise_library_owner_created', 'surprise_library',
  ARRAY['owner_id', 'created_at'], '(owner_id, created_at DESC)');

-- ── push ────────────────────────────────────────────────────────────────────
-- "Valid tokens for this user" is what every notification send reads.
SELECT pg_temp.duo_ix('idx_push_tokens_user_valid', 'push_tokens',
  ARRAY['user_id', 'is_valid', 'last_used_at'],
  '(user_id, last_used_at DESC) WHERE is_valid = true');

-- Refresh planner statistics so the new indexes are used straight away.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'messages', 'call_history', 'gallery_items', 'gallery_albums', 'memories', 'countdowns',
    'shayaris', 'mood_logs', 'playlist_songs', 'code_surprises', 'code_surprise_events',
    'surprise_library', 'push_tokens'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('ANALYZE public.%I', t);
    END IF;
  END LOOP;
END
$$;
