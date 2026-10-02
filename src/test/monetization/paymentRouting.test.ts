import { describe, it, expect } from "vitest";
import { getAvailablePaymentMethods, type RoutingContext } from "@/lib/monetization/paymentRouting";

const base: RoutingContext = {
  distribution: "play_store", country: "IN", platform: "android",
  alternativeBillingEnrolled: false, razorpayConfigured: true,
};

describe("getAvailablePaymentMethods", () => {
  it("Play install in India without enrollment: Google Play only", () => {
    expect(getAvailablePaymentMethods(base)).toEqual(["google_play"]);
  });
  it("Play install in India WITH enrollment and Razorpay configured: both", () => {
    expect(getAvailablePaymentMethods({ ...base, alternativeBillingEnrolled: true })).toEqual(["google_play", "razorpay"]);
  });
  it("never offers Razorpay to a Play user whose country is unknown", () => {
    expect(getAvailablePaymentMethods({ ...base, country: null, alternativeBillingEnrolled: true })).toEqual(["google_play"]);
  });
  it("never offers Razorpay to Play users outside India", () => {
    expect(getAvailablePaymentMethods({ ...base, country: "US", alternativeBillingEnrolled: true })).toEqual(["google_play"]);
  });
  it("sideload: Razorpay only when configured", () => {
    expect(getAvailablePaymentMethods({ ...base, distribution: "sideload" })).toEqual(["razorpay"]);
    expect(getAvailablePaymentMethods({ ...base, distribution: "sideload", razorpayConfigured: false })).toEqual([]);
  });
  it("app store: Apple IAP only, never Razorpay", () => {
    expect(getAvailablePaymentMethods({ ...base, distribution: "app_store" })).toEqual(["apple_iap"]);
  });
  it("web: Razorpay only when configured", () => {
    expect(getAvailablePaymentMethods({ ...base, distribution: "web" })).toEqual(["razorpay"]);
    expect(getAvailablePaymentMethods({ ...base, distribution: "web", razorpayConfigured: false })).toEqual([]);
  });
});
