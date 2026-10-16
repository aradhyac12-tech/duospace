import { describe, it, expect } from "vitest";
import { planRoute, looksIndicOrMixed, type RouteInput } from "../../../../supabase/functions/_shared/ai/router";
import { CONFIG } from "./helpers";

const ALL = new Set(["openai", "gemini", "sarvam"] as const);
const inp = (o: Partial<RouteInput> = {}): RouteInput => ({ task: "UNDERSTAND", isIndicOrMixed: false, allowFallback: false, forceProvider: null, stagingOverridesAllowed: false, indicRouting: "off", availableProviders: ALL, ...o });
const names = (a: ReturnType<typeof planRoute>) => a.map((x) => `${x.provider}:${x.model}`);

describe("task routing", () => {
  it("quick reply → fast tier; understand → reasoning tier; deep compat → deep tier", () => {
    expect(names(planRoute(inp({ task: "QUICK_REPLY" }), CONFIG))).toEqual(["openai:fast-model-x"]);
    expect(names(planRoute(inp({ task: "UNDERSTAND" }), CONFIG))).toEqual(["openai:reason-model-x"]);
    expect(names(planRoute(inp({ task: "COMPATIBILITY_DEEP" }), CONFIG))).toEqual(["openai:deep-model-x"]);
  });
  it("NO provider switch unless the request allows fallback (privacy)", () => {
    expect(planRoute(inp({ allowFallback: false }), CONFIG)).toHaveLength(1);
    expect(names(planRoute(inp({ allowFallback: true }), CONFIG))).toEqual(["openai:reason-model-x", "gemini:reason-model-y", "gemini:secondary-model-x"]);
  });
  it("skips providers with no key", () => {
    expect(names(planRoute(inp({ allowFallback: true, availableProviders: new Set(["gemini"]) }), CONFIG))).toEqual(["gemini:reason-model-y", "gemini:secondary-model-x"]);
  });
  it("Sarvam is used for Indic/code-mixed ONLY when indicRouting=specialist (default off)", () => {
    expect(names(planRoute(inp({ isIndicOrMixed: true }), CONFIG))).toEqual(["openai:reason-model-x"]);
    expect(names(planRoute(inp({ isIndicOrMixed: true, indicRouting: "specialist" }), CONFIG))[0]).toBe("sarvam:indic-model-x");
  });
  it("specialist routing never replaces the deep model", () => {
    expect(names(planRoute(inp({ task: "COMPATIBILITY_DEEP", isIndicOrMixed: true, indicRouting: "specialist" }), CONFIG))).toEqual(["openai:deep-model-x"]);
  });
  it("specialist + fallback denied → exactly one provider", () => {
    expect(planRoute(inp({ isIndicOrMixed: true, indicRouting: "specialist", allowFallback: false }), CONFIG)).toHaveLength(1);
  });
  it("force-provider is ignored outside staging and honoured in staging", () => {
    expect(names(planRoute(inp({ forceProvider: "gemini" }), CONFIG))[0]).toBe("openai:reason-model-x");
    expect(names(planRoute(inp({ forceProvider: "gemini", stagingOverridesAllowed: true }), CONFIG))).toEqual(["gemini:reason-model-y"]);
  });
  it("unconfigured tier → empty plan", () => { expect(planRoute(inp({ task: "COMPATIBILITY_DEEP" }), {})).toEqual([]); });
  it("detects Devanagari, Roman Hindi/Marathi and hints", () => {
    expect(looksIndicOrMixed("आज मैं थक गई", null)).toBe(true);
    expect(looksIndicOrMixed("kal milte hai but I am busy", null)).toBe(true);
    expect(looksIndicOrMixed("mala kasa vatla tula", null)).toBe(true);
    expect(looksIndicOrMixed("see you tomorrow", null)).toBe(false);
    expect(looksIndicOrMixed("hello", "mr")).toBe(true);
  });
});
