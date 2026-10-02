/**
 * reconcile_entitlement_from_transaction: the single path by which any
 * provider's payment becomes access. Covers idempotency, renewal-updates-
 * not-duplicates, refund/revoke, replacement, provider switching, and that
 * couple coverage still follows the live partner link.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser } from "./pgliteHarness";

const A = "20000000-0000-4000-8000-000000000001";
const B = "20000000-0000-4000-8000-000000000002";
const C = "20000000-0000-4000-8000-000000000003";

let db: PGlite;
let indivId: string;
let coupleId: string;

beforeEach(async () => {
  db = await makeDb([
    "20260910140000_lock_get_partner_id_to_self.sql",
    "20260926120000_monetization_entitlements_foundation.sql",
    "20260927091500_monetization_fix_admin_search_plan_lookup.sql",
    "20260927130000_monetization_lifecycle_hardening.sql",
    "20260927140000_commerce_provider_agnostic_core.sql",
    "20260928140000_fix_replacement_reconciliation_for_ledger.sql",
  ]);
  await db.exec(
    `INSERT INTO auth.users(id) VALUES ('${A}'),('${B}'),('${C}');
     INSERT INTO public.profiles(user_id, partner_id) VALUES ('${A}','${B}'),('${B}','${A}'),('${C}',NULL);`,
  );
  indivId = (await db.query<{ id: string }>(`SELECT id FROM public.commercial_products WHERE plan='PLUS_INDIVIDUAL'`)).rows[0].id;
  coupleId = (await db.query<{ id: string }>(`SELECT id FROM public.commercial_products WHERE plan='PLUS_COUPLE'`)).rows[0].id;
}, 30_000);

const txn = async (user: string, provider: string, ref: string, plan: string, product: string, status = "active", days = 30) =>
  (await db.query<{ id: string }>(
    `INSERT INTO public.payment_transactions(user_id, provider, provider_transaction_id, product_id, plan, amount_minor, currency, status, expires_at)
     VALUES ('${user}','${provider}','${ref}','${product}','${plan}',14900,'INR','${status}', now() + interval '${days} days') RETURNING id`,
  )).rows[0].id;
const reconcile = (id: string) => db.query(`SELECT public.reconcile_entitlement_from_transaction('${id}')`);
const plan = (u: string) => asUser(db, u, async () => (await db.query<{ plan: string }>(`SELECT plan::text FROM public.my_entitlement`)).rows[0].plan);
const count = async (id: string) => Number((await db.query<{ c: string }>(`SELECT count(*) c FROM public.entitlements WHERE payment_transaction_id='${id}'`)).rows[0].c);

describe("reconcile_entitlement_from_transaction", () => {
  it("is idempotent: repeated reconcile leaves exactly one entitlement", async () => {
    const t = await txn(C, "razorpay", "pay_1", "PLUS_INDIVIDUAL", indivId);
    await reconcile(t); await reconcile(t); await reconcile(t);
    expect(await count(t)).toBe(1);
    expect(await plan(C)).toBe("PLUS_INDIVIDUAL");
  });

  it("a renewal updates the same entitlement instead of adding another", async () => {
    const t = await txn(C, "razorpay", "pay_2", "PLUS_INDIVIDUAL", indivId, "active", 30);
    await reconcile(t);
    await db.query(`UPDATE public.payment_transactions SET expires_at = now() + interval '60 days' WHERE id='${t}'`);
    await reconcile(t);
    expect(await count(t)).toBe(1);
    const e = (await db.query<{ expires_at: string }>(`SELECT expires_at FROM public.entitlements WHERE payment_transaction_id='${t}'`)).rows[0];
    expect(new Date(e.expires_at).getTime()).toBeGreaterThan(Date.now() + 50 * 86400000);
  });

  it("refunded, revoked and failed/pending transactions grant nothing", async () => {
    for (const status of ["refunded", "revoked", "pending", "failed"]) {
      const t = await txn(C, "razorpay", `pay_${status}`, "PLUS_INDIVIDUAL", indivId, status);
      await reconcile(t);
    }
    expect(await plan(C)).toBe("FREE");
  });

  it("refunding an active transaction removes access on the next reconcile", async () => {
    const t = await txn(C, "razorpay", "pay_r", "PLUS_INDIVIDUAL", indivId);
    await reconcile(t);
    expect(await plan(C)).toBe("PLUS_INDIVIDUAL");
    await db.query(`UPDATE public.payment_transactions SET status='refunded', refunded_at=now() WHERE id='${t}'`);
    await reconcile(t);
    expect(await plan(C)).toBe("FREE");
  });

  it("an expired subscription grants nothing", async () => {
    const t = await txn(C, "google_play", "gp_exp", "PLUS_INDIVIDUAL", indivId, "active", -1);
    await reconcile(t);
    expect(await plan(C)).toBe("FREE");
  });

  it("couple purchase covers the linked partner live, not the stranger, and stops on unlink", async () => {
    const t = await txn(A, "razorpay", "pay_c", "PLUS_COUPLE", coupleId);
    await reconcile(t);
    expect(await plan(A)).toBe("PLUS_COUPLE");
    expect(await plan(B)).toBe("PLUS_COUPLE");
    expect(await plan(C)).toBe("FREE");
    await db.exec(`UPDATE public.profiles SET partner_id = NULL WHERE user_id IN ('${A}','${B}')`);
    expect(await plan(B)).toBe("FREE");
  });

  it("provider switching / overlap: the highest plan wins, and each provider keeps its own entitlement row", async () => {
    const g = await txn(C, "google_play", "gp_1", "PLUS_INDIVIDUAL", indivId);
    const r = await txn(C, "razorpay", "pay_x", "PLUS_COUPLE", coupleId);
    await reconcile(g); await reconcile(r);
    expect(await plan(C)).toBe("PLUS_COUPLE");
    await db.query(`UPDATE public.payment_transactions SET status='expired' WHERE id='${r}'`);
    await reconcile(r);
    expect(await plan(C)).toBe("PLUS_INDIVIDUAL");
  });

  it("the same provider transaction id cannot be recorded twice", async () => {
    await txn(C, "razorpay", "dup_1", "PLUS_INDIVIDUAL", indivId);
    await expect(txn(C, "razorpay", "dup_1", "PLUS_INDIVIDUAL", indivId)).rejects.toThrow();
  });

  it("a client cannot write payment_transactions or call reconcile directly", async () => {
    const insertDenied = await asUser(db, C, async () => {
      try {
        await db.query(`INSERT INTO public.payment_transactions(user_id, provider, product_id, plan, amount_minor, currency, status) VALUES ('${C}','razorpay','${indivId}','PLUS_INDIVIDUAL',1,'INR','active')`);
        return "OK";
      } catch { return "DENIED"; }
    });
    expect(insertDenied).toBe("DENIED");
    const t = await txn(C, "razorpay", "pay_z", "PLUS_INDIVIDUAL", indivId);
    const rpcDenied = await asUser(db, C, async () => {
      try { await db.query(`SELECT public.reconcile_entitlement_from_transaction('${t}')`); return "OK"; } catch { return "DENIED"; }
    });
    expect(rpcDenied).toBe("DENIED");
  });
});

describe("reconcile_replaced_transaction (fixes the post-refactor replacement gap)", () => {
  it("revokes the OLD transaction's entitlement when replaced, without touching an unrelated user", async () => {
    const oldTxn = await txn(C, "google_play", "gp-old", "PLUS_INDIVIDUAL", indivId);
    await db.query(`UPDATE public.payment_transactions SET provider_purchase_token_hash='old-hash' WHERE id='${oldTxn}'`);
    await reconcile(oldTxn);
    expect(await plan(C)).toBe("PLUS_INDIVIDUAL");

    const newTxn = await txn(C, "google_play", "gp-new", "PLUS_INDIVIDUAL", indivId);
    await db.query(`UPDATE public.payment_transactions SET provider_purchase_token_hash='new-hash' WHERE id='${newTxn}'`);
    await reconcile(newTxn);

    // An unrelated active entitlement must survive untouched.
    const otherTxn = await txn(A, "razorpay", "pay_unrelated", "PLUS_INDIVIDUAL", indivId);
    await reconcile(otherTxn);

    await db.query(`SELECT public.reconcile_replaced_transaction('old-hash', '${newTxn}')`);

    const oldStatus = (await db.query<{ status: string }>(`SELECT status FROM public.payment_transactions WHERE id='${oldTxn}'`)).rows[0].status;
    expect(oldStatus).toBe("replaced");
    expect(await plan(C)).toBe("PLUS_INDIVIDUAL"); // still covered — via the NEW transaction
    expect(await plan(A)).toBe("PLUS_INDIVIDUAL"); // untouched
    const oldEntStatus = (await db.query<{ status: string }>(`SELECT status FROM public.entitlements WHERE payment_transaction_id='${oldTxn}'`)).rows[0].status;
    expect(oldEntStatus).toBe("revoked");
  });

  it("is a no-op (not an error) when there's nothing to replace", async () => {
    await expect(db.query(`SELECT public.reconcile_replaced_transaction('no-such-hash', '${await txn(C, "google_play", "gp-x", "PLUS_INDIVIDUAL", indivId)}')`)).resolves.toBeDefined();
  });
});
