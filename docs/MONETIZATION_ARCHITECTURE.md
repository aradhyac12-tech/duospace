# DuoSpace Monetization Architecture

Status key used throughout: **IMPLEMENTED** / **CONFIGURED BUT NOT ACTIVATED** / **REQUIRES GOOGLE PLAY CONSOLE CONFIGURATION** / **REQUIRES PRODUCTION CREDENTIALS**

## 1. What already existed
Nothing. A full-codebase search (`subscription|billing|purchase|entitlement|premium|admob|productId|sku`)
found zero monetization code. The handful of "subscription" hits were Supabase
Auth's `onAuthStateChange` subscription — unrelated. This build starts from a
clean slate on top of the existing pairing model: `profiles.partner_id`
(symmetric, no separate `couples` table), managed by
`get_partner_id()`/`get_effective_entitlement()`-style SECURITY DEFINER
functions that validate `auth.uid()` themselves — the same pattern this repo
already used for `get_partner_id`.

## 2. What changed — files
- `supabase/migrations/20260926120000_monetization_entitlements_foundation.sql` — **IMPLEMENTED**
- `src/lib/monetization/config.ts` — **IMPLEMENTED**
- `src/hooks/useEntitlement.ts` — **IMPLEMENTED**
- `supabase/functions/verify-google-play-purchase/index.ts` — **IMPLEMENTED** (structure, replay protection, entitlement write) / **REQUIRES PRODUCTION CREDENTIALS** (actual Google Play API call)
- `docs/MONETIZATION_ARCHITECTURE.md` — this file

No existing file was modified. Chat, Calls, navigation, and visual design are untouched.

## 3. Database / schema changes
Two new tables, additive only:

- **`entitlements`** — one row per purchasing user. `plan` is one of
  `FREE, PLUS_INDIVIDUAL, PLUS_COUPLE, LIFETIME, FOUNDER, BETA, ADMIN`.
  Never duplicated onto a partner.
- **`purchase_events`** — audit trail of every purchase notification,
  keyed by `UNIQUE(platform, purchase_token_hash)` for hard replay
  protection. Raw purchase tokens are never stored — only a SHA-256 hash.

Both have RLS enabled with a `SELECT`-only policy scoped to `user_id =
auth.uid()`. **There is no INSERT/UPDATE policy for `authenticated` on
either table** — this is what makes "client says I paid" structurally
impossible, not just discouraged. All writes happen from
`verify-google-play-purchase` using the service role.

## 4. Entitlement architecture — the couple-plan risk, handled
`get_effective_entitlement(user_id)` is computed **live**, every call:
1. Does the user have their own active entitlement? (ADMIN > FOUNDER >
   LIFETIME > PLUS_COUPLE > PLUS_INDIVIDUAL > BETA, highest wins)
2. If not, does their **current** `profiles.partner_id` hold an active
   `PLUS_COUPLE` entitlement, *and* does that partner's profile currently
   point back at them?

Because step 2 reads `profiles.partner_id` live rather than a cached couple
ID, the exact scenario in the spec resolves correctly:
- A buys Couple Plus → B (currently linked) gets it live.
- A unlinks B → B's next check finds partner_id no longer points to A → B loses it immediately.
- A links C → C's next check finds A holds Couple Plus and A→C is mutual → C gets it. This is correct: A is still the one paying, and coverage always follows A's current, real partner.

A client-side `useEntitlement()` hook exposes this via
`public.my_entitlement` (a thin view over the same function) — it never
locally computes or overrides plan status.

## 5. Billing architecture
Product IDs (single source of truth in `src/lib/monetization/config.ts`):
- `duospace_plus_individual_monthly` → ₹149/month fallback display price
- `duospace_plus_couple_monthly` → ₹199/month fallback display price

**IMPLEMENTED** this pass: `native-plugins/billing` — a new local Capacitor
plugin (registered in root `package.json` as `duospace-billing`, following
the exact `file:./native-plugins/*` pattern the other plugins use) wrapping
Google Play Billing Library 7 (`connect`, `getProducts`, `purchase`,
`queryActivePurchases`, `acknowledgePurchase`, plus a `purchaseUpdated`
listener). Android only — `src/web.ts` honestly reports "unavailable"
rather than faking success, since there is no web equivalent.

