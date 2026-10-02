// Single source of truth for monetization pricing, product IDs, and feature
// flags. Nothing else in the app should hard-code a price, a product id, or
// an "is monetization on" check — import from here instead.
//
// IMPLEMENTED: this config + the types it exports.
// NOT YET ACTIVATED: nothing here turns billing or ads on by itself — see
// the *_enabled flags below, all defaulted to false/safe for local dev.

// ---------------------------------------------------------------------------
// PLAN MODEL. Two axes: LEVEL (what you can do) and SCOPE (who is covered).
// Features depend on LEVEL only. Individual and Couple at the same level have
// IDENTICAL capabilities; Couple only adds the purchaser's current, mutually
// linked partner (resolved live in Postgres, never copied).
// ---------------------------------------------------------------------------
export type PlanLevel = "FREE" | "PLUS" | "PRO";
export type PlanScope = "INDIVIDUAL" | "COUPLE";
export type BillingPeriod = "monthly"; // "yearly" is a schema-ready future addition

export type EntitlementPlan =
  | "FREE"
  | "PLUS_INDIVIDUAL"
  | "PLUS_COUPLE"
  | "PRO_INDIVIDUAL"
  | "PRO_COUPLE"
  | "LIFETIME"
  | "FOUNDER"
  | "BETA"
  | "ADMIN";

export const PRODUCT_IDS = {
  PLUS_INDIVIDUAL_MONTHLY: "duospace_plus_individual_monthly",
  PLUS_COUPLE_MONTHLY: "duospace_plus_couple_monthly",
  PRO_INDIVIDUAL_MONTHLY: "duospace_pro_individual_monthly",
  PRO_COUPLE_MONTHLY: "duospace_pro_couple_monthly",
} as const;

export type ProductId = (typeof PRODUCT_IDS)[keyof typeof PRODUCT_IDS];

export interface ProductInfo {
  plan: Extract<EntitlementPlan, "PLUS_INDIVIDUAL" | "PLUS_COUPLE" | "PRO_INDIVIDUAL" | "PRO_COUPLE">;
  level: Exclude<PlanLevel, "FREE">;
  scope: PlanScope;
  period: BillingPeriod;
  /** Fallback DISPLAY price only. Play's localized price wins when available,
   *  and the server charges/verifies from commercial_products, never from this. */
  amount: number;
  currency: "INR";
  label: string;
}

// The one place prices live. Pro prices are launch candidates: the authoritative
// charge amounts are rows in public.commercial_products (change them there).
export const PRODUCT_CATALOG: Record<ProductId, ProductInfo> = {
  [PRODUCT_IDS.PLUS_INDIVIDUAL_MONTHLY]: { plan: "PLUS_INDIVIDUAL", level: "PLUS", scope: "INDIVIDUAL", period: "monthly", amount: 149, currency: "INR", label: "₹149/month" },
  [PRODUCT_IDS.PLUS_COUPLE_MONTHLY]:     { plan: "PLUS_COUPLE",     level: "PLUS", scope: "COUPLE",     period: "monthly", amount: 199, currency: "INR", label: "₹199/month" },
  [PRODUCT_IDS.PRO_INDIVIDUAL_MONTHLY]:  { plan: "PRO_INDIVIDUAL",  level: "PRO",  scope: "INDIVIDUAL", period: "monthly", amount: 299, currency: "INR", label: "₹299/month" },
  [PRODUCT_IDS.PRO_COUPLE_MONTHLY]:      { plan: "PRO_COUPLE",      level: "PRO",  scope: "COUPLE",     period: "monthly", amount: 399, currency: "INR", label: "₹399/month" },
};

export function productIdFor(level: Exclude<PlanLevel, "FREE">, scope: PlanScope, period: BillingPeriod = "monthly"): ProductId {
  const hit = (Object.keys(PRODUCT_CATALOG) as ProductId[]).find((id) => {
    const p = PRODUCT_CATALOG[id];
    return p.level === level && p.scope === scope && p.period === period;
  });
  if (!hit) throw new Error(`no product for ${level}/${scope}/${period}`);
  return hit;
}

