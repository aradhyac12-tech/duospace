import { describe, expect, it } from "vitest";
import { methodNote, priceCaption, razorpayModeFrom } from "@/lib/monetization/billingCopy";

describe("billing copy", () => {
  it("defaults to order mode unless explicitly subscription", () => {
    expect(razorpayModeFrom(undefined)).toBe("order");
    expect(razorpayModeFrom("order")).toBe("order");
    expect(razorpayModeFrom("sub")).toBe("order");
    expect(razorpayModeFrom("subscription")).toBe("subscription");
  });

  it("never claims a Razorpay order-mode pass renews", () => {
    expect(methodNote("razorpay", "order")).toMatch(/does not renew/i);
    expect(methodNote("razorpay", "order")).not.toMatch(/renews monthly/i);
    expect(priceCaption(["razorpay"], "order")).toBe("for 30 days");
  });

  it("says renews only for Play and Razorpay subscription mode", () => {
    expect(methodNote("google_play", "order")).toMatch(/renews monthly/i);
    expect(methodNote("razorpay", "subscription")).toMatch(/renews monthly/i);
    expect(priceCaption(["razorpay"], "subscription")).toBe("per month");
  });

  it("keeps 'per month' whenever Play is offered, even alongside Razorpay order mode", () => {
    expect(priceCaption(["google_play", "razorpay"], "order")).toBe("per month");
    expect(priceCaption([], "order")).toBe("per month");
  });

  it("has no note for Apple (not live)", () => {
    expect(methodNote("apple_iap")).toBeNull();
  });
});
