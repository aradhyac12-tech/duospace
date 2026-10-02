-- Surprise 3.0 §7/§8/§12: Couple Sync.
--
-- A separate table from code_surprise_events on purpose: that table's
-- existing rows/behavior (received/opened/expanded/finished, plain INSERT,
-- legitimately-repeatable on reopen) must not change. Couple Sync events
-- need a real exactly-once guarantee (§12 "use idempotent event IDs" /
-- "avoid duplicate events" — a reconnect or a duplicate client dispatch
-- must never replay a partner's felt reaction twice), which needs a
-- non-partial UNIQUE constraint upsert() can target directly — adding that
-- to code_surprise_events would either constrain rows that are supposed to
-- repeat, or need a partial index that supabase-js's upsert() can't address
-- (its generated ON CONFLICT target can't carry a WHERE predicate).
--
-- Only semantic event types travel here (surprise_major_reveal,
-- partner_reaction_opened/completed/heart) — never raw haptic commands,
-- per §7's explicit instruction. Each device translates the semantic type
-- into its own local haptic/visual response client-side.
CREATE TABLE IF NOT EXISTS public.surprise_couple_sync_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  surprise_id uuid NOT NULL REFERENCES public.code_surprises(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (surprise_id, user_id, event_type)
);

GRANT SELECT, INSERT ON public.surprise_couple_sync_events TO authenticated;
GRANT ALL ON public.surprise_couple_sync_events TO service_role;
ALTER TABLE public.surprise_couple_sync_events ENABLE ROW LEVEL SECURITY;

-- Same shape as code_surprise_events' own (already-verified) policies —
-- §18: visible only to the person who did it and the surprise's creator
-- (the one whose device should actually feel the reaction). No one else,
-- including a future group-chat context, can see these rows.
DROP POLICY IF EXISTS "View couple sync events" ON public.surprise_couple_sync_events;
CREATE POLICY "View couple sync events" ON public.surprise_couple_sync_events FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR surprise_id IN (SELECT id FROM public.code_surprises WHERE creator_id = auth.uid()));

-- §18: WITH CHECK pins user_id to the authenticated caller — nobody can
-- insert an event claiming to be their partner's action, and there is no
-- client-supplied "target partner id" field anywhere in this table for
-- someone to forge in the first place.
DROP POLICY IF EXISTS "Insert own couple sync events" ON public.surprise_couple_sync_events;
CREATE POLICY "Insert own couple sync events" ON public.surprise_couple_sync_events FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- §8: creator-controlled opt-out. Defaults true so every existing surprise
-- keeps behaving exactly as it does today the moment this ships.
ALTER TABLE public.code_surprises
  ADD COLUMN IF NOT EXISTS partner_reactions_enabled boolean NOT NULL DEFAULT true;
