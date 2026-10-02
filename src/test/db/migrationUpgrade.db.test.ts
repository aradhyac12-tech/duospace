/**
 * Phase 3E — migration safety on UPGRADE (not just fresh): apply the schema
 * as it would exist on a live project, add existing data, then apply the
 * newer migrations and check they succeed and preserve compatible data.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { makeDb, asUser } from "./pgliteHarness";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BASE = ["20260910140000_lock_get_partner_id_to_self.sql", "20260922100000_relationship_shares.sql", "20260922100100_unlink_revokes_relationship_shares.sql", "20260923130000_relationship_shares_permanent_revoke.sql", "20260925180000_relationship_shares_repair_message.sql", "20260925190000_repair_message_in_reply_to.sql", "20260925200000_relationship_shares_memory_agreements.sql"];
const apply = (db: Awaited<ReturnType<typeof makeDb>>, f: string) => db.exec(readFileSync(`supabase/migrations/${f}`, "utf8"));
const ins = (db: Awaited<ReturnType<typeof makeDb>>, kind: string, payload: unknown, ref: string) => asUser(db, A, () => db.query(`INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash) VALUES ($1,$2,$3,$4,$5,'h')`, [A, B, kind, ref, JSON.stringify(payload)]));

describe("upgrade path to 20260925210000", () => {
  it("succeeds on a database that already holds a non-conforming MEMORY share, withdraws it, keeps valid rows", async () => {
    const db = await makeDb(BASE);
    await db.exec(`INSERT INTO auth.users VALUES ('${A}'),('${B}'); INSERT INTO public.profiles VALUES ('${A}','${B}'),('${B}','${A}');`);
    const good = { v: 1, kind: "MEMORY", memoryId: "m1", category: "PREFERENCE", topic: "planning", statement: "ok", position: { key: "notice", value: "yes" }, lastConfirmedAt: "2026-09-25" };
    await ins(db, "MEMORY", good, "m1");
    await ins(db, "MEMORY", { ...good, memoryId: "m2", position: { key: "x", value: "no", hidden: "leaked text" } }, "m2");
    await ins(db, "REPAIR_MESSAGE", { v: 1, kind: "REPAIR_MESSAGE", message: "hi" }, "r1");
    await apply(db, "20260925210000_memory_share_payload_hardening.sql"); // must not throw
    const rows = (await db.query<{ item_ref: string; revoked_at: string | null }>(`SELECT item_ref, revoked_at FROM public.relationship_shares ORDER BY item_ref`)).rows;
    expect(rows.find((r) => r.item_ref === "m1")!.revoked_at).toBeNull();
    expect(rows.find((r) => r.item_ref === "m2")!.revoked_at).not.toBeNull(); // non-conforming legacy share withdrawn
    expect(rows.find((r) => r.item_ref === "r1")!.revoked_at).toBeNull();
    const partnerSees = await asUser(db, B, async () => (await db.query<{ item_ref: string }>(`SELECT item_ref FROM public.relationship_shares`)).rows.map((r) => r.item_ref).sort());
    expect(partnerSees).toEqual(["m1", "r1"]);
    // new non-conforming rows are rejected
    await expect(ins(db, "MEMORY", { ...good, memoryId: "m3", position: { key: "x", value: "no", hidden: 1 } }, "m3")).rejects.toThrow();
  }, 30_000);
  it("is idempotent (re-running the migration is harmless)", async () => {
    const db = await makeDb([...BASE, "20260925210000_memory_share_payload_hardening.sql"]);
    await apply(db, "20260925210000_memory_share_payload_hardening.sql");
  }, 30_000);
});
