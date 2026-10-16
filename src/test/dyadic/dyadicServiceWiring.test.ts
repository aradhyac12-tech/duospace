/** Phase 3B audit of Phase 3A: the service wiring for compareWithPartner had no test. */
import { describe, it, expect } from "vitest";
import { createRelationshipAIService, type RuntimeStateStore } from "@/lib/relationship/service";
import { localRuleProvider } from "@/lib/relationship/providers/localRuleProvider";
import type { RelationshipAIProvider } from "@/lib/relationship/provider";
import type { ShareRow } from "@/lib/relationship/types";
import { makeDeps, answer } from "../ai/fixtures";

const memStore = (): RuntimeStateStore => { let s: never | null = null; return { load: () => s, save: (x) => { s = x as never; } }; };
const readyCaps = () => ({ supported: true, modelAvailable: true, accelerator: "webgpu", reasons: [] }) as never;
const noCaps = () => ({ supported: false, modelAvailable: false, accelerator: "none", reasons: ["x"] }) as never;
const share = (qid: string, choiceId: string): ShareRow => ({
  id: "s1", ownerId: "p", recipientId: "u", kind: "VALUE_ANSWER", itemRef: qid, createdAt: "2026-09-20T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z", revokedAt: null, payload: { v: 1, kind: "VALUE_ANSWER", questionId: qid, mode: "ANSWERED", choiceId } as never,
});
const input = { userId: "u", partnerId: "p", values: { version: 1 as const, answers: [answer("comm-1", 0)], skippedCategories: [] }, expectations: [], sharedWithMe: [share("comm-1", "few")], corrections: [] };

describe("RelationshipAIService.compareWithPartner", () => {
  it("refuses without consent", async () => {
    const { deps } = makeDeps({ gate: { hasConsent: async () => false } });
    await expect(createRelationshipAIService({ deps, capabilities: noCaps, stateStore: memStore() }).compareWithPartner(input)).rejects.toMatchObject({ code: "CONSENT_MISSING" });
  });
  it("RULE_BASED when no local model", async () => {
    const { deps } = makeDeps();
    const r = await createRelationshipAIService({ deps, capabilities: noCaps, stateStore: memStore() }).compareWithPartner(input);
    expect(r.mode).toBe("RULE_BASED");
    expect(r.different).toHaveLength(1);
  });
  it("LOCAL provider with explainDyadic is used through the service; unsafe output falls back", async () => {
    const { deps } = makeDeps();
    const mk = (out: unknown) => ({ ...localRuleProvider, info: { ...localRuleProvider.info, id: "m", kind: "LOCAL_MODEL", modelVersion: "local-test" }, explainDyadic: async () => out }) as unknown as RelationshipAIProvider;
    const good = await createRelationshipAIService({ deps, capabilities: readyCaps, deviceMemoryGB: () => 8, stateStore: memStore(), providers: { local: mk({ comparison: "You picked different answers here, which you can explore together." }) } }).compareWithPartner(input);
    expect(good.mode).toBe("LOCAL");
    const bad = await createRelationshipAIService({ deps, capabilities: readyCaps, deviceMemoryGB: () => 8, stateStore: memStore(), providers: { local: mk({ comparison: "You are 20% compatible." }) } }).compareWithPartner(input);
    expect(bad.mode).toBe("RULE_BASED");
    expect(JSON.stringify(bad)).not.toMatch(/20%/);
  });
});
