# Testing DuoSpace Plus payments (Razorpay test mode)

Google Play Billing only works on a Play-installed build, so the easiest way
to test end-to-end is **Razorpay test mode** in a browser or sideloaded build.
No real money moves in test mode.

## 1. Razorpay test keys
Razorpay Dashboard -> switch to **Test Mode** -> Account & Settings -> API Keys -> Generate.
You get `rzp_test_...` (key id) and a secret.

## 2. Deploy the payment Edge Functions (not yet deployed on production)
```bash
supabase link --project-ref jzlpelxwzjjpddqcrtpu
supabase secrets set RAZORPAY_KEY_ID=rzp_test_xxx RAZORPAY_KEY_SECRET=xxx \
  BILLING_ACCOUNT_HMAC_SECRET=$(openssl rand -hex 32)
supabase functions deploy create-razorpay-order verify-razorpay-payment razorpay-webhook get-billing-account-token
```
(Optional, for renewals/refunds: create a webhook in Razorpay pointing at
`https://jzlpelxwzjjpddqcrtpu.supabase.co/functions/v1/razorpay-webhook`, then
`supabase secrets set RAZORPAY_WEBHOOK_SECRET=...`.)

## 3. Run the app with payments on
`.env.local`:
```
VITE_RAZORPAY_ENABLED=true
# Android APK installed outside Play: also set VITE_DISTRIBUTION=sideload
```
In a browser the app is automatically treated as "web" (Razorpay only), so
you no longer see "This plan isn't available to purchase right now" — that
message came from Google Play Billing, which cannot work outside a Play install.
`npm run dev`, sign in with any **non-admin** account -> Settings -> DuoSpace Plus.

## 4. Pay
Pick a plan -> "Get ... UPI / Card". In the Razorpay popup use:
- Card: `4111 1111 1111 1111`, any future expiry, any CVV, OTP `1234` (or Success)
- UPI: `success@razorpay` (success) / `failure@razorpay` (failure)

## 5. Verify
- App shows "You're on Plus" and the screen switches to the active card.
- SQL: `select * from payment_transactions order by created_at desc limit 3;` -> status `active`
- SQL: `select plan,status,expires_at from entitlements where user_id = '<uid>';` -> PLUS_*, 30 days

## Account rules (enforced in the database)
- Only `chavanaradhya1@gmail.com` can hold the ADMIN plan (table `admin_allowlist`
  + trigger). Nobody else can be granted ADMIN, even from the SQL editor.
- That account's linked partner automatically gets full premium (as FOUNDER,
  no Admin panel). It follows the live partner link: unlink and it disappears.
- Everyone else starts FREE and can buy Individual/Couple Plus.
- Test the admin/partner rule by signing in as the admin and its partner: both
  show "Premium is included with your account" and no purchase cards.
