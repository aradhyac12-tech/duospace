import { describe, it, expect, vi } from "vitest";
import { reconcileSharedState, withdrawAllMemorySharesVerified, createMemory, deleteMemory, emptyMemoryState, setShared } from "@/lib/relationship/memory";
import type { ShareRow } from "@/lib/relationship/types";

const NOW = Date.parse("2026-09-25T12:00:00Z");
const mk = (statement: string) => createMemory(emptyMemoryState(), { ownerUserId: "A", relationshipId: null, category: "PREFERENCE", topic: "planning", statement, sourceType: "USER_ENTERED", sourceId: "s", sourceTimestamp: "2026-09-25" }, { nowMs: NOW, newId: () => `m-${statement}`, consentStore: true });
const row = (id: string, extra: Partial<ShareRow> = {}) => ({ id, ownerId: "A", recipientId: "B", kind: "MEMORY", revokedAt: null, ...extra } as unknown as ShareRow);

describe("reconcile local SHARED flags with the server (stale state)", () => {
  it("unlink auto-revoked the share → local memory becomes private", () => {
    const r = mk("x"); const s = setShared(r.state, r.memory.memoryId, "A", "sh1");
    const out = reconcileSharedState(s, [row("sh1", { revokedAt: "2026-09-25" })], "A");
    expect(out.changed).toBe(1);
    expect(out.state.memories[0]).toMatchObject({ shareId: null, visibility: "PRIVATE", status: "USER_APPROVED" });
  });
  it("still-live share is left alone; nothing is ever marked shared from server rows", () => {
    const r = mk("x"); const s = setShared(r.state, r.memory.memoryId, "A", "sh1");
    expect(reconcileSharedState(s, [row("sh1")], "A").changed).toBe(0);
    expect(reconcileSharedState(r.state, [row("sh1")], "A").state.memories[0].shareId).toBeNull();
  });
  it("a deleted memory is not resurrected by a server row that still references it", () => {
    const r = mk("x"); const s = deleteMemory(setShared(r.state, r.memory.memoryId, "A", "sh1"), r.memory.memoryId, "A");
    expect(reconcileSharedState(s, [row("sh1")], "A").state.memories).toEqual([]);
  });
});

describe("withdraw-then-verify (delete-all / consent-off)", () => {
  it("offline: the list failing aborts BEFORE anything is deleted (was: silently [] → local wipe with shares left)", async () => {
    await expect(withdrawAllMemorySharesVerified(async () => { throw new Error("offline"); }, "A", vi.fn())).rejects.toThrow("offline");
  });
  it("a share created concurrently (other device) is caught by the second list → not ok", async () => {
    let calls = 0;
    const list = async () => (++calls === 1 ? [row("s1")] : [row("s2")]);
    const r = await withdrawAllMemorySharesVerified(list, "A", async () => {});
    expect(r).toMatchObject({ ok: false, remaining: ["s2"] });
  });
  it("happy path; duplicate withdrawal is harmless (revoke is idempotent)", async () => {
    const live = new Set(["s1", "s2"]);
    const list = async () => [...live].map((id) => row(id));
    const unshare = async (id: string) => { live.delete(id); };
    expect(await withdrawAllMemorySharesVerified(list, "A", unshare)).toMatchObject({ ok: true, withdrawn: 2, remaining: [] });
    expect(await withdrawAllMemorySharesVerified(list, "A", unshare)).toMatchObject({ ok: true, withdrawn: 0 });
  });
  it("one failed withdrawal → not ok", async () => {
    const r = await withdrawAllMemorySharesVerified(async () => [row("s1")], "A", async () => { throw new Error("x"); });
    expect(r.ok).toBe(false);
  });
});
