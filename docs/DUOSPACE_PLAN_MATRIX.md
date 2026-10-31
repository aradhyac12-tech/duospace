# DuoSpace plan matrix

Two axes. **Level** decides what you can do. **Scope** decides who is covered.
Individual and Couple at the same level have **identical capabilities**.

| Plan | Level | Scope | Price / month (launch) | Covers |
|---|---|---|---|---|
| FREE | FREE | — | ₹0 | you |
| PLUS INDIVIDUAL | PLUS | INDIVIDUAL | ₹149 | you |
| PLUS COUPLE | PLUS | COUPLE | ₹199 | you + your current mutually linked partner |
| PRO INDIVIDUAL | PRO | INDIVIDUAL | ₹299 | you |
| PRO COUPLE | PRO | COUPLE | ₹399 | you + your current mutually linked partner |

Prices live in `public.commercial_products` (the server charges from there) and
`PRODUCT_CATALOG` in `src/lib/monetization/config.ts` (display fallback only).
Pro prices are launch candidates.

Internal plans (never sold): LIFETIME, FOUNDER -> PRO level; BETA -> PRO-equivalent;
ADMIN -> unrestricted. Only `chavanaradhya1@gmail.com` may hold ADMIN
(`admin_allowlist` + trigger); its partner receives FOUNDER-level access.

## What each level really gives today

| Capability | FREE | PLUS | PRO | Status |
|---|---|---|---|---|
| Chat, calls, media, memories, mood, music, surprises, partner linking | yes | yes | yes | always on |
| Safety, privacy, consent, data deletion, unlinking | yes | yes | yes | never paywalled |
| AI helper actions (Understand, Reply help), server-counted | 5 / day | 50 / day | 150 / day | ENFORCED (quota); helpers run on-device |
| Deep analyses (`AI_DEEP` bucket) | 0 | 5 / month | 30 / month | quota exists; **no feature consumes it yet** |
| Premium themes (23 of 33 presets) | no | yes | yes | ENFORCED at theme selection |
| Theme Studio (custom themes, fonts, density) | no | yes | yes | ENFORCED at entry |
| Expanded / Pro storage | — | — | — | PENDING (no server storage quota exists) |
| Advanced music / surprise / memory / discovery | — | — | — | PENDING |
| Deep relationship analysis, advanced compatibility, conflict repair, longitudinal insights | — | — | — | PENDING (contract for DuoSpace Intelligence 1.0) |
| Ad-free | — | — | — | PENDING (no ads exist) |
| Priority AI / support | — | — | — | PENDING |

Quotas are rows in `public.plan_quota_config` (edit to retune, no rebuild).
Daily windows reset at midnight India time, monthly on the 1st.

## Entitlement rules
- **Partner inheritance is live.** `_compute_entitlement_plan` reads the current, *mutual* `partner_id`; nothing is copied to the partner. Unlink -> inherited access is gone on the next evaluation. Relink -> the new partner inherits.
- Only COUPLE plans (and ADMIN -> FOUNDER) are shared. An INDIVIDUAL plan never is.
- The strongest applicable entitlement wins, never a downgrade: precedence ADMIN > FOUNDER > LIFETIME > PRO_COUPLE > PRO_INDIVIDUAL > BETA > PLUS_COUPLE > PLUS_INDIVIDUAL > FREE (BETA is PRO-equivalent, so above PLUS).
- Expired, cancelled, on-hold and revoked entitlements grant nothing.
- Upgrades/downgrades come from the billing state only (verified purchases); the app never edits a plan string. Play replacements map through `reconcile_replaced_transaction`.

## Cancellation and expiry
Google Play: state changes arrive through verification/RTDN (currently BLOCKED, see architecture doc). Razorpay: a 30-day order simply expires; it does not renew.
