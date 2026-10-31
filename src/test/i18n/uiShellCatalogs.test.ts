import { describe, it, expect, beforeEach } from "vitest";
import en from "@/lib/uiCatalogs/en";
import {
  SPLASH_LANGUAGES, SYSTEM_LANGUAGE, getLanguageCode, getLanguagePreference,
  setLanguageCode, tr, detectDeviceLanguage,
} from "@/lib/i18n";

const catalogs = import.meta.glob("@/lib/uiCatalogs/*.ts", { eager: true }) as Record<string, { default: Record<string, string> }>;
const byCode = (code: string) => Object.entries(catalogs).find(([p]) => p.endsWith(`/${code}.ts`))![1].default;
const placeholders = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(",");

describe("app-shell UI catalogs", () => {
  it("every supported non-English language covers every English key with the same placeholders", () => {
    for (const l of SPLASH_LANGUAGES.filter((x) => x.code !== "en")) {
      const c = byCode(l.code);
      for (const [k, v] of Object.entries(en)) {
        expect(c[k], `${l.code}.${k}`).toBeTruthy();
        expect(placeholders(c[k]), `${l.code}.${k} placeholders`).toBe(placeholders(v));
      }
    }
  });
  it("translates and interpolates", () => {
    expect(tr("settings.title", {}, "hi")).toBe("सेटिंग्स");
    expect(tr("settings.partner.connected", { name: "A" }, "ta")).toContain("A");
    expect(tr("settings.title", {}, "xx")).toBe("Settings");
  });
});

describe("system language following", () => {
  beforeEach(() => { localStorage.clear(); });
  it("defaults to system and resolves against the device language list", () => {
    expect(getLanguagePreference()).toBe(SYSTEM_LANGUAGE);
    Object.defineProperty(navigator, "languages", { value: ["ru-RU", "hi-IN"], configurable: true });
    expect(detectDeviceLanguage()).toBe("hi");
    expect(getLanguageCode()).toBe("hi");
  });
  it("explicit choice overrides the device; 'system' hands control back", () => {
    Object.defineProperty(navigator, "languages", { value: ["hi-IN"], configurable: true });
    setLanguageCode("ta");
    expect(getLanguageCode()).toBe("ta");
    setLanguageCode(SYSTEM_LANGUAGE);
    expect(getLanguageCode()).toBe("hi");
  });
  it("unsupported device language falls back to English", () => {
    Object.defineProperty(navigator, "languages", { value: ["ru-RU", "ky"], configurable: true });
    expect(getLanguageCode()).toBe("en");
  });
});
