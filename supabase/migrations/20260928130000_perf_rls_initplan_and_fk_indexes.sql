-- Performance: wrap bare auth.uid() calls in RLS policies as (SELECT auth.uid())
-- so Postgres evaluates them once per query (InitPlan) instead of once per row
-- (Supabase advisor: auth_rls_initplan, 30 policies). Semantically identical.
-- Also adds covering indexes for 9 foreign keys the advisor flagged as unindexed.
--
-- Applied live to jzlpelxwzjjpddqcrtpu on 2026-09-29 via a DO block that rewrote
-- policies in place (ALTER POLICY ... USING/WITH CHECK) rather than dropping and
-- recreating them, to avoid any window without a policy. Recorded here as a plain
-- migration so a from-scratch database ends up in the same state. Re-running this
-- against the live DB is a safe no-op (ALTER POLICY / CREATE INDEX IF NOT EXISTS).

DO $$
DECLARE
  p record;
  new_qual text;
  new_check text;
  stmt text;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (coalesce(qual,'') ~ '(?<!SELECT )auth\.uid\(\)'
        OR coalesce(with_check,'') ~ '(?<!SELECT )auth\.uid\(\)')
  LOOP
    new_qual  := CASE WHEN p.qual IS NULL THEN NULL
                 ELSE regexp_replace(p.qual, '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g') END;
    new_check := CASE WHEN p.with_check IS NULL THEN NULL
                 ELSE regexp_replace(p.with_check, '(?<!SELECT )auth\.uid\(\)', '(SELECT auth.uid())', 'g') END;

    stmt := format('ALTER POLICY %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    IF new_qual  IS NOT NULL THEN stmt := stmt || ' USING (' || new_qual || ')'; END IF;
    IF new_check IS NOT NULL THEN stmt := stmt || ' WITH CHECK (' || new_check || ')'; END IF;
    EXECUTE stmt;
  END LOOP;
END $$;

DO $$
DECLARE
  f record;
  cols text;
  idxname text;
BEGIN
  FOR f IN
    SELECT c.conname, c.conrelid, c.conkey, cl.relname AS tbl
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = cl.relnamespace
    WHERE c.contype = 'f' AND ns.nspname = 'public'
      AND c.conname IN (
        'ai_insights_consent_reference_fkey',
        'call_history_caller_id_fkey',
        'call_history_claimed_by_fkey',
        'entitlements_granted_by_fkey',
        'entitlements_payment_transaction_id_fkey',
        'entitlements_purchase_event_id_fkey',
        'payment_transactions_product_id_fkey',
        'payment_transactions_replaced_by_transaction_id_fkey',
        'qr_pairing_tokens_claimed_by_user_id_fkey')
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
      INTO cols
    FROM unnest(f.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = f.conrelid AND a.attnum = k.attnum;

    idxname := left('idx_' || f.tbl || '_' || regexp_replace(replace(cols, ', ', '_'), '"', '', 'g') || '_fk', 63);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (%s)', idxname, f.tbl, cols);
  END LOOP;
END $$;
