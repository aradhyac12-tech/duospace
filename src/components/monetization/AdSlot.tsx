// Drop-in banner slot. Renders nothing itself: the banner is a native overlay
// pinned to the bottom of the screen. All rules (Free plan only, allowed
// surfaces only, never in chat/calls/login/linking) come from adPolicy.ts.
//
// Usage on an allowed screen:   <AdSlot surface="settings_footer" />
// The provider publishes the banner height as --ad-banner-height, which the
// floating dock and --dock-reserve add, so the banner sits BELOW the dock.
// Pass `suppressed` while a full-screen viewer/selection UI is open.

import { useEffect } from "react";
import { useEntitlement } from "@/hooks/useEntitlement";
import { hideAds, showAdIfAllowed, type AllowedAdSurface } from "@/lib/monetization/adPolicy";
import { initAds } from "@/lib/monetization/admobProvider";

export function AdSlot({ surface, suppressed = false }: { surface: AllowedAdSurface; suppressed?: boolean }) {
  const { plan, status } = useEntitlement();

  useEffect(() => {
    // Wait for the real plan: never flash an ad at a paying user while it loads.
    if (status !== "ready" || suppressed) return;
    let cancelled = false;
    (async () => {
      await initAds();
      if (cancelled) return;
      await showAdIfAllowed({ plan, surface, format: "banner" });
    })();
    return () => {
      cancelled = true;
      void hideAds();
    };
  }, [plan, status, surface, suppressed]);

  return null;
}
