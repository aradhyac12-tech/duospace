-- Pro is not for sale while its headline features are PENDING
-- (docs/DUOSPACE_FEATURE_AUDIT.md). create-razorpay-order and
-- create-razorpay-subscription both require commercial_products.active = true,
-- and the client cannot read inactive rows, so this blocks Pro purchases
-- server-side even against a patched client.
-- Existing PRO_* entitlements and complimentary/BETA/FOUNDER access are NOT
-- touched: this only stops NEW sales. Re-enable together with SELL_PRO=true in
-- src/lib/monetization/config.ts.
UPDATE public.commercial_products
SET active = false
WHERE plan IN ('PRO_INDIVIDUAL', 'PRO_COUPLE');
