/**
 * Covers everything added on top of the base entitlements foundation:
 *  - grant_entitlement / revoke_entitlement (admin-only, server-checked)
 *  - the self-bootstrap admin grant being un-revocable even by direct RPC call
 *  - admin_search_accounts correctly reporting OTHER users' real plans
 *    (regression test for the bug found while building it: the first draft
 *    called the self-only get_effective_entitlement() on other users' ids
 *    and always got FREE back)
 *  - reconcile_linked_purchase_token correctly revoking the OLD entitlement
 *    when a subscription is replaced, without touching unrelated entitlements
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser } from "./pgliteHarness";

const ADMIN = "10000000-0000-4000-8000-000000000001";
const ALICE = "10000000-0000-4000-8000-000000000002";
const BOB = "10000000-0000-4000-8000-000000000003";

let db: PGlite;

beforeEach(async () => {
  db = await makeDb([
    "20260910140000_lock_get_partner_id_to_self.sql",
    "20260922100000_relationship_shares.sql",
    "20260926120000_monetization_entitlements_foundation.sql",
    "20260927090000_monetization_admin_grant_rpc.sql",
    "20260927091500_monetization_fix_admin_search_plan_lookup.sql",
    "20260927093000_monetization_protect_self_bootstrap_admin_grant.sql",
    "20260927130000_monetization_lifecycle_hardening.sql",
  ]);
  await db.exec(
    `INSERT INTO auth.users VALUES ('${ADMIN}'),('${ALICE}'),('${BOB}');
     INSERT INTO auth.users(id) SELECT '${ADMIN}' WHERE NOT EXISTS (SELECT 1 FROM auth.users WHERE id='${ADMIN}');
     INSERT INTO public.profiles VALUES ('${ADMIN}',NULL),('${ALICE}',NULL),('${BOB}',NULL);
     -- auth.users in this harness has no email column by default (only id);
     -- add one so admin_search_accounts (which joins on it) has something to match.
     ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
     UPDATE auth.users SET email = 'admin@example.com' WHERE id = '${ADMIN}';
     UPDATE auth.users SET email = 'alice@example.com' WHERE id = '${ALICE}';
     UPDATE auth.users SET email = 'bob@example.com' WHERE id = '${BOB}';
     INSERT INTO public.entitlements(user_id, plan, status, source, granted_by)
       VALUES ('${ADMIN}', 'ADMIN', 'active', 'admin_grant', '${ADMIN}');`,
  );
}, 30_000);

const myPlan = (uid: string) =>
  asUser(db, uid, async () =>
    (await db.query<{ plan: string }>(`SELECT plan::text AS plan FROM public.my_entitlement`)).rows[0].plan,
  );

describe("grant_entitlement / revoke_entitlement", () => {
  it("a non-admin cannot grant anything", async () => {
    const result = await asUser(db, ALICE, async () => {
      try {
        await db.query(`SELECT public.grant_entitlement('${BOB}', 'FOUNDER', 'test')`);
        return "OK";
      } catch {
        return "DENIED";
      }
    });
    expect(result).toBe("DENIED");
  });

  it("an admin can grant FOUNDER to another account, and it takes effect immediately", async () => {
    await asUser(db, ADMIN, () =>
      db.query(`SELECT public.grant_entitlement('${ALICE}', 'FOUNDER', 'friend')`),
    );
    expect(await myPlan(ALICE)).toBe("FOUNDER");
  });

  it("grant_entitlement refuses to hand out a paid plan", async () => {
    const result = await asUser(db, ADMIN, async () => {
      try {
        await db.query(`SELECT public.grant_entitlement('${ALICE}', 'PLUS_INDIVIDUAL', 'nope')`);
        return "OK";
      } catch {
        return "DENIED";
      }
    });
    expect(result).toBe("DENIED");
  });

  it("the self-bootstrap admin grant cannot be revoked, even by the admin who holds it", async () => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM public.entitlements WHERE user_id = '${ADMIN}' AND source = 'admin_grant'`,
    );
    const bootstrapId = rows[0].id;
    const result = await asUser(db, ADMIN, async () => {
      try {
        await db.query(`SELECT public.revoke_entitlement('${bootstrapId}')`);
        return "OK";
      } catch {
        return "DENIED";
      }
    });
    expect(result).toBe("DENIED");
    expect(await myPlan(ADMIN)).toBe("ADMIN"); // still admin — didn't lock themselves out
  });

  it("a normal (non-bootstrap) grant CAN be revoked by an admin, and access is removed immediately", async () => {
    const { rows } = await asUser(db, ADMIN, () =>
      db.query<{ id: string }>(`SELECT (public.grant_entitlement('${BOB}', 'BETA', 'test')).id`),
    );
    expect(await myPlan(BOB)).toBe("BETA");
    await asUser(db, ADMIN, () => db.query(`SELECT public.revoke_entitlement('${rows[0].id}')`));
    expect(await myPlan(BOB)).toBe("FREE");
  });
});

describe("admin_search_accounts", () => {
  it("reports OTHER users' real current plan, not FREE for everyone (regression: see file header)", async () => {
    await asUser(db, ADMIN, () => db.query(`SELECT public.grant_entitlement('${ALICE}', 'FOUNDER', 'x')`));
    const rows = await asUser(db, ADMIN, async () =>
      (await db.query<{ username: string; current_plan: string }>(
        `SELECT username, current_plan::text FROM public.admin_search_accounts('alice')`,
      )).rows,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].current_plan).toBe("FOUNDER");
  });

  it("a non-admin cannot call it", async () => {
    const result = await asUser(db, ALICE, async () => {
      try {
        await db.query(`SELECT * FROM public.admin_search_accounts('bob')`);
        return "OK";
      } catch {
        return "DENIED";
      }
    });
    expect(result).toBe("DENIED");
  });
});

describe("reconcile_linked_purchase_token (subscription replacement)", () => {
  it("revokes the OLD entitlement/purchase_event without touching an unrelated one", async () => {
    const { rows: oldEvent } = await db.query<{ id: string }>(
      `INSERT INTO public.purchase_events(user_id, platform, product_id, purchase_token_hash, status, verification_status)
       VALUES ('${ALICE}', 'google_play', 'duospace_plus_individual_monthly', 'old-hash', 'verified', 'verified')
       RETURNING id`,
    );
    const { rows: oldEnt } = await db.query<{ id: string }>(
      `INSERT INTO public.entitlements(user_id, plan, status, source, product_id, purchase_event_id)
       VALUES ('${ALICE}', 'PLUS_INDIVIDUAL', 'active', 'google_play', 'duospace_plus_individual_monthly', '${oldEvent[0].id}')
       RETURNING id`,
    );
    // An unrelated entitlement for a different user must survive untouched.
    await db.query(
      `INSERT INTO public.entitlements(user_id, plan, status, source) VALUES ('${BOB}', 'FOUNDER', 'active', 'founder_grant')`,
    );

    await db.query(`SELECT public.reconcile_linked_purchase_token('old-hash')`);

    const ent = await db.query<{ status: string }>(`SELECT status FROM public.entitlements WHERE id = '${oldEnt[0].id}'`);
    const evt = await db.query<{ status: string }>(`SELECT status FROM public.purchase_events WHERE id = '${oldEvent[0].id}'`);
    const bobPlan = await myPlan(BOB);

    expect(ent.rows[0].status).toBe("revoked");
    expect(evt.rows[0].status).toBe("invalid");
    expect(bobPlan).toBe("FOUNDER"); // untouched
  });
});
