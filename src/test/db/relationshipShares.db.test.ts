/**
 * relationship_shares — executed against REAL Postgres (PGlite) using the
 * actual migration files, with RLS enforced as the `authenticated` role.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser } from "./pgliteHarness";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // owner
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; // partner
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // stranger

const FILES = [
  "20260910140000_lock_get_partner_id_to_self.sql",
  "20260922100000_relationship_shares.sql",
  "20260922100100_unlink_revokes_relationship_shares.sql",
  "20260923130000_relationship_shares_permanent_revoke.sql",
];

let db: PGlite;
async function share(owner = A, recipient = B, item = "q1"): Promise<string> {
  return asUser(db, owner, async () => {
    const r = await db.query<{ id: string }>(
      `INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash)
       VALUES ($1, $2, 'VALUE_ANSWER', $3, '{"v":1}', 'h') RETURNING id`, [owner, recipient, item]);
    return r.rows[0].id;
  });
}
const visibleTo = (u: string) => asUser(db, u, async () =>
  (await db.query<{ id: string }>(`SELECT id FROM public.relationship_shares`)).rows.map((r) => r.id));
const tryAs = async (u: string, sql: string, params: unknown[] = []) => {
  try { const r = await asUser(db, u, () => db.query(sql, params)); return { ok: true, affected: r.affectedRows ?? 0 }; }
  catch (e) { return { ok: false, error: String((e as Error).message) }; }
};

beforeEach(async () => {
  db = await makeDb(FILES);
  await db.exec(`INSERT INTO auth.users VALUES ('${A}'),('${B}'),('${C}');
    INSERT INTO public.profiles VALUES ('${A}','${B}'),('${B}','${A}'),('${C}',NULL);`);
}, 30_000);

describe("relationship_shares (real Postgres + RLS)", () => {
  it("owner can share with the CURRENT partner only", async () => {
    const id = await share();
    expect(id).toBeTruthy();
    const toStranger = await tryAs(A, `INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash) VALUES ($1,$2,'INSIGHT','x','{}','h')`, [A, C]);
    expect(toStranger.ok).toBe(false);
    const asSomeoneElse = await tryAs(C, `INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash) VALUES ($1,$2,'INSIGHT','x','{}','h')`, [A, B]);
    expect(asSomeoneElse.ok).toBe(false);
  });

  it("partner can read it; a stranger cannot", async () => {
    const id = await share();
    expect(await visibleTo(B)).toEqual([id]);
    expect(await visibleTo(C)).toEqual([]);
  });

  it("client cannot choose lifecycle fields on insert (no pre-revoked / far-future / back-dated rows)", async () => {
    const r = await asUser(db, A, () => db.query<{ expires_at: string; revoked_at: string | null; created_at: string }>(
      `INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash, expires_at, revoked_at, created_at)
       VALUES ($1,$2,'INSIGHT','x','{}','h', now() + interval '10 years', now(), now() - interval '5 years')
       RETURNING expires_at, revoked_at, created_at`, [A, B]));
    const row = r.rows[0];
    expect(row.revoked_at).toBeNull();
    expect(new Date(row.expires_at).getTime()).toBeLessThanOrEqual(Date.now() + 181 * 864e5);
    expect(Math.abs(new Date(row.created_at).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("owner revoke removes partner access", async () => {
    const id = await share();
    const rev = await tryAs(A, `UPDATE public.relationship_shares SET revoked_at = now() WHERE id = $1`, [id]);
    expect(rev.ok).toBe(true);
    expect(await visibleTo(B)).toEqual([]);
    expect(await visibleTo(A)).toEqual([id]); // owner still sees own (revoked) record
  });

  it("a revoked share can NEVER be resurrected or re-dated", async () => {
    const id = await share();
    await tryAs(A, `UPDATE public.relationship_shares SET revoked_at = now() WHERE id = $1`, [id]);
    const resurrect = await tryAs(A, `UPDATE public.relationship_shares SET revoked_at = NULL WHERE id = $1`, [id]);
    expect(resurrect.ok).toBe(false);
    expect(resurrect.error).toMatch(/cannot be un-revoked/);
    const redate = await tryAs(A, `UPDATE public.relationship_shares SET revoked_at = now() + interval '1 day' WHERE id = $1`, [id]);
    expect(redate.ok).toBe(false);
    expect(await visibleTo(B)).toEqual([]);
  });

  it("revocation timestamp is server time (a future-dated 'revoke' cannot keep access alive)", async () => {
    const id = await share();
    await tryAs(A, `UPDATE public.relationship_shares SET revoked_at = now() + interval '30 days' WHERE id = $1`, [id]);
    expect(await visibleTo(B)).toEqual([]);
  });

  it("identity/content/expiry of an existing share cannot be changed", async () => {
    const id = await share();
    for (const set of [`recipient_id = '${C}'`, `owner_id = '${C}'`, `payload = '{"v":2}'`, `item_ref = 'other'`, `kind = 'INSIGHT'`, `expires_at = now() + interval '5 years'`, `payload_hash = 'x'`]) {
      const r = await tryAs(A, `UPDATE public.relationship_shares SET ${set} WHERE id = $1`, [id]);
      expect(r.ok, set).toBe(false);
    }
  });

  it("the partner (recipient) and strangers cannot revoke, edit or delete someone else's share", async () => {
    const id = await share();
    for (const u of [B, C]) {
      const upd = await tryAs(u, `UPDATE public.relationship_shares SET revoked_at = now() WHERE id = $1`, [id]);
      expect(upd.ok ? upd.affected : 0).toBe(0); // RLS: row not updatable → 0 rows
      const del = await tryAs(u, `DELETE FROM public.relationship_shares WHERE id = $1`, [id]);
      expect(del.ok ? del.affected : 0).toBe(0);
    }
    expect(await visibleTo(B)).toEqual([id]);
  });

  it("unlink revokes every share both ways, and access stays gone afterwards", async () => {
    const ab = await share(A, B, "q1");
    const ba = await share(B, A, "q2");
    await db.exec(`SELECT private.apply_unlink('${A}', '${B}')`);
    expect(await visibleTo(B)).toEqual([ba]); // B keeps only its OWN (now revoked) record — A's share is gone
    expect(await visibleTo(A)).toEqual([ab]); // and vice versa
    const revoked = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.relationship_shares WHERE revoked_at IS NOT NULL`);
    expect(revoked.rows[0].n).toBe(2);
    // Even re-linking later does not resurrect old shares.
    await db.exec(`UPDATE public.profiles SET partner_id='${B}' WHERE user_id='${A}'; UPDATE public.profiles SET partner_id='${A}' WHERE user_id='${B}';`);
    expect(await visibleTo(B)).toEqual([ba]); // only B's own
    const resurrect = await tryAs(A, `UPDATE public.relationship_shares SET revoked_at = NULL WHERE id = $1`, [ab]);
    expect(resurrect.ok).toBe(false);
  });

  it("post-unlink: an un-revoked row (e.g. written before this migration) is still unreadable by a non-partner", async () => {
    const id = await share();
    await db.exec(`UPDATE public.profiles SET partner_id = NULL WHERE user_id IN ('${A}','${B}')`); // unlink WITHOUT the revoke step
    expect(await visibleTo(B)).toEqual([]);
    expect(await visibleTo(A)).toEqual([id]);
  });
});
