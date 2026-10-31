# DuoSpace monetization: staging verification kit

Goal: prove ONE payment flips ONE entitlement, then prove couple inheritance and revocation.
Target: staging `otaficrlkiscaihdwxnt`. Never production `jzlpelxwzjjpddqcrtpu`.
Kill switch: no purchase flips an entitlement on staging by 2026-10-14 -> freeze monetization, go to the Android device matrix.

## 0. Preconditions (fail any = stop)
Run first: `npm run check:monetization -- --target staging --client-env .env.local --secrets-file <secrets.env>` — any FAIL = stop.
- [ ] Razorpay Dashboard is in **Test Mode**; keys start with `rzp_test_`. A `rzp_live_` key = stop.
- [ ] Two NON-admin staging accounts, A and B, both signed in at least once.
- [ ] `supabase` CLI logged in; `.env.local` points at the staging URL/anon key, with `VITE_RAZORPAY_ENABLED=true` and `VITE_DISTRIBUTION=web`. Leave `VITE_RAZORPAY_MODE` unset (one-time order mode).

## 1. Schema
```bash
supabase link --project-ref otaficrlkiscaihdwxnt
supabase db push          # 127 migrations; clean-install is unverified, read any error
```
Verify:
```sql
select to_regclass('public.entitlements'), to_regclass('public.payment_transactions'),
       to_regclass('public.commercial_products'), to_regclass('public.plan_quota_config');
select count(*) from public.commercial_products;          -- expect Plus rows (Pro too until hidden)
select plan, price_minor from public.commercial_products;  -- Plus individual 14900, couple 19900
```
PASS: all four tables exist, catalog rows present.

## 2. Secrets and functions
```bash
supabase secrets set RAZORPAY_KEY_ID=rzp_test_xxx RAZORPAY_KEY_SECRET=xxx \
  RAZORPAY_WEBHOOK_SECRET=$(openssl rand -hex 24) \
  BILLING_ACCOUNT_HMAC_SECRET=$(openssl rand -hex 32)
supabase functions deploy create-razorpay-order verify-razorpay-payment get-billing-account-token
# The webhook is called by Razorpay with NO Supabase JWT. Default JWT check would 401 it.
supabase functions deploy razorpay-webhook --no-verify-jwt
```
Then in Razorpay (Test Mode) -> Webhooks: URL `https://otaficrlkiscaihdwxnt.supabase.co/functions/v1/razorpay-webhook`, same secret as above, events `payment.captured`, `payment.failed`, `refund.processed`.
Note: `config.toml` has no `[functions.razorpay-webhook] verify_jwt = false` entry (same for `google-play-rtdn`). Add both so a plain `deploy` doesn't silently break them.
PASS: unsigned POST is rejected by your code, not the gateway:
```bash
curl -i -X POST https://otaficrlkiscaihdwxnt.supabase.co/functions/v1/razorpay-webhook -d '{}'
# expect 401 from the function (signature check), NOT "Invalid JWT"
```

## 3. Single purchase (Individual Plus)
1. `npm run dev`, sign in as A, Settings -> DuoSpace Plus, buy "Plus (just me)".
2. Razorpay popup, TEST MODE ONLY: card `4111 1111 1111 1111`, any future expiry/CVV, OTP `1234`. UPI: `success@razorpay`. A real UPI app will NOT work in test mode.
```sql
select provider, status, plan, amount_minor, provider_transaction_id, expires_at
from public.payment_transactions where user_id = '<A_UID>' order by created_at desc limit 3;
select plan, status, expires_at from public.entitlements where user_id = '<A_UID>';
```
PASS: ledger `active`, entitlement PLUS_INDIVIDUAL, ~30 days out, app shows "You're on Plus".
Then check Razorpay side matches: payment `captured`, amount 14900.

## 4. Failure and replay
- [ ] `failure@razorpay` -> ledger not `active`, entitlement unchanged (FREE).
- [ ] Re-invoke `verify-razorpay-payment` with the same payment_id -> still exactly one ledger row (unique on provider+provider_transaction_id).
- [ ] Tampered signature -> rejected, nothing granted.
- [ ] As B, call verify with A's payment_id -> rejected (account binding).

## 5. Couple inheritance (the real risk)
Prereq: A and B mutually linked (`profiles.partner_id` points both ways).
1. A buys Plus Couple.
```sql
select public.get_effective_entitlement('<B_UID>');   -- run as B's session, or check via my_entitlement while signed in as B
```
2. PASS: B resolves to PLUS-level via A; B has NO entitlements row of their own.
3. A unlinks B -> re-check B: FREE immediately.
4. A links a third account C -> C resolves to PLUS via A.
5. One-sided link (A->B only, B not pointing back) -> B gets nothing.
6. Individual plan bought by A -> B gets nothing while linked.

## 6. Privacy and forgery checks (M1 class)
- [ ] Signed in as B: `select * from entitlements where user_id = '<A_UID>'` returns 0 rows.
- [ ] Anon key: `my_entitlement` and `get_effective_entitlement('<A_UID>')` return nothing/denied.
- [ ] Authenticated client `insert/update` on `entitlements`, `payment_transactions` is denied.

## 7. Quota (metering)
```sql
select * from public.plan_quota_config;   -- FREE 5/day, PLUS 50/day
```
As FREE: hit Understand 6 times -> 6th blocked. After purchase: limit lifts to 50.

## 8. Report back
Paste: section 1 counts, section 3 both query outputs, section 5 step 2/3/4 results, section 6 results. Anything not PASS is a bug to fix before Play work.

## Known gaps this kit does NOT cover
- Google Play verification (needs service account + license-tester build).
- Razorpay subscription mode (`create-razorpay-subscription`, `cancel-razorpay-subscription`) and webhook renewals.
- Policy: a `play_store` build must not offer Razorpay outside the alternative-billing programme (`paymentRouting.ts` already defaults to Play only). Test Razorpay on web/sideload builds only.
