import { describe, expect, it } from "vitest";
import { AD_FREE_SURFACES } from "@/lib/monetization/config";
import {
  ALLOWED_AD_SURFACES,
  INTERSTITIAL_MIN_GAP_MS,
  canShowAd,
  registerAdProvider,
  showAdIfAllowed,
  NoopAdProvider,
} from "@/lib/monetization/adPolicy";

const ON = { adsEnabled: true, rewardedAdsEnabled: true, interstitialAdsEnabled: true };
const base = { plan: "FREE" as const, surface: "settings_footer", format: "banner" as const };

describe("ad policy", () => {
  it("is off by default (flag off)", () => {
    expect(canShowAd(base, { ...ON, adsEnabled: false })).toEqual({ show: false, reason: "ads_disabled" });
  });
  it("shows a banner to a free user on an allowed surface", () => {
    expect(canShowAd(base, ON).show).toBe(true);
  });
  it("the allowlist never overlaps the ad-free list", () => {
    for (const s of ALLOWED_AD_SURFACES) expect((AD_FREE_SURFACES as readonly string[]).includes(s)).toBe(false);
  });
  it("never shows on any ad-free surface", () => {
    for (const s of AD_FREE_SURFACES) expect(canShowAd({ ...base, surface: s }, ON).show).toBe(false);
  });
  it("default-denies unknown surfaces", () => {
    expect(canShowAd({ ...base, surface: "somewhere_new" }, ON)).toEqual({ show: false, reason: "surface_not_allowed" });
  });
  it("paying and complimentary plans are ad-free", () => {
    for (const plan of ["PLUS_INDIVIDUAL", "PLUS_COUPLE", "PRO_INDIVIDUAL", "PRO_COUPLE", "LIFETIME", "FOUNDER", "BETA", "ADMIN"] as const) {
      expect(canShowAd({ ...base, plan }, ON).show).toBe(false);
    }
  });
  it("never during a call or typing", () => {
    expect(canShowAd({ ...base, inCallOrTyping: true }, ON).show).toBe(false);
  });
  it("rewarded needs its flag and a user tap", () => {
    const r = { ...base, format: "rewarded" as const };
    expect(canShowAd(r, ON).show).toBe(false);
    expect(canShowAd({ ...r, userInitiated: true }, ON).show).toBe(true);
    expect(canShowAd({ ...r, userInitiated: true }, { ...ON, rewardedAdsEnabled: false }).show).toBe(false);
  });
  it("interstitials are frequency capped", () => {
    const i = { ...base, format: "interstitial" as const, nowMs: 1_000_000 };
    expect(canShowAd(i, ON).show).toBe(true);
    expect(canShowAd({ ...i, lastInterstitialAtMs: 1_000_000 - 1000 }, ON).show).toBe(false);
    expect(canShowAd({ ...i, lastInterstitialAtMs: 1_000_000 - INTERSTITIAL_MIN_GAP_MS }, ON).show).toBe(true);
  });
  it("shows nothing with the default no-op provider, and swallows provider errors", async () => {
    expect(await showAdIfAllowed(base)).toBe(false);
    registerAdProvider({ name: "boom", isReady: () => true, show: async () => { throw new Error("x"); } });
    expect(await showAdIfAllowed({ ...base })).toBe(false);
    registerAdProvider(NoopAdProvider);
  });
});
