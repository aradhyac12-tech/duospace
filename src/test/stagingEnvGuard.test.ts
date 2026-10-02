import { describe, it, expect } from "vitest";
import { checkStagingEnv, PRODUCTION_KEY } from "../../scripts/staging-env-guard.mjs";

const STG = { VITE_SUPABASE_URL: "https://otaficrlkiscaihdwxnt.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_stagingkey" };
describe("staging build guard", () => {
  it("never affects non-staging modes (production default unchanged)", () => {
    expect(checkStagingEnv("production", {})).toBeNull();
    expect(checkStagingEnv("development", {})).toBeNull();
  });
  it("staging without env vars fails instead of falling back to production", () => {
    expect(checkStagingEnv("staging", {})).toMatch(/set BOTH/);
    expect(checkStagingEnv("staging", { VITE_SUPABASE_URL: STG.VITE_SUPABASE_URL })).toMatch(/set BOTH/);
  });
  it("staging pointed at production fails", () => {
    expect(checkStagingEnv("staging", { ...STG, VITE_SUPABASE_URL: "https://jzlpelxwzjjpddqcrtpu.supabase.co" })).toMatch(/PRODUCTION/);
    expect(checkStagingEnv("staging", { ...STG, VITE_SUPABASE_PUBLISHABLE_KEY: PRODUCTION_KEY })).toMatch(/PRODUCTION/);
  });
  it("staging with a proper staging project passes; junk URL fails", () => {
    expect(checkStagingEnv("staging", STG)).toBeNull();
    expect(checkStagingEnv("staging", { ...STG, VITE_SUPABASE_URL: "http://localhost:54321" })).toMatch(/not a Supabase project URL/);
  });
});
