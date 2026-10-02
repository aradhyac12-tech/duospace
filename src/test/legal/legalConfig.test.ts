import { describe, expect, it } from "vitest";
import { dmcaAgentFrom } from "@/lib/legal/legalConfig";

describe("dmcaAgentFrom", () => {
  it("returns null unless name, email and address are all set", () => {
    expect(dmcaAgentFrom(() => "")).toBeNull();
    expect(dmcaAgentFrom((k) => (k.endsWith("NAME") ? "A" : ""))).toBeNull();
    expect(dmcaAgentFrom((k) => ({ VITE_DMCA_AGENT_NAME: "A", VITE_DMCA_AGENT_EMAIL: "a@b.c" } as Record<string, string>)[k] ?? "")).toBeNull();
  });
  it("returns the agent when complete", () => {
    const m: Record<string, string> = { VITE_DMCA_AGENT_NAME: "A", VITE_DMCA_AGENT_EMAIL: "a@b.c", VITE_DMCA_AGENT_ADDRESS: "1 Main St" };
    expect(dmcaAgentFrom((k) => m[k] ?? "")).toEqual({ name: "A", email: "a@b.c", address: "1 Main St" });
  });
});
