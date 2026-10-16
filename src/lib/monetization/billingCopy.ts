// Truthful billing copy for the paywall. Play subscriptions renew; Razorpay in
// the default "order" mode is a ONE-TIME 30-day pass and must never say it
// renews; only "subscription" mode (VITE_RAZORPAY_MODE=subscription) renews.
// Pure so it can be unit-tested; the screen just renders what this returns.

export type RazorpayMode = "order" | "subscription";
export type BillingMethod = "google_play" | "razorpay" | "apple_iap";

export function razorpayModeFrom(raw: unknown): RazorpayMode {
  return raw === "subscription" ? "subscription" : "order";
}

export const RAZORPAY_MODE: RazorpayMode = razorpayModeFrom((import.meta as any)?.env?.VITE_RAZORPAY_MODE);

/** Caption under the price. Razorpay-only order mode is not a monthly renewal. */
export function priceCaption(methods: readonly BillingMethod[], mode: RazorpayMode = RAZORPAY_MODE): string {
  const razorpayOneTimeOnly = methods.includes("razorpay") && !methods.includes("google_play") && mode === "order";
  return razorpayOneTimeOnly ? "for 30 days" : "per month";
}

/** One line under a payment button saying exactly what that button does. */
export function methodNote(method: BillingMethod, mode: RazorpayMode = RAZORPAY_MODE): string | null {
  if (method === "google_play") return "Renews monthly. Cancel anytime in Google Play.";
  if (method === "razorpay") {
    return mode === "subscription"
      ? "Renews monthly until you cancel it here. Cancelling keeps access until the period ends."
      : "One-time payment for 30 days. It does not renew automatically.";
  }
  return null;
}
