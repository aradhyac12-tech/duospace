-- Vanish Mode: unseen messages must survive the sender turning the mode off.
--
-- Until now, turning Vanish Mode off deleted every disappear_at = 'vanish'
-- row in the conversation, in both directions, whether or not the other
-- person had opened it. A message you sent that your partner never got to
-- see was erased from their side (and from the database).
--
-- The client now keeps unseen messages and re-labels them with a second
-- non-timestamp sentinel:
--
--   'vanish'            a message sent while a Vanish session is running
--   'vanish_after_seen' the session ended before the recipient opened it —
--                       kept, and deleted (row + media file) once they have
--                       read it and left the chat
--
-- (see src/lib/vanishPlan.ts, src/lib/vanishPurge.ts and the
--  purge-vanish-messages edge function)
--
-- THIS MIGRATION: delete_expired_messages() casts disappear_at to timestamptz
-- for every row that isn't a known sentinel. The previous migration
-- (20260824121500) fixed that with `NOT IN ('pending','vanish')`, which
--   1. would crash the whole sweep on the first 'vanish_after_seen' row, and
--   2. isn't even safe as written: Postgres does not guarantee that the
--      NOT IN filter runs before the cast in the same WHERE clause.
-- Both are fixed by making the cast conditional on the value actually
-- looking like a timestamp, inside a CASE (which IS evaluated in order).
-- Any future sentinel is then safe by construction.
CREATE OR REPLACE FUNCTION public.delete_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.messages
  WHERE disappear_at IS NOT NULL
    AND CASE
          WHEN disappear_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            THEN disappear_at::timestamptz <= now()
          ELSE false
        END;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'cleanup_disappeared_messages'
  ) THEN
    EXECUTE $sql$
      CREATE OR REPLACE FUNCTION public.cleanup_disappeared_messages()
      RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $fn$
        DELETE FROM public.messages
        WHERE disappear_at IS NOT NULL
          AND CASE
                WHEN disappear_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                  THEN disappear_at::timestamptz < now()
                ELSE false
              END;
      $fn$;
    $sql$;
  END IF;
END $$;
