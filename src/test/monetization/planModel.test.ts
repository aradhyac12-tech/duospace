import { describe, it, expect } from "vitest";
import {
  FEATURES, FEATURE_MIN_LEVEL, FEATURE_STATUS, PRODUCT_CATALOG, PRODUCT_IDS,
  getPlanLevel, getPlanScope, isCouplePlan, isPlus, isPro, planIncludesFeature, productIdFor,
  type EntitlementPlan, type FeatureFlag,
} from "@/lib/monetization/config";

const ALL: EntitlementPlan[] = ["FREE", "PLUS_INDIVIDUAL", "PLUS_COUPLE", "PRO_INDIVIDUAL", "PRO_COUPLE", "LIFETIME", "FOUNDER", "BETA", "ADMIN"];
const FEATURE_LIST = Object.keys(FEATURES) as FeatureFlag[];

describe("plan normalisation", () => {
  it("maps every concrete plan to a level", () => {
    expect(getPlanLevel("FREE")).toBe("FREE");
    expect(getPlanLevel("PLUS_INDIVIDUAL")).toBe("PLUS");
    expect(getPlanLevel("PLUS_COUPLE")).toBe("PLUS");
    expect(getPlanLevel("PRO_INDIVIDUAL")).toBe("PRO");
    expect(getPlanLevel("PRO_COUPLE")).toBe("PRO");
    for (const p of ["LIFETIME", "FOUNDER", "BETA", "ADMIN"] as const) expect(getPlanLevel(p)).toBe("PRO");
  });
  it("scope only differs for COUPLE plans", () => {
    expect(getPlanScope("PLUS_COUPLE")).toBe("COUPLE");
    expect(getPlanScope("PRO_COUPLE")).toBe("COUPLE");
    expect(getPlanScope("PLUS_INDIVIDUAL")).toBe("INDIVIDUAL");
    expect(isCouplePlan("FREE")).toBe(false);
    expect(isCouplePlan("PRO_COUPLE")).toBe(true);
  });
  it("isPlus/isPro follow level", () => {
    expect(isPlus("FREE")).toBe(false);
    expect(isPlus("PLUS_COUPLE")).toBe(true);
    expect(isPlus("PRO_INDIVIDUAL")).toBe(true);
    expect(isPro("PLUS_COUPLE")).toBe(false);
    expect(isPro("PRO_COUPLE")).toBe(true);
  });
});

describe("Individual and Couple have IDENTICAL capabilities at the same level", () => {
  it("PLUS", () => { for (const f of FEATURE_LIST) expect(planIncludesFeature("PLUS_COUPLE", f)).toBe(planIncludesFeature("PLUS_INDIVIDUAL", f)); });
  it("PRO", () => { for (const f of FEATURE_LIST) expect(planIncludesFeature("PRO_COUPLE", f)).toBe(planIncludesFeature("PRO_INDIVIDUAL", f)); });
});

describe("feature access", () => {
  it("levels are strictly nested: FREE ⊂ PLUS ⊂ PRO", () => {
    for (const f of FEATURE_LIST) {
      if (planIncludesFeature("FREE", f)) expect(planIncludesFeature("PLUS_INDIVIDUAL", f)).toBe(true);
      if (planIncludesFeature("PLUS_INDIVIDUAL", f)) expect(planIncludesFeature("PRO_INDIVIDUAL", f)).toBe(true);
    }
  });
  it("Plus cannot reach Pro features", () => {
    expect(planIncludesFeature("PLUS_COUPLE", "AI_DEEP_REASONING")).toBe(false);
    expect(planIncludesFeature("PRO_INDIVIDUAL", "AI_DEEP_REASONING")).toBe(true);
  });
  it("Free keeps every CORE_* feature and basic AI", () => {
    for (const f of FEATURE_LIST.filter((x) => x.startsWith("CORE_"))) expect(planIncludesFeature("FREE", f)).toBe(true);
    expect(planIncludesFeature("FREE", "AI_BASIC")).toBe(true);
    expect(planIncludesFeature("FREE", "PREMIUM_THEMES")).toBe(false);
  });
  it("special plans get PRO-level capabilities", () => {
    for (const p of ["LIFETIME", "FOUNDER", "BETA", "ADMIN"] as const)
      for (const f of FEATURE_LIST) expect(planIncludesFeature(p, f)).toBe(true);
  });
  it("every feature has a minimum level and a status", () => {
    for (const f of FEATURE_LIST) { expect(FEATURE_MIN_LEVEL[f]).toBeDefined(); expect(FEATURE_STATUS[f]).toBeDefined(); }
  });
  it("safety/privacy controls are not a feature at all (never paywallable)", () => {
    for (const f of FEATURE_LIST) expect(f).not.toMatch(/SAFETY|PRIVACY|CONSENT|DELETE|UNLINK|SECURITY/);
  });
});

describe("product catalogue", () => {
  it("has exactly the four consumer products with the locked prices", () => {
    expect(Object.keys(PRODUCT_CATALOG).sort()).toEqual(Object.values(PRODUCT_IDS).sort());
    expect(PRODUCT_CATALOG[PRODUCT_IDS.PLUS_INDIVIDUAL_MONTHLY].amount).toBe(149);
    expect(PRODUCT_CATALOG[PRODUCT_IDS.PLUS_COUPLE_MONTHLY].amount).toBe(199);
    expect(PRODUCT_CATALOG[PRODUCT_IDS.PRO_INDIVIDUAL_MONTHLY].amount).toBe(299);
    expect(PRODUCT_CATALOG[PRODUCT_IDS.PRO_COUPLE_MONTHLY].amount).toBe(399);
  });
  it("productIdFor resolves level+scope to the right id", () => {
    expect(productIdFor("PRO", "COUPLE")).toBe("duospace_pro_couple_monthly");
    expect(productIdFor("PLUS", "INDIVIDUAL")).toBe("duospace_plus_individual_monthly");
  });
  it("a product's plan agrees with its level/scope", () => {
    for (const p of Object.values(PRODUCT_CATALOG)) {
      expect(getPlanLevel(p.plan)).toBe(p.level);
      expect(getPlanScope(p.plan)).toBe(p.scope);
    }
  });
});

describe("no component compares plan strings for access", () => {
  it("only config.ts / the hook / tests mention concrete paid plan names in src", async () => {
    const { execSync } = await import("node:child_process");
    const out = execSync(
      `grep -rlE "=== ?\\"(PLUS|PRO)_(INDIVIDUAL|COUPLE)\\"" src --include=*.ts --include=*.tsx || true`,
      { encoding: "utf8" },
    ).split("\n").filter(Boolean).filter((f) => !f.startsWith("src/test/") && f !== "src/lib/monetization/config.ts");
    expect(out).toEqual([]);
  });
});
