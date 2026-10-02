import { describe, it, expect, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { changeMemory, withdrawAllMemoryShares, liveMemoryShares, compareTopics, currency, createMemory, correctMemory, markOutdated, selectContext, summarize, emptyMemoryState, agreementStatus, type MemoryState, type Agreement } from "@/lib/relationship/memory";
import type { ShareRow } from "@/lib/relationship/types";

const NOW = Date.parse("2026-09-25T12:00:00Z");
let n = 0; const id = () => `id${++n}`;
const ctx = { nowMs: NOW, newId: id, consentStore: true };
const ALL = { store: true, useInAI: true, share: true, longitudinal: true };
const mem = (s: MemoryState, owner: string, statement: string, value: "yes" | "no", extra: object = {}) =>
  createMemory(s, { ownerUserId: owner, relationshipId: null, category: "PREFERENCE", topic: "communication", statement, position: { key: "daily_calls", value }, sourceType: "USER_ENTERED", sourceId: id(), sourceTimestamp: new Date(NOW).toISOString(), ...extra }, ctx);
const asShared = (m: ReturnType<typeof mem>["memory"]) => ({ ...m, visibility: "SHARED" as const, status: "SHARED" as const });

describe("§9 partner asymmetry", () => {
  it("A prefers daily calls, B doesn't → DIFFERENT, never a 'couple preference'", () => {
    const a = mem(emptyMemoryState(), "A", "I prefer daily calls.", "yes").memory;
    const b = asShared(mem(emptyMemoryState(), "B", "I do not prefer daily calls.", "no").memory);
    const [c] = compareTopics([a], [b], [], "A", "B", NOW);
    expect(c.status).toBe("DIFFERENT");
    const s = summarize({ ...emptyMemoryState(), memories: [a] }, [b], { me: "A", partner: "B", consents: ALL, nowMs: NOW });
    expect(JSON.stringify(s)).not.toMatch(/couple|you both prefer|shared preference/i);
  });
  it("A's boundary that B hasn't confirmed is A's stated boundary — never a shared one", () => {
    const a = createMemory(emptyMemoryState(), { ownerUserId: "A", relationshipId: null, category: "BOUNDARY", topic: "privacy", statement: "Don't check my phone.", sourceType: "USER_ENTERED", sourceId: "s", sourceTimestamp: new Date(NOW).toISOString() }, ctx).memory;
    const [c] = compareTopics([a], [], [], "A", "B", NOW);
    expect(c.status).toBe("NOT_YET_DISCUSSED");
    expect(c.sharedAgreement).toBeNull();
    const ag: Agreement = { agreementId: "g", topic: "privacy", text: "x", proposedBy: "A", participants: ["A", "B"], createdAt: new Date(NOW).toISOString(), reviewDate: null, confirmations: { A: "ACCEPTED" }, status: "PROPOSED", shareId: null };
    expect(agreementStatus(ag, NOW)).toBe("ACCEPTED_BY_ONE"); // proposing ≠ partner agreeing
  });
  it("a partner's memory that isn't SHARED is ignored", () => {
    const b = mem(emptyMemoryState(), "B", "x", "no").memory; // PRIVATE
    expect(compareTopics([], [b], [], "A", "B", NOW)).toEqual([]);
  });
});

describe("§10 temporal", () => {
  it("a changed preference: the old value is HISTORICAL and never current, in comparisons, AI context or summaries", () => {
    const r = mem(emptyMemoryState(), "A", "I prefer daily calls.", "yes");
    const c = correctMemory(r.state, r.memory.memoryId, "A", { statement: "Every other day is fine now.", position: { key: "daily_calls", value: "no" } }, ctx);
    const old = c.state.memories.find((m) => m.memoryId === r.memory.memoryId)!;
    expect(currency(old, NOW)).toBe("HISTORICAL");
    expect(selectContext(c.state.memories, { consents: ALL, nowMs: NOW }).map((m) => m.statement)).toEqual(["Every other day is fine now."]);
    expect(compareTopics(c.state.memories, [], [], "A", "B", NOW)[0].mine.map((m) => m.statement)).toEqual(["Every other day is fine now."]);
  });
  it("unconfirmed for 181 days → MAY_BE_OUTDATED (uncertainty), withdrawn → not current", () => {
    const r = mem(emptyMemoryState(), "A", "x", "yes");
    const old = { ...r.memory, lastConfirmedAt: new Date(NOW - 181 * 86_400_000).toISOString(), expiresAt: null };
    expect(currency(old, NOW)).toBe("MAY_BE_OUTDATED");
    expect(currency(markOutdated(r.state, r.memory.memoryId, "A").memories[0], NOW)).toBe("WITHDRAWN");
  });
});

describe("AUDIT FIX D1 — changing a shared memory withdraws the share first", () => {
  for (const change of [{ kind: "correct", statement: "New view." }, { kind: "outdated" }, { kind: "delete" }] as const) {
    it(change.kind, async () => {
      const r = mem(emptyMemoryState(), "A", "Old view.", "yes");
      const st = { ...r.state, memories: r.state.memories.map((m) => ({ ...m, shareId: "share-1", visibility: "SHARED" as const, status: "SHARED" as const })) };
      const unshare = vi.fn(async () => {});
      const out = await changeMemory(st, r.memory.memoryId, "A", change, { nowMs: NOW, newId: id, unshare });
      expect(unshare).toHaveBeenCalledWith("share-1");
      expect(out.memories.every((m) => m.shareId === null && m.visibility === "PRIVATE")).toBe(true);
    });
  }
  it("if withdrawing fails, nothing changes locally", async () => {
    const r = mem(emptyMemoryState(), "A", "Old view.", "yes");
    const st = { ...r.state, memories: r.state.memories.map((m) => ({ ...m, shareId: "share-1" })) };
    await expect(changeMemory(st, r.memory.memoryId, "A", { kind: "delete" }, { nowMs: NOW, newId: id, unshare: async () => { throw new Error("offline"); } })).rejects.toThrow("offline");
  });
});

describe("AUDIT FIX D2 — turning memory off / delete-all withdraws every live memory share", () => {
  const row = (rid: string, kind: string, owner = "A", revokedAt: string | null = null) => ({ id: rid, kind, ownerId: owner, recipientId: "B", revokedAt } as unknown as ShareRow);
  it("selects only my live MEMORY/AGREEMENT/AGREEMENT_RESPONSE rows", () => {
    expect(liveMemoryShares([row("1", "MEMORY"), row("2", "AGREEMENT"), row("3", "AGREEMENT_RESPONSE"), row("4", "REPAIR_MESSAGE"), row("5", "MEMORY", "B"), row("6", "MEMORY", "A", "2026-01-01")], "A")).toEqual(["1", "2", "3"]);
  });
  it("reports failures so the UI can refuse to delete locally", async () => {
    const failed = await withdrawAllMemoryShares([row("1", "MEMORY"), row("2", "AGREEMENT")], "A", async (x) => { if (x === "2") throw new Error("offline"); });
    expect(failed).toEqual(["2"]);
  });
});

describe("§5 high-risk static checks", () => {
  const files = [...readdirSync("src/lib/relationship/memory").map((f) => `src/lib/relationship/memory/${f}`), "src/components/relationship/MemoryPanel.tsx"];
  it("no chat/mood/call/media sources, no telemetry/logging, no network except share.ts", () => {
    for (const f of files) {
      const s = readFileSync(f, "utf8");
      expect(s, f).not.toMatch(/from\s+["'][^"']*(messages|chat|mood|calls?|media|telemetry|analytics|errorReport|crash)["']/i);
      expect(s, f).not.toMatch(/console\.(log|info|warn|error)|\bfetch\s*\(/);
      if (f.endsWith("memory/longitudinal.ts") || f.endsWith("memory/model.ts") || f.endsWith("memory/types.ts")) expect(s, f).not.toMatch(/supabase|sharing/);
    }
  });
  it("no numeric score field and no predictive/profiling vocabulary in the engine's own templates", () => {
    const types = readFileSync("src/lib/relationship/memory/types.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(types).not.toMatch(/score|rating|compatib|healthScore|risk:/i);
    const long = readFileSync("src/lib/relationship/memory/longitudinal.ts", "utf8");
    const templates = [...long.matchAll(/text: `([^`]*)`/g)].map((m) => m[1]).join(" ");
    expect(templates).not.toMatch(/break ?up|divorce|toxic|avoidant|anxious|healthy|score|will last/i);
  });
});

describe("AUDIT FIX D4 — safety-flagged memories/agreements are never shared", () => {
  it("memory statements and agreement texts with danger content are refused (any language)", async () => {
    const { previewMemoryShare, previewAgreement, MemorySafetyHold } = await import("@/lib/relationship/memory/share");
    for (const statement of ["He threatens to hurt me if I leave.", "वो मुझे मारता है", "usne mujhe dhamki di", "அவன் என்னை அடித்தான்"]) {
      const m = { ...mem(emptyMemoryState(), "A", statement, "no").memory };
      expect(() => previewMemoryShare(m, ALL), statement).toThrow(MemorySafetyHold);
    }
    expect(() => previewAgreement({ agreementId: "g", topic: "privacy", text: "You will stop tracking my phone location.", proposedBy: "A", participants: ["A", "B"], createdAt: "", reviewDate: null, confirmations: {}, status: "PROPOSED", shareId: null })).toThrow(MemorySafetyHold);
    const ok = mem(emptyMemoryState(), "A", "I like a quick text when plans change.", "yes").memory;
    await expect(previewMemoryShare(ok, ALL)).resolves.toBeTruthy();
  });
});
