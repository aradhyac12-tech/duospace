-- SECURITY FIX (P1 — Phase 4 adversarial audit, RLS matrix): six tables
-- carried a `FOR SELECT TO authenticated USING (true)` policy —
-- countdowns, memories, taps, daily_answers, playlist_songs, invite_links
-- — recreated with the exact same unrestricted text across four
-- successive "full schema reset" migrations
-- (20260308224547/20260511075549/20260707054831/20260708090100) and never
-- narrowed. DuoSpace is strictly 1:1 (profiles.partner_id, enforced
-- elsewhere) — every one of these tables holds content meant for exactly
-- one couple, but `USING (true)` means ANY signed-in DuoSpace user, for
-- ANY other couple in the app, could `select * from <table>` directly over
-- PostgREST and read it in full: countdown titles/dates, shared photo
-- memories, daily-question answers, tap notifications, and (this one is
-- worse than a read leak) every currently-valid, unused invite_links.code
-- — the token accept_invite() uses to link two accounts as partners. A
-- client could list every unclaimed invite in the app and claim a
-- complete stranger's pending invite before its intended recipient does,
-- linking as their partner. This is a full P1 finding, one column short
-- of P0 (the same class of "any authenticated user, arbitrary target"
-- gap as get_partner_daily_key/is_partner_on_call before this audit's
-- earlier fixes) — the reason it isn't rated P0 itself is that acquiring
-- a specific invite requires already knowing SOME valid unclaimed code
-- exists, whereas P0 required knowing nothing about the target at all;
-- once one code is listed via this policy, though, the impact is
-- identical to a P0 account-linking takeover.
--
-- FIX: for the five couple-content tables, scope SELECT to
-- creator_id/sender_id/user_id/added_by = the caller OR the caller's
-- actual partner (via public.get_partner_id(auth.uid()) — the same
-- already-hardened helper gallery_items' own SELECT policy already uses,
-- 20260910140000_lock_get_partner_id_to_self.sql), instead of reinventing
-- the relationship check. For taps specifically, sender_id/receiver_id
-- already directly name the two parties, so no get_partner_id lookup is
-- needed at all — narrower still.
--
-- For invite_links: a full grep of src/ (this migration's own audit trail)
-- confirms there is exactly one client-side access to this table anywhere
-- in the app — the INSERT that creates a new invite
-- (PartnerSettings.tsx) — and accepting an invite goes entirely through
-- accept_invite(p_code, p_user_id), a SECURITY DEFINER RPC that already
-- validates code + expiry + used_by atomically and bypasses RLS by
-- design. Nothing in the app ever SELECTs this table directly, so SELECT
-- is scoped to `creator_id = auth.uid()` (see your own outstanding
-- invites in settings) rather than needing any code-lookup carve-out —
-- removing the unused, exploitable "Anyone can lookup invite by code"
-- policy entirely rather than trying to narrow it.

DROP POLICY IF EXISTS "Authenticated users can view countdowns" ON public.countdowns;
CREATE POLICY "Users can view own or partner's countdowns" ON public.countdowns
  FOR SELECT TO authenticated
  USING (auth.uid() = creator_id OR creator_id = public.get_partner_id(auth.uid()));

DROP POLICY IF EXISTS "Authenticated users can view memories" ON public.memories;
CREATE POLICY "Users can view own or partner's memories" ON public.memories
  FOR SELECT TO authenticated
  USING (auth.uid() = creator_id OR creator_id = public.get_partner_id(auth.uid()));

DROP POLICY IF EXISTS "Authenticated users can view taps" ON public.taps;
CREATE POLICY "Users can view own sent or received taps" ON public.taps
  FOR SELECT TO authenticated
  USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

DROP POLICY IF EXISTS "Authenticated users can view answers" ON public.daily_answers;
CREATE POLICY "Users can view own or partner's answers" ON public.daily_answers
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR user_id = public.get_partner_id(auth.uid()));

DROP POLICY IF EXISTS "Authenticated users can view songs" ON public.playlist_songs;
CREATE POLICY "Users can view own or partner's playlist songs" ON public.playlist_songs
  FOR SELECT TO authenticated
  USING (auth.uid() = added_by OR added_by = public.get_partner_id(auth.uid()));

DROP POLICY IF EXISTS "Anyone can lookup invite by code" ON public.invite_links;
CREATE POLICY "Users can view own created invites" ON public.invite_links
  FOR SELECT TO authenticated
  USING (auth.uid() = creator_id);
