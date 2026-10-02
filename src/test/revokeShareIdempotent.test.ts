/**
 * Phase 3F regression — found on the real staging Supabase project:
 * re-revoking an already-revoked share raised the DB trigger error and the
 * app threw REVOKE_FAILED. The fake below reproduces that trigger exactly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = { id: string; owner_id: string; kind: string; item_ref: string; revoked_at: string | null };
const rows: Row[] = [];
function table() {
  const f: { op: string; patch?: Partial<Row>; eqs: [string, unknown][]; isNull: string[] } = { op: "select", eqs: [], isNull: [] };
  const match = (r: Row) => f.eqs.every(([k, v]) => (r as Record<string, unknown>)[k] === v) && f.isNull.every((k) => (r as Record<string, unknown>)[k] === null);
  const api = {
    update(p: Partial<Row>) { f.op = "update"; f.patch = p; return api; },
    select() { return api; },
    eq(k: string, v: unknown) { f.eqs.push([k, v]); return api; },
    is(k: string, v: null) { if (v === null) f.isNull.push(k); return api; },
    async maybeSingle() {
      const r = rows.find(match);
      if (!r) return { data: null, error: null };
      if (f.op === "update") {
        if (r.revoked_at !== null) return { data: null, error: { code: "P0001", message: "relationship_shares: a revoked share cannot be un-revoked or re-dated" } };
        r.revoked_at = String(f.patch?.revoked_at);
      }
      return { data: { kind: r.kind, item_ref: r.item_ref }, error: null };
    },
  };
  return api;
}
vi.mock("@/integrations/supabase/appClient", () => ({ supabase: { from: () => table() } }));
const setValue = vi.fn(async (..._a: unknown[]) => {});
vi.mock("@/lib/relationship/stores", async (orig) => ({ ...(await orig<object>()), setValueShareState: (...a: unknown[]) => setValue(...a) }));

beforeEach(() => { rows.length = 0; setValue.mockClear(); });

describe("revokeShare is idempotent against the real trigger behaviour", () => {
  it("live share: revoked once, local state reset (unchanged behaviour)", async () => {
    const { revokeShare } = await import("@/lib/relationship/sharing");
    rows.push({ id: "s1", owner_id: "A", kind: "VALUE_ANSWER", item_ref: "q1", revoked_at: null });
    await revokeShare("A", "s1", { store: {} as never });
    expect(rows[0].revoked_at).not.toBeNull();
    expect(setValue).toHaveBeenCalledTimes(1);
  });
  it("already revoked (e.g. by unlink): no error, and the local shared flag is still cleared", async () => {
    const { revokeShare } = await import("@/lib/relationship/sharing");
    rows.push({ id: "s1", owner_id: "A", kind: "VALUE_ANSWER", item_ref: "q1", revoked_at: "2026-09-26T00:00:00Z" });
    await expect(revokeShare("A", "s1", { store: {} as never })).resolves.toBeUndefined();
    expect(rows[0].revoked_at).toBe("2026-09-26T00:00:00Z"); // not re-dated
    expect(setValue).toHaveBeenCalledTimes(1);
  });
  it("someone else's share: silent no-op, nothing leaked or changed", async () => {
    const { revokeShare } = await import("@/lib/relationship/sharing");
    rows.push({ id: "s1", owner_id: "B", kind: "VALUE_ANSWER", item_ref: "q1", revoked_at: null });
    await revokeShare("A", "s1", { store: {} as never });
    expect(rows[0].revoked_at).toBeNull();
    expect(setValue).not.toHaveBeenCalled();
  });
});
