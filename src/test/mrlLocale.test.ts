import { describe, it, expect, afterEach } from "vitest";
import { SPLASH_LANGUAGES, setLanguageCode, getLanguageCode, tr, fallbackChain } from "@/lib/i18n";
import { understand } from "@/lib/relationship/contextual/present";

// Written, not yet executed (no node_modules in the authoring sandbox).
afterEach(() => setLanguageCode("en"));

describe("Marathi in English letters (mrl)", () => {
  it("is selectable and persisted as its own code", () => {
    expect(SPLASH_LANGUAGES.some((l) => l.code === "mrl")).toBe(true);
    setLanguageCode("mrl");
    expect(getLanguageCode()).toBe("mrl");
    expect(document.documentElement.lang).toBe("mr-Latn");
  });
  it("falls back to English, never to Devanagari Marathi", () => {
    expect(fallbackChain("mrl")).toEqual(["mrl", "en"]);
  });
  it("renders Latin-script Marathi, and Devanagari mr is unaffected", () => {
    expect(tr("p1.today.empty", {}, "mrl")).toBe("Aaj laksha denyasarkhe kahi nahi.");
    expect(tr("p1.today.empty", {}, "mr")).toMatch(/[\u0900-\u097F]/);
  });
  it("Understand keeps the exact quote and shows no Devanagari", () => {
    setLanguageCode("mrl");
    const u = understand({ id: "mrl1", text: "Can you please call me when you reach?" });
    if (u.provenance.basis === "EXPLICIT") {
      expect(u.statement).toContain(u.why[0]);
      expect(u.statement).not.toMatch(/[\u0900-\u097F]/);
      expect(u.statement).toMatch(/Tyanni/);
    }
    expect(understand({ id: "mrl2", text: "fine" }).statement).toBe(tr("p1.cantTell.short", {}, "mrl"));
  });
});
