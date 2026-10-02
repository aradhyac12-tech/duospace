// PHASE 13 — payment routing. Decides which payment methods DuoSpace may
// offer, from facts about HOW the app was installed and WHERE the account is
// billed — never from device locale, VPN or IP guesses alone.
//
// Conservative by design: anything not explicitly allowed below returns an
// empty list, so an unrecognized distribution cannot accidentally expose
// Razorpay (which would break Google Play policy for Play installs).
//
// STATUS: routing logic is implemented. Two inputs are NOT yet wired to
// trusted sources and are marked below:
//  - `country`: must come from a trusted server/Play context (e.g. Play
//    Billing's getBillingConfig country code, or a server-side determination),
//    not from navigator.language.
//  - `alternativeBillingEnrolled`: true only once DuoSpace is actually
//    enrolled in Google Play's alternative billing program for India and the
//    external-transaction reporting is set up (REQUIRES GOOGLE ALTERNATIVE
//    BILLING ENROLLMENT). It is false in this codebase.

export type Distribution = "play_store" | "sideload" | "app_store" | "web";
export type PaymentMethod = "google_play" | "razorpay" | "apple_iap";

export interface RoutingContext {
  distribution: Distribution;
  /** ISO country from a TRUSTED source — see file header. */
  country: string | null;
  platform: "android" | "ios" | "web";
  /** Whether Play alternative billing is enrolled + configured (external). */
  alternativeBillingEnrolled: boolean;
  /** Whether the Razorpay provider has credentials + plan IDs configured. */
  razorpayConfigured: boolean;
}

export function getAvailablePaymentMethods(ctx: RoutingContext): PaymentMethod[] {
  switch (ctx.distribution) {
    case "play_store": {
      // Google Play distribution: Play Billing is the default and always
      // the compliant path. Razorpay is offered ONLY where Google's
      // alternative billing program permits it (India, once enrolled) —
      // and never to a user whose country we can't establish.
      const methods: PaymentMethod[] = ["google_play"];
      if (ctx.country === "IN" && ctx.alternativeBillingEnrolled && ctx.razorpayConfigured) {
        methods.push("razorpay");
      }
      return methods;
    }
    case "sideload":
      // Not distributed through Play, so Play's billing policy doesn't
      // apply. Razorpay is the only working option (Play Billing needs a
      // Play-installed app). Commercial/legal configuration still applies.
      return ctx.razorpayConfigured ? ["razorpay"] : [];
    case "app_store":
      // iOS (.ipa): Apple In-App Purchase only — never Razorpay.
      return ["apple_iap"];
    case "web":
      // Browser build (also the easiest way to test payments): Razorpay
      // Checkout works in any browser and no store policy applies.
      return ctx.razorpayConfigured ? ["razorpay"] : [];
    default:
      return [];
  }
}

/** Human copy for the paywall footer, derived from what's actually available. */
export function paymentMethodsCopy(methods: PaymentMethod[]): string {
  if (methods.length === 0) return "Purchases aren't available on this install yet.";
  const parts = methods.map((m) =>
    m === "google_play" ? "Google Play" : m === "razorpay" ? "UPI or card (Razorpay)" : "the App Store",
  );
  return `Billed monthly via ${parts.join(" or ")}. Cancel anytime — no long-term commitment, no hidden fees.`;
}
