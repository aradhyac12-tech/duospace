import { describe, it, expect } from "vitest";
import { PLAN_MARKETING, upgradeOptionsFor } from "@/lib/monetization/marketing";
import { FEATURE_STATUS, AI_QUOTA_DISPLAY, SELL_PRO } from "@/lib/monetization/config";

describe("no false marketing", () => {
  it("never sells 'unlimited' anything", () => {
    for (const c of Object.values(PLAN_MARKETING)) for (const h of c.highlights) expect(h.toLowerCase()).not.toContain("unlimited");
  });
  it("never advertises features that are still PENDING", () => {
    const banned = [/storage/i, /advanced mood/i, /couple insights/i, /deep (relationship )?(analysis|reasoning)/i, /priority support/i, /ad-?free|no ads/i];
    for (const c of Object.values(PLAN_MARKETING)) for (const h of c.highlights) for (const b of banned) expect(h).not.toMatch(b);
  });
  it("ENFORCED set is exactly what the paywall relies on", () => {
    const enforced = Object.entries(FEATURE_STATUS).filter(([, v]) => v === "ENFORCED").map(([k]) => k).sort();
    expect(enforced).toEqual(["ADVANCED_CUSTOMIZATION", "AI_BASIC", "AI_STANDARD", "PREMIUM_THEMES"]);
  });
  it("quoted AI numbers match the configured display quotas", () => {
    expect(PLAN_MARKETING.PLUS.highlights.join(" ")).toContain(String(AI_QUOTA_DISPLAY.PLUS.standardPerDay));
    expect(PLAN_MARKETING.PRO.highlights.join(" ")).toContain(String(AI_QUOTA_DISPLAY.PRO.standardPerDay));
  });
});

describe("upgrade options", () => {
  it("Pro is not for sale while its features are PENDING", () => expect(SELL_PRO).toBe(false));
  it("FREE sees only Plus while Pro is not sold", () => expect(upgradeOptionsFor("FREE", "INDIVIDUAL").levels).toEqual(SELL_PRO ? ["PLUS", "PRO"] : ["PLUS"]));
  it("PLUS sees nothing to buy while Pro is not sold (never a lower plan)", () => expect(upgradeOptionsFor("PLUS", "COUPLE").levels).toEqual(SELL_PRO ? ["PRO"] : []));
  it("PRO sees nothing", () => expect(upgradeOptionsFor("PRO", "COUPLE").levels).toEqual([]));
});
