// Razorpay Standard Web Checkout — the sideload/alt-billing payment path
// (see src/lib/monetization/paymentRouting.ts for when this is actually
// offered; Play-distributed builds must use Google Play Billing instead,
// per Play policy, and this hook is never surfaced there by default).
//
// Flow: create-razorpay-order (or create-razorpay-subscription when
// VITE_RAZORPAY_MODE=subscription; server, real amount from the catalog) ->
// Razorpay Checkout modal -> razorpay_payment_id/order_id/signature ->
// verify-razorpay-payment (server, recomputes the HMAC) -> entitlement
// refresh. The Checkout success callback is never itself treated as proof
// of payment — only a server-verified signature is.
import { useCallback, useRef, useState } from "react";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { useEntitlement } from "@/hooks/useEntitlement";
import type { ProductId } from "@/lib/monetization/config";

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

// "order" (default) = one-time 30-day pass. "subscription" = auto-renewing
// Razorpay Subscriptions (needs Subscriptions/UPI AutoPay enabled on the
// Razorpay account). Build-time flag so it is switched on deliberately.
const SUBSCRIPTION_MODE = (import.meta as any)?.env?.VITE_RAZORPAY_MODE === "subscription";

const CHECKOUT_SCRIPT_SRC = "https://checkout.razorpay.com/v1/checkout.js";

function loadRazorpayScript(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${CHECKOUT_SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Failed to load Razorpay Checkout")));
      return;
    }
    const script = document.createElement("script");
    script.src = CHECKOUT_SCRIPT_SRC;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Razorpay Checkout"));
    document.body.appendChild(script);
  });
}

interface CreateOrderResponse {
  orderId: string;
  keyId: string;
  amountMinor: number;
  currency: string;
}

interface CreateSubscriptionResponse {
  subscriptionId: string;
  keyId: string;
}

interface VerifyResponse {
  status: "verified";
}

type RazorpayFlowState = "idle" | "creating_order" | "awaiting_payment" | "verifying" | "done" | "error" | "cancelled";

const PLAN_TO_PLAN_NAME: Record<ProductId, "PLUS_INDIVIDUAL" | "PLUS_COUPLE" | "PRO_INDIVIDUAL" | "PRO_COUPLE"> = {
  duospace_plus_individual_monthly: "PLUS_INDIVIDUAL",
  duospace_plus_couple_monthly: "PLUS_COUPLE",
  duospace_pro_individual_monthly: "PRO_INDIVIDUAL",
  duospace_pro_couple_monthly: "PRO_COUPLE",
};

const PLAN_LABELS = {
  PLUS_INDIVIDUAL: "Plus (just me)", PLUS_COUPLE: "Plus (both of us)",
  PRO_INDIVIDUAL: "Pro (just me)", PRO_COUPLE: "Pro (both of us)",
} as const;

export function useRazorpayCheckout() {
  const { refreshEntitlement } = useEntitlement();
  const [state, setState] = useState<RazorpayFlowState>("idle");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const pay = useCallback(
    async (productId: ProductId) => {
      if (busy.current) return;
      busy.current = true;
      setError(null);
      setState("creating_order");
      try {
        await loadRazorpayScript();

        const planName = PLAN_TO_PLAN_NAME[productId];
        type Paid = { razorpay_payment_id: string; razorpay_signature: string; razorpay_order_id?: string; razorpay_subscription_id?: string };

        const checkoutOptions: Record<string, unknown> = SUBSCRIPTION_MODE
          ? await (async () => {
              const sub = await invokeEdgeFunction<CreateSubscriptionResponse>("create-razorpay-subscription", { body: { plan: planName } });
              return { key: sub.keyId, subscription_id: sub.subscriptionId };
            })()
          : await (async () => {
              const order = await invokeEdgeFunction<CreateOrderResponse>("create-razorpay-order", { body: { plan: planName } });
              return { key: order.keyId, order_id: order.orderId, amount: order.amountMinor, currency: order.currency };
            })();

        setState("awaiting_payment");

        const result = await new Promise<({ status: "success" } & Paid) | { status: "cancelled" }>((resolve) => {
          const rzp = new window.Razorpay!({
            ...checkoutOptions,
            name: "DuoSpace",
            description: PLAN_LABELS[planName],
            handler: (response: Paid) => {
              resolve({ status: "success", ...response });
            },
            modal: {
              // Fires when the user dismisses the modal without paying —
              // maps to the same "cancelled" outcome as Play's USER_CANCELED.
              ondismiss: () => resolve({ status: "cancelled" }),
            },
          });
          rzp.open();
        });

        if (result.status === "cancelled") {
          setState("cancelled");
          return;
        }

        setState("verifying");
        try {
          const verify = await invokeEdgeFunction<VerifyResponse>("verify-razorpay-payment", {
            body: {
              razorpay_order_id: result.razorpay_order_id,
              razorpay_subscription_id: result.razorpay_subscription_id,
              razorpay_payment_id: result.razorpay_payment_id,
              razorpay_signature: result.razorpay_signature,
            },
          });
          if (verify.status !== "verified") throw new Error("not verified");
        } catch {
          setState("error");
          setError("We couldn't confirm this payment. If you were charged, it will reconcile automatically shortly.");
          return;
        }

        await refreshEntitlement();
        setState("done");
      } catch (e) {
        setState("error");
        setError(e instanceof Error ? e.message : "Something went wrong.");
      } finally {
        busy.current = false;
      }
    },
    [refreshEntitlement],
  );

  return { pay, state, error };
}
