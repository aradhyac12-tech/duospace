import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Understand is fully deterministic (no model, no network): it must never meter AI quota.
describe("UnderstandSheet quota classification", () => {
  const src = readFileSync(resolve(__dirname, "../../components/chat/UnderstandSheet.tsx"), "utf8");
  it("does not consume AI quota", () => {
    expect(src).not.toMatch(/consumeAiQuota|useAiQuota|QuotaBlocked/);
  });
  it("does not make network calls", () => {
    expect(src).not.toMatch(/\bfetch\(|supabase\./);
  });
});

describe("QuickReplySheet quota classification", () => {
  const src = readFileSync(resolve(__dirname, "../../components/chat/QuickReplySheet.tsx"), "utf8");
  it("meters only model-worded replies, never the deterministic fallback", () => {
    expect(src).toMatch(/producesReply && r\.usedModel/);
  });
});
