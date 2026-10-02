// "Ad privacy choices" entry point. Google requires this to be reachable in
// regions where the consent form applies (EEA/UK etc.); elsewhere it renders
// nothing. Shown only when ads are on, the SDK consent flow has run, and
// Google reports privacyOptionsRequired.

import { useEffect, useState } from "react";
import { adPrivacyChoicesRequired, initAds, openAdPrivacyChoices } from "@/lib/monetization/admobProvider";

export function AdPrivacyChoices() {
  const [required, setRequired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void initAds().then(() => {
      if (!cancelled) setRequired(adPrivacyChoicesRequired());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!required) return null;
  return (
    <div className="px-5 pt-2 pb-4 text-center">
      <button
        type="button"
        onClick={() => void openAdPrivacyChoices()}
        className="text-[11px] text-muted-foreground underline underline-offset-2"
      >
        Ad privacy choices
      </button>
    </div>
  );
}
