/**
 * Phase 3E — OBSERVED (not just grepped) network behaviour of the private
 * AI paths. fetch / XMLHttpRequest / WebSocket / the Supabase client are
 * replaced by recorders; the private flows below must produce ZERO calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls: string[] = [];
function trap(name: string): unknown {
  return new Proxy(() => {}, {
    get: (_t, p) => (p === "then" ? undefined : trap(`${name}.${String(p)}`)),
    apply: () => { calls.push(name); return trap(name); },
  });
}
vi.mock("@/integrations/supabase/appClient", () => ({ supabase: trap("supabase") }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: trap("supabase") }));

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (u: unknown) => { calls.push(`fetch:${String(u)}`); throw new Error("network blocked in test"); }));
  vi.stubGlobal("XMLHttpRequest", class { open(_m: string, u: string) { calls.push(`xhr:${u}`); } send() {} setRequestHeader() {} });
  vi.stubGlobal("WebSocket", class { constructor(u: string) { calls.push(`ws:${u}`); } send() {} close() {} });
});

const NOW = Date.parse("2026-09-25T12:00:00Z");

describe("no network in private relationship-AI paths (RULE_BASED)", () => {
  it("response support (EN, Hindi limited mode, safety hold)", async () => {
    const { supportResponse } = await import("@/lib/relationship/responsiveness");
    await supportResponse({ partnerMessage: "You didn't call me after work.", myExperience: "I was busy" }, { nowMs: NOW });
    await supportResponse({ partnerMessage: "तुमने कल फ़ोन नहीं किया" }, { nowMs: NOW, language: "hi" });
    await supportResponse({ partnerMessage: "usne mujhe dhamki di" }, { nowMs: NOW });
    expect(calls).toEqual([]);
  });

  it("conflict repair (EN, Tamil limited mode)", async () => {
    const { prepareRepair, newSession, checkSafety } = await import("@/lib/relationship/repair");
    for (const a of [{ concreteEvent: "You cancelled dinner.", myResponsibility: "I didn't explain" }, { myResponsibility: "நான் கோபமாக பேசினேன்" }]) {
      await prepareRepair({ ...newSession({ id: "r", conflictId: "c", userId: "u", relationshipId: null, nowMs: NOW }), answers: a, stage: "REVIEW", safetyState: checkSafety(a) }, { nowMs: NOW });
    }
    expect(calls).toEqual([]);
  });

  it("dyadic comparison, memory model + summary, language detection, safety lexicon", async () => {
    const { compareDyad } = await import("@/lib/relationship/dyadic");
    const mem = await import("@/lib/relationship/memory");
    const { detectLanguage, multilingualSafetyCategories } = await import("@/lib/relationship/i18n/lang");
    compareDyad([], [], [], NOW);
    const r = mem.createMemory(mem.emptyMemoryState(), { ownerUserId: "A", relationshipId: null, category: "PREFERENCE", topic: "planning", statement: "x", sourceType: "USER_ENTERED", sourceId: "s", sourceTimestamp: "2026-09-25" }, { nowMs: NOW, newId: () => "m", consentStore: true });
    await mem.buildLongitudinalSummary(r.state, [], { me: "A", partner: "B", consents: { store: true, useInAI: true, share: true, longitudinal: true }, nowMs: NOW });
    detectLanguage("वो मुझे मारता है");
    multilingualSafetyCategories("woh mujhe maarta hai");
    expect(calls).toEqual([]);
  });

  it("control: the explicit share path DOES reach Supabase (proves the recorder works)", async () => {
    const { listSharedByMeStrict } = await import("@/lib/relationship/sharing");
    await listSharedByMeStrict("u").catch(() => undefined);
    expect(calls.some((c) => c.startsWith("supabase"))).toBe(true);
  });
});
