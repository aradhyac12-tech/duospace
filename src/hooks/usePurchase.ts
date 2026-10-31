// Ties together, in the only order that's safe:
//   1. Fetch this account's obfuscated account-binding token from the backend
//   2. DuospaceBilling.purchase() LAUNCHES Play's UI — its resolved value is
//      a launch acknowledgement ONLY (see native-plugins/billing/src/
//      definitions.ts), never the purchase result
//   3. The real result arrives asynchronously via the "purchaseUpdated"
//      event, which this hook listens for
//   4. Only a "purchased" event goes to verify-google-play-purchase; a
//      "pending" event is shown as pending and NEVER verified/granted; a
//      "cancelled"/"error" event resets to idle/error
//   5. Only after the server confirms do we refresh the entitlement the
//      rest of the app reads — acknowledgement now happens server-side
//      (see verify-google-play-purchase), not from the client
//
// FIX (async purchase bug): a prior version of this hook read
// `DuospaceBilling.purchase()`'s own resolved value as if it were the
// purchase outcome, checking it for a `purchaseToken` field that was never
// there — launchBillingFlow() is fire-and-forget, and Play's own UI runs in
// a separate Activity for however long the user takes. This version never
// treats the launch call's return value as proof of anything.
import { useCallback, useEffect, useRef, useState } from "react";
import { DuospaceBilling, type PurchaseUpdatedEvent } from "duospace-billing";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { useEntitlement } from "@/hooks/useEntitlement";
import type { ProductId } from "@/lib/monetization/config";

interface VerifyPurchaseResponse {
  status: "verified" | "invalid" | "duplicate";
  plan?: string;
  reason?: string;
}

interface AccountTokenResponse {
  obfuscatedAccountId: string;
}

type PurchaseFlowState = "idle" | "purchasing" | "pending" | "verifying" | "done" | "error";

const PURCHASE_RESULT_TIMEOUT_MS = 5 * 60 * 1000; // Play's own UI has no hard timeout; this is a UX bound, not a security one — a late event past this window is still processed normally by the persistent listener, just no longer reflected in this specific buy() call's UI state.

/** Sends a verified "purchased" event to the backend. Exported so the
 *  restore-purchases flow can reuse the exact same verification path a
 *  fresh purchase uses — there must only be one way a purchase becomes an
 *  entitlement. */
// Same token submitted twice at once (live purchase event + restore pass, or a
// redelivered event) shares ONE in-flight verification instead of racing two.
// The backend is idempotent too; this just avoids the redundant round trip.
const inFlightVerifications = new Map<string, Promise<VerifyPurchaseResponse>>();

export async function verifyPurchase(
  event: PurchaseUpdatedEvent,
  obfuscatedAccountId: string,
): Promise<VerifyPurchaseResponse> {
  const key = event.purchaseToken ?? "";
  const existing = inFlightVerifications.get(key);
  if (existing) return existing;
  const promise = invokeEdgeFunction<VerifyPurchaseResponse>("verify-google-play-purchase", {
    body: {
      productId: event.productId,
      purchaseToken: event.purchaseToken,
      obfuscatedAccountId,
    },
  }).finally(() => inFlightVerifications.delete(key));
  inFlightVerifications.set(key, promise);
  return promise;
}

