import { describe, it, expect } from "vitest";
import { detectRingRegion, ringbackFor, periodSeconds, RINGBACK } from "@/lib/ringback";

describe("ringback by location", () => {
  it("India by time zone even when the phone UI language is en-US (was: American beeps)", () => {
    expect(ringbackFor(detectRingRegion({ timeZone: "Asia/Kolkata", languages: ["en-US"] })).name).toBe("INDIA");
    expect(ringbackFor(detectRingRegion({ timeZone: "Asia/Calcutta", languages: [] })).name).toBe("INDIA");
  });
  it("Kyrgyzstan → CIS long beep, by time zone or ky-KG / ru-KG locale", () => {
    expect(ringbackFor(detectRingRegion({ timeZone: "Asia/Bishkek", languages: ["en-US"] })).name).toBe("CIS");
    expect(ringbackFor(detectRingRegion({ timeZone: "UTC", languages: ["ru-KG"] })).name).toBe("CIS");
  });
  it("time zone beats the locale region (a Hindi-speaking user in Bishkek hears the local tone)", () => {
    expect(ringbackFor(detectRingRegion({ timeZone: "Asia/Bishkek", languages: ["hi-IN"] })).name).toBe("CIS");
  });
  it("North America and default", () => {
    expect(ringbackFor(detectRingRegion({ timeZone: "America/New_York", languages: [] })).name).toBe("NORTH_AMERICA");
    expect(ringbackFor(detectRingRegion({ timeZone: "Europe/London", languages: ["en-GB"] })).name).toBe("DOUBLE");
    expect(ringbackFor(detectRingRegion({ timeZone: null, languages: [] })).name).toBe("DOUBLE");
  });
  it("cadences match the national tone plans", () => {
    expect(RINGBACK.INDIA).toMatchObject({ freqs: [400], amHz: 25, cadence: [0.4, 0.2, 0.4, 2.0] });
    expect(periodSeconds(RINGBACK.INDIA)).toBeCloseTo(3.0);
    expect(RINGBACK.CIS).toMatchObject({ freqs: [425], cadence: [1.0, 4.0] });
    expect(periodSeconds(RINGBACK.CIS)).toBeCloseTo(5.0);
    expect(RINGBACK.NORTH_AMERICA.freqs).toEqual([440, 480]);
  });
  it("every pattern starts with a tone and alternates on/off", () => {
    for (const p of Object.values(RINGBACK)) {
      expect(p.cadence.length % 2).toBe(0);
      expect(p.cadence.every((d) => d > 0)).toBe(true);
    }
  });
});
