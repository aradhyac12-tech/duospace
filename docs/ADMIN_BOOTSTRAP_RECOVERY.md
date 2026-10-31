# Admin bootstrap and recovery (ADM-002)

Exactly one account holds the ADMIN plan by design. Who may hold it is the
`public.admin_allowlist` table (service_role only), enforced by the
`enforce_admin_allowlist` trigger. The email in migration
`20260930100000_admin_allowlist_and_partner_premium.sql` is only the initial seed.

## Change or recover the admin (run as service_role in the SQL editor)
```sql
-- 1. allow the new admin email (lowercase)
INSERT INTO public.admin_allowlist (email) VALUES ('new-admin@example.com') ON CONFLICT DO NOTHING;
-- 2. remove the old one
DELETE FROM public.admin_allowlist WHERE email = 'old-admin@example.com';
-- 3. revoke the old ADMIN entitlement, then grant the new one
UPDATE public.entitlements SET status = 'revoked'
 WHERE plan = 'ADMIN' AND status = 'active'
   AND user_id = (SELECT id FROM auth.users WHERE lower(email) = 'old-admin@example.com');
INSERT INTO public.entitlements (user_id, plan, status, source, granted_by, metadata)
SELECT id, 'ADMIN', 'active', 'admin_grant', id, '{"note":"allowlisted admin"}'::jsonb
  FROM auth.users WHERE lower(email) = 'new-admin@example.com';
```
No migration edit is needed. Keep the service_role key and the Supabase project
owner login as the break-glass path.
