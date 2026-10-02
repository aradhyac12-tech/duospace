/**
 * Phase 3C — REPAIR_MESSAGE shares on REAL Postgres (PGlite) with RLS as `authenticated`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser } from "./pgliteHarness";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FILES = ["20260910140000_lock_get_partner_id_to_self.sql", "20260922100000_relationship_shares.sql", "20260922100100_unlink_revokes_relationship_shares.sql", "20260923130000_relationship_shares_permanent_revoke.sql", "20260925180000_relationship_shares_repair_message.sql", "20260925190000_repair_message_in_reply_to.sql"];
let db: PGlite;
beforeEach(async () => {
  db = await makeDb(FILES);
  await db.exec(`INSERT INTO auth.users VALUES ('${A}'),('${B}'),('${C}');
    INSERT INTO public.profiles VALUES ('${A}','${B}'),('${B}','${A}'),('${C}',NULL);`);
}, 30_000);

const insert = (owner: string, recipient: string, payload: unknown) => asUser(db, owner, async () => {
  try { const r = await db.query<{ id: string }>(`INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash) VALUES ($1,$2,'REPAIR_MESSAGE','session-1',$3,'h') RETURNING id`, [owner, recipient, JSON.stringify(payload)]); return { ok: true as const, id: r.rows[0].id }; }
  catch (e) { return { ok: false as const, error: String((e as Error).message) }; }
});
const visible = (u: string) => asUser(db, u, async () => (await db.query<{ id: string; payload: unknown }>(`SELECT id, payload FROM public.relationship_shares`)).rows);
const MSG = { v: 1, kind: "REPAIR_MESSAGE", message: "I take responsibility for raising my voice. What was happening for you?" };

describe("REPAIR_MESSAGE shares (real Postgres + RLS)", () => {
  it("owner can share a message-only payload with the current partner; partner reads it, stranger can't", async () => {
    const r = await insert(A, B, MSG);
    expect(r.ok).toBe(true);
    expect((await visible(B)).map((x) => x.payload)).toEqual([MSG]);
    expect(await visible(C)).toEqual([]);
  });
  it("server rejects any hidden extra field (analysis, safety flags, confidence, notes)", async () => {
    for (const extra of [{ analysis: "x" }, { safetyState: "CLEAR" }, { confidence: "SUPPORTED" }, { privateNotes: "x" }, { facts: [] }]) {
      expect((await insert(A, B, { ...MSG, ...extra })).ok, JSON.stringify(extra)).toBe(false);
    }
  });
  it("server rejects empty, non-string and over-long messages, and mismatched payload kind", async () => {
    expect((await insert(A, B, { ...MSG, message: "" })).ok).toBe(false);
    expect((await insert(A, B, { ...MSG, message: 42 })).ok).toBe(false);
    expect((await insert(A, B, { ...MSG, message: "x".repeat(2001) })).ok).toBe(false);
    expect((await insert(A, B, { ...MSG, kind: "INSIGHT" })).ok).toBe(false);
  });
  it("can't share to a non-partner or as someone else", async () => {
    expect((await insert(A, C, MSG)).ok).toBe(false);
    expect((await asUser(db, C, async () => { try { await db.query(`INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash) VALUES ($1,$2,'REPAIR_MESSAGE','s',$3,'h')`, [A, B, JSON.stringify(MSG)]); return true; } catch { return false; } }))).toBe(false);
  });
  it("withdraw (owner revoke) removes partner access; partner can't withdraw it", async () => {
    const r = await insert(A, B, MSG);
    if (!r.ok) throw new Error(r.error);
    await asUser(db, B, () => db.query(`UPDATE public.relationship_shares SET revoked_at = now() WHERE id = $1`, [r.id])).catch(() => undefined);
    expect(await visible(B)).toHaveLength(1);
    await asUser(db, A, () => db.query(`UPDATE public.relationship_shares SET revoked_at = now() WHERE id = $1`, [r.id]));
    expect(await visible(B)).toEqual([]);
  });
  it("existing kinds still work after the constraint change", async () => {
    const ok = await asUser(db, A, async () => { try { await db.query(`INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash) VALUES ($1,$2,'VALUE_ANSWER','q','{"v":1}','h')`, [A, B]); return true; } catch { return false; } });
    expect(ok).toBe(true);
  });

  it("a reply may reference the original by uuid — and nothing else rides along", async () => {
    const first = await insert(A, B, MSG);
    if (!first.ok) throw new Error(first.error);
    expect((await insert(B, A, { v: 1, kind: "REPAIR_MESSAGE", message: "I was stressed, thanks for asking.", inReplyTo: first.id })).ok).toBe(true);
    expect((await visible(A)).length).toBe(2); // A sees own row + B's reply
    expect((await insert(B, A, { v: 1, kind: "REPAIR_MESSAGE", message: "x", inReplyTo: "not-a-uuid" })).ok).toBe(false);
    expect((await insert(B, A, { v: 1, kind: "REPAIR_MESSAGE", message: "x", inReplyTo: 42 })).ok).toBe(false);
    expect((await insert(B, A, { v: 1, kind: "REPAIR_MESSAGE", message: "x", inReplyTo: first.id, analysis: "y" })).ok).toBe(false);
  });
});
