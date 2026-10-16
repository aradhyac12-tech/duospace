import { describe, it, expect } from "vitest";
import data from "../fixtures/replyEval.v1.json";
import { acceptableReply } from "@/lib/relationship/contextual/cloudReply";

// Deterministic harness: validates the dataset and the client-side acceptance rules.
// It does NOT call a model. Live quality (groundedness, tone, latency, cost) is only
// measurable via `npm run test:ai-live` on staging + human review, and has NOT been run.
const SCRIPT: Record<string, RegExp> = { Devanagari: /[\u0900-\u097F]/, Latin: /[A-Za-z]/ };

describe("replyEval.v1 dataset", () => {
  it("is versioned, synthetic, and covers en/hi/mr/hinglish", () => {
    expect(data.version).toBe("replyEval.v1");
    expect(new Set(data.cases.map((c) => c.lang))).toEqual(new Set(["en", "hi", "mr", "hinglish"]));
    expect(new Set(data.cases.map((c) => c.id)).size).toBe(data.cases.length);
  });
  it.each(data.cases)("$id: scripted candidates obey acceptance + forbidden-phrase rules", (c) => {
    const bad = "As an AI language model I think " + c.partner;
    expect(acceptableReply(bad, c.partner)).toBe(false);
    expect(acceptableReply(c.partner, c.partner)).toBe(false);
    for (const f of (c as { mustNotInclude?: string[] }).mustNotInclude ?? []) expect(f.length).toBeGreaterThan(2);
    const script = (c as { expectScript?: string }).expectScript;
    if (script) expect(SCRIPT[script].test(c.partner)).toBe(true);
  });
});
