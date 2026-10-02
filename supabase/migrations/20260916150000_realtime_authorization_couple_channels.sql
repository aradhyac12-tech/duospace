-- SECURITY FIX (queue item 3 from .ai/NEXT_PHASE.md: "Realtime channel
-- authorization audit").
--
-- FINDING: Supabase Realtime channels come in two flavors here.
-- postgres_changes-based channels (messages-rt, gallery-rt, dock-msgs,
-- call-history-rt, and a dozen others) are safe regardless of channel
-- name — Realtime enforces the underlying table's own RLS row-by-row
-- before delivering an event, so an attacker subscribing under a guessed
-- channel name still only ever receives rows they were already allowed to
-- SELECT. Broadcast and Presence channels are different: they are NOT
-- backed by any table RLS. By default every Supabase Realtime channel is
-- PUBLIC — anyone who knows (or guesses) the channel name/topic can join
-- it and both send and receive its broadcast/presence events, with zero
-- server-side authorization, unless the project explicitly opts into
-- "Realtime Authorization" (RLS policies on realtime.messages + the
-- client passing `private: true`). This project had never done that.
--
-- Four channels in this codebase use broadcast/presence:
--   typing-<sortedPair>      (useChatTyping.ts)       — typing indicator
--   presence-<sortedPair>    (useChatPresence.ts)     — partner online/offline
--   groic:<uid1>:<uid2>      (GroicContext.tsx, x2)   — shared music-listen sync
--   blend-sync                (Playlist.tsx)           — shared playlist blend sync
--
-- The first three at least embed both partners' real user IDs in the
-- topic, so exploiting them requires already knowing both UUIDs — but
-- that is a real, not hypothetical, threat model for a couples-safety
-- app specifically: an EX-partner who was previously paired with someone
-- still knows their UUID indefinitely (UUIDs don't rotate on unlink), and
-- could keep silently watching someone's typing activity, online/offline
-- status, and shared listening sessions long after the relationship (and
-- the DuoSpace pairing) ended. This is exactly the kind of thing
-- .ai/DO_NOT_CHANGE.md's "must never become a surveillance application"
-- principle exists to prevent, even though nobody wrote this bug on
-- purpose.
--
-- "blend-sync" was worse: not scoped to a couple at all — a single global
-- channel name shared by every user in the app with an active blend
-- session, letting any authenticated client observe (and inject spoofed
-- playback-control broadcasts into) every other couple's blend session
-- simultaneously. Fixed in this migration + a matching client change to
-- `blend-sync:<uid1>:<uid2>`, same pattern as the other three.
--
-- FIX (this migration is step 1 of 2 — see the accompanying client
-- changes to useChatTyping.ts / useChatPresence.ts / GroicContext.tsx /
-- Playlist.tsx that add `config: { private: true }` and switch
-- typing-/presence- to the same colon-delimited `<prefix>:<uid1>:<uid2>`
-- topic format groic: already used, specifically because a UUID can
-- contain hyphens but never a colon, so splitting on ':' is unambiguous —
-- splitting the old `typing-<uid1>-<uid2>` format on '-' would have been
-- ambiguous, since each UUID already contains 4 hyphens of its own):
--
--   1. A helper function validating that a topic of the form
--      "<prefix>:<uid1>:<uid2>" only authorizes the two users who are
--      CURRENTLY paired as partners — not just "any two UUIDs", and not
--      a stale/former pairing. This closes the ex-partner scenario above:
--      the moment two people unlink, this check starts failing for that
--      topic regardless of who still remembers the old channel name.
--   2. RLS policies on realtime.messages (SELECT = receive, INSERT = send)
--      using that function via realtime.topic().
--
-- REQUIRED MANUAL STEP THIS MIGRATION CANNOT DO: per Supabase's own docs,
-- enforcing private channels also requires disabling "Allow public
-- access" under Project Settings -> Realtime -> Settings in the Supabase
-- dashboard. That is a project-level toggle, not something a SQL
-- migration or this codebase can set. Until that is done AND the
-- accompanying client-side `private: true` change is deployed, these
-- RLS policies are inert (a channel not marked private is public
-- regardless of what's in realtime.messages) — so this migration is safe
-- to apply on its own with zero behavior change, but the fix is not
-- complete until both the client deploy and that dashboard toggle happen.
-- NOT TESTABLE from this environment (no live Supabase project access,
-- no dashboard access) — flagging rather than claiming it's done.

CREATE OR REPLACE FUNCTION public.is_couple_realtime_topic_authorized(p_topic text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  parts text[];
  prefix text;
  uid1 uuid;
  uid2 uuid;
  other_uid uuid;
  my_partner uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN false;
  END IF;

  parts := string_to_array(p_topic, ':');
  IF array_length(parts, 1) <> 3 THEN
    RETURN false;
  END IF;

  prefix := parts[1];
  IF prefix NOT IN ('typing', 'presence', 'groic', 'blend-sync') THEN
    RETURN false;
  END IF;

  BEGIN
    uid1 := parts[2]::uuid;
    uid2 := parts[3]::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN false;
  END;

  IF auth.uid() = uid1 THEN
    other_uid := uid2;
  ELSIF auth.uid() = uid2 THEN
    other_uid := uid1;
  ELSE
    RETURN false;
  END IF;

  SELECT partner_id INTO my_partner FROM public.profiles WHERE user_id = auth.uid();
  RETURN my_partner IS NOT NULL AND my_partner = other_uid;
END;
$$;

COMMENT ON FUNCTION public.is_couple_realtime_topic_authorized(text) IS
  'Realtime Authorization helper: true only if the caller is one of the '
  'two UUIDs in a "<prefix>:<uid1>:<uid2>" topic AND the other UUID is '
  'their CURRENT partner_id (not just any two UUIDs, and not a former '
  'pairing). Add new prefixes to the allowlist here if a future feature '
  'introduces another couple-scoped broadcast/presence channel.';

DROP POLICY IF EXISTS "couple realtime topics: receive" ON realtime.messages;
CREATE POLICY "couple realtime topics: receive"
ON realtime.messages FOR SELECT
TO authenticated
USING ( public.is_couple_realtime_topic_authorized(realtime.topic()) );

DROP POLICY IF EXISTS "couple realtime topics: send" ON realtime.messages;
CREATE POLICY "couple realtime topics: send"
ON realtime.messages FOR INSERT
TO authenticated
WITH CHECK ( public.is_couple_realtime_topic_authorized(realtime.topic()) );