`src/hooks/usePurchase.ts` wires the full, safe order end to end:
1. `DuospaceBilling.purchase()` launches Play's native purchase UI.
2. The resulting `{ productId, purchaseToken }` is sent to
   `verify-google-play-purchase` via the repo's existing hardened
   `invokeEdgeFunction` wrapper (`src/lib/edgeFunction.ts`) — not raw
   `supabase.functions.invoke`, to match every other call site.
3. Only on a `"verified"` response does the hook call
   `acknowledgePurchase()` and then `refreshEntitlement()`. An unverified
   purchase is deliberately never acknowledged, so Google auto-refunds it.

Both `node scripts/check-rls-coverage.mjs` and
`node scripts/verify-android-build.mjs --deps` (this repo's own gates)
pass with the new plugin and tables in place.

Real prices must come from Google Play's `ProductDetails` at runtime
(`getProducts()` does this) — `FALLBACK_DISPLAY_PRICING` is only for the
brief window before that resolves, or a non-Android context.

Still open: the actual server-side call inside
`verifyWithGooglePlay()` to Google's `purchases.subscriptions.get` is a
stub that throws — **REQUIRES PRODUCTION CREDENTIALS**: a
`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` Supabase secret from the Play Console,
which only you can provision. Until that's wired in, every real purchase
attempt will correctly fail verification (and therefore fail closed,
granting nothing) rather than silently succeeding.

## 6. Ads architecture
**NOT YET IMPLEMENTED.** No AdMob code exists or was added. `AD_FREE_SURFACES`
in `config.ts` documents the non-negotiable list (chat, calls, login,
linking, etc.) as a checklist for whenever an `AdService` abstraction is
built — deliberately not built yet, since Phase 8 says to centralize it
rather than scatter calls, and there's no ad SDK dependency in `package.json`
to build it around yet.

## 7. Founder/Beta/Admin architecture
Supported by the `entitlements.source` values (`founder_grant`,
`beta_grant`, `admin_grant`) and `granted_by` column. **No admin UI/RPC to
grant these was built in this pass** — writes are service-role only by
design, so today that means an operator running a SQL insert via the
Supabase dashboard. A safe granting RPC is a clear next step (see below),
not a hard-coded email check.

## 8. Security findings
- Confirmed: no pre-existing hard-coded premium checks anywhere in the codebase.
- New tables pass the repo's own `node scripts/check-rls-coverage.mjs` (basic presence check only — see that script's own header for what it can't prove).
- `get_effective_entitlement` and the `my_entitlement` view both re-validate `auth.uid()` — a user cannot query another user's entitlement.
- No Google credentials, service-role keys, or secrets were added to any client-reachable file.

## 9. Files changed
See section 2.

## 10. Tests executed and results
**Not executed.** This container has no network access, so `npm install`
failed (registry 403) and neither `npm run build`, `npm run lint`, nor
`npm run test` could run. `node scripts/check-rls-coverage.mjs` (pure
Node, no deps) was run and **passed**. Be certain to run the full
`npm run build && npm run lint && npm run test` locally before shipping —
I have not verified them.

## 11. Build result
Not verified — see above.

## 12. Requires Google Play Console configuration
- Create FOUR subscription products: `duospace_plus_individual_monthly`, `duospace_plus_couple_monthly`, `duospace_pro_individual_monthly`, `duospace_pro_couple_monthly` (launch prices ₹149 / ₹199 / ₹299 / ₹399 per month; each with exactly one base plan and no promotional offer).
- Generate a service-account key with Play Android Developer API access and set it as the `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` Supabase secret.

## 13. Current status (updated for the Plus/Pro phase — see docs/DUOSPACE_PLAN_MATRIX.md and docs/DUOSPACE_FEATURE_AUDIT.md)
- IMPLEMENTED: PLUS/PRO level x INDIVIDUAL/COUPLE model, precedence resolver, live mutual-partner inheritance, server AI quota (`consume_ai_quota`), Pro catalog rows, paywall (Free/Plus/Pro + scope switch), Play Billing client plugin (`native-plugins/billing`, `usePurchase.ts`), Razorpay web checkout.
- IMPLEMENTED (2026-09-30, `supabase/functions/_shared/googlePlay.ts`): real `verifyWithGooglePlay` (service-account OAuth -> `subscriptionsv2.get`, product-match check, state mapping: ACTIVE/GRACE/CANCELED-in-period grant, everything else does not), real `acknowledgeWithGooglePlay` (skipped when Google already reports acknowledged), and real `verifyPubSubJwt` (RS256 vs Google JWKS, issuer, audience, expiry, push service-account email; fails closed when unconfigured). 8 offline tests pass (`_shared/tests/googlePlay.test.ts`, Deno-native; also run under Node 22 with a Deno.test shim). NOT yet run against live Google: needs the secrets below.
- STILL REQUIRES YOUR CREDENTIALS: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (Play Console -> API access), and for RTDN `PUBSUB_PUSH_AUDIENCE` + `PUBSUB_PUSH_SERVICE_ACCOUNT_EMAIL`. Until set, Play purchases fail closed (grant nothing) and RTDN returns 401.
- Razorpay auto-renewing subscriptions (2026-09-30): `create-razorpay-subscription` (creates the Razorpay Plan from the catalog price on first use and stores `razorpay_plan_id`), `verify-razorpay-payment` now also verifies subscriptions (signature is `payment_id|subscription_id`, the reverse of orders), and the existing webhook already maps subscription.* events. The client uses it only when `VITE_RAZORPAY_MODE=subscription`; default stays the one-time order. NOT tested against Razorpay: needs Subscriptions/UPI AutoPay enabled on the account, deploy of the new function, and webhook events subscription.* enabled. Paywall copy must keep calling the order mode a 30-day pass and only say "renews" once the mode is on.
- Cancel renewal (2026-09-30): `cancel-razorpay-subscription` (subscription id looked up server-side from the caller's own active ledger row; `cancel_at_cycle_end=1`, access kept until the paid period ends) + `useRazorpaySubscription` + a "Cancel renewal" link on the active-plan card (shown only for an active Razorpay subscription). Must be deployed together with `create-razorpay-subscription`; do not enable `VITE_RAZORPAY_MODE=subscription` without it. Untested against Razorpay.
- Razorpay order mode is a ONE-TIME 30-day order, not an auto-renewing subscription. It is classified as a temporary web/sideload purchase; it does not renew and must not be described as a subscription.
- Google ledger rows now record the catalog base price (list price, not Google's settled amount) instead of 0.
- Apple IAP: not built (no StoreKit plugin, no App Store Server verification).
- Ads: policy layer built (2026-09-30, `src/lib/monetization/adPolicy.ts`, 10 tests): default-deny surface allowlist (settings/gallery/plans footers only), chat/calls/login/linking/media viewer always blocked, Free plan only (Plus/Pro/complimentary ad-free), rewarded ads need a user tap, interstitials capped to one per 5 min, `VITE_ADS_ENABLED` still false. Local plugin `native-plugins/admob` (Kotlin, play-services-ads 23.6.0, Google TEST ids by default) + `admobProvider.ts` + `<AdSlot/>` now exist, but the plugin is NOT yet registered in package.json/lockfile (needs `npm install --save ./native-plugins/admob` on a networked machine - see its README), and `<AdSlot surface="settings_footer"/>` is placed once, at the end of Settings.tsx (inert unless VITE_ADS_ENABLED=true; the native overlay must be checked against the bottom nav on a device; `initAds` does not start the SDK when ads are off). Nothing renders an ad, so `NO_ADS` stays PENDING. Interstitial/rewarded are not implemented natively.
- Not "production ready": no real purchase has been verified end to end.

## 14. Exact next steps
1. DONE in code (see section 13). Remaining is configuration: set the three secrets, deploy `verify-google-play-purchase` and `google-play-rtdn`, create the 4 subscription products, create the Pub/Sub topic + authenticated push subscription to `https://jzlpelxwzjjpddqcrtpu.supabase.co/functions/v1/google-play-rtdn`, then test with a license-tester account on an internal-testing build.
2. Decide Razorpay: convert to real subscriptions (plan ids + `subscription.*` webhooks) or keep as an explicitly labelled 30-day pass.
3. Build StoreKit + App Store Server verification for iOS.
4. Enforce the PENDING features listed in docs/DUOSPACE_FEATURE_AUDIT.md before advertising them.
5. Run `npm ci && npm run check:lock && npm run check:rls && npx tsc --noEmit && npm run lint && npm test && npm run build` with network access (not possible in the authoring sandbox).

## 15. 2026-09-30 verification pass
- Pro sales paused: `SELL_PRO=false` (config.ts), paywall/upgradeOptionsFor gated, migration `20260930120000_pause_pro_sales.sql` sets PRO_* catalog rows inactive (server blocks purchase). Existing Pro/complimentary entitlements unaffected. Re-enable both together.
- `supabase/config.toml`: `verify_jwt=false` added for `razorpay-webhook` and `google-play-rtdn` (Razorpay/Pub-Sub carry no Supabase JWT; the functions authenticate by HMAC / OIDC).
- Test harness fix: `commerceReconcile.db.test.ts` did not load `20260928140000_fix_replacement_reconciliation_for_ledger.sql`.
- PGlite DB suites (entitlements, admin/lifecycle, ledger reconcile) + monetization unit tests: 95 passed. Staging Razorpay/Supabase live verification: see docs/STAGING_MONETIZATION_VERIFICATION.md (owner-run).

## 16. Plan gating + ads (2026-09-30, second pass)
- Icon Studio now requires ADVANCED_CUSTOMIZATION (Plus): locked badge, click -> /settings/plus, and the sheet cannot open unless the plan allows it. Plain custom icon upload stays free. Client-side only (cosmetic, local), same as Theme Studio.
- Not gated, deliberately: everything in the "never paywalled" list, and every PENDING feature (no real operation exists to gate; see DUOSPACE_FEATURE_AUDIT.md).
- Ads: `duospace-admob` registered via `npm install --save ./native-plugins/admob` (lockfile updated by npm; `check:lock` passes). Banner only, Free plan only, Settings footer only. No domain required: AdMob needs no website to create the app or serve ads; `app-ads.txt` is optional and can be added once you own a domain/Play listing. Uses Google TEST ids until VITE_ADMOB_BANNER_UNIT_ID and VITE_ADS_ENABLED=true are set.
- NO_ADS stays PENDING until a banner is seen rendering on a device.
- Before release: real AdMob App ID in `duospace_admob_app_id`, Play Data safety (advertising ID) + Ads declaration, and Google UMP consent if you have EEA/UK users.
- AdMob App ID set (2026-09-30): `native-plugins/admob/.../duospace_admob.xml` now carries the real App ID. The banner still uses Google's TEST unit until `VITE_ADMOB_BANNER_UNIT_ID` is set, and even then only in production bundles (`import.meta.env.PROD`); dev builds always get the test unit. Still needed for real ads: create a Banner unit in AdMob, set the env var, `VITE_ADS_ENABLED=true`, add your phone as a test device, Play Data safety + Ads declaration.

## 17. Ads: UMP consent + gallery/plans banners (2026-10-02, v3.20.2)
- Consent: `DuospaceAdmob.requestConsent()` runs before the SDK; no `canRequestAds` = no SDK, no ad. "Ad privacy choices" (Settings footer) appears only where Google requires it.
- Banner on Gallery (`gallery_grid_footer`) and the Plus screen (`plans_screen_footer`), Free plan only, via the existing policy. Suppressed in the media viewer and multi-select. The dock and content are lifted by `--ad-banner-height`.
- Still needed before real ads: UMP message created in AdMob console (Privacy & messaging) for the app, real banner unit id in `VITE_ADMOB_BANNER_UNIT_ID`, `VITE_ADS_ENABLED=true`, test device registered, Play Data safety + Ads declaration. Check on a device: banner vs dock on Settings/Gallery/Plus, form in an EEA debug geography (`requestConsent({debugGeography:"EEA", testDeviceIds:[...]})`).
