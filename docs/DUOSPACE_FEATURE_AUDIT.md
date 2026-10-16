# Feature audit — what is really gated (v3.18.1 snapshot)

Method: read every consumer of `FEATURES`, `planIncludesFeature`, `useEntitlement`, `isPlus`
and every Edge Function; then looked for the real operation behind each advertised feature.

## Headline findings
1. **Before this phase nothing was gated.** `canUseFeature()` had zero callers; `isPlus` was only used to pick which card to draw. Every "Plus feature" was free to everyone.
2. **The relationship AI is entirely on-device.** Understand, Reply help, Today insight, Repair and Comparison run locally (`src/lib/relationship/*`). There is no cloud AI Edge Function. A server can count/limit calls the client volunteers, but cannot stop on-device code — so this is *metering*, not hard enforcement, and honest copy must not say otherwise.
3. **No storage quota exists.** `mediaCache.ts` limits are a local cache size, unrelated to a plan. Nothing to enforce, so storage is not sold.
4. Old marketing claimed "Unlimited AI insights", "Advanced mood analytics", "Extra storage", "Advanced couple insights". None were real. Removed.
5. Bypass risks that remain (by design of on-device features): a patched client can skip the quota call or theme lock. Server-side state (plan, purchases, quota counter) cannot be forged.

## Per-feature table
| Feature | Declared | Real operation | Server enforced | Client UX | Quota | Tests | Status |
|---|---|---|---|---|---|---|---|
| AI_BASIC / AI_STANDARD | catalog | Understand sheet, Quick-reply generation | counter is server-side (`consume_ai_quota`, keyed on `auth.uid()`) | `QuotaBlocked` card + See plans | 5/50/150 per day | DB matrix; UI not run | ENFORCED (metered) |
| PREMIUM_THEMES | catalog | `ThemePicker.choose` | no (cosmetic, local) | lock badge, click -> plans | — | unit (catalog) | ENFORCED (client) — a theme chosen earlier is kept after a downgrade |
| ADVANCED_CUSTOMIZATION | catalog | Theme Studio entry + `open` guard | no | lock badge, click -> plans | — | unit (catalog) | ENFORCED (client) |
| AI_DEEP_* / compatibility / advanced conflict repair / longitudinal | catalog | none — no distinct deep mode exists; existing Comparison/Repair contain safety guidance and are intentionally **not** paywalled | `AI_DEEP` quota bucket exists, no consumer | none | 0/5/30 per month | DB (quota) | PENDING |
| EXPANDED_STORAGE / PRO_STORAGE / PRO_MEDIA_LIMITS | catalog | none | no | none | — | — | PENDING |
| ADVANCED_MUSIC / PRO_MUSIC_LIMITS | catalog | none (background playback restrictions are source-specific and unchanged) | no | none | — | — | PENDING |
| ADVANCED_SURPRISE / PRO_SURPRISE / ADVANCED_MEMORY / ADVANCED_DISCOVERY / AI_MEMORY_ASSIST / AI_MULTILINGUAL | catalog | none distinct from the free versions | no | none | — | — | PENDING |
| NO_ADS | catalog + `AD_FREE_SURFACES` | ads do not exist | no | none | — | — | PENDING |
| PRIORITY_AI / PRIORITY_SUPPORT | catalog | none | no | none | — | — | PENDING |

Deliberately never gated: chat, calls, media, memories, mood, music, surprises, partner
linking, account security, consent, data deletion, privacy controls, unlinking, safety
detection/guidance. In `UnderstandSheet` the safety block renders regardless of quota;
in `QuickReplySheet` safety holds are neither metered nor hidden.

`FEATURE_STATUS` in `config.ts` marks which features are ENFORCED; `marketing.test.ts`
fails if the paywall advertises anything else.

## Consequence for Pro
Pro today = higher AI limits + everything in Plus. Its headline capabilities are contract only
(PENDING). Consider not selling Pro until DuoSpace Intelligence ships, or keep it clearly
labelled as "higher limits".
