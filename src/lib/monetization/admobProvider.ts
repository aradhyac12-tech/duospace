// Connects the AdMob native plugin to the ad policy. Android-native only; on
// web/iOS `isReady()` stays false, so nothing is ever drawn.
//
// Ad unit: set VITE_ADMOB_BANNER_UNIT_ID to your REAL banner unit for release
// builds. Unset = Google's TEST banner (safe, earns nothing). Never click your
// own live ads; register your phone as a test device instead.

import { Capacitor } from "@capacitor/core";
import { DuospaceAdmob } from "duospace-admob";
import { registerAdProvider, type AdProvider } from "./adPolicy";
import { FEATURE_FLAGS } from "./config";
import { applyAdInset, mayStartAdSdk, shouldOfferPrivacyChoices, type ConsentOutcome } from "./adConsent";

let ready = false;
let lastConsent: ConsentOutcome | null = null;
let initPromise: Promise<void> | null = null;

// Real unit only in production web bundles; dev/debug builds always get Google's
// TEST banner so the app owner can never click their own live ads (AdMob bans that).
const bannerUnit = (import.meta as any)?.env?.PROD
  ? (((import.meta as any)?.env?.VITE_ADMOB_BANNER_UNIT_ID as string | undefined) || undefined)
  : undefined;

export const admobProvider: AdProvider = {
  name: "admob",
  isReady: () => ready,
  async show(_surface, format) {
    if (format !== "banner") return false; // interstitial/rewarded are not implemented natively yet
    const res = await DuospaceAdmob.showBanner({ adUnitId: bannerUnit });
    // Lift the dock/content above the banner; released again in hide().
    if (typeof document !== "undefined") applyAdInset(document.documentElement.style, res.shown ? res.heightDp : undefined);
    return res.shown;
  },
  async hide() {
    await DuospaceAdmob.hideBanner();
    if (typeof document !== "undefined") applyAdInset(document.documentElement.style, undefined);
  },
};

/** Idempotent. Call once after the user is signed in and on a non-ad-free screen. */
export function initAds(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Do not even start the ad SDK unless ads are switched on for this build.
    if (!FEATURE_FLAGS.adsEnabled) return;
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android") return;
    try {
      // Google UMP first (EEA/UK consent form when required). No consent = SDK never starts.
      lastConsent = await DuospaceAdmob.requestConsent();
      if (!mayStartAdSdk(lastConsent)) return;
      const res = await DuospaceAdmob.initialize();
      ready = res.initialized;
      if (ready) registerAdProvider(admobProvider);
    } catch {
      ready = false;
    }
  })();
  return initPromise;
}

/** True when Google requires an always-reachable "Ad privacy choices" entry point (EEA/UK etc.). */
export function adPrivacyChoicesRequired(): boolean {
  return shouldOfferPrivacyChoices(FEATURE_FLAGS.adsEnabled, lastConsent);
}

/** Re-opens Google's privacy options form. Safe no-op where unavailable. */
export async function openAdPrivacyChoices(): Promise<void> {
  try {
    const res = await DuospaceAdmob.showPrivacyOptions();
    if (res.shown) {
      // The user may have changed consent; refresh so a later init sees the new state.
      lastConsent = await DuospaceAdmob.requestConsent();
    }
  } catch {
    /* nothing to open */
  }
}