// Kept for existing call sites (display fallbacks only).
export const FALLBACK_DISPLAY_PRICING = Object.fromEntries(
  (Object.keys(PRODUCT_CATALOG) as ProductId[]).map((id) => [
    id,
    { amount: PRODUCT_CATALOG[id].amount, currency: PRODUCT_CATALOG[id].currency, label: PRODUCT_CATALOG[id].label },
  ]),
) as Record<ProductId, { amount: number; currency: "INR"; label: string }>;

// ---------------------------------------------------------------------------
// FEATURE CATALOG. Every capability, its minimum level, and whether it is
// actually enforced today. `ENFORCED` = a real operation checks it.
// `PENDING` = declared for the contract only; it must NOT be marketed.
// ---------------------------------------------------------------------------
export const FEATURES = {
  // FREE — the core product. Never paywalled.
  CORE_CHAT: "CORE_CHAT",
  CORE_CALLS: "CORE_CALLS",
  CORE_MEDIA: "CORE_MEDIA",
  CORE_PROFILE: "CORE_PROFILE",
  CORE_PARTNER_LINKING: "CORE_PARTNER_LINKING",
  CORE_MEMORIES: "CORE_MEMORIES",
  CORE_MOOD: "CORE_MOOD",
  CORE_MUSIC: "CORE_MUSIC",
  CORE_SURPRISE: "CORE_SURPRISE",
  CORE_DISCOVERY: "CORE_DISCOVERY",
  AI_BASIC: "AI_BASIC", // limited daily AI helper actions (server-counted)
  // PLUS
  AI_STANDARD: "AI_STANDARD",
  AI_MULTILINGUAL: "AI_MULTILINGUAL",
  AI_REPLY_ASSIST: "AI_REPLY_ASSIST",
  AI_UNDERSTAND: "AI_UNDERSTAND",
  AI_MEMORY_ASSIST: "AI_MEMORY_ASSIST",
  ADVANCED_DISCOVERY: "ADVANCED_DISCOVERY",
  ADVANCED_MEMORY: "ADVANCED_MEMORY",
  PREMIUM_THEMES: "PREMIUM_THEMES",
  ADVANCED_CUSTOMIZATION: "ADVANCED_CUSTOMIZATION",
  EXPANDED_STORAGE: "EXPANDED_STORAGE",
  ADVANCED_MUSIC: "ADVANCED_MUSIC",
  ADVANCED_SURPRISE: "ADVANCED_SURPRISE",
  NO_ADS: "NO_ADS",
  // PRO
  AI_DEEP_REASONING: "AI_DEEP_REASONING",
  AI_DEEP_RELATIONSHIP_ANALYSIS: "AI_DEEP_RELATIONSHIP_ANALYSIS",
  AI_ADVANCED_COMPATIBILITY: "AI_ADVANCED_COMPATIBILITY",
  AI_ADVANCED_DISCOVERY: "AI_ADVANCED_DISCOVERY",
  AI_ADVANCED_CONFLICT_REPAIR: "AI_ADVANCED_CONFLICT_REPAIR",
  AI_ADVANCED_RELATIONSHIP_MEMORY: "AI_ADVANCED_RELATIONSHIP_MEMORY",
  AI_LONGITUDINAL_INSIGHTS: "AI_LONGITUDINAL_INSIGHTS",
  PRO_STORAGE: "PRO_STORAGE",
  PRO_MEDIA_LIMITS: "PRO_MEDIA_LIMITS",
  PRO_MUSIC_LIMITS: "PRO_MUSIC_LIMITS",
  PRO_SURPRISE: "PRO_SURPRISE",
  PRIORITY_AI: "PRIORITY_AI",
  PRIORITY_SUPPORT: "PRIORITY_SUPPORT",
} as const;

export type FeatureFlag = keyof typeof FEATURES;
const LEVEL_ORDER: Record<PlanLevel, number> = { FREE: 0, PLUS: 1, PRO: 2 };

