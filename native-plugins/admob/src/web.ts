/** Web fallback: there are no ads on web. Reports "not shown" instead of faking success. */
import { WebPlugin } from "@capacitor/core";
import type { ConsentResult, DuospaceAdmobPlugin, InitializeResult, ShowBannerResult } from "./definitions";

export class AdmobWeb extends WebPlugin implements DuospaceAdmobPlugin {
  async requestConsent(): Promise<ConsentResult> {
    return { canRequestAds: false, privacyOptionsRequired: false, error: "unavailable_on_web" };
  }
  async showPrivacyOptions(): Promise<{ shown: boolean }> {
    return { shown: false };
  }
  async initialize(): Promise<InitializeResult> {
    return { initialized: false, error: "unavailable_on_web" };
  }
  async showBanner(): Promise<ShowBannerResult> {
    return { shown: false, error: "unavailable_on_web" };
  }
  async hideBanner(): Promise<void> {}
}
