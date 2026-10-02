// PHASE 5 — restore/recovery. The app must not depend solely on the
// purchaseUpdated callback from a live purchase() call: that callback can
// be missed entirely (app killed mid-flow, device changed, app data
// cleared, app was offline when Play tried to deliver it, or the purchase
// was made from a different install of the app). This hook asks Google
// directly what it currently considers active for this device/account and
// runs each one through the SAME verify-google-play-purchase path a fresh
// purchase uses — never granting Plus just because a local record exists.
//
// Runs on: mount (covers app launch), the user becoming authenticated
// (covers sign-in after a fresh install), and the app returning to the
// foreground (covers "was offline when the purchase settled" and "bought
// on another device while this one was backgrounded").
import { useEffect, useRef } from "react";
import { App } from "@capacitor/app";
import { DuospaceBilling } from "duospace-billing";
import { invokeEdgeFunction } from "@/lib/edgeFunction";
import { useAuth } from "@/hooks/useAuth";
import { useEntitlement } from "@/hooks/useEntitlement";
import { verifyPurchase } from "@/hooks/usePurchase";

interface AccountTokenResponse {
  obfuscatedAccountId: string;
}

export function useRestorePurchases() {
  const { user } = useAuth();
  const { refreshEntitlement } = useEntitlement();
  const inFlight = useRef(false);

  const restore = async () => {
    if (!user || inFlight.current) return;
    inFlight.current = true;
    try {
      const { state } = await DuospaceBilling.connect();
      if (state !== "connected") return; // billing genuinely unavailable on this device — not an error to surface, just nothing to restore

      const { purchases } = await DuospaceBilling.queryActivePurchases();
      if (purchases.length === 0) return;

      const { obfuscatedAccountId } = await invokeEdgeFunction<AccountTokenResponse>(
        "get-billing-account-token",
        { body: {} },
      );

      let anyVerified = false;
      for (const purchase of purchases) {
        // Same gate as a live purchase: only a genuinely purchased
        // subscription is ever sent for verification. A "pending" entry
        // found here (e.g. a cash payment still settling) is left alone —
        // it'll show up again on a future restore pass once Google
        // considers it purchased.
        if (purchase.state !== "purchased" || !purchase.purchaseToken) continue;
        try {
          const result = await verifyPurchase(purchase, obfuscatedAccountId);
          if (result.status === "verified") anyVerified = true;
        } catch {
          // One failed restore attempt for one token shouldn't block
          // reconciling the others, and shouldn't be surfaced as an error —
          // this runs silently in the background. It'll retry next launch/
          // resume.
        }
      }

      if (anyVerified) await refreshEntitlement();
    } finally {
      inFlight.current = false;
    }
  };

  useEffect(() => {
    restore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    const listenerPromise = App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) restore();
    });
    return () => {
      listenerPromise.then((handle) => handle.remove());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
}
