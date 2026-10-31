-- Resume Pro sales (owner decision 2026-10-03). Reverses 20260930120000_pause_pro_sales.sql.
-- Pair with SELL_PRO = true in src/lib/monetization/config.ts.
UPDATE public.commercial_products
SET active = true
WHERE plan IN ('PRO_INDIVIDUAL', 'PRO_COUPLE');
