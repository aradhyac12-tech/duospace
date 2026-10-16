-- Push the partner when a shared Groic listening session starts, so they
-- can join even if their app is closed. Called by the client's startSession().
-- Rate-limited (one push / 60s per sender) to avoid spam on reconnects.
CREATE TABLE IF NOT EXISTS private.groic_listening_push_log (
  sender_id uuid PRIMARY KEY,
  last_sent_at timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION public.notify_partner_listening()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_me uuid := auth.uid();
  v_partner uuid;
  v_last timestamptz;
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;
  SELECT partner_id INTO v_partner FROM public.profiles WHERE user_id = v_me;
  IF v_partner IS NULL THEN RETURN; END IF;

  SELECT last_sent_at INTO v_last FROM private.groic_listening_push_log WHERE sender_id = v_me;
  IF v_last IS NOT NULL AND v_last > now() - interval '60 seconds' THEN RETURN; END IF;
  INSERT INTO private.groic_listening_push_log (sender_id, last_sent_at) VALUES (v_me, now())
    ON CONFLICT (sender_id) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at;

  PERFORM private.dispatch_push(jsonb_build_object(
    'internal', true,
    'type', 'groic_listening',
    'senderId', v_me,
    'recipientId', v_partner,
    'createdAt', now()
  ));
END;
$$;
REVOKE ALL ON FUNCTION public.notify_partner_listening() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.notify_partner_listening() TO authenticated;
