-- Surprise 3.0 §7: Two-Screen Heart needs BOTH partners to see each
-- other's surprise_dual_activated row for a shared surprise, regardless of
-- who created it — the original policy (surprise_couple_sync_events'
-- migration) only covered "the creator sees reactions about their own
-- surprise", which was correct for partner_reaction_*/surprise_major_reveal
-- (those are inherently creator-facing) but leaves the RECIPIENT unable to
-- see the CREATOR's own activation row when the creator is the one who
-- made a Two-Screen Heart surprise and then also has to tap their own half.
--
-- get_partner_id(uuid) is the same server-side-verified relationship
-- function every other partner-visibility policy in this schema already
-- uses (locations, shayaris, blend_invites, mood_logs, code_surprises
-- itself) — reused here rather than trusting any client-supplied partner
-- id, per §16/§18.
DROP POLICY IF EXISTS "View couple sync events" ON public.surprise_couple_sync_events;
CREATE POLICY "View couple sync events" ON public.surprise_couple_sync_events FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR user_id = public.get_partner_id(auth.uid())
    OR surprise_id IN (SELECT id FROM public.code_surprises WHERE creator_id = auth.uid())
  );
