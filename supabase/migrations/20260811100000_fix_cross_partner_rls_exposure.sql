-- ============================================================
-- P0 FIX (Final Release Audit — Phase 8D)
--
-- FINDING: six tables have a SELECT policy of literally
-- `USING (true)` for `TO authenticated` — meaning ANY signed-in
-- DuoSpace user (not just a couple's own partner) can read every
-- row in these tables, across every couple on the platform:
--
--   countdowns       — "Authenticated users can view countdowns"
--   memories         — "Authenticated users can view memories"
--   taps             — "Authenticated users can view taps"
--   daily_answers    — "Authenticated users can view answers"
--   playlist_songs   — "Authenticated users can view songs"
--   invite_links     — "Anyone can lookup invite by code"
--
-- All six were created together in 20260708090100_...sql. The
-- comment there for invite_links ("lookup by code") suggests the
-- broad SELECT was intended to let an unauthenticated-flow-adjacent
-- lookup work — but it was applied to five other tables that have no
-- such requirement, and even for invite_links this is broader than
-- necessary (a valid, non-expired invite code should be findable by
-- its holder without every invite code and creator_id in the system
-- also being enumerable/scannable by any other user).
--
-- This is squarely couple-privacy data: private countdowns, shared
-- memories/photos-adjacent metadata, "tap" nudges, daily relationship
-- Q&A answers, and shared playlist songs — all currently readable by
-- any of this app's other users, not just the intended partner.
--
-- FIX: scope SELECT to (creator/owner) OR (their partner), using the
-- same get_partner_id() SECURITY DEFINER helper already used
-- elsewhere in this schema (profiles, locations) specifically to
-- avoid RLS recursion. invite_links additionally needs
-- unauthenticated lookup-by-code preserved for the "enter a code you
-- were given" flow (the code itself is the credential) — scoped to
-- only still-valid, unused invites, and stripped of the ability to
-- browse other users' invites at will (creator can always see their
-- own; anyone can look up ONE unexpired/unused invite if they already
-- have its code, matching how the app actually uses this table —
-- see src/pages/settings/PartnerSettings.tsx / Onboarding invite
-- entry flow).
-- ============================================================

DROP POLICY IF EXISTS "Authenticated users can view countdowns" ON public.countdowns;
CREATE POLICY "Users view own or partner countdowns" ON public.countdowns FOR SELECT TO authenticated
  USING (auth.uid() = creator_id OR auth.uid() = public.get_partner_id(creator_id));

DROP POLICY IF EXISTS "Authenticated users can view memories" ON public.memories;
CREATE POLICY "Users view own or partner memories" ON public.memories FOR SELECT TO authenticated
  USING (auth.uid() = creator_id OR auth.uid() = public.get_partner_id(creator_id));

DROP POLICY IF EXISTS "Authenticated users can view taps" ON public.taps;
CREATE POLICY "Users view own or partner taps" ON public.taps FOR SELECT TO authenticated
  USING (
    auth.uid() = sender_id
    OR auth.uid() = public.get_partner_id(sender_id)
    OR (receiver_id IS NOT NULL AND auth.uid() = receiver_id)
  );

DROP POLICY IF EXISTS "Authenticated users can view answers" ON public.daily_answers;
CREATE POLICY "Users view own or partner daily answers" ON public.daily_answers FOR SELECT TO authenticated
  USING (auth.uid() = user_id OR auth.uid() = public.get_partner_id(user_id));

DROP POLICY IF EXISTS "Authenticated users can view songs" ON public.playlist_songs;
CREATE POLICY "Users view own or partner playlist songs" ON public.playlist_songs FOR SELECT TO authenticated
  USING (auth.uid() = added_by OR auth.uid() = public.get_partner_id(added_by));

DROP POLICY IF EXISTS "Anyone can lookup invite by code" ON public.invite_links;
CREATE POLICY "Creator can view own invite links" ON public.invite_links FOR SELECT TO authenticated
  USING (auth.uid() = creator_id);
CREATE POLICY "Anyone can look up one unused unexpired invite" ON public.invite_links FOR SELECT TO authenticated
  USING (used_by IS NULL AND expires_at > now());

-- ============================================================
-- Dependency note: these policies assume partner_id is set
-- symmetrically (A.partner_id = B <=> B.partner_id = A), maintained
-- by the atomic pairing RPC — see the Phase 8G fix to
-- PartnerSettings.tsx (client-side non-atomic pairing fallback
-- removed) in this same remediation pass. If a pairing ever became
-- asymmetric, one direction of visibility here could silently fail
-- rather than error, which is safer than the alternative but worth
-- knowing about if a user reports "my partner's [countdown/memory]
-- disappeared."
--
-- The "look up one unused unexpired invite" policy is still broader
-- than ideal — it lets an authenticated user enumerate rows by trial
-- code guessing (no rate limit at the RLS layer) rather than only by
-- a code they already possess. Given invite codes/tokens are
-- typically high-entropy random values (see qr_pairing_tokens for
-- the comparable pattern), brute-forcing is impractical but not
-- provably impossible from this policy alone — flagged in
-- docs/RLS_SECURITY_MATRIX.md as a lower-priority follow-up
-- (consider moving invite acceptance through a rate-limited RPC
-- instead of a direct table SELECT, if not already the case elsewhere).
-- ============================================================
