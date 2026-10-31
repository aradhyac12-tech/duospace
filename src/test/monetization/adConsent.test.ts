import { describe, expect, it, vi } from "vitest";
import { AD_INSET_VAR, applyAdInset, mayStartAdSdk, shouldOfferPrivacyChoices } from "@/lib/monetization/adConsent";
import { ALLOWED_AD_SURFACES, canShowAd } from "@/lib/monetization/adPolicy";

const ON = { adsEnabled: true, rewardedAdsEnabled: false, interstitialAdsEnabled: false };

describe("ad consent gate", () => {
  it("starts the SDK only when Google says ads can be requested", () => {
    expect(mayStartAdSdk({ canRequestAds: true })).toBe(true);
    expect(mayStartAdSdk({ canRequestAds: false })).toBe(false);
    expect(mayStartAdSdk({ canRequestAds: false, error: "consent_update_failed" })).toBe(false);
    expect(mayStartAdSdk(null)).toBe(false);
    expect(mayStartAdSdk(undefined)).toBe(false);
  });

  it("offers privacy choices only when ads are on and Google requires it", () => {
    expect(shouldOfferPrivacyChoices(true, { canRequestAds: true, privacyOptionsRequired: true })).toBe(true);
    expect(shouldOfferPrivacyChoices(true, { canRequestAds: true, privacyOptionsRequired: false })).toBe(false);
    expect(shouldOfferPrivacyChoices(false, { canRequestAds: true, privacyOptionsRequired: true })).toBe(false);
    expect(shouldOfferPrivacyChoices(true, null)).toBe(false);
  });
});

describe("banner inset", () => {
  it("sets and clears the css variable", () => {
    const style = { setProperty: vi.fn(), removeProperty: vi.fn() };
    applyAdInset(style, 50.4);
    expect(style.setProperty).toHaveBeenCalledWith(AD_INSET_VAR, "50px");
    applyAdInset(style, undefined);
    applyAdInset(style, 0);
    expect(style.removeProperty).toHaveBeenCalledTimes(2);
  });
});

describe("gallery and plans placements", () => {
  it("are allowed for Free and blocked for paying/complimentary plans", () => {
    for (const surface of ["gallery_grid_footer", "plans_screen_footer"]) {
      expect(ALLOWED_AD_SURFACES).toContain(surface);
      expect(canShowAd({ plan: "FREE", surface, format: "banner" }, ON)).toEqual({ show: true });
      expect(canShowAd({ plan: "PLUS_INDIVIDUAL", surface, format: "banner" }, ON)).toEqual({ show: false, reason: "ad_free_plan" });
      expect(canShowAd({ plan: "FOUNDER", surface, format: "banner" }, ON)).toEqual({ show: false, reason: "ad_free_plan" });
    }
  });

  it("stay blocked in a call or while typing", () => {
    expect(canShowAd({ plan: "FREE", surface: "gallery_grid_footer", format: "banner", inCallOrTyping: true }, ON))
      .toEqual({ show: false, reason: "in_call_or_typing" });
  });
});
