/**
 * Phase 3D forensic audit — RLS and payload proofs on REAL Postgres (PGlite),
 * with EVERY relationship_shares migration applied in order (incl. the audit
 * hardening 20260925210000).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser } from "./pgliteHarness";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FILES = ["20260910140000_lock_get_partner_id_to_self.sql", "20260922100000_relationship_shares.sql", "20260922100100_unlink_revokes_relationship_shares.sql", "20260923130000_relationship_shares_permanent_revoke.sql", "20260925180000_relationship_shares_repair_message.sql", "20260925190000_repair_message_in_reply_to.sql", "20260925200000_relationship_shares_memory_agreements.sql", "20260925210000_memory_share_payload_hardening.sql", "20260926100000_relationship_shares_trigger_search_path.sql"];
let db: PGlite; let seq = 0;
beforeEach(async () => {
  db = await makeDb(FILES);
  await db.exec(`INSERT INTO auth.users VALUES ('${A}'),('${B}'),('${C}'); INSERT INTO public.profiles VALUES ('${A}','${B}'),('${B}','${A}'),('${C}',NULL);`);
}, 30_000);
const ins = (owner: string, recipient: string, kind: string, payload: unknown) => asUser(db, owner, async () => {
  try { const r = await db.query<{ id: string }>(`INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash) VALUES ($1,$2,$3,$5,$4,'h') RETURNING id`, [owner, recipient, kind, JSON.stringify(payload), `i-${++seq}`]); return r.rows[0].id; }
  catch { return null; }
});
const rows = (u: string) => asUser(db, u, async () => (await db.query<{ id: string; kind: string }>(`SELECT id, kind FROM public.relationship_shares WHERE revoked_at IS NULL`)).rows);
const MEM = { v: 1, kind: "MEMORY", memoryId: "m1", category: "BOUNDARY", topic: "privacy", statement: "I don't want my phone checked.", position: { key: "phone_checks", value: "no" }, lastConfirmedAt: "2026-09-25T00:00:00Z" };
const AG = { v: 1, kind: "AGREEMENT", agreementId: "g1", topic: "planning", text: "Tell each other if plans change.", reviewDate: null };

describe("Phase 3D audit — RLS proofs", () => {
  it("A's shared memory is readable by partner B only; stranger C sees nothing", async () => {
    expect(await ins(A, B, "MEMORY", MEM)).toBeTruthy();
    expect((await rows(B)).map((r) => r.kind)).toEqual(["MEMORY"]);
    expect(await rows(C)).toEqual([]);
  });
  it("private memory never reaches the server: there is no table for it (only explicit share rows exist)", async () => {
    const tables = await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`);
    expect(tables.rows.map((r) => r.table_name).filter((t) => /memor|longitud|agreement|repair/i.test(t))).toEqual([]);
  });
  it("B cannot modify, delete or withdraw A's memory share; C cannot insert as A", async () => {
    const id = await ins(A, B, "MEMORY", MEM);
    const tryAs = (u: string, sql: string) => asUser(db, u, async () => { try { const r = await db.query(sql, [id]); return (r as { affectedRows?: number }).affectedRows ?? 0; } catch { return -1; } });
    expect(await tryAs(B, `UPDATE public.relationship_shares SET payload = '{"x":1}' WHERE id = $1`)).toBeLessThanOrEqual(0);
    expect(await tryAs(B, `DELETE FROM public.relationship_shares WHERE id = $1`)).toBeLessThanOrEqual(0);
    expect(await tryAs(B, `UPDATE public.relationship_shares SET revoked_at = now() WHERE id = $1`)).toBeLessThanOrEqual(0);
    expect((await rows(B)).length).toBe(1);
    expect(await asUser(db, C, async () => { try { await db.query(`INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash) VALUES ($1,$2,'MEMORY','x',$3,'h')`, [A, B, JSON.stringify(MEM)]); return true; } catch { return false; } })).toBe(false);
  });
  it("being linked does not expose anything that wasn't explicitly shared; a withdrawn share is gone", async () => {
    expect(await rows(B)).toEqual([]);
    const id = await ins(A, B, "MEMORY", MEM);
    await asUser(db, A, () => db.query(`UPDATE public.relationship_shares SET revoked_at = now() WHERE id = $1`, [id]));
    expect(await rows(B)).toEqual([]);
  });
  it("AUDIT FIX D3: position can no longer carry hidden data; bad ids/topics rejected; valid payloads still pass", async () => {
    expect(await ins(A, B, "MEMORY", MEM)).toBeTruthy();
    expect(await ins(A, B, "MEMORY", { ...MEM, memoryId: "m2", position: null })).toBeTruthy();
    for (const bad of [
      { position: { key: "x", value: "no", hidden: "full chat history…" } },
      { position: { key: "x", value: "maybe" } },
      { position: { key: "X Y!", value: "no" } },
      { position: "free text" },
      { position: [1, 2, 3] },
      { memoryId: "m".repeat(65) },
      { memoryId: 42 },
      { topic: "sex_life" },
      { lastConfirmedAt: "x".repeat(41) },
    ]) expect(await ins(A, B, "MEMORY", { ...MEM, ...bad }), JSON.stringify(bad)).toBeNull();
    expect(await ins(A, B, "AGREEMENT", AG)).toBeTruthy();
    expect(await ins(A, B, "AGREEMENT", { ...AG, agreementId: "g".repeat(65) })).toBeNull();
    expect(await ins(A, B, "AGREEMENT", { ...AG, topic: "whatever" })).toBeNull();
    expect(await ins(A, B, "AGREEMENT", { ...AG, reviewDate: { hidden: 1 } })).toBeNull();
    expect(await ins(B, A, "AGREEMENT_RESPONSE", { v: 1, kind: "AGREEMENT_RESPONSE", agreementId: 7, response: "ACCEPTED" })).toBeNull();
  });
  it("earlier kinds still work with every migration applied", async () => {
    expect(await ins(A, B, "REPAIR_MESSAGE", { v: 1, kind: "REPAIR_MESSAGE", message: "hi" })).toBeTruthy();
    expect(await ins(A, B, "VALUE_ANSWER", { v: 1 })).toBeTruthy();
  });
});
