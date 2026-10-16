// Central ad policy. This is the ONLY place that decides whether an ad may be
// shown; call sites ask `canShowAd()` and never check plan/flags themselves.
//
// DEFAULT-DENY: an ad can appear only on a surface listed in
// ALLOWED_AD_SURFACES. AD_FREE_SURFACES (chat, calls, login, linking, ...)
// always wins, even if someone later adds one of them to the allowlist.
//
// STATUS: policy + provider seam only. No ad SDK is installed and no ad is
// rendered anywhere, so NO_ADS stays PENDING in FEATURE_STATUS until a real
// provider and at least one placement ship. VITE_ADS_ENABLED defaults to false.

import {
  AD_FREE_SURFACES,
  FEATURE_FLAGS,
  getPlanLevel,
  isComplimentaryPlan,
  type EntitlementPlan,
} from "./config";

/** Surfaces ads may ever appear on. Empty of chat/calls/auth by construction. */
export const ALLOWED_AD_SURFACES = ["settings_footer", "gallery_grid_footer", "plans_screen_footer"] as const;
export type AllowedAdSurface = (typeof ALLOWED_AD_SURFACES)[number];

export type AdFormat = "banner" | "interstitial" | "rewarded";

export interface AdContext {
  plan: EntitlementPlan;
  surface: string;
  format: AdFormat;
  /** A call is ringing/active or the user is mid-typing — never show. */
  inCallOrTyping?: boolean;
  /** Only meaningful for "rewarded": the user tapped a "watch to unlock" control. */
  userInitiated?: boolean;
  /** Epoch ms of the last interstitial shown this session, if any. */
  lastInterstitialAtMs?: number;
  nowMs?: number;
}

export const INTERSTITIAL_MIN_GAP_MS = 5 * 60 * 1000;

type Flags = Pick<typeof FEATURE_FLAGS, "adsEnabled" | "rewardedAdsEnabled" | "interstitialAdsEnabled">;

export type AdDecision = { show: true } | { show: false; reason: string };

export function canShowAd(ctx: AdContext, flags: Flags = FEATURE_FLAGS): AdDecision {
  if (!flags.adsEnabled) return { show: false, reason: "ads_disabled" };
  if ((AD_FREE_SURFACES as readonly string[]).includes(ctx.surface)) return { show: false, reason: "ad_free_surface" };
  if (!(ALLOWED_AD_SURFACES as readonly string[]).includes(ctx.surface)) return { show: false, reason: "surface_not_allowed" };
  if (ctx.inCallOrTyping) return { show: false, reason: "in_call_or_typing" };

  // Paying and complimentary accounts (Plus/Pro/Founder/Beta/Admin/Lifetime) are ad-free.
  if (isComplimentaryPlan(ctx.plan) || getPlanLevel(ctx.plan) !== "FREE") return { show: false, reason: "ad_free_plan" };

  if (ctx.format === "rewarded") {
    if (!flags.rewardedAdsEnabled) return { show: false, reason: "rewarded_disabled" };
    if (!ctx.userInitiated) return { show: false, reason: "rewarded_requires_user_action" };
  }
  if (ctx.format === "interstitial") {
    if (!flags.interstitialAdsEnabled) return { show: false, reason: "interstitial_disabled" };
    const now = ctx.nowMs ?? Date.now();
    if (ctx.lastInterstitialAtMs !== undefined && now - ctx.lastInterstitialAtMs < INTERSTITIAL_MIN_GAP_MS) {
      return { show: false, reason: "interstitial_frequency_cap" };
    }
  }
  return { show: true };
}

/** Provider seam. A real AdMob plugin implements this; nothing else changes. */
export interface AdProvider {
  readonly name: string;
  isReady(): boolean;
  show(surface: AllowedAdSurface, format: AdFormat): Promise<boolean>;
  /** Remove a persistent ad (banner). */
  hide?(): Promise<void>;
}

export const NoopAdProvider: AdProvider = {
  name: "noop",
  isReady: () => false,
  show: async () => false,
};

let provider: AdProvider = NoopAdProvider;
export function registerAdProvider(p: AdProvider): void {
  provider = p;
}

/** Hide any persistent ad (safe to call anytime, e.g. when a call starts or the plan upgrades). */
export async function hideAds(): Promise<void> {
  try {
    await provider.hide?.();
  } catch {
    /* nothing to hide */
  }
}

/** Policy-checked entry point for call sites. Never throws; false = nothing shown. */
export async function showAdIfAllowed(ctx: AdContext): Promise<boolean> {
  if (!canShowAd(ctx).show || !provider.isReady()) return false;
  try {
    return await provider.show(ctx.surface as AllowedAdSurface, ctx.format);
  } catch {
    return false;
  }
}