/** Minimum level for each feature. The ONLY per-feature table. */
export const FEATURE_MIN_LEVEL: Record<FeatureFlag, PlanLevel> = {
  CORE_CHAT: "FREE", CORE_CALLS: "FREE", CORE_MEDIA: "FREE", CORE_PROFILE: "FREE",
  CORE_PARTNER_LINKING: "FREE", CORE_MEMORIES: "FREE", CORE_MOOD: "FREE",
  CORE_MUSIC: "FREE", CORE_SURPRISE: "FREE", CORE_DISCOVERY: "FREE", AI_BASIC: "FREE",
  AI_STANDARD: "PLUS", AI_MULTILINGUAL: "PLUS", AI_REPLY_ASSIST: "PLUS", AI_UNDERSTAND: "PLUS",
  AI_MEMORY_ASSIST: "PLUS", ADVANCED_DISCOVERY: "PLUS", ADVANCED_MEMORY: "PLUS",
  PREMIUM_THEMES: "PLUS", ADVANCED_CUSTOMIZATION: "PLUS", EXPANDED_STORAGE: "PLUS",
  ADVANCED_MUSIC: "PLUS", ADVANCED_SURPRISE: "PLUS", NO_ADS: "PLUS",
  AI_DEEP_REASONING: "PRO", AI_DEEP_RELATIONSHIP_ANALYSIS: "PRO", AI_ADVANCED_COMPATIBILITY: "PRO",
  AI_ADVANCED_DISCOVERY: "PRO", AI_ADVANCED_CONFLICT_REPAIR: "PRO", AI_ADVANCED_RELATIONSHIP_MEMORY: "PRO",
  AI_LONGITUDINAL_INSIGHTS: "PRO", PRO_STORAGE: "PRO", PRO_MEDIA_LIMITS: "PRO", PRO_MUSIC_LIMITS: "PRO",
  PRO_SURPRISE: "PRO", PRIORITY_AI: "PRO", PRIORITY_SUPPORT: "PRO",
};

/**
 * Truth table for marketing. A feature may appear on the paywall ONLY if it is
 * ENFORCED. Enforcement is by a real operation (see docs/DUOSPACE_FEATURE_AUDIT.md);
 * a feature that exists only as an enum is PENDING and is never sold.
 */
/**
 * Pro is NOT offered for purchase while its headline features are PENDING
 * (docs/DUOSPACE_FEATURE_AUDIT.md: Pro today = higher AI limits only, metered
 * on-device). Flip to true only when a real deep-analysis consumer exists AND
 * the PRO_* rows in public.commercial_products are set active again.
 * Existing Pro/complimentary entitlements are unaffected.
 */
export const SELL_PRO = false;

export type EnforcementStatus = "ENFORCED" | "PENDING";
export const FEATURE_STATUS: Record<FeatureFlag, EnforcementStatus> = Object.fromEntries(
  (Object.keys(FEATURES) as FeatureFlag[]).map((f) => [f, "PENDING"]),
) as Record<FeatureFlag, EnforcementStatus>;
// Core features are trivially "enforced" as always-on; the gated ones below are
// the ones with a real check today.
for (const f of ["AI_BASIC", "AI_STANDARD", "PREMIUM_THEMES", "ADVANCED_CUSTOMIZATION"] as FeatureFlag[]) {
  FEATURE_STATUS[f] = "ENFORCED";
}

// AI quota DISPLAY values (the authoritative numbers are rows in
// public.plan_quota_config; edit those to retune without a rebuild).
export const AI_QUOTA_DISPLAY = {
  FREE: { standardPerDay: 5, deepPerMonth: 0 },
  PLUS: { standardPerDay: 50, deepPerMonth: 5 },
  PRO: { standardPerDay: 150, deepPerMonth: 30 },
} as const;

// Themes free for everyone; every other preset needs PREMIUM_THEMES.
export const FREE_THEME_IDS: readonly string[] = [
  "midnight", "graphite", "ocean", "forest", "arctic", "amber", "rose",
  "minimal-light", "minimal-dark", "monochrome",
];

