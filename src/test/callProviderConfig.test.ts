import { describe, it, expect } from "vitest";
import { resolveCallProviderMode, resolveActiveCallEngine } from "@/lib/callProviderConfig";
import * as providerConfig from "@/lib/callProviderConfig";

describe("callProviderConfig — self-hosted is the only provider", () => {
  it("always resolves to self_hosted", () => {
    expect(resolveCallProviderMode()).toBe("self_hosted");
    expect(resolveActiveCallEngine()).toBe("self_hosted");
  });

  it("a stale per-device override from an old build cannot select another provider", () => {
    localStorage.setItem("duospace_call_provider_override", "daily");
    expect(resolveActiveCallEngine()).toBe("self_hosted");
    localStorage.removeItem("duospace_call_provider_override");
  });

  it("exposes no override API", () => {
    expect((providerConfig as Record<string, unknown>).setCallProviderOverride).toBeUndefined();
  });
});
