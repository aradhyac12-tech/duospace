/**
 * DuospaceAdmob — draws one anchored adaptive banner (Android only).
 *
 * This plugin has NO opinion about whether an ad is allowed. Never call it
 * directly from a screen: go through src/lib/monetization/adPolicy.ts
 * (canShowAd / showAdIfAllowed) so Free-only, surface allowlist and
 * ad-free-surface rules are always applied.
 */
export interface InitializeOptions {
  /** Device ids (from logcat) that should always receive test ads. */
  testDeviceIds?: string[];
}
export interface InitializeResult {
  initialized: boolean;
  error?: string;
}
export interface ConsentOptions {
  /** Dev/test only: force a region to test the form. Needs testDeviceIds. */
  debugGeography?: "EEA" | "NOT_EEA";
  testDeviceIds?: string[];
}
export interface ConsentResult {
  /** Google's verdict: false until required consent is given (or not needed). */
  canRequestAds: boolean;
  /** True in regions that require an always-reachable "ad privacy choices" entry point. */
  privacyOptionsRequired: boolean;
  error?: string;
}
export interface ShowBannerOptions {
  /** Omit to use Google's TEST banner unit. Production must pass the real one. */
  adUnitId?: string;
}
export interface ShowBannerResult {
  shown: boolean;
  /** Height of the loaded banner in dp, so the web layer can reserve space. */
  heightDp?: number;
  error?: string;
}
export interface DuospaceAdmobPlugin {
  /** Google UMP consent. Call before initialize(); initialize() refuses without it. */
  requestConsent(options?: ConsentOptions): Promise<ConsentResult>;
  /** Re-open the privacy options form (when privacyOptionsRequired). */
  showPrivacyOptions(): Promise<{ shown: boolean; error?: string }>;
  initialize(options?: InitializeOptions): Promise<InitializeResult>;
  showBanner(options?: ShowBannerOptions): Promise<ShowBannerResult>;
  hideBanner(): Promise<void>;
}