// ---------------------------------------------------------------------------
// Normalisation — the ONLY place a concrete plan string is inspected.
// Components must go through these helpers / useEntitlement, never compare
// `plan === "PLUS_..."` themselves.
// ---------------------------------------------------------------------------
export function getPlanLevel(plan: EntitlementPlan): PlanLevel {
  switch (plan) {
    case "PLUS_INDIVIDUAL":
    case "PLUS_COUPLE":
      return "PLUS";
    case "PRO_INDIVIDUAL":
    case "PRO_COUPLE":
    case "LIFETIME":
    case "FOUNDER":
    case "BETA":
    case "ADMIN":
      return "PRO";
    default:
      return "FREE";
  }
}

export function getPlanScope(plan: EntitlementPlan): PlanScope {
  return plan === "PLUS_COUPLE" || plan === "PRO_COUPLE" ? "COUPLE" : "INDIVIDUAL";
}

export const isCouplePlan = (plan: EntitlementPlan): boolean => getPlanScope(plan) === "COUPLE" && getPlanLevel(plan) !== "FREE";
export const isPlus = (plan: EntitlementPlan): boolean => LEVEL_ORDER[getPlanLevel(plan)] >= LEVEL_ORDER.PLUS;
export const isPro = (plan: EntitlementPlan): boolean => getPlanLevel(plan) === "PRO";
/** Plans that are granted internally rather than purchased. */
export const isComplimentaryPlan = (plan: EntitlementPlan): boolean =>
  plan === "ADMIN" || plan === "FOUNDER" || plan === "LIFETIME" || plan === "BETA";

/** Does this plan include this feature? Level-only: scope never matters. */
export function planIncludesFeature(plan: EntitlementPlan, feature: FeatureFlag): boolean {
  const min = FEATURE_MIN_LEVEL[feature];
  return min !== undefined && LEVEL_ORDER[getPlanLevel(plan)] >= LEVEL_ORDER[min];
}

export function planMinLevelFor(feature: FeatureFlag): PlanLevel {
  return FEATURE_MIN_LEVEL[feature];
}

// Feature flags — every one defaults to OFF/safe so local dev and a fresh
// checkout never accidentally hit real billing or show live ads (Phase 15).
// Wire these to your existing remote-config/env mechanism when you're ready
// to roll out; until then they read from Vite env vars with safe defaults.
function flag(name: string, fallback = false): boolean {
  const raw = (import.meta as any)?.env?.[name];
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

export const FEATURE_FLAGS = {
  // The Plus screen and plan cards are ON by default so every account can
  // reach them. Set the matching VITE_* variable to "false" to hide them.
  monetizationEnabled: flag("VITE_MONETIZATION_ENABLED", true),
  subscriptionsEnabled: flag("VITE_SUBSCRIPTIONS_ENABLED", true),
  individualPlusEnabled: flag("VITE_INDIVIDUAL_PLUS_ENABLED", true),
  couplePlusEnabled: flag("VITE_COUPLE_PLUS_ENABLED", true),
  adsEnabled: flag("VITE_ADS_ENABLED", false),
  rewardedAdsEnabled: flag("VITE_REWARDED_ADS_ENABLED", false),
  interstitialAdsEnabled: flag("VITE_INTERSTITIAL_ADS_ENABLED", false),
  // Off by default even with real Razorpay credentials configured — this is
  // a separate switch so enabling Razorpay is a deliberate act, and so a
  // Play-distributed build never shows it regardless (see paymentRouting.ts
  // — distribution gating is the real safety net; this flag is the second
  // one, for staged testing rollout).
  razorpayEnabled: flag("VITE_RAZORPAY_ENABLED", true),
} as const;

// Screens/moments ads must never appear on, regardless of ad flags — kept
// here as a single checklist components can import and assert against in
// tests, rather than trusting every call site to remember the rule.
export const AD_FREE_SURFACES = [
  "chat",
  "chat_typing",
  "call_incoming",
  "call_active",
  "video_call_active",
  "login",
  "signup",
  "couple_linking",
  "post_auth",
  "critical_navigation",
  "confirmation_dialog",
  "media_viewer",
] as const;
