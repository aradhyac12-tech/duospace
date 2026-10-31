/** Phase 3D — MEMORY / AGREEMENT / AGREEMENT_RESPONSE shares on REAL Postgres (PGlite) with RLS. */
import { describe, it, expect, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser } from "./pgliteHarness";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FILES = ["20260910140000_lock_get_partner_id_to_self.sql", "20260922100000_relationship_shares.sql", "20260922100100_unlink_revokes_relationship_shares.sql", "20260923130000_relationship_shares_permanent_revoke.sql", "20260925180000_relationship_shares_repair_message.sql", "20260925200000_relationship_shares_memory_agreements.sql"];
let db: PGlite;
let seq = 0;
beforeEach(async () => {
  db = await makeDb(FILES);
  await db.exec(`INSERT INTO auth.users VALUES ('${A}'),('${B}'),('${C}'); INSERT INTO public.profiles VALUES ('${A}','${B}'),('${B}','${A}'),('${C}',NULL);`);
}, 30_000);
const ins = (owner: string, recipient: string, kind: string, payload: unknown) => asUser(db, owner, async () => {
  try { const r = await db.query<{ id: string }>(`INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash) VALUES ($1,$2,$3,$5,$4,'h') RETURNING id`, [owner, recipient, kind, JSON.stringify(payload), `item-${++seq}`]); return r.rows[0].id; }
  catch (e) { if (process.env.DBG) console.error(String((e as Error).message)); return null; }
});
const seen = (u: string) => asUser(db, u, async () => (await db.query(`SELECT kind FROM public.relationship_shares`)).rows.length);
const MEM = { v: 1, kind: "MEMORY", memoryId: "m1", category: "BOUNDARY", topic: "privacy", statement: "I don't want my phone checked without permission.", position: null, lastConfirmedAt: "2026-09-25T00:00:00Z" };
const AG = { v: 1, kind: "AGREEMENT", agreementId: "g1", topic: "planning", text: "Tell each other if plans change by 30+ minutes.", reviewDate: null };
const RESP = { v: 1, kind: "AGREEMENT_RESPONSE", agreementId: "g1", response: "ACCEPTED" };

describe("memory/agreement shares (real Postgres + RLS)", () => {
  it("valid payloads to the current partner are accepted and visible only to owner + partner", async () => {
    expect(await ins(A, B, "MEMORY", MEM)).toBeTruthy();
    expect(await ins(A, B, "AGREEMENT", AG)).toBeTruthy();
    expect(await ins(B, A, "AGREEMENT_RESPONSE", RESP)).toBeTruthy();
    expect(await seen(A)).toBe(3); expect(await seen(B)).toBe(3); expect(await seen(C)).toBe(0);
  });
  it("server rejects extra keys (history, other memories, AI output, safety state) and bad values", async () => {
    for (const bad of [{ ...MEM, history: [] }, { ...MEM, otherMemories: [] }, { ...MEM, aiSummary: "x" }, { ...MEM, category: "PERSONALITY" }, { ...MEM, statement: "" }, { ...MEM, statement: "x".repeat(401) }]) expect(await ins(A, B, "MEMORY", bad), JSON.stringify(Object.keys(bad))).toBeNull();
    expect(await ins(A, B, "AGREEMENT", { ...AG, acceptedBy: [A, B] })).toBeNull(); // a proposer can't write the partner's acceptance
    expect(await ins(B, A, "AGREEMENT_RESPONSE", { ...RESP, response: "MAYBE" })).toBeNull();
    expect(await ins(B, A, "AGREEMENT_RESPONSE", { ...RESP, score: 5 })).toBeNull();
  });
  it("no sharing to strangers; owner unshare removes partner access", async () => {
    expect(await ins(A, C, "MEMORY", MEM)).toBeNull();
    const id = await ins(A, B, "MEMORY", MEM);
    await asUser(db, A, () => db.query(`UPDATE public.relationship_shares SET revoked_at = now() WHERE id = $1`, [id]));
    expect(await seen(B)).toBe(0);
  });
  it("earlier kinds keep working", async () => {
    expect(await ins(A, B, "REPAIR_MESSAGE", { v: 1, kind: "REPAIR_MESSAGE", message: "hi" })).toBeTruthy();
    expect(await ins(A, B, "VALUE_ANSWER", { v: 1 })).toBeTruthy();
  });
});
