/**
 * Minimal real-Postgres harness (PGlite = Postgres compiled to WASM) for
 * running the ACTUAL migration SQL under RLS. Only the Supabase pieces the
 * migrations depend on are stubbed: auth.users, auth.uid() (read from a
 * session setting, like Supabase's request.jwt.claim.sub), the
 * authenticated/anon roles, and the tables the functions reference.
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(__dirname, "..", "..", "..", "supabase", "migrations");
export const readMigration = (name: string) => readFileSync(join(MIGRATIONS, name), "utf8");

export async function makeDb(migrationFiles: string[]): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE SCHEMA private;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    -- Exists in production (read 2026-09-26) and is assumed by several migrations
    -- (e.g. monetization). Mirrored here so migrations apply as they do on Supabase.
    CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
      LANGUAGE plpgsql SET search_path TO 'public' AS $fn$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $fn$;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated, anon;
    GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, anon;
    CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, partner_id uuid, username text, display_name text NOT NULL DEFAULT '', avatar_url text); -- columns as in production (read-only check 2026-09-27)
    CREATE TABLE public.partner_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sender_id uuid, receiver_id uuid, status text);
    GRANT USAGE ON SCHEMA public TO authenticated, anon;
  `);
  for (const f of migrationFiles) await db.exec(readMigration(f));
  // Only when the requested migration set actually created the table: suites that
  // exercise other domains (e.g. commerce reconcile) do not load the sharing migration.
  await db.exec(`DO $g$ BEGIN
    IF to_regclass('public.relationship_shares') IS NOT NULL THEN
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.relationship_shares TO authenticated;
    END IF;
  END $g$;`);
  return db;
}

/** Run `fn` as an authenticated Supabase user (RLS enforced). */
export async function asUser<T>(db: PGlite, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
  try { return await fn(); } finally { await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);`); }
}
