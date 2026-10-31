-- Vanish Mode redesign: disappearing messages no longer resolve to a real
-- expiry timestamp at all — while active, sent messages get
-- disappear_at = 'vanish' (a permanent sentinel, not a pending one that
-- later becomes a timestamp like the old 'pending' flow). They're deleted
-- in bulk, client-side, the moment either user turns Vanish Mode off —
-- see endVanishMode in Chat.tsx — never by this sweep.
--
-- delete_expired_messages() casts disappear_at to timestamptz for any row
-- that isn't the literal 'pending'. Without this fix, the first 'vanish'
-- row in the table crashes that cast for the ENTIRE sweep — including
-- unrelated genuinely-scheduled messages — since one bad row fails a
-- statement-level cast, not just that row.
CREATE OR REPLACE FUNCTION public.delete_expired_messages()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.messages
  WHERE disappear_at IS NOT NULL
    AND disappear_at NOT IN ('pending', 'vanish')
    AND disappear_at::timestamptz <= now();
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
          AND disappear_at NOT IN ('pending', 'vanish')
          AND disappear_at::timestamptz < now();
      $fn$;
    $sql$;
  END IF;
END $$;
