import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveModelConfig, resolveEndpoints } from "../../../../supabase/functions/_shared/ai/config";
import { TASK_BUCKET, TASK_TIER, AI_TASKS } from "../../../../supabase/functions/_shared/ai/tasks";
import { CONFIG, ENV } from "./helpers";

describe("AI_MODEL_CONFIG", () => {
  it("unset env → no tier configured (fail closed, no default model)", () => {
    expect(Object.keys(resolveModelConfig({}))).toHaveLength(0);
  });
  it("resolves provider/model/limits from env and freezes them", () => {
    const e = CONFIG.STANDARD_HIGH_VOLUME!;
    expect(e.provider).toBe("openai");
    expect(e.model).toBe("fast-model-x");
    expect(e.fallback).toEqual({ provider: "gemini", model: "fast-model-y" });
    expect(e.quotaClass).toBe("AI_STANDARD");
    expect(Object.isFrozen(e)).toBe(true);
  });
  it("deep tier uses the AI_DEEP quota class and PRO feature tier", () => {
    expect(CONFIG.DEEP_RELATIONSHIP!.quotaClass).toBe("AI_DEEP");
    expect(CONFIG.DEEP_RELATIONSHIP!.featureTier).toBe("PRO");
  });
  it("rejects unknown providers and half-specified fallbacks", () => {
    const c = resolveModelConfig({ AI_STD_FAST_PROVIDER: "acme", AI_STD_FAST_MODEL: "m", AI_DEEP_PROVIDER: "openai", AI_DEEP_MODEL: "m", AI_DEEP_FALLBACK_PROVIDER: "gemini" });
    expect(c.STANDARD_HIGH_VOLUME).toBeUndefined();
    expect(c.DEEP_RELATIONSHIP!.fallback).toBeNull();
  });
  it("clamps numeric overrides", () => {
    const c = resolveModelConfig({ ...ENV, AI_STD_FAST_MAX_OUT: "999999", AI_STD_FAST_TIMEOUT_MS: "5", AI_STD_FAST_TEMPERATURE: "9" });
    expect(c.STANDARD_HIGH_VOLUME!.maxOutputTokens).toBe(8000);
    expect(c.STANDARD_HIGH_VOLUME!.timeoutMs).toBe(1000);
    expect(c.STANDARD_HIGH_VOLUME!.temperature).toBe(1);
  });
  it("endpoints default to public APIs and are overridable", () => {
    expect(resolveEndpoints({}).openai).toMatch(/^https:\/\/api\.openai\.com/);
    expect(resolveEndpoints({ OPENAI_BASE_URL: "https://proxy.test/v1" }).openai).toBe("https://proxy.test/v1");
  });
  it("every task has a tier and a bucket; only the three deep tasks use AI_DEEP", () => {
    for (const t of AI_TASKS) { expect(TASK_TIER[t]).toBeTruthy(); expect(TASK_BUCKET[t]).toBeTruthy(); }
    expect(AI_TASKS.filter((t) => TASK_BUCKET[t] === "AI_DEEP").sort()).toEqual(["COMPATIBILITY_DEEP", "COMPLEX_CONFLICT", "LONGITUDINAL_ANALYSIS"]);
  });
  it("no provider model id is hardcoded anywhere in the shared AI code or client", () => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
    const files = [...walk("supabase/functions/_shared/ai"), ...walk("src/lib/ai/cloud"), "supabase/functions/ai-gateway/index.ts"];
    for (const f of files) expect(readFileSync(f, "utf8")).not.toMatch(/gpt-\d|gemini-\d|sarvam-\d|o\d-mini/i);
  });
});
