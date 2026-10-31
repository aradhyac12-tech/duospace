# duospace-billing

Local Capacitor plugin wrapping Google Play Billing Library 7 for DuoSpace's
two subscription products (`duospace_plus_individual_monthly`,
`duospace_plus_couple_monthly` — see `src/lib/monetization/config.ts` in the
root app for the single source of truth on IDs/pricing).

Android only. `src/web.ts` is an honest no-op, not a fake success — there is
no web equivalent of Play Billing.

**Security model:** this plugin only reports what the device's Play Store
client says. The app must always send `purchase()`'s `purchaseToken` to the
`verify-google-play-purchase` Supabase Edge Function before treating any
purchase as real or acknowledging it. See `src/definitions.ts`'s header
and `src/hooks/usePurchase.ts` in the root app for the correct end-to-end
flow.

## Setup still required (Play Console / production credentials)
- Create the two subscription products in Play Console with these exact IDs.
- Add `com.android.billingclient:billing-ktx` is already declared in
  `android/build.gradle` — no extra step needed there.
- No new runtime permission is required.
