import { describe, it, expect, afterEach } from "vitest";
import { SPLASH_LANGUAGES, setLanguageCode, getLanguageCode, tr, fallbackChain } from "@/lib/i18n";
import { understand } from "@/lib/relationship/contextual/present";

// Written, not yet executed (no node_modules in the authoring sandbox).
afterEach(() => setLanguageCode("en"));

describe("Hindi in English letters (hil)", () => {
  it("is selectable, persisted, and reports hi-Latn on <html>", () => {
    expect(SPLASH_LANGUAGES.some((l) => l.code === "hil")).toBe(true);
    setLanguageCode("hil");
    expect(getLanguageCode()).toBe("hil");
    expect(document.documentElement.lang).toBe("hi-Latn");
  });
  it("falls back to English only; Devanagari hi is unaffected", () => {
    expect(fallbackChain("hil")).toEqual(["hil", "en"]);
    expect(tr("p1.today.empty", {}, "hil")).toBe("Aaj dhyan dene layak kuch nahi hai.");
    expect(tr("p1.today.empty", {}, "hi")).toMatch(/[\u0900-\u097F]/);
  });
  it("Understand keeps the exact quote and stays in Latin script", () => {
    setLanguageCode("hil");
    const u = understand({ id: "hil1", text: "Can you please call me when you reach?" });
    if (u.provenance.basis === "EXPLICIT") {
      expect(u.statement).toContain(u.why[0]);
      expect(u.statement).not.toMatch(/[\u0900-\u097F]/);
      expect(u.statement).toMatch(/Unhone/);
    }
    expect(understand({ id: "hil2", text: "fine" }).statement).toBe(tr("p1.cantTell.short", {}, "hil"));
  });
});
