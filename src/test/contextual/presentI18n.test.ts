import { describe, it, expect, afterEach } from "vitest";
import { understand, replyIntents, selectTodayInsight } from "@/lib/relationship/contextual/present";
import { extractCached } from "@/lib/relationship/contextual/extract";
import { setLanguageCode } from "@/lib/i18n";

// Written, not yet executed (no node_modules in the authoring sandbox).
const DEVANAGARI = /[\u0900-\u097F]/;
const CASES: [string, string][] = [
  ["request", "Can you please call me when you reach?"],
  ["question", "Where are you right now?"],
  ["apology", "I'm so sorry about last night."],
  ["boundary", "I need some space tonight."],
  ["uncertainty", "I don't understand what happened."],
  ["accusation", "You always forget everything."],
];

afterEach(() => setLanguageCode("en"));

describe("Understand text is localized and keeps the exact quote", () => {
  for (const lang of ["hi", "mr"] as const) {
    it(`${lang}: statements are Devanagari around the unchanged quote; no classifier names`, () => {
      setLanguageCode(lang);
      for (const [, text] of CASES) {
        const u = understand({ id: `${lang}-${text}`, text });
        if (u.provenance.basis === "EXPLICIT") {
          expect(u.statement).toMatch(DEVANAGARI);
          expect(u.statement).toContain(u.why[0]);
        }
        expect(u.statement).not.toMatch(/\b(REQUEST|ACCUSATION|CONTROL|DEFENSIVE|classif|evidence|confidence)\b/i);
      }
    });
    it(`${lang}: no-evidence fallback is localized (not English)`, () => {
      setLanguageCode(lang);
      const u = understand({ id: `${lang}-fb`, text: "fine" });
      expect(u.statement).toMatch(DEVANAGARI);
      expect(u.statement).not.toMatch(/reliably/i);
      expect(replyIntents(extractCached({ id: `${lang}-fb2`, text: "fine" })).fallback).toMatch(DEVANAGARI);
    });
  }
  it("en: accusation / control use plain natural wording", () => {
    setLanguageCode("en");
    const a = understand({ id: "en-acc", text: "You always forget everything." }).statement;
    if (a) expect(a).not.toMatch(/blaming phrase/i);
    expect(a === "" || /blamed you|can't reliably/.test(a)).toBe(true);
  });
  it("Today is localized and quotes the partner's exact words", () => {
    setLanguageCode("hi");
    const now = Date.now();
    const t = selectTodayInsight(
      [{ id: "t1", sender_id: "P", created_at: new Date(now - 60_000).toISOString(), message_type: "text", decryptedContent: "Can you tell me earlier when your plans change?" }],
      { me: "ME", partner: "P", nowMs: now },
    );
    if (t) { expect(t.statement).toMatch(DEVANAGARI); expect(t.statement).toContain(t.phrase); }
  });
});
