import { describe, it, expect } from "vitest";
import { MOODS, NEEDS, suggestFor, todayKey, type Need } from "@/lib/relationship/checkin";
import { findProhibitedContent } from "@/lib/ai/outputValidator";
import { validateComponent } from "@/lib/relationship/responsiveness";

const combos: { mood: (typeof MOODS)[number]["id"]; needs: Need[] }[] = [];
for (const m of MOODS) { combos.push({ mood: m.id, needs: [] }); for (const n of NEEDS) { combos.push({ mood: m.id, needs: [n.id] }); for (const n2 of NEEDS) if (n2.id !== n.id) combos.push({ mood: m.id, needs: [n.id, n2.id] }); } }

describe("daily check-in suggestions", () => {
  it(`all ${combos.length} tap combinations produce a suggestion that passes the safety validators`, () => {
    for (const c of combos) {
      const s = suggestFor(c);
      expect(s.tip.length).toBeGreaterThan(10);
      for (const text of [s.tip, s.message ?? ""]) {
        expect(findProhibitedContent(text), `${JSON.stringify(c)}: ${text}`).toEqual([]);
        expect(validateComponent({ kind: "EXPLAIN", text, sources: [] }, { partnerMessage: "" }).filter((i) => i.check !== "GROUNDING"), text).toEqual([]);
        expect(text).not.toMatch(/\b\d+\s*%|score|compatib|always|never|your partner (feels|wants|thinks)/i);
      }
      expect(s.basedOn).toMatch(/^Because you chose:/);
    }
  });
  it("is deterministic and driven only by the taps", () => {
    expect(suggestFor({ mood: "okay", needs: ["space"] })).toEqual(suggestFor({ mood: "okay", needs: ["space"] }));
    expect(suggestFor({ mood: "good", needs: ["space"] }).message).toBe(suggestFor({ mood: "hard", needs: ["space"] }).message);
  });
  it("hard days and 'sort something out' offer the repair helper; others don't push it", () => {
    expect(suggestFor({ mood: "hard", needs: [] }).offerRepair).toBe(true);
    expect(suggestFor({ mood: "okay", needs: ["talk"] }).offerRepair).toBe(true);
    expect(suggestFor({ mood: "good", needs: ["time"] }).offerRepair).toBe(false);
  });
  it("ignores unknown needs and caps at two", () => {
    expect(suggestFor({ mood: "okay", needs: ["x" as Need, "listen"] }).message).toMatch(/listening/);
  });
  it("date key is local calendar day", () => {
    expect(todayKey(new Date(2026, 8, 5))).toBe("2026-09-05");
  });
});
