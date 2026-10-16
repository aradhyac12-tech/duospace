/**
 * Monetization foundation on real Postgres (PGlite). Includes the M1
 * regression: an anonymous caller could read ANY user's plan because
 * `_user_id <> auth.uid()` is NULL (not true) when auth.uid() is NULL.
 * Reproduced on the staging Supabase project before the fix.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser } from "./pgliteHarness";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
let db: PGlite;
beforeEach(async () => {
  db = await makeDb(["20260910140000_lock_get_partner_id_to_self.sql", "20260922100000_relationship_shares.sql"]);
  await db.exec(`CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;`);
  // Mirror Supabase's default privileges (tables + functions granted to anon/authenticated at creation),
  // so RLS and the migration's own REVOKEs are what's actually being tested.
  await db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;`);
  await db.exec(readFileSync("supabase/migrations/20260926120000_monetization_entitlements_foundation.sql", "utf8"));
  await db.exec(`INSERT INTO auth.users VALUES ('${A}'),('${B}'),('${C}');
    INSERT INTO public.profiles VALUES ('${A}','${B}'),('${B}','${A}'),('${C}',NULL);
    INSERT INTO public.entitlements(user_id, plan, source) VALUES ('${A}','FOUNDER','founder_grant'),('${A}','PLUS_COUPLE','google_play');`);
}, 30_000);

const asAnon = async <T,>(fn: () => Promise<T>) => { await db.exec(`SET ROLE anon; SELECT set_config('request.jwt.claim.sub', '', false);`); try { return await fn(); } finally { await db.exec("RESET ROLE"); } };
const planOf = async (target: string) => (await db.query<{ p: string }>(`SELECT public.get_effective_entitlement($1)::text AS p`, [target])).rows[0].p;
const myPlan = async () => (await db.query<{ plan: string }>(`SELECT plan::text AS plan FROM public.my_entitlement`)).rows[0].plan;

describe("entitlements", () => {
  it("M1: anonymous caller cannot learn anyone's plan", async () => {
    const r = await asAnon(async () => { try { return await planOf(A); } catch { return "DENIED"; } });
    expect(r === "DENIED" || r === "FREE").toBe(true);
    expect(r).not.toBe("FOUNDER");
  });
  it("a stranger asking about someone else gets FREE", async () => {
    expect(await asUser(db, C, () => planOf(A))).toBe("FREE");
  });
  it("own plan (highest wins) and couple plan follows the live, mutual partner link", async () => {
    expect(await asUser(db, A, myPlan)).toBe("FOUNDER");
    expect(await asUser(db, B, myPlan)).toBe("PLUS_COUPLE");
    expect(await asUser(db, C, myPlan)).toBe("FREE");
    await db.exec(`UPDATE public.profiles SET partner_id = NULL WHERE user_id IN ('${A}','${B}')`);
    expect(await asUser(db, B, myPlan)).toBe("FREE"); // unlink removes coverage immediately
  });
  it("clients cannot grant themselves a plan or write purchase events", async () => {
    const ins = (sql: string) => asUser(db, C, async () => { try { await db.query(sql); return "OK"; } catch { return "DENIED"; } });
    expect(await ins(`INSERT INTO public.entitlements(user_id, plan) VALUES ('${C}','LIFETIME')`)).toBe("DENIED");
    expect(await ins(`INSERT INTO public.purchase_events(user_id, platform, product_id, purchase_token_hash, status) VALUES ('${C}','google_play','x','h','verified')`)).toBe("DENIED");
    expect(await asUser(db, C, async () => (await db.query(`SELECT 1 FROM public.entitlements`)).rows.length)).toBe(0);
  });
});
