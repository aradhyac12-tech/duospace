-- ============================================================
-- RLS CONSISTENCY FIX (Phase 8.5, found via the rewritten
-- scripts/check-rls-coverage.mjs — a real, live-tested finding, not a
-- guess: running the script against this repo's actual migrations flagged
-- `apns_push_log` as "RLS enabled but zero currently-active policies.")
--
-- CONTEXT: `apns_push_log` (added in 20260808120000_ios_voip_push.sql) has
-- RLS enabled and `GRANT ALL ... TO service_role`, but no CREATE POLICY at
-- all. Practically this is equivalent to "deny all to anon/authenticated"
-- (RLS enabled + zero policies denies everyone except roles that bypass
-- RLS, i.e. service_role) — so this was never an actual access-control
-- hole. It is, however, inconsistent with every other server-only table in
-- this schema (qr_pairing_tokens, webauthn_challenges, rate_limits,
-- email_change_otps), which all state the same "deny all to anon and
-- authenticated" outcome via two explicit, self-documenting policies
-- rather than relying on the implicit "RLS enabled + no policy" behavior.
-- The implicit form is easy to mistake for an oversight (as this script
-- run did, correctly flagging it for human review) rather than a
-- deliberate choice.
--
-- FIX: add the same explicit deny-all pair used everywhere else in this
-- schema for this exact pattern. No behavior change — apns_push_log was
-- already unreachable by anon/authenticated; this only makes that
-- intentional and self-documenting, and lets the coverage script pass
-- without needing a special-cased allowlist entry.
-- ============================================================

CREATE POLICY "apns_push_log deny anon" ON public.apns_push_log
  FOR ALL TO anon USING (false) WITH CHECK (false);
CREATE POLICY "apns_push_log deny authenticated" ON public.apns_push_log
  FOR ALL TO authenticated USING (false) WITH CHECK (false);
