-- BUG FIX: "Unable to send message" whenever Vanish Mode / disappearing
-- messages is enabled.
--
-- Root cause: src/pages/Chat.tsx inserts the sentinel string "pending" into
-- messages.disappear_at when a disappearing message is sent (it only gets
-- a real timestamp once the recipient reads it — see handleSend / markRead
-- in Chat.tsx). That's intentional and matches how scheduled_messages.
-- disappear_at is already typed (TEXT, see the "baseline schema" migration).
--
-- But public.messages.disappear_at itself was created as
-- TIMESTAMP WITH TIME ZONE. Postgres rejects the literal "pending" for a
-- timestamptz column ("invalid input syntax for type timestamp with time
-- zone"), so every INSERT into messages fails at the database whenever
-- disappearMode is on — surfacing to the user as the generic
-- "Failed to send" toast in Chat.tsx's handleSend/sendVoiceMessage.
--
-- Fix: make messages.disappear_at TEXT, consistent with how the app
-- actually uses it (either the literal "pending", or an ISO timestamp
-- string later parsed with `new Date(m.disappear_at)`). This mirrors
-- scheduled_messages.disappear_at, which was already TEXT for the exact
-- same reason.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'messages'
      AND column_name = 'disappear_at'
      AND data_type <> 'text'
  ) THEN
    -- Plain `::text` on a timestamptz uses Postgres's own display format
    -- ("2026-08-04 12:00:00+00"), which is NOT valid ISO 8601 — the app
    -- parses this column with `new Date(m.disappear_at)`, and that format
    -- is not reliably parseable across JS engines (V8 is lenient, but it's
    -- not a guarantee). Any row that already has a real timestamp in it
    -- (an existing scheduled disappearing message) needs to convert to a
    -- proper ISO 8601 string, not just Postgres's default text cast.
    ALTER TABLE public.messages
      ALTER COLUMN disappear_at TYPE text
      USING to_char(disappear_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  END IF;
END $$;

-- The cleanup sweep compared disappear_at (a timestamp) directly against
-- now(); once the column is TEXT that comparison needs an explicit cast.
-- "pending" rows are excluded since they haven't resolved to a real
-- timestamp yet and must never be swept.
CREATE OR REPLACE FUNCTION public.delete_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.messages
  WHERE disappear_at IS NOT NULL
    AND disappear_at <> 'pending'
    AND disappear_at::timestamptz <= now();
END;
$$;

-- Re-index now that the column type has changed underneath it.
DROP INDEX IF EXISTS idx_messages_disappear_at;
CREATE INDEX IF NOT EXISTS idx_messages_disappear_at
  ON public.messages (disappear_at)
  WHERE disappear_at IS NOT NULL;

-- Same fix for the older duplicate sweep function some earlier migrations
-- defined (not currently scheduled by pg_cron, but kept consistent so it's
-- safe to call and doesn't error if anything still references it).
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
          AND disappear_at <> 'pending'
          AND disappear_at::timestamptz < now();
      $fn$;
    $sql$;
  END IF;
END $$;
