/**
 * Phase 3B: end-to-end privacy — rows read through REAL Postgres RLS feed the
 * Phase 3A comparison. A stranger (or a revoked share) yields nothing to compare.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { makeDb, asUser } from "./pgliteHarness";
import { compareDyad, partnerItemsFromShares, selfItemsFromValues } from "@/lib/relationship/dyadic";
import type { ShareRow } from "@/lib/relationship/types";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FILES = ["20260910140000_lock_get_partner_id_to_self.sql", "20260922100000_relationship_shares.sql", "20260922100100_unlink_revokes_relationship_shares.sql", "20260923130000_relationship_shares_permanent_revoke.sql"];
let db: PGlite;

beforeEach(async () => {
  db = await makeDb(FILES);
  await db.exec(`INSERT INTO auth.users VALUES ('${A}'),('${B}'),('${C}');
    INSERT INTO public.profiles VALUES ('${A}','${B}'),('${B}','${A}'),('${C}',NULL);`);
  await asUser(db, A, () => db.query(`INSERT INTO public.relationship_shares (owner_id, recipient_id, kind, item_ref, payload, payload_hash)
    VALUES ($1,$2,'VALUE_ANSWER','comm-1','{"v":1,"kind":"VALUE_ANSWER","questionId":"comm-1","mode":"ANSWERED","choiceId":"few"}','h')`, [A, B]));
}, 30_000);

const readAs = (u: string) => asUser(db, u, async () => (await db.query<Record<string, string>>(
  `SELECT id, owner_id, recipient_id, kind, item_ref, payload, created_at, expires_at, revoked_at FROM public.relationship_shares`)).rows.map((r): ShareRow => ({
  id: r.id, ownerId: r.owner_id, recipientId: r.recipient_id, kind: r.kind as ShareRow["kind"], itemRef: r.item_ref,
  payload: (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as ShareRow["payload"],
  createdAt: new Date(r.created_at).toISOString(), expiresAt: new Date(r.expires_at).toISOString(), revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
})));
const mine = (u: string) => selfItemsFromValues({ version: 1, answers: [{ id: "comm-1", questionId: "comm-1", category: "COMMUNICATION", mode: "ANSWERED", choiceId: "often", note: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), visibility: "PRIVATE", shareId: null } as never], skippedCategories: [] });

describe("dyadic comparison over real RLS", () => {
  it("partner B sees A's explicit share → DIFFERENT", async () => {
    const c = compareDyad(mine(B), partnerItemsFromShares(await readAs(B), B, A, Date.now()), [], Date.now())[0];
    expect(c.status).toBe("DIFFERENT");
  });
  it("stranger C gets no rows at all → UNKNOWN", async () => {
    expect(await readAs(C)).toEqual([]);
    const c = compareDyad(mine(C), partnerItemsFromShares(await readAs(C), C, A, Date.now()), [], Date.now())[0];
    expect(c.unknownReason).toBe("PARTNER_NOT_SHARED");
  });
  it("after A revokes, B's comparison drops to UNKNOWN", async () => {
    await asUser(db, A, () => db.query(`UPDATE public.relationship_shares SET revoked_at = now() WHERE owner_id = $1`, [A]));
    const c = compareDyad(mine(B), partnerItemsFromShares(await readAs(B), B, A, Date.now()), [], Date.now())[0];
    expect(c.status).toBe("UNKNOWN");
  });
});
