// Pure helpers for the ad consent + layout flow. Kept free of Capacitor/DOM
// imports so they can be unit-tested; admobProvider.ts wires them to the plugin.

export interface ConsentOutcome {
  canRequestAds: boolean;
  privacyOptionsRequired?: boolean;
  error?: string;
}

/** The ad SDK may start only when Google's consent flow says ads can be requested. Fail closed. */
export function mayStartAdSdk(outcome: ConsentOutcome | null | undefined): boolean {
  return outcome?.canRequestAds === true;
}

/** Show the "Ad privacy choices" entry point only where Google requires it. */
export function shouldOfferPrivacyChoices(adsEnabled: boolean, outcome: ConsentOutcome | null | undefined): boolean {
  return adsEnabled && outcome?.privacyOptionsRequired === true;
}

export const AD_INSET_VAR = "--ad-banner-height";

/** Reserve (or release) space for the native banner so it never covers the dock or page content. */
export function applyAdInset(
  style: { setProperty(name: string, value: string): void; removeProperty(name: string): string | void },
  heightDp: number | undefined,
): void {
  if (heightDp && heightDp > 0) style.setProperty(AD_INSET_VAR, `${Math.round(heightDp)}px`);
  else style.removeProperty(AD_INSET_VAR);
}
