/**
 * Security audit v3.22.9 remediation, run on real Postgres (PGlite) using the
 * ACTUAL SQL from 20261004110000_security_audit_v3_22_9_hardening.sql.
 *   RLS-001 exact-match search_users   ADM-001 append-only admin_audit_log
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser, readMigration } from "./pgliteHarness";

const A = "20000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const MIG = readMigration("20261004110000_security_audit_v3_22_9_hardening.sql");
const slice = (from: string, to?: string) => {
  const i = MIG.indexOf(from);
  expect(i).toBeGreaterThan(-1);
  return MIG.slice(i, to ? MIG.indexOf(to, i) : undefined);
};

let db: PGlite;

beforeAll(async () => {
  db = await makeDb([]);
  await db.exec(`
    ALTER TABLE public.profiles ADD COLUMN phone_number text;
    CREATE FUNCTION public.consume_rate_limit(_u uuid, _b text, _m int, _w int) RETURNS boolean
      LANGUAGE sql AS $$ SELECT true $$;
    INSERT INTO public.profiles(user_id, username, display_name) VALUES
      ('${A}', 'alice_01', 'Alice'), ('${B}', 'Bobby_Tables', 'Bob');
    CREATE TABLE public.admin_audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL, action text NOT NULL,
      target_user_id uuid, details jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO public.admin_audit_log(actor_id, action) VALUES ('${A}', 'seed');
  `);
  await db.exec(slice("CREATE OR REPLACE FUNCTION public.search_users", "-- RLS-002"));
  await db.exec(slice("CREATE OR REPLACE FUNCTION private.admin_audit_log_immutable()"));
  await db.exec(`GRANT USAGE ON SCHEMA private TO authenticated;`);
});

describe("RLS-001 search_users", () => {
  const search = (term: string) =>
    asUser(db, A, async () => (await db.query<{ username: string }>(`SELECT username FROM public.search_users($1)`, [term])).rows);

  it("finds an exact username, case-insensitively", async () => {
    expect((await search("bobby_tables")).map((r) => r.username)).toEqual(["Bobby_Tables"]);
  });
  it("does NOT return substring matches (no enumeration)", async () => {
    expect(await search("bob")).toEqual([]);
    expect(await search("tables")).toEqual([]);
    expect(await search("%%%")).toEqual([]);
  });
  it("returns nothing for terms under 3 chars and never the caller", async () => {
    expect(await search("bo")).toEqual([]);
    expect(await search("alice_01")).toEqual([]);
  });
});

describe("ADM-001 admin_audit_log is append-only", () => {
  it("allows INSERT", async () => {
    await db.exec(`INSERT INTO public.admin_audit_log(actor_id, action) VALUES ('${A}', 'ok')`);
  });
  it("blocks UPDATE, DELETE and TRUNCATE even for the table owner", async () => {
    await expect(db.exec(`UPDATE public.admin_audit_log SET action = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`DELETE FROM public.admin_audit_log`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`TRUNCATE public.admin_audit_log`)).rejects.toThrow(/append-only/);
  });
});