export function usePurchase() {
  const { refreshEntitlement } = useEntitlement();
  const [state, setState] = useState<PurchaseFlowState>("idle");
  const [error, setError] = useState<string | null>(null);
  const pendingResolvers = useRef(
    new Map<string, (event: PurchaseUpdatedEvent) => void>(),
  );

  // One persistent listener for the lifetime of this hook instance — not
  // just during buy() — so a result that arrives after the app was
  // backgrounded/resumed during the Play UI flow is still caught, not just
  // results that happen to land while a buy() promise is still awaited.
  useEffect(() => {
    const handlePromise = DuospaceBilling.addListener("purchaseUpdated", (event) => {
      const resolver = pendingResolvers.current.get(event.productId);
      if (resolver) {
        pendingResolvers.current.delete(event.productId);
        resolver(event);
      }
      // An event with no matching resolver (e.g. arrived after this
      // component unmounted and remounted, or from a queryActivePurchases-
      // adjacent path) is exactly what the restore-purchases flow exists to
      // reconcile on next launch — this hook doesn't need to do anything
      // with it here.
    });
    return () => {
      handlePromise.then((handle) => handle.remove());
    };
  }, []);

  const waitForPurchaseUpdate = useCallback(
    (productId: string): Promise<PurchaseUpdatedEvent> =>
      new Promise((resolve, reject) => {
        pendingResolvers.current.set(productId, resolve);
        setTimeout(() => {
          if (pendingResolvers.current.has(productId)) {
            pendingResolvers.current.delete(productId);
            reject(new Error("Timed out waiting for Google Play to respond."));
          }
        }, PURCHASE_RESULT_TIMEOUT_MS);
      }),
    [],
  );

  const buy = useCallback(
    async (productId: ProductId) => {
      setError(null);
      setState("purchasing");
      try {
        await DuospaceBilling.connect();
        const { products } = await DuospaceBilling.getProducts({ productIds: [productId] });

        // Explicit offer selection: the plain base plan (no promotional
        // offerId). If Play returns zero or several base plans we stop and
        // report it rather than silently buying whichever came first.
        const basePlanOffers = (products[0]?.offers ?? []).filter((o) => !o.offerId);
        if (basePlanOffers.length !== 1) {
          setState("error");
          setError("This plan isn't available to purchase right now.");
          return;
        }
        const basePlanId = basePlanOffers[0].basePlanId;

        const { obfuscatedAccountId } = await invokeEdgeFunction<AccountTokenResponse>(
          "get-billing-account-token",
          { body: {} },
        );

        const resultPromise = waitForPurchaseUpdate(productId);
        const launch = await DuospaceBilling.purchase({ productId, basePlanId, obfuscatedAccountId });
        if (!launch.launched) {
          pendingResolvers.current.delete(productId);
          setState("error");
          setError(launch.errorMessage ?? "Couldn't open Google Play.");
          return;
        }

        const event = await resultPromise;

        switch (event.state) {
          case "cancelled":
            setState("idle");
            return;
          case "pending":
            // PHASE 3: a pending purchase (e.g. a cash payment method still
            // being collected) must NEVER unlock Plus. It may resolve to
            // "purchased" later via a fresh purchaseUpdated event, RTDN, or
            // the restore-on-launch pass — this buy() call's job ends here.
            setState("pending");
            return;
          case "unspecified":
          case "error":
            setState("error");
            setError(event.errorMessage ?? "Purchase failed.");
            return;
          case "purchased":
            break; // fall through to verification below
        }

        if (!event.purchaseToken) {
          setState("error");
          setError("Purchase completed but no token was returned — please contact support.");
          return;
        }

        setState("verifying");
        let verifyResult: VerifyPurchaseResponse;
        try {
          verifyResult = await verifyPurchase(event, obfuscatedAccountId);
        } catch {
          setState("error");
          setError("We couldn't confirm this purchase. If you were charged, it will be refunded automatically.");
          return;
        }

        if (verifyResult.status !== "verified") {
          setState("error");
          setError("We couldn't confirm this purchase. If you were charged, it will be refunded automatically.");
          return;
        }

        // Acknowledgement now happens server-side inside
        // verify-google-play-purchase, immediately after verification —
        // never dependent on this client call completing.
        await refreshEntitlement();
        setState("done");
      } catch (e) {
        setState("error");
        setError(e instanceof Error ? e.message : "Something went wrong.");
      }
    },
    [refreshEntitlement, waitForPurchaseUpdate],
  );

  return { buy, state, error };
}
