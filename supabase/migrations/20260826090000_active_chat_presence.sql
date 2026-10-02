-- ----------------------------------------------------------------------------
-- Active chat presence — suppress a message push when the recipient is
-- already looking at that exact conversation.
--
-- GAP THIS CLOSES: send-push's skip-check sequence (recipient exists, not
-- blocked, notification_preferences) had no way to know "the recipient's
-- phone is already open to this thread right now" — a message push would
-- fire and show even while both people were actively chatting. This adds
-- the missing signal: a tiny heartbeat row the client keeps fresh only
-- while the chat screen is genuinely visible/foregrounded (see
-- useActiveChatPresence.ts), which send-push checks before dispatching a
-- message-like push (see the "3.5" skip step in send-push/index.ts).
--
-- Deliberately NOT a general online-presence system (that already exists
-- separately for the Map's "Active now", via a Realtime presence channel,
-- not a table) — this is scoped specifically to "viewing THIS partner's
-- thread right now", which is what a push-suppression decision actually
-- needs, and self-expires via updated_at rather than needing a reliable
-- disconnect signal.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.active_chat_presence (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  partner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.active_chat_presence ENABLE ROW LEVEL SECURITY;

-- Each person may only write/read their own heartbeat row. send-push
-- reads across all rows via the service-role client, which bypasses RLS
-- entirely, so no cross-user SELECT policy is needed here.
CREATE POLICY "own heartbeat: select"
  ON public.active_chat_presence FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "own heartbeat: upsert"
  ON public.active_chat_presence FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "own heartbeat: update"
  ON public.active_chat_presence FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "own heartbeat: delete"
  ON public.active_chat_presence FOR DELETE
  USING (auth.uid() = user_id);

-- Index for send-push's lookup (user_id is already the PK, but the query
-- filters on both columns plus a freshness window — this keeps that a
-- single index-only scan instead of a PK lookup + filter).
CREATE INDEX IF NOT EXISTS active_chat_presence_lookup_idx
  ON public.active_chat_presence (user_id, partner_id, updated_at);

-- Best-effort periodic cleanup isn't required for correctness (send-push's
-- freshness check makes a stale row inert on its own — see below), but
-- keeps the table from accumulating rows for people who stop opening the
-- app. Safe to run from a scheduled job if one exists; harmless if not.
-- (No pg_cron dependency added here — left as a plain function so the
-- project can wire it up to whatever scheduler it already uses.)
CREATE OR REPLACE FUNCTION public.cleanup_stale_chat_presence()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.active_chat_presence WHERE updated_at < now() - interval '1 hour';
$$;
REVOKE ALL ON FUNCTION public.cleanup_stale_chat_presence() FROM public;
