import { describe, it, expect } from "vitest";
import { tr, fallbackChain, registerCatalog, isRtl, SPLASH_LANGUAGES } from "@/lib/i18n";
import { REL_LANGS } from "@/lib/relationship/i18n/lang";
import { t, ALL_KEYS } from "@/lib/relationship/i18n/strings";

describe("i18n architecture", () => {
  it("fallback chain: selected → base → English", () => {
    expect(fallbackChain("hi-IN")).toEqual(["hi-IN", "hi", "en"]);
    expect(fallbackChain("en")).toEqual(["en"]);
  });
  it("missing translations fall back to English, never blank, never throw", () => {
    expect(tr("p0.error.generic", {}, "ta")).toBe("Couldn't do that");
    expect(tr("does.not.exist", {}, "mr")).toBe("does.not.exist");
  });
  it("regional variant uses base catalog", () => {
    registerCatalog("gu", { "test.hello": "નમસ્તે" });
    expect(tr("test.hello", {}, "gu-IN")).toBe("નમસ્તે");
  });
  it("interpolation and plurals", () => {
    expect(tr("p0.memory.itemsShared", { count: 1 }, "en")).toBe("1 item is shared with your partner");
    expect(tr("p0.memory.itemsShared", { count: 3 }, "hi")).toBe("3 items are shared with your partner");
  });
  it("no supported language is RTL; Urdu is not supported", () => {
    for (const l of SPLASH_LANGUAGES) expect(isRtl(l.code)).toBe(false);
    expect(SPLASH_LANGUAGES.some((l) => l.rtl)).toBe(false);
  });
  it("safety text has an explicit per-key fallback in every language (no generic chain)", () => {
    for (const l of REL_LANGS) for (const k of ALL_KEYS) expect(t(l, k).trim().length, `${l}.${k}`).toBeGreaterThan(0);
  });
});
