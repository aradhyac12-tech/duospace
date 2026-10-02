import { describe, it, expect, vi, afterEach } from "vitest";
import { detectEmergencyRegion } from "@/lib/i18n";
const setNav = (languages: string[]) => vi.stubGlobal("navigator", { languages, language: languages[0] });
const setTz = (tz: string) => vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({ timeZone: tz } as Intl.ResolvedDateTimeFormatOptions);
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("emergency region (locale-aware, never from app language)", () => {
  it("IN from device locale region", () => { setNav(["hi-IN"]); setTz("UTC"); expect(detectEmergencyRegion()).toBe("IN"); });
  it("IN from India time zone", () => { setNav(["en-GB"]); setTz("Asia/Kolkata"); expect(detectEmergencyRegion()).toBe("IN"); });
  it("a Hindi speaker in the US → neutral", () => { setNav(["hi", "en-US"]); setTz("America/New_York"); expect(detectEmergencyRegion()).toBeNull(); });
  it("no signal → neutral", () => { setNav([]); setTz("Europe/London"); expect(detectEmergencyRegion()).toBeNull(); });
});
describe("Phase 3E emergency matrix", () => {
  it("Kyrgyzstan (ky-KG, Asia/Bishkek) → neutral, never 112-as-India", () => { setNav(["ky-KG", "ru-KG"]); setTz("Asia/Bishkek"); expect(detectEmergencyRegion()).toBeNull(); });
  it("Hindi app language on a Kyrgyz device → still neutral", () => { setNav(["hi", "ru-KG"]); setTz("Asia/Bishkek"); expect(detectEmergencyRegion()).toBeNull(); });
  it("en-IN user travelling (tz Europe/Berlin) → IN from locale (documented: locale beats tz)", () => { setNav(["en-IN"]); setTz("Europe/Berlin"); expect(detectEmergencyRegion()).toBe("IN"); });
  it("Intl throwing → neutral", () => { setNav([]); vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(() => { throw new Error("x"); }); expect(detectEmergencyRegion()).toBeNull(); });
});
