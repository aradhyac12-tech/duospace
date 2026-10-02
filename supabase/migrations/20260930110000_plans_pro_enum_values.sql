-- Step 1 of 2: new concrete consumer plans. Enum values cannot be USED in the
-- same transaction that adds them, so the resolver/quota work is in the next
-- migration.
ALTER TYPE public.entitlement_plan ADD VALUE IF NOT EXISTS 'PRO_INDIVIDUAL';
ALTER TYPE public.entitlement_plan ADD VALUE IF NOT EXISTS 'PRO_COUPLE';
